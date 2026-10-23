// Assuming the LevelDB database is stored at './path_to_margin_db'
const db = require('./db.js');
const BigNumber = require('bignumber.js')
const { v4: uuidv4 } = require('uuid');
const Options = require('./options.js');


class MarginMap {
    constructor(seriesId) {
        this.seriesId = seriesId;
        this.margins = new Map();
        if (!this.expiryIndex)   this.expiryIndex   = new Map();
        if (!this.tickerExpiry)  this.tickerExpiry  = new Map();
        if (!this.optionOI)      this.optionOI      = new Map();
    }

    static async getInstance(contractId) {
        // Load the margin map for the given contractId from the database
        // If it doesn't exist, create a new instance
        const marginMap = await MarginMap.loadMarginMap(contractId);
        return marginMap;
    }

    static async loadMarginMap(seriesId,flag=false) {
        const key = JSON.stringify({ seriesId });
        //console.log('loading margin map for ' + seriesId);
        // Retrieve the marginMaps database from your Database instance
        const marginMapsDB = await db.getDatabase('marginMaps');

        try {
            const doc = await marginMapsDB.findOneAsync({ _id: key });
            console.log(Boolean(doc))
            if (!doc) {
                // Return a new instance if not found
                //console.log('no MarginMap found, spinning up a fresh one');
                return new MarginMap(seriesId);
            }

            if(flag){console.log('marginMap parsed from DB ' + JSON.stringify(doc));
            return doc.value}
            const map = new MarginMap(seriesId);

            // Parse the value property assuming it's a JSON string
            const parsedValue = JSON.parse(doc.value);
            console.log(JSON.stringify(parsedValue))
            if (parsedValue instanceof Array) {
                // Assuming parsedValue is an array
                map.margins = new Map(parsedValue);
            } else {
                console.error('Error parsing margin map value. Expected an array.');
            }

            //console.log('returning a map from the file ' + JSON.stringify(map.margins));
            return map;
        } catch (err) {
            console.error('Error loading margin Map ' + err);
        }
    }

    /*static async loadMarginMap(seriesId) {
        const key = JSON.stringify({ seriesId});
        console.log('loading margin map for '+seriesId)
        // Retrieve the marginMaps database from your Database instance
        const marginMapsDB = db.getDatabase('marginMaps');

        try {
            const doc = await marginMapsDB.findOneAsync({ _id: key });
            if (!doc) {
                // Return a new instance if not found
                console.log('no MarginMap found, spinning up a fresh one')
                return new MarginMap(seriesId);
            }
            console.log('marginMap parsed from DB '+JSON.stringify(doc))
            var map = new MarginMap(seriesId);
            map.margins = new Map(JSON.parse(doc.value));
            console.log('returning a map from the file '+JSON.stringify(map))
            return map;
        } catch (err) {
            console.log('err loading margin Map '+err)
        }
    }*/

    /*initMargin(address, contracts, price) {
        const notional = contracts * price;
        const margin = notional * 0.1;

        this.margins.set(address, {
            contracts,
            margin,
            unrealizedPl: 0
        });

        return margin;
    }*/
    async getAllPositions(contractId,flag) {
        let map = await MarginMap.loadMarginMap(contractId,flag);

        // If the margins map is empty, attempt to reload from the database
        /*if (!map.margins || map.margins.size === 0) {
            //console.log(`🔄 Margins map empty for contract ${contractId}, reloading from DB...`);
            map = await MarginMap.loadMarginMap(contractId);  // Assuming this method exists
        }*/

        //console.log(`📊 Getting positions for contract ${contractId}:`, JSON.stringify([...map.margins]));

        const allPositions = [];
        for (const [address, position] of map.margins.entries()) {
            if (!address) continue;

            allPositions.push({
                address: address,
                contracts: position.contracts,
                margin: position.margin,
                unrealizedPNL: position.unrealizedPNL,
                avgPrice: position.avgPrice,
                liqPrice: position.liqPrice,
                bankruptcyPrice: position.bankruptcyPrice,
                newPosThisBlock: position.newPosThisBlock
                // Add other relevant fields if necessary
            });
        }
        return allPositions;
    }

    async writePositionToMap(contractId, position) {
      try {
        const key = JSON.stringify({ seriesId: contractId });
        const marginMapsDB = await db.getDatabase('marginMaps');

        // Load existing doc (if any)
        const existing = await marginMapsDB.findOneAsync({ _id: key });

        let map;
        if (existing) {
          const parsedValue = JSON.parse(existing.value);
          console.log('db instance pre-write in write to position '+JSON.stringify(parsedValue))
          map = new Map(parsedValue);
        } else {
          map = new Map();
        }

        // Update sender’s position
        map.set(position.address, position);

        // Serialize and save
        const doc = {
          _id: key,
          value: JSON.stringify(Array.from(map.entries()))
        };
        console.log('doc to write over marginMap '+JSON.stringify(doc))
        await marginMapsDB.updateAsync({ _id: key }, doc, { upsert: true });

        console.log(`📝 Saved position for ${position.address} in contract ${contractId}`);
        return true;
      } catch (err) {
        console.error('❌ Error writing position to map:', err);
        return false;
      }
    }

    /*async readPosition(address,seriesId) {
      const sid = Number(seriesId);
      if (Number.isNaN(sid)) {
        //throw new Error(`Invalid seriesId: ${seriesId}`);
      }
      if (!address) {
        //throw new Error(`Address required`);
      }
      const marginDB = await db.getDatabase('marginMaps');
      // 1) Try to load the single doc keyed by {"seriesId":sid}
      const idKey = JSON.stringify({ seriesId: sid });
      let doc = await marginDB.findOneAsync({ _id: idKey });

      if (!doc) {
        // fallback: get latest for this seriesId
        const candidates = await marginDB.findAsync({ 'key.seriesId': sid });
        if (!candidates || candidates.length === 0) return null;
        candidates.sort((a, b) => (Number(b.block) || 0) - (Number(a.block) || 0));
        doc = candidates[0];
      }

      if (!doc || !doc.value) return null;

      let parsed;
      try {
        parsed = JSON.parse(doc.value);
      } catch (e) {
        console.error('Failed to parse marginMap value', e);
        return null;
      }

      for (const [addr, pos] of parsed) {
        if (addr === address) {
          console.log('what getPositionForAddress returns '+addr +' '+JSON.stringify(pos)+' '+JSON.stringify(parsed))
          return pos;
        }
      }
      return null;
    }*/

    // Set initial margin for a new position in the MarginMap
    async setInitialMargin(sender, contractId, totalInitialMargin, block, position) {
            const BigNumber = require('bignumber.js');
            if(sender=="")
            console.log(
                `[MarginMap.setInitialMargin] sender=${sender} contractId=${contractId} totalInitialMargin=${totalInitialMargin} block=${block}`
            );

            // ------------------------------------------------------------
            // 0) HYDRATE SAFETY: if this instance has an empty margins map,
            //    load positions before we mutate + persist, otherwise we can
            //    overwrite the DB with a partial map (the "contracts=0 wipe").
            // ------------------------------------------------------------
            const hadMap = !!this.margins;
            const wasEmpty = !hadMap || this.margins.size === 0;
            let hydrated = false;

            if (wasEmpty) {
                try {
                    const loaded = await this.getAllPositions(contractId);
                    if (loaded && loaded instanceof Map) {
                        this.margins = loaded;
                    } else if (loaded && typeof loaded.entries === 'function') {
                        // Map-like fallback
                        this.margins = new Map(loaded);
                    } else if (!this.margins) {
                        this.margins = new Map();
                    }

                    hydrated = this.margins.size > 0;
                    console.log(
                        `[MarginMap.setInitialMargin] hydrate attempt: size=${this.margins.size} hydrated=${hydrated}`
                    );
                } catch (e) {
                    console.warn(
                        `[MarginMap.setInitialMargin] hydrate FAILED: ${e && e.message ? e.message : e}`
                    );
                    if (!this.margins) this.margins = new Map();
                }
            }

            // ------------------------------------------------------------
            // 1) Resolve position
            // ------------------------------------------------------------
            if (!position) position = this.margins.get(sender);

            console.log('[MarginMap.setInitialMargin] resolved position ' + JSON.stringify(position));

            if (!position) {
                position = {
                    contracts: 0,
                    margin: 0,
                    unrealizedPNL: 0,
                    avgPrice: 0,
                    address: sender
                };
            } else {
                // normalize missing fields without changing names/types
                if (position.contracts == null) position.contracts = 0;
                if (position.margin == null) position.margin = 0;
                if (position.unrealizedPNL == null) position.unrealizedPNL = 0;
                if (position.avgPrice == null) position.avgPrice = 0;
                if (position.address == null) position.address = sender;
            }

            // ------------------------------------------------------------
            // 2) Apply margin
            // ------------------------------------------------------------
            const before = position.margin;
            position.margin = new BigNumber(position.margin || 0)
                .plus(totalInitialMargin || 0)
                .decimalPlaces(8)
                .toNumber();

            console.log(
                `[MarginMap.setInitialMargin] margin ${before} -> ${position.margin} (delta=${totalInitialMargin}) contracts=${position.contracts}`
            );

            this.margins.set(sender, position);

            // ------------------------------------------------------------
            // 3) Record delta
            // ------------------------------------------------------------
            await this.recordMarginMapDelta(
                sender,
                contractId,
                position.contracts, // totalPosition
                0,                  // position delta (this fn is just margin posting)
                totalInitialMargin, // margin delta
                0,                  // uPNL
                position.avgPrice || 0,
                'initialMargin',
                block
            );

            // ------------------------------------------------------------
            // 4) Persist SAFELY:
            //    Only persist if we either already had a populated map,
            //    or we successfully hydrated it. Otherwise we risk wiping DB.
            // ------------------------------------------------------------
            if (!wasEmpty || hydrated) {
                await this.saveMarginMap(true);
            } else {
                console.warn(
                    `[MarginMap.setInitialMargin] SKIP saveMarginMap(true): margins map not hydrated (would risk partial overwrite)`
                );
            }

            return position;
        }

