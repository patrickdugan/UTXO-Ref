const Datastore = require('./nedbRuntime');
const path = require('path');
const util = require('util');
const ClientWrapper = require('./client')
const { readDeploymentProfile, deploymentStateRoot } = require('./deploymentProfile');


class Database {
    constructor() {
        this.databases = {};
        this.initialized = false;
        this.initializing = false
        this.initPromise = null;
        this.path = ''
        this.test=false
    }

    async init(chain) {
        if (this.initialized) {
            return
        }
        if (this.initializing && this.initPromise) {
            await this.initPromise;
            return;
        }
        this.initializing= true
        this.initPromise = (async () => {
            const skipRpcBootstrap = process.env.TL_SKIP_RPC_BOOT === '1';
            if (skipRpcBootstrap && readDeploymentProfile()) throw new Error('A deployment profile cannot skip RPC network verification');

            if (skipRpcBootstrap) {
                if (!chain) {
                    chain = (process.env.CHAIN || 'LTC').toUpperCase();
                }
                this.test = process.env.TL_FORCE_TEST === '0' ? false : true;
            } else {
                const instance = await ClientWrapper.getInstance();
                if (!chain) {
                    chain = await instance.getChain();
                }
                this.test = await instance.getTest();
            }

            while (!chain) {
                console.log('Waiting for chain...');
                await new Promise(resolve => setTimeout(resolve, 300));
                if (!skipRpcBootstrap) {
                    const instance = await ClientWrapper.getInstance();
                    chain = instance.chain;
                } else {
                    chain = (process.env.CHAIN || 'LTC').toUpperCase();
                }
            }
            let test = 'test'
            if(this.test==false){
                test = 'main'
            }
            const folderName = chain.toLowerCase()+'-'+test
            const deployment = readDeploymentProfile();
            if (deployment && (chain !== 'BTC' || this.test !== true)) throw new Error('Deployment database requires Bitcoin testnet4');
            const rootOverride = deployment ? deploymentStateRoot(deployment) : process.env.TL_NEDB_ROOT;
            const baseDir = rootOverride
                ? (path.isAbsolute(rootOverride) ? rootOverride : path.join(__dirname, '..', rootOverride))
                : path.join(__dirname, '..', 'nedb-data');
            const dbPath = path.join(baseDir, folderName);
            this.path=dbPath
            const categories = ['ammRegistry', 'ammState','txIndex', 'propertyList', 
            'oracleList', 'oracleData', 'contractList','tallyMap', 'tallyMapDelta', 
            'marginMapDelta', 'marginMaps', 'clearlists','attestations', 'clearing', 
            'consensus', 'persistence','volumeIndex','channels', 'withdrawQueue', 
            'activations', 'insurance','orderBooks','feeCache', 'tradeHistory', 
            'fundingEvents', 'vaults','syntheticTokens','liquidations', 'scaling',
            'channelDelta','iou','procedural'
            ];

            categories.forEach(category => {
                try {
                    const db = new Datastore({ 
                        filename: path.join(dbPath, `${category}.db`), 
                        autoload: true 
                    });

                    db.findAsync = util.promisify(db.find.bind(db));
                    db.insertAsync = util.promisify(db.insert.bind(db));
                    db.removeAsync = util.promisify(db.remove.bind(db));
                    db.updateAsync = util.promisify(db.update.bind(db));
                    db.findOneAsync = util.promisify(db.findOne.bind(db));
                    db.countAsync = util.promisify(db.count.bind(db));

                    this.databases[category] = db;
                } catch (error) {
                    console.error(`Error initializing database for category ${category}:`, error);
                    throw error; // Re-throw error after logging
                }
            });

            this.initialized = true;
        })();
        try {
            await this.initPromise;
        } finally {
            this.initializing = false;
        }
    }

    async getDatabase(category) {
        if (!this.initialized) {
            await this.init();
        }
        return this.databases[category];
    }
}

const databaseInstance = new Database();
(async () => {
    await databaseInstance.init();
})();

module.exports = databaseInstance;
