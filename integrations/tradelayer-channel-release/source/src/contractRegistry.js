const db = require('./db')
const path = require('path');
const util = require('util');
//const TxUtils = require('./txUtils.js')
const BigNumber = require('bignumber.js')
const AMMPool = require('./amm.js')
const VolumeIndex = require('./volumeIndex.js')
const OracleRegistry = require('./oracle.js')
const PropertyManager = require('./property.js')
const Channels = require('./channels.js')

class ContractRegistry {
    constructor() {
        // ... Other initializations ...
        this.contractList = new Map()
        this.oracleList = new Map(); // Initialize if needed
        this.nativeList = new Map(); // Initialize if needed
        this.modFlag = false
    }

    static async setModFlag(flag){
        this.modFlag = flag
        return
    }

    static async loadContractSeries() {
        //console.log('loading contract list for this instance '+JSON.stringify(instance))
        const instance = ContractRegistry.getInstance(); // Access singleton instance
        //console.log('loading contract list for this instance '+JSON.stringify(instance))
        try {
            const base = await db.getDatabase('contractList')
            const docs = await base.findAsync({ type: 'contractSeries' });
            return instance.contractSeries = new Map(docs.map(doc => [doc.id, doc.data]));
        } catch (error) {
            console.error('Error loading contract series data:', error);
        }
    }

// contractRegistry.js (add somewhere in the class or attach to the instance)
    static async lookupInverseNativeByNotionalPid(basePid) {
      const all = await ContractRegistry.getAllContracts(); // returns docs.map(doc.data)
      const matches = [];

      console.log('all contracts '+JSON.stringify(all))

      for (const meta of all) {
        if (!meta || typeof meta !== 'object') continue;
        const cid = meta.id;
        if (!cid) continue;

        const inverse = await ContractRegistry.isInverse(cid);
        const native  = await ContractRegistry.isNativeContract(cid);
        console.log('inverse, native? '+inverse+' '+native)
        if (!inverse || !native) continue;

        // match the underlying property we’re hedging
        if (Number(meta.collateralPropertyId) !== Number(basePid)) continue;

        matches.push({
          contractId: cid,
          seriesId: cid,
          symbol: meta.symbol || meta.ticker || meta.name || `contract-${cid}`,
          notionalPropertyId: Number(meta.notionalPropertyId),
          // notional per contract is accessible via getNotionalValue(contractId, mark)
          // but we return meta here and compute with the live mark later
        });
      }
      return matches;
    }

    static async isDuplicateNativeContract(collateralPropertyId, onChainDataPair, notionalPropertyId) {
            try {
                // Load contract series if not already loaded
                if (!ContractRegistry.getInstance().contractSeries) {
                    await ContractRegistry.loadContractSeries();
                }
                const instance = ContractRegistry.getInstance();
                const contractSeries = instance.contractSeries;

                // Iterate over contract series to find a duplicate
                for (const [id, contract] of contractSeries) {
                    console.log('inside isDuplicateNativeContract '+id, JSON.stringify(contract), contract.collateralPropertyId, collateralPropertyId,onChainDataPair)
                    if (contract.native && contract.collateralPropertyId === collateralPropertyId) {
                        console.log('ding')
                        for (const pair of contract.onChainData) {
                            if ((pair[0] === onChainDataPair[0] && pair[1] === onChainDataPair[1])||(pair[0] === onChainDataPair[1] && pair[1] === onChainDataPair[0])&&contract.notionalPropertyId==notionalPropertyId) {
                                console.log('dong')
                                return true;
                            }
                        }
                    }
                }
                console.log('contratulations')
                return false;
            } catch (error) {
                console.error('Error checking for duplicate native contract:', error);
                return false;
            }
    }

     // Singleton instance getter
    static getInstance() {
        if (!this.instance) {
            console.log('no instance detected creating new contract List obj')
            this.instance = new ContractRegistry();
        }
        return this.instance;
    }