            /**
         * Atomically replace all positions for this contract with the final versions
         * produced by the clearing engine.
         *
         * @param {Array} finalPositions - array of fully-computed positions from cache
         * @param {number} contractId
         * @param {boolean} flattenZeroes - if true, zero-contract positions are omitted
         */
        async mergePositions(finalPositions, contractId, flattenZeroes = true) {
            const newMap = new Map();

            for (const pos of finalPositions) {
                if (flattenZeroes) {
                  const iou = new BigNumber(pos.iouClaim || 0);
                  if ((!pos.contracts || pos.contracts === 0) && iou.isZero()) {
                    continue;
                  }
                }
                newMap.set(pos.address, pos);
            }

            // Replace the map atomically
            this.margins = newMap;

            // persist in DB
            await this.saveMarginMap();
        }


      // add save/load methods
    async saveMarginMap(block) {
        console.log('saving margin map')
        try {
            const key = JSON.stringify({ seriesId: this.seriesId });
            const marginMapsDB = await db.getDatabase('marginMaps');
            const value = JSON.stringify([...this.margins]);
            //console.log(value)
                    // Save the margin map to the database
            await marginMapsDB.updateAsync({ _id: key }, { $set: {block: block, value: value}},{upsert: true})
            //await marginMapsDB.loadDatabase();
            //console.log('MarginMap saved successfully.');
        } catch (err) {
            console.error('Error saving MarginMap:', err);
            throw err;
        }
    }

    async updateContractBalancesWithMatch(match, channelTrade, buyerClose,flipLong,sellerClose,flipShort,block) {
        console.log('updating contract balances, buyer '+JSON.stringify(match.buyerPosition)+ '  and seller '+JSON.stringify(match.sellerPosition))
        console.log('with match '+JSON.stringify(match))
        let buyerPosition = await this.updateContractBalances(
            match.buyOrder.buyerAddress,
            match.buyOrder.amount,
            match.tradePrice,
            match.buyOrder.sell,
            match.buyerPosition,
            match.inverse,
            buyerClose,
            flipLong,
            match.buyOrder.contractId,
            match.buyOrder.isLiq,
            block
        );

        let sellerPosition = await this.updateContractBalances(
            match.sellOrder.sellerAddress,
            match.sellOrder.amount,
            match.tradePrice,
            match.sellOrder.sell,
            match.sellerPosition,
            match.inverse,
            sellerClose,
            flipShort,
            match.sellOrder.contractId,
            match.sellOrder.isLiq,
            block
        );
        return {bp: buyerPosition, sp: sellerPosition}
    }

    async updateContractBalances(
        address,
        amount,
        price,
        isSell,
        position,
        inverse,
        close,
        flip,
        contractId,
        inClearing,
        block,
        initial
    ) {
        console.log('pre-liq check in update contracts ' + amount + ' ' + JSON.stringify(position));
        console.log('checking isSell in match update '+isSell)
        /*if (position.contracts == null) {
            position.contracts = 0;
        }
        if (position.newPosThisBlock === undefined) {
            position.newPosThisBlock = 0;
        }*/

        // Capture old size BEFORE contract update
        const oldSize = position.contracts;

        console.log(
            'inside updateContractBalances ' + close + ' ' + flip + 
            ' position ' + oldSize + ' avgPrice ' + position.avgPrice
        );

        // ----------------------------
        // AVG PRICE LOGIC (correct)
        // ----------------------------

        // Case 1: Flip → full close + new open in opposite direction
        if (flip > 0) {
            position.avgPrice = price;
            console.log('FLIP: avgPrice reset to', position.avgPrice);
        }

        // Case 2: Not a flip, not a close → open or extend
        else if (close === 0) {

            // New open (flat → nonflat)
            if (oldSize === 0) {
                position.avgPrice = price;
                console.log('NEW OPEN: avgPrice =', position.avgPrice);
            }

            // Extend existing same-side position (weighted avg)
            else if (
                (oldSize > 0 && !isSell) ||
                (oldSize < 0 && isSell)
            ) {
                console.log('Weighted avg update →', amount, price, contractId);
                position.avgPrice = await this.updateAveragePrice(
                    position, amount, price, contractId, isSell
                );
                console.log('Weighted avg result → avgPrice =', position.avgPrice);
            }

            // Partial close (oldSize and trade sides differ)
            else {
                console.log('PARTIAL CLOSE: avgPrice unchanged:', position.avgPrice);
            }
        }

        // Case 3: Explicit close trade
        else {
            console.log('CLOSE TRADE: avgPrice unchanged:', position.avgPrice);
        }

        // -----------------------------------------------------
        // UPDATE CONTRACT COUNT AFTER avgPrice adjustments
        // -----------------------------------------------------
        console.log('position size before update ' + position.contracts);

        const amountBN = new BigNumber(amount);
         let newPositionSize = isSell
          ? new BigNumber(oldSize).minus(amountBN).toNumber()  // SELL
          : new BigNumber(oldSize).plus(amountBN).toNumber();  // BUY


        console.log(
            'newPositionSize ' + newPositionSize +
            ' address ' + address +
            ' amount ' + amount +
            ' isSell ' + isSell
        );

        position.contracts = newPositionSize;

        // -----------------------------------------------------
        // NOW fetch contract info and compute liquidation
        // -----------------------------------------------------
        const ContractList = require('./contractRegistry.js');
        const TallyMap = require('./tally.js');

        const contractInfo = await ContractList.getContractInfo(contractId);
        const notionalValue = contractInfo.notionalValue;
        const collateralId = contractInfo.collateralPropertyId;

        const balances = await TallyMap.getTally(address, collateralId);
        const available = balances.available;

        const isLong = position.contracts > 0;

        console.log('about to calc liq for pos ' + JSON.stringify(position));
        const liquidationInfo = this.calculateLiquidationPrice(
            available,
            position.margin,
            position.contracts,
            notionalValue,
            inverse,
            isLong,
            position.avgPrice
        );

        console.log('liquidation info ' + JSON.stringify(liquidationInfo));

        // -----------------------------------------------------
        // Liquidation / reset logic
        // -----------------------------------------------------
        if (!liquidationInfo || position.contracts === 0) {
            position.liqPrice = 0;
            position.bankruptcyPrice = 0;

            // If flat, avgPrice must be reset to null
            if (position.contracts === 0) {
                position.avgPrice = null;
            }
        } else {
            position.liqPrice = liquidationInfo.liquidationPrice || null;
            position.bankruptcyPrice = liquidationInfo.bankruptcyPrice;
        }

        // -----------------------------------------------------
        // SAVE POSITION TO MARGIN MAP
        // -----------------------------------------------------
        console.log('Saving position', JSON.stringify(position));
        this.margins.set(address, position);

        let tag = 'updateContractBalances';
        if (inClearing) {
            tag = initial ? 'initialLiq' : 'liquidatingContract';
        }

        await this.saveMarginMap(block);

        await this.recordMarginMapDelta(
            address,
            contractId,
            newPositionSize,
            amount,
            0,
            0,
            0,
            tag,
            block,
            position.bankruptcyPrice
        );

        return position;
    }

    
    calculateLiquidationPrice(available, margin, contracts, notionalValue, isInverse, isLong, avgPrice,uPNL) {
        console.log(available, margin, contracts, notionalValue, isInverse, isLong, avgPrice,uPNL)
        const balanceBN = new BigNumber(available);
        const marginBN = new BigNumber(margin);
        const uPNLBN = new BigNumber(uPNL || 0);
        const totalCollateralBN = balanceBN.plus(marginBN).minus(BigNumber.max(uPNLBN, 0));

        const contractsBN = new BigNumber(Math.abs(contracts));
        const notionalValueBN = new BigNumber(notionalValue);
        const avgPriceBN = new BigNumber(avgPrice);

        // For linear contracts, use your existing formulas.
        const positionNotional = notionalValueBN.times(contractsBN);
        let bankruptcyPriceBN = new BigNumber(0);
        let liquidationPriceBN = new BigNumber(0);
        const adjustment = marginBN.dividedBy(2).dividedBy(contractsBN); // This is used for linear

        console.log('inside calc liq price', isInverse, isLong, 'avail and margin', available, margin);
        
        if (!isInverse) {
            // Linear contracts: existing logic
            if (isLong) {
                if (totalCollateralBN.isGreaterThanOrEqualTo(positionNotional.times(avgPriceBN))) {
                    return { bankruptcyPrice: null, liquidationPrice: null };
                } else {
                    bankruptcyPriceBN = avgPriceBN.minus(totalCollateralBN.dividedBy(positionNotional)).times(1.005);
                    liquidationPriceBN = bankruptcyPriceBN.plus(adjustment);
                }
            } else {
                bankruptcyPriceBN = avgPriceBN.plus(totalCollateralBN.dividedBy(positionNotional)).times(0.995);
                liquidationPriceBN = bankruptcyPriceBN.minus(adjustment);
            }
        } else {
            // Inverse contracts: use reciprocal PnL logic.
            // Define term = (margin / 2) / (contracts * notional)
            const term = marginBN.dividedBy(2).dividedBy(contractsBN.multipliedBy(notionalValueBN));

            if (isLong) {
                // For a long inverse position:
                // 1/Pliq = 1/Pentry + term  => Pliq = 1 / (1/Pentry + term)
                const reciprocalLiq = new BigNumber(1).dividedBy(avgPriceBN).plus(term);
                liquidationPriceBN = new BigNumber(1).dividedBy(reciprocalLiq);
                // For bankruptcy, you might apply a slight multiplier:
                const reciprocalBankruptcy = new BigNumber(1).dividedBy(avgPriceBN).plus(term.multipliedBy(1.005));
                bankruptcyPriceBN = new BigNumber(1).dividedBy(reciprocalBankruptcy);
            } else {
                // For a short inverse position:
                // 1/Pliq = 1/Pentry - term. If that term becomes <= 0, liquidation price is null.
                const reciprocalLiq = new BigNumber(1).dividedBy(avgPriceBN).minus(term);
                if (reciprocalLiq.lte(0)) {
                    return { bankruptcyPrice: null, liquidationPrice: null };
                } else {
                    liquidationPriceBN = new BigNumber(1).dividedBy(reciprocalLiq);
                    // Bankruptcy price with a slight multiplier:
                    const reciprocalBankruptcy = new BigNumber(1).dividedBy(avgPriceBN).minus(term.multipliedBy(1.005));
                    bankruptcyPriceBN = new BigNumber(1).dividedBy(reciprocalBankruptcy);
                }
            }
        }

        let bankruptcyPrice = Math.abs(bankruptcyPriceBN.decimalPlaces(4).toNumber());
        let liquidationPrice = Math.abs(liquidationPriceBN.decimalPlaces(4).toNumber());
        
        return {
            bankruptcyPrice,
            liquidationPrice
        };
    }

