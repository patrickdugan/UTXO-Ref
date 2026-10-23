const fetch = require('node-fetch'); // For HTTP requests (e.g., price lookups)
const db = require('./db.js')
const Litecoin = require('litecoin')
const util = require('util')
const Contracts = require('./contractRegistry.js')
const BigNumber = require('bignumber.js');

class VolumeIndex {
    constructor(db) {
        // Initialize data structures and database path
        this.pairVolumes = {};
        this.pairFees = {};
        this.tokenPairCumulativeVolumes = 0;
        this.ltcPairTotalVolume = 0;
        this.contractCumulativeVolumes = 0;
        this.cumulativeFees = 0;
        this.dbPath = dbPath;
        this.VWAPIndex = new Map()
    }

    static async saveVolumeDataById(id, rawVolume,ltcVolume, price,blockHeight, type) {
        console.log('saving volume index data '+id, typeof id, rawVolume, ltcVolume, price, blockHeight, type)
        const base = await db.getDatabase('volumeIndex')
        await base.updateAsync(
            { _id: id },
            { _id: id, value: { blockHeight:blockHeight, rawVolume: rawVolume, ltcVolume: ltcVolume, price:price, type } },
            { upsert: true }
        );

        // Update global cumulative volume variables
        await VolumeIndex.updateCumulativeVolumes(ltcVolume, type,id,blockHeight);
        return
    }

    static async getUTXOEquivalentVolume(volume, id, type,collateralId, notionalValue,inverse,price){
        console.log('inside get getUTXOEquivalentVolume '+type+collateralId+notionalValue+inverse)
        if(type === "contract"&&collateralId&&notionalValue&&inverse!==undefined){
            const priceInLTC = await this.getTokenPriceInLTC(collateralId);
            console.log('price in ltc for collateral '+collateralId+ ' '+priceInLTC+' trade price '+price+' volume '+volume)
            const ltcPriceBN = new BigNumber(priceInLTC)
            const volumeBN = new BigNumber(volume)
            const tradePriceBN = new BigNumber(price)
            const notionalBN = new BigNumber(notionalValue)
            let volumeInLTC = volumeBN.times(ltcPriceBN).times(notionalBN)
            if(inverse==false){
                volumeInLTC = volumeInLTC.times(tradePriceBN)
            }
            console.log('result '+volumeInLTC.decimalPlaces(8).toNumber())
            return volumeInLTC.decimalPlaces(8).toNumber()
        }else if (type === "token") {
            const [tokenId1, tokenId2] = id.split('-');
            console.log('checking ids ' +tokenId1, tokenId2)
            const priceInLTC1 = await this.getTokenPriceInLTC(tokenId1);
            const priceInLTC2 = await this.getTokenPriceInLTC(tokenId2);
            console.log('LTC prices of the tokens'+priceInLTC1, priceInLTC2)
            const volumeInLTC = priceInLTC1*volume[0] + priceInLTC2*volume[1]
            return volumeInLTC
        }
    }

static async updateCumulativeVolumes(volume, type, id, block) {
  // load existing totals, guard nulls

  const base = await db.getDatabase('volumeIndex');
  const globalDoc = await base.findOneAsync({ _id: 'globalCumulativeVolume' }) || { value: { globalCumulativeVolume: 0 }};
  const ltcDoc    = await base.findOneAsync({ _id: 'ltcPairCumulativeVolume' }) || { value: { ltcPairTotalVolume: 0 }};

  const globalCumulativeVolume = globalDoc.value.globalCumulativeVolume
  const ltcPairTotalVolume = ltcDoc.value.ltcPairTotalVolume

  console.log('inside updateCumulativeVolumes '+JSON.stringify(globalDoc)+' '+JSON.stringify(ltcDoc))
  const BNGlobal = new BigNumber(globalCumulativeVolume || 0);
  const BNltc   = new BigNumber(ltcPairTotalVolume || 0);
  const BNVol   = new BigNumber(volume || 0);

  // global always increments
  const newGlobal = BNVol.plus(BNGlobal).decimalPlaces(8).toNumber();

  // ltc pair increments only if type === "UTXO"
  let newLtcPair = BNltc.toNumber();
  if (type === "UTXO") {
    newLtcPair = BNVol.plus(BNltc).decimalPlaces(8).toNumber();
  }

    await base.updateAsync(
      { _id: 'ltcPairCumulativeVolume' },
      { _id: 'ltcPairCumulativeVolume', value: { ltcPairTotalVolume: newLtcPair, block } },
      { upsert: true }
    );

    await base.updateAsync(
      { _id: 'globalCumulativeVolume' },
      { _id: 'globalCumulativeVolume', value: { globalCumulativeVolume: newGlobal, block } },
      { upsert: true }
    );

  return;
}


