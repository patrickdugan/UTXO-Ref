var db = require('./db')
var BigNumber = require('bignumber.js')
const crypto = require('crypto');
const DlcOracleBridge = require('./dlcOracleBridge.js');
function getInsuranceModule() {
    return require('./insurance.js');
}

class OracleList {
    static instance = null;
    static lastOracleUpdateBlock = new Map();

    constructor() {
        if (!OracleList.instance) {
            this.oracles = new Map(); // Initialize the oracles map only once
            OracleList.instance = this;
        }

        return OracleList.instance;
    }

    static async getAllOracles() {
        const instance = OracleList.getInstance();
        await OracleList.load(); // Make sure the oracles are loaded

        // Convert the Map of oracles to an array
        return Array.from(instance.oracles.values());
    }

    async addOracle(oracleId, oracleData) {
        try {
            // Add to in-memory map
            this.oracles.set(oracleId, oracleData);

            // Add to NeDB database (if applicable)
            const oracleDB = await db.getDatabase('oracleList');
            await oracleDB.insertAsync({ _id: oracleId, ...oracleData });

            console.log(`Oracle added: ID ${oracleId}`);
            return true; // Indicate success
        } catch (error) {
            console.error(`Error adding oracle: ID ${oracleId}`, error);
            throw error; // Re-throw the error for the caller to handle
        }
    }

    static async getOracleInfo(oracleId) {
        const instance = OracleList.getInstance();

        // Check if in-memory map is empty and load if necessary
        if (instance.oracles.size === 0) {
            await OracleList.load();
        }

        // Oracle key to search for
        const oracleKey = `oracle-${oracleId}`;

        // Check in the in-memory map
        const oracle = instance.oracles.get(oracleKey);
        if (oracle) {
            return oracle;
        }

        // If not found in-memory, optionally check the database
        const oracleDB = await db.getDatabase('oracleList');
        console.log('oracle key '+oracleKey)
        const dbOracle = await oracleDB.findOneAsync({ _id: oracleKey });
        console.log('db oracle '+ JSON.stringify(dbOracle))
        if (dbOracle) {
            return dbOracle;
        }

        console.log(`Oracle data not found for oracle ID: ${oracleId}`);
        return null;
    }
    
    static async getOraclePrice(oracleId) {
        // Prepare the query to find all entries with the specified oracleId
        const oracleDB = await db.getDatabase('oracleData');
        const oracleData = await oracleDB.findAsync({ oracleId: oracleId });
        const priceRows = (oracleData || []).filter((row) =>
            row && row.data && Number.isFinite(Number(row.data.price))
        );
        
        // Check if any data was returned
        if (priceRows.length === 0) {
            return 1
        }
        
        // Find the latest data point by blockHeight
        const latestDataPoint = priceRows.reduce((latest, entry) => {
            return (entry.blockHeight > latest.blockHeight) ? entry : latest;
        });

        console.log('Latest oracle data:', JSON.stringify(latestDataPoint));
        return latestDataPoint.data.price;
    }

    static async publishData(oracleId, price, high, low, close, blockHeight) {
        const lastBlock = OracleList.lastOracleUpdateBlock.get(oracleId);

        if (lastBlock !== undefined && lastBlock >= blockHeight) {
            console.log(`⛔ Oracle ${oracleId} already updated at block ${lastBlock}. Skipping block ${blockHeight}.`);
            return;
        }

        // mark as updated
        OracleList.lastOracleUpdateBlock.set(oracleId, blockHeight);

        try {
            const instance = OracleList.getInstance();

            // Prepare oracle data
            const oracleData = { price, high, low, close };
            const lastPrice = await OracleList.getOraclePrice(oracleId)
            console.log('last price '+lastPrice)
            const priceBN = new BigNumber(price)
            const lastPriceBN = new BigNumber(lastPrice)
            const circuitLimitUp = new BigNumber(1.05).times(lastPriceBN).decimalPlaces(4).toNumber()
            const circuitLimitDown = new BigNumber(0.95).times(lastPriceBN).decimalPlaces(4).toNumber()
            console.log('price, limits '+price, lastPrice, circuitLimitDown, circuitLimitUp)
            console.log('ergo, >limit up , <limit down' + Boolean(price>circuitLimitUp)+' '+Boolean(price<circuitLimitDown))
            if(lastPrice!=1){
                if(price>circuitLimitUp){
                    oracleData.price = circuitLimitUp
                }else if(price <circuitLimitDown){
                    oracleData.price = circuitLimitDown
                }
            } 
            // Preserve oracle metadata and only refresh the latest data payload.
            const oracleKey = `oracle-${oracleId}`;
            const existingMeta = instance.oracles.get(oracleKey) ||
                await (await db.getDatabase('oracleList')).findOneAsync({ _id: oracleKey }) ||
                { _id: oracleKey, id: Number(oracleId) };
            instance.oracles.set(oracleKey, {
                ...existingMeta,
                data: oracleData,
                lastPublishedBlock: blockHeight
            });

            // Save oracle data to the database
            await instance.saveOracleData(oracleId, oracleData, blockHeight);

            console.log(`Data published to oracle ${oracleId} for block height ${blockHeight}`);
        } catch (error) {
            console.error(`Error publishing data to oracle ${oracleId} at block height ${blockHeight}:`, error);
            throw error;
        }
    }