    async updateAveragePrice(position, amount, price, contractId, isSell) {
        const oldSize = position.contracts;
        const oldAvg = new BigNumber(position.avgPrice || 0);
        const tradeSize = new BigNumber(amount);

        // Determine new total position size
        const newSize = isSell
            ? new BigNumber(oldSize).minus(tradeSize)
            : new BigNumber(oldSize).plus(tradeSize);
        // If newSize is zero, the position is fully closed
        if (newSize.isZero()) {
            return null; // avgPrice resets in updateContractBalances
        }

        // Weighted average price formula (always absolute sizes)
        const weighted = oldAvg.times(Math.abs(oldSize))
            .plus(new BigNumber(price).times(amount))
            .dividedBy(Math.abs(newSize))
            .decimalPlaces(8);

        return weighted.toNumber();
    }


    async moveMarginAndContractsForMint(address, propertyId, contractId, contracts, margin,block) {
        // Check if the margin map exists for the given contractId
        const position = this.margins.get(address);
        const synthId = 's-'+propertyId+'-'+contractId

        let vaultPosition = this.margins.get(synthId)
        let first = false

        if(!vaultPosition){
            console.log('first time establishing vault on marginMap '+synthId)
            first = true
            vaultPosition = {contracts:0,margin:0,avgPrice:0,liqPrice:null,address:synthId}
        }
        // If no position exists for the propertyId, initialize a new one
        if (!position) {
            return console.log('error: no position found for mint with '+propertyId+' collateral and contract '+contractId)
        }
        let excess = 0
        //we're assuming contracts is a negative number reflecting funky math in the validity function
        console.log('inside moveMarginAndContractsForMint '+contracts, margin, position.margin)
        // Update the existing position
        position.contracts = BigNumber(position.contracts).minus(contracts).toNumber();
        if(margin>position.margin){
            if(Math.abs(position.contracts)>Math.abs(contracts)){
                //instead of trying to calculate init/main. margin in between trade and mark prices, let's keep it simple and liquidation safer
                //and just not take from margin, mmkay
                excess = margin
                margin = 0
            }else{
                excess = BigNumber(margin).minus(position.margin).decimalPlaces(8).toNumber()
                margin = position.margin
            }
        }
        let prevMargin = position.margin
        position.margin = BigNumber(position.margin).minus(margin).decimalPlaces(8).toNumber();
        let marginChange = BigNumber(prevMargin).minus(position.margin)
        let avgDelta = 0
        if(first==false){
            vaultPosition.contracts = BigNumber(vaultPosition.contracts).plus(contracts).toNumber();
            vaultPosition.margin = BigNumber(position.margin).plus(margin).decimalPlaces(8).toNumber();
            let oldAvg = vaultPosition.avgPrice
            if(!oldAvg){oldAvg=0}
            vaultPosition.avgPrice = this.updatedAvgPrice(vaultPosition, amount, position.avgPrice, contractId, false)
            avgDelta = vaultPosition.avgPrice-oldAvg    
        }else if(first==true){
            vaultPosition.contracts = contracts
            vaultPosition.margin = margin
            vaultPosition.avgPrice = position.avgPrice
            avgDelta = vaultPosition.avgPrice   
        }
        
        // Save the updated position
        //if(address==null){throw new Error()}
        this.margins.set(address, position);
        this.margins.set(synthId,vaultPosition)
        await this.recordMarginMapDelta(synthId, contractId, vaultPosition.contracts, contracts, margin, 0, avgDelta, 'mintMarginAndContractsToVault');
        await this.recordMarginMapDelta(propertyId, contractId, position.contracts, contracts*-1, -margin, 0, 0, 'moveMarginAndContractsForMint');
        await this.saveMarginMap(block);

        return {contracts, margin,excess};
    }

    async moveMarginAndContractsForRedeem(address, propertyId, contractId, amount, vault, notional, initMargin,mark,block) {
            const position = this.margins.get(address);
            const vaultPosition = this.margins.get(propertyId)
            if (!position) {
                //throw new Error(`No position found for redemption with ${propertyId} collateral and contract ${contractId}`);
            }

            let excess = 0;
            let contracts = vault.contracts;
            let margin = vault.margin;
            let contractShort = BigNumber(amount).dividedBy(notional).toNumber();
            let longClosed = 0;
            let covered = 0;
            let shortsAdded = 0
            let transferAvg = false
            let modifyAvg = false
            if (position.contracts > 0 && contractShort < position.contracts) {
                longClosed = contractShort;
                covered = contractShort;
            } else if (position.contracts > 0 && contractShort === position.contracts) {
                longClosed = contractShort;
                covered = contractShort;
            } else if (position.contracts > 0 && contractShort > position.contracts) {
                longClosed = position.contracts;
                shortsAdded = BigNumber(contractShort).minus(longClosed).toNumber();
                covered = longClosed;
                //this is going to simply transpose the avg. price in the vault position to the user as it opens a short
                transferAvg = true
            } else if(position.contract<0){
                //this is going to modify the avg. price as it increases the short position
                modifyAvg = true
                shortsAdded = contractShort
            }

            if(shortsAdded>0){
                position.avgPrice = this.updatedAvgPrice(position, amount, vaultPosition.avgPrice, contractId, false)
            }
            // Adjust the contract and margin positions for redemption
            position.contracts = BigNumber(position.contracts).plus(contracts).toNumber();

            // Calculate pro-rata factor and margin to return
            let totalOutstanding = vault.outstanding;
            let proRataFactor = BigNumber(amount).dividedBy(totalOutstanding).decimalPlaces(8).toNumber();
            let marginToReturn = BigNumber(vault.margin).multipliedBy(proRataFactor).decimalPlaces(8).toNumber();
            let availToReturn = BigNumber(vault.available).multipliedBy(proRataFactor).decimalPlaces(8).toNumber()
            
            let returnMargin = BigNumber(contractShort).times(initMargin).decimalPlaces(8).toNumber()
            let returnAvail = BigNumber(marginToReturn).minus(returnMargin).decimalPlaces(8).toNumber()

            if (notCovered > 0) {
                returnAvail = marginToReturn - (marginToReturn * (notCovered / contractShort));
            }

            // Record any excess margin
            excess = BigNumber(margin).minus(marginToReturn).decimalPlaces(8).toNumber();

            // Adjust the margin position for redemption (add margin back to the position)
                position.margin = BigNumber(position.margin).plus(returnMargin).decimalPlaces(8).toNumber();
            if(!modifyAvg&&!transferAvg){
                position.contracts = BigNumber(position.contracts).minus(longClosed).toNumber();   
            }
            let oldAvg = position.avgPrice
            let avgDelta = 0
            if(!oldAvg){oldAvg=0}
            if(transferAvg){
                position.avgPrice=vaultPosition.avgPrice
                position.contracts=BigNumber(position.contracts).minus(longClosed).minus(shortsAdded).toNumber()
            }
            if(modifyAvg){
                position.avgPrice=this.updatedAvgPrice(position, amount, vaultPosition.avgPrice, contractId, false)
                position.contracts= BigNumber(position.contracts).minus(shortsAdded).toNumber()
            }
            let accountingPNL =0
            let reduction = 0
            if(longClosed>0){
                  accountingPNL = await this.realizePnl(address, longClosed, vaultPosition.avgPrice, position.avgPrice, true, notional, position, false,contractId);
                  console.log('calculating rPNL in redeem '+accountingPNL)
                  reduction = await this.reduceMargin(position, longClosed, accountingPNL, true, contractId, address, false,false,0);
                  //somehow adding logic to realize profits on the shorts on this address as they are inherited/covered
                  //going to remove this edge case in validity for now then return later
            }

            console.log('updating margin map in redeem '+address+' '+JSON.stringify(position))
            //if(address==null){throw new Error()}
            this.margins.set(address, position);
            await this.recordMarginMapDelta(propertyId, contractId, vault.contracts, contractShort, -returnMargin, -accountingPNL, 0, 'redeemMarginAndContractsFromVault');
            await this.recordMarginMapDelta(address,contractId, position.contracts, contractShort,returnMargin, accountingPNL,0,'moveMarginAndContractsForRedeem')
            await this.saveMarginMap(block);

            return { contracts: contractShort, margin: marginToReturn, available: availToReturn, excess: excess, rPNL: accountingPNL, reduction:reduction };
        }