    static async getTokenPriceInLTC(tokenId) {
        // Attempt to fetch the VWAP price from the database
        const base = await db.getDatabase('volumeIndex')
        const vwapData = await base.findOneAsync({ _id: `0-${tokenId}` });
        console.log('get token LTC price '+JSON.stringify(vwapData))
        if (vwapData && vwapData.value && vwapData.value.price) {
            return vwapData.value.price;
        }

        // If VWAP price is not available, return a default low value
        return 0.001; // Minimum price
    }

  static async calculateVolIndex(lookbackBlocks = 14400) {
    const base = await db.getDatabase('volumeIndex');
    const docs = await base.findAsync({}).sort({ 'value.blockHeight': -1 }).limit(lookbackBlocks);

    if (!docs || docs.length < 2) {
        return 0;
    }

    // Collect log returns
    let prices = docs.map(d => d.value.price).filter(p => p > 0);
    let logReturns = [];
    for (let i = 1; i < prices.length; i++) {
        logReturns.push(Math.log(prices[i] / prices[i-1]));
    }

    // Standard deviation of log returns
    const mean = logReturns.reduce((a,b) => a+b, 0) / logReturns.length;
    const variance = logReturns.reduce((a,b) => a + Math.pow(b-mean,2), 0) / (logReturns.length-1);
    const stdev = Math.sqrt(variance);

    // Annualize (assuming 144 blocks ≈ 1 day)
    const blocksPerYear = 144 * 365;
    const volIndex = stdev * Math.sqrt(blocksPerYear);

    // Save volIndex in db
    await base.updateAsync(
        { _id: 'volIndex' },
        { _id: 'volIndex', value: { vol: volIndex, updatedAt: Date.now() } },
        { upsert: true }
    );

    return volIndex;
}



  /**
   * Normalize ContractRegistry.getContractInfo(contractId) into a flat shape.
   * Accepts either { data: {...} } or a flat object.
   */
  static async _normalizeContractInfo(contractId) {
    const Contracts = require('./contractRegistry.js')
    const raw = await Contracts.getContractInfo(contractId);
    const d = (raw && raw.data) ? raw.data : (raw || {});

    return {
      contractId: d.id ?? raw?.id ?? contractId,
      ticker: d.ticker,
      native: !!d.native,
      inverse: !!d.inverse,
      // definitive fields from your sample
      notionalPropertyId: d.notionalPropertyId ?? 0, // 0 => LTC
      notionalValue: Number(d.notionalValue ?? 1),
      collateralPropertyId: d.collateralPropertyId,
      leverage: Number(d.leverage ?? 1) || 1,
      onChainData: Array.isArray(d.onChainData) ? d.onChainData : [],
    };
  }

