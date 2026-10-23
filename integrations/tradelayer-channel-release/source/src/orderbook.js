const BigNumber = require('bignumber.js')
const dbInstance = require('./db.js'); // Import your database instance
const { v4: uuidv4 } = require('uuid');  // Import the v4 function from the uuid library
const TradeHistory = require('./tradeHistoryManager.js')
const ContractRegistry = require('./contractRegistry.js')
const VolumeIndex= require('./volumeIndex.js')
const Channels = require('./channels.js')
const ClearList = require('./clearlist.js')
const Consensus = require('./consensus.js')
const PnlIou = require('./iou.js')
const Clearing = require('./clearing.js')

// Helper: rank a single character with "alphabetical then numerical"
function addressCharRank(ch) {
    if (!ch) return { group: 2, char: '' }; // missing chars sort last
    const isDigit = ch >= '0' && ch <= '9';
    return {
        group: isDigit ? 1 : 0,      // 0 = letters, 1 = digits, 2 = missing
        char: ch.toLowerCase()
    };
}

// Helper: compare two sender addresses by last, then 2nd-last, then 3rd-last char
// Helper: compare two sender addresses by last, then 2nd-last, then 3rd-last char,
// with optional txid tie-break for full determinism
function compareSenderAddresses(a, b, txidA = null, txidB = null) {
    const aLen = a.length;
    const bLen = b.length;

    const aChars = [a[aLen - 1], a[aLen - 2], a[aLen - 3]];
    const bChars = [b[bLen - 1], b[bLen - 2], b[bLen - 3]];

    for (let i = 0; i < 3; i++) {
        const ra = addressCharRank(aChars[i]);
        const rb = addressCharRank(bChars[i]);

        if (ra.group !== rb.group) return ra.group - rb.group;
        if (ra.char < rb.char) return -1;
        if (ra.char > rb.char) return 1;
    }

    // fallback: full address lexicographically
    const addrCmp = a.localeCompare(b);
    if (addrCmp !== 0) return addrCmp;

    // FINAL deterministic tie-breaker (optional)
    if (txidA && txidB) {
        return txidA.localeCompare(txidB);
    }

    return 0;
}


class Orderbook {
      constructor(orderBookKey, tickSize = new BigNumber('0.00000001')) {
            this.tickSize = tickSize;
            this.orderBookKey = orderBookKey; // Unique identifier for each orderbook (contractId or propertyId pair)
            this.orderBooks = {};
            this.block = 1
            //this.loadOrderBook(); // Load or create an order book based on the orderBookKey
        }
         // Static async method to get an instance of Orderbook
        static async getOrderbookInstance(orderBookKey) {
            const orderbook = new Orderbook(orderBookKey); // Create instance
            orderbook.orderBooks[orderBookKey] = await orderbook.loadOrderBook(orderBookKey); // Load orderbook
            console.log("Returning Orderbook instance:", orderbook);
            return orderbook;
        }

        async loadOrderBook(key) {
                const stringKey = typeof key === 'string' ? key : String(key);
                const orderBooksDB = await dbInstance.getDatabase('orderBooks');
              
                try {
                    const orderBookData = await orderBooksDB.findOneAsync({ _id: stringKey });
                    if (orderBookData && orderBookData.value) {
                        const parsedOrderBook = JSON.parse(orderBookData.value);
                        this.orderBooks[key] = parsedOrderBook;
                        //console.log('loading the orderbook in check from addr '+addr+' for ' + key + ' in the form of ' + JSON.stringify(parsedOrderBook.buy));
                        return parsedOrderBook; // Return the parsed order book
                    } else {
                        console.log('new orderbook for ' + key);
                        return { buy: [], sell: [] };
                    }
                } catch (error) {
                    console.error('Error loading or parsing order book data:', error);
                    return { buy: [], sell: [] }; // Return an empty order book on error
                }
            }

            async saveOrderBook(orderbookData, key) {
                const stringKey = String(key);  // 🔒 normalize always to string
                console.log('saving orderbook with key ' + stringKey);

                const orderBooksDB = await dbInstance.getDatabase('orderBooks');

                await orderBooksDB.updateAsync(
                    { _id: stringKey },
                    { _id: stringKey, value: JSON.stringify(orderbookData) },
                    { upsert: true }
                );

                return;
            }