    static async createContractSeries(sender, params, block) {
        // Load the current contract list from the database
        const contractListDB = await db.getDatabase('contractList');
        const currentContractList = await contractListDB.findAsync({ type: 'contractSeries' });
        const contractList = new Map(currentContractList.map(doc => [doc.id, doc.data]));

        // Generate a unique ID for the new contract series
        const seriesId = await ContractRegistry.getNextIdFromMap(contractList);
        const thisAMM = new AMMPool(0,1,10,seriesId)
        if(params.whitelist==undefined||params.whitelist==null){
            params.whitelist=0
        }
        if(params.native){
            let propertyData1 = await PropertyManager.getPropertyData(params.notionalPropertyId)
            let propertyData2 = await PropertyManager.getPropertyData(params.collateralPropertyId)
            if(params.notionalPropertyId==0){
                propertyData1={ticker:"LTC"}
                console.log('property data in create contract series special ed. '+JSON.stringify(propertyData1)+' '+JSON.stringify(propertyData2))
            }
            params.ticker = propertyData1.ticker+"/"+propertyData2.ticker+"-PERP"

        }else if(!params.native&&params.underlyingOracleId!=0){
            const oracleInfo = await OracleRegistry.getOracleInfo(params.underlyingOracleId)
            params.ticker = oracleInfo.name.ticker+"-OPERP"+params.underlyingOracleId+"-"+seriesId
            console.log('params in create oracle contract '+JSON.stringify(params))
        }


        // Create the contract series object
        const contractSeries = {
            id: seriesId,
            ticker:params.ticker||seriesId+"-PERP",
            issuer: sender,
            native: params.native,
            underlyingOracleId: params.underlyingOracleId,
            onChainData: params.onChainData,
            notionalPropertyId: params.notionalPropertyId,
            notionalValue: params.notionalValue,
            collateralPropertyId: params.collateralPropertyId,
            leverage: params.leverage,
            expiryPeriod: params.expiryPeriod,
            series: params.series,
            inverse: params.inverse,
            fee: params.fee,
            whitelist: params.whitelist,
            contracts: {
                expired: [],
                unexpired: await ContractRegistry.generateContracts(params.expiryPeriod, params.series, seriesId, block)
            },
            ammPool: thisAMM // Add the AMM object to the contract series
        };

        // Add the new contract series to the contract list
        contractList.set(seriesId, contractSeries);

        // Save the updated contract list back to the database
        await ContractRegistry.saveDataToDb(contractList, 'contractSeries');

        console.log(`New contract series created: ID ${seriesId}`);
        return seriesId; // Return the new series ID
    }

    static async getAMM(contractId) {
        console.log('inside get AMM')
        const contractInfo = await ContractRegistry.getContractInfo(contractId);
        if (contractInfo && contractInfo.ammPool) {
            const pool = contractInfo.ammPool;
            if (pool instanceof AMMPool) return pool;
            const hydrated = new AMMPool(
                Number(pool.position || 0),
                Number(pool.maxPosition || 1),
                Number(pool.maxQuoteSize || 10),
                Number(pool.contractType || contractId)
            );
            hydrated.lpAddresses = { ...(pool.lpAddresses || {}) };
            hydrated.ammOrders = Array.isArray(pool.ammOrders) ? pool.ammOrders : [];
            return hydrated;
        } else {
            throw new Error(`AMM object not found for contract ID ${contractId}`);
        }
    }

    // Function to update AMM object when LPs pledge or redeem
    static async updateAMM(contractId, lpAddress, pledgeAmount, redeemAmount) {
        if (!this.contractList.has(contractId)) {
            throw new Error(`Contract ID ${contractId} not found in contract registry`);
        }
        
        const { ammPool } = this.contractList.get(contractId);
        
        // Update the AMM object based on LPs pledge or redeem
        if (pledgeAmount !== null && pledgeAmount > 0) {
            // Pledge scenario: Add liquidity
            ammPool.insertCapital(lpAddress, pledgeAmount);
        } else if (redeemAmount !== null && redeemAmount > 0) {
            // Redeem scenario: Remove liquidity
            ammPool.redeemCapital(lpAddress, redeemAmount);
        } else {
            throw new Error(`Invalid pledgeAmount (${pledgeAmount}) or redeemAmount (${redeemAmount})`);
        }

        // Save the updated contract list back to the database
        await this.saveAllData();
    }


    static async getNextIdFromMap(contractList) {
        let maxId = 0;
        for (const [key] of contractList.entries()) {
            const currentId = parseInt(key);
            if (currentId > maxId) {
                maxId = currentId;
            }
        }
        return maxId + 1;
    }


    static async getAllPerpContracts() {
    try {
        const contractListDB = await db.getDatabase('contractList');
        const contracts = await contractListDB.findAsync({ type: 'contractSeries' });

        if (!contracts || contracts.length === 0) {
            console.log("⚠️ No contracts found in the registry.");
            return [];
        }

        // **Filter contracts using both expiryPeriod == 0 OR ticker contains "PERP"**
        const perpContracts = contracts
            .filter(doc => 
                doc.data.expiryPeriod === 0 || 
                (doc.data.ticker && doc.data.ticker.includes("PERP"))
            )
            .map(doc => doc.data.id);
            
        return perpContracts;

    } catch (error) {
        console.error("❌ Error fetching perpetual contracts:", error);
        return [];
    }
}


    // Generate contracts within the series
    static async generateContracts(expiryPeriod, series, seriesId, block) {
        let contracts = [];
        let expirationBlock = parseInt(block) + parseInt(expiryPeriod);

        for (let i = 0; i < series; i++) {
            contracts.push({
                id: `${seriesId}-${expirationBlock}`,
                expirationBlock: expirationBlock,
            });
            expirationBlock += parseInt(expiryPeriod);
        }
        return contracts;
    }

