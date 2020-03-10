'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const account_1 = require("./account");
const transaction_1 = require("./transaction");
const utils_1 = require("./utils");
const serialize_1 = require("./utils/serialize");
const LOGIN_WALLET_URL_SUFFIX = '/login/';
const LOCAL_STORAGE_KEY_SUFFIX = '_wallet_auth_key';
const PENDING_ACCESS_KEY_PREFIX = 'pending_key'; // browser storage key for a pending access key (i.e. key has been generated but we are not sure it was added yet)
class WalletConnection {
    constructor(near, appKeyPrefix) {
        this._near = near;
        const authDataKey = appKeyPrefix + LOCAL_STORAGE_KEY_SUFFIX;
        const authData = JSON.parse(window.localStorage.getItem(authDataKey));
        this._networkId = near.config.networkId;
        this._walletBaseUrl = near.config.walletUrl;
        appKeyPrefix = appKeyPrefix || near.config.contractName || 'default';
        this._keyStore = near.connection.signer.keyStore;
        this._authData = authData || { allKeys: [] };
        this._authDataKey = authDataKey;
        if (!this.isSignedIn()) {
            this._completeSignInWithAccessKey();
        }
    }
    /**
     * Returns true, if this WalletAccount is authorized with the wallet.
     * @example
     * walletAccount.isSignedIn();
     */
    isSignedIn() {
        return !!this._authData.accountId;
    }
    /**
     * Returns authorized Account ID.
     * @example
     * walletAccount.getAccountId();
     */
    getAccountId() {
        return this._authData.accountId || '';
    }
    /**
     * Redirects current page to the wallet authentication page.
     * @param {string} contractId contract ID of the application
     * @param {string} title name of the application
     * @param {string} successUrl url to redirect on success
     * @param {string} failureUrl url to redirect on failure
     * @example
     *   walletAccount.requestSignIn(
     *     myContractId,
     *     title,
     *     onSuccessHref,
     *     onFailureHref);
     */
    async requestSignIn(contractId, title, successUrl, failureUrl, fundingKey) {
        if (this.getAccountId() || await this._keyStore.getKey(this._networkId, this.getAccountId())) {
            return Promise.resolve();
        }
        const currentUrl = new URL(window.location.href);
        const newUrl = new URL(this._walletBaseUrl + LOGIN_WALLET_URL_SUFFIX);
        newUrl.searchParams.set('title', title);
        newUrl.searchParams.set('contract_id', contractId);
        newUrl.searchParams.set('funding_key', fundingKey);
        newUrl.searchParams.set('success_url', successUrl || currentUrl.href);
        newUrl.searchParams.set('failure_url', failureUrl || currentUrl.href);
        newUrl.searchParams.set('app_url', currentUrl.origin);
        const accessKey = utils_1.KeyPair.fromRandom('ed25519');
        newUrl.searchParams.set('public_key', accessKey.getPublicKey().toString());
        await this._keyStore.setKey(this._networkId, PENDING_ACCESS_KEY_PREFIX + accessKey.getPublicKey(), accessKey);
        window.location.assign(newUrl.toString());
    }
    async requestSignTransactions(transactions, callbackUrl) {
        const currentUrl = new URL(window.location.href);
        const newUrl = new URL('sign', this._walletBaseUrl);
        newUrl.searchParams.set('transactions', transactions
            .map(transaction => utils_1.serialize.serialize(transaction_1.SCHEMA, transaction))
            .map(serialized => Buffer.from(serialized).toString('base64'))
            .join(','));
        newUrl.searchParams.set('callbackUrl', callbackUrl || currentUrl.href);
        window.location.assign(newUrl.toString());
    }
    /**
     * Complete sign in for a given account id and public key. To be invoked by the app when getting a callback from the wallet.
     */
    async _completeSignInWithAccessKey() {
        const currentUrl = new URL(window.location.href);
        const publicKey = currentUrl.searchParams.get('public_key') || '';
        const allKeys = (currentUrl.searchParams.get('all_keys') || '').split(',');
        const accountId = currentUrl.searchParams.get('account_id') || '';
        // TODO: Handle situation when access key is not added
        if (accountId && publicKey) {
            this._authData = {
                accountId,
                allKeys
            };
            window.localStorage.setItem(this._authDataKey, JSON.stringify(this._authData));
            await this._moveKeyFromTempToPermanent(accountId, publicKey);
        }
        currentUrl.searchParams.delete('public_key');
        currentUrl.searchParams.delete('all_keys');
        currentUrl.searchParams.delete('account_id');
        window.history.replaceState({}, document.title, currentUrl.toString());
    }
    async _moveKeyFromTempToPermanent(accountId, publicKey) {
        const keyPair = await this._keyStore.getKey(this._networkId, PENDING_ACCESS_KEY_PREFIX + publicKey);
        await this._keyStore.setKey(this._networkId, accountId, keyPair);
        await this._keyStore.removeKey(this._networkId, PENDING_ACCESS_KEY_PREFIX + publicKey);
    }
    /**
     * Sign out from the current account
     * @example
     * walletAccount.signOut();
     */
    signOut() {
        this._authData = {};
        window.localStorage.removeItem(this._authDataKey);
    }
    account() {
        if (!this._connectedAccount) {
            this._connectedAccount = new ConnectedWalletAccount(this, this._near.connection, this._authData.accountId);
        }
        return this._connectedAccount;
    }
}
exports.WalletConnection = WalletConnection;
exports.WalletAccount = WalletConnection;
/**
 * {@link Account} implementation which redirects to wallet using (@link WalletConnection) when no local key is available.
 */