                /**
         * Internal: update OI and expiry index when an option pos opens/closes for any address.
         * beforeQty: previous signed qty for this address
         * afterQty:  new signed qty for this address
         * tickerMeta: Options.parseTicker(ticker)
         */
        _touchExpiryIndex(beforeQty, afterQty, ticker, tickerMeta) {
          if (!tickerMeta || !tickerMeta.expiryBlock) return;

          const wasZero = (Number(beforeQty) || 0) === 0;
          const isZero  = (Number(afterQty)  || 0) === 0;

          if (wasZero && !isZero) {
            // transition 0 -> nonzero: increment OI and ensure indexed
            const oi = (this.optionOI.get(ticker) || 0) + 1;
            this.optionOI.set(ticker, oi);

            if (!this.tickerExpiry.has(ticker)) {
              this.tickerExpiry.set(ticker, tickerMeta.expiryBlock);
              const set = this.expiryIndex.get(tickerMeta.expiryBlock) || new Set();
              set.add(ticker);
              this.expiryIndex.set(tickerMeta.expiryBlock, set);
            }
          } else if (!wasZero && isZero) {
            // transition nonzero -> 0: decrement OI; remove ticker from index if OI hits 0
            const oi = Math.max(0, (this.optionOI.get(ticker) || 0) - 1);
            if (oi === 0) {
              this.optionOI.delete(ticker);
              const exp = this.tickerExpiry.get(ticker);
              if (exp != null) {
                const set = this.expiryIndex.get(exp);
                if (set) {
                  set.delete(ticker);
                  if (set.size === 0) this.expiryIndex.delete(exp);
                  else this.expiryIndex.set(exp, set);
                }
              }
              this.tickerExpiry.delete(ticker);
            } else {
              this.optionOI.set(ticker, oi);
            }
          }
        }

    /**
     * Return a flat array of tickers with expiry <= blockHeight.
     */
    async getExpiringTickersUpTo(blockHeight) {
      const out = [];
      for (const [exp, set] of this.expiryIndex.entries()) {
        if (Number(exp) <= Number(blockHeight)) {
          for (const t of set) out.push(t);
        }
      }
      return out;
    }

    /**
     * Remove all index entries with expiry <= blockHeight (call AFTER you process them).
     */
    async cleanupExpiredTickersUpTo(blockHeight) {
      for (const [exp, set] of Array.from(this.expiryIndex.entries())) {
        if (Number(exp) <= Number(blockHeight)) {
          this.expiryIndex.delete(exp);
          for (const t of set) {
            this.tickerExpiry.delete(t);
            this.optionOI.delete(t); // safe: OI should be zero after settlement
          }
        }
      }
    }

    async cleanupFlatPositions(contractId) {
        for (const [address, pos] of this.margins.entries()) {
            // Only remove if truly flat and safe
            if (
              pos.contracts === 0 &&
              (!pos.margin || pos.margin === 0) &&
              (!pos.unrealizedPNL || pos.unrealizedPNL === 0) &&
              new BigNumber(pos.iouClaim || 0).isZero()
            ) {
              this.margins.delete(address);
            }
        }

        // Persist the pruned state
        await this.saveMarginMap(true);
    }


        
    calculateMarginRequirement(contracts, price, inverse) {
        
        // Ensure that the input values are BigNumber instances
        let bnContracts = new BigNumber(contracts);
        let bnPrice = new BigNumber(price);

        let notional

        // Calculate the notional value
         if (inverse === true) {
            // For inverse contracts, the notional value in denominator collateral is typically the number of contracts divided by the price
            notional = bnContracts.dividedBy(bnPrice);
        } else {
            // For regular contracts, the notional value is the number of contracts multiplied by the price
            notional = bnContracts.multipliedBy(bnPrice);
        }

        // Return 10% of the notional value as the margin requirement
        return notional.multipliedBy(0.1).decimalPlaces(8).toNumber();
    }

     /**
     * Computes the numeric maintenance requirement for a position.
     * @param {string} contractId - The ID of the contract.
     * @param {object} position - Position snapshot.
     * @returns {Promise<number>} maintenance requirement in collateral units
     */
    async computeMaintenanceMarginRequirement(contractId, position) {
        if (!position) return 0;

        const ContractRegistry = require('./contractRegistry.js')
        const initialMargin = await ContractRegistry.getInitialMargin(contractId, position.avgPrice);
        const initialMarginBN = new BigNumber(initialMargin || 0);
        const contractsBN = new BigNumber(Math.abs(position.contracts || 0));
        const maintenanceMarginFactorBN = new BigNumber(0.5);

        return contractsBN
            .times(initialMarginBN)
            .times(maintenanceMarginFactorBN)
            .decimalPlaces(8)
            .toNumber();
    }

     /**
     * Checks whether the margin of a given position is below the maintenance margin.
     * If so, it could trigger liquidations or other necessary actions.
     * @param {string} address - The address of the position holder.
     * @param {string} contractId - The ID of the contract.
     */
    async isBelowMaintenanceMargin(address, contractId,position){
        if(!position){
            position = this.margins.get(address);
        }

        if (!position) {
            console.error(`No position found for address ${address}`);
            return;
        }

        const maintenanceMargin = await this.computeMaintenanceMarginRequirement(contractId, position);
        console.log('components '+maintenanceMargin+' '+position.contracts+' '+contractId+' '+position.avgPrice)
        console.log('checking maint margin '+position.margin+' '+position.unrealizedPNL+' <? '+maintenanceMargin)
        if (position.margin < maintenanceMargin) {
            console.log(`Margin below maintenance level for address ${address}. Initiating liquidation process.`);
            // Trigger liquidation or other necessary actions here
            // Example: this.triggerLiquidation(address, contractId);
            return true
        } else {
            console.log(`Margin level is adequate for address ${address}.`);
            return false
        }
    }

    async reduceMargin(pos, contracts, initPerContract, contractId, address, side, feeDebit, fee,block) {
        if (!pos) return { netMargin: new BigNumber(0), mode: 'none' };

        let posMargin = new BigNumber(pos.margin);
        let feeBN = new BigNumber(fee || 0);
        let contractAmount = new BigNumber(contracts);
        let posContracts = new BigNumber(pos.contracts);

        // ✅ **Calculate Required Margin for Current Position**
        let requiredMargin = posContracts.abs().times(initPerContract);
        console.log('inputs to calc req margin '+initPerContract+' '+pos.contracts+' '+posContracts)
        console.log(`🔎 Position: ${posContracts}, Contracts: ${contracts}, Required Margin: ${requiredMargin}`);

        // 🚀 **Calculate Excess Margin**
        let excessMargin = posMargin.minus(requiredMargin);
        
        if (excessMargin.isNegative()) {
            console.log(`⚠️ No excess margin to return.`);
            return 0;
        }

        // 💸 **Deduct Fee If Needed**
        if (feeDebit) {
            excessMargin = excessMargin.minus(feeBN);
            posMargin = posMargin.minus(feeBN);
        }

        // 🚨 **Ensure Margin Never Goes Below Required**
        let reduction = BigNumber.max(excessMargin, 0);

        // 🛠 **Apply Reduction**
        posMargin = posMargin.minus(reduction);

        // ✅ **Update Position & Save**
        pos.margin = posMargin.decimalPlaces(8).toNumber();
        reduction = reduction.decimalPlaces(8).toNumber();

        console.log(`✅ Final Margin: ${pos.margin} (Reduced by ${reduction}), Required Margin: ${requiredMargin.toFixed(8)}`);

        this.margins.set(pos.address, pos);
        await this.recordMarginMapDelta(address, contractId, 0, 0, -reduction, 0, 0, 'marginReduction');
        await this.saveMarginMap(block);

        return reduction
    }

    async feeMarginReduce(address,pos, reduction,contractId,block){
             // Now you can use the minus method
        pos.margin = new BigNumber(pos.margin).minus(reduction).decimalPlaces(8)
        .toNumber(); // Update the margin for the existing or new position
        console.log('updating margin in fee'+pos.margin)           
        this.margins.set(pos.address, pos);
        await this.recordMarginMapDelta(address, contractId, 0, 0, -reduction,0,0,'marginFeeReduction')
        //console.log('returning from reduceMargin '+reduction + ' '+JSON.stringify(pos)+ 'contractAmount '+contractAmount)
        await this.saveMarginMap(block);
        return pos;
    }

    async realizePnl(address, contracts, price, avgPrice, isInverse, notionalValue, pos, isBuy,contractId,block){
        if (!pos) return new BigNumber(0);

        let pnl;
        console.log('inside realizedPNL ' + address + ' ' + contracts + ' trade price ' + price + ' avg. entry ' + avgPrice + ' is inverse ' + isInverse + ' notional ' + notionalValue + ' position' + JSON.stringify(pos));
        
        if(avgPrice==0||avgPrice==null||avgPrice==undefined||isNaN(avgPrice)){
            console.log('weird avg. price input for realizedPNL ' +avgPrice+' '+address+ ' '+price+' '+JSON.stringify(pos))
        }

        const priceBN = new BigNumber(price);
        const avgPriceBN = new BigNumber(avgPrice);
        const contractsBN = new BigNumber(contracts);
        const notionalValueBN = new BigNumber(notionalValue);

        if (isInverse) {
            let one = new BigNumber(1)
            // For inverse contracts: PnL = (1/entryPrice - 1/exitPrice) * contracts * notional
            pnl = one.dividedBy(avgPriceBN).minus(one.dividedBy(priceBN))
                .times(contractsBN)
                .times(notionalValueBN)
            //console.log('pnl ' + pnl.toNumber());
        } else {
            // For linear contracts: PnL = (exitPrice - entryPrice) * contracts * notional
            pnl = priceBN
                .minus(avgPriceBN)
                .times(contractsBN)
                .times(notionalValueBN);
            //console.log('pnl ' + pnl.toNumber());
        }

        // Adjust the sign based on the isBuy flag
        pnl = isBuy ? pnl.times(-1) : pnl;
        pnl = pnl.decimalPlaces(8).toNumber()
        const absRPNL = Math.abs(pnl)
        const sign = pos.unrealizedPNL>0 ? 1: -1
        const signBN = new BigNumber(sign)
        // Modify the position object
        const uPNLBig = new BigNumber(Math.abs(pos.unrealizedPNL))
        pos.unrealizedPNL = uPNLBig.minus(absRPNL).times(sign).decimalPlaces(8).toNumber();
        pos.realizedPNL = pnl
        console.log('inside realizePnl ' + pnl + ' price then avgPrice ' + avgPrice + ' contracts ' + contracts + ' notionalValue ' + notionalValue);
        await this.recordMarginMapDelta(address, contractId,0,0,0,pnl,0,'rPNL')
      
        return pos
    }

