var dbInstance = require('./db.js')
var TxUtils = require('./txUtils.js')
var PropertyList = require('./property.js')
const uuid = require('uuid');
const BigNumber = require('bignumber.js');
function getInsuranceModule() {
  return require('./insurance.js');
}
const Orderbooks = require('./orderbook.js')
const ContractRegistry = require('./contractRegistry.js')

const SATS = new BigNumber(1e8);
const RD = BigNumber.ROUND_DOWN;

function toSatsDecimal(x) {
  // raw sats (can be fractional before flooring)
  return new BigNumber(x).times(SATS);
}
function toSats(x) {
  // integer sats, never creates value
  return toSatsDecimal(x).integerValue(RD);
}
function fromSats(s) {
  return new BigNumber(s).div(SATS);
}

function q8(value) {
  return new BigNumber(value || 0).decimalPlaces(8, BigNumber.ROUND_HALF_UP);
}

    /**
     * Dust record is per (propertyId, contractId) in feeCache DB.
     * We store potential fractional sats as a decimal BigNumber "dustSats"
     * so many <1-sat remainders eventually roll up to whole sats.
     *
     * Schema: { dustSats: "decimal-string" }
     * Key:    `dust::<propertyId>-<contractId>`
     */
    async function _loadDust(db, key) {
      try {
        const row = await db.get(`dust::${key}`);
        const dustSats = new BigNumber(row?.dustSats ?? 0);
        return { dustSats };
      } catch {
        return { dustSats: new BigNumber(0) };
      }
    }

    async function _saveDust(db, key, dustSats) {
      await db.put(`dust::${key}`, { dustSats: dustSats.toString() });
    }

    /**
     * Accumulate dust (can be fractional sat units). When it reaches ≥ 1 sat,
     * credit whole sats to Insurance and keep the fractional remainder.
     *
     * creditFn({wholeSats}) must deposit exactly `wholeSats` (integer) sats to Insurance.
     */
    async function _accumulateDust(db, key, addDustSatsDecimal, creditFn) {
      if (!addDustSatsDecimal || new BigNumber(addDustSatsDecimal).eq(0)) return;

      const { dustSats } = await _loadDust(db, key);
      const next = dustSats.plus(addDustSatsDecimal);
      const whole = next.integerValue(RD);
      const frac  = next.minus(whole);

      if (whole.gt(0)) {
        await creditFn({ wholeSats: whole });
      }
      await _saveDust(db, key, frac);
    }

class TallyMap {
    static instance;

    constructor(path) {
        if (!TallyMap.instance) {
            this.addresses = new Map();
            this.feeCache = new Map(); // Map for storing fees for each propertyId
            TallyMap.instance = this;
            this.modFlag = false
        }
        return TallyMap.instance;
    }

    /**
     * Ensures that only one instance of TallyMap exists and attempts to load it from dbInstance.
     * @param {number} blockHeight - The block height for which to load the tally map.
     * @returns {Promise<TallyMap>} - A promise that resolves to the singleton instance of the TallyMap.
     */
    static async getInstance() {
        if (!TallyMap.instance) {
            TallyMap.instance = new TallyMap();
        }
        await TallyMap.loadFromDB();
        return TallyMap.instance;
    }

    static async setModFlag(flag){
        this.modFlag = flag
        return
    }

    async verifyPropertyIds() {
        let propertyIndex = await PropertyList.getPropertyIndex()    

        for (const [address, properties] of this.addresses.entries()) {
            for (const propertyId in properties) {
                if (!this.propertyIndex.has(propertyId)) {
                    console.error(`Invalid propertyId ${propertyId} found for address ${address}`);
                    // Handle the error - either remove the invalid entry or log it for further investigation
                }
            }
        }
    }

    static async updateBalance(address, propertyId, availableChange, reservedChange, marginChange, vestingChange, type, block,txid) {
            console.log('inside updateBalance for '+address, propertyId, availableChange, reservedChange, marginChange, vestingChange, type, block)
            
            if(availableChange==null||reservedChange==null||marginChange==null||vestingChange==null||isNaN(availableChange)||isNaN(reservedChange)||isNaN(marginChange)||isNaN(vestingChange)){
                throw new Error('Somehow null passed into updateBalance... avail. '+availableChange + ' reserved '+ reservedChange + ' margin' + marginChange + ' vesting '+vestingChange )
            }

            if (typeof propertyId === 'string' && propertyId.startsWith('s-')) {
                    // Handle synthetic token
            } else if (!Number.isInteger(propertyId)) {
                    return Error(`Invalid propertyId: ${propertyId}`);
            }


            if (typeof availableChange !== 'number'){
                console.log(`string passed in: ${availableChange}`);
                availableChange = new BigNumber(availableChange).toNumber()
                 console.log('new availableChange '+availableChange)
            }
            if(typeof reservedChange !== 'number'){
                console.log(`string passed in: ${reservedChange}`);
                reservedChange = new BigNumber(reservedChange).toNumber()
            }
            if(typeof marginChange !== 'number'){
                console.log(`string passed in: ${marginChange}`);
                marginChange = new BigNumber(marginChange).toNumber()
                console.log('new margin Change '+marginChange)
            }
            if(typeof vestingChange !== 'number'){
                console.log(`string passed in: ${vestingChange}`);
                vestingChange = new BigNumber(vestingChange).toNumber()
            }

            await TallyMap.loadFromDB();
            if (!TallyMap.addresses.has(address)) {
                TallyMap.addresses.set(address, {});
            }
            const addressObj = TallyMap.addresses.get(address);
            
            console.log('addressObj being changed '+propertyId + ' for addr '+JSON.stringify(addressObj[propertyId]))

            if (!addressObj[propertyId]) {
                addressObj[propertyId] = { amount: 0, available: 0, reserved: 0, margin: 0, vesting: 0 };
            }

            // Check and update available balance
            // Assuming addressObj[propertyId] and the respective change variables are already BigNumber instances
            // Example for available balance

            const originalAvailableBalance = new BigNumber(addressObj[propertyId].available);
            const newAvailableBalance = originalAvailableBalance.plus(availableChange);
            console.log('avail. balance change '+originalAvailableBalance, newAvailableBalance.toNumber(),availableChange)
            if (newAvailableBalance.isLessThan(0)) {
                throw new Error("Available balance cannot go negative " + originalAvailableBalance.toString() + ' change ' + availableChange.toString());
            }

            addressObj[propertyId].available = newAvailableBalance.toNumber();

            // Repeat the pattern for reserved, margin, and vesting balances

            // Example for reserved balance
            const originalReservedBalance = new BigNumber(addressObj[propertyId].reserved);
            const newReservedBalance = originalReservedBalance.plus(reservedChange);
            console.log('reserve. balance change '+originalReservedBalance, newReservedBalance.toNumber(),availableChange)
        
            if (newReservedBalance.isLessThan(0)) {
                throw new Error("Reserved balance cannot go negative " + originalReservedBalance.toString() + ' change ' + reservedChange.toString());
            }

            addressObj[propertyId].reserved = newReservedBalance.toNumber();

            // Example for margin balance
            const originalMarginBalance = new BigNumber(addressObj[propertyId].margin);
            const newMarginBalance = originalMarginBalance.plus(marginChange);
            console.log('old and new margin balance '+originalMarginBalance+' '+newMarginBalance)                
            if (newMarginBalance.isLessThan(0)) {
                throw new Error("Margin balance cannot go negative " + originalMarginBalance.toString() + ' change ' + marginChange.toString());
            }

            addressObj[propertyId].margin = newMarginBalance.toNumber();

            // Example for vesting balance
            const originalVestingBalance = new BigNumber(addressObj[propertyId].vesting);
            const newVestingBalance = originalVestingBalance.plus(vestingChange);

            if (newVestingBalance.isLessThan(0)) {
                throw new Error("Vesting balance cannot go negative " + originalVestingBalance.toString() + ' change ' + vestingChange.toString());
            }

            addressObj[propertyId].vesting = newVestingBalance.toNumber();

            // Update the total amount
            addressObj[propertyId].amount = this.calculateTotal(addressObj[propertyId]);

            if (typeof addressObj[propertyId].channelBalance === 'undefined') {
                addressObj[propertyId].channelBalance = 0;
            }


            if(availableChange==0&&reservedChange==0&&marginChange==0&&vestingChange==0){

            }else{
                await TallyMap.recordTallyMapDelta(address, block, propertyId, addressObj[propertyId].amount, availableChange, reservedChange, marginChange, vestingChange, 0, type,txid) 
            }
            TallyMap.addresses.set(address, addressObj); // Update the map with the modified address object
            //console.log('Updated balance for address:', JSON.stringify(addressObj), 'with propertyId:', propertyId);
            await TallyMap.saveToDB(block); // Save changes to the database
        }