    static loadContractsFromDB() {
        db.getDatabase('contractList').findAsync()
            .then(docs => {
                docs.forEach(doc => {
                    const { type, seriesId } = doc;
                    if (type === 'oracle') {
                        this.oracleList.set(seriesId, doc.data);
                    } else {
                        this.nativeList.set(seriesId, doc.data);
                    }
                });
                return
            })
            .catch(error => {
                console.error('Error loading contracts from DB:', error);
                throw error;
            });
    }

       static async saveDataToDb(dataMap, dataType) {
        const dbInstance = await db.getDatabase('contractList');
        const dataArray = Array.from(dataMap.entries()).map(([id, data]) => ({
            id, data, type: dataType
        }));

        for (const entry of dataArray) {
            await dbInstance.updateAsync({ id: entry.id }, entry, { upsert: true });
        }
    }


    // Function to save contract series, oracle contracts, or native contracts
    static async saveAllData() {
        const instance = ContractRegistry.getInstance();
        await this.saveDataToDb(instance.contractList, 'contractSeries');
        await this.saveDataToDb(instance.oracleList, 'oracleContracts');
        await this.saveDataToDb(instance.nativeList, 'nativeContracts');
    }


     static async getNextId() {
        const instance = ContractRegistry.getInstance(); // Access singleton instance
        console.log('getting next id for instance '+JSON.stringify(instance))
        let maxId = 0;
        for (const [key] of instance.contractList.entries()) {
            const currentId = parseInt(key);
            if (currentId > maxId) {
                maxId = currentId;
            }
        }
        return maxId + 1;
    }

    static isValidSeriesId(seriesId) {
        const instance = ContractRegistry.getInstance(); // Access singleton instance
        // Check if the seriesId exists in the contract series registry
        // The registry could be a database, a map, or any other data structure
        // that stores information about the contract series in your system
        if (instance.contractList.has(seriesId)) {
            return true; // The seriesId is valid
        } else {
            return false; // The seriesId is not valid
        }
    }

    static async getContractSeries(seriesId) {
        const contractListDB = await db.getDatabase('contractList');
        const doc = await contractListDB.findOneAsync({ id: seriesId, type: 'contractSeries' });
        return doc ? doc.data : null;
    }

    // ... other methods ...

    // Function to generate unique series ID
    static async getNextId() {
        const contractListDB = await db.getDatabase('contractList');
        const docs = await contractListDB.findAsync({ type: 'contractSeries' });
        let maxId = docs.reduce((max, doc) => Math.max(max, parseInt(doc.id)), 0);
        return maxId + 1;
    }

    static async getAllContracts() {
        const contractListDB = await db.getDatabase('contractList');
        const docs = await contractListDB.findAsync({ type: 'contractSeries' });
        return docs.map(doc => doc.data);
    }

    /**
     * Returns an array of contract IDs where the collateral matches collateralId.
     * @param {string} address - The trader's address (not used in filtering, but included for compatibility)
     * @param {number} collateralId - The collateral property ID to filter by
     * @returns {Promise<number[]>} - A promise that resolves to an array of contract IDs
     */
    static async getAllContractsForCollateral(address, collateralId) {
        // Fetch contract data from DB
        const contractList = await ContractRegistry.getAllContracts();

        if (!contractList || contractList.length === 0) {
            console.log(`⚠️ No contracts found in database.`);
            return [];
        }

        // Filter contracts that match the collateralId
        const contractIds = contractList
            .filter(contract => contract.collateralPropertyId === collateralId)
            .map(contract => contract.id); // Ensure we're extracting the correct ID field

        console.log(`🔎 Found ${contractIds.length} contracts using collateral ${collateralId} for address ${address}.`);
        return contractIds; // Returns an array usable in for...of loops
    }

    async hasOpenPositions(contract) {
        try {
            // Load the margin map for the contract's series ID
            let marginMap = await MarginMap.loadMarginMap(contract.seriesId);
            // Check if the margin map has any non-zero positions for this contract
            for (let [address, positionData] of marginMap.margins.entries()) {
                if (positionData.contracts > 0) {
                    return true; // Found an open position
                }
            }
            return false; // No open positions found
        } catch (error) {
            console.error('Error checking open positions for contract:', contract.seriesId, error);
            throw error;
        }
    }

    
    static async getContractType(contractId) {
        console.log('inside get contract type')
        const contractInfo = await this.getContractInfo(contractId);
        if (!contractInfo) {
            throw new Error("Contract type not found for contract ID: " + contractId);
        }
        return contractInfo.native ? 'native' : 'oracle';
    }