           async saveTrade(tradeRecord) {
            const tradeDB =await dbInstance.getDatabase('tradeHistory');

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
                //console.log(`Trade record saved successfully: ${tradeId}`);
            } catch (error) {
                //console.error(`Error saving trade record: ${tradeId}`, error);
                throw error; // Rethrow the error for handling upstream
            }
        }

                // Record a token trade with specific key identifiers
        async recordTokenTrade(trade, blockHeight, txid) {
            const tradeRecordKey = `token-${trade.offeredPropertyId}-${trade.desiredPropertyId}`;
            const tradeRecord = {
                key: tradeRecordKey,
                type: 'token',
                trade,
                blockHeight,
                txid
            };
            await this.saveTrade(tradeRecord);
        }

        // Record a contract trade with specific key identifiers
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
        // Retrieve token trading history by propertyId pair
        static async getTokenTradeHistoryByPropertyIdPair(propertyId1, propertyId2) {
                const tradeDB = await dbInstance.getDatabase('tradeHistory');
                const tradeRecordKey = `token-${propertyId1}-${propertyId2}`;
                const trades = await tradeDB.findAsync({ key: tradeRecordKey });
                return trades.map(doc => doc.trade);
        }

        // Retrieve contract trading history by contractId
        static async getContractTradeHistoryByContractId(contractId) {
                //console.log('loading trade history for '+contractId)
                const tradeDB = await dbInstance.getDatabase('tradeHistory');
                const tradeRecordKey = `contract-${contractId}`;
                const trades = await tradeDB.findAsync({ key: tradeRecordKey });
                return trades.map(doc => doc.trade);
        }

        // Retrieve trade history by address for both token and contract trades
        static async getTradeHistoryByAddress(address) {
                const tradeDB = await dbInstance.getDatabase('tradeHistory');
                const trades = await tradeDB.findAsync({ 
                    $or: [{ 'trade.sender': address }, { 'trade.receiverAddress': address }]
                });
                return trades.map(doc => doc.trade);
        }

        // Function to divide two numbers with an option to round up or down to the nearest Satoshi
        divideAndRound(number1, number2, roundUp = false) {
            const result = new BigNumber(number1).dividedBy(new BigNumber(number2));
            return roundUp
                ? result.decimalPlaces(8, BigNumber.ROUND_UP).toString()
                : result.decimalPlaces(8, BigNumber.ROUND_DOWN).toString();
        }

                // Ensure we have the global pending queue
            // --- DB-backed on-chain order queue using the orderbook DB ---
        static async _getOrderbookDB() {
            // IMPORTANT: use the same name you already use for the orderbook collection
            // e.g. dbInstance.getDatabase('orderbook') or dbInstance.getDatabase('orderBooks')
            return dbInstance.getDatabase('orderBooks');
        }

        static async _addActivePair(pairKey) {
            const db = await this._getOrderbookDB();
            const doc = await db.findOneAsync({ _id: 'activePairs' });
            let pairs = (doc && Array.isArray(doc.pairs)) ? doc.pairs : [];

            if (!pairs.includes(pairKey)) {
                pairs.push(pairKey);
                await db.updateAsync(
                    { _id: 'activePairs' },
                    { _id: 'activePairs', pairs },
                    { upsert: true }
                );
                await db.loadDatabase();
            }
        }

        static async _updateActivePairs(pairs) {
            const db = await this._getOrderbookDB();
            await db.updateAsync(
                { _id: 'activePairs' },
                { _id: 'activePairs', pairs },
                { upsert: true }
            );
            await db.loadDatabase();
        }

        /**
         * Queue a token:token on-chain order (tx type 5) under key "queue-<pairKey>".
         */
        static async queueOnChainTokenOrder(orderBookKey, sender, order, blockHeight, txid) {
            const db = await this._getOrderbookDB();
            const pairKey = String(orderBookKey);
            const queueId = `queue-${pairKey}`;

            const doc = await db.findOneAsync({ _id: queueId });
            const entries = (doc && Array.isArray(doc.orders)) ? doc.orders : [];

            entries.push({
                kind: 'token',
                orderBookKey: pairKey,
                sender,
                blockHeight: Number(blockHeight),
                txid,
                order
            });

            await db.updateAsync(
                { _id: queueId },
                { _id: queueId, orders: entries },
                { upsert: true }
            );
            await db.loadDatabase();
            await this._addActivePair(pairKey);
        }

        /**
         * Queue a contract on-chain order (tx type 18) under key "queue-<contractId>".
         */
        static async queueOnChainContractOrder(contractId, sender, params, blockHeight, txid) {
            const db = await this._getOrderbookDB();
            const pairKey = String(contractId);       // reuse the same pattern
            const queueId = `queue-${pairKey}`;

            const doc = await db.findOneAsync({ _id: queueId });
            const entries = (doc && Array.isArray(doc.orders)) ? doc.orders : [];

            entries.push({
                kind: 'contract',
                orderBookKey: pairKey,
                sender,
                blockHeight: Number(blockHeight),
                txid,
                params
            });

            await db.updateAsync(
                { _id: queueId },
                { _id: queueId, orders: entries },
                { upsert: true }
            );
            await db.loadDatabase();
            await this._addActivePair(pairKey);
        }

        /**
         * For a given blockHeight:
         *  - read "activePairs"
         *  - for each pair, read "queue-<pair>"
         *  - split entries into thisBlock / remaining
         *  - sort thisBlock by canonical tail-char sender order
         *  - chaingun addTokenOrder / addContractOrder
         *  - write back remaining, clean up activePairs for empty queues
         */
        static async processQueuedOnChainOrdersForBlock(blockHeight) {
            const height = Number(blockHeight);
            const db = await this._getOrderbookDB();

            const activeDoc = await db.findOneAsync({ _id: 'activePairs' });
            if (!activeDoc || !Array.isArray(activeDoc.pairs) || activeDoc.pairs.length === 0) {
                return;
            }

            let activePairs = activeDoc.pairs.slice();

            for (const pairKey of activeDoc.pairs) {
                const queueId = `queue-${pairKey}`;
                const qDoc = await db.findOneAsync({ _id: queueId });

                if (!qDoc || !Array.isArray(qDoc.orders) || qDoc.orders.length === 0) {
                    // Nothing queued; ensure the pair doesn't linger in activePairs
                    activePairs = activePairs.filter(k => k !== pairKey);
                    await db.updateAsync(
                        { _id: queueId },
                        { _id: queueId, orders: [] },
                        { upsert: true }
                    );
                    continue;
                }

                const entries = qDoc.orders;
                const ready = [];
                const future = [];

                // ✅ process all orders whose blockHeight <= current height
                for (const entry of entries) {
                    const entryHeight = Number(entry.blockHeight);
                    if (!isNaN(entryHeight) && entryHeight <= height) {
                        ready.push(entry);
                    } else {
                        future.push(entry);
                    }
                }

                if (ready.length === 0) {
                    // No work for this height for this pair; still persist shrunk queue if needed
                    if (future.length !== entries.length) {
                        await db.updateAsync(
                            { _id: queueId },
                            { _id: queueId, orders: future },
                            { upsert: true }
                        );
                    }
                    if (future.length === 0) {
                        activePairs = activePairs.filter(k => k !== pairKey);
                    }
                    continue;
                }

                // Deterministic ordering: first by blockHeight, then by sender
                ready.sort((a, b) => {
                    const ha = Number(a.blockHeight);
                    const hb = Number(b.blockHeight);
                    if (ha !== hb) return ha - hb;
                    return compareSenderAddresses(a.sender, b.sender,a.txid,b.txid);
                });

                const orderbook = await Orderbook.getOrderbookInstance(pairKey);

                for (const entry of ready) {
                    if (entry.kind === 'token') {
                        await orderbook.addTokenOrder(
                            entry.order,
                            entry.blockHeight,
                            entry.txid
                        );
                    } else if (entry.kind === 'contract') {
                        const p = entry.params;
                        const matchResult = await orderbook.addContractOrder(
                            p.contractId,
                            p.price,
                            p.amount,
                            p.sell,
                            p.insurance,
                            p.blockTime,   // using blockTime as you had it
                            entry.txid,
                            entry.sender,
                            p.isLiq || false,
                            p.reduce,
                            p.post,
                            p.stop,
                            orderbook      // ✅ pass the existing instance through
                        );
                        //console.log(' match result ' + JSON.stringify(matchResult));
                    }
                }

                // Debug: show loaded book & height, preserve your throw
                const data = await orderbook.loadOrderBook(pairKey);
                
                // ✅ Write back only truly future entries for this pair
                await db.updateAsync(
                    { _id: queueId },
                    { _id: queueId, orders: future },
                    { upsert: true }
                );

                // If nothing left queued at all for this pair, drop it from activePairs
                if (future.length === 0) {
                    activePairs = activePairs.filter(k => k !== pairKey);
                }
            }

            // Persist the shrunk activePairs set
            await this._updateActivePairs(activePairs);
        }

        /**
         * Queue a CHANNEL trade (token or contract) for deterministic processing.
         */
        static async queueChannelTrade(kind, pairKey, sender, match, blockHeight, txid) {
            const db = await this._getOrderbookDB();
            const queueId = `channel-queue-${pairKey}`;

            const doc = await db.findOneAsync({ _id: queueId });
            const trades = (doc && Array.isArray(doc.trades)) ? doc.trades : [];

            trades.push({
                kind,                  // 'token' | 'contract'
                pairKey: String(pairKey),
                sender,                // canonical ordering key (commit address / multisig)
                blockHeight: Number(blockHeight),
                txid,
                match                  // ✅ already fully-formed
            });

            await db.updateAsync(
                { _id: queueId },
                { _id: queueId, trades },
                { upsert: true }
            );

            await db.loadDatabase();
            await this._addActivePair(`channel-${pairKey}`);
        }


        static async processQueuedChannelTradesForBlock(blockHeight) {
            const height = Number(blockHeight);
            const db = await this._getOrderbookDB();

            const activeDoc = await db.findOneAsync({ _id: 'activePairs' });
            if (!activeDoc?.pairs?.length) return;

            let activePairs = activeDoc.pairs.slice();

            for (const pair of activeDoc.pairs) {
                if (!pair.startsWith('channel-')) continue;

                const pairKey = pair.replace('channel-', '');
                const queueId = `channel-queue-${pairKey}`;
                const qDoc = await db.findOneAsync({ _id: queueId });

                if (!qDoc?.trades?.length) {
                    activePairs = activePairs.filter(p => p !== pair);
                    continue;
                }

                const ready = [];
                const future = [];

                for (const t of qDoc.trades) {
                    if (Number(t.blockHeight) <= height) ready.push(t);
                    else future.push(t);
                }

                if (ready.length === 0) continue;

                // ✅ CANONICAL SIEVE (same rule everywhere)
                ready.sort((a, b) => {
                    if (a.blockHeight !== b.blockHeight) {
                        return a.blockHeight - b.blockHeight;
                    }
                    const s = compareSenderAddresses(a.sender, b.sender,a.txid,b.txid);
                    if (s !== 0) return s;
                    return a.txid.localeCompare(b.txid);
                });

                const orderbook = await Orderbook.getOrderbookInstance(pairKey);

                for (const entry of ready) {
                    if (entry.kind === 'token') {
                        await orderbook.processTokenMatches(
                            [entry.payload.match],
                            entry.blockHeight,
                            entry.txid,
                            true
                        );
                    } else if (entry.kind === 'contract') {
                        await orderbook.processContractMatches(
                            [entry.payload.match],
                            entry.blockHeight,
                            true
                        );
                    }
                }

                await db.updateAsync(
                    { _id: queueId },
                    { _id: queueId, trades: future },
                    { upsert: true }
                );

                if (future.length === 0) {
                    activePairs = activePairs.filter(p => p !== pair);
                }
            }

            await this._updateActivePairs(activePairs);
        }

        // Adds a token order to the order book
        async addTokenOrder(order, blockHeight, txid) {
         
            const TallyMap = require('./tally.js'); //lazy load so we can move available to reserved for this order
            await TallyMap.updateBalance(order.sender, order.offeredPropertyId, -order.amountOffered, order.amountOffered, 0, 0,'tokenOrder',blockHeight);
            
            // Determine the correct orderbook key
            const normalizedOrderBookKey = this.normalizeOrderBookKey(order.offeredPropertyId, order.desiredPropertyId);
            //console.log('Normalized Order Book Key:', normalizedOrderBookKey);
           
            // Create an instance of Orderbook for the pair and load its data
            const orderbook = new Orderbook(normalizedOrderBookKey);
            var orderbookData = await orderbook.loadOrderBook(normalizedOrderBookKey,false);
            //console.log('loaded orderbook' +JSON.stringify(orderbookData))
            // Calculate the price for the order and round to the nearest tick interval
            const calculatedPrice = this.calculatePrice(order.amountOffered, order.amountExpected);
            console.log('Calculated Token  Price:' + calculatedPrice+' '+txid);
            order.price = calculatedPrice; // Append the calculated price to the order object
            order.txid= txid.slice(0,3)+txid.slice(-4)

            // Determine if the order is a sell order
            const isSellOrder = Boolean(order.offeredPropertyId < order.desiredPropertyId);

            // Add the order to the orderbook
            orderbookData = await orderbook.insertOrder(order, orderbookData, isSellOrder,false);
            //console.log('Order Insertion Confirmation:', orderbookData);

            // Match orders in the orderbook
            const matchResult = await orderbook.matchTokenOrders(orderbookData);
            if (matchResult.matches && matchResult.matches.length > 0) {
                //console.log('Match Result:', matchResult);
                await orderbook.processTokenMatches(matchResult.matches, blockHeight, txid, false);
            }else{console.log('No Matches for ' +txid)}
            console.log('Normalized Order Book Key before saving:', normalizedOrderBookKey);
            //console.log('getting ready to save orderbook update '+JSON.stringify(matchResult.orderBook))
            // Save the updated orderbook back to the database
            await orderbook.saveOrderBook(matchResult.orderBook,normalizedOrderBookKey);

            return matchResult;
        }

         /**
         * Get the total reserved margin for a specific address across buy and sell orders
         * @param {string} address - The address whose reserved margin is being calculated
         * @returns {BigNumber} - Total reserved margin for the address
         */
        getReserveByAddress(address,key) {
            const stringKey = typeof key === 'string' ? key : String(key);

            let totalReserved = new BigNumber(0);
            for (const side of ["buy", "sell"]) {
                console.log('inside get reserve by addr book '+JSON.stringify(this.orderBooks))
                if (!this.orderBooks[stringKey][side]) continue;
                for (const order of this.orderBooks[stringKey][side]) {
                    if ((order.sender || order.address) === address) {
                        console.log('in getReserveByAddr '+totalReserved.toNumber())
                        totalReserved = totalReserved.plus(order.initMargin || 0);
                    }
                }
            }
            return totalReserved;
        }

        normalizeOrderBookKey(propertyId1, propertyId2) {
            // Ensure lower property ID is first in the key
            return propertyId1 < propertyId2 ? `${propertyId1}-${propertyId2}` : `${propertyId2}-${propertyId1}`;
        }

       async insertOrder(order, orderbookData, isSellOrder, isLiq) {

            if (typeof orderbookData === 'string') {
                try {
                    orderbookData = JSON.parse(orderbookData);
                } catch (e) {
                    console.error('Failed to parse orderbook data:', orderbookData);
                    return; // Exit if parsing fails to prevent further issues
                }
            }

            /*if (!this.isValidOrderbook(orderbookData,contract)) {

 
 +                    console.error('Invalid orderbook data:', JSON.stringify(orderbookData));
                return orderbookData; // Return early to avoid corrupting the orderbook
            }*/
            if (!orderbookData) {
                orderbookData = { buy: [], sell: [] };
            }

            // Log the current state for debugging
            //console.log('Order:', JSON.stringify(order));
            //console.log('Orderbook data before:', JSON.stringify(orderbookData));
            //console.log('Is sell order:', isSellOrder);

            // Determine the side of the order
            //console.log('is sell?'+isSellOrder)
            const side = isSellOrder ? 'sell' : 'buy';
            //console.log('side '+side)
            let bookSide = orderbookData[side];
            //console.log('book side '+JSON.stringify(bookSide))
            // Ensure bookSide is initialized if undefined
            if (!bookSide) {
                bookSide = [];
            }

            // Log the state of bookSide for debugging
            //console.log('Book side before:', JSON.stringify(bookSide));

            // Find the appropriate index to insert the new order
            const index = bookSide.findIndex((o) => o.time > order.time);
            if (index === -1) {
                bookSide.push(order); // Append to the end if no larger time is found
            } else {
                bookSide.splice(index, 0, order); // Insert at the found index
            }

            // Reintegrate bookSide back into orderbookData correctly
            orderbookData[side] = bookSide;

            // Log the updated orderbookData for debugging
            //console.log('Updated orderbook data:', JSON.stringify(orderbookData));

            return orderbookData;
        }

        isValidOrderbook(data,contract) {
            if (typeof data !== 'object' || data === null) return false;

            const hasBuySell = data.hasOwnProperty('buy') && data.hasOwnProperty('sell');
            const isValidBuyArray = Array.isArray(data.buy) && (data.buy.length === 0 || data.buy.every(this.isValidOrder,contract));
            const isValidSellArray = Array.isArray(data.sell) && (data.sell.length === 0 || data.sell.every(this.isValidOrder,contract));

            console.log(isValidBuyArray, isValidSellArray)
            console.log(data.buy.length===0, data.sell.length===0)


            return hasBuySell && isValidBuyArray && isValidSellArray;
        }

       isValidOrder(order, contract) {
            const hasRequiredFields = order.hasOwnProperty('offeredPropertyId') &&
                order.hasOwnProperty('desiredPropertyId') &&
                order.hasOwnProperty('amountOffered') &&
                order.hasOwnProperty('amountExpected') &&
                order.hasOwnProperty('blockTime') &&
                order.hasOwnProperty('sender') &&
                order.hasOwnProperty('price');

            const hasValidTypes = typeof order.offeredPropertyId === 'number' &&
                typeof order.desiredPropertyId === 'number' &&
                typeof order.amountOffered === 'number' &&
                typeof order.amountExpected === 'number' &&
                typeof order.blockTime === 'number' &&
                typeof order.sender === 'string' &&
                typeof order.price === 'number';

            if (contract==true||contract==null) {
                const hasContractFields = order.hasOwnProperty('contractId') &&
                    order.hasOwnProperty('amount') &&
                    order.hasOwnProperty('side') &&
                    order.hasOwnProperty('initMargin') &&
                    order.hasOwnProperty('txid') &&
                    order.hasOwnProperty('isLiq') &&
                    order.hasOwnProperty('reduce') &&
                    order.hasOwnProperty('post');

                const hasValidContractTypes = typeof order.contractId === 'number' &&
                    typeof order.amount === 'number' &&
                    typeof order.side === 'boolean' &&
                    typeof order.initMargin === 'number' &&
                    typeof order.txid === 'string' &&
                    typeof order.isLiq === 'boolean' &&
                    typeof order.reduce === 'boolean' &&
                    typeof order.post === 'boolean';

                return hasContractFields && hasValidContractTypes;
            }

            return hasRequiredFields && hasValidTypes;
        }


        calculatePrice(amountOffered, amountExpected) {
            const priceRatio = new BigNumber(amountOffered).dividedBy(amountExpected);
            //console.log('price ratio '+priceRatio)
            return priceRatio.decimalPlaces(8, BigNumber.ROUND_HALF_UP).toNumber();
        }
    
    async matchTokenOrders(orderbookData) {
        if (!orderbookData || typeof orderbookData !== 'object') {
            console.error("⚠️ Invalid orderbookData received:", orderbookData);
            return { orderBook: { buy: [], sell: [] }, matches: [] };
        }

        let orderBookCopy = {
            buy: Array.isArray(orderbookData.buy) ? [...orderbookData.buy] : [],
            sell: Array.isArray(orderbookData.sell) ? [...orderbookData.sell] : []
        };

        console.log(`📊 Matching orders... Buy: ${orderBookCopy.buy.length}, Sell: ${orderBookCopy.sell.length}`);

        let matches = [];

        // Sort buy and sell orders
        if (orderBookCopy.buy.length > 0) {
            orderBookCopy.buy.sort((a, b) => new BigNumber(b.price).comparedTo(a.price) || a.blockTime - b.blockTime);
        }
        if (orderBookCopy.sell.length > 0) {
            orderBookCopy.sell.sort((a, b) => new BigNumber(a.price).comparedTo(b.price) || a.blockTime - b.blockTime);
        }

        console.log(`📈 Orders sorted, beginning matching process...`);

        let iterationLimit = 1000;
        let iterationCount = 0;

        for (; orderBookCopy.buy.length > 0 && orderBookCopy.sell.length > 0; iterationCount++) {
            if (iterationCount >= iterationLimit) {
                console.warn(`⚠️ Match execution limit reached! Exiting.`);
                break;
            }

            let sellOrder = orderBookCopy.sell[0];
            let buyOrder = orderBookCopy.buy[0];

            // Ensure matching distinct property IDs
            if (sellOrder.offeredPropertyId !== buyOrder.desiredPropertyId || sellOrder.desiredPropertyId !== buyOrder.offeredPropertyId) {
                console.warn(`⚠️ Mismatched property IDs, skipping orders.`);
                break;
            }

            let tradePrice;
            let bumpTrade = false;
            let post = false;
            sellOrder.maker = false;
            buyOrder.maker = false;

            // Handle trades in the same block
            if (sellOrder.blockTime === buyOrder.blockTime) {
                tradePrice = buyOrder.price;
                if (sellOrder.post) {
                    tradePrice = sellOrder.price;
                    post = true;
                    sellOrder.maker = true;
                } else if (buyOrder.post) {
                    tradePrice = buyOrder.price;
                    post = true;
                    buyOrder.maker = true;
                }
                sellOrder.flat = true;
            } else {
                tradePrice = sellOrder.blockTime < buyOrder.blockTime ? sellOrder.price : buyOrder.price;
                if ((sellOrder.blockTime < buyOrder.blockTime && buyOrder.post) || 
                    (buyOrder.blockTime < sellOrder.blockTime && sellOrder.post)) {
                    bumpTrade = true;
                }
                if (sellOrder.blockTime < buyOrder.blockTime && !bumpTrade) {
                    sellOrder.maker = true;
                } else if (sellOrder.blockTime > buyOrder.blockTime && !bumpTrade) {
                    buyOrder.maker = true;
                }
            }

            if (sellOrder.sender === buyOrder.sender) {
                console.log(`🔄 Self-trade detected, removing maker order.`);
                if (sellOrder.maker) {
                    orderBookCopy.sell.shift();
                } else if (buyOrder.maker) {
                    orderBookCopy.buy.shift();
                }
                continue;
            }

            // Check for price match
            if (new BigNumber(buyOrder.price).isGreaterThanOrEqualTo(sellOrder.price)) {
                let sellAmountOffered = new BigNumber(sellOrder.amountOffered);
                let sellAmountExpected = new BigNumber(sellOrder.amountExpected);
                let buyAmountOffered = new BigNumber(buyOrder.amountOffered);
                let buyAmountExpected = new BigNumber(buyOrder.amountExpected);

                let tradeAmountA = BigNumber.min(sellAmountOffered, buyAmountExpected);
                let tradeAmountB = tradeAmountA.times(tradePrice);

                console.log(`🔄 Processing trade - Amount A: ${tradeAmountA}, Amount B: ${tradeAmountB}`);

                if (!bumpTrade) {
                    sellOrder.amountOffered = sellAmountOffered.minus(tradeAmountA).toNumber();
                    buyOrder.amountOffered = buyAmountOffered.minus(tradeAmountB).toNumber();
                    sellOrder.amountExpected = sellAmountExpected.minus(tradeAmountB).toNumber();
                    buyOrder.amountExpected = buyAmountExpected.minus(tradeAmountA).toNumber();

                    matches.push({
                        sellOrder: {...sellOrder, amountOffered: tradeAmountA.toNumber()},
                        buyOrder: {...buyOrder, amountExpected: tradeAmountB.toNumber()},
                        amountOfTokenA: tradeAmountA.toNumber(),
                        amountOfTokenB: tradeAmountB.toNumber(),
                        tradePrice,
                        post,
                        bumpTrade
                    });

                    if (sellOrder.amountOffered === 0) {
                        orderBookCopy.sell.shift();
                    } else {
                        orderBookCopy.sell[0] = sellOrder;
                    }

                    if (buyOrder.amountExpected === 0) {
                        orderBookCopy.buy.shift();
                    } else {
                        orderBookCopy.buy[0] = buyOrder;
                    }
                } else {
                    if (buyOrder.post) {
                        buyOrder.price = sellOrder.price - this.tickSize;
                    }
                    if (sellOrder.post) {
                        sellOrder.price = buyOrder.price + this.tickSize;
                    }
                }
            } else {
                console.log(`❌ No price match, stopping execution.`);
                break;
            }
        }

        console.log(`✅ Matching complete. Trades executed: ${matches.length}`);
        return { orderBook: orderBookCopy, matches: matches };
    }

    async processTokenMatches(matches, blockHeight, txid, channel) {
      if (!Array.isArray(matches) || matches.length === 0) {
        console.log('No valid matches to process');
        return;
      }

      // If it’s a channel fill, divert to channel handler and return early
      if (channel) {
        await this.processTokenChannelTrades(matches, blockHeight, txid);
        return;
      }

      for (const match of matches) {
        if (!match.sellOrder || !match.buyOrder) {
          console.error('Invalid match object:', match);
          continue;
        }

        const sellOrderAddress = match.sellOrder.senderAddress;
        const buyOrderAddress  = match.buyOrder.senderAddress;
        const sellOrderPropertyId = match.sellOrder.offeredPropertyId;   // Token A
        const buyOrderPropertyId  = match.buyOrder.desiredPropertyId;    // Token B

        // Tag maker/taker by time (stable, deterministic)
        if (match.sellOrder.blockTime < match.buyOrder.blockTime) {
          match.sellOrder.orderRole = 'maker';
          match.buyOrder.orderRole  = 'taker';
        } else if (match.buyOrder.blockTime < match.sellOrder.blockTime) {
          match.buyOrder.orderRole  = 'maker';
          match.sellOrder.orderRole = 'taker';
        } else {
          match.buyOrder.orderRole  = 'split';
          match.sellOrder.orderRole = 'split';
        }

        const amountToTradeA = new BigNumber(match.amountOfTokenA); // seller gives A
        const amountToTradeB = new BigNumber(match.amountOfTokenB); // buyer gives B

        let takerFee = new BigNumber(0);
        let makerRebate = new BigNumber(0);

        // Fees: 2 bps taker; 50% rebate to maker (1 bp); 1 bp retained as exchange fee.
        if (match.sellOrder.orderRole === 'maker' && match.buyOrder.orderRole === 'taker') {
          // taker pays in the asset they are giving (Token B here)
          takerFee    = amountToTradeB.times(0.0002);
          makerRebate = takerFee.div(2);
          takerFee    = takerFee.div(2); // actual paid net by taker after rebate to maker

          // Spot-fee accrual in B (contractId = null → revenues to Property 1 investors)
          await tallyMap.updateFeeCache(buyOrderPropertyId, takerFee.decimalPlaces(8, BigNumber.ROUND_FLOOR).toNumber(), null,blockHeight);

          // Apply maker rebate to maker’s received asset (they receive B)
          const sellOrderAmountChange = amountToTradeB.plus(makerRebate).decimalPlaces(8);
          const buyOrderAmountChange  = amountToTradeA.minus(new BigNumber(0)); // taker receives A without a fee on A side

          // Seller (maker): -A reserve, +B available (+ rebate)
          await tallyMap.updateBalance(
            sellOrderAddress, sellOrderPropertyId,
            0, amountToTradeA.negated().toNumber(), 0, 0, true, false, false, txid
          );
          await tallyMap.updateBalance(
            sellOrderAddress, buyOrderPropertyId,
            sellOrderAmountChange.toNumber(), 0, 0, 0, true, false, false, txid
          );

          // Buyer (taker): -B reserve, +A available
          await tallyMap.updateBalance(
            buyOrderAddress, buyOrderPropertyId,
            0, amountToTradeB.negated().toNumber(), 0, 0, true, false, false, txid
          );
          await tallyMap.updateBalance(
            buyOrderAddress, sellOrderPropertyId,
            amountToTradeA.toNumber(), 0, 0, 0, true, false, false, txid
          );

          // Record trade
          await this.recordTokenTrade({
            offeredPropertyId: sellOrderPropertyId,
            desiredPropertyId: buyOrderPropertyId,
            amountOffered: amountToTradeA.toNumber(),
            amountExpected: amountToTradeB.toNumber(),
            price: match.tradePrice,
            buyerRole: match.buyOrder.orderRole,
            sellerRole: match.sellOrder.orderRole,
            takerFee: takerFee.toNumber(),
            makerRebate: makerRebate.toNumber(),
            block: blockHeight,
            buyer: buyOrderAddress,
            seller: sellOrderAddress,
            takerTxId: txid
          }, blockHeight, txid);

        } else if (match.buyOrder.orderRole === 'maker' && match.sellOrder.orderRole === 'taker') {
          // taker pays in the asset they are giving (Token A here)
          takerFee    = amountToTradeA.times(0.0002);
          makerRebate = takerFee.div(2);
          takerFee    = takerFee.div(2);

          // Spot-fee accrual in A (contractId = null)
          await tallyMap.updateFeeCache(sellOrderPropertyId, takerFee.decimalPlaces(8, BigNumber.ROUND_FLOOR).toNumber(), null,blockHeight);

          // Apply maker rebate to maker’s received asset (maker receives A here)
          const buyOrderAmountChange  = amountToTradeA.plus(makerRebate).decimalPlaces(8);
          const sellOrderAmountChange = amountToTradeB.minus(new BigNumber(0));

          // Seller (taker): -A reserve, +B available
          await tallyMap.updateBalance(
            sellOrderAddress, sellOrderPropertyId,
            0, amountToTradeA.negated().toNumber(), 0, 0, true, false, false, txid
          );
          await tallyMap.updateBalance(
            sellOrderAddress, buyOrderPropertyId,
            amountToTradeB.toNumber(), 0, 0, 0, true, false, false, txid
          );

          // Buyer (maker): -B reserve, +A available (+ rebate)
          await tallyMap.updateBalance(
            buyOrderAddress, buyOrderPropertyId,
            0, amountToTradeB.negated().toNumber(), 0, 0, true, false, false, txid
          );
          await tallyMap.updateBalance(
            buyOrderAddress, sellOrderPropertyId,
            buyOrderAmountChange.toNumber(), 0, 0, 0, true, false, false, txid
          );

          await this.recordTokenTrade({
            offeredPropertyId: sellOrderPropertyId,
            desiredPropertyId: buyOrderPropertyId,
            amountOffered: amountToTradeA.toNumber(),
            amountExpected: amountToTradeB.toNumber(),
            price: match.tradePrice,
            buyerRole: match.buyOrder.orderRole,
            sellerRole: match.sellOrder.orderRole,
            takerFee: takerFee.toNumber(),
            makerRebate: makerRebate.toNumber(),
            block: blockHeight,
            buyer: buyOrderAddress,
            seller: sellOrderAddress,
            takerTxId: txid
          }, blockHeight, txid);

        } else {
          // split blockTime case: each pays 1bp on the asset they give
          const takerFeeA = amountToTradeA.times(0.0001).decimalPlaces(8, BigNumber.ROUND_FLOOR);
          const takerFeeB = amountToTradeB.times(0.0001).decimalPlaces(8, BigNumber.ROUND_FLOOR);

          await tallyMap.updateFeeCache(buyOrderPropertyId, takerFeeA.toNumber(), null,blockHeight);
          await tallyMap.updateFeeCache(sellOrderPropertyId, takerFeeB.toNumber(), null,blockHeight);

          // Seller: -A reserve, +B available (minus its own fee on B? fee is in the asset they GIVE, so no)
          await tallyMap.updateBalance(
            sellOrderAddress, sellOrderPropertyId,
            0, amountToTradeA.negated().toNumber(), 0, 0, true, false, false, txid
          );
          await tallyMap.updateBalance(
            sellOrderAddress, buyOrderPropertyId,
            amountToTradeB.toNumber(), 0, 0, 0, true, false, false, txid
          );

          // Buyer: -B reserve, +A available
          await tallyMap.updateBalance(
            buyOrderAddress, buyOrderPropertyId,
            0, amountToTradeB.negated().toNumber(), 0, 0, true, false, false, txid
          );
          await tallyMap.updateBalance(
            buyOrderAddress, sellOrderPropertyId,
            amountToTradeA.toNumber(), 0, 0, 0, true, false, false, txid
          );

          await this.recordTokenTrade({
            offeredPropertyId: sellOrderPropertyId,
            desiredPropertyId: buyOrderPropertyId,
            amountOffered: amountToTradeA.toNumber(),
            amountExpected: amountToTradeB.toNumber(),
            price: match.tradePrice,
            buyerRole: 'split',
            sellerRole: 'split',
            takerFee: new BigNumber(takerFeeA).plus(takerFeeB).toNumber(), // total fees collected
            makerRebate: 0,
            block: blockHeight,
            buyer: buyOrderAddress,
            seller: sellOrderAddress,
            takerTxId: txid
          }, blockHeight, txid);
        }
      }
    }

    async processTokenChannelTrades(matches, blockHeight, txid) {
      console.log(`⚡ Processing ${matches.length} channel token matches at block ${blockHeight}`);

      for (const match of matches) {
        if (!match.sellOrder || !match.buyOrder) continue;

        const sellAddr = match.sellOrder.senderAddress;
        const buyAddr  = match.buyOrder.senderAddress;
        const propA = match.sellOrder.offeredPropertyId;   // A
        const propB = match.buyOrder.desiredPropertyId;    // B
        const amtA  = new BigNumber(match.amountOfTokenA);
        const amtB  = new BigNumber(match.amountOfTokenB);

        // TODO: replace below with true channel ledger updates (HTLC/commitment updates, etc.)
        // For now: same balance updates as spot path, so your economics and fee flow remain consistent.

        // Debit seller reserve A, credit B available
        await tallyMap.updateBalance(sellAddr, propA, 0, amtA.negated().toNumber(), 0, 0, true, false, /*channel*/ true, txid);
        await tallyMap.updateBalance(sellAddr, propB, amtB.toNumber(), 0, 0, 0, true, false, /*channel*/ true, txid);

        // Debit buyer reserve B, credit A available
        await tallyMap.updateBalance(buyAddr, propB, 0, amtB.negated().toNumber(), 0, 0, true, false, /*channel*/ true, txid);
        await tallyMap.updateBalance(buyAddr, propA, amtA.toNumber(), 0, 0, 0, true, false, /*channel*/ true, txid);
      }
    }
    
        async addContractOrder(
            contractId,
            price,
            amount,
            sell,
            insurance,
            blockTime,
            txid,
            sender,
            isLiq,
            reduce,
            post,
            stop,
            orderbook
        ) {
            const ContractRegistry = require('./contractRegistry.js');
            const MarginMap = require('./marginMap.js');

            // Ensure we have an orderbook instance
            const orderBookKey = `${contractId}`;
            if (!orderbook) {
                orderbook = await Orderbook.getOrderbookInstance(orderBookKey);
            }

            const marginMap = await MarginMap.loadMarginMap(contractId);
            const existingPosition = await marginMap.getPositionForAddress(sender, contractId);

            console.log(
                'amount in add contract order ' +
                amount +
                ' ' +
                JSON.stringify(existingPosition)
            );

            const contracts = Number(existingPosition.contracts || 0);

            const isLong  = contracts > 0;
            const isShort = contracts < 0;

            // ✅ Correct: reduce only when the order is opposite to existing sign
            // - If you're SHORT (< 0), a BUY reduces/ flips.
            // - If you're LONG  (> 0), a SELL reduces/ flips.
            const isBuyerReducingPosition = isShort && (sell === false); // buy against short
            const isSellerReducingPosition = isLong && (sell === true);  // sell against long

            let initialReduce = false;
            console.log(
                'adding contract order... existingPosition? ' +
                JSON.stringify(existingPosition) +
                ' reducing position? ' +
                isBuyerReducingPosition +
                ' ' +
                isSellerReducingPosition
            );

            let initMargin = 0;

            // 🔹 Case 1: new or *increasing* exposure → must reserve init margin
            if (!isBuyerReducingPosition && !isSellerReducingPosition) {
                console.log('about to call moveCollateralToReserve ' + contractId, amount, sender);

                initMargin = await ContractRegistry.moveCollateralToReserve(
                    sender,
                    contractId,
                    amount,
                    price,
                    blockTime,
                    txid
                );

                // If we cannot reserve any margin, do NOT place the order.
                if (!initMargin || initMargin <= 0) {
                    console.warn(
                        `Insufficient collateral to open/increase position for ${sender} on contract ${contractId}; ` +
                        `skipping order ${txid}.`
                    );
                    // Return the current book and no matches
                    const currentBook = await orderbook.loadOrderBook(orderBookKey, false);
                    return { orderBook: currentBook, matches: [] };
                }

            // 🔹 Case 2: reduce or flip
            } else if (isBuyerReducingPosition || isSellerReducingPosition) {
                initialReduce = true;

                let flipAmount = 0;

                // If the order *over-shoots* the existing exposure, the excess is a flip that
                // needs *new* margin.
                if (
                    (sell && contracts > 0 && amount > contracts) ||                // long -> bigger short
                    (!sell && contracts < 0 && amount > Math.abs(contracts))        // short -> bigger long
                ) {
                    flipAmount = sell
                        ? amount - contracts
                        : amount - Math.abs(contracts);

                    if (flipAmount > 0) {
                        const extraInitMargin = await ContractRegistry.moveCollateralToReserve(
                            sender,
                            contractId,
                            flipAmount,
                            price,
                            blockTime,
                            txid
                        );

                        if (!extraInitMargin || extraInitMargin <= 0) {
                            console.warn(
                                `Insufficient collateral to flip position for ${sender} on contract ${contractId}; ` +
                                `skipping order ${txid}.`
                            );
                            const currentBook = await orderbook.loadOrderBook(orderBookKey, false);
                            return { orderBook: currentBook, matches: [] };
                        }

                        // We only lock extra for the flipped part; margin for the reduced leg
                        // is already in margin/reserve from the existing position.
                        initMargin = extraInitMargin;
                    }
                }
            }

            // Build the order object
            const contractOrder = {
                contractId,
                amount,
                price,
                blockTime,
                sell,
                initMargin,
                sender,
                txid,
                isLiq,
                reduce,
                post,
                stop,
                initialReduce
            };

            // Load the orderbook snapshot for this contract
            let orderbookData = await orderbook.loadOrderBook(orderBookKey, false);

            console.log('is sell? ' + sell);

            // Insert into book
            orderbookData = await orderbook.insertOrder(
                contractOrder,
                orderbookData,
                sell,
                isLiq
            );

            // Run matching
            const matchResult = await orderbook.matchContractOrders(orderbookData);

            console.log('about to save orderbook in contract trade ' + orderBookKey);
            await orderbook.saveOrderBook(matchResult.orderBook, orderBookKey);

            // If we got matches, clear/margin them
            if (matchResult.matches && matchResult.matches.length > 0) {
                await orderbook.processContractMatches(matchResult.matches, blockTime, false);
            }

            return matchResult;
        }

         async estimateLiquidation(
          liq,            // 1st param: liquidation order (simulated incoming order)
          notional,
          liqPrice,
          trueLiqPrice,
          inverse,
          contractId      // 7th param
        ) {
          const amount = Math.abs(Number(liq.amount || 0));

          const result = {
            filled: false,
            filledSize: 0,
            goodFilledSize: 0,
            badFilledSize: 0,
            remainder: amount,
            avgFillPrice: null,
            fills: []
          };

          console.log(
            "\n[EST_LIQ:start]",
            "contract", contractId,
            "amount", amount,
            "sell", liq.sell,
            "trueLiqPrice", trueLiqPrice,
            "inverse", inverse
          );

          // --------------------------------------------------
          // Load orderbook for THIS contract
          // --------------------------------------------------
          const key = String(contractId);
          let ob = this.orderBooks[key];
          if (!ob) {
            console.log("[EST_LIQ] loading orderbook for contract", key);
            ob = await this.loadOrderBook(key);
            this.orderBooks[key] = ob;
          }

          console.log(
            "[EST_LIQ] book sizes",
            "buy", ob.buy?.length,
            "sell", ob.sell?.length
          );

          // Long liquidation → SELL into bids
          // Short liquidation → BUY into asks
          const orderbookSide = liq.sell ? ob.buy : ob.sell;
          if (!orderbookSide || orderbookSide.length === 0) {
            console.log("[EST_LIQ] no liquidity on side → ADL");
            return result;
          }

          console.log(
            "[EST_LIQ] sweeping side",
            liq.sell ? "BUY (bids)" : "SELL (asks)",
            "levels", orderbookSide.length,
            "bestPx", orderbookSide[0]?.price,
            "bestSz", orderbookSide[0]?.amount
          );

          let remaining = amount;
          let weightedPriceSum = 0;

          // --------------------------------------------------
          // Sweep the book as-if `liq` were incoming
          // --------------------------------------------------
          for (let i = 0; i < orderbookSide.length; i++) {
            const level = orderbookSide[i];
            if (remaining <= 0) {
              console.log("[EST_LIQ] remaining exhausted");
              break;
            }

            if (liq.address && level.sender === liq.address) {
              console.log("[EST_LIQ] skip self order @", level.price);
              continue;
            }

            const px = Number(level.price);
            const sz = Number(level.amount);

            if (!Number.isFinite(px) || !Number.isFinite(sz) || sz <= 0) {
              console.log("[EST_LIQ] skip invalid level", level);
              continue;
            }

            const isGood = !inverse
              ? (liq.sell ? px >= trueLiqPrice : px <= trueLiqPrice)
              : (liq.sell ? px <= trueLiqPrice : px >= trueLiqPrice);

            console.log(
              "[EST_LIQ] level",
              i,
              "px", px,
              "sz", sz,
              "remaining", remaining,
              "isGood", isGood
            );

            if (!isGood) {
              console.log(
                "[EST_LIQ] price fails threshold → stop sweep",
                "px", px,
                "threshold", trueLiqPrice
              );
              break;
            }

            const take = Math.min(remaining, sz);

            console.log(
              "[EST_LIQ] TAKE",
              take,
              "@", px
            );

            result.goodFilledSize += take;
            weightedPriceSum += take * px;
            result.fills.push({ price: px, size: take, good: true });

            remaining -= take;
          }

          // --------------------------------------------------
          // Finalize result
          // --------------------------------------------------
          result.filledSize = result.goodFilledSize;
          result.remainder = amount - result.goodFilledSize;

          if (result.goodFilledSize > 0) {
            result.filled = true;
            result.avgFillPrice = weightedPriceSum / result.goodFilledSize;
          }

          console.log(
            "[EST_LIQ:end]",
            "filled", result.filled,
            "filledSize", result.filledSize,
            "remainder", result.remainder,
            "avgPx", result.avgFillPrice
          );

          return result;
        }

    async matchContractOrders(orderBook) {
      // Base condition: if there are no buy or sell orders, return an empty match array.
      if (!orderBook || orderBook.buy.length === 0 || orderBook.sell.length === 0) {
        return { orderBook, matches: [] };
      }

      let matches = [];
      const maxIterations = Math.min(orderBook.buy.length, orderBook.sell.length, 10000); // Safety guard

      // Sort buy orders descending by price and ascending by blockTime,
      // sort sell orders ascending by price and ascending by blockTime.
      //
      // LITERAL PATCH: add a small priority bump for isMarket without touching existing logic
      orderBook.buy.sort((a, b) =>
        BigNumber(b.price).comparedTo(a.price) ||
        a.blockTime - b.blockTime
      );
      orderBook.sell.sort((a, b) =>
        BigNumber(a.price).comparedTo(b.price) ||
        a.blockTime - b.blockTime
      );

      // Process a round of matching
      for (let i = 0; i < maxIterations; i++) {
        if (orderBook.sell.length === 0 || orderBook.buy.length === 0) break;

        let sellOrder = orderBook.sell[0];
        let buyOrder = orderBook.buy[0];

        console.log('sell order ' + JSON.stringify(sellOrder));

        // Remove orders with zero amounts
        if (BigNumber(sellOrder.amount).isZero()) {
          orderBook.sell.splice(0, 1);
          continue;
        }
        if (BigNumber(buyOrder.amount).isZero()) {
          orderBook.buy.splice(0, 1);
          continue;
        }

        // LITERAL PATCH: market flags
        const buyIsMkt = !!buyOrder.isMarket;
        const sellIsMkt = !!sellOrder.isMarket;

        // Check for price match: if the best buy price is below the best sell price, no trade can occur.
        // LITERAL PATCH: skip this break when either side is market
        if (!buyIsMkt && !sellIsMkt) {
          if (BigNumber(buyOrder.price).isLessThan(sellOrder.price)) break;
        }

        // Determine trade price (using the order with the earlier blockTime)
        // LITERAL PATCH: market order always takes the resting price
        let tradePrice;
        if (buyIsMkt && !sellIsMkt) {
          tradePrice = sellOrder.price;
        } else if (sellIsMkt && !buyIsMkt) {
          tradePrice = buyOrder.price;
        } else if (buyIsMkt && sellIsMkt) {
          // Should not happen in normal flow; conservative fallback
          tradePrice = buyOrder.price;
        } else {
          tradePrice =
            sellOrder.blockTime < buyOrder.blockTime ? sellOrder.price : buyOrder.price;
        }

        // LITERAL PATCH: maker/taker rules with market support
        if (buyIsMkt && !sellIsMkt) {
          buyOrder.maker = false;
          sellOrder.maker = true;
        } else if (sellIsMkt && !buyIsMkt) {
          sellOrder.maker = false;
          buyOrder.maker = true;
        } else {
          sellOrder.maker = sellOrder.blockTime < buyOrder.blockTime;
          buyOrder.maker = buyOrder.blockTime < sellOrder.blockTime;
        }

        // Prevent self-trading
        const sellSender = sellOrder.sender || sellOrder.address;
        const buySender = buyOrder.sender || buyOrder.address;
        if (sellSender === buySender) {
          console.log("Self-trade detected, removing the maker (resting) order.");
          if (sellOrder.maker) {
            orderBook.sell.splice(0, 1);
          } else {
            orderBook.buy.splice(0, 1);
          }
          continue;
        }

        // For orders in the same block, decide based on the post-only flag.
        // LITERAL PATCH: only apply same-block post-only logic when neither side is market
        if (!buyIsMkt && !sellIsMkt && sellOrder.blockTime === buyOrder.blockTime) {
          console.log("Trades in the same block, defaulting to buy order");
          tradePrice = buyOrder.price;
          if (sellOrder.post) {
            tradePrice = sellOrder.price;
            sellOrder.maker = true;
            buyOrder.maker = false;
          } else if (buyOrder.post) {
            tradePrice = buyOrder.price;
            buyOrder.maker = true;
            sellOrder.maker = false;
          } else {
            sellOrder.maker = false;
            buyOrder.maker = false;
          }
        }

        // Execute trade: match the minimum of the two orders’ amounts.
        let tradeAmount = BigNumber.min(sellOrder.amount, buyOrder.amount);

        // Compute initial margin per contract (and marginUsed)
        const ContractRegistry = require('./contractRegistry.js');
        let initialMarginPerContract = await ContractRegistry.getInitialMargin(
          buyOrder.contractId,
          tradePrice
        );
        if (!initialMarginPerContract || isNaN(initialMarginPerContract)) {
          console.error(
            `Invalid initialMarginPerContract: ${initialMarginPerContract} for contract ${buyOrder.contractId} at price ${tradePrice}`
          );
          initialMarginPerContract = 0;
        }
        let marginUsed = BigNumber(initialMarginPerContract)
          .times(tradeAmount)
          .decimalPlaces(8)
          .toNumber();
        if (isNaN(marginUsed)) {
          console.error(`NaN detected in marginUsed: ${marginUsed}, using default 0`);
          marginUsed = 0;
        }

        // Choose a txid based on maker flag
        let txid = sellOrder.maker ? sellOrder.txid : buyOrder.txid;

        // Construct the match object
        matches.push({
          sellOrder: {
            ...sellOrder,
            contractId: sellOrder.contractId,
            amount: tradeAmount.toNumber(),
            sellerAddress: sellOrder.sender || sellOrder.address,
            txid: sellOrder.txid,
            maker: sellOrder.maker,
            liq: sellOrder.isLiq || false,
            marginUsed: marginUsed,
            initialReduce: sellOrder.initialReduce
          },
          buyOrder: {
            ...buyOrder,
            contractId: buyOrder.contractId,
            amount: tradeAmount.toNumber(),
            buyerAddress: buyOrder.sender || buyOrder.address,
            txid: buyOrder.txid,
            liq: buyOrder.isLiq || false,
            maker: buyOrder.maker,
            marginUsed: marginUsed,
            initialReduce: buyOrder.initialReduce
          },
          tradePrice,
          txid: txid
        });

        // Update order amounts after the match
        sellOrder.amount = BigNumber(sellOrder.amount).minus(tradeAmount).toNumber();
        buyOrder.amount = BigNumber(buyOrder.amount).minus(tradeAmount).toNumber();

        //  initMargin shrinking
        if (sellOrder.amount > 0) {
          sellOrder.initMargin = (
            initialMarginPerContract * sellOrder.amount
          ).toFixed(8);
        }

        if (buyOrder.amount > 0) {
          buyOrder.initMargin = (
            initialMarginPerContract * buyOrder.amount
          ).toFixed(8);
        }

        // Remove fully filled orders from the front of the arrays
        if (sellOrder.amount === 0) {
          orderBook.sell.splice(0, 1);
        } else {
          orderBook.sell[0] = sellOrder;
        }
        if (buyOrder.amount === 0) {
          orderBook.buy.splice(0, 1);
        } else {
          orderBook.buy[0] = buyOrder;
        }
      }

      // After this round, if there are still orders and the best buy price is at or above the best sell price,
      // recursively match the remaining orders.
      //
      // LITERAL PATCH: allow recursion to continue when a market order is at the top
      const topBuy = orderBook.buy[0];
      const topSell = orderBook.sell[0];
      const topBuyIsMkt = topBuy ? !!topBuy.isMarket : false;
      const topSellIsMkt = topSell ? !!topSell.isMarket : false;

      if (
        orderBook.buy.length > 0 &&
        orderBook.sell.length > 0 &&
        (
          topBuyIsMkt ||
          topSellIsMkt ||
          BigNumber(topBuy.price).isGreaterThanOrEqualTo(topSell.price)
        )
      ) {
        const recResult = await this.matchContractOrders(orderBook);
        matches = matches.concat(recResult.matches);
        orderBook = recResult.orderBook;
      }

      return { orderBook, matches };
    }


    async getAddressOrders(address, sell) {
        // Load the order book for the current instance's contractId
        const orderBookKey = `${this.orderBookKey}`;
        const orderbookData = await this.loadOrderBook(orderBookKey, false);

        if(!orderbookData){
            console.error(`No order book found for contract ${this.orderBookKey}`);
            return [];
        }

        // Determine whether to check buy or sell orders
        let orders = sell ? orderbookData.sell : orderbookData.buy;

        // Filter orders by matching the given address
        return orders.filter(order => order.sender === address);
    }

     async cancelContractOrdersForSize(address, contractId, blockHeight, sell, size) {
        // Load the order book for the current instance's contractId
        const orderBookKey = `${this.orderBookKey}`;
        const orderbookData = await this.loadOrderBook(orderBookKey, false);

        if (!orderbookData) {
            console.error(`No order book found for contract ${this.orderBookKey}`);
            return [];
        }

        // Determine the order side (buy or sell)
        let orders = sell ? orderbookData.sell : orderbookData.buy;

        // Sort orders based on distance from market:
        // - Buy orders: Sort ascending (lowest price first)
        // - Sell orders: Sort descending (highest price first)
        orders = sell
            ? orders.sort((a, b) => a.price - b.price)  // Buy side (cancel lowest first)
            : orders.sort((a, b) => b.price - a.price); // Sell side (cancel highest first)

        let remainingSize = new BigNumber(size);
        let cancelledOrders = [];

        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];

            // Only process orders belonging to the given address
            if (order.sender !== address) {
                continue;
            }

            let orderSizeBN = new BigNumber(order.amount);
            let cancelSize = BigNumber.minimum(orderSizeBN, remainingSize);

            // Cancel the order
            cancelledOrders.push({
                txid: order.txid, // Transaction ID of the order being cancelled
                amountCancelled: cancelSize.toNumber(),
                price: order.price,
            });

            // Reduce remaining size to satisfy cancellation
            remainingSize = remainingSize.minus(cancelSize);

            // Remove order from orderbook if fully cancelled
            if (orderSizeBN.isLessThanOrEqualTo(cancelSize)) {
                orders.splice(i, 1);
                i--; // Adjust index since we removed an element
            } else {
                // Update order amount in the order book
                order.amount = orderSizeBN.minus(cancelSize).toNumber();
            }

            // If we have fully satisfied the requested size, stop processing
            if (remainingSize.isLessThanOrEqualTo(0)) {
                break;
            }
        }

        // Save the updated order book
        //await this.saveOrderBook(orderBookKey, orderbookData);

        return cancelledOrders;
    }

        async evaluateBasicLiquidityReward(match, channel, contract) {
            var accepted = false

            var contractOrPropertyIds = []
            if(!contract){
                contractOrPropertyIds=[match.propertyId1, match.propertyId2];
            }else{
                contractOrPropertyIds=[match.sellOrder.contractId]
            }
            let issuerAddresses = [];
            
            if(contract){
                const ContractRegistry1 = require('./contractRegistry.js')

                    for (const id of contractOrPropertyIds) {
                        const contractData = await ContractRegistry1.getContractInfo(id); // Assuming you have a similar method for contracts
                        if (contractData && contractData.issuerAddress) {
                            issuerAddresses.push(contractData.issuerAddress);
                        }
                    }
            }else{
                const PropertyManager1 = require('./property.js')
                    for (const id of contractOrPropertyIds) {
                    const propertyData = await PropertyManager1.getPropertyData(id);
                    if (propertyData && propertyData.issuerAddress) {
                        issuerAddresses.push(propertyData.issuerAddress);
                    }
                }

            }
            for (const address of issuerAddresses) {
                const isWhitelisted = await ClearList.isAddressInClearlist(1, address);
                if (isWhitelisted) {
                    accepted=true
                }
            }
            return accepted;
        }

        async evaluateEnhancedLiquidityReward(match, channel) {
            var accepted = false
            
            let addressesToCheck = [];
            
            if (match.type === 'channel') {
                const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(match.address);
                addressesToCheck = [channel.A.address, channel.B.address];
            } else {
                addressesToCheck = [match.buyerAddress, match.sellerAddress];
            }
            
            for (const address of addressesToCheck) {
                const isWhitelisted = await ClearList.isAddressInClearlist(2, address);
                if (isWhitelisted) {
                    accepted=true;
                }
            }
            
            return accepted;
        }

            // In Orderbooks.js
    async adjustOrdersForAddress(address, contractId, tally, pos) {
        const orderBookKey = `${this.orderBookKey}`;
        const orderbook = await this.loadOrderBook(orderBookKey, false);
        const obForContract = orderbook.orderBooks[contractId] || { buy: [], sell: [] };

        console.log(`🔄 Adjusting orders for ${address} on contract ${contractId} with position: ${JSON.stringify(pos)}`);

        let totalInitMarginForAddress = new BigNumber(0);
        let changedOrders = false;
        let requiredMarginChange = new BigNumber(0);

        // Loop through buy & sell sides
        for (const side of ['buy', 'sell']) {
            for (let i = obForContract[side].length - 1; i >= 0; i--) {
                const order = obForContract[side][i];
                const orderAddress = order.sender || order.address;
                if (orderAddress !== address) continue;

                const orderSide = order.side || (order.sell ? 'sell' : 'buy');
                const shouldBeReduce = (orderSide === 'buy' && pos.contracts < 0) ||
                                       (orderSide === 'sell' && pos.contracts > 0);

                if (order.initialReduce !== shouldBeReduce) {
                    console.log(`🔄 Order ${order.txid}: initialReduce flipped (${order.initialReduce} → ${shouldBeReduce})`);
                    order.initialReduce = shouldBeReduce;
                    changedOrders = true;

                    if (shouldBeReduce) {
                        // ✅ **Return `initMargin` to `available` since it's now a take-profit order**
                        console.log(`📉 Order ${order.txid} converted to take-profit. Returning ${order.initMargin} to available.`);
                        await TallyMap.updateBalance(address, tally.propertyId, order.initMargin, -order.initMargin, 0, 0, 'takeProfitMarginReturn', tally.block);
                    } else {
                        // ❌ **Pull `initMargin` from `available` for new entry orders**
                        console.log(`📈 Order ${order.txid} requires fresh margin allocation.`);
                        requiredMarginChange = requiredMarginChange.plus(order.initMargin);
                    }
                }

                // Update margin usage
                const newInitialMargin = await ContractRegistry.getInitialMargin(contractId, pos.avgPrice);
                const expectedMarginUsed = new BigNumber(newInitialMargin).times(order.amount).decimalPlaces(8).toNumber();

                if (order.marginUsed !== expectedMarginUsed) {
                    console.log(`🔧 Updating marginUsed ${order.marginUsed} → ${expectedMarginUsed} for Order ${order.txid}`);
                    order.marginUsed = expectedMarginUsed;
                    changedOrders = true;
                }

                // Track total reserved margin for address
                totalInitMarginForAddress = totalInitMarginForAddress.plus(expectedMarginUsed);
            }
        }

        // **Step 2: Ensure sufficient balance before applying margin changes**
        if (requiredMarginChange.gt(0)) {
            const hasSufficient = await TallyMap.hasSufficientBalance(address, tally.propertyId, requiredMarginChange.toNumber());

            if (!hasSufficient) {
                console.log(`⚠️ Insufficient balance for new entry orders. Cancelling lower-priority orders.`);
                await this.cancelExcessOrders(address, contractId, obForContract, requiredMarginChange);
            } else {
                console.log(`✅ Sufficient balance. Allocating ${requiredMarginChange.toFixed(8)} to margin.`);
                await TallyMap.updateBalance(address, tally.propertyId, -requiredMarginChange.toNumber(), requiredMarginChange.toNumber(), 0, 0, 'reduceFlagReallocation', tally.block);
            }
        }

        // Save updated orderbook
        orderbook.orderBooks[contractId] = obForContract;
        await Orderbooks.saveOrderbook(orderbook);
        console.log(`✅ Finished adjusting orders for ${address} on contract ${contractId}.`);

        return orderbook;
    }

    /**
     * Attempt to source remaining loss from reserves tied up in *other* contract orderbooks.
     * 
     * @param {string} address 
     * @param {number} propertyId 
     * @param {BigNumber} remaining 
     * @param {number} skipContractId 
     * @param {number} blockHeight 
     * @returns {Object} { remaining: BigNumber, breakdown: {...} }
     */
    static async sourceCrossContractReserve(address, propertyId, remaining, skipContractId, blockHeight) {
        const TallyMap = require('./tally.js');
        const ContractRegistry = require('./contractRegistry.js');
        const Orderbook = require('./orderbook.js');

        const breakdown = { fromCrossReserve: 0 };

        // Load *all* contract IDs
        let allContracts = [];
        try {
            allContracts = await ContractRegistry.getAllContracts();
            console.log('all contracts? '+JSON.stringify(allContracts))
        } catch (e) {
            console.error("⚠️ Could not list all contracts, cross-contract reserve fallback skipped.", e);
            return { remaining, breakdown };
        }

        // Snapshot available before cross-contract scavenging
        const initialTally = await TallyMap.getTally(address, propertyId);
        let baselineAvail = new BigNumber(initialTally.available || 0);

        console.log(`🔁 Cross-contract scavenging for ${address}, need ${remaining.toFixed(8)}`);

        for (const c of allContracts) {
            const otherCid = c.id;    // ← extract numeric ID
            console.log('id and skip '+otherCid +' '+skipContractId)
            if (!otherCid) continue;
            if (otherCid === skipContractId) continue;

            console.log(`➡️ Scanning contract ${otherCid} for cancellable orders...`);

            await Orderbook.cancelExcessOrders(
                address,
                otherCid,         // now a real number, not [object Object]
                remaining,
                propertyId,
                blockHeight
            );

            // Tally AFTER cancellation
            const after = await TallyMap.getTally(address, propertyId);
            const afterAvail = new BigNumber(after.available || 0);

            // Freed = increase in available
            let freed = afterAvail.minus(baselineAvail);
            if (freed.lt(0)) freed = new BigNumber(0);

            const useX = BigNumber.min(remaining, freed);

            if (useX.gt(0)) {
                console.log(`   ✔ Freed ${useX.toFixed(8)} on contract ${otherCid}`);

                // Debit available to pay the loss
                await TallyMap.updateBalance(
                    address,
                    propertyId,
                    -useX,
                    0,
                    0,
                    0,
                    'loss_from_cross_contract_reserve',
                    block
                );

                breakdown.fromCrossReserve += useX.toNumber();
                remaining = remaining.minus(useX);

                // Update baseline for next iteration
                baselineAvail = afterAvail.minus(useX);
            }

            if (remaining.lte(0)) {
                console.log("🎉 Cross-contract reserve fully covers loss.");
                break;
            }
        }

        return { remaining, breakdown };
    }


    static async cancelExcessOrders(address, contractId, requiredMargin,collateralId,block) {
        const TallyMap = require('./tally.js')
        let freedMargin = new BigNumber(0);
        const orderBookKey = `${contractId}`;
        const orderbook = new Orderbook(contractId);
        var obForContract = await orderbook.loadOrderBook(orderBookKey,false);

        console.log(`🚨 Cancelling excess orders for ${address} on contract ${contractId} to free up ${requiredMargin.toFixed(8)} margin.`);

        // Sort sell orders by highest price first (worst price for seller)
        obForContract.sell.sort((a, b) => new BigNumber(b.price).comparedTo(a.price));

        // Sort buy orders by lowest price first (worst price for buyer)
        obForContract.buy.sort((a, b) => new BigNumber(a.price).comparedTo(b.price));

        for (const side of ['buy', 'sell']) {
            for (let i = obForContract[side].length - 1; i >= 0; i--) {
                const order = obForContract[side][i];
                if ((order.sender || order.address) !== address) continue;

                console.log(`❌ Cancelling Order ${order.txid}, freeing ${order.initMargin} margin.`);
                freedMargin = freedMargin.plus(order.initMargin);
                obForContract[side].splice(i, 1); // Remove order

                await TallyMap.updateBalance(address, collateralId, order.initMargin, -order.initMargin, 0, 0, 'excessOrderCancellation', block);

                if (freedMargin.gte(requiredMargin)) {
                    console.log(`✅ Enough margin freed. Stopping cancellations.`);
                    return;
                }
            }
        }

        await orderbook.saveOrderBook(obForContract, orderBookKey);

        console.log(`⚠️ Could not free all required margin. User may still be undercollateralized.`);
    }

    static decomposePositionChange(oldPos, tradeAmount, isBuyerSide) {
      // Buyers are "long" side (+), sellers "short" side (-)
      const dir = isBuyerSide ? +1 : -1;
      const incoming = dir * tradeAmount;      // signed change
      const absOld = Math.abs(oldPos);
      const sameDir = (Math.sign(oldPos) === Math.sign(incoming)) || oldPos === 0;
      console.log('inside decomp position '+JSON.stringify(oldPos)+' '+tradeAmount+' '+isBuyerSide)
      let closed = 0;
      let flipped = 0;
      let newPos = oldPos;

      if (!sameDir && oldPos.amount !== 0) {
        // Trade goes against our existing position
        closed = Math.min(absOld, Math.abs(incoming));  // <= |oldPos|
        const remaining = Math.abs(incoming) - closed;  // what's left after closing
        flipped = remaining;                            // always >= 0

        if (remaining === 0) {
          newPos = oldPos + incoming;                  // ends up at 0
        } else {
          newPos = Math.sign(incoming) * remaining;    // flipped to opposite side
        }
        console.log('inside the key block '+sameDir+' '+JSON.stringify(newPos)+' '+closed+' '+flipped+' '+remaining)
      } else {
        // Purely adding to existing direction (or opening from flat)
        closed = 0;
        flipped = 0;
        newPos = oldPos + incoming;
      }

      return { closed, flipped, newPos };
    }

    async sourceFundsForLoss(address, propertyId, lossAmount, block, contractId,tie) {
        const TallyMap = require('./tally.js')
        const tally = await TallyMap.getTally(address, propertyId);
        if (!tally) {
            return { hasSufficient: false, reason: 'undefined tally', remaining: lossAmount };
        }

        let remaining = new BigNumber(lossAmount);
        const breakdown = { fromAvailable: 0, fromMarginCap: 0, fromReserve: 0, fromMarginFinal: 0 };

        console.log(`🔍 Starting loss sourcing for ${address}, need ${remaining.toFixed(8)}`);

        // 1️⃣ Available balance
        const availUse = BigNumber.min(remaining, tally.available || 0);
        let type = 'loss_from_available'
        if(tie){type+='_tieOff'}
        if (availUse.gt(0)) {
            await TallyMap.updateBalance(address, propertyId, -availUse, 0, 0, 0, type,block);
            breakdown.fromAvailable = availUse.toNumber();
            remaining = remaining.minus(availUse);
        }

        type = 'loss_from_margin'
        if(tie){type+='_tieOff'}
        // 2️⃣ 49% of margin
        if (remaining.gt(0)) {
            const marginCap = new BigNumber(tally.margin || 0).multipliedBy(0.499);
            const marginUse = BigNumber.min(remaining, marginCap);
            if (marginUse.gt(0)) {
                await TallyMap.updateBalance(address, propertyId, 0, 0, -marginUse, 0, type,block);
                breakdown.fromMarginCap = marginUse.toNumber();
                remaining = remaining.minus(marginUse);
            }
        }

        // 3️⃣ Try freeing reserve first if needed
        if (remaining.gt(0)) {
        // Snapshot before we mess with anything
        const before = await TallyMap.getTally(address, propertyId);
        const beforeAvail = new BigNumber(before.available || 0);
        const beforeReserved = new BigNumber(before.reserved || 0);
        console.log('before reserved '+ beforeAvail +' ' +beforeReserved)
        // Always try to cancel up to the shortfall.
        // cancelExcessOrders should internally clamp to available reserved.
        if (beforeReserved.gt(0)) {
                console.log(
                    `⚠️ Attempting to free up to ${remaining.toFixed(8)} from cancelled orders (reserved=${beforeReserved.toFixed(8)})`
                );
                await Orderbook.cancelExcessOrders(address, contractId, remaining, propertyId, block);
        }

        const after = await TallyMap.getTally(address, propertyId);
        const afterAvail = new BigNumber(after.available || 0);
        const afterReserved = new BigNumber(after.reserved || 0);
        console.log('after cancel '+afterAvail+' '+afterReserved)
        // Tokens freed from reserve are the *increase* in available
        // (assuming cancelExcessOrders moves reserved -> available without touching supply)
        let freedFromReserve = afterAvail.minus(beforeAvail);
        if (freedFromReserve.lt(0)) {
            // defensive: shouldn't happen, but don't let it blow things up
            freedFromReserve = new BigNumber(0);
        }

        // Only use what we actually freed, and cap by remaining shortfall
        const reserveUse = BigNumber.min(remaining, freedFromReserve);
        console.log('reserve use '+reserveUse)
        if (reserveUse.gt(0)) {
            // This call should *not* create or destroy global supply:
            // losers lose reserveUse, winners gain reserveUse elsewhere.
            await TallyMap.updateBalance(
                address,
                propertyId,
                -reserveUse,   // reduce available to pay the loss
                0,
                0,
                0,
                'loss_from_reserve',
                block
            );
            breakdown.fromReserve = (breakdown.fromReserve || 0) + reserveUse.toNumber();
            remaining = remaining.minus(reserveUse);
        }
        console.log('special check '+remaining.toNumber())

        // --- after primary reserve sourcing ---
        if (remaining.gt(0)) {
            const x = await Orderbook.sourceCrossContractReserve(
                address,
                propertyId,
                remaining,
                contractId,   // skip same contract
                block
            );

            remaining = x.remaining;
            breakdown.fromCrossReserve = x.breakdown.fromCrossReserve || 0;
        }


        // At this point:
        // - available has been reduced by exactly the amount we just freed
        // - reserved has dropped by cancelExcessOrders
        // - global (amount+reserved+margin+vesting) stays invariant, except for the
        //   separate credit to counterparties which should be balancing this debit.
    }
    
        const success = remaining.lte(0);
        remaining.decimalPlaces(8).toNumber();
        const reason = success ? '' : 'Insufficient total balance after all buckets';

        console.log(`📊 Loss sourcing result for ${address}:`, { success, remaining, breakdown });

        return {
            hasSufficient: success,
            reason,
            remaining,
            totalUsed: lossAmount - remaining,
            breakdown
        };
    }

    async _pruneInstaLiqOrdersFromFreshBook(
          thisPrice,
          blockHeight,
          contractId,
          notional,
          inverse
        ) {
          const Tally = require('./tally.js');
          const ContractRegistry = require('./contractRegistry.js');

          const key = String(contractId);
          const collateralId = await ContractRegistry.getCollateralId(contractId);

          // Use an instance so we can call loadOrderBook/saveOrderBook exactly like the rest of the file
          const obInst = new Orderbook(key);

          // ✅ always load fresh snapshot
          const ob = await obInst.loadOrderBook(key);
          if (!ob || (!Array.isArray(ob.buy) && !Array.isArray(ob.sell))) return 0;

          let pruned = 0;

          // Sweep both sides (fresh snapshot)
          for (const sideName of ['buy', 'sell']) {
            const side = Array.isArray(ob[sideName]) ? ob[sideName] : [];

            // iterate backwards because we splice
            for (let i = side.length - 1; i >= 0; i--) {
              const order = side[i];
              if (!order) continue;

              const address = order.sender || order.address;
              if (!address) continue;
              const isVirtualAmm = address === 'amm' || (typeof address === 'string' && address.startsWith('amm:'));

              const qty = Math.abs(Number(order.amount || 0));
              if (!Number.isFinite(qty) || qty <= 0) continue;

              // Lazy-load tally
              const tally = await Tally.getTally(address, collateralId);
              if (!tally) continue;

              const avail = Number(tally.available || 0);
              const margin = Number(tally.margin || 0);
              const totalCollateral = avail + margin;

              // no collateral => prune
              if (!Number.isFinite(totalCollateral) || totalCollateral <= 0) {
                // splice out order
                side.splice(i, 1);
                pruned++;

                // refund reserve if present
                const reserve = Number(order.initMargin || 0);
                if (reserve > 0 && !isVirtualAmm) {
                  await Tally.updateBalance(
                    address,
                    collateralId,
                    +reserve,
                    -reserve,
                    0,
                    0,
                    'contractCancel',
                    blockHeight
                  );
                }
                continue;
              }

              const px = Number(order.price);
              if (!Number.isFinite(px) || px <= 0) continue;

              // sideName decides direction (don’t rely on order.isSell)
              const isSell = (sideName === 'sell');

              let worstLoss = 0;

              if (!inverse) {
                // Linear
                worstLoss = isSell
                  ? qty * notional * Math.max(0, thisPrice - px)     // short loses on price ↑
                  : qty * notional * Math.max(0, px - thisPrice);    // long loses on price ↓
              } else {
                // Inverse
                worstLoss = isSell
                  ? qty * notional * Math.max(0, (1 / px) - (1 / thisPrice))
                  : qty * notional * Math.max(0, (1 / thisPrice) - (1 / px));
              }

              if (worstLoss > totalCollateral) {
                // prune the order
                side.splice(i, 1);
                pruned++;

                // refund reserved collateral (prefer stored initMargin)
                let reserve = Number(order.initMargin || 0);
                if (!Number.isFinite(reserve) || reserve <= 0) {
                  // fallback: compute from registry if needed
                  const imPer = await ContractRegistry.getInitialMargin(contractId, px);
                  reserve = Number(imPer || 0) * qty;
                }

                if (reserve > 0 && !isVirtualAmm) {
                  await Tally.updateBalance(
                    address,
                    collateralId,
                    +reserve,
                    -reserve,
                    0,
                    0,
                    'contractCancel',
                    blockHeight
                  );
                }
              }
            }
          }

          if (pruned > 0) {
            obInst.orderBooks[key] = ob;
            await obInst.saveOrderBook(ob, key);
          }

          return pruned;
        }
     
    async processContractMatches(matches, currentBlockHeight, channel, last=null){
            const TallyMap = require('./tally.js');
            const ContractRegistry = require('./contractRegistry.js')
            if (!Array.isArray(matches)) {
                // Handle the non-iterable case, e.g., log an error, initialize as an empty array, etc.
                console.error('Matches is not an array:', matches);
                matches = []; // Initialize as an empty array if that's appropriate
            }

            const MarginMap = require('./marginMap.js')
            const tradeHistoryManager = new TradeHistory()
            const trades= []
            //console.log('processing contract mathces '+JSON.stringify(matches))
            let counter = 0 
            for (const match of matches) {
                counter+=1
                  console.log('counter 🛑 '+counter+' '+JSON.stringify(matches))
                  console.log('🛑 JSON.stringify match '+JSON.stringify(match))

                  let isLiquidation = false
                  if(match.buyOrder.isLiq||match.sellOrder.isLiq){
                    isLiquidation=true
                  }
                    if(match.buyOrder.buyerAddress == match.sellOrder.sellerAddress){
                        console.log('self trade nullified '+match.buyOrder.buyerAddress)
                        continue
                    }

                    let debugFlag = false
                    // Load the margin map for the given series ID and block height
                    const marginMap = await MarginMap.loadMarginMap(match.sellOrder.contractId);
                    const isInverse = await ContractRegistry.isInverse(match.sellOrder.contractId)
                    const priceInfo = await Clearing.isPriceUpdatedForBlockHeight(match.sellOrder.contractId,currentBlockHeight);
                    let lastPrice = priceInfo.lastPrice
                    let thisPrice = priceInfo.thisPrice
                    if(isLiquidation&&last!=null){lastPrice=last}
                        console.log('last price in process contracts '+lastPrice)
                    match.inverse = isInverse
                    let collateralPropertyId = await ContractRegistry.getCollateralId(match.buyOrder.contractId)
                    const blob = await ContractRegistry.getNotionalValue(match.sellOrder.contractId,match.tradePrice)
                    const notionalValue = blob.notionalValue
                    const perContractNotional = blob.notionalPerContract;
                    console.log('returned notionalValue '+notionalValue+' '+perContractNotional)
                    let reserveBalanceA = await TallyMap.getTally(match.sellOrder.sellerAddress,collateralPropertyId)
                    let reserveBalanceB = await TallyMap.getTally(match.buyOrder.buyerAddress,collateralPropertyId)
                    if(debugFlag){
                        console.log('checking reserves in process contract matches '+JSON.stringify(reserveBalanceA)+' '+JSON.stringify(reserveBalanceB))
                    }
                      //console.log('checking the marginMap for contractId '+ marginMap )
                    // Get the existing position sizes for buyer and seller
                    match.buyerPosition = await marginMap.getPositionForAddress(match.buyOrder.buyerAddress, match.buyOrder.contractId);
                    match.sellerPosition = await marginMap.getPositionForAddress(match.sellOrder.sellerAddress, match.buyOrder.contractId);
                    if(match.buyerPosition.address==undefined){
                        match.buyerPosition.address=match.buyOrder.buyerAddress
                    }
                    if(match.sellerPosition.address==undefined){
                        match.sellerPosition.address=match.sellOrder.sellerAddress
                    }

                    console.log('checking positions '+JSON.stringify(match.buyerPosition)+' '+JSON.stringify(match.sellerPosition))
                    const isBuyerReducingPosition = Boolean(match.buyerPosition.contracts < 0);
                    const isSellerReducingPosition = Boolean(match.sellerPosition.contracts > 0);
                   
                    console.log('about to calc fee '+match.buyOrder.amount+' '+match.sellOrder.maker+' '+match.buyOrder.maker+' '+isInverse+' '+match.tradePrice+' '+notionalValue+' '+channel)
                    const { buyerFee, sellerFee } = this.calculateFee({
                        amountBuy: match.buyOrder.amount,
                        amountSell: match.sellOrder.amount,
                        buyMaker: match.buyOrder.maker,
                        sellMaker: match.sellOrder.maker,
                        isInverse,
                        lastMark: match.tradePrice,
                        notionalValue,
                        channel
                    });
					console.log('seller/buyer fee '+sellerFee+' '+buyerFee)
					// Buyer side: only push taker/on-chain positive fees
					if (buyerFee.isGreaterThan(0)&&sellerFee.isLessThan(0)) {
					  const feeToCache = buyerFee.div(2).toNumber();
					  console.log('buyer fee to cache '+feeToCache)
					  await TallyMap.updateFeeCache(collateralPropertyId, feeToCache, match.buyOrder.contractId,currentBlockHeight,true);
					}

					// Seller side: same treatment
					if (sellerFee.isGreaterThan(0)&&buyerFee.isLessThan(0)) {
					  const feeToCache = sellerFee.div(2).toNumber();
					  console.log('seller fee to cache '+feeToCache)
					  await TallyMap.updateFeeCache(collateralPropertyId, feeToCache, match.sellOrder.contractId,currentBlockHeight,true);
					}

					if(buyerFee.isGreaterThan(0)&&sellerFee.isGreaterThan(0)){
					  await TallyMap.updateFeeCache(collateralPropertyId, sellerFee.toNumber(), match.sellOrder.contractId,currentBlockHeight);
					  await TallyMap.updateFeeCache(collateralPropertyId, buyerFee.toNumber(), match.sellOrder.contractId,currentBlockHeight);
					}

                    //console.log('reducing? buyer '+isBuyerReducingPosition +' seller '+isSellerReducingPosition+ ' buyer fee '+buyerFee +' seller fee '+sellerFee)
                   
                    let feeInfo = await this.locateFee(match, reserveBalanceA, reserveBalanceB,collateralPropertyId,buyerFee, sellerFee, isBuyerReducingPosition, isSellerReducingPosition,currentBlockHeight)         
                   
                    const buyerPos = match.buyerPosition.contracts || 0;
                    const sellerPos = match.sellerPosition.contracts || 0;

                    const buyerMove  = Orderbook.decomposePositionChange(buyerPos,  match.buyOrder.amount,  /* isBuyerSide */ true);
                    const sellerMove = Orderbook.decomposePositionChange(sellerPos, match.sellOrder.amount, /* isBuyerSide */ false);
                    let initialMarginPerContract = await ContractRegistry.getInitialMargin(match.buyOrder.contractId, match.tradePrice);
                    const buyerClosed  = buyerMove.closed;
                    let flipLong     = buyerMove.flipped;
                    const sellerClosed = sellerMove.closed;
                    let flipShort    = sellerMove.flipped;
                    console.log('flip long and short '+flipLong+' '+flipShort)
                    console.log('buyerClosed and sellerClosed '+buyerClosed+' '+sellerClosed)
                    const isBuyerFlippingPosition  = buyerMove.flipped > 0;
                    const isSellerFlippingPosition = sellerMove.flipped > 0;

                    const buyerFullyClosed  = (buyerMove.newPos === 0 && buyerClosed > 0);
                    const sellerFullyClosed = (sellerMove.newPos === 0 && sellerClosed > 0);
                    
                        console.log('debug flag flags '+isBuyerFlippingPosition+isSellerFlippingPosition+isBuyerReducingPosition+isSellerReducingPosition)

                    if (isBuyerFlippingPosition) {
                        let closedContracts = buyerClosed // The contracts being closed
                      
                        if (feeInfo.buyFeeFromMargin) {
                            match.buyOrder.marginUsed = BigNumber(match.buyOrder.marginUsed).minus(buyerFee).decimalPlaces(8).toNumber();
                        }

                        console.log(`Checking flip logic: ${match.buyOrder.buyerAddress} closing ${closedContracts}, flipping ${flipLong}`);
                        let newMarginRequired = BigNumber(initialMarginPerContract).times(flipLong)
                        console.log('newMargin flip '+newMarginRequired+' '+initialMarginPerContract+' '+flipLong)
                        if(!channel){
                            // Release margin for closed contracts
                            let marginToRelease = BigNumber(initialMarginPerContract).times(closedContracts)
                            //so in the event that this is not a channel trade we will deduct this as it matches the book
                            let diff = marginToRelease.minus(newMarginRequired).decimalPlaces(8).toNumber();
                            if(diff>0){
                                await TallyMap.updateBalance(
                                match.buyOrder.buyerAddress, collateralPropertyId, marginToRelease, -marginToRelease, 0, 0, 
                                'contractMarginRelease', currentBlockHeight
                                );
                            }else{
                                diff*=-1
                                newMarginRequired-=diff
                            }
                            
                        }else if(channel){
                           let diff = BigNumber(newMarginRequired).minus(match.buyerPosition.margin || 0).decimalPlaces(8).toNumber();
                            if (diff !== 0) await TallyMap.updateBalance(match.buyOrder.buyerAddress, collateralPropertyId, -diff, 0, diff, 0, 'contractTradeInitMargin_channelFlip', currentBlockHeight);

                        }

                        // Ensure there is enough margin for the new contracts beyond closing
                        let hasSufficientReserve = await TallyMap.hasSufficientBalance(match.buyOrder.buyerAddress, collateralPropertyId, newMarginRequired);
                        
                        if (!hasSufficientReserve.hasSufficient) {
                            console.log(`Shortfall detected: ${JSON.stringify(hasSufficientBalance)}`);
                            console.log('hasSuf '+hasSufficientBalance.shortfall+' '+initialMarginPerContract )
                            let contractUndo = BigNumber(hasSufficientBalance.shortfall)
                                .dividedBy(initialMarginPerContract)
                                .decimalPlaces(0, BigNumber.ROUND_CEIL)
                                .toNumber();

                            flipLong -= contractUndo;
                            newMarginRequired = BigNumber(initialMarginPerContract).times(new BigNumber(flipLong)).decimalPlaces(8).toNumber();
                            console.log('contract undo investigate '+newMarginRequired+' '+flipLong+' '+contractUndo+' '+BigNumber(hasSufficientBalance.shortfall)
                                .dividedBy(initialMarginPerContract)+' '+BigNumber(hasSufficientBalance.shortfall)
                                .dividedBy(initialMarginPerContract)
                                .decimalPlaces(0, BigNumber.ROUND_CEIL))                            
                        }

                        await TallyMap.updateBalance(
                            match.buyOrder.buyerAddress, collateralPropertyId, -newMarginRequired, 0, newMarginRequired, 0, 
                            'contractTradeInitMargin', currentBlockHeight
                        );

                        await marginMap.setInitialMargin(match.buyOrder.buyerAddress, match.buyOrder.contractId, newMarginRequired);
                        await marginMap.recordMarginMapDelta(match.buyOrder.buyerAddress, match.buyOrder.contractId, 
                            match.buyerPosition.contracts + match.buyOrder.amount, match.buyOrder.amount, 0, 0, 0, 
                            'updateContractBalancesFlip',currentBlockHeight
                        );

                        let refreshedBalance = await TallyMap.getTally(match.buyOrder.buyerAddress,collateralPropertyId)
                        //this.adjustOrdersForAddress(match.buyOrder.buyerAddress, match.buyOrder.contractId, refreshedBalance, match.buyerPosition)

                        console.log(`Flip logic updated: closed=${closedContracts}, flipped=${flipLong}`);
                    }
                    
                    if(isSellerFlippingPosition){
                        let closedContracts = sellerClosed // The contracts being closed
                   
                        console.log(`Checking sell flip logic: ${match.sellOrder.sellerAddress} closing ${closedContracts}, flipping ${flipShort}`);

                        console.log(`Checking flip logic: ${match.buyOrder.buyerAddress} closing ${closedContracts}, flipping ${flipLong}`);
                        let newMarginRequired = BigNumber(initialMarginPerContract).times(flipShort).decimalPlaces(8).toNumber();
                        console.log('newMargin flip '+newMarginRequired+' '+initialMarginPerContract+' '+flipLong)
                        if(!channel){
                            // Release margin for closed contracts
                            let marginToRelease = BigNumber(initialMarginPerContract).times(closedContracts)
                            //so in the event that this is not a channel trade we will deduct this as it matches the book
                            let diff = marginToRelease.minus(newMarginRequired).decimalPlaces(8).toNumber();
                            if(diff>0){
                                await TallyMap.updateBalance(
                                match.sellOrder.sellerAddress, collateralPropertyId, marginToRelease, -marginToRelease, 0, 0, 
                                'contractMarginRelease', currentBlockHeight
                                );
                            }else{
                                diff*=-1
                                newMarginRequired-=diff
                            }
                        }else if(channel){
                            let diff = BigNumber(newMarginRequired).minus(match.sellerPosition.margin || 0).decimalPlaces(8).toNumber();
                            if (diff !== 0) await TallyMap.updateBalance(match.sellOrder.sellerAddress, collateralPropertyId, -diff, 0, diff, 0, 'contractTradeInitMargin_channelFlip', currentBlockHeight);
                        }

                        if (feeInfo.sellFeeFromMargin) {
                            newMarginRequired = BigNumber(newMarginRequired).minus(sellerFee).decimalPlaces(8).toNumber();
                        }

                        let hasSufficientReserve = await TallyMap.hasSufficientBalance(match.sellOrder.sellerAddress, collateralPropertyId, newMarginRequired);
                        
                        if (!hasSufficientReserve.hasSufficient) {
                            console.log(`Sell flip shortfall detected: ${JSON.stringify(hasSufficientBalance)}`);
                            let contractUndo = BigNumber(hasSufficientBalance.shortfall)
                                .dividedBy(initialMarginPerContract)
                                .decimalPlaces(0, BigNumber.ROUND_CEIL)
                                .toNumber();

                            flipShort -= contractUndo;
                            newMarginRequired = BigNumber(initialMarginPerContract).times(new BigNumber(flipShort)).decimalPlaces(8).toNumber();
                        }

                        await TallyMap.updateBalance(
                            match.sellOrder.sellerAddress, collateralPropertyId, -newMarginRequired, 0, newMarginRequired, 0, 
                            'contractTradeInitMargin', currentBlockHeight
                        );

                        await marginMap.setInitialMargin(match.sellOrder.sellerAddress, match.sellOrder.contractId, newMarginRequired);
                        await marginMap.recordMarginMapDelta(match.sellOrder.sellerAddress, match.sellOrder.contractId, 
                            match.sellerPosition.contracts - match.sellOrder.amount, match.sellOrder.amount, 0, 0, 0, 
                            'updateContractBalancesFlip',currentBlockHeight
                        );

                        let refreshedBalanceB = await TallyMap.getTally(match.sellOrder.sellerAddress,collateralPropertyId)
                        //this.adjustOrdersForAddress(match.sellOrder.sellerAddress, match.sellOrder.contractId, refreshedBalanceB, match.sellerPosition)

                        console.log(`Sell flip logic updated: closed=${closedContracts}, flipped=${flipShort}`);
                    }

                    console.log('about to go into logic brackets for init margin '+isBuyerReducingPosition + ' seller reduce? '+ isSellerReducingPosition+ ' channel? '+channel)
                
                    console.log('looking at feeInfo obj '+JSON.stringify(feeInfo))
                    if(!isBuyerReducingPosition&&!match.buyOrder.liq){
                        if(channel==false){
                            // Use the instance method to set the initial margin
                            console.log('moving margin buyer not channel not reducing '+counter+' '+match.buyOrder.buyerAddress+' '+match.buyOrder.contractId+' '+match.buyOrder.amount+' '+match.buyOrder.marginUsed)
                            const txid = match?.txid || '';
                            match.buyerPosition = await ContractRegistry.moveCollateralToMargin(match.buyOrder.buyerAddress, match.buyOrder.contractId,match.buyOrder.amount, match.tradePrice, match.buyOrder.price,false,match.buyOrder.marginUsed,channel,null,currentBlockHeight,feeInfo,match.buyOrder.maker,debugFlag,txid,match.buyerPosition)
                            console.log('looking at feeInfo obj '+JSON.stringify(feeInfo))
                        }else if(channel==true){
                            console.log('moving margin buyer channel not reducing '+counter+' '+match.buyOrder.buyerAddress+' '+match.buyOrder.contractId+' '+match.buyOrder.amount+' '+match.buyOrder.marginUsed)
                            const txid = match?.txid || '';
                            match.buyerPosition = await ContractRegistry.moveCollateralToMargin(match.buyOrder.buyerAddress, match.buyOrder.contractId,match.buyOrder.amount, match.buyOrder.price, match.buyOrder.price,false,match.buyOrder.marginUsed,channel, match.channelAddress,currentBlockHeight,feeInfo,match.buyOrder.maker,debugFlag,txid,match.buyerPosition)                  
                        }
                        //console.log('buyer position after moveCollat '+match.buyerPosition)
                    }
                    // Update MarginMap for the contract series
                    console.log(' addresses in match '+match.buyOrder.buyerAddress+' '+match.sellOrder.sellerAddress)
                    if(!isSellerReducingPosition&&!match.sellOrder.liq){
                        if(channel==false){
                            // Use the instance method to set the initial margin
                            console.log('moving margin seller not channel not reducing '+counter+' '+match.sellOrder.sellerAddress+' '+match.sellOrder.contractId+' '+match.sellOrder.amount+' '+match.sellOrder.initMargin)
                            match.sellerPosition = await ContractRegistry.moveCollateralToMargin(match.sellOrder.sellerAddress, match.sellOrder.contractId,match.sellOrder.amount, match.tradePrice,match.sellOrder.price, true, match.sellOrder.marginUsed,channel,null,currentBlockHeight,feeInfo,match.buyOrder.maker,match.sellerPosition)
                        }else if(channel==true){
                            console.log('moving margin seller channel not reducing '+counter+' '+match.sellOrder.sellerAddress+' '+match.sellOrder.contractId+' '+match.sellOrder.amount+' '+match.sellOrder.initMargin)
                            match.sellerPosition = await ContractRegistry.moveCollateralToMargin(match.sellOrder.sellerAddress, match.sellOrder.contractId,match.sellOrder.amount, match.sellOrder.price,match.sellOrder.price, true, match.sellOrder.marginUsed,channel, match.channelAddress,currentBlockHeight,feeInfo,match.buyOrder.maker,match.sellerPosition)
                        }
                        console.log('sellerPosition after moveCollat '+match.sellerPosition)
                    }


                    //console.log('checking position for trade processing '+JSON.stringify(match.buyerPosition) +' buyer size '+' seller size '+JSON.stringify(match.sellerPosition))
                    //console.log('reviewing Match object before processing '+JSON.stringify(match))
                    // Update contract balances for the buyer and seller
                    let close = false
                    let flip = false
                    if((isBuyerReducingPosition||isSellerReducingPosition)&&(isBuyerFlippingPosition==false||isSellerFlippingPosition==false)){
                        close = true
                    }else if(isBuyerFlippingPosition==true||isSellerFlippingPosition==true){
                        flip=true
                    }
                    if(channel==true){
                        console.log('checking match obj before calling update contract balances '+JSON.stringify(match))
                    }

                    console.log('close? flip? '+close+' '+flip)

                    // ========== FIX: Capture avgPrice BEFORE position update ==========
                    // This is critical for same-block closes where the position may flip
                    // and then close, causing avgPrice to be set to null before we can use it
                    const buyerAvgPriceBeforeUpdate = match.buyerPosition.avgPrice;
                    const sellerAvgPriceBeforeUpdate = match.sellerPosition.avgPrice;
                    // ===================================================================

                    let positions = await marginMap.updateContractBalancesWithMatch(match, channel, buyerClosed,flipLong,sellerClosed,flipShort,currentBlockHeight)
                 
                    const isLiq = Boolean(match.sellOrder.liq||match.buyOrder.liq)

                    const trade = {
                        buyerPosition: positions.bp,
                        sellerPosition: positions.sp,
                        buyerFee: buyerFee.decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber(),
                        sellerFee: sellerFee.decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber(),
                        contractId: match.sellOrder.contractId,
                        amount: match.sellOrder.amount,
                        price: match.tradePrice,
                        buyerAddress: match.buyOrder.buyerAddress,
                        sellerAddress: match.sellOrder.sellerAddress,
                        sellerTx: match.sellOrder.sellerTx,
                        buyerTx: match.buyOrder.buyerTx,
                        buyerClose: buyerClosed,
                        sellerClose: sellerClosed,
                        block: currentBlockHeight,
                        buyerFullClose: buyerFullyClosed,
                        sellerFullClose: sellerFullyClosed,
                        flipLong: flipLong,
                        flipShort: flipShort,
                        channel: channel,
                        liquidation: isLiq,
                        remainderLiq: 0
                        // other relevant trade details...
                    };

                    const deltas = this.deriveTradeDelta(
                            match,
                            buyerClosed,
                            sellerClosed,
                            flipLong,
                            flipShort
                        );

                        const buyerTradeRecord = Clearing.recordTrade(
                            trade.contractId,
                            trade.buyerAddress,
                            deltas.buyer.opened,    // opened
                            buyerClosed,            // closed
                            trade.price,
                            match.buyOrder.txid,
                            true
                        );

                        const sellerTradeRecord = Clearing.recordTrade(
                            trade.contractId,
                            trade.sellerAddress,
                            deltas.seller.opened,   // opened
                            sellerClosed,           // closed
                            trade.price,
                            match.sellOrder.txid,
                            false
                        );

                        const closesBuyer = buyerClosed;
                        // how many of these closes belong to same-block opens?
                        const buyerClosesAgainstAvg  = buyerTradeRecord.consumedFromOpened;
                        const sellerClosesAgainstAvg = sellerTradeRecord.consumedFromOpened
                        // settlement prices
                        const buyerAvg = match.buyerPosition.avgPrice;
                        let sellerClosesAgainstLast = sellerClosed- sellerClosesAgainstAvg;
                        let buyerClosesAgainstLast = buyerClosed- buyerClosesAgainstAvg
                    console.log('trade '+JSON.stringify(trade))
                    match.buyerPosition = positions.bp
                    match.sellerPosition = positions.sp
                    console.log('checking positions based on mMap vs. return of object in contract update '+JSON.stringify(positions)+' '+JSON.stringify(match.buyerPosition) + ' '+JSON.stringify(match.sellerPosition))

                    console.log('checking positions after contract adjustment, seller '+JSON.stringify(match.sellerPosition) + ' buyer '+JSON.stringify(match.buyerPosition))
                    let buyerOpenMarkPNL = 0
                    let sellerOpenMarkPNL = 0
                         // ========== MARK BASIS (A): realize any OPENED portion to lastPrice ==========
                        // This rebases same-block opens to mark immediately, so later closes can use lastPrice.
                        const amount = Number(trade.amount || 0);

                        const buyerClose = Number(trade.buyerClose || 0);
                        const sellerClose = Number(trade.sellerClose || 0);

                        // “Opened” is what’s left after close + flip allocation
                        const buyerOpened  = Math.max(0, amount - buyerClose );
                        const sellerOpened = Math.max(0, amount - sellerClose);
                        console.log('buyer opened '+buyerOpened+' '+amount+ ' '+buyerClose+' '+flipLong)
                        console.log('seller opened '+sellerOpened+' '+amount+ ' '+sellerClose+' '+flipShort)

                        if (buyerOpened > 0) {
                            let exit = lastPrice   
                            let type = 'buyerNewContractTieOff'
                            if(isLiquidation){
                                type+= 'Liq'
                                exit=thisPrice}
                                console.log('tie off in liquidation? '+isLiquidation+' '+exit+' '+lastPrice+' '+thisPrice)
                            buyerOpenMarkPNL = await marginMap.settlePNL(
                                trade.buyerAddress,
                                buyerOpened,      // long opened
                                exit,         // exit = mark
                                trade.price,       // entry = fill
                                trade.contractId,
                                currentBlockHeight,
                                isInverse,
                                perContractNotional
                            );

                            if(buyerOpenMarkPNL>0){
                                await TallyMap.updateBalance(
                                trade.buyerAddress,
                                collateralPropertyId,
                                buyerOpenMarkPNL,
                                0, 0, 0,
                                'buyerNewContractTieOff',
                                currentBlockHeight
                                );
                            }else{
                                await this.sourceFundsForLoss( 
                                    trade.buyerAddress,
                                    collateralPropertyId,
                                    Math.abs(buyerOpenMarkPNL),
                                    currentBlockHeight,
                                    trade.contractId,
                                    true)
                            }                            
                          }

                        if (sellerOpened > 0) {
                            let exit = lastPrice
                            let type = 'sellerNewContractTieOff'
                             if(isLiquidation){
                                type+= 'Liq'
                                exit=thisPrice}
                               console.log('tie off in liquidation? '+isLiquidation+' '+exit+' '+lastPrice+' '+thisPrice)


                            sellerOpenMarkPNL = await marginMap.settlePNL(
                                trade.sellerAddress,
                                -sellerOpened,     // short opened
                                exit,         // exit = mark
                                trade.price,       // entry = fill
                                trade.contractId,
                                currentBlockHeight,
                                isInverse,
                                perContractNotional
                            );

                            if(sellerOpenMarkPNL>0){
                                await TallyMap.updateBalance(
                                trade.sellerAddress,
                                collateralPropertyId,
                                sellerOpenMarkPNL,
                                0, 0, 0,
                                type,
                                currentBlockHeight
                                );
                            }else{
                                await this.sourceFundsForLoss( 
                                    trade.sellerAddress,
                                    collateralPropertyId,
                                    Math.abs(sellerOpenMarkPNL),
                                    currentBlockHeight,
                                    trade.contractId,
                                    true)
                            }

                            
                        }    

                    console.log('seller and buyer tie offs'+sellerOpenMarkPNL+' '+buyerOpenMarkPNL+' '+sellerOpened+' '+buyerOpened)

                    // Record the contract trade
                    await this.recordContractTrade(trade, currentBlockHeight);

                    // Realize PnL if the trade reduces the position size
                    let buyerPnl = new BigNumber(0), sellerPnl = new BigNumber(0);
                    console.log('do we realize PNL? '+isBuyerReducingPosition+' '+isBuyerFlippingPosition+' '+match.buyOrder.liq+' '+isSellerReducingPosition+' '+isSellerFlippingPosition+' '+match.sellOrder.liq)
                    let closedShorts=0
                    let realizedBuyerLoss = 0
                    let realizedSellerLoss = 0
                    let realizedBuyerProfit = 0
                    let realizedSellerProfit = 0

                    if((isBuyerReducingPosition||isBuyerFlippingPosition)/*&&!match.buyOrder.liq*/){
                        closedShorts = match.buyOrder.amount

                        if(isBuyerFlippingPosition){
                            closedShorts-=flipLong
                        }
                        console.log('closed contracts '+match.buyOrder.amount+' '+closedShorts)
                        //this loops through our position history and closed/open trades in that history to figure a precise entry price for the trades 
                        //on a LIFO basis that are being retroactively 'closed' by reference here
                        //console.log('about to call trade history manager '+match.buyOrder.contractId)
                        //const LIFO = tradeHistoryManager.calculateLIFOEntry(match.buyOrder.buyerAddress, closedContracts, match.buyOrder.contractId)
                        //{AvgEntry,blockTimes}
                        
                        // ========== FIX: Use pre-update avgPrice for settlement ==========
                        // After updateContractBalancesWithMatch, avgPrice may be null if the
                        // position closed. Use the captured value from before the update.
                        let avgEntry = buyerAvgPriceBeforeUpdate || match.buyerPosition.avgPrice;
                        // ===================================================================
                        
                        //then we take that avg. entry price, not for the whole position but for the chunk that is being closed
                        //and we figure what is the PNL that one would show on their taxes, to save a record.
                
                        match.buyerPosition = await marginMap.realizePnl(match.buyOrder.buyerAddress, closedShorts, match.tradePrice, avgEntry, isInverse, perContractNotional, match.buyerPosition, true,match.buyOrder.contractId);
                        //then we will look at the last settlement mark price for this contract or default to the LIFO Avg. Entry if
                        //the closing trade and the opening trades reference happened in the same block (exceptional, will add later)
                        
                        let settlementPNL =
                                await marginMap.settlePNL(
                                    trade.buyerAddress,
                                    -buyerClosed,
                                    trade.price,
                                    lastPrice,
                                    trade.contractId,
                                    currentBlockHeight,
                                    isInverse,
                                    perContractNotional
                                  );
                        console.log('settlementPNL for buyer '+settlementPNL)
                        
                        //then we figure out the aggregate position's margin situation and liberate margin on a pro-rata basis 
                        const reduction = await marginMap.reduceMargin(match.buyerPosition, closedShorts, initialMarginPerContract, match.buyOrder.contractId, match.buyOrder.buyerAddress, false, feeInfo.buyFeeFromMargin,buyerFee)
                        //{netMargin,mode}
                        const sufficientMargin = await TallyMap.hasSufficientMargin(match.buyOrder.buyerAddress,collateralPropertyId,reduction)
                          
                        if(reduction!==0&&sufficientMargin.hasSufficient){
                            //console.log('reduction about to pass to TallyMap' +reduction)
                            await TallyMap.updateBalance(match.buyOrder.buyerAddress, collateralPropertyId, reduction, 0, -reduction, 0, 'contractTradeMarginReturn',currentBlockHeight)              
                        }
                       
                        let debit = settlementPNL < 0 ? Math.abs(settlementPNL) : 0;
                        if (debit > 0) {
                          const recovery = await this.sourceFundsForLoss(
                            match.buyOrder.buyerAddress,
                            collateralPropertyId,
                            debit,
                            currentBlockHeight,
                            trade.contractId
                          );

                          realizedBuyerLoss=recovery.totalUsed

                          if (recovery.remaining > 0) {
                            console.log(`⚠️ Buyer still short ${recovery.remaining}`);
                            // optional: escalate to insurance/liquidation path
                            trade.remainderLiq = recovery.remainder

                          }
                        } else {
                            realizedBuyerProfit= settlementPNL
                        }



                        buyerPnl=new BigNumber(settlementPNL)       
                        const savePNLParams = {height:currentBlockHeight, contractId:match.buyOrder.contractId, accountingPNL: match.buyerPosition.realizedPNL, isBuyer: true, 
                            address: match.buyOrder.buyerAddress, amount: closedShorts, tradePrice: match.tradePrice, collateralPropertyId: collateralPropertyId,
                            timestamp: new Date().toISOString(), txid: match.buyOrder.buyerTx, settlementPNL: settlementPNL, marginReduction:reduction, avgEntry: avgEntry}
                        //console.log('preparing to call savePNL with params '+JSON.stringify(savePNLParams))
                        tradeHistoryManager.savePNL(savePNLParams)
                    }

                    if ((isSellerReducingPosition||isSellerFlippingPosition)/*&&!match.sellOrder.liq*/){
                        let closedContracts = match.sellOrder.amount

                        if(isSellerFlippingPosition){
                            closedContracts-=flipShort
                        }
                        
                        // ========== FIX: Use pre-update avgPrice for settlement ==========
                        // After updateContractBalancesWithMatch, avgPrice may be null if the
                        // position closed. Use the captured value from before the update.
                        let avgEntry = sellerAvgPriceBeforeUpdate || match.sellerPosition.avgPrice;
                        // ===================================================================
                      
                        console.log('position before realizePnl '+JSON.stringify(match.sellerPosition))
                        match.sellerPosition = await marginMap.realizePnl(match.sellOrder.sellerAddress, closedContracts, match.tradePrice, avgEntry, isInverse, perContractNotional, match.sellerPosition, false,match.sellOrder.contractId);
                        //then we will look at the last settlement mark price for this contract or default to the LIFO Avg. Entry if
                        //the closing trade and the opening trades reference happened in the same block (exceptional, will add later)
                        
                        console.log('position before settlePNL '+JSON.stringify(match.sellerPosition))
                           
                        let settlementPNL =
                                await marginMap.settlePNL(
                                    trade.sellerAddress,
                                    sellerClosed,
                                    trade.price,
                                    lastPrice,
                                    trade.contractId,
                                    currentBlockHeight,
                                    isInverse,
                                    perContractNotional
                                  )


                        console.log('settlementPNL for seller '+settlementPNL)
                    
                        //then we figure out the aggregate position's margin situation and liberate margin on a pro-rata basis 
                        console.log('position before going into reduce Margin '+closedContracts+' '+flipShort+' '+match.sellOrder.amount/*JSON.stringify(match.sellerPosition)*/)
                        const reduction = await marginMap.reduceMargin(match.sellerPosition, closedContracts, initialMarginPerContract, match.sellOrder.contractId, match.sellOrder.sellerAddress, false, feeInfo.sellFeeFromMargin, sellerFee)
                        console.log('sell reduction '+JSON.stringify(reduction))
                        //{netMargin,mode} 
                        const sufficientMargin = await TallyMap.hasSufficientMargin(match.sellOrder.sellerAddress,collateralPropertyId,reduction)
                        
                        if(reduction !==0&&sufficientMargin.hasSufficient){
                            await TallyMap.updateBalance(match.sellOrder.sellerAddress, collateralPropertyId, reduction, 0, -reduction, 0, 'contractTradeMarginReturn',currentBlockHeight)              
                        } 

                        let debit = settlementPNL < 0 ? Math.abs(settlementPNL) : 0;
                        if (debit > 0) {
                          const recovery = await this.sourceFundsForLoss(
                            match.sellOrder.sellerAddress,
                            collateralPropertyId,
                            debit,
                            currentBlockHeight,
                            trade.contractId
                          );
                            realizedSellerLoss=recovery.totalUsed
                          if (recovery.remaining > 0) {
                            console.log(`⚠️ Seller still short ${recovery.remaining}`);
                            trade.remainderLiq = recovery.remainder
                          }
                        } else {
                            realizedSellerProfit= settlementPNL
                        }

                        sellerPnl=new BigNumber(settlementPNL) 
                        const savePNLParams = {height:currentBlockHeight, contractId:match.sellOrder.contractId, accountingPNL: match.sellerPosition.realizedPNL, isBuyer:false, 
                            address: match.sellOrder.sellerAddress, amount: closedContracts, tradePrice: match.tradePrice, collateralPropertyId: collateralPropertyId,
                            timestamp: new Date().toISOString(), txid: match.sellOrder.sellerTx, settlementPNL: settlementPNL, marginReduction:reduction, avgEntry: avgEntry}
                        //console.log('preparing to call savePNL with params '+JSON.stringify(savePNLParams))
                        tradeHistoryManager.savePNL(savePNLParams)
                    }

                    if(realizedSellerProfit > 0) {
                        const realizedSellerProfitBN = new BigNumber(realizedSellerProfit)
                    }
            
                const realizedSellerProfitBN = new BigNumber(realizedSellerProfit)
            if (isLiquidation) {
                // Liquidation: credit full profit - funded by counterparty loss or tie-off
                await TallyMap.updateBalance(
                    match.sellOrder.sellerAddress,
                    collateralPropertyId,
                    realizedSellerProfitBN.toNumber(),
                    0, 0, 0,
                    'liquidationProfit',
                    currentBlockHeight
                );
            } else {
                // Normal trade: cap immediate payout by realized loss funding
                console.log('real profit '+realizedSellerProfit+' '+realizedBuyerLoss)
                let immediate = BigNumber.min(realizedSellerProfitBN, realizedBuyerLoss);
                const deferred  = realizedSellerProfitBN.minus(immediate);
                if(!isBuyerReducingPosition||isBuyerFlippingPosition){
                    immediate = realizedSellerProfitBN
                }
                console.log("BASDFSDF deffered and immediate in seller contract profit settlement "+deferred+' '+immediate)

                    if (immediate.gt(0)) {
                        await TallyMap.updateBalance(
                            match.sellOrder.sellerAddress,
                            collateralPropertyId,
                            immediate.toNumber(),
                            0, 0, 0,
                            'contractTradeSettlement',
                            currentBlockHeight
                        );
                    }

                    if (deferred.gt(0)) {
                        trade.sellerDeferredPnl = deferred.toNumber();
                    }
            }

        if(realizedBuyerProfit > 0) {
            const realizedBuyerProfitBN = new BigNumber(realizedBuyerProfit)
            console.log('realizing buyer profit maybe '+realizedBuyerProfit)
            if (isLiquidation) {
                // Liquidation: credit full profit
                await TallyMap.updateBalance(
                    match.buyOrder.buyerAddress,
                    collateralPropertyId,
                    realizedBuyerProfitBN.toNumber(),
                    0, 0, 0,
                    'liquidationProfit',
                    currentBlockHeight
                );
            } else {
                // Normal trade: cap immediate payout by realized loss funding
                let immediate = BigNumber.min(realizedBuyerProfitBN, realizedSellerLoss);
                const deferred  = realizedBuyerProfitBN.minus(immediate);
                if(!isSellerReducingPosition||isSellerFlippingPosition){
                    immediate = realizedBuyerProfitBN
                    if(isSellerFlippingPosition){

                    }
                }
                if (immediate.gt(0)) {
                    await TallyMap.updateBalance(
                        match.buyOrder.buyerAddress,
                        collateralPropertyId,
                        immediate.toNumber(),
                        0, 0, 0,
                        'contractTradeSettlement',
                        currentBlockHeight
                    );
                }

                if (deferred.gt(0)) {
                    trade.buyerDeferredPnl = deferred.toNumber();
                }
            }
        }

                    const contractLTCValue = await VolumeIndex.getContractUnitLTCValue(trade.contractId)
                    const totalContractsLTCValue = new BigNumber(contractLTCValue).times(trade.amount).decimalPlaces(8).toNumber()
                    if (!Number.isFinite(Number(totalContractsLTCValue))) {
                      throw new Error(`${contractLTCValue} ${trade.amount}`);
                    }
                    console.log('contract LTC Value '+contractLTCValue)
                    if(contractLTCValue==0){throw new Error()}
      			await VolumeIndex.saveVolumeDataById(
                        trade.contractId,
                        trade.amount,
                        totalContractsLTCValue,
                        trade.price,
                        trade.block,
                        'contract')

                     //see if the trade qualifies for increased Liquidity Reward
                    var qualifiesBasicLiqReward = await this.evaluateBasicLiquidityReward(match,channel,true)
                    var qualifiesEnhancedLiqReward = await this.evaluateEnhancedLiquidityReward(match,channel)
                    if(qualifiesBasicLiqReward){
                        var notionalTokens = notionalValue*trade.amount
                        const liqRewardBaseline = await VolumeIndex.baselineLiquidityReward(notionalTokens,0.000025,collateralPropertyId)
                        TallyMap.updateBalance(match.sellOrder.sellerAddress,3,liqRewardBaseline,0,0,0,'baselineLiquidityReward')
                        TallyMap.updateBalance(match.buyOrder.buyerAddress,3,liqRewardBaseline,0,0,0,'baselineLiquidityReward')
                    }

                    if(qualifiesEnhancedLiqReward){
                        var notionalTokens = notionalValue*trade.amount
                        const liqRewardBaseline= await VolumeIndex.calculateLiquidityReward(notionalTokens)
                        TallyMap.updateBalance(match.sellOrder.sellerAddress,3,liqRewardBaseline,0,0,0,'enhancedLiquidityReward')
                        TallyMap.updateBalance(match.buyOrder.buyerAddress,3,liqRewardBaseline,0,0,0,'enhancedLiquidityReward')
                    }
                    // Save the updated margin map
                    await marginMap.saveMarginMap(currentBlockHeight);
                    
                            const delta = buyerPnl.plus(sellerPnl);
                    
                    if (!isLiquidation&&(isSellerReducingPosition||isSellerFlippingPosition)&&(isBuyerReducingPosition||isBuyerFlippingPosition)) {
                        if (delta.gt(0)) {
                            // Net profit in this trade (winner with no/partial loser to fund)
                            // Creates IOU claims for the unfunded portion
                            await PnlIou.addIouClaims(
                                trade.contractId,
                                collateralPropertyId,
                                currentBlockHeight,
                                trade.buyerAddress,
                                trade.sellerAddress,
                                buyerPnl,
                                sellerPnl,
                                delta
                            );
                            
                            // Record as profit (system owes more)
                            await PnlIou.addProfit(
                                trade.contractId,
                                collateralPropertyId,
                                delta,
                                currentBlockHeight
                            );
                        } else if (delta.lt(0)) {
                            // Net loss in this trade (loser with no/partial winner)
                            // Real tokens were debited - available for IOU payout
                            await PnlIou.addLoss(
                                trade.contractId,
                                collateralPropertyId,
                                delta.abs(),
                                currentBlockHeight
                            );
                        }
                        // If delta === 0, trade was fully offset internally, nothing to track
                    }

                    trade.delta = delta;
                    trades.push(trade);                    
            }
             return trades
		}
	

        /**
		 * calculateFee
		 * - Positive result  => taker fee (debit)
		 * - Negative result  => maker rebate (credit)
		 *
		 * Inputs:
		 *  amount:           trade size (contracts or units)
		 *  columnAIsSeller:  bool
		 *  columnAIsMaker:   bool | undefined  (legacy tx may omit)
		 *  isInverse:        bool
		 *  isBuyer:          bool  (this side is the buyer?)
		 *  lastMark:         price used to value notional
		 *  notionalValue:    contract notional
		 *  channel:          bool (true = off-chain channel => fees ÷ 10)
		 */
    	calculateFee({
            amountBuy,
            amountSell,
            buyMaker,
            sellMaker,
            isInverse,
            lastMark,
            notionalValue,
            channel
        }) {
            const BNnotionalValue = new BigNumber(notionalValue);
            const BNlastMark      = new BigNumber(lastMark);
            const BNamountBuy     = new BigNumber(amountBuy);
            const BNamountSell    = new BigNumber(amountSell);

            let takerRate = new BigNumber(0.0005);     // +5 bps
            let makerRate = new BigNumber(-0.00025);   // –2.5 bps rebate

            if (channel === true) {
                takerRate = takerRate.div(10);         // +0.5 bps
                makerRate = makerRate.div(10);         // –0.25 bps
            }

            const baseFee = (bps, amt) =>
                isInverse
                    ? new BigNumber(bps).times(BNnotionalValue).div(BNlastMark).times(amt)
                    : new BigNumber(bps).times(BNlastMark).div(BNnotionalValue).times(amt);

            // ----------------------------------------------------------
            // CASE 1 — Neither side is maker → same-block on-chain match
            // → apply “half taker” to both: 1.25bps each (split of 2.5bps)
            // ----------------------------------------------------------
            if (!buyMaker && !sellMaker) {
                // full taker fee on buy side
                let raw = baseFee(takerRate, BNamountBuy).abs();

                let sats = raw.times(1e8).integerValue(BigNumber.ROUND_FLOOR);

                // ensure final total fee is EVEN sats
                if (!sats.mod(2).isZero()) sats = sats.plus(1);

                // split evenly
                const half = sats.idiv(2);

                return {
                    buyerFee:  half.div(1e8),
                    sellerFee: half.div(1e8)
                };
            }

            // ----------------------------------------------------------
            // CASE 2 — Exactly one maker → normal match
            // ----------------------------------------------------------
            const buyerIsTaker = (buyMaker === false);
            const sellIsTaker  = (sellMaker === false);

            // exactly one of these is taker
            const takerSide  = buyerIsTaker ? 'buyer' : 'seller';
            const makerSide  = buyerIsTaker ? 'seller' : 'buyer';

            const takerAmt = buyerIsTaker ? BNamountBuy : BNamountSell;

            // compute taker fee once
            let rawTaker = baseFee(takerRate, takerAmt).abs();

            let sats = rawTaker.times(1e8).integerValue(BigNumber.ROUND_FLOOR);

            // make sure sats is EVEN → avoids downstream mint / burn
            if (!sats.mod(2).isZero()) sats = sats.plus(1);

            const makerRebate = sats.negated().div(2);

            // package results
            let buyerFee, sellerFee;

            if (takerSide === 'buyer') {
                buyerFee  =  sats.div(1e8)
                sellerFee = makerRebate.div(1e8)
            } else {
                buyerFee  = makerRebate.div(1e8)
                sellerFee =  sats.div(1e8)
            }

            return { buyerFee, sellerFee };
        }

		resolveMaker(columnAIsSeller, columnAIsMaker) {
		  const makerIsA = (columnAIsMaker === true)
		    ? true
		    : (columnAIsMaker === false)
		      ? false
		      : !columnAIsSeller;          // inference for legacy tx
		  return {
		    sellerMaker: columnAIsSeller && makerIsA,
		    buyerMaker:  !columnAIsSeller && makerIsA,
		  };
		}

        deriveTradeDelta(match, buyerClosed, sellerClosed, flipLong, flipShort) {
            const beforeBuyer  = match.buyerPosition.contracts - match.buyOrder.amount + buyerClosed;
            const afterBuyer   = match.buyerPosition.contracts;

            const beforeSeller = match.sellerPosition.contracts + match.sellOrder.amount - sellerClosed;
            const afterSeller  = match.sellerPosition.contracts;

            // ------------------------------------------------------------
            // Compute opened INDEPENDENTLY for buyer and seller
            // A party "opens" when they're not closing existing positions
            // ------------------------------------------------------------
            const tradeAmount = match.buyOrder.amount;
            
            // Buyer opens = trade amount minus what they closed
            // If buyer closed 3 of 5, they opened 2 new longs
            let buyerOpened = tradeAmount - buyerClosed;
            if (flipLong > 0) {
                // Flip case: they closed all shorts and opened new longs
                buyerOpened = flipLong;
            }
            
            // Seller opens = trade amount minus what they closed  
            // If seller closed 3 of 5, they opened 2 new shorts
            let sellerOpened = tradeAmount - sellerClosed;
            if (flipShort > 0) {
                // Flip case: they closed all longs and opened new shorts
                sellerOpened = flipShort;
            }

            return {
                buyer: {
                    delta: match.buyOrder.amount,
                    opened: buyerOpened,
                    wasLong: beforeBuyer > 0,
                    isLong: afterBuyer > 0
                },
                seller: {
                    delta: -match.sellOrder.amount,
                    opened: sellerOpened,
                    wasLong: beforeSeller > 0,
                    isLong: afterSeller > 0
                }
            };
        }


  async locateFee(
		  match,
		  reserveBalanceA,
		  reserveBalanceB,
		  collateralPropertyId,
		  buyerFee,                  // signed: >0 taker debit, <0 maker rebate
		  sellerFee,                 // signed: >0 taker debit, <0 maker rebate
		  isBuyerReducingPosition,
		  isSellerReducingPosition,
		  block,
		  isLiq,
		  cacheAdd = 0               // ⬅️ sum of feeCache writes for this match (Number), default 0
		) {
		  const TallyMap = require('./tally.js');
		  const MarginMap = require('./marginMap.js');
		  const marginMap = await MarginMap.loadMarginMap(match.sellOrder.contractId);

		  const RD = BigNumber.ROUND_DOWN;
		  buyerFee  = new BigNumber(buyerFee).decimalPlaces(8, RD).toNumber();
		  sellerFee = new BigNumber(sellerFee).decimalPlaces(8, RD).toNumber();
		  cacheAdd  = new BigNumber(cacheAdd).decimalPlaces(8, RD).toNumber();

		  let buyFeeFromMargin = false;
		  let buyFeeFromReserve = false;
		  let buyFeeFromAvailable = false;
		  let sellFeeFromMargin = false;
		  let sellFeeFromReserve = false;
		  let sellFeeFromAvailable = false;

		  const feeInfo = {
		    sellFeeFromAvailable,
		    sellFeeFromReserve,
		    sellFeeFromMargin,
		    buyFeeFromAvailable,
		    buyFeeFromReserve,
		    buyFeeFromMargin,
		    sellerFee,
		    buyerFee,
		  };

		  console.log('🔍 [locateFee] Checking balances to apply fees...');
		  console.log('🧾 Buyer fee:', buyerFee, ', Seller fee:', sellerFee, ', Property:', collateralPropertyId);

		  const buyerAddr = match.buyOrder.buyerAddress;
		  const sellerAddr = match.sellOrder.sellerAddress;
		  const txid = match.txid || `contract-fee-${block}`;
		  const buyerIsVirtualAmm = buyerAddr === 'amm' || (typeof buyerAddr === 'string' && buyerAddr.startsWith('amm:'));
		  const sellerIsVirtualAmm = sellerAddr === 'amm' || (typeof sellerAddr === 'string' && sellerAddr.startsWith('amm:'));

		  // -------- BUYER SIDE --------
		  if (buyerIsVirtualAmm) {
		    console.log('Skipping buyer fee settlement for virtual AMM sender');
		  } else if (buyerFee < 0) {
		    // Negative = rebate → always credit
		    await TallyMap.updateBalance(
		      buyerAddr, collateralPropertyId,
		      -buyerFee, 0, 0, 0, 'contractFeeRebate', block, txid
		    );
		    feeInfo.buyFeeFromAvailable = true;
		    console.log('💚 Credited buyer rebate (available):', new BigNumber(-buyerFee).toFixed(8));
		  } else if (buyerFee > 0) {
		    // Positive = debit → sufficiency gates
		    let buyerAvail   = (await TallyMap.hasSufficientBalance(buyerAddr, collateralPropertyId, buyerFee)).hasSufficient;
		    let buyerReserve = (await TallyMap.hasSufficientReserve(buyerAddr, collateralPropertyId, buyerFee)).hasSufficient;
		    let buyerMargin  = (await TallyMap.hasSufficientMargin(buyerAddr, collateralPropertyId, buyerFee)).hasSufficient;

		    console.log(`🧾 Buyer available: ${buyerAvail}, reserve: ${buyerReserve}, margin: ${buyerMargin}`);

		    if (buyerAvail) {
		      await TallyMap.updateBalance(buyerAddr, collateralPropertyId, -buyerFee, 0, 0, 0, 'contractFee', block, txid);
		      feeInfo.buyFeeFromAvailable = true;
		      console.log('💰 Buyer fee from available');
		    } else if (buyerReserve) {
		      await TallyMap.updateBalance(buyerAddr, collateralPropertyId, 0, -buyerFee, 0, 0, 'contractFee', block, txid);
		      feeInfo.buyFeeFromReserve = true;
		      console.log('💰 Buyer fee from reserve');
		    } else if (buyerMargin) {
		      await TallyMap.updateBalance(buyerAddr, collateralPropertyId, 0, 0, -buyerFee, 0, 'contractFee', block, txid);
		      feeInfo.buyFeeFromMargin = true;
		      console.log('💰 Buyer fee from margin');
		    } else {
		      console.warn('⚠️ Buyer fee could not be debited from any source.');
		    }

		  }

		  // -------- SELLER SIDE --------
		  if (sellerIsVirtualAmm) {
		    console.log('Skipping seller fee settlement for virtual AMM sender');
		  } else if (sellerFee < 0) {
		    await TallyMap.updateBalance(
		      sellerAddr, collateralPropertyId,
		      -sellerFee, 0, 0, 0, 'contractFeeRebate', block, txid
		    );
		    feeInfo.sellFeeFromAvailable = true;
		    console.log('💚 Credited seller rebate (available):', new BigNumber(-sellerFee).toFixed(8));
		  } else if (sellerFee > 0) {
		    let sellerAvail   = (await TallyMap.hasSufficientBalance(sellerAddr, collateralPropertyId, sellerFee)).hasSufficient;
		    let sellerReserve = (await TallyMap.hasSufficientReserve(sellerAddr, collateralPropertyId, sellerFee)).hasSufficient;
		    let sellerMargin  = (await TallyMap.hasSufficientMargin(sellerAddr, collateralPropertyId, sellerFee)).hasSufficient;

		    console.log(`🧾 Seller available: ${sellerAvail}, reserve: ${sellerReserve}, margin: ${sellerMargin}`);

		    if (sellerAvail) {
		      await TallyMap.updateBalance(sellerAddr, collateralPropertyId, -sellerFee, 0, 0, 0, 'contractFee', block, txid);
		      feeInfo.sellFeeFromAvailable = true;
		      console.log('💰 Seller fee from available');
		    } else if (sellerReserve) {
		      await TallyMap.updateBalance(sellerAddr, collateralPropertyId, 0, -sellerFee, 0, 0, 'contractFee', block, txid);
		      feeInfo.sellFeeFromReserve = true;
		      console.log('💰 Seller fee from reserve');
		    } else if (sellerMargin) {
		      await TallyMap.updateBalance(sellerAddr, collateralPropertyId, 0, 0, -sellerFee, 0, 'contractFee', block, txid);
		      feeInfo.sellFeeFromMargin = true;
		      console.log('💰 Seller fee from margin');
		    } else {
		      console.warn('⚠️ Seller fee could not be debited from any source.');
		    }
		  }

		  // -------- Reconciliation log (per match) --------
		  const takerPos = new BigNumber(Math.max(buyerFee, 0)).plus(Math.max(sellerFee, 0)).decimalPlaces(8, RD);
		  const makerNeg = new BigNumber(Math.max(-buyerFee, 0)).plus(Math.max(-sellerFee, 0)).decimalPlaces(8, RD);
		  const cacheBN  = new BigNumber(cacheAdd).decimalPlaces(8, RD);
		  const net      = takerPos.negated().plus(makerNeg).plus(cacheBN).decimalPlaces(8, RD);

		  console.log('[recon]',
		    'takerPos=', takerPos.toFixed(),
		    'makerNeg=', makerNeg.toFixed(),
		    'cacheAdd=', cacheBN.toFixed(),
		    'net=', net.toFixed()
		  );

		  console.log('✅ [locateFee] Fee sources determined:', JSON.stringify(feeInfo, null, 2));
		  return feeInfo;
		}

        /**
         * Route and cache a matched trade fee (buyer or seller).
         *
         * - Does NOT divide fee (full sats only)
         * - Correctly handles taker-only or dual-taker cases
         * - No double-splits (updateFeeCache does the only split)
         * - No misrouting to wrong contract ID
         *
         * @param {BigNumber} buyerFeeBN
         * @param {BigNumber} sellerFeeBN
         * @param {number} collateralPropertyId
         * @param {Object} match
         * @param {number} currentBlockHeight
         */
    async routeMatchFees(
        buyerFeeBN,
        sellerFeeBN,
        collateralPropertyId,
        match,
        currentBlockHeight
    ) {
        // Buyer taker fee (positive buyer, negative seller)
        if (buyerFeeBN.isGreaterThan(0) && sellerFeeBN.isLessThan(0)) {
            const feeToCache = buyerFeeBN.decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber();

            console.log("route: buyer taker fee → cache", feeToCache);

            await TallyMap.updateFeeCache(
                collateralPropertyId,
                feeToCache,
                match.buyOrder.contractId,
                currentBlockHeight,
                true
            );
        }

        // Seller taker fee (positive seller, negative buyer)
        if (sellerFeeBN.isGreaterThan(0) && buyerFeeBN.isLessThan(0)) {
            const feeToCache = sellerFeeBN.decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber();

            console.log("route: seller taker fee → cache", feeToCache);

            await TallyMap.updateFeeCache(
                collateralPropertyId,
                feeToCache,
                match.sellOrder.contractId,
                currentBlockHeight,
                true
            );
        }

        // Both positive → dual taker (rare but valid)
        if (buyerFeeBN.isGreaterThan(0) && sellerFeeBN.isGreaterThan(0)) {
            const buyerFeeToCache  = buyerFeeBN.decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber();
            const sellerFeeToCache = sellerFeeBN.decimalPlaces(8, BigNumber.ROUND_DOWN).toNumber();

            console.log("route: dual taker fee → buyer:", buyerFeeToCache, "seller:", sellerFeeToCache);

            await TallyMap.updateFeeCache(
                collateralPropertyId,
                buyerFeeToCache,
                match.buyOrder.contractId,
                currentBlockHeight,
                true
            );

            await TallyMap.updateFeeCache(
                collateralPropertyId,
                sellerFeeToCache,
                match.sellOrder.contractId,
                currentBlockHeight,
                true
            );
        }

        // If both negative or both zero → no fee handling required
    }