        static async updateChannelBalance(address, propertyId, channelChange, type,block) {
            await TallyMap.loadFromDB();
            
            // Initialize the address if it doesn't exist
            if (!TallyMap.addresses.has(address)) {
                TallyMap.addresses.set(address, {});
            }
            const addressObj = TallyMap.addresses.get(address);
            
            // Initialize the propertyId if it doesn't exist
            if (!addressObj[propertyId]) {
                addressObj[propertyId] = { amount: 0, available: 0, reserved: 0, margin: 0, vesting: 0, channelBalance: 0 };
            }
            
            // Handle undefined channel balance and set it to 0 if necessary
            if (typeof addressObj[propertyId].channelBalance === 'undefined') {
                addressObj[propertyId].channelBalance = 0;
            }
            
            // Update channel balance
            const originalChannelBalance = new BigNumber(addressObj[propertyId].channelBalance);
            const newChannelBalance = originalChannelBalance.plus(channelChange);
            
            if (newChannelBalance.isLessThan(0)) {
                throw new Error(`Channel balance cannot go negative for property ${propertyId}`);
            }

            // Update the channel balance
            addressObj[propertyId].channelBalance = newChannelBalance.toNumber();
            addressObj[propertyId].amount = this.calculateTotal(addressObj[propertyId]);
            // Record the channel balance change
            if (channelChange !== 0) {
                await TallyMap.recordTallyMapDelta(
                    address, 
                    block, 
                    propertyId, 
                    addressObj[propertyId].amount, 
                    0, // No change in available
                    0, // No change in reserved
                    0, // No change in margin
                    0, // No change in vesting
                    channelChange, 
                    type
                );
            }

            // Save the updated object back to the map
            TallyMap.addresses.set(address, addressObj);
            await TallyMap.saveToDB(block); // Save the updated balance to the database
        }

        static async getTotalForProperty(propertyId) {
            const instance = await TallyMap.getInstance();
            let totalBalance = new BigNumber(0);

            // Convert propertyId to a string to match stored keys
            const propertyKey = String(propertyId);

            // Iterate over all addresses in tallyMap
            for (const [address, properties] of TallyMap.addresses.entries()) {
                
                if (properties[propertyKey]) {
                    const balance = properties[propertyKey];
                    console.log('property balance '+JSON.stringify(balance))
                    // Ensure all balance components are properly defined
                    const available = new BigNumber(balance.available || 0);
                    const reserved = new BigNumber(balance.reserved || 0);
                    const margin = new BigNumber(balance.margin || 0);
                    const channel = new BigNumber(balance.channelBalance || 0);
                    if (available.isNaN() || reserved.isNaN() || margin.isNaN() || channel.isNaN()) {
                        console.error(`🚨 NaN detected in balance calculation for property ${propertyKey}`, {
                            available: available.toFixed(),
                            reserved: reserved.toFixed(),
                            margin: margin.toFixed(),
                            channel: channel.toFixed(),
                        });
                        continue; // Skip this entry
                    }

                    // Add up all the valid balances
                    totalBalance = totalBalance.plus(available).plus(reserved).plus(margin).plus(channel);
                }
            }

            return totalBalance;
        }

        static calculateTotal(balanceObj) {
            return q8(balanceObj.available)
                .plus(q8(balanceObj.reserved))
                .plus(q8(balanceObj.margin))
                .plus(q8(balanceObj.channelBalance))
                .toNumber();
        }

        static async setInitializationFlag() {
            const db = await dbInstance.getDatabase('tallyMap');
            await db.updateAsync(
                { _id: '$TLinit' },
                { _id: '$TLinit', initialized: true },
                { upsert: true }
            );
        }

    static async checkInitializationFlag() {
            const db = await dbInstance.getDatabase('tallyMap');
            const result = await db.findOneAsync({ _id: '$TLinit' });
            if(result==undefined){return false}
            return result ? result.initialized : false;
        }