  /**
   * LTC value per 1 contract unit:
   *   ltcPerContract = (notionalValue * price(notionalPropertyId in LTC)) / leverage
   * Handles inverse/native the same, since notional is explicit in (value, property).
   */
  static async getContractUnitLTCValue(contractId) {
    try {
      const c = await this._normalizeContractInfo(contractId);

      // Price for the notional token in LTC
      let tokenPriceInLTC = 1;
      if (!(c.notionalPropertyId === 0 || c.notionalPropertyId === '0' || c.notionalPropertyId === 'LTC')) {
        tokenPriceInLTC = await this.getTokenPriceInLTC(c.notionalPropertyId);
      }

      const notionalLTC = c.notionalValue * Number(tokenPriceInLTC || 0);
      if (!Number.isFinite(notionalLTC) || notionalLTC <= 0) return 0;

      const ltcPerContract = notionalLTC / (c.leverage || 1);
    console.log('inside LTC contract value '+ltcPerContract.toFixed(8)+' '+notionalLTC+' '+c.leverage)
      return Number(ltcPerContract.toFixed(8));
    } catch (e) {
      console.error('getContractUnitLTCValue error', e);
      return 0;
    }
  }

  /**
   * Debug/telemetry variant with all the inputs broken out.
   */
  static async getContractUnitLTCValueDetails(contractId) {
    const c = await this._normalizeContractInfo(contractId);

    let tokenPriceInLTC = 1;
    if (!(c.notionalPropertyId === 0 || c.notionalPropertyId === '0' || c.notionalPropertyId === 'LTC')) {
      tokenPriceInLTC = await this.getTokenPriceInLTC(c.notionalPropertyId);
    }

    const notionalLTC = c.notionalValue * Number(tokenPriceInLTC || 0);
    console.log('inside get contract unit LTC Value '+notionalLTC+' '+JSON.stringify(c))
    const ltcPerContract = Number.isFinite(notionalLTC) && c.leverage
      ? Number((notionalLTC / c.leverage).toFixed(8))
      : 0;

      if(ltcPerContract==0){throw new Error()}
    return ltcPerContract
  }


    /**
     * Function to get the last price for a given token pair and block height.
     * @param {string} tokenPair - The token pair in the format "X-Y".
     * @param {number} blockHeight - The block height to compare against.
     * @returns {Promise<number|null>} - The last price if found, otherwise null.
     */
    static async getLastPrice(tokenPair, blockHeight) {
        try {
            const base = await db.getDatabase('volumeIndex');
            console.log('inside get last price ' + blockHeight);
            if (typeof tokenPair !== 'string' || !tokenPair.includes('-')) {
                console.warn(`getLastPrice called with invalid tokenPair: ${tokenPair}`);
                return null;
            }

            // Try direct pair first
            const direct = await base.findOneAsync({ _id: tokenPair });

            if (direct && direct.value && direct.value.price) {
                return direct.value.price;
            }

            // If not found, try the inverse pair
            const [a, b] = tokenPair.split('-');
            const inversePair = `${b}-${a}`;
            const inverse = await base.findOneAsync({ _id: inversePair });

            if (inverse && inverse.value && inverse.value.price) {
                // invert the price for the obverse pair
                const inverted = new BigNumber(1).div(inverse.value.price).toNumber();
                console.log(
                    `Using inverse pair ${inversePair}, original tokenPair ${tokenPair}, inverted price=${inverted}`
                );
                return inverted;
            }

            console.error(
                `No data found for token pair: ${tokenPair} or its inverse at or below block height ${blockHeight}`
            );
            return null;
        } catch (error) {
            console.error('Error fetching last price:', error);
            return null;
        }
    }

static async getCumulativeVolumes(block) {
  const base = await db.getDatabase('volumeIndex');

  // Default values
  let globalCumulativeVolume = 0;
  let contractCumulativeVolume = 0;
  let ltcPairTotalVolume = 0;

  try {
    const globalDocs = await base.findAsync({ _id: 'globalCumulativeVolume', 'value.block': { $lt: block } });
    if (Array.isArray(globalDocs) && globalDocs.length) {
      globalDocs.sort((a, b) => b.value.block - a.value.block);
      globalCumulativeVolume = globalDocs[0].value.globalCumulativeVolume || 0;
    }
  } catch (err) {
    console.error("Error fetching global cumulative volume:", err);
  }

  try {
    const contractDocs = await base.findAsync({ _id: 'contractCumulativeVolume', 'value.block': { $lt: block } });
    if (Array.isArray(contractDocs) && contractDocs.length) {
      contractDocs.sort((a, b) => b.value.block - a.value.block);
      contractCumulativeVolume = contractDocs[0].value.contractCumulativeVolume || 0;
    }
  } catch (err) {
    console.error("Error fetching contract cumulative volume:", err);
  }

  try {
    const ltcDocs = await base.findAsync({ _id: 'ltcPairCumulativeVolume', 'value.block': { $lt: block } });
    if (Array.isArray(ltcDocs) && ltcDocs.length) {
      ltcDocs.sort((a, b) => b.value.block - a.value.block);
      ltcPairTotalVolume = ltcDocs[0].value.ltcPairTotalVolume || 0;
    }
  } catch (err) {
    console.error("Error fetching LTC pair total volume:", err);
  }

  return {
    globalCumulativeVolume,
    ltcPairTotalVolume,
    contractCumulativeVolume,
  };
}