async processContractMatchesShort(matches, currentBlockHeight, channel) {
  const TallyMap = require('./tally.js');
  const ContractRegistry = require('./contractRegistry.js');
  const MarginMap = require('./marginMap.js');
  const tradeHistoryManager = new TradeHistory();

  if (!Array.isArray(matches)) {
      console.error('Matches is not an array:', matches);
      matches = [];
  }

  let counter = 0;
  for (const match of matches) {
    counter++;
    console.log(`Processing match ${counter}: ${JSON.stringify(match)}`);

    // 1. Validate match and load up-to-date state.
    if (match.buyOrder.buyerAddress === match.sellOrder.sellerAddress) {
      console.log(`Self-trade nullified for ${match.buyOrder.buyerAddress}`);
      continue;
    }
    await validateMatch(match);

    // 2. Calculate fees & update fee caches.
    const feeInfo = await calculateFees(match, channel,currentBlockHeight);
    // 3. Determine if flip logic applies and update collateral.
    const flipData = await handleFlipLogic(match, feeInfo, currentBlockHeight);
    
    // 4. Adjust collateral for non-reducing orders.
    await moveCollateral(match, feeInfo, channel, currentBlockHeight);
    
    // 5. Update contract balances (positions) using the match.
    const updatedPositions = await updateContractBalances(match, channel, flipData);
    match.buyerPosition = updatedPositions.bp;
    match.sellerPosition = updatedPositions.sp;

    // 6. Settle PnL if the trade reduces the position.
    await realizePnLAndSettle(match, currentBlockHeight);

    // 7. Record the trade.
    const trade = buildTradeObject(match, currentBlockHeight, flipData);
    await recordTrade(trade, currentBlockHeight);

    // 8. Update volume data and liquidity rewards.
    await updateVolumeAndRewards(match, currentBlockHeight);

    // Save the updated margin map after processing the match.
    await MarginMap.saveMarginMap(currentBlockHeight);
  }
  // Return something if needed.
  return;
}