    static async getAddressBalances(address) {
            await TallyMap.loadFromDB();

            // Log the serialized form of the data from the DB
            //console.log('Serialized data from DB:', JSON.stringify([...instance.addresses]));

            // Check if the address exists in the map
            if (!TallyMap.addresses.has(address)) {
                console.log(`No data found for address: ${address}`);
                return [];
            }

            const addressObj = TallyMap.addresses.get(address);
            //console.log(`Data for address ${address}:`, addressObj);
            const balances = [];
            for (const propertyId in addressObj) {
                //console.log('bleh' +propertyId+' '+JSON.stringify(addressObj))
                const info = await PropertyList.getPropertyData(propertyId)
                if (Object.hasOwnProperty.call(addressObj, propertyId)) {
                    const balanceObj = addressObj[propertyId];
                    let ticker = ''
                    if(info!=null&&info.ticker){ticker=info.ticker}
                    //console.log(propertyId, JSON.stringify(balanceObj),JSON.stringify(info))
                    balances.push({
                        propertyId: propertyId,
                        ticker: info.ticker,
                        amount: balanceObj.amount,
                        available: balanceObj.available,
                        reserved: balanceObj.reserved,
                        margin: balanceObj.margin,
                        vesting: balanceObj.vesting,
                        channel: balanceObj.channelBalance
                    });
                }
            }
            //console.log(`Balances for address ${address}:`, balances);
            return balances;
    }

      /**
     * Retrieves the total tally for a given property ID across all addresses.
     * @param {number|string} propertyId - The property ID to aggregate balances for.
     * @returns {Promise<Object>} - An object representing the total tally for the given property.
     */
    static async getTotalTally(propertyId) {
        const instance = await TallyMap.getInstance();
        const totalTally = {
            amount: new BigNumber(0),
            available: new BigNumber(0),
            reserved: new BigNumber(0),
            margin: new BigNumber(0),
            vesting: new BigNumber(0),
            channelBalance: new BigNumber(0)
        };

        for (const properties of TallyMap.addresses.values()) {
            if (properties[propertyId]) {
                totalTally.amount = totalTally.amount.plus(properties[propertyId].amount || 0);
                totalTally.available = totalTally.available.plus(properties[propertyId].available || 0);
                totalTally.reserved = totalTally.reserved.plus(properties[propertyId].reserved || 0);
                totalTally.margin = totalTally.margin.plus(properties[propertyId].margin || 0);
                totalTally.vesting = totalTally.vesting.plus(properties[propertyId].vesting || 0);
                totalTally.channelBalance = totalTally.channelBalance.plus(properties[propertyId].channelBalance || 0);
            }
        }

        return {
            amount: q8(totalTally.amount).toNumber(),
            available: q8(totalTally.available).toNumber(),
            reserved: q8(totalTally.reserved).toNumber(),
            margin: q8(totalTally.margin).toNumber(),
            vesting: q8(totalTally.vesting).toNumber(),
            channelBalance: q8(totalTally.channelBalance).toNumber()
        };
    }

    /**
     * Checks if a sender has a sufficient balance of a specific property.
     * @param {string} senderAddress - The address of the sender.
     * @param {number} propertyId - The ID of the property to check.
     * @param {number} requiredAmount - The amount required for the transaction.
     * @returns {Promise<{hasSufficient: boolean, reason: string}>} - An object indicating if the balance is sufficient and a reason if it's not.
     */
    static async hasSufficientBalance(senderAddress, propertyId, requiredAmount) {
        try {
            const senderTally = await this.getTally(senderAddress, propertyId);
            console.log('Checking senderTally in has hasSufficientBalance', senderAddress, propertyId, requiredAmount, JSON.stringify(senderTally));

            if(!senderTally || senderTally.available === undefined||senderTally==0){
                return { hasSufficient: false, reason: 'undefined', shortfall: requiredAmount };
            }

            //console.log('Available tokens:', senderTally.available, 'Required amount:', requiredAmount);
            if(senderTally.available < requiredAmount){
                const availBN = new BigNumber(senderTally.available)
                const shortfall = new BigNumber(requiredAmount).minus(availBN).decimalPlaces(8).toNumber()
                console.log('shortfall calc '+requiredAmount+' '+senderTally.available+' '+shortfall)
                return { hasSufficient: false, reason: 'Insufficient available balance', shortfall:shortfall, available:senderTally.available };
            }

            return { hasSufficient: true, reason: '' };
        } catch (error) {
            console.error('Error in hasSufficientBalance:', error);
            return { hasSufficient: false, reason: 'Unexpected error checking balance' };
        }
    }

    static async hasSufficientReserve(senderAddress, propertyId, requiredAmount) {
        try {
            const senderTally = await this.getTally(senderAddress, propertyId);
            console.log('Checking senderTally in has hasSufficientReserve', senderAddress, propertyId, requiredAmount, JSON.stringify(senderTally));

            if (!senderTally || senderTally.reserved === undefined) {
                return { hasSufficient: false, reason: 'undefined', shortfall: requiredAmount };
            }

            console.log('Reserve tokens:', senderTally.reserved, 'Required amount:', requiredAmount);

            if (senderTally.reserved < requiredAmount) {
                let requiredBN = new BigNumber(requiredAmount)
                let reservedBN = new BigNumber(senderTally.reserved)
                let shortfall= requiredBN.minus(reservedBN).toNumber()
                console.log('insufficient tokens ' +shortfall)
                return { hasSufficient: false, reason: 'Insufficient available balance', shortfall: shortfall };
            }

            return { hasSufficient: true, reason: '' };
        } catch (error) {
            console.error('Error in hasSufficientBalance:', error);
            return { hasSufficient: false, reason: 'Unexpected error checking balance' };
        }
    }

    static async hasSufficientMargin(senderAddress, propertyId, requiredAmount) {
        try {
            const senderTally = await this.getTally(senderAddress, propertyId);
            console.log('Checking senderTally in has hasSufficientMargin', senderAddress, propertyId, requiredAmount, JSON.stringify(senderTally));

            if (!senderTally || senderTally.margin === undefined) {
                return { hasSufficient: false, reason: 'undefined', shortfall: requiredAmount };
            }

            console.log('Margin tokens:', senderTally.margin, 'Required amount:', requiredAmount);

            if (senderTally.margin < requiredAmount) {
                let requiredBN = new BigNumber(requiredAmount)
                let marginBN = new BigNumber(senderTally.margin)
                let shortfall= requiredBN.minus(marginBN).toNumber()
                console.log('insufficient tokens ' +shortfall)
                return { hasSufficient: false, reason: 'Insufficient available balance', shortfall: shortfall };
            }

            return { hasSufficient: true, reason: '' };
        } catch (error) {
            console.error('Error in hasSufficientBalance:', error);
            return { hasSufficient: false, reason: 'Unexpected error checking balance' };
        }
    }    