    static async getBlockVolumes(blockHeight) {
        try {
            // Query the VolumeIndex.db for trades with the given blockHeight
            const base = await db.getDatabase('volumeIndex')
            const trades = await base.findAsync({ 
                "value.blockHeight": blockHeight
            });
            // If no trades are found, return 0
            if (!trades || trades.length === 0) {
                return 0;
            }

            console.log('getting block volumes '+JSON.stringify(trades))
            // Sum the total volume from the trades found
            let totalLTCVolume = new BigNumber(0);
            let totalVolume = new BigNumber(0)
            trades.forEach(trade => {
                const tradeVolume = new BigNumber(trade.value.ltcVolume);
                
                if(trade._id.toString().includes('0')){
                    console.log(tradeVolume)
                    totalLTCVolume = totalLTCVolume.plus(tradeVolume);
                }
                
                totalVolume=totalVolume.plus(tradeVolume)
                
            });
            totalLTCVolume= totalLTCVolume.toNumber()
            totalVolume= totalVolume.toNumber()
            console.log(totalLTCVolume+' '+totalVolume)
            // Return the total volume for the block
            return {ltcPairs:totalLTCVolume,global:totalVolume};
        } catch (error) {
            return console.error(`Error fetching block volumes for block ${blockHeight}:`, error);
            //throw new Error(`Failed to fetch block volumes for block ${blockHeight}`);
        }
    }

    static async getVolumeDataById(id) {
        return await db.getDatabase('volumeIndex').findOneAsync({ _id: id });
    }

    static async sampleVolumesByBlock(blockHeight) {
        const volumeIndexData = await db.getDatabase('volumeIndex').findAsync({ blockHeight });
        return volumeIndexData.map(entry => ({ id: entry._id, volume: entry.volume }));
    }

    static async sampleVolumesByBlockRange(startBlockHeight, endBlockHeight) {
        const volumeIndexData = await db.getDatabase('volumeIndex').findAsync({ 
            blockHeight: { $gte: startBlockHeight, $lte: endBlockHeight }
        });
        return volumeIndexData.map(entry => ({ id: entry._id, volume: entry.volume }));
    }

    static async calculateCumulativeVolume(id1, id2) {
        const volumeIndexData = await db.getDatabase('volumeIndex').findAsync({ _id: { $regex: `^${id1}-${id2}-` } });
        let cumulativeVolume = 0;
        volumeIndexData.forEach(entry => cumulativeVolume += entry.volume);
        return cumulativeVolume;
    }

    static async saveCumulativeVolume(id1, id2, cumulativeVolume) {
        const id = `cumulative-${id1}-${id2}`;
        await saveVolumeDataById(id, null, cumulativeVolume);
    }