    static async isNativeContract(contractId){
        //console.log('inside isNative')
        const contractInfo = await this.getContractInfo(contractId);
        return contractInfo ? contractInfo.native : false;
    }

    static async getContractInfo(contractId) {
            //console.log('retrieving db info for contract ' + contractId);
            const contractListDB = await db.getDatabase('contractList');
            const doc = await contractListDB.findOneAsync({ 
                id: parseInt(contractId, 10),  // <-- coerce to number
                type: 'contractSeries' 
            });
            if (!doc) {
                return null;
            }
            //console.log(doc);
            return doc.data;
        }

    static async getNotionalValue(contractId, mark) {
        const contractData = await ContractRegistry.getContractInfo(contractId);
        if (!contractData) {
            return { notionalValue: 0, notionalPerContract: 0 };
        }
        console.log('blaiven '+JSON.stringify(contractData))
        const BNNotional = new BigNumber(contractData.notionalValue || 0);
        let BNMark = new BigNumber(mark || 0);
        if (!BNMark.isFinite() || BNMark.lte(0)) {
            if (contractData.underlyingOracleId != null) {
                const oracleMark = await OracleRegistry.getOraclePrice(contractData.underlyingOracleId);
                BNMark = new BigNumber(oracleMark || 0);
            }
        }
        console.log('checking notional and mark in getNotionalValue '+contractData.notionalValue +' '+BNMark.toString())
        try {
           if (contractData.native && contractData.inverse) {
            console.log(`Calculating Notional Value for Inverse Native Contract`);
            if (!BNMark.isFinite() || BNMark.lte(0)) {
                return { notionalValue: 0, notionalPerContract: Number(BNNotional) || 0 };
            }
            const notionalValue = new BigNumber(1)
                .dividedBy(BNMark)
                .multipliedBy(BNNotional)
                .decimalPlaces(8)
                .toNumber();

            console.log(`Calculated Notional Value: ${notionalValue}`);
            
            return{notionalValue:notionalValue, notionalPerContract:contractData.notionalValue};
        }else if (!contractData.native && !contractData.inverse) {
            console.log(`Calculating Notional Value for Linear Contract`+BNNotional+' '+BNMark);
            if (!BNMark.isFinite() || BNMark.lte(0)) {
                return { notionalValue: Number(BNNotional) || 0, notionalPerContract: contractData.notionalValue };
            }
            const notionalValue = BNNotional.times(BNMark).decimalPlaces(8).toNumber();

            console.log(`Calculated Notional Value: ${notionalValue}`);
            return{notionalValue:notionalValue, notionalPerContract:contractData.notionalValue};
        }else if (!contractData.native && contractData.inverse) {
                console.log(`Calculating Notional Value for Inverse Oracle Contract`);
                if (!BNMark.isFinite() || BNMark.lte(0)) {
                    return { notionalValue: 0, notionalPerContract: contractData.notionalValue };
                }
                const notionalValue = new BigNumber(1)
                    .dividedBy(BNMark)
                    .multipliedBy(BNNotional)
                    .decimalPlaces(8)
                    .toNumber();

                console.log(`Calculated Notional Value: ${notionalValue}`);
                return {notionalValue:notionalValue, notionalPerContract:contractData.notionalValue};
            }
            return { notionalValue: Number(BNNotional) || 0, notionalPerContract: contractData.notionalValue };
        } catch (error) {
            console.error(`Error retrieving notional value for contractId ${contractId}:`, error);
            throw error;
        }
    };

    static async isInverse(contractId) {
        // Call the existing getContractInfo function

        //console.log('inside isInverse')
        const contractInfo = await this.getContractInfo(contractId);
        
        // Check if contractInfo exists and has the 'inverse' property
        if (contractInfo && typeof contractInfo.inverse !== 'undefined') {
            return contractInfo.inverse;
        }

        // Return false by default if the contract is not found or doesn't have the 'inverse' property
        return false;
    }

     // Function to get initial margin requirement for a contract
    static async getInitialMargin(contractId, price){
        //console.log('checking contractId inside getInitialMargin '+contractId)
        const contractInfo = await ContractRegistry.getContractInfo(contractId);
        if (!contractInfo) {
            throw new Error(`Contract info not found for contract ID: ${contractId}`);
        }
        console.log('getting contractInfo inside getInit Margin ' +JSON.stringify(contractInfo))
        let inverse = contractInfo.inverse;
        let notionalValue = contractInfo.notionalValue
        let leverage = contractInfo.leverage || 10
        let priceBN = new BigNumber(price)
        let leverageBN = new BigNumber(leverage)
        let notionalBN = new BigNumber(notionalValue)
        console.log('inside getInitialMargin, inverse:'+inverse+ 'notional '+ notionalValue + 'lvg. '+ leverage + 'at price '+price)
        if (inverse) {
            // For inverse contracts, margin is calculated based on notional value
            console.log('calc. init. margin inverse '+notionalValue+' '+priceBN+' '+leverage)
            let margin = notionalBN.dividedBy(priceBN).div(leverageBN).decimalPlaces(8, BigNumber.ROUND_CEIL).toNumber();
            console.log(margin)
            return margin
        } else {
            /*
            // For linear contracts, check collateral and calculate based on oracle price or property value
            const collateralValue = await ContractRegistry.getCollateralValue(contractInfo);
            return BigNumber(collateralValue).div(leverage);
            */

            return notionalBN.times(price).div(leverageBN).decimalPlaces(8).toNumber();
        }
    }