    static async hasSufficientChannel(senderAddress, propertyId, requiredAmount) {
        try {
            const senderTally = await this.getTally(senderAddress, propertyId);
            console.log('Checking senderTally in has hasSufficientChannel', senderAddress, propertyId, requiredAmount, JSON.stringify(senderTally));

            if (!senderTally || senderTally.channel === undefined) {
                return { hasSufficient: false, reason: 'undefined' };
            }

            console.log('Channel tokens:', senderTally.channel, 'Required amount:', requiredAmount);

            if (senderTally.channel < requiredAmount) {
                let requiredBN = new BigNumber(requiredAmount)
                let channelBN = new BigNumber(senderTally.channel)
                let shortfall= requiredBN.minus(channelBN).toNumber()
                console.log('insufficient tokens ' +shortfall)
                return { hasSufficient: false, reason: 'Insufficient available balance', shortfall: shortfall };
            }

            return { hasSufficient: true, reason: '' };
        } catch (error) {
            console.error('Error in hasSufficientBalance:', error);
            return { hasSufficient: false, reason: 'Unexpected error checking balance' };
        }
    }

    static async saveToDB(block) {
        try {
            const db = await dbInstance.getDatabase('tallyMap');
            const serializedData = JSON.stringify([...this.addresses]);
            console.log('saving tallymap')
            // Use upsert option
            await db.updateAsync({ _id: 'tallyMap' }, { $set: {block: block, data: serializedData } }, { upsert: true });
            //console.log('TallyMap saved successfully.');
        } catch (error) {
            console.error('Error saving TallyMap:', error);
        }
    }

    static async loadFromDB() {
        try {
            const query = { _id: 'tallyMap' };
            const db = await dbInstance.getDatabase('tallyMap')
            const result = await db.findOneAsync(query);

            if (result && result.data) {
                // Deserialize the data from a JSON string to an array
                const mapDataArray = JSON.parse(result.data);
                 // Convert the array back into a Map
                this.addresses = new Map(mapDataArray.map(([key, value]) => [key, value]));
                return this.addresses
            } else {
                console.log('failed to load tallyMap, starting a new map')
                return this.addresses = new Map(); // Ensure addresses is always a Map
            }
        } catch (error) {
            console.error('Error loading tally map from dbInstance:', error);
        }
    }

   static async saveFeeCacheToDB(propertyId, feeAmount, contractid) {
        if (propertyId === undefined || feeAmount === undefined) {
            console.error('Property ID or fee amount is undefined.');
            return;
        }
        console.log('Inside save fee cache ' + propertyId + ' ' + feeAmount);
        const db = await dbInstance.getDatabase('feeCache');
        try {
           const roundedFee = Number(new BigNumber(feeAmount).toFixed(8));  // ✅ Ensures max 8 decimal places
            const serializedFeeAmount = roundedFee
            // Convert propertyId to a string if it's not already a string
            const cacheId = String(propertyId)+String(contractid);

            await db.updateAsync(
                { _id: cacheId }, // Query to find the document
                { $set: { value: serializedFeeAmount, contract: contractid } }, // Update the value field
                { upsert: true } // Insert a new document if it doesn't exist
            );
            console.log('FeeCache for property ' + propertyId + ' saved successfully.');
        } catch (error) {
            console.error('Error saving FeeCache:', error);
        }
    }

    static async loadFeeCacheFromDB() {
        let fees = new Map();

        try {
            const db = await dbInstance.getDatabase('feeCache');
            const results = await db.findAsync({});

            if (!results || results.length === 0) {
                //console.log("⚠️ No fee cache entries found.");
                return fees;
            }

            //console.log(`✅ Loaded ${results.length} fee cache entries.`);

            for (let result of results) {
                //console.log(`📝 DB Entry: ${JSON.stringify(result)}`);

                if (!result._id) {
                    console.warn(`⚠️ Skipping malformed entry (missing _id): ${JSON.stringify(result)}`);
                    continue;
                }

                if (typeof result.value === "undefined") {
                    continue;
                }
                if(!result.stash){result.stash=0}
                let feeData = {
                    value: parseFloat(result.value), // ✅ Ensure value is a number
                    contract: result.contract || null,
                    stash: parseFloat(result.stash)
                };

                //console.log(`🔹 Fee Cache Parsed - Key: ${result._id}, Value: ${feeData.value}, Contract: ${feeData.contract}`);

                fees.set(result._id, feeData);
            }
        } catch (error) {
            console.error(`🚨 Error loading fee cache:`, error);
        }

        return fees;
    }

    static async loadFeeCacheForProperty(id) {
        try {
            const db = await dbInstance.getDatabase('feeCache');
            const result = await db.findAsync({});
            console.log('📄 Database contents:', JSON.stringify(result, null, 2));

            let total = new BigNumber(0);

            for(const doc of result){
                if (doc._id.startsWith(`${id}-`)) {
                    const value = new BigNumber(doc.value || 0);
                    const stash = new BigNumber(doc.stash || 0);
                    total = total.plus(value).plus(stash);
                    console.log(`➕ Matched ${doc._id}: value=${value.toFixed()}, stash=${stash.toFixed()}, running total=${total.toFixed()}`);
                }
            }

            console.log(`✅ FeeCache total for property ${id}: ${total.toFixed()}`);
            return total;
        } catch (error) {
            console.error('❌ Error loading fee cache from dbInstance:', error);
            return new BigNumber(0);
        }
    }


        static async loadTallyBlobDirect() {
            try {
                const dbInstance = require('./db.js')
                const db = await dbInstance.getDatabase('tallyMap');
                const result = await db.findOneAsync({ _id: 'tallyMap' });

                if (!result) {
                    console.log("[TALLY] No tallyMap found in DB.");
                    return null;
                }

                // result = { _id, block, data: "JSON_STRING" }
                return result;

            } catch (err) {
                console.error("[TALLY] Error loading tally map:", err);
                return null;
            }
        }

    // Method to update fee cache for a property
    // tally.js

    static async resolveBlock(explicitBlock) {
      if (explicitBlock !== undefined && explicitBlock !== null) return explicitBlock;
      try {
        const consensus = await dbInstance.getDatabase('consensus');
        const t = await consensus.findOneAsync({ _id: 'TrackHeight' });
        const m = await consensus.findOneAsync({ _id: 'MaxProcessedHeight' });
        return (t && t.value) || (m && m.value) || null;
      } catch { return null; }
    }

    static async loadFeeRow(db, cacheId) {
      const row = await db.findOneAsync({ _id: cacheId });
      return {
        value: new BigNumber(row ? row.value || 0 : 0),
        stash: new BigNumber(row ? row.stash || 0 : 0),
        contract: row ? row.contract : undefined,
      };
    }
    static async saveFeeRow(db, cacheId, { value, stash, contract }) {
      await db.updateAsync(
        { _id: cacheId },
        {
          $set: {
            value: new BigNumber(value).decimalPlaces(8).toNumber(),
            stash: new BigNumber(stash).decimalPlaces(8).toNumber(),
            contract: contract,
          },
        },
        { upsert: true }
      );
    }