class ConnectedWalletAccount extends account_1.Account {
    constructor(walletConnection, connection, accountId) {
        super(connection, accountId);
        this.walletConnection = walletConnection;
    }
    // Overriding Account methods
    async signAndSendTransaction(receiverId, actions) {
        await this.ready;
        const localKey = await this.connection.signer.getPublicKey(this.accountId, this.connection.networkId);
        let accessKey = await this.accessKeyForTransaction(receiverId, actions, localKey);
        if (!accessKey) {
            throw new Error(`Cannot find matching key for transaction sent to ${receiverId}`);
        }
        if (localKey && localKey.toString() === accessKey.public_key) {
            try {
                return await super.signAndSendTransaction(receiverId, actions);
            }
            catch (e) {
                // TODO: Use TypedError when available
                if (e.message.includes('does not have enough balance')) {
                    accessKey = await this.accessKeyForTransaction(receiverId, actions);
                }
                else {
                    throw e;
                }
            }
        }
        const publicKey = utils_1.PublicKey.from(accessKey.public_key);
        // TODO: Cache & listen for nonce updates for given access key
        const nonce = accessKey.access_key.nonce + 1;
        const status = await this.connection.provider.status();
        const blockHash = serialize_1.base_decode(status.sync_info.latest_block_hash);
        const transaction = transaction_1.createTransaction(this.accountId, publicKey, receiverId, nonce, actions, blockHash);
        await this.walletConnection.requestSignTransactions([transaction], window.location.href);
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                reject(new Error('Failed to redirect to sign transaction'));
            }, 1000);
        });
        // TODO: Aggregate multiple transaction request with "debounce".
        // TODO: Introduce TrasactionQueue which also can be used to watch for status?
    }
    async accessKeyMatchesTransaction(accessKey, receiverId, actions) {
        const { access_key: { permission } } = accessKey;
        if (permission === 'FullAccess') {
            return true;
        }
        if (permission.FunctionCall) {
            const { receiver_id: allowedReceiverId, method_names: allowedMethods } = permission.FunctionCall;
            if (allowedReceiverId === receiverId) {
                if (actions.length !== 1) {
                    return false;
                }
                const [{ functionCall }] = actions;
                return functionCall && (allowedMethods.length === 0 || allowedMethods.includes(functionCall.methodName));
            }
        }
        // TODO: Support other permissions than FunctionCall
        return false;
    }
    async accessKeyForTransaction(receiverId, actions, localKey) {
        const accessKeys = await this.getAccessKeys();
        if (localKey) {
            const accessKey = accessKeys.find(key => key.public_key === localKey.toString());
            if (accessKey && await this.accessKeyMatchesTransaction(accessKey, receiverId, actions)) {
                return accessKey;
            }
        }
        const walletKeys = this.walletConnection._authData.allKeys;
        for (const accessKey of accessKeys) {
            if (walletKeys.indexOf(accessKey.public_key) !== -1 && await this.accessKeyMatchesTransaction(accessKey, receiverId, actions)) {
                return accessKey;
            }
        }
        return null;
    }
}