    static async auditVWAP(blockHeight) {
        const volumeData = await this.sampleVolumesByBlock(blockHeight);

        // Calculate total volume and sum of (volume * price)
        let totalVolume = 0;
        let sumVolumeTimesPrice = 0;

        for (const entry of volumeData) {
            const price = await this.getTokenPriceInLTC(entry.id);
            const volume = entry.volume;

            totalVolume += volume;
            sumVolumeTimesPrice += volume * price;
        }

        // Avoid division by zero
        if (totalVolume === 0) {
            return null;
        }

        // Calculate VWAP
        const vwap = sumVolumeTimesPrice / totalVolume;
        return vwap;
    }

    static calculateVWAP(data, contract = false) {
        // Calculate total volume and sum of (volume * price)
        let totalVolume = 0;
        let sumVolumeTimesPrice = 0;

        for (const entry of data) {
            let volume;
            let price;

            if (entry.amount1 !== undefined && entry.amount2 !== undefined) {
                volume = contract ? entry.amount2 : entry.amount1;
                price = contract ? entry.amount1 : entry.amount2;
            } else if (entry.amount !== undefined && entry.price !== undefined) {
                volume = entry.amount;
                price = entry.price;
            } else {
                throw new Error("Invalid data format. Each entry must contain either 'amount1' and 'amount2', or 'amount' and 'price'.");
            }

            totalVolume += volume;
            sumVolumeTimesPrice += volume * price;
        }

        // Avoid division by zero
        if (totalVolume === 0) {
            return null;
        }

        // Calculate VWAP
        const vwap = sumVolumeTimesPrice / totalVolume;
        return vwap;
    }
    
    static async getVwapData(propertyId1, propertyId2, trailingBlocks) {
        try {
         // Fetch the N most recent VWAP entries for the specified property pair
            const vwapData = await db.getDatabase('volumeIndex').findAsync({
                _id: { $regex: `${propertyId1}-${propertyId2}-` }
            }, {
                sort: { blockHeight: -1 },  // Sort by blockHeight in descending order
                limit: trailingBlocks      // Limit to the N most recent entries
            });

            // Calculate total volume and sum of (volume * price)
            let totalVolume = 0;
            let sumVolumeTimesPrice = 0;

            for (const entry of vwapData) {
                const price = entry.value.price;
                const volume = entry.value.volume;

                totalVolume += volume;
                sumVolumeTimesPrice += volume * price;
            }

            // Avoid division by zero
            if (totalVolume === 0) {
                return null;
            }

            // Calculate VWAP
            const vwap = sumVolumeTimesPrice / totalVolume;
            return vwap;
        } catch (error) {
            console.error('Error fetching VWAP data:', error);
            throw new Error('Failed to fetch VWAP data.');
        }
    }

    static async saveVWAP(id, blockHeight, vwap) {
        console.log('saving VWAP'+ id, blockHeight, vwap)
        const base = await db.getDatabase('volumeIndex')
        await base.updateAsync(
            { _id: 'vwap-'+id },
            { value: { blockHeight:blockHeight, volume: volume, price:price } },
            { upsert: true }
        );
    }

    static computeLiquidityRewardShare(cumulativeLtc, opts = {}) {
        const maxShare = Number(opts.maxShare ?? 0.35);
        const minShare = Number(opts.minShare ?? 0.02);
        const pivotLtc = Math.max(Number(opts.pivotLtc ?? 1000), 1);
        const slope = Math.max(Number(opts.slope ?? 1), 0);

        const cumulative = Math.max(Number(cumulativeLtc || 0), 0);
        const scaled = cumulative / pivotLtc;
        const attenuation = maxShare / (1 + Math.log10(1 + scaled) * slope);
        const clamped = Math.max(minShare, Math.min(maxShare, attenuation));
        return Math.min(0.99, clamped);
    }

    static calculateAttenuatedLiquidityReward(feePaid, cumulativeLtc, opts = {}) {
        const fee = Math.max(Number(feePaid || 0), 0);
        if (fee <= 0) return 0;
        const share = this.computeLiquidityRewardShare(cumulativeLtc, opts);
        return new BigNumber(fee).times(share).decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber();
    }

