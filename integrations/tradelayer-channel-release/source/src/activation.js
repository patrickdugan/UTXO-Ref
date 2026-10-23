const db = require('./db.js')
//const Logic = require('./logic.js');
const TradeLayerManager = require('./vesting.js')
const Consensus = require('./consensus'); // Import consensus.js functions
const ClientWrapper = require('./client.js')
const { readDeploymentProfile } = require('./deploymentProfile');
const ReleaseIdentity = require('./releaseIdentity');

const testAdmin = "tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8"

class Activation {
    static instance = null;  // Static instance holder

    constructor(chain) {
        if (Activation.instance) {
            return Activation.instance;
        }
       
        this.consensusVector = {};
        this.txRegistry = this.initializeTxRegistry()
        //this.init(chain)
        Activation.instance = this; // Set the instance
    }

     async init(chain) {
                const client = await ClientWrapper.getInstance()
                if(!chain){
                    console.log('assigning chain '+client.chain)
                    this.chain = await client.getChain() 
                }else{
                    this.chain = await client.getChain(chain);
                }
                this.test = await client.getTest();
                this.updateAdminAddress()
            }

    updateAdminAddress() {
        const deployment = readDeploymentProfile();
        if (deployment) {
            if (this.chain !== 'BTC' || this.test !== true) throw new Error('The deployment profile requires Bitcoin testnet4');
            this.adminAddress = deployment.adminAddress;
            return;
        }
        if (this.chain === 'BTC') {
            this.adminAddress = this.test ? 'tb1q8f84erfegxhaylmvpfll9m5rgwymqy4akjnnvq' : 'bc1qktknrnx2jcchjht9anz0uy8ae02xryxq2vxeem';
        } else if (this.chain === 'DOGE') {
            this.adminAddress = this.test ? 'nop27JQWbGr95ySHXZMzCg8XXxYzbCBZAW' : 'DLSfu9qvEggkeXAgCAwBBw5BVLvMCtkewz';
        } else if (this.chain === 'LTC') {
            this.adminAddress = this.test ? 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8' : 'MTmoypkhRQoJ172ZqxcsVumPZfJ8KCrQCB';
        }
    }


    async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Static method to get the singleton instance
    static getInstance(chain) {
        if (!Activation.instance) {
            console.log('generate activation instance')
            Activation.instance = new Activation(chain);
        }
        return Activation.instance;
    }

    getAdmin(){
        return this.adminAddress
    }

    async saveActivationsList() {
    try {
        const activationsDB = await db.getDatabase('activations');
        const query = { _id: 'activationsList' };
        const update = { $set: { value: JSON.stringify(this.txRegistry) } };
        const options = { upsert: true }; // This option will insert if not found

        //console.log('Saving activations list:', JSON.stringify(this.txRegistry));
        await activationsDB.updateAsync(query, update, options);
        console.log('Activations list saved successfully.');
    } catch (error) {
        console.error('Error saving activations list:', error);
    }
}


   // New Method to load activations list
      async loadActivationsList() {
        try {
            const activationsDB = await db.getDatabase('activations');
            const entries = await activationsDB.findAsync({});

            if (entries.length === 0) {
                console.log('No activations list found, initializing with default values.');
                this.txRegistry = this.initializeTxRegistry();
                await this.saveActivationsList(); // Save the newly created default activations list
            } else {
                let data = {};
                entries.forEach(entry => {
                    data[entry._id] = entry.value;
                });

                if (data['activationsList']) {
                    this.txRegistry = JSON.parse(data['activationsList']);
                    console.log('Activations list loaded successfully.');
                } else {
                    console.error('Activations list not found in the database, initializing with default values.');
                    this.txRegistry = this.initializeTxRegistry();
                    await this.saveActivationsList(); // Save the newly created default activations list
                }
            }

            // Return the latest activations list (txRegistry)
            return this.txRegistry;
        } catch (error) {
            console.error('Error loading activations list:', error);
            this.txRegistry = this.initializeTxRegistry(); // Initialize with default values in case of any error
            await this.saveActivationsList(); // Save the newly created default activations list
            return this.txRegistry;
        }
    }