    // Helper function to get collateral value for linear contracts
    static async getCollateralValue(contractInfo) {
        const PropertyManager = require('./property.js')
        const OracleList = require('./oracle.js')
        const { collateralPropertyId, underlyingOracleId } = contractInfo;
        if (collateralPropertyId) {
            // If collateral is a property, use its value
            const propertyData = await PropertyManager.getPropertyData(collateralPropertyId);
            return propertyData ? propertyData.value : 0; // Example value fetching logic
        } else if (underlyingOracleId) {
            // If collateral is based on an oracle, use the latest price
            const latestPrice = await OracleRegistry.getOracleData(underlyingOracleId);
            return latestPrice || 0; // Example oracle price fetching logic
        }
        return 0; // Default to 0 if no valid collateral source
    }

    // Method to get the collateral property ID for a given contract ID
    static async getCollateralId(contractId) {
        // Load contract information

        //console.log('inside get collateralPropertyId')
        const contractInfo = await ContractRegistry.getContractInfo(contractId);

        // Check if contract information is available
        if (!contractInfo) {
            console.log(`Contract info not found for contract ID: ${contractId}`);
        }
        //console.log('getting contract info for '+contractId +' '+JSON.stringify(contractInfo.collateralPropertyId))
        // Return the collateral property ID from the contract information
        //console.log('returning collateral id '+contractInfo.collateralPropertyId+ ' type of '+typeof contractInfo.collateralPropertyId)
        return contractInfo.collateralPropertyId;
    }

        // In the contract order addition process
    static async moveCollateralToReserve(sender, contractId, amount,price, block,txid,inProcess) {
        const TallyMap = require('./tally.js')
        const initialMarginPerContract = await ContractRegistry.getInitialMargin(contractId, price);
        console.log('initialMarginPerContract '+initialMarginPerContract)
        const collateralPropertyId = await ContractRegistry.getCollateralId(contractId)
        console.log('collateralPropertyId '+collateralPropertyId)
        const amountBN = new BigNumber(Math.abs(amount))
        const initialMarginBN = new BigNumber(initialMarginPerContract)
        const totalInitialMargin = initialMarginBN.times(amountBN).decimalPlaces(8).toNumber();
        console.log('Total Initial Margin to reserve ' +totalInitialMargin+' '+sender+' '+collateralPropertyId)
        // Move collateral to reserved position
        const hasSufficientBalance = await TallyMap.hasSufficientBalance(sender,collateralPropertyId,totalInitialMargin)
        console.log(hasSufficientBalance.hasSufficient)
        if(hasSufficientBalance.hasSufficient){
            let reason ='contractReserveInitMargin'
            if(inProcess){reason = 'contractReserveFromMatchProcess'}
            await TallyMap.updateBalance(sender, collateralPropertyId, -totalInitialMargin, totalInitialMargin, 0, 0, reason,block,txid); 
            return totalInitialMargin
        }else{
            return null
        }
        
    }

