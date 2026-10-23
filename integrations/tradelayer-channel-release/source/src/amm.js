const ContractRegistry = require('./contractRegistry.js')
const Orderbook = require('./orderbook.js')
const Clearing = require('./clearing.js')
const db = require('./db.js');

class AMMPool {
    constructor(initialPosition, maxPosition, maxQuoteSize, contractType) {
        this.position = initialPosition;
        this.maxPosition = maxPosition;
        this.maxQuoteSize = maxQuoteSize;
        this.contractType = contractType;
        this.lpAddresses = {}; // Object to store LP addresses and their positions
        this.ammOrders = []; // Array to store AMM orders
    }

    async addCapital(address, id, capital, isContract, id2, amount2, block) {
        const TallyMap = require('./tally.js');
        const addAmount = Number(capital || 0);
        const addAmount2 = Number(amount2 || 0);
        if (!Number.isFinite(addAmount) || addAmount <= 0) {
            throw new Error('Invalid AMM capital amount');
        }
        if (this.position + addAmount > this.maxPosition) {
            throw new Error('Pool has reached its maximum position');
        }

        this.position += addAmount;
        this.lpAddresses[address] = Number(this.lpAddresses[address] || 0) + addAmount;

        if (isContract) {
            const lpProperty = `${id}-LP`;
            await TallyMap.updateBalance(address, id, -addAmount, 0, 0, 0, 'AMMPledge', block);
            await TallyMap.updateBalance(address, lpProperty, addAmount, 0, 0, 0, 'LPIssue', block);
            return;
        }

        if (!Number.isFinite(addAmount2) || addAmount2 <= 0) {
            throw new Error('Invalid second AMM capital amount');
        }
        const lpProperty1 = `${id}-${id2}-LP`;
        const lpProperty2 = `${id2}-${id}-LP`;
        await TallyMap.updateBalance(address, id, -addAmount, 0, 0, 0, 'AMMPledge', block);
        await TallyMap.updateBalance(address, lpProperty1, addAmount, 0, 0, 0, 'LPIssue', block);
        await TallyMap.updateBalance(address, id2, -addAmount2, 0, 0, 0, 'AMMPledge', block);
        await TallyMap.updateBalance(address, lpProperty2, addAmount2, 0, 0, 0, 'LPIssue', block);
    }

    async redeemCapital(address, id, capital, isContract, id2, amount2, block) {
        const TallyMap = require('./tally.js');
        const redeemAmount = Number(capital || 0);
        const redeemAmount2 = Number(amount2 || 0);
        const currentShare = Number(this.lpAddresses[address] || 0);
        if (!Number.isFinite(redeemAmount) || redeemAmount <= 0) {
            throw new Error('Invalid AMM redeem amount');
        }
        if (currentShare < redeemAmount) {
            throw new Error('Insufficient LP shares to redeem');
        }

        this.position -= redeemAmount;
        this.lpAddresses[address] = currentShare - redeemAmount;
        if (this.lpAddresses[address] <= 0) delete this.lpAddresses[address];

        if (isContract) {
            const lpProperty = `${id}-LP`;
            await TallyMap.updateBalance(address, lpProperty, -redeemAmount, 0, 0, 0, 'LPBurn', block);
            await TallyMap.updateBalance(address, id, redeemAmount, 0, 0, 0, 'AMMRedeem', block);
            return;
        }

        if (!Number.isFinite(redeemAmount2) || redeemAmount2 <= 0) {
            throw new Error('Invalid second AMM redeem amount');
        }
        const lpProperty1 = `${id}-${id2}-LP`;
        const lpProperty2 = `${id2}-${id}-LP`;
        await TallyMap.updateBalance(address, lpProperty1, -redeemAmount, 0, 0, 0, 'LPBurn', block);
        await TallyMap.updateBalance(address, id, redeemAmount, 0, 0, 0, 'AMMRedeem', block);
        await TallyMap.updateBalance(address, lpProperty2, -redeemAmount2, 0, 0, 0, 'LPBurn', block);
        await TallyMap.updateBalance(address, id2, redeemAmount2, 0, 0, 0, 'AMMRedeem', block);
    }