    async recordMarginMapDelta(address, contractId, total, contracts, margin, uPNL, avgEntry, mode,block,mark){
            const newUuid = uuidv4();
            const dbInstance = await db.getDatabase('marginMapDelta');
            const deltaKey = `${address}-${contractId}-${newUuid}`;if (typeof contracts === 'object' && contracts.toNumber) {
                contracts = contracts.toNumber();
            }
            const delta = { address, contract: contractId, totalPosition: total, position: contracts, margin: margin, uPNL: uPNL, avgEntry, mode, block: block, lastPrice:mark};
            const ContractRegistry = require('./contractRegistry.js')
            console.log('saving marginMap delta ' + JSON.stringify(delta));

            try {
                // Try to find an existing document based on the key
                const existingDocument = await dbInstance.findOneAsync({ _id: deltaKey });

                if (existingDocument) {
                    // If the document exists, update it
                    await dbInstance.updateAsync({ _id: deltaKey }, { $set: { data: delta } });
                } else {
                    // If the document doesn't exist, insert a new one
                    await dbInstance.insertAsync({ _id: deltaKey, data: delta });
                }

                ContractRegistry.setModFlag(true)

                return; // Return success or handle as needed
            } catch (error) {
                console.error('Error saving marginMap delta:', error);
                throw error; // Rethrow the error or handle as needed
            }
    }


      /**
       * Allocate an IOU CLAIM for this match's imbalance delta (>0).
       * delta is the unfunded profit portion (e.g. buyerPnl + sellerPnl after loss caps).
       * We assign CLAIMS to whichever side(s) have positive pnl, proportional to their positive pnl.
       *
       * NOTE: This only mints claim amount == delta (not full pnl), so it won't double-pay.
       */
      /**
         * Allocate IOU CLAIMs for an unfunded PnL imbalance.
         *
         * @param {string} buyerAddress   address of buyer in this match
         * @param {string} sellerAddress  address of seller in this match
         * @param {number} buyerPnl       realized PnL for buyer (can be negative)
         * @param {number} sellerPnl      realized PnL for seller (can be negative)
         * @param {number} imbalanceDelta unfunded profit amount to be represented as IOUs (>0 only)
         */
      async applyIouClaimDelta(
          buyerAddress,
          sellerAddress,
          buyerPnl,
          sellerPnl,
          imbalanceDelta,
          contractId
        ) {
          const totalImbalance = new BigNumber(imbalanceDelta || 0);
          if (totalImbalance.lte(0)) return;

          const buyerPnlBN = new BigNumber(buyerPnl || 0);
          const sellerPnlBN = new BigNumber(sellerPnl || 0);

          const buyerPositivePnl = buyerPnlBN.gt(0) ? buyerPnlBN : new BigNumber(0);
          const sellerPositivePnl = sellerPnlBN.gt(0) ? sellerPnlBN : new BigNumber(0);

          const totalPositivePnl = buyerPositivePnl.plus(sellerPositivePnl);
          if (totalPositivePnl.lte(0)) return;

          const allPositions = await this.getAllPositions(contractId);
          if (!Array.isArray(allPositions)) return;

          const findPosition = (addr) =>
            allPositions.find(p => p.address === addr) || null;

          // Allocate buyer share
          if (buyerPositivePnl.gt(0) && buyerAddress) {
            const buyerPosition = findPosition(buyerAddress);
            if (buyerPosition) {
              const buyerShare = totalImbalance
                .times(buyerPositivePnl)
                .div(totalPositivePnl)
                .decimalPlaces(8);

              buyerPosition.iouClaim = new BigNumber(buyerPosition.iouClaim || 0)
                .plus(buyerShare)
                .decimalPlaces(8)
                .toNumber();
            }
          }

          // Allocate seller share
          if (sellerPositivePnl.gt(0) && sellerAddress) {
            const sellerPosition = findPosition(sellerAddress);
            if (sellerPosition) {
              const sellerShare = totalImbalance
                .times(sellerPositivePnl)
                .div(totalPositivePnl)
                .decimalPlaces(8);

              sellerPosition.iouClaim = new BigNumber(sellerPosition.iouClaim || 0)
                .plus(sellerShare)
                .decimalPlaces(8)
                .toNumber();
            }
          }
        }



    /*realizePnl(address, contracts, price, avgPrice, isInverse, notionalValue, pos) {
        //const pos = this.margins.get(address);

        if (!pos) return 0;

        let pnl;
        console.log('inside realizedPNL '+address + ' '+contracts + ' trade price ' +price + ' avg. entry '+avgPrice + ' is inverse '+ isInverse + ' notional '+notionalValue + ' position' +JSON.stringify(pos))
        if (isInverse) {
            // For inverse contracts: PnL = (1/entryPrice - 1/exitPrice) * contracts * notional
            pnl = (1 / avgPrice - 1 / price) * contracts * notionalValue;
            console.log('pnl '+pnl)
        } else {
            // For linear contracts: PnL = (exitPrice - entryPrice) * contracts * notional
            pnl = (price - avgPrice) * contracts * notionalValue;
            console.log('pnl '+(price - avgPrice), contracts, notionalValue, pnl)
        }

        //pos.margin -= Math.abs(pnl);
        //pos.unrealizedPl += pnl; //be sure to modify uPNL and scoop it out for this value...
        console.log('inside realizePnl '+price + ' price then avgPrice '+avgPrice +' contracts '+contracts + ' notionalValue '+notionalValue)
        return pnl;
    }*/

    async settlePNL(address, contracts, price, lastMark, contractId, currentBlockHeight,inverse,notional) {
                const pos = this.margins.get(address);
                console.log('pos at top of settle '+JSON.stringify(pos))
                const avgPriceBN = new BigNumber(pos.avgPrice);
                const priceBN = new BigNumber(price)
                const contractsBN = new BigNumber(contracts)
                if (!pos) return 0;
                const ContractRegistry = require('./contractRegistry.js')
                if (notional == null || isNaN(Number(notional))) {
                    // Lazy fetch from ContractRegistry
                    const info = await ContractRegistry.getContractInfo(contractId);
                    if (info && info.notionalValue != null) {
                        notional = info.notionalValue;
                    } else {
                        console.log('SOMEHOW CONTRACT INFO FAILED TO LOAD in SETTLEPNL')
                        // Couldn’t find it—fail this tx gracefully!
                        // e.g., return 0 or set pnl=0, maybe set a params.reason if you track validation
                        notional = 1; // or 0, or whatever "safe" fallback makes sense for your protocol
                    }
                }
                const notionalValueBN = new BigNumber(notional)
                // Check if the contract is associated with an orac
                let pnl = 0
                if(!inverse){
                     // Calculate PnL based on settlement price
                      if (lastMark == null){lastMark = pos.avgPrice;}
                console.log('inside settlePNL ' +lastMark+' '+price+' '+contracts)
                pnl = new BigNumber((price - lastMark) * contracts);
                console.log('calculated settle PNL '+pnl.toNumber()+' '+JSON.stringify(pnl))
                
                }else{
                      let one = new BigNumber(1)
            // For inverse contracts: PnL = (1/entryPrice - 1/exitPrice) * contracts * notional
                    if (lastMark == null){lastMark = pos.avgPrice;}
                     console.log('inside settlePNL ' +lastMark+' '+price+' '+contracts)
                    let lastMarkBN = new BigNumber(lastMark)
                    console.log('settlePNL: lastMarkBN', lastMarkBN.toString(), typeof lastMarkBN)
                    console.log('settlePNL: priceBN', priceBN.toString(), typeof priceBN)
                    console.log('settlePNL: contractsBN', contractsBN.toString(), typeof contractsBN)
                    console.log('settlePNL: notionalValueBN', notionalValueBN.toString(), typeof notionalValueBN)

                pnl = one.dividedBy(lastMarkBN).minus(one.dividedBy(priceBN))
                .times(contractsBN)
                .times(notionalValueBN)
                console.log('calculated settle PNL '+pnl.toNumber()+' '+JSON.stringify(pnl))
                }
                // Update margin and unrealized PnL
                //pos.margin -= Math.abs(pnl);
                const uPNLBN = new BigNumber(pos.unrealizedPNL)
                pos.unrealizedPNL -= uPNLBN.minus(pnl).decimalPlaces(8).toNumber();
                console.log('pos before save in settle '+JSON.stringify(pos))
                this.margins.set(pos.address, pos)
                await this.recordMarginMapDelta(address, contractId, pos.contracts, contracts, 0, -pnl, 0, 'settlementPNL', currentBlockHeight)
                  
                return pnl.decimalPlaces(8).toNumber();
        }

    /**
     * Estimate PnL between two prices for a given position.
     * Pure function: no side effects, no margin map mutations.
     *
     * @param {number} contracts - number of contracts (+long / -short)
     * @param {number} entryPrice - entry/mark price
     * @param {number} exitPrice  - settlement/strike price
     * @param {boolean} inverse   - contract type (true if inverse, false if linear)
     * @param {number} notional   - notional value per contract
     * @returns {number} estimated PnL in collateral units
     */
    estimatePNL(contracts, entryPrice, exitPrice, inverse, notional) {
        const contractsBN = new BigNumber(contracts);
        const entryBN = new BigNumber(entryPrice);
        const exitBN = new BigNumber(exitPrice);
        const notionalBN = new BigNumber(notional || 1);

        let pnl;

        if (!inverse) {
            // Linear contract: PnL = (exit - entry) * contracts
            pnl = exitBN.minus(entryBN).times(contractsBN);
        } else {
            // Inverse contract:
            // PnL = (1/entry - 1/exit) * contracts * notional
            const one = new BigNumber(1);
            pnl = one.div(entryBN).minus(one.div(exitBN))
                  .times(contractsBN)
                  .times(notionalBN);
        }

        return pnl.decimalPlaces(8).toNumber();
    }