    static getFeeAccrualBuffer() {
      if (!this._feeAccrualBuffer) this._feeAccrualBuffer = new Map();
      return this._feeAccrualBuffer;
    }

    static async queueFeeAccrual(propertyId, amount, contractId, block) {
      const resolved = await TallyMap.resolveBlock(block);
      if (resolved == null || Number.isNaN(Number(resolved))) {
        return await TallyMap.accrueFee(propertyId, amount, contractId, block);
      }

      const blockKey = String(resolved);
      const effContractId = (contractId === null || contractId === undefined) ? "1" : String(contractId);
      const key = `${propertyId}-${effContractId}`;
      const amountBN = new BigNumber(amount || 0).decimalPlaces(8);
      if (amountBN.lte(0)) return;

      const buffer = this.getFeeAccrualBuffer();
      let byBlock = buffer.get(blockKey);
      if (!byBlock) {
        byBlock = new Map();
        buffer.set(blockKey, byBlock);
      }

      const prev = byBlock.get(key);
      if (!prev) {
        byBlock.set(key, { propertyId, contractId: effContractId, amount: amountBN });
      } else {
        prev.amount = prev.amount.plus(amountBN).decimalPlaces(8);
        byBlock.set(key, prev);
      }
    }

    static async flushQueuedFeeAccruals(block) {
      const resolved = await TallyMap.resolveBlock(block);
      const blockKey = String(resolved);
      const buffer = this.getFeeAccrualBuffer();
      const byBlock = buffer.get(blockKey);
      if (!byBlock || byBlock.size === 0) return;

      for (const [, entry] of byBlock.entries()) {
        await TallyMap.accrueFee(
          entry.propertyId,
          entry.amount.toNumber(),
          entry.contractId,
          resolved
        );
      }
      buffer.delete(blockKey);
    }

    static async flushAllQueuedFeeAccruals() {
      const buffer = this.getFeeAccrualBuffer();
      const blocks = Array.from(buffer.keys()).sort((a, b) => Number(a) - Number(b));
      for (const block of blocks) {
        await TallyMap.flushQueuedFeeAccruals(Number(block));
      }
    }

     /*
     * updateFeeCache with full tracing:
     * - Logs every decision point: spot, TL-spot, derivative, oracle/non-oracle.
     * - Logs sat math: raw, rounded, half-split, dust.
     * - Logs stash/insurance writes with exact integer sats.
     */static async updateFeeCache(propertyId, amount, contractId, block) {
    const blockArg = arguments.length >= 6 ? arguments[5] : block;
    // Canonical fee routing lives in accrueFee; queue by block to reduce feeCache write pressure.
    return await TallyMap.queueFeeAccrual(propertyId, amount, contractId, blockArg);

    try {
        console.log(`\n====== updateFeeCache() @ block ${blockArg} ======`);
        console.log(`INPUT propertyId=${propertyId}, amount=${amount}, contractId=${contractId}`);

        // Convert → sats
        let rawSats = toSatsDecimal(amount);
        console.log(`rawSats (pre-floor) = ${rawSats.toString()}`);

        rawSats = rawSats.integerValue(BigNumber.ROUND_FLOOR);
        console.log(`rawSats (floored sats) = ${rawSats.toString()}`);

        // Require even sats (should happen automatically from calculateFee)
        let feeSats = rawSats;

        console.log(`feeSats (final even sats) = ${feeSats.toString()}`);

        if (feeSats.lte(0)) {
            console.log(`EXIT: feeSats <= 0`);
            return;
        }

        const db  = await dbInstance.getDatabase('feeCache');
        const blk = await TallyMap.resolveBlock(blockArg);
        const effContractId = (contractId == null) ? '1' : String(contractId);

        const isOracleContract = await ContractRegistry.isOracleContract(contractId);
        console.log(`Resolved: effContractId=${effContractId}, isOracle=${isOracleContract}`);

        //
        // 1) SPOT NON-TL
        //
        if (effContractId === '1' && propertyId != 1) {
            const cacheId = `${propertyId}-1`;
            console.log(`SPOT NON-TL route → stash only → cacheId=${cacheId}`);

            const row0 = await TallyMap.loadFeeRow(db, cacheId);
            console.log(`Pre-stash row: stash=${row0.stash.toString()}`);

            const addTokens = fromSats(feeSats);
            console.log(`Adding to stash: +${addTokens.toString()} tokens`);

            await TallyMap.saveFeeRow(db, cacheId, {
                stash: row0.stash.plus(addTokens),
                contract: '1'
            });

            const row1 = await TallyMap.loadFeeRow(db, cacheId);
            console.log(`Post-stash row: stash=${row1.stash.toString()}`);

            console.log(`→ running buyback`);
            return await TallyMap.feeCacheBuy(blockArg);
        }

        //
        // 2) SPOT TL-TOKEN (propertyId==1)
        //
        if (effContractId === '1' && propertyId == 1) {
            console.log(`SPOT TL route → 100% to insurance`);

            const insurance = await getInsuranceModule().getInstance(effContractId, false);

            console.log(`insurance.deposit: +${fromSats(feeSats).toFixed(8)} (LTC)`);
            await insurance.deposit(propertyId, fromSats(feeSats).toFixed(8), blk);

            return;
        }

        //
        // 3) DERIVATIVES
        //
        console.log(`DERIVATIVES route (contract!=1)`);

        const insuranceSats = feeSats.idiv(2);      // floor
        const stashSats     = feeSats.minus(insuranceSats); 

        console.log(`50/50 split: insuranceSats=${insuranceSats}, stashSats=${stashSats}`);

        if (!insuranceSats.plus(stashSats).eq(feeSats)) {
            console.log(`⚠ Split mismatch (summing glitch), fixing stash = fee-insurance`);
            stashSats = stashSats.minus(1);
        }

        //
        // Insurance write
        //
        try {
            console.log(`Insurance deposit: contract=${effContractId}, isOracle=${isOracleContract}`);
            console.log(`insurance.deposit: +${fromSats(insuranceSats).toFixed(8)} (LTC)`);

            const insurance = await getInsuranceModule().getInstance(effContractId, isOracleContract);

            await insurance.deposit(
                propertyId,
                fromSats(insuranceSats).toFixed(8),
                blk
            );
        } catch (e) {
            console.error(`❌ Insurance deposit ERROR for contract ${effContractId}:`, e);
        }

        //
        // Stash write
        //
        const cacheId = `${propertyId}-${effContractId}`;
        console.log(`Stash write → cacheId=${cacheId}`);

        const stashRow0 = await TallyMap.loadFeeRow(db, cacheId);
        console.log(`Pre-stash stash=${stashRow0.stash.toString()}`);

        await TallyMap.saveFeeRow(db, cacheId, {
            stash: stashRow0.stash.plus(fromSats(stashSats)),
            contract: effContractId
        });

        const stashRow1 = await TallyMap.loadFeeRow(db, cacheId);
        console.log(`Post-stash stash=${stashRow1.stash.toString()}`);

        //
        // 4) Buyback
        //
        console.log(`→ running buyback`);
        const ret = await TallyMap.feeCacheBuy(blockArg);

        console.log(`====== END updateFeeCache() @ block ${blockArg} ======\n`);
        return ret;

    } catch (e) {
        console.error('🚨 Error in updateFeeCache:', e);
    }
}