// 1. Validate the match and load up-to-date state (positions, collateral, etc.)
async validateMatch(match) {
  // Check for self-trade
  if (match.buyOrder.buyerAddress === match.sellOrder.sellerAddress) {
    throw new Error(`Self-trade detected for ${match.buyOrder.buyerAddress}`);
  }
  // Load the margin map for this contract
  const marginMap = await MarginMap.loadMarginMap(match.sellOrder.contractId);
  match.buyerPosition = await marginMap.getPositionForAddress(match.buyOrder.buyerAddress, match.buyOrder.contractId);
  match.sellerPosition = await marginMap.getPositionForAddress(match.sellOrder.sellerAddress, match.buyOrder.contractId);
  if (!match.buyerPosition.address) match.buyerPosition.address = match.buyOrder.buyerAddress;
  if (!match.sellerPosition.address) match.sellerPosition.address = match.sellOrder.sellerAddress;
  
  // Attach collateral and notional info
  match.collateralPropertyId = await ContractRegistry.getCollateralId(match.buyOrder.contractId);
  const blob = await ContractRegistry.getNotionalValue(match.sellOrder.contractId, match.tradePrice);
  match.notionalValue = blob.notionalValue;
  match.perContractNotional = blob.notionalPerContract;
  // Also fetch tally (reserve/available) for each side if needed later.
  match.reserveA = await TallyMap.getTally(match.sellOrder.sellerAddress, match.collateralPropertyId);
  match.reserveB = await TallyMap.getTally(match.buyOrder.buyerAddress, match.collateralPropertyId);
  
  // Determine if contract is inverse
  match.inverse = await ContractRegistry.isInverse(match.sellOrder.contractId);
  
  return match;
}