    static async moveCollateralToMargin(
        sender,
        contractId,
        amount,
        price,
        orderPrice,
        side,
        initMargin,
        channel,
        channelAddr,
        block,
        feeInfo,
        maker,
        flag,
        txid,
        position
    ){
        const TallyMap = require('./tally.js');
        const MarginMap = require('./marginMap.js');
        const BigNumber = require('bignumber.js');
        const Channels = require('./channels.js');

        const marginMap = await MarginMap.getInstance(contractId);

        const initialMarginPerContract = await ContractRegistry.getInitialMargin(contractId, price);
        const compareInitMargin = await ContractRegistry.getInitialMargin(contractId, orderPrice);
        console.log('comparing realized price margin with orderPrice margin ' + initMargin + ' ' + compareInitMargin);

        const collateralPropertyId = await ContractRegistry.getCollateralId(contractId);

        // initMargin is already a TOTAL in your call-sites (marginUsed), keep it as-is
        let totalInitialMargin = new BigNumber(initMargin || 0).decimalPlaces(8).toNumber();
        const totalComparedMargin = new BigNumber(compareInitMargin).times(amount).decimalPlaces(8).toNumber();

        console.log('Total Initial Margin ' + totalInitialMargin + ' ' + amount + ' ' + initMargin + ' ' + price);
        console.log('about to calc. reserve-vs-fill delta ' + orderPrice + ' ' + price + ' ' + totalComparedMargin + ' ' + totalInitialMargin + ' ' + side + ' ' + maker);

        // ------------------------------------------------------------
        // Reconcile reserve at orderPrice vs required at fill price
        // diff = reserved(orderPrice) - required(fill)
        //  diff > 0 => refund from reserve to available
        //  diff < 0 => top up reserve from available (if possible)
        // NOTE: keep your original gating: only non-maker, non-channel
        // ------------------------------------------------------------
        if (channel === false && maker === false) {
            const diff = new BigNumber(totalComparedMargin).minus(totalInitialMargin).decimalPlaces(8).toNumber();

            if (diff > 0) {
                console.log(`returning excess margin ${diff} to ${sender}`);
                await TallyMap.updateBalance(
                    sender,
                    collateralPropertyId,
                    diff,      // available +
                    -diff,     // reserve   -
                    0, 0,
                    'returnExcessMargin',
                    block
                );
            } else if (diff < 0) {
                const topUp = new BigNumber(diff).abs().decimalPlaces(8).toNumber();
                console.log(`topping up reserve ${topUp} for ${sender}`);
                const has = await TallyMap.hasSufficientBalance(sender, collateralPropertyId, topUp);
                if (has.hasSufficient) {
                    await TallyMap.updateBalance(
                        sender,
                        collateralPropertyId,
                        -topUp,    // available -
                        topUp,     // reserve   +
                        0, 0,
                        'topUpReserveToFillPriceMargin',
                        block
                    );
                } else {
                    console.log(`topUpReserveToFillPriceMargin skipped: insufficient available for ${sender}, need=${topUp}`);
                }
            }
        }

        console.log('checking feeInfo obj again ' + JSON.stringify(feeInfo));

        if (feeInfo.buyFeeFromReserve && side === true) {
            totalInitialMargin = new BigNumber(totalInitialMargin).minus(feeInfo.buyerFee).decimalPlaces(8).toNumber();
        } else if (feeInfo.sellFeeFromReserve && side === false) {
            totalInitialMargin = new BigNumber(totalInitialMargin).minus(feeInfo.sellerFee).decimalPlaces(8).toNumber();
        }

        const isVirtualAmmSender = (sender === 'amm') || (typeof sender === 'string' && sender.startsWith('amm:'));
        if (channel === false && isVirtualAmmSender) {
            console.log('virtual AMM sender: skip tally collateral movement, set margin only in map');
            console.log('about to setInitialMargin ' + sender + contractId + ' ' + totalInitialMargin);
            position = await marginMap.setInitialMargin(sender, contractId, totalInitialMargin, block, position);
            return position;
        }

        // ------------------------------------------------------------
        // Move init margin into margin bucket
        // Priority: reserve -> available -> (optional) existing margin
        // This prevents negative available crashes.
        // ------------------------------------------------------------
        if (channel === false) {
            console.log('attention Will Robinson ' + totalInitialMargin);

            // IMPORTANT: your getTally(address) path logs "undefined" and does not return a usable prop object
            const propObj = await TallyMap.getTally(sender, collateralPropertyId) || {};

            const availBal = new BigNumber(propObj.available || 0);
            const resBal   = new BigNumber(propObj.reserved  || 0);
            const marBal   = new BigNumber(propObj.margin    || 0);

            // use as much reserve as possible
            const reserveDebitBN = BigNumber.minimum(resBal, new BigNumber(totalInitialMargin));
            const reserveDebit = reserveDebitBN.decimalPlaces(8).toNumber();

            const remainingBN = new BigNumber(totalInitialMargin).minus(reserveDebitBN).decimalPlaces(8);
            const remaining = remainingBN.toNumber();

            // Case A: reserve alone covers it
            if (remaining <= 0) {
                if (reserveDebit > 0) {
                    await TallyMap.updateBalance(
                        sender,
                        collateralPropertyId,
                        0,
                        -reserveDebit,
                        reserveDebit,
                        0,
                        'contractTradeInitMargin',
                        block
                    );
                }
            }
            // Case B: reserve + available covers it
            else if (availBal.gte(remaining)) {
                await TallyMap.updateBalance(
                    sender,
                    collateralPropertyId,
                    -remaining,      // take remaining from available
                    -reserveDebit,   // take what we can from reserve
                    totalInitialMargin,
                    0,
                    'contractTradeInitMargin',
                    block
                );
            }
            // Case C: reserve + existing margin covers it (no available debit)
            else if (marBal.gte(remaining)) {
                // move reserve portion (if any) into margin
                if (reserveDebit > 0) {
                    await TallyMap.updateBalance(
                        sender,
                        collateralPropertyId,
                        0,
                        -reserveDebit,
                        reserveDebit,
                        0,
                        'contractTradeInitMargin',
                        block
                    );
                }
                // remaining is assumed to already be sitting inside margin collateral
                // (cross-margin style), so no tally movement needed.
            }
            // Case D: available + existing margin covers remaining (drain available, rest from margin)
            else if (availBal.plus(marBal).gte(remaining)) {
                const fromAvailBN = availBal.decimalPlaces(8);
                const fromAvail = fromAvailBN.toNumber();

                if (reserveDebit > 0) {
                    await TallyMap.updateBalance(
                        sender,
                        collateralPropertyId,
                        0,
                        -reserveDebit,
                        reserveDebit,
                        0,
                        'contractTradeInitMargin',
                        block
                    );
                }

                if (fromAvail > 0) {
                    await TallyMap.updateBalance(
                        sender,
                        collateralPropertyId,
                        -fromAvail,
                        0,
                        fromAvail,
                        0,
                        'contractTradeInitMargin',
                        block
                    );
                }
                // remainder-from-margin: no movement
            }
            // Case E: cannot fund
            else {
                throw new Error(
                    `Insufficient collateral for contractTradeInitMargin sender=${sender} prop=${collateralPropertyId} need=${totalInitialMargin} avail=${availBal.toNumber()} res=${resBal.toNumber()} mar=${marBal.toNumber()}`
                );
            }
        }
        else if (channel === true) {
            let hasChannel = await TallyMap.hasSufficientChannel(channelAddr, collateralPropertyId, totalInitialMargin);
            console.log('about to move initMargin from channel ' + channelAddr + ' ' + collateralPropertyId + ' ' + totalInitialMargin);

            if (hasChannel.hasSufficient) {
                await TallyMap.updateChannelBalance(channelAddr, collateralPropertyId, -totalInitialMargin, 'debitChannelContractTradeInitMargin', block);
                await TallyMap.updateBalance(sender, collateralPropertyId, 0, 0, totalInitialMargin, 0, 'creditChannelContractTradeInitMargin', block);
                await Channels.debitInitMarginFromChannel(channelAddr, sender, collateralPropertyId, totalInitialMargin, block);
            } else {
                if (hasChannel.reason != 'undefined') {
                    let shortfallBN = new BigNumber(hasChannel.shortfall);
                    let channelDebit = new BigNumber(totalInitialMargin).minus(shortfallBN).decimalPlaces(8).toNumber();

                    await TallyMap.updateChannelBalance(channelAddr, collateralPropertyId, -channelDebit, 'contractTradeInitMargin', block);
                    await TallyMap.updateBalance(sender, collateralPropertyId, -shortfallBN.toNumber(), 0, totalInitialMargin, 0, 'contractTradeInitMargin', block);

                    await Channels.debitInitMarginFromChannel(channelAddr, sender, collateralPropertyId, channelDebit, block);
                } else {
                    throw new Error("reserve balance is undefined in tallymap for " + collateralPropertyId);
                }
            }
        }

        console.log('about to setInitialMargin ' + sender + contractId + ' ' + totalInitialMargin);
        position = await marginMap.setInitialMargin(sender, contractId, totalInitialMargin, block, position);
        return position;
    }