    // Example helper functions (implementations depend on your specific logic and data structures)
    async activate(txType, block, codeHash) {
        txType = parseInt(txType)
        //console.log('Activating transaction type:' +txType +(txType === 0) + ' block '+ block );
        await this.loadActivationsList(); // Make sure to load the activations list first
        if (txType === undefined) {
            console.error("Transaction type is undefined.");
            return; // Exit the function if txType is undefined
        }
        if (txType === 0) {
            //console.log('in the activate 0 block')
            // Handle the special case for the initial transaction
            //const TL = .getInstance(testAdmin);
            const tradeLayerManager = await TradeLayerManager.getInstance(this.adminAddress, this.chain,this.test);
            const balances = await tradeLayerManager.initializeTokens(block); //await TradeLayerManager.initializeContractSeries(); going to save this for the activation of native contracts
            console.log('balances '+ balances + "if undefined this is a repeat that successfully prevented inflation")
            this.txRegistry[txType].active = true;
            this.txRegistry[txType].activationBlock = block
            if(codeHash){
                this.txRegistry[txType].codeHash = codeHash
            }
            //console.log(JSON.stringify(this.txRegistry))
            await this.saveActivationsList()
            await Consensus.pushLatestActivationToConsensusVector();
        }else{
            // Check if the transaction type exists in the registry
            //console.log('in the general activations block')
            if (this.txRegistry[txType]) {
                // A re-activation naming another release replaces this node's channel rules: stop.
                ReleaseIdentity.assertNotSuperseded(txType, this.txRegistry[txType], codeHash);
                this.txRegistry[txType].active = true;
                this.txRegistry[txType].activationBlock = block
                if(codeHash){
                    this.txRegistry[txType].codeHash = codeHash
                }
                //console.log('activating '+txType+ ' '+JSON.stringify(this.txRegistry))
                
                await this.saveActivationsList();
                await Consensus.pushLatestActivationToConsensusVector(); // Save the updated activations list
                return this.txRegistry[txType] ; // Save the updated activations list
            } else {
                console.error(`Transaction type ${txType} not found in registry.`);
            }
        }
    }

        /**
     * Checks if more than 90% of the activations in the transaction registry are true.
     * @returns {boolean} - Returns true if >90% of activations are true, otherwise false.
     */
    async areActivationsAboveThreshold() {
        await this.loadActivationsList(); // Ensure the registry is up-to-date

        const totalTxTypes = Object.keys(this.txRegistry).length;
        if (totalTxTypes === 0) {
            console.error('Transaction registry is empty.');
            return false;
        }

        // Count active transactions
        const activeCount = Object.values(this.txRegistry).reduce((count, tx) => {
            return tx.active ? count + 1 : count;
        }, 0);

        const activationPercentage = (activeCount / totalTxTypes) * 100;

        console.log(`Active transactions: ${activeCount}/${totalTxTypes} (${activationPercentage.toFixed(2)}%)`);
        console.log('above threshold? '+Boolean(activationPercentage > 90))
        // Check if >90% of activations are true
        return Boolean(activationPercentage > 90);
    }


