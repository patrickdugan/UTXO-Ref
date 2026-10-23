// Define a global shutdown event
const EventEmitter = require('events');
class ShutdownEmitter extends EventEmitter {}
const shutdownEmitter = new ShutdownEmitter();
//const fetch = require('node-fetch'); // For HTTP requests (e.g., price lookups)
const util = require('util')
const ReOrgChecker = require('./reOrg.js');
// main.js
const initialize = require('./init');
let client 
let db
const bootstrap = initialize().then(({ Client, Db }) => { client = Client; db = Db; });

const fs = require('fs'); // File system module
const { readDeploymentProfile, verifyDeploymentNode } = require('./deploymentProfile');

const Validity = require('./validity.js'); // Module for checking transaction validity
const TxUtils = require('./txUtils.js'); // Utility functions for transactions
const TxIndex = require('./txIndex.js') // Indexes TradeLayer transactions
const TradeChannel = require('./channels.js'); // Manages Trade Channels
const TallyMap = require('./tally.js'); // Manages Tally Mapping
const MarginMap = require('./marginMap.js'); // Manages Margin Mapping
const Clearing = require('./clearing.js')
const Channels = require('./channels.js')
const PropertyManager = require('./property.js'); // Manages properties
const ContractsRegistry = require('./contractRegistry.js'); // Registry for contracts
const VolumeIndex = require('./volumeIndex.js')
const TradeLayerManager = require('./vesting.js')
const Consensus = require('./consensus.js'); // Functions for handling consensus
const Oracles = require('./oracle.js')
const Activation = require('./activation.js')
const Orderbook = require('./orderbook.js')
const Persistence = require('./persistence.js');
let activation

const activationReady = bootstrap.then(async () => {
    activation = Activation.getInstance();
    await activation.init();
});

const Encode = require('./txEncoder.js'); // Encodes transactions
const Types = require('./types.js'); // Defines different types used in the system
const Logic = require('./logic.js')
const AMM = require('./amm.js')
const Decode = require('./txDecoder.js'); // Decodes transactionsconst db = require('./db.js'); // Adjust the path if necessary
const genesisBlock = 3082500
const COIN = 100000000
let pause = false

const GENESIS_BLOCK_HEIGHTS = {
    BTC: {
        test: 3520000,  // Replace with actual testnet genesis block height
        main: 880000,  // Replace with actual mainnet genesis block height
    },
    DOGE: {
        test: 6815000,  // Replace with actual testnet genesis block height
        main: 5520000,  // Replace with actual mainnet genesis block height
    },
    LTC: {
        test: 3082500,  // Replace with actual testnet genesis block height
        main: 2819000,  // Replace with actual mainnet genesis block height
    }
};

class Main {
    static instance;
    static isInitializing = false;  // Add a flag to track initialization


    constructor() {
        console.log('inside main constructor '+Boolean(Main.instance))
        if (Main.instance) {
            console.log('main already initialized')
            return Main.instance;
        }

        this.client=client// Use the already initialized clientInstance  // Initialize the client with the specified chain     
 
        console.log('RPC client initialized in Main');
        //this.tradeLayerManager = new TradeLayerManager();
        this.txIndex = TxIndex.getInstance();  
        this.getBlockCountAsync = () => this.client.getBlockCount();
        this.getNetworkInfoAsync = () => this.client.getNetworkInfo();        
        this.genesisBlock = 600000
        this.parseBlock = 0
        console.log(this.genesisBlock)
        Main.instance = this;
    }

    static async getInstance() {
        await activationReady;
        if (!Main.instance && !Main.isInitializing) {
            Main.isInitializing = true;
            console.log('Initializing Main instance...');

            // 1. Construct Main first
            Main.instance = new Main();

            // 2. Detect network from the initialized client instance
            const net = await Main.instance.client.getChain();
            const test = await Main.instance.client.getTest();
            console.log("[Main] Detected network:", net, "test:", test);

            // 3. Initialize Persistence ONCE only via its own singleton
            Main.instance.blockchainPersistence = await Persistence.getInstance({
                network: net,
                test: test,
                snapshotInterval: 1000
            });

            Main.persistenceInitialized = true;
            Main.isInitializing = false;
        }

        return Main.instance;
    }