    static async getPriceAtBlock(contractId, blockHeight) {
        let isOracleContract = await ContractRegistry.isOracleContract(contractId);
        let oracleId = null;
        let propertyId1 = null;
        let propertyId2 = null;
        let latestData;
        let oracleDataDB = await db.getDatabase('contractList')
        if (isOracleContract) {
            oracleId = await ContractRegistry.getOracleId(contractId);
            latestData = await oracleDataDB.findAsync({ oracleId: oracleId });
        } else {
            let info = await ContractRegistry.getContractInfo(contractId);
            propertyId1 = info.onChainData[0][0];
            propertyId2 = info.onChainData[0][1];
            const pair = propertyId1+'-'+propertyId2
            latestData = await VolumeIndex.getLastPrice(pair,blockHeight)
            return latestData
            console.log('inside get price at block '+typeof latestData, JSON.stringify(latestData))
        }
        // Filter data to get updates before the given blockHeight
        const filteredData = latestData.filter(entry => entry.blockHeight < blockHeight);

        if (filteredData.length === 0) {
            // No data available before the given blockHeight
            return null;
        }

        // Sort filtered data by block height in descending order
        const sortedData = filteredData.sort((a, b) => b.blockHeight - a.blockHeight);
        const latestBlockData = sortedData[0]; // Get the latest data before the given blockHeight
        const lastPriceEntry = latestBlockData[latestBlockData.length - 1];
        const priceBlockHeight = lastPriceEntry.blockHeight; // Block height of the price data

        // Check if the block height of the price data is less than the provided blockHeight
        if (priceBlockHeight >= blockHeight) {
            // If not, find the latest data before the provided blockHeight
            for (let i = 1; i < sortedData.length; i++) {
                const blockData = sortedData[i];
                const blockDataPrice = blockData[blockData.length - 1].blockHeight;
                if (blockDataPrice < blockHeight) {
                    const lastPriceEntry = blockData[blockData.length - 1];
                    return lastPriceEntry.data.price;
                }
            }
            return null; // No valid price data found before the provided blockHeight
        }
        return lastPriceEntry.data.price;
    }