     static async feeCacheBuy(block) {
          const fees = await TallyMap.loadFeeCacheFromDB();
          if (!fees || fees.size === 0) return;

          for (const [key, feeData] of fees.entries()) {
            if (!feeData || !feeData.contract) continue;

            const [property, contractId] = key.split('-');
            const value = new BigNumber(feeData.value || 0);
            const stash = new BigNumber(feeData.stash || 0);
            const total = value.plus(stash);
            if (total.lte(0)) continue;

            const orderBookKey = `1-${property}`;
            const orderbook = await Orderbooks.getOrderbookInstance(orderBookKey);
            const ob = orderbook.orderBooks[orderBookKey] || { buy: [], sell: [] };
            const hasSell = Array.isArray(ob.sell) && ob.sell.length > 0;

            if (!hasSell) continue; // nothing to do this block

            // Place a single buy using total (value + stash)
            const order = {
              offeredPropertyId: property,
              desiredPropertyId: 1,
              amountOffered: total.toNumber(),
              amountExpected: 0.00000001,
              blockTime: block,
              sender: 'feeCache',
            };
            order.price = orderbook.calculatePrice(order.amountOffered, order.amountExpected);

            const reply = await orderbook.insertOrder(order, orderBookKey, false, false);

            // Pre-deduct: set value→0 and spend all stash
            if (value.gt(0)) await TallyMap.adjustFeeCache(property, contractId, { valueDelta: value.negated() });
            if (stash.gt(0)) await TallyMap.adjustFeeCache(property, contractId, { stashDelta: stash.negated() });

            const matchResult = await orderbook.matchTokenOrders(reply);
            if (matchResult.matches && matchResult.matches.length > 0) {
              await orderbook.processTokenMatches(matchResult.matches, block, null, false);
            } else {
              // restore back to stash if no matches (race)
              if (value.gt(0)) await TallyMap.adjustFeeCache(property, contractId, { stashDelta: value });
              if (stash.gt(0)) await TallyMap.adjustFeeCache(property, contractId, { stashDelta: stash });
            }

            await orderbook.saveOrderBook(orderBookKey);
          }
        }



    /**
     * accrueFee:
     * - SPOT (contractId null/undefined):
     *    - propertyId != 1: 100% to VALUE cache (awaits buyback path before insurance accounting).
     *    - propertyId == 1: 50/50 split in sats -> insurance now + stash (tail-emission pool).
     * - CONTRACT:
     *    - Native -> 100% to VALUE (no insurance now).
     *    - Oracle  -> 50/50 split in integer sats → half Insurance NOW, half -> STASH.
     * - All rounding remainders funnel into dust and later pay to Insurance.
     */
    static async accrueFee(propertyId, amount, contractId, block) {
      const db = await dbInstance.getDatabase('feeCache');

      // Work in sats
      const rawSats = toSatsDecimal(amount);
      const feeSats = rawSats.integerValue(RD);
      if (feeSats.lte(0)) return;

      const isSpot = (contractId === null || contractId === undefined);
      const effContractId = isSpot ? '1' : String(contractId);
      const cacheId = `${propertyId}-${effContractId}`;
      const dustKey = cacheId;
      const blk = await TallyMap.resolveBlock(block);

      // Accumulate conversion dust
      const convDust = rawSats.minus(feeSats); // [0,1)
      await _accumulateDust(db, dustKey, convDust, async ({ wholeSats }) => {
        const isSpotNonOne = isSpot && String(propertyId) !== '1';
        const isSpotOne = isSpot && String(propertyId) === '1';
        if (isSpotNonOne) {
          // Keep non-1 spot dust in cache until buyback conversion occurs.
          const dustRow = await TallyMap.loadFeeRow(db, cacheId);
          await TallyMap.saveFeeRow(db, cacheId, {
            value: dustRow.value.plus(fromSats(wholeSats)),
            stash: dustRow.stash,
            contract: '1',
          });
          return;
        }
        if (isSpotOne) {
          // Property 1 dust follows tail-emission split: 50% insurance, 50% stash.
          const insuranceSats = wholeSats.idiv(2);
          const stashSats = wholeSats.minus(insuranceSats);
          if (insuranceSats.gt(0)) {
            const insurance = await getInsuranceModule().getInstance('1', false);
            await insurance.deposit('1', fromSats(insuranceSats).toFixed(8), blk);
          }
          if (stashSats.gt(0)) {
            const dustRow = await TallyMap.loadFeeRow(db, cacheId);
            await TallyMap.saveFeeRow(db, cacheId, {
              value: dustRow.value,
              stash: dustRow.stash.plus(fromSats(stashSats)),
              contract: '1',
            });
          }
          return;
        }
        const insurance = await getInsuranceModule().getInstance(effContractId, effContractId !== '1');
        await insurance.deposit(propertyId, fromSats(wholeSats).toNumber(), blk);
      });

      const row = await TallyMap.loadFeeRow(db, cacheId);

      if (isSpot) {
        const isPropertyOne = String(propertyId) === '1';
        if (!isPropertyOne) {
          // Non-1 spot fees stay in cache until orderbook buyback converts them into property 1.
          await TallyMap.saveFeeRow(db, cacheId, {
            value: row.value.plus(fromSats(feeSats)),
            stash: row.stash,
            contract: '1',
          });
          return;
        }

        // Property 1 fee is split 50/50 between insurance and tail-emission stash.
        try {
          const ins = await getInsuranceModule().getInstance('1', false);
          const insuranceSats = feeSats.idiv(2);
          const stashSats = feeSats.minus(insuranceSats);
          if (insuranceSats.gt(0)) {
            await ins.deposit('1', fromSats(insuranceSats).toFixed(8), blk);
          }
          if (stashSats.gt(0)) {
            await TallyMap.saveFeeRow(db, cacheId, {
              value: row.value,
              stash: row.stash.plus(fromSats(stashSats)),
              contract: '1',
            });
          }
        } catch (e) {
          console.error('❌ Spot fee insurance deposit failed:', e);
        }
        return;
      }

      // Contract path
      const isNative = await ContractRegistry.isNativeContract(effContractId).catch(() => false);
      if (!isNative) {
        // ORACLE: half to insurance now, exact remainder to STASH
        const insuranceSats = feeSats.idiv(2);
        const stashSats     = feeSats.minus(insuranceSats);

        try {
          const ins = await getInsuranceModule().getInstance(effContractId, true);
          await ins.deposit(propertyId, fromSats(insuranceSats).toNumber(), blk);
        } catch (e) {
          console.error(`❌ Insurance deposit failed for contract ${effContractId}:`, e);
        }

        await TallyMap.saveFeeRow(db, cacheId, {
          value: row.value,
          stash: row.stash.plus(fromSats(stashSats)),
          contract: effContractId,
        });
        return;
      }

      // NATIVE: 100% to VALUE
      await TallyMap.saveFeeRow(db, cacheId, {
        value: row.value.plus(fromSats(feeSats)),
        stash: row.stash,
        contract: effContractId,
      });
    }
    /**
     * NEW: adjustFeeCache(propertyId, contractId, { valueDelta?, stashDelta? })
     * - Used by clearing to spend from VALUE/STASH when matching.
     */
    static async adjustFeeCache(propertyId, contractId, deltas) {
      const db = await dbInstance.getDatabase('feeCache');
      const effectiveContractId = (contractId === null || contractId === undefined) ? '1' : String(contractId);
      const cacheId = `${propertyId}-${effectiveContractId}`;
      const row = await TallyMap.loadFeeRow(db, cacheId);

      const valueDelta = new BigNumber(deltas?.valueDelta || 0).decimalPlaces(8);
      const stashDelta = new BigNumber(deltas?.stashDelta || 0).decimalPlaces(8);

      await TallyMap.saveFeeRow(db, cacheId, {
        value: row.value.plus(valueDelta),
        stash: row.stash.plus(stashDelta),
        contract: effectiveContractId,
      });
    }

