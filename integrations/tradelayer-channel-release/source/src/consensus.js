const db = require('./db.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const util = require('util');
const fsPromises = fs.promises;
const basePath = path.join(__dirname);

class ConsensusDatabase {
        static consensusVector = [];
    constructor() {
        if (ConsensusDatabase.instance) {
            return ConsensusDatabase.instance;
        }

        const flaggedIPs = []
        ConsensusDatabase.instance = this;
        this.loadFlaggedIPsFromDb(); // Load flagged IPs from the database on initialization
    }

    /**
     * Store the consensus hash for a given block height.
     * @param {Number} blockHeight - The height of the block.
     * @param {String} consensusHash - The consensus hash for the block.
     */
    static async storeConsensusHash(blockHeight, consensusHash) {
        const query = { _id: `block-${blockHeight}` };  // Use _id as a unique identifier
        const update = { $set: { blockHeight, consensusHash } };  // Update or insert block and consensus hash

        try {
            const base = await db.getDatabase('consensus')
            await base.updateAsync(query, update, { upsert: true });  // Upsert to insert if it doesn't exist
            console.log(`Consensus hash for block ${blockHeight} stored.`);
        } catch (err) {
            console.error('Error storing consensus hash:', err);
        }
    }

    /**
     * Retrieve the consensus hash for a given block height.
     * @param {Number} blockHeight - The height of the block.
     * @returns {String|null} - The consensus hash or null if not found.
     */
    static async getConsensusHash(blockHeight) {
        const query = { _id: `block-${blockHeight}` };  // Use _id to find based on the block number

        try {
            const base = await db.getDatabase('consensus')
            const result = await base.findOneAsync(query);  // Find based on the block height (_id)
            if (result) {
                return result.consensusHash;  // Return the consensus hash if found
            } else {
                console.warn(`No consensus hash found for block ${blockHeight}`);
                return null;
            }
        } catch (err) {
            console.error('Error retrieving consensus hash:', err);
            return null;
        }
    }

    static async checkIfTxProcessed(txId) {
        //console.log('inside checkIfTxProcessed ' + txId);
        const base = await db.getDatabase('consensus')
        const result = await base.findOneAsync({ _id: txId });
        //console.log(result);
        return result && result.processed === true;
    }

    static async getTxParams(txId) {
        const base = await db.getDatabase('consensus')
        const result = await base.findOneAsync({ _id: txId });
        return result.value.processed === true ? result.value.params : null;
    }

    static async markTxAsProcessed(txId, params) {
        let value = { processed: true, params };
        const base = await db.getDatabase('consensus')
        await base.updateAsync(
            { _id: txId },
            { $set: value },
            { upsert: true }
        );
    }

    static async getTxParamsForAddress(address) {
        const base = await db.getDatabase('consensus')
        const results = await base.findAsync({ "value.processed": true, "value.params.address": address });
        return results.map(result => result.value.params);
    }

    static async getTxParamsForBlock(blockHeight) {
        const base = await db.getDatabase('consensus')
        const results = await base.findAsync({ "value.processed": true, "value.params.block": blockHeight });
        return results.map(result => result.value.params);
    }

    static async getMaxProcessedBlock() {
        const base = await db.getDatabase('consensus')
        const result = await base.findOneAsync({ _id: 'MaxProcessedHeight' });
        return result ? result.value : null;
    }

    static async getHighestBlockHeight(callback) {
            const base = await db.getDatabase('consensus')
            const result = await base.aggregate([
            { $group: { _id: null, maxBlockHeight: { $max: "$value.params.blockHeight" } } }
        ], (err, result) => {
            if (err) {
                callback(err, null);
            } else {
                const maxBlockHeight = result.length > 0 ? result[0].maxBlockHeight : null;
                callback(null, maxBlockHeight);
            }
        });
    }


    static async compareBlockHeights() {
        const maxProcessedBlock = await this.getMaxProcessedBlock();
        const highestBlockHeight = await this.getHighestBlockHeight();

        const higherBlockHeight = Math.max(maxProcessedBlock, highestBlockHeight);

        return {
            maxProcessedBlock,
            highestBlockHeight,
            higherBlockHeight
        };
    }


    // Function to generate SHA-256 hash
    static generateHash(input) {
        const hash = crypto.createHash('sha256');
        hash.update(input);
        return hash.digest('hex');
    }

    // 1. txIndexHash: Hash the filtered txIndex
    static async txIndexHash() {
        try {
            const base = await db.getDatabase('txIndex')
            const txIndex = await base.findAsync({});
            const filteredTxIndex = txIndex.filter(tx => tx._id.startsWith('tx'));
            const filteredTxIndexString = JSON.stringify(filteredTxIndex);
            const hash = this.generateHash(filteredTxIndexString);
            console.log('txIndexHash:', hash);
            return hash;
        } catch (err) {
            console.error('Error generating txIndex hash:', err);
        }
    }

	// Function to get the latest instance of a DB
    static async getLatestInstance(dbName) {
        const base = await db.getDatabase(dbName)
        const data = await base.findAsync({});
        return data.length > 0 ? data[data.length - 1] : null; // Get the latest entry
    }

    // Function to get all instances from a DB
    static async getAllInstances(dbName) {
        const base = await db.getDatabase(dbName)
        const data = await base.findAsync({});
        return data; // Return all entries
    }

    // Function to generate stateConsensusHash based on various DBs
    // Function to generate stateConsensusHash based on various DBs
    static async stateConsensusHash(snapshot) {
        try {
            // Retrieve latest instance from tally.db and activations.db
            const latestTally = await this.getLatestInstance('tallyMap');
            const latestActivation = await this.getLatestInstance('activations');

            // Retrieve everything from other specified DBs
            const channels = await this.getAllInstances('channels');
            const clearlists = await this.getAllInstances('clearlists');
            const contractList = await this.getAllInstances('contractList');
            const feeCache = await this.getAllInstances('feeCache');
            const insurance = await this.getAllInstances('insurance');
            const marginMaps = await this.getAllInstances('marginMaps');
            const oracleData = await this.getAllInstances('oracleData');
            const oracleList = await this.getAllInstances('oracleList');
            const orderBooks = await this.getAllInstances('orderBooks');
            const propertyList = await this.getAllInstances('propertyList');
            const syntheticTokens = await this.getAllInstances('syntheticTokens');
            const vaults = await this.getAllInstances('vaults');
            const volumeIndex = await this.getAllInstances('volumeIndex');
            const withdrawQueue = await this.getAllInstances('withdrawQueue');

            // Combine all the retrieved data into a single structure
            const combinedState = {
                latestTally,
                latestActivation,
                channels,
                clearlists,
                contractList,
                feeCache,
                insurance,
                marginMaps,
                oracleData,
                oracleList,
                orderBooks,
                propertyList,
                syntheticTokens,
                vaults,
                volumeIndex,
                withdrawQueue
            };

            // Convert combined data to string
            const combinedStateString = JSON.stringify(combinedState);

            // Generate and return the SHA-256 hash of the combined state
            const hash = this.generateHash(combinedStateString);
            console.log('stateConsensusHash:', hash);
            if(!snapshot){
            	return hash;
            }else if(snapshot){
            	return {hash: hash, state: combinedStateString}
            }

        } catch (err) {
            console.error('Error generating stateConsensus hash:', err);
        }
    }

// Function to hash files in the specified folder
	static async hashFiles() {
	    // The release hash, as activations record it (releaseIdentity.js). The older raw-content
	    // hash below covered a different file list and changed with line endings.
	    return require('./releaseIdentity').computeCodeHash();
	    try {
	        let combinedContent = ''; // Initialize empty string to hold combined file content

	        const jsFiles = [
			    'activation', 'amm', 'channels', 'clearing', 'clearlist', 'consensus', 'contractRegistry',
			    'insurance', 'logic', 'main', 'marginMap', 'options', 'oracle', 'orderbook',
			    'persistence', 'property', 'reOrg', 'tally', 'txDecoder', 'txIndex', 'types',
			    'validity', 'vaults', 'vesting', 'volumeIndex'
			];
	        // Loop through each file, read its content, and append to combinedContent
	        for (const file of jsFiles) {
                console.log('file name '+file)
                const name = file+'.js'
	            const filePath = path.join(basePath, name);

	            if (fs.existsSync(filePath)) {
                    const fileContent = await fsPromises.readFile(filePath, 'utf8');
	                combinedContent += fileContent; // Append file content
	            } else {
	                console.warn(`File not found: ${filePath}`); // Warn if the file is missing
	            }
	        }

	        // Stringify the combined content
	        const combinedContentString = JSON.stringify(combinedContent);
            //console.log('combinedContent '+combinedContentString)

	        // Generate a SHA-256 hash of the combined content
	        const hash = crypto.createHash('sha256');
	        hash.update(combinedContentString);
	        const finalHash = hash.digest('hex');

	        console.log('Final SHA-256 Hash:', finalHash);
	        return finalHash;
	    } catch (err) {
	        console.error('Error reading or hashing files:', err);
	    }
	}

	// Function to fetch the latest activation from activations.db and push into the consensus vector
	   static async pushLatestActivationToConsensusVector() {
            try {
                const activationsDb = await db.getDatabase('activations');
                const activations = await activationsDb.findAsync({ _id: 'activationsList' });

                if (!activations || !activations[0] || !activations[0].value) {
                    console.log('No activations found in the database.');
                    return;
                }

                const activationsList = JSON.parse(activations[0].value);
                let latestActivation = null;
                let maxBlock = -1;

                for (const key in activationsList) {
                    const activation = activationsList[key];
                    if (activation.activationBlock && activation.activationBlock > maxBlock) {
                        maxBlock = activation.activationBlock;
                        latestActivation = activation;
                    }
                }

                if (!latestActivation) {
                    console.log('No valid activation with an activationBlock found.');
                    return;
                }

                const projectPath = path.resolve(__dirname);
                const codeHash = await ConsensusDatabase.hashFiles(projectPath) || '';
                const wasmCodeHash = '';
                const consensusHash = await ConsensusDatabase.stateConsensusHash();

                const newConsensusEntry = {
                    activation: latestActivation,
                    codeHash,
                    wasmCodeHash,
                    consensusHash,
                    blockNumber: maxBlock,
                };

                this.consensusVector.push(newConsensusEntry);
                console.log('Latest activation pushed to consensus vector:', newConsensusEntry);
                return newConsensusEntry;

            } catch (err) {
                console.error('Error fetching latest activation or updating consensus vector:', err);
            }
        }



	// Function to save the consensus vector to the consensus.db file
	static async saveConsensusVector() {
	    try {
	        const consensusDb = await db.getDatabase('consensus');

	        // Check if a document with _id "consensusVector" exists
	        const existingConsensusVector = await consensusDb.findOneAsync({ _id: 'consensusVector' });

	        if (existingConsensusVector) {
	            // If it exists, update the document
	            await consensusDb.updateAsync(
	                { _id: 'consensusVector' },
	                { $set: { vector: consensusVector } },
	                { upsert: true }
	            );
	            console.log('Consensus vector updated in consensus.db');
	        } else {
	            // If it doesn't exist, insert a new document
	            await consensusDb.insertAsync({
	                _id: 'consensusVector',
	                vector: consensusVector
	            });
	            console.log('Consensus vector saved to consensus.db');
	        }
	    } catch (err) {
	        console.error('Error saving consensus vector to consensus.db:', err);
	    }
	}

	static async loadConsensusVector() {
	    try {
	        const consensusDb = await db.getDatabase('consensus');

	        // Check if a document with _id "consensusVector" exists
	        const existingConsensusVector = await consensusDb.findOneAsync({ _id: 'consensusVector' });

	        if (existingConsensusVector) {
	            return existingConsensusVector
	        } else {
	        	return console.log('No Consensus vector found.');
	        }
	    } catch (err) {
	        console.error('Error saving consensus vector to consensus.db:', err);
	    }
	}

	static async generateHashes() {
        // These are updated to match the actual method names
        this.txIndexHash = await this.txIndexHash(); // For transaction index hash
        this.consensusStateHash = await this.stateConsensusHash(); // For consensus state hash
        this.codeHash = await this.hashFiles(path.resolve(__dirname)); // For code hash
    }

	  // Consensus handshake function: compares local and incoming hashes
	static async consensusHandshake(incomingHashes) {
        await this.generateHashes(); // Generate both JS and WASM hashes
        await this.populateConsensusVectorFromActivations();
        const localHashes = {
            txIndexHash: this.txIndexHash,
            consensusStateHash: this.consensusStateHash,
            codeHash: this.codeHash || '',  // JavaScript hash
            wasmCodeHash: this.wasmCodeHash || ''  // WASM/Rust hash
        };

        console.log('Local Hashes:', localHashes);
        console.log('Incoming Hashes:', incomingHashes);

        const txIndexMatch = localHashes.txIndexHash === incomingHashes.txIndexHash;
        const consensusStateMatch = localHashes.consensusStateHash === incomingHashes.consensusStateHash;
        const codeHashMatch = localHashes.codeHash === incomingHashes.codeHash;
        const wasmCodeHashMatch = localHashes.wasmCodeHash === incomingHashes.wasmCodeHash;

        if (!txIndexMatch) {
            console.warn('Transaction index hash does not match!');
        }
        if (!consensusStateMatch) {
            console.warn('Consensus state hash does not match!');
        }
        if (!codeHashMatch) {
            console.warn('Code hash does not match!');
        }
        if (!wasmCodeHashMatch) {
            console.warn('WASM code hash does not match!');
        }

        const match = txIndexMatch && consensusStateMatch && codeHashMatch && wasmCodeHashMatch;

        return match;
    }


    async investigateDiscrepancy(incomingHashes) {
        try {
            // Load the latest activations list
            const activations = await this.loadActivationsList();

            // Loop through the activations to compare with incoming codeHash
            for (const [key, activation] of Object.entries(activations)) {
                if (activation.codeHash === incomingHashes.codeHash) {
                    // If a match is found, check if the consensus hash also matches
                    if (activation.consensusHash === incomingHashes.consensusHash) {
                        return { status: 'match', message: 'Code and consensus hash match the existing version.' };
                    } else {
                        return { status: 'partial-match', message: 'Code hash matches but consensus hash differs.' };
                    }
                }
            }

            // If no matches are found
            return { status: 'unknown', message: 'No matching code hash found in the activations list.' };

        } catch (error) {
            console.error('Error investigating discrepancy:', error);
            return { status: 'error', message: 'Error investigating discrepancy.' };
        }
    }

   // Function to call the handshake and handle discrepancies
    // Function to call the handshake and handle discrepancies
    // Function to call the handshake and handle discrepancies
        static async verifyConsensus(incomingHashes) {
            const isHandshakeSuccessful = await this.consensusHandshake(incomingHashes);


            if (isHandshakeSuccessful) {
                console.log("Handshake successful, consensus verified.");
                return true;
            } else {
                console.log("Handshake failed, investigating discrepancies...");
                const status = await this.investigateDiscrepancy(incomingHashes);

                if (status.status === 'unknown') {
                    // No match found for the codeHash - claim is suspicious
                    console.log("No matching codeHash found. This could be BS or a false claim.");
                    return false;  // Call BS here and return false
                } else if (status.status === 'partial-match') {
                    // CodeHash matches, but consensusHash differs
                    console.log("CodeHash matches but consensusHash differs. Attempting to reconstruct consensus...");

                    // Call a function to reconstruct consensus based on the incoming codeHash
                    const reconstructedConsensus = await this.reconstructConsensus(incomingHashes.codeHash);

                    // Compare the reconstructed consensus with the incoming consensusHash
                    if (reconstructedConsensus === incomingHashes.consensusHash) {
                        console.log("Consensus reconstructed successfully, matches the incoming hash.");
                        return true;
                    } else {
                        console.log("Reconstructed consensus does not match the incoming hash. Consensus mismatch.");
                        return false;  // Return false if consensus reconstruction fails
                    }
                } else if (status.status === 'match') {
                    // Everything matches, but somehow the handshake failed earlier, let's proceed anyway
                    console.log("Code and consensus hash match, but handshake failed earlier. Proceeding...");
                    return true;
                }

                return false; // Default to false if nothing else matches
            }
        }


    // Function to reconstruct consensus based on codeHash
    static async reconstructConsensus(codeHash) {
        try {
            // Load the activations list to ensure we have the latest consensus state
            const activations = await this.loadActivationsList();

            // Find the matching activation by codeHash
            for (const [key, activation] of Object.entries(activations)) {
                if (activation.codeHash === codeHash) {
                    console.log('Found matching activation for reconstruction:', activation);

                    // Regenerate the consensus state based on the activation we found
                    const reconstructedConsensus = await this.stateConsensusHash();

                    // Log and return the reconstructed consensus hash
                    console.log('Reconstructed consensus hash:', reconstructedConsensus);
                    return reconstructedConsensus;
                }
            }

            // If no matching activation is found, return null
            return null;

        } catch (error) {
            console.error('Error during consensus reconstruction:', error);
            return null;  // Return null in case of an error
        }
    }

    static async crossReferenceFlagList(incomingFlagList) {
	    for (const flaggedNode of incomingFlagList) {
	        const localEntry = flaggedIPs.find(entry => entry.ip === flaggedNode.ip);
	        
	        if (localEntry) {
	            localEntry.flagCount += flaggedNode.flagCount;
	            localEntry.reason += `; ${flaggedNode.reason}`;
	            localEntry.timestamp = new Date().toISOString();
	        } else {
	            flaggedIPs.push(flaggedNode);
	        }
	    }
	}

	static async flagIP(ipAddress, reason) {
	    const existingEntry = flaggedIPs.find(entry => entry.ip === ipAddress);
	    if (existingEntry) {
	        existingEntry.flagCount += 1;
	        existingEntry.timestamp = new Date().toISOString();
	    } else {
	        flaggedIPs.push({
	            ip: ipAddress,
	            flagCount: 1,
	            reason: reason,
	            timestamp: new Date().toISOString()
	        });
	    }
	    console.log(`IP ${ipAddress} flagged for reason: ${reason}`);
	     // Save the updated flagged IP list to the database
        await this.saveFlaggedIPsToDb();
	}

    // Function to populate consensus vector using the activations blob
    static async populateConsensusVectorFromActivations() {
        try {
            const activations = await this.loadActivationsList();

            for (const [key, activation] of Object.entries(activations)) {
                if (activation.active) {
                    const newEntry = {
                        codeHash: activation.codeHash || '',  // The code hash for this activation
                        activationBlock: activation.activationBlock || -1,  // The block it was activated
                        consensusHash: activation.consensusHash || null  // Optional, if available
                    };

                    this.consensusVector.push(newEntry);
                }
            }

            console.log('Consensus vector populated from activations:', this.consensusVector);
            return this.consensusVector;

        } catch (err) {
            console.error('Error populating consensus vector from activations:', err);
            return null;
        }
    }

    // Save the flagged IPs list to the database
    static async saveFlaggedIPsToDb() {
        try {
            const flaggedIPsDb = db.getDatabase('flaggedIPs');
            await flaggedIPsDb.updateAsync(
                { _id: 'flaggedIPsList' },
                { $set: { value: JSON.stringify(this.flaggedIPs) } },
                { upsert: true } // Insert if not found
            );
            console.log('Flagged IP list saved to the database.');
        } catch (error) {
            console.error('Error saving flagged IP list to the database:', error);
        }
    }

    // Load the flagged IPs list from the database
    static async loadFlaggedIPsFromDb() {
        try {
            const flaggedIPsDb = await db.getDatabase('flaggedIPs');
            const entry = await flaggedIPsDb.findOneAsync({ _id: 'flaggedIPsList' });

            if (entry && entry.value) {
                this.flaggedIPs = JSON.parse(entry.value);
                console.log('Flagged IP list loaded from the database.');
            } else {
                this.flaggedIPs = []; // Initialize to an empty list if not found in DB
                console.log('No flagged IP list found in the database. Initialized with empty list.');
            }
        } catch (error) {
            console.error('Error loading flagged IP list from the database:', error);
            this.flaggedIPs = []; // Initialize to an empty list on error
        }
    }

    // Method to get the current flagged IPs list
    static getFlaggedIPs() {
        return this.flaggedIPs;
    }

}

module.exports = ConsensusDatabase;