    // === marginMap.js ===
    async applyOptionTrade(address, fullTicker, signedQty, tradePrice, blockHeight, creditMargin){
      // fetch or init the series-level blob for this address
      let pos = this.margins.get(address);
      if (!pos) {
        pos = {
          address,
          contractId: this.seriesId || null, // series scope
          contracts: 0,         // perp/futures core (untouched here)
          avgPrice: 0,          // perp/futures core (untouched here)
          unrealizedPNL: 0,     // perp/futures core (untouched here)
          margin: 0,            // series-level margin bucket (optional)
          options: {}           // per-option map
        };
      }
      if (!pos.options) pos.options = {};

      // fetch or init this specific option sub-position
      let optPos = pos.options[fullTicker] || { contracts: 0, avgPrice: 0, margin: 0 };

      const delta = Number(signedQty) || 0;
      const px    = Number(tradePrice) || 0;
      const before = Number(optPos.contracts) || 0;
      const after  = before + delta;


      const meta = Options.parseTicker(fullTicker);
      this._touchExpiryIndex(this, before, after, fullTicker, meta);

      // compute reduce/flip characteristics (for avgPrice update only)
      const beforeSign = Math.sign(before);
      const afterSign  = Math.sign(after);
      const isFlip     = (before !== 0 && delta !== 0 && beforeSign !== Math.sign(delta) && Math.abs(delta) > Math.abs(before));

      // update avgPrice:
      // - if same sign or opening from flat → weighted average
      // - if crossing to exactly zero → avg=0
      // - if flip to opposite sign → reset avg to trade price for the leftover
      if (after === 0) {
        optPos.avgPrice = 0;
      } else if (!isFlip && (before === 0 || beforeSign === afterSign)) {
        // weighted average only when growing in same direction or opening
        const numer = (before * optPos.avgPrice) + (delta * px);
        optPos.avgPrice = numer / after;
      } else {
        // flip: new side takes the trade price as new avg
        optPos.avgPrice = px;
      }

      // update signed contracts
      optPos.contracts = after;

      // margin: accumulate package credit if provided (seller side handled upstream)
      optPos.margin = Number(optPos.margin || 0) + Number(creditMargin || 0);

      // persist back
      pos.options[fullTicker] = optPos;
      this.margins.set(address, pos);

      // record delta
      await this.recordMarginMapDelta(
        address,
        fullTicker,
        after,               // position after
        delta,               // contracts delta
        px,                  // trade price
        0,                   // uPNL delta (none here)
        Number(creditMargin || 0), // margin delta
        'optionTrade',
        blockHeight
      );

      // return the updated sub-position (and some useful derived info if caller wants it)
      const closedQty = (before !== 0 && Math.sign(before) !== Math.sign(delta))
        ? Math.min(Math.abs(before), Math.abs(delta))
        : 0;
      const flipQty = (before !== 0 && Math.sign(before) !== Math.sign(delta) && Math.abs(delta) > Math.abs(before))
        ? (Math.abs(delta) - Math.abs(before))
        : 0;

      return {
        contracts: optPos.contracts,
        avgPrice: optPos.avgPrice,
        margin: optPos.margin,
        closedQty,
        flipQty
      };
    }

/**
 * Approximate liquidation price with option protection.
 * - For LONG underlying exposure: long puts cap downside → liqPrice = min(baseLiq, maxProtectStrike)
 * - For SHORT underlying: long calls cap upside → liqPrice = max(baseLiq, minProtectStrike)
 * Assumes hybrid series blob: pos.options[ticker] exists.
 *
 * @param {string} address
 * @param {number} baseLiqPrice   // your existing calcLiquidation result (perps/futures only)
 * @param {number} spot
 * @param {number} currentBlock
 * @returns {number} adjustedLiq
 */
    async calcLiquidationWithOptions(address, baseLiqPrice, spot, currentBlock) {
      const pos = this.margins.get(address) || {};
      const optionsBag = pos.options || {};
      if (!optionsBag || !Object.keys(optionsBag).length) return baseLiqPrice;

      // Determine net underlying side from your top-level series fields
      const netContracts = Number(pos.contracts || 0); // + long, - short
      if (netContracts === 0) return baseLiqPrice;

      let protectiveStrikes = [];

      for (const [ticker, o] of Object.entries(optionsBag)) {
        const meta = Options.parseTicker(ticker);
        if (!meta) continue;
        const qty = Number(o.contracts || 0);
        if (qty <= 0) continue; // protection only from LONG options
        // Only options that protect the direction matter
        if (netContracts > 0 && meta.type === 'Put') protectiveStrikes.push(Number(meta.strike || 0));
        if (netContracts < 0 && meta.type === 'Call') protectiveStrikes.push(Number(meta.strike || 0));
      }

      if (protectiveStrikes.length === 0) return baseLiqPrice;

      if (netContracts > 0) {
        // Long underlying: puts protect downside -> liq cannot be below protective put strike.
        const floor = Math.max(...protectiveStrikes);
        return Math.max(baseLiqPrice, floor);
      } else {
        // Short underlying: calls protect upside -> liq cannot be above protective call strike.
        const cap = Math.min(...protectiveStrikes);
        return Math.min(baseLiqPrice, cap);
      }
    }


    async updateMargin(address, contractId, newMargin, block,position) {
        console.log(`Updating margin for ${address} on contract ${contractId} to ${newMargin}`);

        // Ensure the position exists
        if(!position){ position = this.margins.get(address)};

        if (!position) {
            console.warn(`No position found for ${address} on contract ${contractId}, initializing a new one.`);
            position = {
                contracts: 0,
                margin: 0,
                unrealizedPNL: 0,
                avgPrice: 0,
            };
        }
        const marginBN = new BigNumber(position.margin)
        const marginChange = new BigNumber(newMargin).plus(marginBN).decimalPlaces(8).toNumber();
        // Update the margin
        position.margin = marginChange

        // Save the updated position
        this.margins.set(position.address, position);

        // Record the change in margin map deltas
        await this.recordMarginMapDelta(address, contractId, position.contracts, 0, marginChange, 0, 0, 'updateMargin',block);

        // Persist changes to the database
        await this.saveMarginMap(block);
        return position
        console.log(`Margin successfully updated for ${address} on contract ${contractId}`);
    }

    async clear(position, address, pnlChange, avgPrice,contractId,block,markPrice,oldPrice) {
            //const position = await this.getPositionForAddress(address,contractId)
            console.log('position before clear '+JSON.stringify(position))
            if(position.unrealizedPNL==null||position.unrealizedPNL==undefined){
                position.unrealizedPNL=0
            }
            position.oldMark = oldPrice
            position.lastMark = markPrice
            const uPNLBN = new BigNumber(position.unrealizedPNL)
            position.unrealizedPNL=new BigNumber(pnlChange).plus(uPNLBN).decimalPlaces(8).toNumber()
            this.margins.set(position.address, position)
            console.log('set clearing in position '+JSON.stringify(position))
            await this.writePositionToMap(contractId, position)

            await this.recordMarginMapDelta(address, contractId, position.contracts, 0, 0, pnlChange, avgPrice, 'markPrice',block,markPrice)
            return position
    }
    
    generateLiquidationOrder(position, contractId, amount, block, lastPrice, bankruptcyPrice) {
        if (!amount || amount <= 0) return null;
        if (position.contracts === 0) return null;

        const sell = position.contracts > 0;

        const equity = new BigNumber(position.margin || 0)
            .plus(position.available || 0);

        if (equity.lte(0)) return null;

        return {
            address: position.address,
            contractId,
            amount: Math.abs(amount),
            price: bankruptcyPrice.toNumber(),   // 🔑 THE boundary
            sell,
            isLiq: true,
            isMarket: true,            // market-style but bounded
            blockTime: block
        };
    }


   async saveLiquidationOrders(contractId, position, order,reason,blockHeight,liquidationLoss,contractsDeleveraged, realizedLiquidation, delverageResults, infoBlob) {
        try {
            // Access the liquidations database
            const liquidationsDB = await db.getDatabase('liquidations');

            // Construct the key and value for storing the liquidation orders
            const key = `liquidationOrders-${contractId}-${blockHeight}`;
            const value = {
                _id: key, // Ensure uniqueness by setting the _id field
                order: order,
                position: position,
                reason: reason,
                blockHeight: blockHeight,
                liquidationLoss: liquidationLoss,
                contractsDeleveraged: contractsDeleveraged,
                realizedLiquidation: realizedLiquidation,
                deleverage: delverageResults,
                info: infoBlob
            };

            // Use updateAsync with upsert to insert or update the document
            await liquidationsDB.updateAsync(
                { _id: key }, // Query to find the document
                { $set: value }, // Data to set/update
                { upsert: true } // Enable upsert (insert if not found)
            );

            console.log(`Successfully saved liquidation order for contract ${contractId} at block height ${blockHeight}`);
        } catch (error) {
            console.error(`Error saving liquidation orders for contract ${contractId} at block height ${blockHeight}:`, error);
            throw error;
        }
    }