    // Static method to get the singleton instance
    static getInstance() {
        if (!OracleList.instance) {
            OracleList.instance = new OracleList();
        }
        return OracleList.instance;
    }

    static async load() {
        try {
            const oracleDB = await db.getDatabase('oracleList');
            const oracles = await oracleDB.findAsync({});

            const instance = OracleList.getInstance();
            for (const oracle of oracles) {
                instance.oracles.set(oracle._id, oracle);
            }

            console.log('Oracles loaded from the database');
        } catch (error) {
            console.error('Error loading oracles from the database:', error);
        }
    }

    static async isAdmin(senderAddress, oracleId) {
        try {
            const oracleKey = `oracle-${oracleId}`;
            console.log('checking admin for oracle key '+oracleKey)
            const oracleDB = await db.getDatabase('oracleList');
            const oracleData = await oracleDB.findOneAsync({ _id: oracleKey });

            const adminAddr = oracleData?.adminAddress || oracleData?.name?.adminAddress;
            const backupAddr = oracleData?.backupAddress || oracleData?.name?.backupAddress;
            if (adminAddr === senderAddress || backupAddr === senderAddress) {
                return true; // The sender is the admin
            } else {
                return false; // The sender is not the admin
            }
        } catch (error) {
            console.error(`Error verifying admin for oracle ${oracleId}:`, error);
            throw error;
        }
    }

    static async verifyAdmin(oracleId, adminAddress) {
        const oracleKey = `oracle-${oracleId}`;

        // Check in-memory map first
        const instance = OracleList.getInstance();
        let oracle = instance.oracles.get(oracleKey);

        // If not found in-memory, check the database
        if (!oracle) {
            const oracleDB = await db.getDatabase('oracleList');
            oracle = await oracleDB.findOneAsync({ _id: oracleKey });
        }

        // Verify admin address
        return oracle && oracle.adminAddress === adminAddress;
    }


    static async updateAdmin(oracleId, newAdminAddress, backup) {
        const oracleKey = `oracle-${oracleId}`;
        const instance = OracleList.getInstance();
            
        // Get the NeDB datastore for oracles
        const oracleDB = await db.getDatabase('oracleList');

        // Fetch the current oracle data
        const oracle = await oracleDB.findOneAsync({ _id: oracleKey });

        if (!oracle) {
            throw new Error('Oracle not found');
        }

        const field = backup ? 'backupAddress' : 'adminAddress';
        oracle[field] = newAdminAddress;

        // Update the oracle in the database
        await oracleDB.updateAsync({ _id: oracleKey }, { $set: { [field]: newAdminAddress } }, {});

        // Optionally, update the in-memory map if you are maintaining one
        instance.oracles.set(oracleKey, oracle);

        console.log(`Oracle ID ${oracleId} admin updated to ${newAdminAddress}`);
    }

    static async recordStake(oracleId, stakerAddress, stakedPropertyId, amount, blockHeight) {
        const oracleDataDB = await db.getDatabase('oracleData');
        const key = `oracle-stake-${oracleId}-${stakerAddress}`;
        const prev = await oracleDataDB.findOneAsync({ _id: key });
        const previousAmount = Number(prev?.amount || 0);
        const nextAmount = new BigNumber(previousAmount).plus(amount).decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber();
        const doc = {
            _id: key,
            type: 'stake',
            oracleId,
            stakerAddress,
            stakedPropertyId,
            amount: nextAmount,
            blockHeight
        };
        await oracleDataDB.updateAsync({ _id: key }, { $set: doc }, { upsert: true });
        return doc;
    }

    static async getStake(oracleId, stakerAddress) {
        const oracleDataDB = await db.getDatabase('oracleData');
        return oracleDataDB.findOneAsync({ _id: `oracle-stake-${oracleId}-${stakerAddress}` });
    }