// 2. Calculate fees for the match and update fee caches
async calculateFees(match, channel,block) {
  // (Assume you have a calculateFee function available.)
  const buyerFee = calculateFee(
    match.buyOrder.amount,
    match.sellOrder.maker,
    match.buyOrder.maker,
    match.inverse,
    true,
    match.tradePrice,
    match.notionalValue,
    channel
  );
  const sellerFee = calculateFee(
    match.sellOrder.amount,
    match.sellOrder.maker,
    match.buyOrder.maker,
    match.inverse,
    false,
    match.tradePrice,
    match.notionalValue,
    channel
  );
  await TallyMap.updateFeeCache(match.collateralPropertyId, buyerFee, match.buyOrder.contractId,block);
  await TallyMap.updateFeeCache(match.collateralPropertyId, sellerFee, match.buyOrder.contractId,block);
  
  // Return fee info object. (You can add more properties as needed.)
  return { buyerFee, sellerFee, buyFeeFromMargin: false, sellFeeFromMargin: false };
}

// 3. Handle flip logic: check if buyer/seller are “flipping” their positions and adjust margin accordingly.
async handleFlipLogic(match, feeInfo, currentBlockHeight) {
  const flipData = { flipLong: 0, flipShort: 0, buyerFullyClosed: false, sellerFullyClosed: false };
  const initialMarginPerContract = await ContractRegistry.getInitialMargin(match.buyOrder.contractId, match.tradePrice);
  
  // Buyer flip: if buyer's order amount exceeds the absolute value of a negative (short) position.
  const isBuyerFlipping = (match.buyOrder.amount > Math.abs(match.buyerPosition.contracts)) && (match.buyerPosition.contracts < 0);
  // Seller flip: if seller's order amount exceeds a positive (long) position.
  const isSellerFlipping = (match.sellOrder.amount > match.sellerPosition.contracts) && (match.sellerPosition.contracts > 0);
  
  if (isBuyerFlipping) {
    const closedContracts = Math.abs(match.buyerPosition.contracts);
    flipData.flipLong = match.buyOrder.amount - closedContracts;
    // Release margin for closed contracts.
    const marginToRelease = new BigNumber(initialMarginPerContract).times(closedContracts).decimalPlaces(8).toNumber();
    await TallyMap.updateBalance(
      match.buyOrder.buyerAddress,
      match.collateralPropertyId,
      marginToRelease,
      -marginToRelease,
      0,
      0,
      'contractMarginRelease',
      currentBlockHeight
    );
    flipData.buyerFullyClosed = true;
  }
  
  if (isSellerFlipping) {
    const closedContracts = Math.abs(match.sellerPosition.contracts);
    flipData.flipShort = match.sellOrder.amount - closedContracts;
    const marginToRelease = new BigNumber(initialMarginPerContract).times(closedContracts).decimalPlaces(8).toNumber();
    await TallyMap.updateBalance(
      match.sellOrder.sellerAddress,
      match.collateralPropertyId,
      marginToRelease,
      -marginToRelease,
      0,
      0,
      'contractMarginRelease',
      currentBlockHeight
    );
    flipData.sellerFullyClosed = true;
  }
  
  return flipData;
}