    // =======================
    // simpleDeleverage - POOL-ONLY VERSION
    // - Uses vintage-aware matching
    // - Calls adjustDeleveraging() to shrink positions & move margin
    // - Returns ONLY pool distribution data (per-CP share of liquidationPool)
    // =======================
    async simpleDeleverage(
      positionCache,
      contractId,
      unfilledContracts,
      sell,
      liqPrice,
      liquidatingAddress,
      inverse,
      notional,
      block,
      markPrice,
      collateralId,      
      liquidationPool   // NEW (optional)
    ) {
      const BigNumber = require('bignumber.js');
      const bn = x => new BigNumber(x || 0);
      const DB = require('./db.js');
      const liquidationsDB = await DB.getDatabase('liquidations');


      const result = {
        contractId,
        liquidatingAddress,
        attemptedDeleverage: unfilledContracts,
        totalDeleveraged: 0,
        counterparties: [],
        poolAssignments: [] // NEW
      };

      let remaining = bn(unfilledContracts);

      // 1) Collect counterparties...
      let cps = positionCache
        .map((p, i) => ({ ...p, _i: i }))
        .filter(p => {
          if (p.address === liquidatingAddress) return false;
          return sell ? p.contracts < 0 : p.contracts > 0;
        });

        console.log(`[simpleDeleverage] liquidatingAddress=${liquidatingAddress} unfilledContracts=${unfilledContracts}`);
        console.log(`[simpleDeleverage] Total positions in cache: ${positionCache.length}`);
        console.log(`[simpleDeleverage] After filter, counterparties: ${cps.length}`);
        cps.forEach((cp, i) => {
          console.log(`  CP[${i}]: address=${cp.address} contracts=${cp.contracts} lastMark=${cp.lastMark}`);
        });

      // 2) Compute mark-to-mark PnL...
      cps = cps.map(p => {
        const size = bn(p.contracts);
        const last = bn(p.lastMark);
        const mark = bn(markPrice);

        let pnl = bn(0);
        if (last.gt(0) && mark.gt(0)) {
          if (!inverse) {
            pnl = size.times(mark.minus(last)).times(notional);
          } else {
            pnl = size.times(bn(1).div(last).minus(bn(1).div(mark)));
          }
        }

        return { ...p, movePnl: pnl };
      });

      // 3) Winners only
        const winners = cps.filter(p => p.movePnl.gt(0));

        // If no winners, FALL BACK to all opposite-side cps (net-0 guarantee path)
        if (winners.length === 0) {
          // keep cps as-is (already opposite side), optionally sort by size
          cps.sort((a, b) => Math.abs(b.contracts) - Math.abs(a.contracts));
        } else {
          cps = winners;

          // 4) Sort winners...
          cps.sort((a, b) => {
            const ap = a.movePnl.abs();
            const bp = b.movePnl.abs();
            if (!ap.eq(bp)) return bp.minus(ap).toNumber();
            return Math.abs(b.contracts) - Math.abs(a.contracts);
          });
        }

      // 4) Sort...
      cps.sort((a, b) => {
        const ap = a.movePnl.abs();
        const bp = b.movePnl.abs();
        if (!ap.eq(bp)) return bp.minus(ap).toNumber();
        return Math.abs(b.contracts) - Math.abs(a.contracts);
      });

      // 5) Deleveraging loop
      for (const cp of cps) {
        if (remaining.lte(0)) break;

        const absPos = Math.abs(cp.contracts);
        if (absPos <= 0) continue;

        const matchSize = Math.min(absPos, remaining.toNumber());

        const updatedPos = await this.adjustDeleveraging(
          positionCache,
          cp._i,
          cp.address,
          contractId,
          matchSize,
          sell,
          block,
          liqPrice
        );

        remaining = remaining.minus(matchSize);
        result.totalDeleveraged += matchSize;

        await liquidationsDB.updateAsync(
          {
            _id: `adl-${contractId}-${block}-${liquidatingAddress}-${cp.address}`
          },
          {
            _id: `adl-${contractId}-${block}-${liquidatingAddress}-${cp.address}`,
            block,
            contractId,
            liquidatingAddress,
            counterparty: cp.address,
            contractsReduced: matchSize,
            contractsBefore: cp.contracts,
            contractsAfter: updatedPos?.contracts ?? 0,
            markPrice,
            liqPrice,
            reason: 'autoDeleverage'
          },
          { upsert: true }
        );

        // NEW: capture weights for pool distribution
        result.counterparties.push({
          address: cp.address,
          matchSize,
          updatedPosition: updatedPos,
          _adlAbsPos: absPos,
          _adlMovePnl: cp.movePnl
        });
      }

      // NEW: produce poolAssignments so handleLiquidation can credit deleveragePoolCredit
      const poolBN = bn(liquidationPool);
      if (poolBN.gt(0) && result.counterparties.length > 0) {
        // weight by per-contract pnl * matched contracts
        let denom = bn(0);
        for (const cp of result.counterparties) {
          const perContract = bn(cp._adlMovePnl).div(bn(cp._adlAbsPos || 1));
          denom = denom.plus(perContract.times(bn(cp.matchSize)));
        }

        // fallback: just matchSize-proportional
        const totalMatched = bn(result.totalDeleveraged || 0);

        for (const cp of result.counterparties) {
          let share = bn(0);

          if (denom.gt(0)) {
            const perContract = bn(cp._adlMovePnl).div(bn(cp._adlAbsPos || 1));
            const w = perContract.times(bn(cp.matchSize));
            share = poolBN.times(w.div(denom));
          } else if (totalMatched.gt(0)) {
            share = poolBN.times(bn(cp.matchSize).div(totalMatched));
          }

          result.poolAssignments.push({
            address: cp.address,
            poolShare: share.dp(8).toNumber()
          });

          // cleanup internal fields (optional, but keeps logs sane)
          delete cp._adlAbsPos;
          delete cp._adlMovePnl;
        }
      }

      return result;
    }

    // =======================
    // calcPriceDelta - PnL helper
    // =======================
    calcPriceDelta(contracts, fromPrice, toPrice, isInverse, notional, isLong) {
      const c = new BigNumber(contracts);
      const f = new BigNumber(fromPrice);
      const t = new BigNumber(toPrice);
      const n = new BigNumber(notional || 1);

      let d;
      if (isInverse) {
        d = new BigNumber(1).div(f).minus(new BigNumber(1).div(t)).times(c).times(n);
      } else {
        d = t.minus(f).times(c).times(n);
      }
      
      return (isLong ? d : d.negated()).dp(8);
    }

    // =======================
    // adjustDeleveraging
    // =======================
    async adjustDeleveraging(
        positionCache,
        index,        
        address,
        contractId,
        size,
        sell,
        block,
        liqPrice
    ) {
        console.log(`Adjusting position for ${address}: reduce ${size} contracts on ${contractId}`);

        const ContractRegistry = require('./contractRegistry.js');
        const BigNumber = require('bignumber.js');

        let requestedSize = Number(size);
        if (!requestedSize || requestedSize <= 0) return positionCache[index];

        // Get position from cache by index
        let position = positionCache[index];
        if (!position || !position.contracts) return position;

        const before = Number(position.contracts);
        const maxReducible = Math.abs(before);
        if (maxReducible <= 0) return position;

        const effectiveSize = Math.min(requestedSize, maxReducible);
        
        // FIXED: Correct sign handling
        // If position is short (negative contracts) and we're deleveraging shorts,
        // we ADD contracts (make less negative)
        // If position is long (positive) and we're deleveraging longs,
        // we SUBTRACT contracts
        let contractChange;
        if (before > 0) {
          // Long position - reduce by subtracting
          contractChange = -effectiveSize;
        } else {
          // Short position - reduce by adding (making less negative)
          contractChange = effectiveSize;
        }

        const after = before + contractChange;
        
        // Handle potential sign flip - if we overshoot, clamp to 0
        if ((before > 0 && after < 0) || (before < 0 && after > 0)) {
          position.contracts = 0;
        } else {
          position.contracts = after;
        }

        // Return margin
        const initPerContract = await ContractRegistry.getInitialMargin(contractId, liqPrice);
        const collateral = await ContractRegistry.getCollateralId(contractId);

        let reduction = await this.reduceMargin(
            position,
            Math.abs(contractChange),
            initPerContract,
            contractId,
            address,
            sell,
            false,
            0
        );
        const Tally=require('./tally.js')
        const hasSufficient = await Tally.hasSufficientMargin(address, collateral, reduction);
        if (!hasSufficient.hasSufficient) {
            reduction = new BigNumber(reduction)
                .minus(hasSufficient.shortfall)
                .dp(8)
                .toNumber();
        }

        if (reduction !== 0) {
            await Tally.updateBalance(
                address,
                collateral,
                reduction,
                0,
                -reduction,
                0,
                'contractDelevMarginReturn',
                block
            );
        }

        await this.recordMarginMapDelta(
            address,
            contractId,
            after,        // delta totalPosition
            contractChange,        // delta position
            -reduction,            // delta margin
            0,                     // delta uPNL
            0,                     // delta avgPrice
            'deleverage'
        );

        if (position.contracts === 0) {
            position.bankruptcyPrice = null;
            position.averagePrice = null;
            position.unrealizedPNL = 0;
        }

        await this.recordMarginMapDelta(
            address,
            contractId,
            after,        // delta totalPosition
            contractChange,        // delta position
            -reduction,            // delta margin
            0,                     // delta uPNL
            0,                     // delta avgPrice
            'deleverage'
        );

        return position;
    }