    static async applyFraudProof(oracleId, accusedAddress, challengerAddress, slashAmount, evidenceHash, blockHeight) {
        const oracleDataDB = await db.getDatabase('oracleData');
        const stakeKey = `oracle-stake-${oracleId}-${accusedAddress}`;
        const accusedStake = await oracleDataDB.findOneAsync({ _id: stakeKey });
        if (!accusedStake) {
            return { slashed: 0 };
        }

        const currentStake = Number(accusedStake.amount || 0);
        const slash = Math.min(currentStake, Number(slashAmount || 0));
        const nextStake = new BigNumber(currentStake).minus(slash).decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber();
        await oracleDataDB.updateAsync({ _id: stakeKey }, { $set: { amount: nextStake, blockHeight } }, { upsert: true });

        const fraudKey = `oracle-fraud-${oracleId}-${blockHeight}-${String(evidenceHash || '').slice(0, 24)}`;
        await oracleDataDB.updateAsync(
            { _id: fraudKey },
            {
                $set: {
                    _id: fraudKey,
                    type: 'fraudProof',
                    oracleId,
                    accusedAddress,
                    challengerAddress,
                    slashAmount: slash,
                    evidenceHash,
                    blockHeight
                }
            },
            { upsert: true }
        );
        return { slashed: slash };
    }

    static async relayTradeLayerState(oracleId, senderAddress, relayType, stateHash, dlcRef, blockHeight, relayBlob = '') {
        const oracleDataDB = await db.getDatabase('oracleData');
        const parsed = DlcOracleBridge.parseRelayBlob(relayBlob);
        const sigHex = String(parsed?.signatureHex || '').trim().toLowerCase();
        const effectiveStateHash = String(stateHash || parsed?.stateHash || '');
        const effectiveDlcRef = String(dlcRef || '');

        // Replay protection: a signed oracle attestation cannot be reused for a different
        // DLC reference or state hash.
        if (sigHex) {
            const sigDigest = crypto.createHash('sha256').update(sigHex).digest('hex');
            const sigKey = `oracle-relay-sig-${oracleId}-${sigDigest}`;
            const prev = await oracleDataDB.findOneAsync({ _id: sigKey });
            if (prev) {
                const changedState = String(prev.stateHash || '') !== effectiveStateHash;
                const changedDlcRef = String(prev.dlcRef || '') !== effectiveDlcRef;
                if (changedState || changedDlcRef) {
                    throw new Error('Relay signature replay detected for different stateHash/dlcRef');
                }
            } else {
                await oracleDataDB.updateAsync(
                    { _id: sigKey },
                    {
                        _id: sigKey,
                        type: 'relaySigUse',
                        oracleId,
                        signatureHex: sigHex,
                        stateHash: effectiveStateHash,
                        dlcRef: effectiveDlcRef,
                        firstSeenBlock: blockHeight
                    },
                    { upsert: true }
                );
            }
        }

        const relayKey = `oracle-relay-${oracleId}-${relayType}-${blockHeight}`;
        const relayDoc = {
            _id: relayKey,
            type: 'relay',
            oracleId,
            senderAddress,
            relayType,
            stateHash,
            dlcRef,
            relayBlob,
            blockHeight
        };
        await oracleDataDB.updateAsync({ _id: relayKey }, relayDoc, { upsert: true });
        return relayDoc;
    }

    static async createOracle(nameOrConfig, adminAddress) {
        const instance = OracleList.getInstance(); // Get the singleton instance
        const oracleId = await OracleList.getNextId();
        const oracleKey = `oracle-${oracleId}`;
        const config = (nameOrConfig && typeof nameOrConfig === 'object')
            ? nameOrConfig
            : { name: nameOrConfig, adminAddress };
        const displayName = config.name || config.ticker || `oracle-${oracleId}`;

        const newOracle = {
            _id: oracleKey, // NeDB uses _id as the primary key
            id: oracleId,
            name: displayName,
            ticker: config.ticker || displayName,
            url: config.url || '',
            backupAddress: config.backupAddress || '',
            clearlists: Array.isArray(config.clearlists) ? config.clearlists : [],
            lag: Number.isFinite(Number(config.lag)) ? Number(config.lag) : 1,
            adminAddress: config.adminAddress || adminAddress || '',
            data: {} // Initial data, can be empty or preset values
        };

        // Get the NeDB datastore for oracles
        const oracleDB = await db.getDatabase('oracleList');

        try {
            // Save the new oracle to the database
            await oracleDB.insertAsync(newOracle);

            // Also save the new oracle to the in-memory map
            instance.oracles.set(oracleKey, newOracle);

            console.log(`New oracle created: ID ${oracleId}, Name: ${displayName}`);
            return oracleId; // Return the new oracle ID
        } catch (error) {
            console.error('Error creating new oracle:', error);
            throw error; // Re-throw the error for the caller to handle
        }
    }