// 4. Move collateral for non-reducing orders (for buyer and seller).
async moveCollateral(match, feeInfo, channel, currentBlockHeight) {
  // Only move collateral if the order is not marked as liquidation and not reducing.
  if (!match.buyOrder.liq && !match.buyerReducing) {
    match.buyerPosition = await ContractRegistry.moveCollateralToMargin(
      match.buyOrder.buyerAddress,
      match.buyOrder.contractId,
      match.buyOrder.amount,
      match.tradePrice,
      match.buyOrder.price,
      false,
      match.buyOrder.marginUsed,
      channel,
      channel ? match.channelAddress : null,
      currentBlockHeight,
      feeInfo,
      match.buyOrder.maker
    );
  }
  if (!match.sellOrder.liq && !match.sellerReducing) {
    match.sellerPosition = await ContractRegistry.moveCollateralToMargin(
      match.sellOrder.sellerAddress,
      match.sellOrder.contractId,
      match.sellOrder.amount,
      match.tradePrice,
      match.sellOrder.price,
      true,
      match.sellOrder.marginUsed,
      channel,
      channel ? match.channelAddress : null,
      currentBlockHeight,
      feeInfo,
      match.buyOrder.maker
    );
  }
  return match;
}

// 5. Update contract balances using the match.
async updateContractBalances(match, channel, flipData) {
  const marginMap = await MarginMap.loadMarginMap(match.buyOrder.contractId);
  // Assume updateContractBalancesWithMatch is defined on marginMap.
  const positions = await marginMap.updateContractBalancesWithMatch(match, channel, 
    (match.buyerReducing || match.sellerReducing), 
    (flipData.flipLong > 0 || flipData.flipShort > 0)
  );
  return positions; // e.g., { bp: updated buyerPosition, sp: updated sellerPosition }
}