    // ---------- 4) drawOnFeeCache (compat shim; pull from VALUE/STASH) ----------
    /**
     * drawOnFeeCache(propertyId, contractId='1', opts?)
     * - Minimal compat: withdraw up to `opts.max` from VALUE first (then STASH if allowStash).
     * - Returns { spent } in token units (8 d.p.).
     */
    static async drawOnFeeCache(propertyId, contractId = '1', opts = {}) {
      const { max = null, allowStash = false } = opts;
      const db = await dbInstance.getDatabase('feeCache');
      const effContractId = (contractId == null) ? '1' : String(contractId);
      const cacheId = `${propertyId}-${effContractId}`;
      const row = await TallyMap.loadFeeRow(db, cacheId);

      const want = (max == null) ? row.value : BigNumber.min(new BigNumber(max), row.value);
      if (want.lte(0)) {
        if (!allowStash) return { spent: new BigNumber(0) };
        const wantFromStash = (max == null) ? row.stash : BigNumber.min(new BigNumber(max), row.stash);
        if (wantFromStash.lte(0)) return { spent: new BigNumber(0) };

        // spend from STASH (sat-accurate)
        const raw = toSatsDecimal(wantFromStash);
        const sats = raw.integerValue(RD);
        const spent = fromSats(sats);

        await _accumulateDust(db, `adj:${cacheId}:stash`, raw.minus(sats), async ({ wholeSats }) => {
          const r = await TallyMap.loadFeeRow(db, cacheId);
          await TallyMap.saveFeeRow(db, cacheId, {
            value: r.value,
            stash: r.stash.plus(fromSats(wholeSats)),
            contract: effContractId,
          });
        });

        await TallyMap.saveFeeRow(db, cacheId, {
          value: row.value,
          stash: row.stash.minus(spent),
          contract: effContractId,
        });
        return { spent };
      }

      // spend from VALUE
      const raw = toSatsDecimal(want);
      const sats = raw.integerValue(RD);
      const spent = fromSats(sats);

      await _accumulateDust(db, `adj:${cacheId}:value`, raw.minus(sats), async ({ wholeSats }) => {
        const r = await TallyMap.loadFeeRow(db, cacheId);
        await TallyMap.saveFeeRow(db, cacheId, {
          value: r.value.plus(fromSats(wholeSats)),
          stash: r.stash,
          contract: effContractId,
        });
      });

      await TallyMap.saveFeeRow(db, cacheId, {
        value: row.value.minus(spent),
        stash: row.stash,
        contract: effContractId,
      });
      return { spent };
    }

    async applyDeltasSinceLastHeight(lastHeight) {
        // Retrieve and apply all deltas from lastHeight to the current height
        for (let height = lastHeight + 1; height <= currentBlockHeight; height++) {
            const serializedDelta = await dbInstance.get(`tallyMapDelta-${height}`);
            if (serializedDelta) {
                const delta = JSON.parse(serializedDelta);
                this.applyDelta(delta);
            }
        }
    }

    // Function to record a delta
    static async recordTallyMapDelta(address, block, propertyId, total, availableChange, reservedChange, marginChange, vestingChange, channelChange, type,txid){
        const newUuid = uuid.v4();
        const db = await dbInstance.getDatabase('tallyMapDelta');
        let deltaKey = `${address}-${propertyId}-${newUuid}`;
        deltaKey+='-'+block
        const tally = TallyMap.getTally(address, propertyId)
        if(!txid){txid=''}
        total = q8(tally.available).plus(tally.reserved).plus(tally.margin).plus(tally.channel).plus(tally.vesting).toNumber()
        const delta = { address, block, property: propertyId, total: total, avail: availableChange, res: reservedChange, mar: marginChange, vest: vestingChange, channel: channelChange, type, tx: txid };
        
        console.log('saving delta ' + JSON.stringify(delta));

        try {
            // Try to find an existing document based on the key
            const existingDocument = await db.findOneAsync({ _id: deltaKey });

            if (existingDocument) {
                // If the document exists, update it
                await db.updateAsync({ _id: deltaKey }, { $set: { data: delta } });
            } else {
                // If the document doesn't exist, insert a new one
                await db.insertAsync({ _id: deltaKey, data: delta });
            }
            TallyMap.setModFlag(true)

            return; // Return success or handle as needed
        } catch (error) {
            console.error('Error saving delta:', error);
            throw error; // Rethrow the error or handle as needed
        }
    }

    static async didReceiveClearingProfitThisBlock(address, blockHeight) {
        const db = await dbInstance.getDatabase('tallyMapDelta');

        return new Promise((resolve, reject) => {
            db.find(
                {
                    "data.address": address,
                    "data.block": blockHeight
                },
                (err, docs) => {
                    if (err) return reject(err);

                    const hasClearing = docs.some(doc =>
                        (doc.data.type === 'clearing')
                    );

                    resolve(hasClearing);
                }
            );
        });
    }

// Function to apply a delta to the TallyMap
    applyDeltaToTallyMap(delta) {
        const { address, propertyId, amountChange } = delta;
        // Logic to apply the change to TallyMap
        TallyMap.updateBalance(address, propertyId, amountChange);
    }