    async dynamicDeleverage(contractId, side, unfilledContracts, liqPrice) {
        console.log(`Starting dynamic deleveraging for contract ${contractId} at liquidation price ${liqPrice}`);

        let remainingSize = new BigNumber(unfilledContracts);

        // Load marginMap instance for the given contractId
        const marginMap = await MarginMap.getInstance(contractId);

        // Fetch all positions from marginMap
        const allPositions = await marginMap.getAllPositions();

        // Load contract details for collateral filtering
        const contractInfo = await ContractRegistry.getContractInfo(contractId);
        const collateralId = contractInfo.collateralPropertyId;
        const notionalValue = new BigNumber(contractInfo.notionalValue);

        let potentialCounterparties = [];

        for (let position of allPositions) {
            if (position.contracts === 0) continue; // Skip inactive positions

            // Ensure the position belongs to the same collateral pool
            if (position.collateralId !== collateralId) continue;

            // Fetch available and reserved balances from TallyMap
            const tally = await TallyMap.getTally(position.address, collateralId);
            const availableCollateral = new BigNumber(tally.available);
            const reservedCollateral = new BigNumber(tally.reserved);

            // Calculate position notional value at liquidation price
            const positionNotional = notionalValue.times(Math.abs(position.contracts)).times(liqPrice);

            // Compute net exposure by summing positions for this collateral across all contracts
            const totalExposure = await calculateNetExposure(position.address, collateralId);

            // Ensure the side is opposite (we need shorts to absorb long liquidations and vice versa)
            const isCounterparty = side ? position.contracts < 0 : position.contracts > 0;

            if (isCounterparty) {
                // Calculate leverage = (position notional) / (available + reserved collateral)
                const totalCollateral = availableCollateral.plus(reservedCollateral);
                const leverage = totalCollateral.isZero() ? new BigNumber(Infinity) : positionNotional.dividedBy(totalCollateral);

                potentialCounterparties.push({
                    address: position.address,
                    contracts: position.contracts,
                    leverage,
                    exposure: totalExposure
                });
            }
        }

        // Sort counterparties by highest leverage, then by naked exposure (descending order)
        potentialCounterparties.sort((a, b) => {
            if (!b.exposure && a.exposure) return 1; // Prefer naked positions
            if (!a.exposure && b.exposure) return -1;
            return b.leverage.minus(a.leverage).toNumber(); // Highest leverage first
        });

        // Match positions for deleveraging
        for (let counterparty of potentialCounterparties) {
            if (remainingSize.isZero()) break;

            let absorbAmount = new BigNumber(Math.abs(counterparty.contracts));
            let matchedAmount = BigNumber.min(remainingSize, absorbAmount);

            console.log(`Matching ${matchedAmount} contracts to ${counterparty.address}`);

            await executeDeleveraging(counterparty.address, contractId, matchedAmount, side, liqPrice);

            remainingSize = remainingSize.minus(matchedAmount);
        }

        if (!remainingSize.isZero()) {
            console.log(`WARNING: Unable to fully deleverage ${remainingSize.toString()} contracts`);
        }
        console.log(`Deleveraging complete.`);
    }

// Helper function to compute net exposure across all contract positions for an address
async calculateNetExposure(address, collateralId) {
    const allContracts = await ContractRegistry.getContractsForCollateral(collateralId);
    let netExposure = new BigNumber(0);

    for (let contract of allContracts) {
        const marginMap = await MarginMap.getInstance(contract.contractId);
        const position = await marginMap.getPositionForAddress(address, contract.contractId);
        if (position) {
            netExposure = netExposure.plus(position.contracts);
        }
    }
    return netExposure;
}

// Helper function to execute deleveraging trade
async executeDeleveraging(address, contractId, size, side, liqPrice,block) {
    console.log(`Executing deleveraging: ${address} ${size} contracts at ${liqPrice}`);
    
    const marginMap = await MarginMap.getInstance(contractId);
    let position = await marginMap.getPositionForAddress(address, contractId);

    if (!position) return;

    position.contracts = new BigNumber(position.contracts).plus(side ? size : -size).toNumber();

    if (position.contracts === 0) {
        position.liqPrice = null;
        position.bankruptcyPrice = null;
    }

    marginMap.margins.set(position.address, position);
    await marginMap.saveMarginMap(block);
}

async fetchLiquidationVolume(blockHeight, contractId, mark) {
        const liquidationsDB = await db.getDatabase('liquidations');
        // Fetch liquidations from the database for the given contract and blockHeight
        let liquidations = []

        try {
                // Construct the key based on the provided structure
                const key = `liquidationOrders-${contractId}-${blockHeight}`;
                
                // Find the document with the constructed key
                liquidations = await liquidationsDB.findOneAsync({ _id: key });
            } catch (error) {
                console.error('Error fetching liquidations:', error);
            }
        // Initialize BigNumber instances
        let liquidatedContracts = new BigNumber(0);
        let filledLiqContracts = new BigNumber(0);
        let bankruptcyVWAPPreFill = new BigNumber(0);
        let filledVWAP = new BigNumber(0);
        let avgBankrupcyPrice = new BigNumber(0);
        let liquidationOrders = new BigNumber(0);
        let sells = new BigNumber(0);
        let buys = new BigNumber(0);

        // Calculate values using BigNumber
        if (liquidations && liquidations.length > 0) {
            liquidations.forEach(liquidation => {
                liquidationOrders = liquidationOrders.plus(1);
                liquidatedContracts = liquidatedContracts.plus(liquidation.contractCount);
                bankruptcyVWAPPreFill = bankruptcyVWAPPreFill.plus(new BigNumber(liquidation.size).times(new BigNumber(liquidation.bankruptcyPrice)));
                avgBankrupcyPrice = avgBankrupcyPrice.plus(new BigNumber(liquidation.bankruptcyPrice));
                if (liquidation.side == false) {
                    sells = sells.plus(0);
                } else if (liquidation.side == true) {
                    buys = buys.plus(0);
                }
            });
        }else{
            console.log("No liquidations found for the given criteria.");
        }

        bankruptcyVWAPPreFill = bankruptcyVWAPPreFill.dividedBy(liquidatedContracts);
        avgBankrupcyPrice = avgBankrupcyPrice.dividedBy(liquidationOrders);

        const tradeHistoryDB = await db.getDatabase('tradeHistory');
        const tradeKey = `liquidationOrders-${contractId}-${blockHeight}`;
        // Fetch trade history for the given blockHeight and contractId
        const trades = await tradeHistoryDB.findAsync();

        // Count the number of liquidation orders in the trade history
        let liquidationTradeMatches = new BigNumber(0);
        trades.forEach(trade => {
            if (trade.trade.isLiq === true&&trade.blockHeight==blockHeight) {
                liquidationTradeMatches = liquidationTradeMatches.plus(1);
                filledLiqContracts = filledLiqContracts.plus(trade.trade.amount);
                filledVWAP = filledVWAP.plus(trade.trade.tradePrice);
            }
        });
        filledVWAP = filledVWAP.dividedBy(filledLiqContracts);

        // Calculate the unfilled liquidation order contract count
        const unfilledLiquidationContracts = liquidatedContracts.minus(filledLiqContracts);
        const lossDelta = bankruptcyVWAPPreFill.minus(filledVWAP);

        return {
            liqTotal: liquidatedContracts.toNumber(),
            liqOrders: liquidationOrders.toNumber(),
            unfilled: unfilledLiquidationContracts.toNumber(),
            bankruptcyVWAPPreFill: bankruptcyVWAPPreFill.toNumber(),
            filledVWAP: filledVWAP.toNumber(),
            lossDelta: lossDelta.toNumber()
        };
    }


    needsLiquidation(contract) {
        const maintenanceMarginFactor = 0.05; // Maintenance margin is 5% of the notional value

        for (const [address, position] of Object.entries(this.margins[contract.id])) {
            const notionalValue = position.contracts * contract.marketPrice;
            const maintenanceMargin = notionalValue * maintenanceMarginFactor;

            if (position.margin < maintenanceMargin) {
                return true; // Needs liquidation
            }
        }
        return false; // No positions require liquidation
    }

async getPositionForAddress(address, contractId) {
    // This expects your loader to return { margins: array } 
    // where margins is like: [ [address, {contracts: ...}], ... ]

    const map = await MarginMap.loadMarginMap(contractId);
    const arr = map.margins

    console.log("[DEBUG] Loaded margin map addresses:", JSON.stringify(arr))
    console.log("[DEBUG] Looking for address:", address);

    // First try exact match
    for (const [addr, pos] of arr) {
        if (addr === address) {
            if (!pos.address) pos.address = addr;
            console.log("[DEBUG] Found exact match:", addr);
            return pos;
        }
    }

    // Fallback for Bech32 (case-insensitive)
    // Bech32-insensitive match for BTC + LTC mainnet/testnet
    if (
        address.startsWith('ltc1') || address.startsWith('tltc1') ||
        address.startsWith('bc1')  || address.startsWith('tb1')
    ) {
        for (const [addr, pos] of arr) {
            const lowerAddr = addr.toLowerCase();
            const lowerInput = address.toLowerCase();
            if (lowerAddr === lowerInput) {
                console.log("[DEBUG] Found Bech32 (BTC/LTC lowercase) match:", addr);
                if (!pos.address) pos.address = addr;
                return pos;
            }
        }
    }


    // Still not found
    console.log("[DEBUG] Address not found in margin map for contractId", contractId);
    return { contracts: 0, margin: 0, unrealizedPNL: 0 };
}

    async getMarketPrice(contract) {
        let marketPrice;

        if (ContractsRegistry.isOracleContract(contract.id)) {
            // Fetch the 3-block TWAP for oracle-based contracts
            marketPrice = await Oracles.getTwap(contract.id, 3); // Assuming the getTwap method accepts block count as an argument
        } else if (ContractsRegistry.isNativeContract(contract.id)) {
            // Fetch VWAP data for native contracts
            const contractInfo = ContractsRegistry.getContractInfo(contract.id);
            if (contractInfo && contractInfo.indexPair) {
                const [propertyId1, propertyId2] = contractInfo.indexPair;
                marketPrice = await VolumeIndex.getVwapData(propertyId1, propertyId2,3);
            }
        } else {
            throw new Error(`Unknown contract type for contract ID: ${contract.id}`);
        }

        return marketPrice;
    }

    async recordContractTrade(trade, blockHeight, sellerTx, buyerTx) {
            const tradeRecordKey = `contract-${trade.contractId}`;
            const tradeRecord = {
                key: tradeRecordKey,
                type: 'contract',
                trade,
                blockHeight,
                sellerTx,
                buyerTx
            };
            //console.log('saving contract trade ' +JSON.stringify(trade))
            await this.saveTrade(tradeRecord);
        }

        async saveTrade(tradeRecord) {
            const tradeDB =await db.getDatabase('tradeHistory');

            const uuid = uuidv4();

            // Use the key provided in the trade record for storage
            const tradeId = `${tradeRecord.key}-${uuid}-${tradeRecord.blockHeight}`;

            // Construct the document to be saved
            const tradeDoc = {
                _id: tradeId,
                ...tradeRecord
            };

            // Save or update the trade record in the database
            try {
                await tradeDB.updateAsync(
                    { _id: tradeId },
                    tradeDoc,
                    { upsert: true }
                );
                console.log(`Trade record saved successfully: ${tradeId}`);
            } catch (error) {
                //console.error(`Error saving trade record: ${tradeId}`, error);
                throw error; // Rethrow the error for handling upstream
            }
        }

}

module.exports = MarginMap
