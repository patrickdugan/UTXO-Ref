const util = require('util');
const Litecoin = require('litecoin');
const Bitcoin = require('bitcoin');
const Doge = require('dogecoind-rpc');
const { isTestNetwork, readDeploymentProfile, verifyDeploymentNode } = require('./deploymentProfile');

// --- ENV bootstrap helpers (safe if .env is missing) ---
const path = require('path');

function loadDotenvFromKnownLocations() {
  // lazy-load to avoid hard dependency if dotenv isn't installed yet
  let dotenv;
  try { dotenv = require('dotenv'); } catch { return; }

  // 1) repo-style: one level up relative to this file (…/ .env)
  const repoEnv = path.join(__dirname, '..', '.env');
  dotenv.config({ path: repoEnv, override: false });

  // 2) fallback: current working directory (.env)
  dotenv.config({ override: false });
}

function getRpcBootstrapFromEnv(defaultChain = 'LTC') {
  loadDotenvFromKnownLocations();

  const env = process.env;
  const deployment = readDeploymentProfile();
  if (deployment) {
    if (env.CHAIN && env.CHAIN !== 'BTC') throw new Error('The deployment profile requires CHAIN=BTC');
    const host = env.RPC_HOST || '127.0.0.1', port = Number(env.RPC_PORT || 48332);
    if (!['localhost', '127.0.0.1', '::1'].includes(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('The testnet4 deployment requires a valid loopback RPC endpoint');
    }
    let user = env.RPC_USER, pass = env.RPC_PASS;
    if (env.RPC_COOKIE_FILE) {
      const cookie = require('fs').readFileSync(env.RPC_COOKIE_FILE, 'utf8').replace(/[\r\n]+$/, '');
      const separator = cookie.indexOf(':');
      if (separator < 1 || separator === cookie.length - 1) throw new Error('Invalid local RPC cookie');
      user = cookie.slice(0, separator); pass = cookie.slice(separator + 1);
    }
    if (!user || !pass) throw new Error('The testnet4 deployment requires local RPC credentials or RPC_COOKIE_FILE');
    return { chain: 'BTC', host, port, user, pass, timeout: 10000, locked: true, deployment };
  }
  const ENV_CHAIN  = (env.CHAIN || '').toUpperCase();
  const AUTODETECT = (env.AUTODETECT || '1') !== '0'; // AUTODETECT=0 → lock env, skip discovery

  const DEFAULT_PORT = { BTC: 8332, BTCTEST: 18332, LTC: 9332, LTCTEST: 19332, DOGE: 22555, DOGETEST:44555 };
  const chain = ['BTC', 'LTC', 'DOGE'].includes(ENV_CHAIN) ? ENV_CHAIN : defaultChain;

  const host = env.RPC_HOST || '127.0.0.1';
  const user = env.RPC_USER || 'user';
  const pass = env.RPC_PASS || 'pass';
  const port = Number(env.RPC_PORT || DEFAULT_PORT[chain]);
  const timeout = Number(env.TIMEOUT_MS || 60000);

  // If any of CHAIN / RPC_PORT is provided OR AUTODETECT=0, we consider this a "locked" bootstrap.
  const locked = (!AUTODETECT) || !!env.CHAIN || !!env.RPC_PORT;

  return {
    // normalized values
    chain, host, port, user, pass, timeout,
    // whether the caller should skip autodetect and return immediately
    locked,
  };
}


let clientInstance = null;

class ClientWrapper {
   constructor() {
    if (clientInstance) {
      return clientInstance;
    }
    this.chain = null;
    this.client = null;
    this.initializing = false
    clientInstance = this;  // Assign the instance to the singleton variable
  }

   async init() {
    if (this.initialized) return this.chain;
    if (this.initialization) return this.initialization;
    this.isInitializing = true;
    this.initialization = this.initializeClient().then(chain => {
      this.initialized = true;
      return chain;
    }, error => {
      this.client = null;
      this.chain = null;
      throw error;
    }).finally(() => { this.isInitializing = false; this.initialization = null; });
    return this.initialization;
  }

   async initializeClient() {

	    if(!this.client){
	     const boot = this.getEnvBootstrap('LTCTEST'); // default LTC; change to 'BTC' if you prefer

	this.config = {
	  host: boot.host,
	  port: boot.port,
	  user: boot.user,
	  pass: boot.pass,
	  timeout: boot.timeout,
	};

	// Build a client immediately using the env-chosen CHAIN (or default)
	this.chain  = boot.chain;
	this.client = this._createClientByChain(this.chain);
    if (boot.deployment) await verifyDeploymentNode(this, boot.deployment);

	// If .env told us to lock (AUTODETECT=0 or CHAIN/RPC_PORT provided), stop here.
	// (No probing needed; this lets desktop/server scripts fully control startup.)
	if (boot.locked) {
	  return this.chain;
	}

      // Wait for the blockchain to finish initial block download and indexing
      let isTest = true
       try {
          const blockchainInfo = await this.getBlockchainInfo();
           isTest = isTestNetwork(blockchainInfo.chain);
           console.log('is test '+isTest)
        }catch (error) {
            if (error.code === -28) {
              console.log('Getting the err on the second call.');
            }
        }

      const networkInfo = await this.getNetworkInfo();
      console.log('determining chain in init '+JSON.stringify(networkInfo))
      this.chain = this.determineChainFromSubversion(networkInfo.subversion);

      if (!this.chain) throw new Error('Unable to determine blockchain chain.');

      this.config.port = isTest 
        ? (this.chain === 'BTC' ? 18332 : this.chain === 'DOGE' ? 44556 : 19332)
        : (this.chain === 'BTC' ? 8332 : this.chain === 'DOGE' ? 22555 : 9332);

      this.client = this._createClientByChain(this.chain);
      }
      return this.chain
  }

   async waitForInitialization() {
    while (this.isInitializing) {
      console.log('waiting for initialization')
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms between checks
    }
    return this.chain;  // Return the chain after initialization completes
  }

  // inside your existing class (e.g., RpcClient / whatever it’s named)
	getEnvBootstrap(defaultChain = 'LTC') {
  		return getRpcBootstrapFromEnv(defaultChain);
	}



  _createClientByChain(chain) {
    switch (chain) {
      case 'BTC':
        return new Bitcoin.Client(this.config);
      case 'DOGE':
        return new Doge.Client(this.config);
      default:
        return new Litecoin.Client(this.config);
    }
  }

   static async getInstance(txIndex) {
    if (!clientInstance) {
      if(txIndex){console.log('initializing client by way of txIndex')}
      new ClientWrapper();
    }
    await clientInstance.init();
    return clientInstance;
  }

  determineChainFromSubversion(subversion, flag) {
    console.log('chain subversion '+subversion+' '+flag )
    subversion = subversion.toLowerCase();
    if (subversion.includes('litecoin')) return 'LTC';
    if (subversion.includes('bitcoin') || subversion.startsWith('/satoshi:')) return 'BTC';
    if (subversion.includes('dogecoin')) return 'DOGE';
    throw new Error(`Unknown chain in subversion: ${subversion}`);
  }

  getBlockchainInfo() {
    return util.promisify(this.client.cmd.bind(this.client, 'getblockchaininfo'))();
  }

  getRawTransaction(txId, verbose = true, blockHash) {
    const params = blockHash === undefined ? [txId, verbose] : [txId, verbose, blockHash];
    return util.promisify(this.client.cmd.bind(this.client, 'getrawtransaction'))(...params);
  }

  getnewaddress() {
    return util.promisify(this.client.cmd.bind(this.client, 'getnewaddress'))();
  }

  sendtoaddress(addr,amt){
    return util.promisify(this.client.cmd.bind(this.client, 'sendtoaddress'))(addr,amt)
  }

  getNetworkInfo(){
    return util.promisify(this.client.cmd.bind(this.client, 'getnetworkinfo'))()
  }

  getWalletPath() {
    const wallet = process.env.RPC_WALLET || process.env.LTC_WALLET || process.env.WALLET_NAME;
    return wallet ? `/wallet/${wallet}` : null;
  }

  rpcCall(method, params = [], walletScoped = false) {
    const path = walletScoped ? this.getWalletPath() : null;
    const rpc = this.client && this.client.rpc;
    if (!rpc || typeof rpc.call !== 'function' || !path) {
      return util.promisify(this.client.cmd.bind(this.client, method))(...params);
    }

    return new Promise((resolve, reject) => {
      rpc.call(
        method,
        params,
        (result) => resolve(result),
        (err) => reject(err),
        path
      );
    });
  }

  getTransaction(txId) {
    return util.promisify(this.client.cmd.bind(this.client, 'gettransaction'))(txId);
  }

  getBlock(blockHash, verbosity = 1) {
    return util.promisify(this.client.cmd.bind(this.client, 'getblock'))(blockHash, verbosity);
  }

  getBlockHash(height) {
    return util.promisify(this.client.cmd.bind(this.client, 'getblockhash'))(height);
  }

  createRawTransaction(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'createrawtransaction'))(...params);
  }

  listUnspent(...params) {
    return this.rpcCall('listunspent', params, true);
  }

  decoderawtransaction(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'decoderawtransaction'))(...params);
  }

  signrawtransactionwithwallet(...params) {
    return this.rpcCall('signrawtransactionwithwallet', params, true);
  }

  dumpprivkey(...params) {
    return this.rpcCall('dumpprivkey', params, true);
  }

  sendrawtransaction(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'sendrawtransaction'))(...params);
  }

  validateAddress(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'validateaddress'))(...params);
  }

  getBlockCount() {
      return util.promisify(this.client.cmd.bind(this.client, 'getblockcount'))();
  }

  loadWallet(...params) {
    return util.promisify(this.client.cmd.bind(this.client, 'loadwallet'))(...params);
  }

  listlabels(...params) {
    return this.rpcCall('listlabels', params, true);
  }

  getaddressesbylabel(label) {
    return this.rpcCall('getaddressesbylabel', [label], true);
  }

  getwalletinfo() {
    return this.rpcCall('getwalletinfo', [], true);
  }

  listunspent() {
    return this.rpcCall('listunspent', [], true);
  }


  // Add this method to the ClientWrapper class
  async verifyClientChain() {
    try {
      const networkInfo = await clientInstance.getNetworkInfo();
      const subversion = networkInfo.subversion.toLowerCase();
      let match;
      if (subversion.includes('litecoin')) {
        match = 'LTC';
      } else if (subversion.includes('bitcoin')) {
        match = 'BTC';
      } else if (subversion.includes('dogecoin')) {
        match = 'DOGE';
      }

      if (match && match !== this.chain) {
        console.warn(`Mismatch: Configured chain is ${this.chain}, but detected ${match}.`);
        this.chain = match;
      } else {
        console.log(`Verified chain: ${this.chain}`);
      }
    } catch (error) {
      console.error('Error verifying chain:', error);
    }
  }

  async getChain() {
    const bleh= await this.getNetworkInfo(); // Double-check chain type
    console.log('determining chain in get chain')  
    return this.determineChainFromSubversion(bleh.subversion, true);
  }

  async getTest(){
    const blockchainInfo = await this.getBlockchainInfo();
    const profile = readDeploymentProfile();
    if (profile) await verifyDeploymentNode(this, profile, blockchainInfo);
    return isTestNetwork(blockchainInfo.chain);
  }

  clientInstance = this;


  // Additional RPC methods as needed...
}

// Export singleton instance
module.exports = ClientWrapper;