    quoteContractOrders(markPrice, block, spreadBps = 40) {
        const mid = Number(markPrice || 0);
        if (!Number.isFinite(mid) || mid <= 0) return [];

        const quoteSize = Math.max(0, Math.min(Number(this.maxQuoteSize || 0), Number(this.position || 0)));
        if (!(quoteSize > 0)) return [];

        const spread = Math.max(1, Number(spreadBps || 40)) / 10000;
        const bid = Number((mid * (1 - spread)).toFixed(8));
        const ask = Number((mid * (1 + spread)).toFixed(8));
        const cid = Number(this.contractType || 0);
        const t = Number(block || 0);

        return [
            {
                contractId: cid,
                amount: quoteSize,
                price: bid,
                blockTime: t,
                sell: false,
                initMargin: 0,
                sender: 'amm',
                txid: `amm-bid-${cid}-${t}`,
                isLiq: false,
                reduce: false,
                post: false,
                stop: false,
                initialReduce: false
            },
            {
                contractId: cid,
                amount: quoteSize,
                price: ask,
                blockTime: t,
                sell: true,
                initMargin: 0,
                sender: 'amm',
                txid: `amm-ask-${cid}-${t}`,
                isLiq: false,
                reduce: false,
                post: false,
                stop: false,
                initialReduce: false
            }
        ];
    }

    // Create a new AMM and insert into ammRegistry
    async createAMM(payload) {
        const registryDB = db.getDatabase('ammRegistry');
        const stateDB = db.getDatabase('ammState');

        // Find current max ID
        const last = await registryDB.findAsync({}).sort({ ammId: -1 }).limit(1);
        const nextId = last.length > 0 ? last[0].ammId + 1 : 1;

        const newAMM = {
            ammId: nextId,
            contractId: payload.contractId,
            propertyId: payload.propertyId,
            optionsMaker: payload.optionsMaker || null,
            optionsTaker: payload.optionsTaker || null,
            strategyBlob: payload.strategyBlob || null,
            createdAt: Date.now()
        };

        await registryDB.insertAsync(newAMM);

        // initialize state
        const state = {
            ammId: nextId,
            lpShares: {},
            position: 0,
            orders: [],
            pnl: 0,
            updatedAt: Date.now()
        };
        await stateDB.insertAsync(state);

        return newAMM;
    }

        // Save mutable state of an AMM
        async saveAMMState(ammId, stateUpdate) {
            const stateDB = db.getDatabase('ammState');
            stateUpdate.updatedAt = Date.now();
            await stateDB.updateAsync(
                { ammId },
                { $set: stateUpdate },
                { upsert: true }
            );
        }

        // Load state of an AMM
        async loadAMMState(ammId) {
            const stateDB = db.getDatabase('ammState');
            return await stateDB.findOneAsync({ ammId });
        }

        // Load immutable AMM info
        async loadAMMRegistry(ammId) {
            const registryDB = db.getDatabase('ammRegistry');
            return await registryDB.findOneAsync({ ammId });
        }

     // ---------------- Order Update ----------------
    static async updateOrdersForAllContractAMMs(block) {
        const ContractRegistry = require('./contractRegistry.js');
        const Orderbook = require('./orderbook.js');
        const Clearing = require('./clearing.js');
        const contractSeries = await ContractRegistry.loadContractSeries();
        if (!contractSeries || contractSeries.size === 0) return;

        for (const [id] of contractSeries.entries()) {
            let ammInstance = null;
            try {
                ammInstance = await ContractRegistry.getAMM(id);
            } catch (_) {
                continue;
            }
            if (!ammInstance) continue;
            if (!(Number(ammInstance.position || 0) > 0)) continue;

            const mark = await Clearing.getIndexPrice(id, block);
            if (!Number.isFinite(Number(mark)) || Number(mark) <= 0) continue;

            const orderBookKey = String(id);
            const orderbook = await Orderbook.getOrderbookInstance(orderBookKey);
            await orderbook.cancelOrdersByCriteria('amm', orderBookKey, {}, false, true);

            let orderbookData = await orderbook.loadOrderBook(orderBookKey, false);
            const quoteOrders = ammInstance.quoteContractOrders(mark, block);
            for (const ord of quoteOrders) {
                orderbookData = await orderbook.insertOrder(ord, orderbookData, Boolean(ord.sell), false);
            }
            await orderbook.saveOrderBook(orderbookData, orderBookKey);
        }
    }