    async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
    }

    async initialize(options = {}) {
        this.followBlocks = options.followBlocks !== false;
          await this.delay(1500)
        console.log('db status '+db)
        if(!db&&this.client){
            console.log('have client, awaiting db')
            await db.init(this.client.chain)
            await this.delay(300)
            console.log('db status recheck '+db.initialized)
        }else if(!db.initialized&&!this.client.chain){
            console.log('no client no db, trying init again')
            const { Client, Db } = await initialize();   
               await this.delay(300)
            console.log('db+client status recheck '+db.initialized+this.client.chain)
        } 
        const txIndex = await TxIndex.getInstance();
        this.test = await this.client.getTest()
        this.chain = await this.client.getChain()
        console.log('this.test '+this.test+' '+this.chain)
        console.log('block heights '+GENESIS_BLOCK_HEIGHTS)
        const deployment = readDeploymentProfile();
        const blockchainInfo = await this.client.getBlockchainInfo();
        if (this.chain === 'BTC' && blockchainInfo.chain === 'testnet4' && !deployment) {
            throw new Error('Bitcoin testnet4 requires an explicit TradeLayer deployment profile');
        }
        if (deployment) {
            if (this.chain !== 'BTC') throw new Error('The deployment profile requires Bitcoin');
            await verifyDeploymentNode(this.client, deployment, blockchainInfo);
            this.genesisBlock = deployment.genesisBlock;
        } else if (this.test !== undefined && this.chain !== undefined) {
            const networkType = this.test ? 'test' : 'main'; // Map boolean to 'test' or 'main'
            const genesisConfig = GENESIS_BLOCK_HEIGHTS?.[this.chain];
            
            if (genesisConfig && genesisConfig[networkType] !== undefined) {
                this.genesisBlock = genesisConfig[networkType];
                console.log(`Genesis Block for ${this.chain} (${networkType}): ${this.genesisBlock}`);
            } else {
                console.error(`Genesis block not configured for chain: ${this.chain} (${networkType})`);
            }
        } else {
            console.error('Chain or test flag is undefined. Cannot set genesis block.');
        }

        console.log('genesis block in tx index init '+this.genesisBlock)
        try {
            await txIndex.initializeOrLoadDB(this.genesisBlock);
            // Proceed with further operations after successful initialization
        } catch (error) {
            if (deployment) throw error;
            console.log('boop '+error)
        }
          console.log('about to check for Index')
        const indexExists = await TxIndex.checkForIndex();
        console.log('indexExists' + indexExists);
        if (deployment) {
            await TxIndex.initializeIndex(this.genesisBlock);
            const indexed = await TxIndex.findMaxIndexedBlock();
            await TxIndex.extractBlockData(indexed == null ? this.genesisBlock : Math.max(this.genesisBlock, indexed + 1));
        } else if (!indexExists) {
            console.log('building txIndex');
            await this.initOrLoadTxIndex()
            //await TxIndex.initializeIndex(this.genesisBlock);

        }

        // Construct consensus from index, or load from Persistence if available
        console.log('constructing consensus state')
        const consensus = await this.constructOrLoadConsensus();

        // Start processing incoming blocks
        //await this.processIncomingBlocks(consensus);
        
    }

    async getCurrentBlockHeight() {
      try {
        const blockchainInfo = await this.getBlockCountAsync();
        console.log(blockchainInfo)
        return blockchainInfo;
      } catch (error) {
        console.error('Error fetching current block height:', error);
        throw error; // or handle error as needed
      }
    }

    async initOrLoadTxIndex() {
        // Check if the txIndex exists by trying to find the max indexed block
        var maxIndexedBlock = await TxIndex.findMaxIndexedBlock();
        console.log('max Indexed Block ' + JSON.stringify(maxIndexedBlock))
        if (maxIndexedBlock === 0 || maxIndexedBlock === null) {
            // Initialize the txIndex if it doesn't exist
            console.log('about to init index with ' +this.genesisBlock)
            await TxIndex.initializeIndex(this.genesisBlock);
            maxIndexedBlock= this.genesisBlock
        }
        // Proceed to synchronize the index
        await this.syncIndex(maxIndexedBlock);
    }

    async syncIndex(maxIndexedBlock) {
      console.log('sync Index maxIndexedBlock '+maxIndexedBlock)
        try {
            // Find the maximum indexed block in the database
            if(maxIndexedBlock===null){this.initOrLoadTxIndex()}
            // Fetch the current chain tip (latest block number) from the blockchain
            const chainTip = await this.getBlockCountAsync()
            console.log('sync index retrieved chaintip '+chainTip)
            // If the chain tip is greater than the max indexed block, sync the index
            if (chainTip > maxIndexedBlock && maxIndexedBlock !== 0 && maxIndexedBlock !== null){
                // Loop through each block starting from maxIndexedBlock + 1 to chainTip
                console.log('building tx index '+maxIndexedBlock)
                return await TxIndex.extractBlockData(maxIndexedBlock)
            } else if(maxIndexedBlock==0|| maxIndexedBlock == {}){
              console.log('building txIndex from genesis')
                return await TxIndex.extractBlockData(this.genesisBlock)
            }else if(maxIndexedBlock==chainTip){

                console.log("TxIndex is already up to date.");
                return this.constructOrLoadConsensus(maxIndexedBlock)
            }
        } catch (error) {
            console.error("Error during syncIndex:", error);
        }
    }

    async constructOrLoadConsensus() {
        let consensusState;

        try {
            //const lastSavedHeight = await persistenceDB.get('lastSavedHeight');
            const startHeight = /*lastSavedHeight ||*/ this.genesisBlock;
            return this.constructConsensusFromIndex(startHeight, false);
        } catch (error) {
            if (error.type === 'NotFoundError') {
                // If no saved state, start constructing consensus from genesis block
                console.log("no consensus found")
                return this.constructConsensusFromIndex(this.genesisBlock, false);
            } else {
                console.error('Error loading consensus state:', error);
                throw error;
            }
        }
    }

    /*
        Most important function, has two modes, realtime==false means we're catching up and constructing consensus,
        from the txIndex, from genesis until chaintip.
        Real-time==true means we're looping in a delayed timer to check for new blocks and include any new ones in the
        txIndex then apply them to this to update the db and consensus.
    */
       async constructConsensusFromIndex(startHeight) {
             let lastIndexBlock = await TxIndex.findMaxIndexedBlock();
            const indexedTip = lastIndexBlock;
            let blockHeight;
            let maxProcessedHeight = startHeight - 1;

            const txIndexDB = await db.getDatabase('txIndex');
            const tallyMapInstance = TallyMap.getInstance();
            const lastConsensusHeight = await this.loadMaxProcessedHeight();

            // Fetch all transaction data
            const allTxData = await txIndexDB.findAsync({});
            const txDataSet = allTxData.filter(txData => txData._id.startsWith('tx-'));

            // Group transactions by block height
            const txByBlockHeight = txDataSet.reduce((acc, txData) => {
                const txBlockHeight = parseInt(txData._id.split('-')[1]);
                if(!acc[txBlockHeight]){
                    acc[txBlockHeight] = {
                        fundingTx: [],  // Bucket for funding transactions
                        tradeTx: []     // Bucket for regular trade transactions
                    };
                }
                //console.log('troubleshooting 1 '+txData.value)
                // Determine if the transaction is a funding transaction (type starting with 4 or 20)
                let counter1 = 0
                let counter2 = 0
                const valueData=txData.value
                if (!valueData || !valueData.payload) return acc;
                    const payload = valueData.payload;
                    const type = parseInt(payload.slice(0, 1).toString(36), 36);
                    // Assuming types 4 and 20 are the funding types
                    if (type === 4 || type === 20) {
                        counter1++
                        //console.log('logging funding '+counter1+' '+JSON.stringify(txData))
                        acc[txBlockHeight].fundingTx.push(txData);
                    } else {
                        counter2++
                        //console.log('logging other '+counter2+' '+JSON.stringify(txData))
                        acc[txBlockHeight].tradeTx.push(txData);
                    }
                return acc;
            }, {});

            //console.log(JSON.stringify(txByBlockHeight))

            // Determine the last block height with transactions
            const blockHeights = Object.keys(txByBlockHeight).map(Number);
            if (blockHeights.length > 0) {
                lastIndexBlock = Math.max(...blockHeights);
            } else {
                lastIndexBlock = null;
            }

            if (!lastIndexBlock) {
                console.log('No transactions to process.');
                if (Number.isSafeInteger(indexedTip)) await this.saveMaxProcessedHeight(indexedTip);
                if (this.followBlocks) return this.syncIfNecessary();
                return;
            }

            blockHeight = startHeight;
            console.log('construct Consensus from Index max indexed block ' + lastIndexBlock, 'start height ' + startHeight);

            for (; blockHeight <= lastIndexBlock; blockHeight++) {
                this.parseBlock = blockHeight
                if(blockHeight%10000==1){console.log('parsing towards real-time mode '+blockHeight)}
                const blockData = txByBlockHeight[blockHeight];
                let skip = true
                //if(blockHeight%1000){console.log('block consensus processing '+blockHeight)}
                if (blockData) {
                    // First process funding transactions
                    const skips = await this.processTxSet(blockData.fundingTx, blockHeight);
                    console.log('skips? '+skips)
                    // Then process trade transactions
                    const skips2 = await this.processTxSet(blockData.tradeTx, blockHeight);
                    console.log('skips 2? '+skips2)
                    if((skips+skips2)<(blockData.fundingTx.length+blockData.tradeTx.length)){
                        console.log('skip to my lou my darlin '+skips +' '+skips2+' '+blockData.fundingTx.length+' '+blockData.tradeTx.length)
                        skip=false
                        if((skips+skips2)>0){
                            // Replay can legitimately hit partially processed blocks after prior crashes.
                            // Continue idempotently: process remaining txs and run post-processing once.
                            console.warn("partially processed block detected; continuing idempotent replay");
                        }
                    }
                }
                if(blockHeight%10000==0){skip=false}
                if(skip==false){ //we don't do any post-processing on state for this block if it's already done, no replay of vesting, clearing
                    await TallyMap.flushQueuedFeeAccruals(blockHeight);
                    await Logic.settleLiquidityRewards(blockHeight);
                    await Orderbook.processQueuedOnChainOrdersForBlock(blockHeight);
                    await Orderbook.processQueuedChannelTradesForBlock(blockHeight);
                    const cumulativeVolumes = await VolumeIndex.getCumulativeVolumes(blockHeight);
                    const thisBlockVolumes = await VolumeIndex.getBlockVolumes(blockHeight);
                    if (thisBlockVolumes.global > 0){
                        console.log('This is a block volume! ' + thisBlockVolumes);
                        const updateVesting = await TradeLayerManager.updateVesting(
                            cumulativeVolumes.ltcPairTotalVolume,
                            thisBlockVolumes.ltcPairs,
                            cumulativeVolumes.globalCumulativeVolume,
                            thisBlockVolumes.global
                        );
                        if (updateVesting != null && updateVesting != undefined && thisBlockVolumes != 0) {
                            console.log('Update Vesting in block ' + blockHeight + ' ' + JSON.stringify(updateVesting));
                            await TallyMap.applyVesting(2, updateVesting.two, blockHeight);
                            await TallyMap.applyVesting(3, updateVesting.three, blockHeight);
                        }
                    }

                    // Additional processing steps like withdrawal and clearing
                    await Channels.processWithdrawals(blockHeight);
                    await Clearing.clearingFunction(blockHeight,false);
                }

                maxProcessedHeight = blockHeight;
            }

            await this.saveMaxProcessedHeight(maxProcessedHeight,false,null);
            if (this.followBlocks) return this.syncIfNecessary();
        }

        async checkSync(){
            const consensusParse = this.parseBlock
            const txIndex = await TxIndex.getInstance();
            const txIndexParse = txIndex.parseBlock
            return {consensus: consensusParse, txIndex: txIndexParse}
        }

        // Helper function to process a set of transactions
        async processTxSet(txSet, blockHeight) {
            let skips = 0
            for (const txData of txSet) {
                let flag = false;
                let txId = 'unknown';
                let type = -1;
                try {
                    const valueData = txData.value
                    txId = valueData.txId;
                    
                    if (await Consensus.checkIfTxProcessed(txId)) {
                        //console.log('scanning blockHeight '+blockHeight+' '+txId)
                        skips++
                        continue;
                    }

                    var payload = valueData.payload;
                    const marker = valueData.marker;
                    type = parseInt(payload.slice(0, 1).toString(36), 36);
                    console.log('type is '+type + ' height is '+blockHeight)
                    payload = payload.slice(1, payload.length).toString(36);
                    const senderAddress = valueData.sender.senderAddress;
                    const referenceAddress = valueData.reference;
                    const senderUTXO = valueData.sender.amount;
                    const referenceUTXO = valueData.reference.amount / COIN;

                    if (flag) {
                        console.log('missing tx params ' + txId,
                            type,
                            marker,
                            payload,
                            senderAddress,
                            referenceAddress,
                            senderUTXO,
                            referenceUTXO,
                            blockHeight);
                    }

                    let decodedParams = await Types.decodePayload(
                        txId,
                        type,
                        marker,
                        payload,
                        senderAddress,
                        referenceAddress,
                        senderUTXO,
                        referenceUTXO,
                        blockHeight
                    );

                    if (flag) {
                        console.log('missing tx decode ' + decodedParams);
                    }
                    console.log('decoded params ' +JSON.stringify(decodedParams))
                    decodedParams.block = blockHeight;

                    if (decodedParams.valid === true) {
                        try {
                            await Logic.typeSwitch(type, decodedParams);
                        } catch (logicErr) {
                            if (logicErr?.superseded) throw logicErr;
                            decodedParams.valid = false;
                            decodedParams.reason = `${decodedParams.reason || ''} Logic error: ${logicErr.message}`;
                            console.error(`Logic failure while processing tx ${txId} at block ${blockHeight}:`, logicErr);
                        }
                    }

                    await Consensus.markTxAsProcessed(txId, decodedParams);
                    await TxIndex.upsertTxValidityAndReason(txId, type, decodedParams.valid, decodedParams.reason);
                } catch (txErr) {
                    if (txErr?.superseded) throw txErr;
                    console.error(`Fatal tx processing failure for ${txId} at block ${blockHeight}:`, txErr);
                    const failedParams = {
                        valid: false,
                        reason: `Fatal tx processing error: ${txErr.message}`,
                        block: blockHeight,
                        txid: txId
                    };
                    if (txId !== 'unknown') {
                        await Consensus.markTxAsProcessed(txId, failedParams);
                        if (type >= 0) {
                            await TxIndex.upsertTxValidityAndReason(txId, type, false, failedParams.reason);
                        }
                    }
                }
            }
            return skips
        }

        async processTx(txSet, blockHeight) {
              let processedAny = false;

              for (const txData of txSet) {
                let txId = 'unknown';
                let type = -1;
                try {
                  console.log('tx data in real-time' + JSON.stringify(txData));
                  txId = txData.txId;

                  if (await Consensus.checkIfTxProcessed(txId)) {
                    // We *skip* this tx, but keep going in case there are new ones
                    continue;
                  }

                  let payload = txData.payload;
                  const marker = 'tl';

                  type = parseInt(payload.slice(0, 1).toString(36), 36);
                  payload = payload.slice(1, payload.length).toString(36);

                  const senderAddress    = txData.sender.senderAddress;
                  const referenceAddress = txData.reference;
                  const senderUTXO       = txData.sender.amount;
                  const referenceUTXO    = txData.reference.amount / COIN;

                  console.log('params to go in during consensus builder ' + type + '  ' + payload + ' ' + senderAddress + blockHeight);

                  const decodedParams = await Types.decodePayload(
                    txId, type, marker, payload,
                    senderAddress, referenceAddress,
                    senderUTXO, referenceUTXO,
                    blockHeight
                  );
                  decodedParams.block = blockHeight;

                  // activation checks as you already have...
                  if (decodedParams.type > 0) {
                    const activationBlock = activation.getActivationBlock(decodedParams.type);
                    if (blockHeight < activationBlock) {
                      decodedParams.valid = false;
                      decodedParams.reason += 'Tx not yet activated ';
                    }
                  }

                  if (decodedParams.valid === true) {
                    processedAny = true;
                    console.log('valid tx going in for processing ' + type + JSON.stringify(decodedParams) + ' ' + txId + 'blockHeight ' + blockHeight);
                    try {
                      await Logic.typeSwitch(type, decodedParams);
                    } catch (logicErr) {
                      if (logicErr?.superseded) throw logicErr;
                      decodedParams.valid = false;
                      decodedParams.reason = `${decodedParams.reason || ''} Logic error: ${logicErr.message}`;
                      console.error(`Realtime logic failure while processing tx ${txId} at block ${blockHeight}:`, logicErr);
                    }
                  } else {
                    console.log('invalid tx ' + decodedParams.reason);
                  }
                  await Consensus.markTxAsProcessed(txId, decodedParams);
                  await TxIndex.upsertTxValidityAndReason(txId, type, decodedParams.valid, decodedParams.reason);
                } catch (txErr) {
                  if (txErr?.superseded) throw txErr;
                  console.error(`Realtime fatal tx processing failure for ${txId} at block ${blockHeight}:`, txErr);
                  const failedParams = {
                    valid: false,
                    reason: `Fatal tx processing error: ${txErr.message}`,
                    block: blockHeight,
                    txid: txId
                  };
                  if (txId !== 'unknown') {
                    await Consensus.markTxAsProcessed(txId, failedParams);
                    if (type >= 0) {
                      await TxIndex.upsertTxValidityAndReason(txId, type, false, failedParams.reason);
                    }
                  }
                }
              }

              return processedAny;
            }


    /*originally was an if-logic based switch function but refactoring real-time mode
      it simply is a part of a flow, could be refactored into one function
    */
    async syncIfNecessary(restore) {
        const blockLag = await this.checkBlockLag();
        if(restore){
            blockLag.maxTrack=restore
            console.log('set max track to restore '+blockLag.maxTrack)
        }
        
        if(pause){
            while(pause){
                await this.delay(1000)
            }
            return this.syncIfNecessary()
        }else{
                this.processIncomingBlocks(blockLag.lag, blockLag.maxTrack, blockLag.chainTip).catch(error => {
                    this.followError = error.message;
                    console.error('TradeLayer block following stopped:', error);
                });
        }
    }

    setPause(){
       if(!pause){
            pause=true 
       }else if(pause){
            pause=false
       }
       return pause
    }

    //updates max consensus block in real-time mode
    async checkBlockLag(){
        const chaintip = await this.getBlockCountAsync()
        let track = await this.loadTrackHeight()
        const processed = await this.loadMaxProcessedHeight();
        if (track == null) track = processed;
        else if (Number.isSafeInteger(processed)) track = Math.min(track, processed);
        //console.log(maxConsensusBlock)
        var lag = chaintip - track
        return {'lag':lag, 'chainTip':chaintip, 'maxTrack':track}
    }

    /*main function of real-time mode*/
    async processIncomingBlocks(lag, maxTrack, chainTip) {
        // Continuously loop through incoming blocks and process them
        let latestProcessedBlock = maxTrack
        console.log('entering real-time mode '+latestProcessedBlock)
        let lagObj
        while (true) {
            /*if (shutdownRequested) {
                break; // Break the loop if shutdown is requested
            }*/
            chainTip = await this.getBlockCountAsync()
            //console.log('latest block '+chainTip+' max track'+latestProcessedBlock)
            let checkTrack = await this.loadTrackHeight()
            const processedHeight = await this.loadMaxProcessedHeight();
            if(checkTrack>latestProcessedBlock && processedHeight >= checkTrack){latestProcessedBlock=checkTrack}
            for (let blockNumber = latestProcessedBlock + 1; blockNumber <= chainTip; blockNumber++) {
                
                const networkIsUp = await this.checkNetworkStatus();
                if (!networkIsUp.status) {
                    console.log('Network down, entering recovery mode.');
                    blockNumber = await this.enterRecoveryMode(latestProcessedBlock, blockNumber);
                }

                //const blockData = await TxIndex.fetchBlockData(blockNumber);
                const blockData = await this.fetchWithRetry(blockNumber);
                const block= await this.processBlock(blockData, blockNumber);

                if(block.reOrg==true){
                    console.log('returned block to restore '+JSON.stringify(block))
                    return this.syncIfNecessary(block.restore)
                }
                let trackHeight = blockNumber;
                await this.saveMaxProcessedHeight(blockNumber);
                //console.log('updating trackHeight'+trackHeight)
                await this.saveTrackHeight(trackHeight)
            }

            if(pause==true){
               console.log('exiting real-time mode '+latestProcessedBlock)  
                break
            };
            // Wait for a short period before checking for new blocks
            await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
            //console.log('checking block lag '+maxConsensusBlock+' '+chainTip)
            await this.saveTrackHeight(chainTip)
        }
        return this.syncIfNecessary()
    }

        async checkNetworkStatus() {
            try {
                // Fetch network info using the promisified getnetworkinfo RPC call
                //console.log('about to ping')
                const networkInfo = await this.getNetworkInfoAsync();

                // Check if the network is active
                const networkActive = networkInfo.networkactive;
                const connections = networkInfo.connections;

                //console.log('Network Status:', networkInfo);

                // Determine if there is a potential network outage or issue
                if (!networkActive) {
                    console.error('Network is inactive! The node is not connected to the Bitcoin network.');
                    return { status: false, reason: 'Network inactive' };
                }

                if (connections === 0) {
                    console.warn('Node has 0 connections. It may be isolated from the network.');
                    return { status: false, reason: 'No connections' };
                }

                // If everything seems fine
                //console.log('Network is active with', connections, 'connections.');
                return { status: true, connections: connections };

            } catch (error) {
                // Handle errors such as ECONNREFUSED (cannot connect to the node)
                if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                    console.error(`Network error: ${error.message}. Could not reach the Bitcoin node.`);
                    return { status: false, reason: 'Connection refused or timeout' };
                } else {
                    console.error('An unexpected error occurred:', error);
                    throw error; // Rethrow if it's an unexpected error
                }
            }
        }

        async enterRecoveryMode(latestProcessedBlock, trackHeight) {
            console.log('Entering recovery mode, last processed block:', latestProcessedBlock);

            while (true) {
                const networkIsUp = await this.checkNetworkStatus();
                if (networkIsUp.status) {
                    console.log('Network restored, resuming block processing.');

                    // Reload state from the database to ensure we're starting from the correct point
                    const savedTrackHeight = await this.loadTrackHeight();
                    const maxConsensusBlock = await this.loadMaxProcessedHeight();

                    console.log(`Resuming from block: ${latestProcessedBlock}, track height: ${trackHeight}`);
                    return savedTrackHeight; // Exit recovery mode and resume normal processing
                }

                // Retry after a short delay before checking the network again
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }


    /*sub-function of real-time mode, breaks things into 3 steps*/
    async processBlock(blockData, blockNumber) {
        // Process the beginning of the block
        const tx= await this.blockHandlerBegin(blockData, blockNumber);
        if(typeof tx=='number'){return {reOrg: true, restore: tx}}//re-org recovery at block
        // Process each transaction in the block
        blockNumber = await this.blockHandlerMid(tx, blockNumber);

        // Process the end of the block
        await this.blockHandlerEnd(blockData.hash, blockNumber);
        return {reOrg:false, restore: blockNumber}
    }

     async shutdown() {
        console.log('Saving state to database...');
        // Code to save state to database
        console.log('Shutdown completed.');
        process.exit(0); // or use another method to exit gracefully
      }

      async fetchWithRetry(blockNumber, retries = 3, delayMs = 1000) {
            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                      return await TxIndex.fetchBlockData(blockNumber);  // Directly call the function
                } catch (error) {
                    if (error.code === 'ETIMEDOUT') {
                        console.warn(`Attempt ${attempt + 1} failed with ETIMEDOUT.`);
                        if (attempt === retries) throw error; // Re-throw if max retries reached
                        await this.delay(delayMs * Math.pow(2, attempt)); // Exponential backoff
                    } else {
                        throw error; // Rethrow non-timeout errors
                    }
                }
            }
        }

    async blockHandlerBegin(blockData, blockHeight) {
        const persistence = await Persistence.getInstance();

        //try {
            if (persistence) {
            // 1) Live reorg detection
            const reorg = await persistence.checkForReorgForNewBlock(
                blockHeight,
                blockData.previousblockhash
            );
            if (reorg) {
                // Handle deep reorg (offline or multiple blocks)
                const info = await persistence.detectAndHandleReorg(blockHeight);
                if (info && typeof info.restoredFrom === 'number') {
                    console.log(
                        `Replaying consensus from snapshot at ${info.restoredFrom + 1} ` +
                        `after reorg (common ancestor ${info.commonAncestor}).`
                    );
                    
                    //await this.constructConsensusFromIndex(info.restoredFrom + 1, true);
                    return info.restoredFrom 
                }
            }

            // 2) Record this block header for future comparisons
            await persistence.recordBlockHeader(
                blockHeight,
                blockData.hash,
                blockData.previousblockhash
            );

            // 3) Maybe write a snapshot + consensus checkpoint
            await persistence.maybeCheckpoint(blockHeight);
        }
            //const blockData = await TxIndex.fetchBlockData(blockHeight);
            const txDetails = await TxIndex.processBlockData(blockData, blockHeight);
         
            if(txDetails.length>=1){
                console.log('processing new tx '+JSON.stringify(txDetails))   
            }
            // Separate out Commit/Transfer transactions from others
            const fundingTxs = [];
            const otherTxs = [];

            for (const tx of txDetails) {
                if (tx.payload.startsWith('4') || tx.payload.startsWith('m')) {
                    fundingTxs.push(tx);
                } else {
                    otherTxs.push(tx);
                }
                console.log('funding tx '+JSON.stringify(fundingTxs))
            }

            // Process Commit/Transfer transactions first
            if (fundingTxs.length > 0) {
                await this.processTx(fundingTxs, blockHeight);
                console.log(`Processed funding txs for block ${blockHeight}`);
            }

            // Pass other transactions to `blockHandlerMid` for processing later
            return otherTxs;  // Store remaining txs for mid-processing
       /*} catch (error) {
            console.error(`Error in blockHandlerBegin at block ${blockHeight}:`, error);

            // Normalize error message into a string safely
            const msg = (error?.message || error?.toString?.() || "");

            if (msg.includes("ETIMEDOUT")) {
                // retry
                return this.blockHandlerBegin('', blockHeight);
            }

            return [];
        }*/
    }


    /*middle part of real-time mode processed new tx */
    async blockHandlerMid(txData, blockHeight) {
            let didWork = false;

            try {
                if (txData && txData.length > 0) {
                    console.log(`tx Data for block ${blockHeight} txData ${JSON.stringify(txData)}`);
                    
                    // processTx now returns true if any tx was newly processed
                    didWork = await this.processTx(txData, blockHeight);

                    // Save max height regardless, to persist progress
                    // Progress is persisted after the whole block succeeds.
                }

                console.log(`Processed block ${blockHeight} successfully...`);
            } catch (error) {
                // A superseded release must stop before this block is marked processed.
                if (error?.superseded) throw error;
                console.error(`Blockhandler Mid Error processing block ${blockHeight}:`, error);
            }

            // Run clearing only if there was actual new TL work done
            if (didWork) {
                await TallyMap.flushQueuedFeeAccruals(blockHeight);
                await Logic.settleLiquidityRewards(blockHeight);
                await Orderbook.processQueuedOnChainOrdersForBlock(blockHeight);
                await Orderbook.processQueuedChannelTradesForBlock(blockHeight);
                console.log(`[CLEARING] Running for block ${blockHeight} (new TL work detected)`);
                await Clearing.clearingFunction(blockHeight, /*skip=*/false);
            } else {
                //console.log(`[CLEARING] Skipped for block ${blockHeight} (no new TL work)`);
            }

            await Channels.processWithdrawals(blockHeight);
            // Always return block number for chain continuity
            return blockHeight;
        }

    /*here's where we finish a block processing in real-time mode, handling anything that is done after
    the main tx processing. But since I've stuck the clearing function, channel removal and others in the constructConsensus function
    this is currently also redundant */
    async blockHandlerEnd(blockHash, blockHeight) {
        const cumVolumes = await VolumeIndex.getCumulativeVolumes()
                const thisBlockVolumes = await VolumeIndex.getBlockVolumes(blockHeight)
                if(thisBlockVolumes>0){
                    console.log('this is a block volume! '+thisBlockVolumes)
                    const updateVesting = await TradeLayerManager.updateVesting(cumVolumes.ltcPairTotalVolume,thisBlockVolumes.ltcPairs,cumVolumes.globalCumulativeVolume,thisBlockVolumes.global)
                    if(updateVesting!=null&&updateVesting!=undefined&&thisBlockVolumes!=0){
                    console.log('update Vesting in block' +blockHeight+ ' '+JSON.stringify(updateVesting))
                    await TallyMap.applyVesting(2,updateVesting.two,blockHeight)
                    await TallyMap.applyVesting(3,updateVesting.three,blockHeight)
                    }   
                }
 
        return //console.log('block finish '+blockHeight)
    }

    async handleReorg(blockHeight) {
        //console.log(`Handling reorganization at block ${blockHeight}`);
        // Add logic to handle a blockchain reorganization
        await this.blockchainPersistence.handleReorg();
        // This could involve reverting to a previous state, re-processing blocks, etc.
    }

    async saveMaxProcessedHeight(maxProcessedHeight){ 
         try {
            const base = await db.getDatabase('consensus')
             await base.updateAsync(
                    { _id: 'MaxProcessedHeight' },
                    { $set: { value: maxProcessedHeight } },
                    { upsert: true }
                );
                //console.log('realtime mode update '+maxProcessedHeight)
        } catch (error) {
            console.error('Error updating MaxProcessedHeight:', error);
            throw error; // or handle the error as needed
        }
    }

    async saveTrackHeight(saveHeight){
            const base = await db.getDatabase('consensus')
           await base.updateAsync(
                    { _id: 'TrackHeight' },
                    { $set: { value: saveHeight } },
                    { upsert: true }
                    )
    }
 
    async loadMaxProcessedHeight() {
        const consensusDB = await db.getDatabase('consensus'); // Access the consensus sub-database

        try {
            const maxProcessedHeightDoc = await consensusDB.findOneAsync({ _id: 'MaxProcessedHeight' });
            if (maxProcessedHeightDoc) {
                const maxProcessedHeight = maxProcessedHeightDoc.value;
                //console.log('MaxProcessedHeight retrieved:', maxProcessedHeight);
                return maxProcessedHeight; // Return the retrieved value
            } else {
                console.log('MaxProcessedHeight not found in the database.');
                return null; // Return null or an appropriate default value if not found
            }
        } catch (error) {
            console.error('Error retrieving MaxProcessedHeight:', error);
            throw error; // Rethrow the error or handle it as needed
        }
    }

    async loadTrackHeight() {
        const consensusDB = await db.getDatabase('consensus'); // Access the consensus sub-database

        try {
            let track = await consensusDB.findOneAsync({ _id: 'TrackHeight' });
            if (track) {
                track = track.value;
                //console.log('MaxProcessedHeight retrieved:', maxProcessedHeight);
                return track; // Return the retrieved value
            } else {
                console.log('MaxTrackHeight not found in the database.');
                return null; // Return null or an appropriate default value if not found
            }
        } catch (error) {
            console.error('Error retrieving MaxProcessedHeight:', error);
            throw error; // Rethrow the error or handle it as needed
        }
    }

    static async getGenesisBlock() {
        const mainInstance = await Main.getInstance();
        return mainInstance.genesisBlock;
    }

    static async getLastBlock() {
        try {
            return await TxUtils.getLatestBlockHeight(); // Calls the blockchain for last block height
        } catch (error) {
            console.error("Error getting latest block height:", error);
            throw error;
        }
    }
    // ... other methods ...
}

module.exports = Main