// 6. Realize PnL and settle for reducing trades.
async realizePnLAndSettle(match, currentBlockHeight, flipData) {
  const marginMap = await MarginMap.loadMarginMap(match.buyOrder.contractId);
  const lastMark = await ContractRegistry.getPriceAtBlock(match.buyOrder.contractId, currentBlockHeight) || match.tradePrice;
  // For buyer
  if ((match.buyerReducing || match.buyerFlipping) && !match.buyOrder.liq) {
    let closedContracts = match.buyOrder.amount;
    if (match.buyerFlipping) {
      closedContracts -= flipData.flipLong;
    }
    const avgEntry = match.buyerPosition.avgPrice;
    match.buyerPosition = await marginMap.realizePnl(
      match.buyOrder.buyerAddress,
      closedContracts,
      match.tradePrice,
      avgEntry,
      match.inverse,
      match.perContractNotional,
      match.buyerPosition,
      true,
      match.buyOrder.contractId
    );
    const settlementPNL = await marginMap.settlePNL(
      match.buyOrder.buyerAddress,
      closedContracts,
      match.tradePrice,
      lastMark,
      match.buyOrder.contractId,
      currentBlockHeight
    );
    await TallyMap.updateBalance(
      match.buyOrder.buyerAddress,
      match.collateralPropertyId,
      settlementPNL,
      0,
      0,
      0,
      'contractTradeSettlement',
      currentBlockHeight
    );
  }
  // For seller
  if ((match.sellerReducing || match.sellerFlipping) && !match.sellOrder.liq) {
    let closedContracts = match.sellOrder.amount;
    if (match.sellerFlipping) {
      closedContracts -= flipData.flipShort;
    }
    const avgEntry = match.sellerPosition.avgPrice;
    match.sellerPosition = await marginMap.realizePnl(
      match.sellOrder.sellerAddress,
      closedContracts,
      match.tradePrice,
      avgEntry,
      match.inverse,
      match.perContractNotional,
      match.sellerPosition,
      false,
      match.sellOrder.contractId
    );
    const settlementPNL = await marginMap.settlePNL(
      match.sellOrder.sellerAddress,
      closedContracts,
      match.tradePrice,
      lastMark,
      match.sellOrder.contractId,
      currentBlockHeight
    );
    await TallyMap.updateBalance(
      match.sellOrder.sellerAddress,
      match.collateralPropertyId,
      settlementPNL,
      0,
      0,
      0,
      'contractTradeSettlement',
      currentBlockHeight
    );
  }
  return match;
}