    static async getNextId() {
        const oracleDB = await db.getDatabase('oracleList');
        const docs = await oracleDB.findAsync({});
        let maxId = 0;
        for (const doc of docs) {
            const id = Number(doc?.id ?? (String(doc?._id || '').split('-')[1]));
            if (Number.isFinite(id) && id > maxId) maxId = id;
        }
        if (maxId > 0) return maxId + 1;

        const instance = OracleList.getInstance(); // Get the singleton instance
        for (const key of instance.oracles.keys()) {
            const currentId = parseInt(key.split('-')[1]);
            if (currentId > maxId) {
                maxId = currentId;
            }
        }
        return maxId + 1;
    }

    async saveOracleData(oracleId, data, blockHeight) {
        const oracleDataDB = await db.getDatabase('oracleData');
        const recordKey = `oracle-${oracleId}-${blockHeight}`;
        console.log('saving published oracle data to key '+recordKey)
        const oracleDataRecord = {
            _id: recordKey,
            type: 'oracle',
            oracleId,
            data,
            blockHeight
        };

        try {
            await oracleDataDB.updateAsync(
                { _id: recordKey },
                oracleDataRecord,
                { upsert: true }
            );
            console.log(`Oracle data record saved successfully: ${recordKey}`);
        } catch (error) {
            console.error(`Error saving oracle data record: ${recordKey}`, error);
            throw error;
        }
    }

    async loadOracleData(oracleId, startBlockHeight = 0, endBlockHeight = Number.MAX_SAFE_INTEGER) {
        const oracleDataDB = await db.getDatabase('oracleData');
        try {
            const query = {
                oracleId: oracleId,
                type: 'oracle',
                blockHeight: { $gte: startBlockHeight, $lte: endBlockHeight }
            };
            const oracleDataRecords = await oracleDataDB.findAsync(query);
            return oracleDataRecords.map(record => ({
                blockHeight: record.blockHeight,
                data: record.data
            }));
        } catch (error) {
            console.error(`Error loading oracle data for oracleId ${oracleId}:`, error);
            throw error;
        }
    }

    static async closeOracle(oracleId) {
        const instance = OracleList.getInstance();
        const oracleKey = `oracle-${oracleId}`;
        const oracleDB = await db.getDatabase('oracleList');

        try {
            // Fetch the current oracle data
            const oracle = await oracleDB.findOneAsync({ _id: oracleKey });

            if (!oracle) {
                throw new Error('Oracle not found');
            }

            // Mark the oracle as closed
            oracle.closed = true;

            // Update the oracle in the database
            await oracleDB.updateAsync({ _id: oracleKey }, { $set: { closed: true } }, {});

            // Update the in-memory map if maintaining one
            instance.oracles.set(oracleKey, oracle);

            console.log(`Oracle ID ${oracleId} has been closed`);

            // Call the insurance fund to perform the payout
            await getInsuranceModule().liquidate(oracle.adminAddress,true);

            console.log(`Payout for Oracle ID ${oracleId} completed`);
        } catch (error) {
            console.error(`Error closing oracle ${oracleId}:`, error);
            throw error;
        }
    }


    /**
     * Fetches VWAP for an oracle-based contract over `trailingBlocks`
     * @param {number} oracleId - The oracle ID
     * @param {number} blockHeight - The current block height
     * @param {number} trailingBlocks - The number of blocks to look back
     * @returns {Promise<number|null>} - The calculated VWAP or null if no data
     */
    static async getTWAP(oracleId, blockHeight, trailingBlocks) {
        try {
            const oracleDB = await db.getDatabase('oracleData');
            const blockStart = blockHeight - trailingBlocks;

            // Query oracle data within the block range
            const oracleData = await oracleDB.findAsync({
                oracleId,
                blockHeight: { $gte: blockStart, $lte: blockHeight }
            });

            if (!oracleData || oracleData.length === 0) {
                //console.warn(`⚠️ No Oracle VWAP data for oracle ${oracleId} in blocks ${blockStart}-${blockHeight}`);
                return null;
            }

            // Calculate VWAP
            let totalVolume = new BigNumber(0);
            let sumVolumeTimesPrice = new BigNumber(0);

            for (const entry of oracleData) {
                const price = new BigNumber(entry.data.price);
                const volume = new BigNumber(1); // Assume equal weight for each oracle entry

                totalVolume = totalVolume.plus(volume);
                sumVolumeTimesPrice = sumVolumeTimesPrice.plus(volume.times(price));
            }

            if (totalVolume.isZero()) return null;

            return sumVolumeTimesPrice.dividedBy(totalVolume).decimalPlaces(8).toNumber();
        } catch (error) {
            console.error(`❌ Error fetching VWAP for oracle ${oracleId}:`, error);
            return null;
        }
    }

    // Additional methods for managing oracles
}

module.exports = OracleList;