       // ---------------- Core LP Capital Logic ----------------
    static async insertCapital(address, id, capital, isContract, id2, amount2, block) {
        if (this.position + capital > this.maxPosition) {
            throw new Error('Pool has reached its maximum position');
        }
        this.position += capital;
        this.lpShares[address] = (this.lpShares[address] || 0) + capital;

        let LPPropertyId, LPPropertyId2;
        if (isContract) {
            LPPropertyId = `${id}-LP`;
            await TallyMap.updateBalance(address, id, -capital, 0, 0, 0, 'AMMPledge', block);
            await TallyMap.updateBalance(address, LPPropertyId, capital, 0, 0, 0, 'LPIssue', block);
        } else {
            LPPropertyId = `${id}-${id2}-LP`;
            LPPropertyId2 = `${id2}-${id}-LP`;
            await TallyMap.updateBalance(address, id, -capital, 0, 0, 0, 'AMMPledge', block);
            await TallyMap.updateBalance(address, LPPropertyId, capital, 0, 0, 0, 'LPIssue', block);
            await TallyMap.updateBalance(address, id2, -amount2, 0, 0, 0, 'AMMPledge', block);
            await TallyMap.updateBalance(address, LPPropertyId2, amount2, 0, 0, 0, 'LPIssue', block);
        }
    }

    static async redeemCapital(address, id, capital, isContract, id2, amount2, block) {
        if (!this.lpShares[address] || this.lpShares[address] < capital) {
            throw new Error('Insufficient LP shares to redeem');
        }
        this.position -= capital;
        this.lpShares[address] -= capital;
        if (this.lpShares[address] === 0) delete this.lpShares[address];

        let LPPropertyId, LPPropertyId2;
        if (isContract) {
            LPPropertyId = `${id}-LP`;
            await TallyMap.updateBalance(address, LPPropertyId, -capital, 0, 0, 0, 'LPBurn', block);
            await TallyMap.updateBalance(address, id, capital, 0, 0, 0, 'AMMRedeem', block);
        } else {
            LPPropertyId = `${id}-${id2}-LP`;
            LPPropertyId2 = `${id2}-${id}-LP`;
            await TallyMap.updateBalance(address, LPPropertyId, -capital, 0, 0, 0, 'LPBurn', block);
            await TallyMap.updateBalance(address, id, capital, 0, 0, 0, 'AMMRedeem', block);
            await TallyMap.updateBalance(address, LPPropertyId2, -amount2, 0, 0, 0, 'LPBurn', block);
            await TallyMap.updateBalance(address, id2, amount2, 0, 0, 0, 'AMMRedeem', block);
        }
    }

    // ---------------- Maker/Taker Relationships ----------------
    static async requestLiquidity(order) {
        if (this.position + order.size > this.maxPosition) return null;
        this.position += order.size * (order.side === 'buy' ? 1 : -1);
        this.ammOrders.push(order);
        return order;
    }

    // ---------------- Option Strategy Runner ----------------
    static async runOptionStrategy(lastPrice, volIndex, block) {
        if (!this.strategyBlob) return [];
        let strategy;
        try {
            strategy = JSON.parse(this.strategyBlob);
        } catch (err) {
            console.error("Invalid strategy blob:", err);
            return [];
        }
        switch (strategy.type) {
            case 'straddle': return this.buildStraddle(lastPrice, block);
            case 'ironFly': return this.buildIronFly(lastPrice, block);
            case 'calendar': return this.buildCalendar(lastPrice, block);
            default: return [];
        }
    }

    static buildStraddle(lastPrice, block) {
        return [
            { side: 'buy', type: 'call', strike: lastPrice, expiry: block+1, size: this.maxQuoteSize },
            { side: 'buy', type: 'put',  strike: lastPrice, expiry: block+1, size: this.maxQuoteSize }
        ];
    }