     // Determine if a contract is an oracle contract
    static async isOracleContract(contractId) {
        const contractInfo = await ContractRegistry.getContractInfo(contractId);
        return contractInfo && contractInfo.native === false;
    }

      // Determine a contract's oracle
    static async getOracleId(contractId) {
        const contractInfo = await ContractRegistry.getContractInfo(contractId);
        //console.log(contractInfo.native,Boolean(contractInfo.native===false))
        return contractInfo.underlyingOracleId;
    }

    static async getLatestOracleData(oracleId){
         // Access the database where oracle data is stored
            const oracleDataDB = await db.getDatabase('oracleData');
            // Query the database for the latest oracle data for the given contract
                       
            const latestData = await oracleDataDB.findOneAsync({ oracleId: oracleId });
            if (latestData) {
                const sortedData = [latestData].sort((a, b) => b.blockHeight - a.blockHeight);
                const latestBlockData = sortedData[0];

                return latestBlockData
            }else{
                console.log('no oracle data found '+JSON.stringify(latestData))
                return null
            }

    }

    // Calculate the 1-hour funding rate for an oracle contract
    static async calculateFundingRate(contractId) {
        const isOracle = await ContractRegistry.isOracleContract(contractId);
        if (!isOracle) {
            return 0; // Return zero for non-oracle contracts
        }

        // Get oracle data for the last 24 blocks
        const Oracles = require('./Oracles');
        const oracleData = await Oracles.getLast24BlocksData(contractId);
        const avgOraclePrice = ContractRegistry.calculateAveragePrice(oracleData);

        // Placeholder for the logic to get the average trade price for the contract
        // const avgTradePrice = ...;

        // Calculate the funding rate based on the difference between oracle price and trade price
        const priceDifference = avgTradePrice / avgOraclePrice;
        let fundingRate = 0;

        if (priceDifference > 1.0005) {
            fundingRate = (priceDifference - 1.0005) * oracleData.length; // Example calculation
        } else if (priceDifference < 0.9995) {
            fundingRate = (0.9995 - priceDifference) * oracleData.length; // Example calculation
        }

        return fundingRate;
    }

    async applyFundingRateToSystem(contractId,block) {
        const fundingRate = await ContractsRegistry.calculateFundingRate(contractId);
        
        // Apply funding rate to marginMap+tallyMap
        for (const [address, position] of marginMap.entries()) {
            if (position.contractId === contractId) {
                const fundingAmount = calculateFundingAmount(position.size, fundingRate);
                TallyMap.updateBalance(address, contractId, fundingAmount,0,0,0,'funding',block);
                marginMap.updatePosition(address, contractId, fundingAmount);
            }
        }

        // Apply funding rate to vaulted contracts
        for (const [vaultId, vault] of SynthRegistry.vaults.entries()) {
            if (vault.contractId === contractId) {
                const fundingAmount = ContractRegistry.calculateFundingAmount(vault.contractBalance, fundingRate);
                SynthRegistry.applyPerpetualSwapFunding(vaultId, contractId, fundingAmount);
            }
        }

        // Save changes
        await TallyMap.save();
        await marginMap.save();
        await SynthRegistry.saveVaults();
    }

    static calculateFundingAmount(contractSize, fundingRate) {
        return contractSize * fundingRate;
    }


    // Calculate the average price from oracle data
    static calculateAveragePrice(oracleData) {
        if (!oracleData || oracleData.length === 0) return 0;

        const total = oracleData.reduce((acc, data) => acc + data.price, 0);
        return total / oracleData.length;
    }

    // Save funding event for a contract
    static async saveFundingEvent(contractId, fundingRate, blockHeight) {
        const dbInstance = require('./db.js');
        const fundingEvent = { contractId, fundingRate, blockHeight };
        await dbInstance.getDatabase('fundingEvents').insertAsync(fundingEvent);
    }

    // Load funding events for a contract
    static async loadFundingEvents(contractId) {
        const dbInstance = require('./db.js');
        const fundingEvents = await dbInstance.getDatabase('fundingEvents').findAsync({ contractId: contractId });
        return fundingEvents.map(doc => doc);
    }
}

// Usage:

/*const oracleContracts = registry.getContractsByOracle(5); 

const propertyContracts = registry.getContractsByProperties(1, 2);*/

module.exports = ContractRegistry;