    async saveDeltaTodbInstance(blockHeight, delta) {
        const serializedDelta = JSON.stringify(delta);
        await dbInstance.getDatabase('tallyMap').insert(`tallyMapDelta-${blockHeight}`, serializedDelta);
    }

    // Function to save the aggregated block delta
    async saveBlockDelta(blockHeight, blockDelta) {
        const deltaKey = `blockDelta-${blockHeight}`;
        await dbInstance.getDatabase('tallyMap').insert(deltaKey, JSON.stringify(blockDelta));
    }

    // Function to load all deltas for a block
    async loadDeltasForBlock(blockHeight) {
        // Load and parse all deltas from the database for the given block height
    }

    totalTokens(propertyId) {
        let total = 0;
        for (const addressObj of this.addresses.values()) {
            if (addressObj[propertyId]) {
                total += addressObj[propertyId].available + addressObj[propertyId].reserved;
            }
        }
        return total;
    }
    // Get the tally for a specific address and property
    static async getTally(address, propertyId) {
        await TallyMap.loadFromDB(); // Ensure instance is loaded
        if (!TallyMap.addresses.has(address)) {
            console.log("can't find address in tallyMap")
            return 0;
        }
        const addressObj = TallyMap.addresses.get(address);
        console.log('inside getTally '+propertyId+' '+JSON.stringify(addressObj))
        if (!addressObj[propertyId]) {
            console.log("can't find property in address "+address+propertyId+ ' '+JSON.stringify(addressObj) )
            return 0;
        }

        const returnObj = {amount: addressObj[propertyId].amount, 
            available: addressObj[propertyId].available, 
            reserved: addressObj[propertyId].reserved, 
            margin: addressObj[propertyId].margin, 
            vesting:addressObj[propertyId].vesting,
            channel: addressObj[propertyId].channelBalance}

            console.log('return obj '+address+' '+JSON.stringify(returnObj))

        return returnObj
    }

    getAddressBalances(address) {
        //console.log('ze tally map'+this.addresses)
        const balances = [];
        if (this.addresses.has(address)) {
            const properties = this.addresses.get(address);
            for (const [propertyId, balanceData] of Object.entries(properties)) {
                balances.push({
                    propertyId: propertyId,
                    balance: balanceData
                });
            }
        }
        return balances;
    }

    /**
     * Retrieves all addresses that have a balance for a given property.
     * @param {number} propertyId - The property ID to check balances for.
     * @return {Array} - An array of addresses that have a balance for the specified property.
     */
    static async getAddressesWithBalanceForProperty(propertyId) {
            const addressesWithBalances = [];

            try {
                // Get the tallyMap document
                const tallyMapDoc = await dbInstance.getDatabase('tallyMap').findOneAsync({ _id: 'tallyMap' });

                // Ensure we got the document and the data field exists
                if (!tallyMapDoc || !tallyMapDoc.data) {
                    console.error('No tallyMap document found or data is missing');
                    return addressesWithBalances;
                }

                // Parse the stringified data into a usable array
                const parsedData = JSON.parse(tallyMapDoc.data);

                // Iterate over the parsed data and find addresses with the specified propertyId
                for (const [address, balances] of parsedData) {
                    if (balances[propertyId]) {
                        const balanceInfo = balances[propertyId];
                        if (balanceInfo.available > 0 || balanceInfo.vesting > 0) {
                            addressesWithBalances.push({
                                address: address,
                                available: balanceInfo.available,
                                reserved: balanceInfo.reserved,
                                margin: balanceInfo.margin,
                                vesting: balanceInfo.vesting,
                                channelBalance: balanceInfo.channelBalance
                            });
                        }
                    }
                }

                console.log('Found addresses for property', propertyId, addressesWithBalances);
            } catch (error) {
                console.error('Error querying addresses with balance for propertyId:', propertyId, error);
            }

            return addressesWithBalances;
        }

    static async applyVesting(propertyId, vestingAmount, block) {
        console.log('insideApply vesting '+vestingAmount)
        if(vestingAmount<1e-8){return}
        // Get the list of addresses with balances for the given propertyId
        const addressesWithBalances = await this.getAddressesWithBalanceForProperty(propertyId);
        const propertyInfo = await PropertyList.getPropertyData(propertyId)
        // Retrieve the total number of tokens for the propertyId from the propertyList
        const totalTokens = propertyInfo.totalInCirculation;
        vestingAmount = new BigNumber(vestingAmount)
        // Iterate over each address to apply the vesting amount
        for (const { address, available, reserved, margin, vesting, channelBalance } of addressesWithBalances) {
            console.log(JSON.stringify(addressesWithBalances))
            console.log('inside apply vesting '+address+' '+available+' '+vesting+' '+totalTokens)
            // Calculate the total balance for this address (amount + reserved)
            const totalBalanceForAddress = new BigNumber(available);

            // Calculate the percentage this balance represents of the total tokens
            const percentageOfTotalTokens = totalBalanceForAddress.dividedBy(totalTokens);
            console.log('percentage '+percentageOfTotalTokens, vestingAmount)
            // Apply the vesting amount proportionally to this address
            const vestingShare = vestingAmount.multipliedBy(percentageOfTotalTokens);
            console.log(vestingAmount)
            console.log(vestingShare.toNumber()+' '+totalBalanceForAddress+' '+percentageOfTotalTokens)
            // Depending on propertyId, apply the vesting rules:
            if (propertyId === 2) {
                // Move tokens from vesting in propertyId 2 to available in propertyId 1
                await this.updateBalance(
                    address, 2, 0, 0, 0, vestingShare.negated().toNumber(), 'vestingDebit', block // Debit vesting from propertyId 2
                );
                await this.updateBalance(
                    address, 1, vestingShare.toNumber(), 0, 0, 0, 'vestingCredit', block // Credit available in propertyId 1
                );
            } else if (propertyId === 3) {
                // Move tokens from vesting in propertyId 3 to available in propertyId 4
                await this.updateBalance(
                    address, 3, 0, 0, 0, vestingShare.negated().toNumber(), 'vestingDebit', block // Debit vesting from propertyId 3
                );
                await this.updateBalance(
                    address, 4, vestingShare.toNumber(), 0, 0, 0, 'vestingCredit', block // Credit available in propertyId 4
                );
            }
        }
        return
    }
}

module.exports = TallyMap;