    initializeTxRegistry() {
        // Initialize the transaction registry
        return {
            0: { name: "Activate TradeLayer", active: false },
            1: { name: "Token Issue", active: false },
            2: { name: "Send", active: false },
            3: { name: "Trade Token for UTXO", active: false },
            4: { name: "Commit Token", active: false },
            5: { name: "On-chain Token for Token", active: false },
            6: { name: "cancelOrder", active: false },
            7: { name: "Create Whitelist", active: false },
            8: { name: "Update Admin", active: false },
            9: { name: "Issue or Revoke Attestation", active: false },
            10: { name: "AMM", active: false },
            11: { name: "Grant Managed Token", active: false },
            12: { name: "Redeem Managed Token", active: false },
            13: { name: "Create Oracle", active: false },
            14: { name: "Publish Oracle Data", active: false },
            15: { name: "Close Oracle", active: false },
            16: { name: "Create Future Contract Series", active: false },
            17: { name: "Exercise Derivative", active: false },
            18: { name: "Trade Contract On-chain", active: false },
            19: { name: "Trade Contract Channel", active: false },
            20: { name: "Trade Tokens Channel", active: false },
            21: { name: "Withdrawal", active: false },
            22: { name: "Transfer", active: false },
            23: { name: "Settle Channel PNL", active: false },
            24: { name: "Mint Synthetic", active: false },
            25: { name: "Redeem Synthetic", active: false },
            26: { name: "Pay to Tokens", active: false },
            27: { name: "Create Option Chain", active: false },
            28: { name: "Trade Bai Urbun", active: false },
            29: { name: "Trade Murabaha", active: false },
            30: { name: "Oracle Stake/Fraud/Relay", active: false },
            31: { name: "Batch Move Zk Rollup", active: false },
            32: { name: "Publish New Tx", active: false },
            33: { name: "Colored Coin", active: false },
            34: { name: "Cross Layer Bridge", active: false },
            35: { name: "Smart Contract Bind", active: false },
        }

    }

    // Function to get the activation block of a transaction type
    getActivationBlock(txType) {
        if (this.txRegistry.hasOwnProperty(txType)) {
            return this.txRegistry[txType].activationBlock || null; // Returns the activation block if available, otherwise null
        } else {
            console.error(`Transaction type ${txType} not found in registry.`);
            return null; // Return null if the transaction type is not found
        }
    }

     /**
     * Checks if a transaction type is active in the transaction registry.
     * @param {number} txTypeNumber - The transaction type number to check.
     * @returns {boolean} - Returns true if the transaction type is active, false otherwise.
     */
    // The registry entry of one type ({ active, activationBlock, codeHash }), as currently recorded.
    async getTypeEntry(txTypeNumber) {
        await this.loadActivationsList();
        return this.txRegistry[txTypeNumber] || null;
    }

    async isTxTypeActive(txTypeNumber) {
        // Assuming txRegistry is accessible within this context
        await this.loadActivationsList()
        const txType = this.txRegistry[txTypeNumber];
        //console.log('checking ' + JSON.stringify(txType)+' registry '+JSON.stringify(this.txRegistry))
        if(txType==undefined){return false}
        if (txType.active==true) {
            return true;
        }
        return false;
    }

    async checkActivationBlock(txTypeNumber){
        await this.loadActivationsList()
        //console.log('checking for activation block ' +this.txRegistry[txTypeNumber])
        const txType = this.txRegistry[txTypeNumber];
        //console.log('checking type activation' + JSON.stringify(txType))
        if(txType.activationBlock==undefined){return null}else{return txType.activationBlock};
    }

    async isSenderGenesisAdmin(address) {
        // Check if the given address is the genesis admin
        return (address === 'tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8')
    }

    isValidJSON(json) {
        try {
            JSON.parse(json);
            return true;
        } catch (e) {
            return false;
        }
    }

    isValidJavaScript(jsCode) {
        // Implement JavaScript validation logic
        // This could include syntax checking and potentially safety checks
        return true; // Placeholder
    }

    minifyJavaScript(jsCode) {
        // Implement JavaScript code minification
        // You might use existing libraries for minification
        return jsCode; // Placeholder
    }

    getNextTxTypeId() {
        // Logic to get the next transaction type ID
        // This might involve querying a database or keeping track in memory
        return /* next transaction type ID */;
    }

    saveNewTransaction(newTx) {
        // Logic to save the new transaction
        // This will likely involve database operations
    }
}

module.exports = Activation;