    static buildIronFly(lastPrice, block) {
        let up = lastPrice * 1.02, down = lastPrice * 0.98;
        return [
            { side: 'sell', type: 'call', strike: lastPrice, expiry: block+1, size: this.maxQuoteSize },
            { side: 'sell', type: 'put',  strike: lastPrice, expiry: block+1, size: this.maxQuoteSize },
            { side: 'buy', type: 'call', strike: up, expiry: block+1, size: this.maxQuoteSize },
            { side: 'buy', type: 'put',  strike: down, expiry: block+1, size: this.maxQuoteSize }
        ];
    }

    static buildCalendar(lastPrice, block) {
        return [
            { side: 'sell', type: 'call', strike: lastPrice, expiry: block+1, size: this.maxQuoteSize },
            { side: 'buy',  type: 'call', strike: lastPrice, expiry: block+10, size: this.maxQuoteSize }
        ];
    }

    static calculateRedemptionValue(amount, isContract, poolData, lastPrice) {
        if (isContract) {
            // If the AMM is for a contract
            // Calculate the pro-rated value based on the total value of collateralId tokens in the pool
            const totalCollateralValue = poolData.collateralId * poolData.price;
            const poolValue = poolData.tokens + totalCollateralValue;
            const redemptionValue = (amount / poolData.tokens) * poolValue;
            return redemptionValue;
        } else {
            // If the AMM is for tokens
            // Calculate the redemption value based on the last price
            const redemptionValue = amount * lastPrice;
            return redemptionValue;
        }
    }


    // Function to calculate the total position of an address in the pool
    static calculateTotalPosition(address = null) {
        if (address === null) {
            // Calculate the total position of all LPs in the pool
            const totalShares = Object.values(this.lpShares).reduce((total, shares) => total + shares, 0);
            return (totalShares / this.maxPosition) * 100; // Calculate percentage
        } else {
            // Calculate the pro-rata position of the given address
            if (this.lpShares[address]) {
                return (this.lpShares[address] / this.maxPosition) * 100; // Calculate percentage
            } else {
                return 0; // If the address is not found in the LP shares, return 0
            }
        }
    }

    // Function to look up which addresses are LPs for a given contractid's AMM
    static getLPAddresses() {
        return Object.keys(this.lpAddresses);
    }

    // Function to get AMM orders and positions
    static getAMMOrdersAndPositions() {
        // You can return any relevant data here, such as orders and positions
        return {
            orders: this.ammOrders,
            position: this.position,
            maxPosition: this.maxPosition,
            lpAddresses: this.lpAddresses
        };
    }

    static calculateOrderSize(distanceFromOracle, priceDistance, totalOrders) {
        // Calculate order size based on the given distance from the oracle
        const totalDistance = 0.2 * priceDistance; // Total distance from bottom tick to top of the book
        const distanceRatio = distanceFromOracle / totalDistance;
        let orderSize;

        if (distanceRatio <= 0.05) {
            // Bottom quarter of the book
            orderSize = totalOrders * 0.35;
        } else if (distanceRatio <= 0.1) {
            // Second to bottom quarter of the book
            orderSize = totalOrders * 0.25;
        } else if (distanceRatio <= 0.15) {
            // Third to bottom quarter of the book
            orderSize = totalOrders * 0.15;
        } else {
            // Top quarter of the book
            orderSize = totalOrders * 0.05;
        }

        return orderSize;
    }

    static generateOrdersForInverse(oraclePrice, priceDistance, totalOrders) {
        // Calculate distance from oracle to bottom tick
        const distanceFromOracle = 0.001; // Assuming bottom tick is 0.01 away from oracle

        // Calculate order size based on distance from oracle
        const orderSize = this.calculateOrderSize(distanceFromOracle, priceDistance, totalOrders);

        // Adjust quote size based on position and max quote size
        let quoteSize = Math.min(this.position, this.maxQuoteSize);

        // Adjust order size based on available quote size
        const maxOrderSize = Math.min(orderSize, quoteSize);

        // Update position and quote size
        this.position += maxOrderSize;
        quoteSize -= maxOrderSize;

        // Generate order object
        const order = {
            price: oraclePrice + distanceFromOracle, // Assume bottom tick is above oracle price
            size: maxOrderSize,
            side: 'sell' // Assuming it's a sell order for inverse quoted contracts
        };

        return order;
    }