    static async calculateLiquidityReward(tradeVolume, token, ctx = {}) {
        const feePaid = Number(
            ctx.feePaid != null
                ? ctx.feePaid
                : new BigNumber(tradeVolume || 0)
                    .times(Number(ctx.feeRate ?? 0.00005))
                    .toNumber()
        );

        let cumulativeLtc = Number(ctx.cumulativeLtc ?? 0);
        if (!(cumulativeLtc > 0)) {
            const block = Number(ctx.block || 0);
            const cumulative = await this.getCumulativeVolumes((block > 0 ? block : 1) + 1).catch(() => null);
            cumulativeLtc = Number(cumulative?.ltcPairTotalVolume || cumulative?.globalCumulativeVolume || 0);
        }

        return this.calculateAttenuatedLiquidityReward(feePaid, cumulativeLtc, ctx);
    }
static async getVWAP(propertyId1, propertyId2, blockHeight, trailingBlocks) {
    try {
        const base = await db.getDatabase('volumeIndex');
        const blockStart = blockHeight - trailingBlocks;

        // Query volume index within the block range
        const vwapData = await base.findAsync({
            _id: { $in: [`${propertyId1}-${propertyId2}`, `${propertyId2}-${propertyId1}`] }, // Check both pair orders
            "value.blockHeight": { $gte: blockStart, $lte: blockHeight }
        });

        if (!vwapData || vwapData.length === 0) {
            //console.warn(`⚠️ No VWAP data for ${propertyId1}-${propertyId2} in blocks ${blockStart}-${blockHeight}`);
            return null;
        }

        // Calculate VWAP
        let totalVolume = new BigNumber(0);
        let sumVolumeTimesPrice = new BigNumber(0);

        for (const entry of vwapData) {
            const price = new BigNumber(entry.value.price);
            const volume = new BigNumber(entry.value.volume);

            totalVolume = totalVolume.plus(volume);
            sumVolumeTimesPrice = sumVolumeTimesPrice.plus(volume.times(price));
        }

        if (totalVolume.isZero()) return null;

        return sumVolumeTimesPrice.dividedBy(totalVolume).decimalPlaces(8).toNumber();
    } catch (error) {
        console.error(`❌ Error fetching VWAP for ${propertyId1}-${propertyId2}:`, error);
        return null;
    }
}


    static async baselineLiquidityReward(tradeVolume, fee, token, ctx = {}) {
        // Compatibility shim: keep call sites stable but use bounded fee-linked attenuation.
        return this.calculateLiquidityReward(tradeVolume, token, { ...ctx, feePaid: fee });
    }

    static async getTLPriceInLTC() {
        // Attempt to fetch the VWAP price from the database
        const base = await db.getDatabase('volumeIndex')
        const vwapData = await base.findOneAsync({ _id: `vwap-1` });
        
        if (vwapData && vwapData.value && vwapData.value.price) {
            return vwapData.value.price;
        }

        // If VWAP price is not available, return a default low value
        return 0.001; // Minimum price
    }



    static vestTokens(tradeVolume) {
        // Calculate logarithmic value
        const logVolume = Math.log10(this.globalCumulativeVolume / 1e9); // Log base 10 with cap at 100 billion LTC

        // Tier 1 vesting tokens (1000 to 100,000,000 LTC)
        let tier1Tokens = 0;
        if (logVolume > 0) {
            if (totalVolume >= 1000 && totalVolume <= 1e8) {
                tier1Tokens = logVolume * 1e6; // Adjust 1e6 for tokens calculation
            }
        }

        // Tier 2 vesting tokens (100,000,000 to 100 billion LTC)
        let tier2Tokens = 0;
        if (logVolume > 0) {
            if (totalVolume > 1e8 && totalVolume <= 1e11) {
                tier2Tokens = logVolume * 3e6; // Adjust 3e6 for tokens calculation
            }
        }

        return {
            tier1Tokens,
            tier2Tokens
        };
    }


}

module.exports = VolumeIndex;