// 7. Build a trade object from the match data.
buildTradeObject(match, currentBlockHeight, flipData) {
  return {
    contractId: match.sellOrder.contractId,
    amount: match.sellOrder.amount,
    price: match.tradePrice,
    buyerAddress: match.buyOrder.buyerAddress,
    sellerAddress: match.sellOrder.sellerAddress,
    sellerTx: match.sellOrder.sellerTx,
    buyerTx: match.buyOrder.buyerTx,
    buyerClose: match.buyOrder.amount - (flipData.flipLong || 0),
    sellerClose: match.sellOrder.amount - (flipData.flipShort || 0),
    block: currentBlockHeight,
    buyerFullClose: (match.buyerPosition.contracts === match.buyOrder.amount),
    sellerFullClose: (match.sellerPosition.contracts === match.sellOrder.amount),
    flipLong: flipData.flipLong,
    flipShort: flipData.flipShort,
    channel: match.channel,
    liquidation: Boolean(match.sellOrder.liq || match.buyOrder.liq)
  };
}

// 8. Record the trade in trade history.
async recordTrade(trade, currentBlockHeight) {
  const tradeHistoryManager = new TradeHistory();
  await tradeHistoryManager.recordContractTrade(trade, currentBlockHeight);
}

// 9. Update volume data and liquidity rewards.
async updateVolumeAndRewards(match, currentBlockHeight) {
  // Calculate volume (UTXOEquivalentVolume) and update volume data.
  const UTXOEquivalentVolume = await VolumeIndex.getUTXOEquivalentVolume(
    match.sellOrder.contractId,
    match.sellOrder.amount,
    'contract',
    match.collateralPropertyId,
    match.perContractNotional,
    match.inverse,
    match.tradePrice
  );
  if (match.channel === false) {
    await VolumeIndex.saveVolumeDataById(
      match.sellOrder.contractId,
      match.sellOrder.amount,
      UTXOEquivalentVolume,
      match.tradePrice,
      currentBlockHeight,
      'onChainContract'
    );
  } else {
    await VolumeIndex.saveVolumeDataById(
      match.sellOrder.contractId,
      match.sellOrder.amount,
      UTXOEquivalentVolume,
      match.tradePrice,
      currentBlockHeight,
      'channelContract'
    );
  }
  // Evaluate and update liquidity rewards if applicable.
  const qualifiesBasicLiqReward = await evaluateBasicLiquidityReward(match, match.channel, true);
  const qualifiesEnhancedLiqReward = await evaluateEnhancedLiquidityReward(match, match.channel);
  if (qualifiesBasicLiqReward) {
    const notionalTokens = match.notionalValue * match.sellOrder.amount;
    const liqRewardBaseline = await VolumeIndex.baselineLiquidityReward(notionalTokens, 0.000025, match.collateralPropertyId);
    await TallyMap.updateBalance(match.sellOrder.sellerAddress, 3, liqRewardBaseline, 0, 0, 0, 'baselineLiquidityReward');
    await TallyMap.updateBalance(match.buyOrder.buyerAddress, 3, liqRewardBaseline, 0, 0, 0, 'baselineLiquidityReward');
  }
  if (qualifiesEnhancedLiqReward) {
    const notionalTokens = match.notionalValue * match.sellOrder.amount;
    const liqRewardBaseline = await VolumeIndex.calculateLiquidityReward(notionalTokens);
    await TallyMap.updateBalance(match.sellOrder.sellerAddress, 3, liqRewardBaseline, 0, 0, 0, 'enhancedLiquidityReward');
    await TallyMap.updateBalance(match.buyOrder.buyerAddress, 3, liqRewardBaseline, 0, 0, 0, 'enhancedLiquidityReward');
  }
}

        async cancelOrdersByCriteria(fromAddress, orderBookKey, criteria, token, amm) {
            
            let orderBook = await this.loadOrderBook(orderBookKey); // Assuming this is the correct reference 
            const cancelledOrders = [];
            let returnFromReserve = 0
            console.log('orderbook object in cancel ' +JSON.stringify(orderBook))
            if(!token){
                //console.log('showing orderbook before cancel '+JSON.stringify(orderBook))
            }
            if(orderBook==undefined){
               // console.log('orderbook undefined, maybe empty ')
                return []
            }

             // Check if the cancellation criteria are for AMM orders
            if (amm) {
                    for (let i = orderBook.buy.length - 1; i >= 0; i--) {
                        const order = orderBook.buy[i];
                        // Check if the order is an AMM order (marked by "amm" sender)
                        if (order.sender === "amm") {
                            cancelledOrders.push(order);
                            orderBook.buy.splice(i, 1);
                            // Virtual AMM quotes are not backed by wallet reserve buckets.
                            // Do not attempt reserve refund accounting for sender=amm.
                        }
                    }

                    // Loop through the sell side book as well
                    for (let i = orderBook.sell.length - 1; i >= 0; i--) {
                        const order = orderBook.sell[i];
                        // Check if the order is an AMM order (marked by "amm" sender)
                        if (order.sender === "amm") {
                            cancelledOrders.push(order);
                            orderBook.sell.splice(i, 1);
                            // Virtual AMM quotes are not backed by wallet reserve buckets.
                            // Do not attempt reserve refund accounting for sender=amm.
                        }
                    }
                } else {

                    if(criteria.txid!=undefined){
                        //console.log('cancelling by txid '+criteria.txid)
                       if(criteria.buy==true){
                          for (let i = orderBook.buy.length - 1; i >= 0; i--) {
                            const ord = orderBook.buy[i]
                                if(ord.txid === criteria.txid){
                                    cancelledOrders.push(ord);

                                    //console.log('splicing order '+JSON.stringify(ord))
                                    orderBook.buy.splice(i, 1);
                                }
                           }
                        } 

                        if(criteria.buy==false){
                           for (let i = orderBook.sell.length - 1; i >= 0; i--) {
                            const ordi = orderBook.sell[i]
                                if(ordi.txid === criteria.txid){
                                //console.log('splicing orders out for cancel by txid '+JSON.stringify(ordi))
                                    cancelledOrders.push(ordi);

                                    //console.log('splicing order '+JSON.stringify(ordi))
                                    orderBook.buy.splice(i, 1);
                                }
                           }

                    }else{
                            console.log('orderbook prior to cancelling '+JSON.stringify(orderBook))
                        for (let i = orderBook.buy.length - 1; i >= 0; i--) {

                            const order = orderBook.buy[i];
                            
                            if(this.shouldCancelOrder(order,criteria)){
                                 // Logic to cancel the order
                                    cancelledOrders.push(order);

                                    //console.log('splicing order '+JSON.stringify(order))
                                    orderBook.buy.splice(i, 1);

                                    if(token==true){
                                        returnFromReserve+=order.amountOffered
                                    }else{
                                        returnFromReserve+=order.initMargin
                                    }
                            }
                        }

                        //console.log('orderbook sellside '+JSON.stringify(orderBook.sell))
                        for (let i = orderBook.sell.length - 1; i >= 0; i--) {
                            const order = orderBook.sell[i];

                            if(this.shouldCancelOrder(order,criteria)){
                                    //if(criteria.address=="tltc1qa0kd2d39nmeph3hvcx8ytv65ztcywg5sazhtw8"){console.log('canceling all')}
                                 // Logic to cancel the order
                                    cancelledOrders.push(order);
                                    //console.log('splicing order '+JSON.stringify(order))
                                    orderBook.sell.splice(i, 1);

                                    if(token==true){
                                        returnFromReserve+=order.amountOffered
                                    }else{
                                        returnFromReserve+=order.initMargin
                                    }
                            }
                        }
                    }
                }
            }
              
                console.log('returning tokens from reserve '+returnFromReserve)
                cancelledOrders.returnFromReserve=returnFromReserve
                // Save the updated order book to the database

                this.orderBooks[orderBookKey] = orderBook
                console.log('orderbook after cancel operation '+orderBookKey+' '+JSON.stringify(orderBook))
                await this.saveOrderBook(orderBook, orderBookKey);

                // Log the cancellation for record-keeping
                //console.log(`Cancelled orders: ${JSON.stringify(cancelledOrders)}`);

                // Return the details of the cancelled orders
                return cancelledOrders;
        }

        shouldCancelOrder(order, criteria) {
            /*if (!order || !order.senderAddess) {
                console.error('Invalid order:', order);
                return false;
            }*/
            //console.log('should cancel order? '+JSON.stringify(order)+' '+JSON.stringify(criteria))
            //console.log('cancel all criteria '+JSON.stringify(criteria.address!=undefined)+' '+JSON.stringify(order.sender===criteria.address))
            if(criteria.price!=undefined&&(criteria.buy ? order.price <= criteria.price : order.price >= criteria.price)){
                return true
            }
            if (criteria.address!=undefined && order.sender === criteria.address) {
                return true;
            }

            return false;
        }

        async cancelAllContractOrders(fromAddress, offeredPropertyId,block) {
            const TallyMap = require('./tally.js')
            const ContractRegistry = require('./contractRegistry.js')
            // Logic to cancel all contract orders
            // Retrieve relevant order details and calculate margin reserved amounts
            const criteria = { address: fromAddress }; // Criteria to cancel all orders for a specific address
            const key = offeredPropertyId
            console.log('about to call cancelOrdersByCriteria in cancelAllContractOrders '+fromAddress, key, criteria)
            const cancelledOrders = await this.cancelOrdersByCriteria(fromAddress, key, criteria);
            const collateralPropertyId = await ContractRegistry.getCollateralId(offeredPropertyId);
            console.log('returning from reserve '+cancelledOrders.returnFromReserve)
            for (const order of cancelledOrders) {
                //console.log('applying reserve changes for cancelled order '+JSON.stringify(order))
                const reserveAmount = parseFloat(order.initMargin)
                //console.log('about to apply changes '+reserveAmount+typeof reserveAmount)
                await TallyMap.updateBalance(fromAddress, collateralPropertyId, +reserveAmount, -reserveAmount,0,0,'contractCancel',block);
            }

            // Return the details of the cancelled orders
            return cancelledOrders;
        }

        async cancelContractOrderByTxid (fromAddress, offeredPropertyId, txid,block) {
            const TallyMap = require('./tally.js')
            // Logic to cancel a specific contract order by txid
            // Retrieve order details and calculate margin reserved amount
            const criteria = { txid: txid }; // Criteria to cancel orders by txid
            const key = offeredPropertyId
            const cancelledOrder = await this.cancelOrdersByCriteria(fromAddress, key, criteria);
            //console.log('cancelling order '+JSON.stringify(cancelledOrder)+' cancelled order price '+cancelledOrder[0].price)
            const initMarginPerContract = await ContractRegistry.getInitialMargin(offeredPropertyId, cancelledOrder[0].price);
            //console.log('about to calculate reserveAmount '+cancelledOrder[0].amount + ' '+initMarginPerContract)
            const reserveAmount = cancelledOrder[0].initMargin
            const collateralPropertyId = await ContractRegistry.getCollateralId(offeredPropertyId)
            //console.log('about to move reserve back to available cancelling contract order by txid '+reserveAmount +' '+collateralPropertyId)
            await TallyMap.updateBalance(fromAddress, collateralPropertyId, reserveAmount, -reserveAmount,0,0,'contractCancel',block);

            // Return the details of the cancelled order
            return cancelledOrder;
        }

        async cancelContractBuyOrdersByPrice(fromAddress, offeredPropertyId, price, buy,block) {
            const TallyMap = require('./tally.js')
            const criteria = { price: price, buy: false }; // Criteria to cancel sell orders by price
            const key = offeredPropertyId
            const cancelledOrders = await this.cancelOrdersByCriteria(fromAddress, key, criteria);

            const collateralPropertyId = await ContractRegistry.getCollateralId(offeredPropertyId);

            for (const order of cancelledOrders) {
                const reserveAmount = order.initMargin 
                await TallyMap.updateBalance(fromAddress, collateralPropertyId, reserveAmount, -reserveAmount,0,0,'contractCancel',block);
            }

            // Return the details of the cancelled orders
            return cancelledOrders;
        }

        async cancelAllTokenOrders(fromAddress, offeredPropertyId, desiredPropertyId,block) {
            const TallyMap = require('./tally.js')
            // Logic to cancel all token orders
            // Retrieve relevant order details and calculate margin reserved amounts
            
            const key =  this.normalizeOrderBookKey(offeredPropertyId,desiredPropertyId)
            console.log('cancelAllTokenOrders key'+key)
            let buy = false
            if(offeredPropertyId>desiredPropertyId){
                buy=true
            }
            const criteria = { address: fromAddress, buy: buy }; // Criteria to cancel all orders for a specific address
            const cancelledOrders = await this.cancelOrdersByCriteria(fromAddress, key, criteria);

            for (const order of cancelledOrders) {
                const reserveAmount = order.amountOffered;
                console.log('cancelling orders in cancelAll token orders '+JSON.stringify(order)+' '+reserveAmount)
                await TallyMap.updateBalance(fromAddress, offeredPropertyId, reserveAmount, -reserveAmount,0,0,'tokenCancel',block);
            }

            // Return the details of the cancelled orders
            return cancelledOrders;
        }

        async cancelTokenOrderByTxid(fromAddress, offeredPropertyId, desiredPropertyId, txid,block) {
            const TallyMap = require('./tally.js')
            // Logic to cancel a specific token order by txid
            // Retrieve order details and calculate margin reserved amount
            const key =  this.normalizeOrderBookKey(offeredPropertyId,desiredPropertyId)
            let buy = false
            if(offeredPropertyId>desiredPropertyId){
                buy=true
            }
            const cancelledOrder = await this.cancelOrdersByCriteria(fromAddress, key, {txid:txid});
            const reserveAmount = order.amountOffered;
            await TallyMap.updateBalance(fromAddress, offeredPropertyId, reserveAmount, -reserveAmount,0,0,'tokenCancel',block);

            // Return the details of the cancelled order
            return cancelledOrder;
        }

        async cancelTokenBuyOrdersByPrice(fromAddress, offeredPropertyId, desiredPropertyId, price,block) {
            const TallyMap = require('./tally.js')
            // Logic to cancel token buy orders by price
            // Retrieve relevant buy orders and calculate margin reserved amounts
            const key =  this.normalizeOrderBookKey(offeredPropertyId,desiredPropertyId)
            let buy = false
            if(offeredPropertyId>desiredPropertyId){
                buy=true
            }
            const cancelledOrders = await this.cancelOrdersByCriteria(fromAddress, key, {price:price, buy:true});

            for (const order of cancelledOrders) {
                const reserveAmount = order.amountOffered;
                await TallyMap.updateBalance(fromAddress, offeredPropertyId, reserveAmount, -reserveAmount,0,0,'tokenCancel',block);
            }

            // Return the details of the cancelled orders
            return cancelledOrders;
        }

        async cancelTokenSellOrdersByPrice(fromAddress, offeredPropertyId, desiredPropertyId, price,block) {
            const TallyMap = require('./tally.js')
            // Logic to cancel token sell orders by price
            // Retrieve relevant sell orders and calculate margin reserved amounts
            const key =  this.normalizeOrderBookKey(offeredPropertyId,desiredPropertyId)
            const cancelledOrders = await this.cancelOrdersByCriteria(fromAddress, key, {price:price, buy:false});
            let buy = false
            if(offeredPropertyId>desiredPropertyId){
                buy=true
            }
            for (const order of cancelledOrders) {
                const reserveAmount = order.amountOffered;
                await TallyMap.updateBalance(fromAddress, offeredPropertyId, reserveAmount, -reserveAmount,0,0,'tokenCancel',block);
            }

            // Return the details of the cancelled orders
            return cancelledOrders;
        }
async cancelAllOrdersForAddress(fromAddress, key, block, collateralPropertyId) {
    const TallyMap = require('./tally.js');
    const ContractRegistry = require('./contractRegistry.js');
    
    console.log(`\n🛑 Cancelling all contract ${key} orders for ${fromAddress}`);

    let orderBook = await this.loadOrderBook(key, fromAddress);
    if (!Array.isArray(orderBook.buy)) orderBook.buy = [];
    if (!Array.isArray(orderBook.sell)) orderBook.sell = [];

    let cancelledOrders = [];
    let returnFromReserve = 0;

    // Helper for shared cancel logic
    const filterFn = (side) => (order) => {
        const isMine = order.sender === fromAddress;
        const isReduce = !order.initMargin || order.initMargin <= 0;

        if (isMine) {
            if (isReduce) {
                console.log(`⚠️ Skipping reduce-only ${side} order ${order.txid}`);
                return true; // Keep reduce orders
            }
            cancelledOrders.push(order);
            returnFromReserve += order.initMargin;
            return false; // Remove non-reduce order
        }
        return true; // Keep others
    };

    orderBook.buy = orderBook.buy.filter(filterFn('buy'));
    orderBook.sell = orderBook.sell.filter(filterFn('sell'));

    console.log(`✅ Cancelled ${cancelledOrders.length} non-reduce orders for ${fromAddress}. Returning ${returnFromReserve} to reserve.`);
    console.log(JSON.stringify(cancelledOrders, null, 2));

    this.orderBooks[key] = orderBook;
    await this.saveOrderBook(orderBook, key);

    const isVirtualAmmSender = fromAddress === 'amm' || (typeof fromAddress === 'string' && fromAddress.startsWith('amm:'));
    if (returnFromReserve > 0 && !isVirtualAmmSender) {
        await TallyMap.updateBalance(
            fromAddress,
            collateralPropertyId,
            returnFromReserve,
            -returnFromReserve,
            0,
            0,
            'contractCancel',
            block
        );
    }

    return cancelledOrders;
}

           
        async getOrdersForAddress(address, contractId, offeredPropertyId, desiredPropertyId) {
            const orderbookId = contractId ? contractId.toString() : `${offeredPropertyId}-${desiredPropertyId}`;

            try {
                // Load or create order book data
                const orderbookData = await this.loadOrderBook(orderbookId);
                const { buy, sell } = orderbookData;

                if (!buy || !sell) {
                    return []; // Return an empty array if buy or sell data is missing
                }

                // Filter buy orders for the given address
                const buyOrders = buy.filter(order => order.sender === address);

                // Filter sell orders for the given address
                const sellOrders = sell.filter(order => order.sender === address);

                // Concatenate buy and sell orders and return the result
                return buyOrders.concat(sellOrders);
            } catch (error) {
                console.error('Error getting orders for address:', error);
                return []; // Return an empty array in case of an error
            }
        }

        // Function to return the current state of the order book for the given key
        getOrderBookData() {
            return this.orderBooks[this.orderBookKey];
        }
}

module.exports = Orderbook;