    static generateOrdersForLinear(oraclePrice, priceDistance, totalOrders) {
        // Calculate distance from oracle to bottom tick
        const distanceFromOracle = 0.01; // Assuming bottom tick is 0.01 away from oracle

        // Calculate order size based on distance from oracle
        const orderSize = this.calculateOrderSize(distanceFromOracle, priceDistance, totalOrders);

        // Adjust quote size based on position and max quote size
        let quoteSize = Math.min(this.position, this.maxQuoteSize);

        // Adjust order size based on available quote size
        const maxOrderSize = Math.min(orderSize, quoteSize);

        // Update position and quote size
        this.position += maxOrderSize;
        quoteSize -= maxOrderSize;

        // Generate order object
        const order = {
            price: oraclePrice + distanceFromOracle, // Assume bottom tick is above oracle price
            size: maxOrderSize,
            side: this.position > 0 ? 'buy' : 'sell' // Buy if long, sell if short for linear contracts
        };

        return order;
    }

    static async generateTokenOrders(tokenXId, tokenYId, totalLiquidity, totalOrders, lastPrice, blockHeight) {
        const pairKey = `${tokenXId}-${tokenYId}`;
        const orderbook = await Orderbook.getOrderbookInstance(pairKey);

        const curveDistance = 0.30 * lastPrice; // Distance from the last price
        const orderIncrement = curveDistance / totalOrders; // Increment for each order

        // Calculate the initial supply ratio
        const initialXSupply = Math.sqrt(totalLiquidity * (1 - curveDistance / (2 * lastPrice)));
        const initialYSupply = Math.sqrt(totalLiquidity * (1 + curveDistance / (2 * lastPrice)));

        // Generate orders for token X and token Y
        for (let i = 1; i <= totalOrders; i++) {
            const priceX = lastPrice - (i * orderIncrement);
            const priceY = lastPrice + (i * orderIncrement);

            // Calculate the supply at this price level
            const xSupply = initialXSupply * (lastPrice / priceX);
            const ySupply = totalLiquidity / xSupply;

            const orderX = {
                offeredPropertyId: tokenXId,
                desiredPropertyId: tokenYId,
                amountOffered: xSupply - initialXSupply,
                amountExpected: ySupply - initialYSupply,
                price: priceX,
                sender: "pool",
                txid: "amm"
            };

            const orderY = {
                offeredPropertyId: tokenYId,
                desiredPropertyId: tokenXId,
                amountOffered: ySupply - initialYSupply,
                amountExpected: xSupply - initialXSupply,
                price: priceY,
                sender: "pool",
                txid: "amm"
            };

            try {
                await Promise.all([
                    orderbook.addTokenOrder(orderX, blockHeight, txid),
                    orderbook.addTokenOrder(orderY, blockHeight, txid)
                ]);
            } catch (error) {
                console.error(`Error placing orders for pair ${pairKey}: ${error.message}`);
                // Handle the error as needed
            }
        }

        console.log(`Token orders placed for pair ${pairKey}`);
    }

    static generateOrders(lastPrice, priceDistance, totalOrders, id1, id2, inverse, token) {
        
        if(token==true){
            let totalLiquidity = this.calculateTotalLiquidityForToken(id1,id2,totalLiquidity,lastPrice,block);
            return this.generateTokenOrders()
        }

        if (this.contractType === 'inverse') {
            return this.generateOrdersForInverse(lastPrice, priceDistance, totalOrders);
        } else if (this.contractType === 'linear') {
            return this.generateOrdersForLinear(lastPrice, priceDistance, totalOrders);
        } else {
            throw new Error('Invalid contract type');
        }
    }

}

module.exports = AMMPool
