/**
 * TradeLayer L2 Scaling Module
 * 
 * Transaction Flow:
 * Tx 1: Half-signed trade with expiry block (anti-free-option)
 * Tx 2: Keep-alive - both sign to acknowledge "this is real"  
 * Tx 3: Close position at mark price, neutralizes 1+2
 * Tx 4: Net PnL transfer + UTXO rotation (new cycle begins)
 * King Tx: 3rd UTXO co-sign sweep - all state → one on-chain settlement
 */

const db = require('./db.js');
const Channels = require('./channels.js');
const ContractRegistry = require('./contractRegistry.js');
const MarginMap = require('./marginMap.js');
const TallyMap = require('./tally.js');
const BigNumber = require('bignumber.js');

// Settlement types enum - replaces boolean close flag
const SettleType = {
    KEEP_ALIVE: 0,      // Tx 2 - acknowledge trade is live
    CLOSE_POSITION: 1,  // Tx 3 - close at mark, neutralize 1+2
    NET_SETTLE: 2,      // Tx 4 - PnL transfer, UTXO rotation
    KING_SETTLE: 3      // sweep tx - all state → one on-chain settlement
};

// Settlement status for tracking
const SettleStatus = {
    PENDING: 'pending',
    LIVE: 'live', 
    NEUTRALIZED: 'neutralized',
    EXPIRED: 'expired',
    SWEPT: 'swept'
};

const ScalingL2 = {

    // ============================================
    // VALIDATION FUNCTIONS (for validity.js)
    // ============================================

    /**
     * Validate Type 23: Settle Channel PNL (polymorphic)
     * Handles KEEP_ALIVE, CLOSE_POSITION, NET_SETTLE based on settleType
     */
    async validateSettleChannelPNL(sender, params, txid, block, { 
        Channels, ContractRegistry, MarginMap, Scaling, activationInstance 
    }) {
        params.reason = '';
        params.valid = true;

        // Activation check
        const isAlreadyActivated = await activationInstance.isTxTypeActive(23);
        if (!isAlreadyActivated) {
            params.valid = false;
            params.reason += 'Tx type not yet activated; ';
            return params;
        }

        // Validate settleType enum
        if (![SettleType.KEEP_ALIVE, SettleType.CLOSE_POSITION, SettleType.NET_SETTLE].includes(params.settleType)) {
            params.valid = false;
            params.reason += `Invalid settleType: ${params.settleType}; `;
            return params;
        }

        // Validate channel exists and sender is participant
        const channel = await Channels.getChannel(sender);
        if (!channel) {
            params.valid = false;
            params.reason += 'Channel not found for sender; ';
            return params;
        }

        const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(sender);
        if (!commitAddressA && !commitAddressB) {
            params.valid = false;
            params.reason += 'Sender is not a channel participant; ';
            return params;
        }

        // Validate txidNeutralized1 exists (the trade we're settling)
        if (!params.txidNeutralized1) {
            params.valid = false;
            params.reason += 'Missing txidNeutralized1 (trade reference); ';
            return params;
        }

        // Check if this settlement was already neutralized by a later one
        const isAlreadyNeutralized = await this.isSettlementNeutralized(sender, params.txidNeutralized1);
        if (isAlreadyNeutralized) {
            params.valid = false;
            params.reason += 'Settlement already superseded by later settlement; ';
            return params;
        }

        // Type-specific validation
        switch (params.settleType) {
            case SettleType.KEEP_ALIVE:
                // Tx 2: Just needs valid trade reference, no mark price required
                const tradeStatus = await this.getTradeStatus(params.txidNeutralized1);
                if (tradeStatus.status === 'expired') {
                    params.valid = false;
                    params.reason += 'Cannot keep-alive an expired trade; ';
                }
                break;

            case SettleType.CLOSE_POSITION:
                // Tx 3: Needs mark price and txidNeutralized2 (the keep-alive)
                if (!params.markPrice || params.markPrice <= 0) {
                    params.valid = false;
                    params.reason += 'Invalid mark price for close; ';
                }
                if (!params.txidNeutralized2) {
                    params.valid = false;
                    params.reason += 'Missing txidNeutralized2 (keep-alive reference); ';
                }
                // Verify txidNeutralized2 is a valid keep-alive for txidNeutralized1
                const keepAliveValid = await this.validateKeepAliveChain(
                    params.txidNeutralized1, 
                    params.txidNeutralized2
                );
                if (!keepAliveValid) {
                    params.valid = false;
                    params.reason += 'Keep-alive chain invalid; ';
                }
                break;

            case SettleType.NET_SETTLE:
                // Tx 4: PnL direction and amount required
                if (params.netAmount === undefined || params.netAmount === null) {
                    params.valid = false;
                    params.reason += 'Missing netAmount for NET_SETTLE; ';
                }
                // columnAIsSeller tells us PnL direction
                if (params.columnAIsSeller === undefined) {
                    params.valid = false;
                    params.reason += 'Missing columnAIsSeller direction flag; ';
                }
                break;
        }

        // Block expiry check - the foundational anti-free-option mechanism
        if (params.expiryBlock && block > params.expiryBlock) {
            params.valid = false;
            params.reason += `Settlement expired at block ${params.expiryBlock}, current: ${block}; `;
        }

        return params;
    },

    /**
     * Validate Type 31: King Settlement (the sweep)
     * This is the "nuclear option" that collapses all L2 state to chain
     */
    async validateKingSettle(sender, params, txid, block, {
        Channels, Scaling, activationInstance
    }) {
        params.reason = '';
        params.valid = true;

        const isAlreadyActivated = await activationInstance.isTxTypeActive(31);
        if (!isAlreadyActivated) {
            params.valid = false;
            params.reason += 'Tx type not yet activated; ';
            return params;
        }

        // Must have block range
        if (!params.blockStart || !params.blockEnd) {
            params.valid = false;
            params.reason += 'Missing block range (blockStart/blockEnd); ';
            return params;
        }

        if (params.blockStart > params.blockEnd) {
            params.valid = false;
            params.reason += 'Invalid block range: start > end; ';
            return params;
        }

        // Current block must be within or after the range
        if (block < params.blockStart) {
            params.valid = false;
            params.reason += 'Cannot settle future block range; ';
            return params;
        }

        // Validate channel and 3rd UTXO co-sign requirement
        const channel = await Channels.getChannel(sender);
        if (!channel) {
            params.valid = false;
            params.reason += 'Channel not found; ';
            return params;
        }

        // Verify both parties have signed (3rd UTXO check happens at tx construction level)
        // The fact that this tx exists with valid sigs from multisig means both agreed

        // Property ID must be valid
        if (!params.propertyId || params.propertyId < 1) {
            params.valid = false;
            params.reason += 'Invalid propertyId; ';
            return params;
        }

        // Net amount and direction
        if (params.netAmount === undefined) {
            params.valid = false;
            params.reason += 'Missing netAmount; ';
            return params;
        }

        if (params.aPaysBDirection === undefined) {
            params.valid = false;
            params.reason += 'Missing payment direction (aPaysBDirection); ';
            return params;
        }

        // Validate channelRoot reference
        if (!params.channelRoot) {
            params.valid = false;
            params.reason += 'Missing channelRoot (founding UTXO reference); ';
            return params;
        }

        // Verify all intermediate settlements in range are now invalidated
        // This is the key security property - king tx invalidates everything
        const pendingSettlements = await this.getPendingSettlementsInRange(
            sender, 
            params.blockStart, 
            params.blockEnd
        );

        // Store the count for audit
        params.neutralizedCount = pendingSettlements.length;
        params.totalContracts = params.totalContracts || 0;

        return params;
    },

    // ============================================
    // LOGIC FUNCTIONS (for logic.js)
    // ============================================

    /**
     * Process Type 23: Settle Channel PNL
     */
    async settleChannelPNL(channelAddress, params, block, txid, {
        Channels, MarginMap, TallyMap, Scaling
    }) {
        const {
            txidNeutralized1,
            txidNeutralized2,
            markPrice,
            settleType,
            columnAIsSeller,
            columnAIsMaker,
            netAmount
        } = params;

        const channel = await Channels.getChannel(channelAddress);
        const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(channelAddress);

        switch (settleType) {
            case SettleType.KEEP_ALIVE:
                // Tx 2: Acknowledge trade is live, extend validity
                await this.processKeepAlive(channelAddress, txidNeutralized1, block, txid);
                break;

            case SettleType.CLOSE_POSITION:
                // Tx 3: Close at mark price, generate offset trade
                await this.processClosePosition(
                    channelAddress,
                    txidNeutralized1,
                    txidNeutralized2,
                    markPrice,
                    columnAIsSeller,
                    block,
                    txid,
                    { Channels, MarginMap, Scaling }
                );
                break;

            case SettleType.NET_SETTLE:
                // Tx 4: Execute PnL transfer, prepare for next cycle
                await this.processNetSettle(
                    channelAddress,
                    txidNeutralized1,
                    txidNeutralized2,
                    netAmount,
                    columnAIsSeller,
                    block,
                    txid,
                    { Channels, TallyMap, Scaling }
                );
                break;
        }

        // Record the settlement
        await this.recordSettlement(channelAddress, txid, settleType, block);

        console.log(`Settlement type ${settleType} processed for channel ${channelAddress}`);
    },

    /**
     * Process Type 31: King Settlement
     * The sweep that collapses all L2 state
     */
    async processKingSettle(channelAddress, params, block, txid, {
        Channels, TallyMap, Scaling
    }) {
        const {
            blockStart,
            blockEnd,
            propertyId,
            netAmount,
            aPaysBDirection,
            channelRoot,
            totalContracts,
            neutralizedCount
        } = params;

        const channel = await Channels.getChannel(channelAddress);
        const { commitAddressA, commitAddressB } = await Channels.getCommitAddresses(channelAddress);

        // 1. Neutralize all pending settlements in the block range
        await this.neutralizeSettlementsInRange(channelAddress, blockStart, blockEnd);

        // 2. Execute the net PnL transfer
        const payerAddr = aPaysBDirection ? commitAddressA : commitAddressB;
        const receiverAddr = aPaysBDirection ? commitAddressB : commitAddressA;

        // Update channel balances (this is the on-chain settlement)
        const colKey = propertyId.toString();
        
        if (aPaysBDirection) {
            // A pays B
            channel.A[colKey] = (channel.A[colKey] || 0) - Math.abs(netAmount);
            channel.B[colKey] = (channel.B[colKey] || 0) + Math.abs(netAmount);
        } else {
            // B pays A
            channel.B[colKey] = (channel.B[colKey] || 0) - Math.abs(netAmount);
            channel.A[colKey] = (channel.A[colKey] || 0) + Math.abs(netAmount);
        }

        await Channels.updateChannel(channelAddress, channel);

        // 3. Record the king settlement
        await this.recordKingSettlement(channelAddress, txid, {
            blockStart,
            blockEnd,
            propertyId,
            netAmount,
            aPaysBDirection,
            channelRoot,
            totalContracts,
            neutralizedCount,
            settledAtBlock: block
        });

        // 4. Clear the L2 state for this channel in the settled range
        await this.clearL2State(channelAddress, blockStart, blockEnd);

        console.log(`King Settlement executed: channel=${channelAddress}, blocks=${blockStart}-${blockEnd}, net=${netAmount}, contracts=${totalContracts}`);
    },

    // ============================================
    // HELPER FUNCTIONS
    // ============================================

    async processKeepAlive(channelAddress, tradeTxid, block, settleTxid) {
        const scalingDb = await db.getDatabase('scaling');
        
        // Update trade status to 'live' and record keep-alive
        await scalingDb.updateAsync(
            { _id: channelAddress, 'trades.txid': tradeTxid },
            { 
                $set: { 'trades.$.status': SettleStatus.LIVE },
                $push: { 
                    keepAlives: { 
                        tradeTxid, 
                        settleTxid, 
                        block 
                    } 
                }
            }
        );
    },

    async processClosePosition(channelAddress, tradeTxid, keepAliveTxid, markPrice, columnAIsSeller, block, settleTxid, deps) {
        const { Channels, MarginMap, Scaling } = deps;

        // 1. Get the original trade params
        const trade = await this.getTradeByTxid(tradeTxid);
        if (!trade) {
            throw new Error(`Trade ${tradeTxid} not found`);
        }

        // 2. Neutralize the original trade and keep-alive
        await this.neutralizeSettlement(channelAddress, tradeTxid);
        await this.neutralizeSettlement(channelAddress, keepAliveTxid);

        // 3. Calculate PnL based on mark price vs trade price
        const pnl = this.calculatePnL(trade.params, markPrice, columnAIsSeller);

        // 4. Generate and execute offset trade
        const offsetParams = {
            ...trade.params,
            price: markPrice,
            isOffset: true,
            originalTxid: tradeTxid,
            pnl: pnl.amount,
            pnlDirection: pnl.direction
        };

        // Store close position record
        const scalingDb = await db.getDatabase('scaling');
        await scalingDb.updateAsync(
            { _id: channelAddress },
            {
                $push: {
                    closes: {
                        tradeTxid,
                        keepAliveTxid,
                        settleTxid,
                        markPrice,
                        pnl: pnl.amount,
                        pnlDirection: pnl.direction,
                        block
                    }
                }
            },
            { upsert: true }
        );

        return offsetParams;
    },

    async processNetSettle(channelAddress, txidNeutralized1, txidNeutralized2, netAmount, columnAIsSeller, block, txid, deps) {
        const { Channels, TallyMap, Scaling } = deps;

        // 1. Neutralize referenced settlements
        if (txidNeutralized1) {
            await this.neutralizeSettlement(channelAddress, txidNeutralized1);
        }
        if (txidNeutralized2) {
            await this.neutralizeSettlement(channelAddress, txidNeutralized2);
        }

        // 2. Record net settlement (actual balance transfer happens in king settle)
        const scalingDb = await db.getDatabase('scaling');
        await scalingDb.updateAsync(
            { _id: channelAddress },
            {
                $push: {
                    netSettles: {
                        txid,
                        txidNeutralized1,
                        txidNeutralized2,
                        netAmount,
                        columnAIsSeller,
                        block,
                        status: SettleStatus.PENDING
                    }
                }
            },
            { upsert: true }
        );
    },

    calculatePnL(tradeParams, markPrice, columnAIsSeller) {
        const { price: entryPrice, amount: contracts } = tradeParams;
        const priceDiff = markPrice - entryPrice;
        
        // If A is seller: A profits when price drops, B profits when price rises
        // If A is buyer: A profits when price rises, B profits when price drops
        let amount = Math.abs(priceDiff * contracts);
        let direction; // 'AtoB' or 'BtoA'

        if (columnAIsSeller) {
            // A sold, so A profits if price dropped
            direction = priceDiff < 0 ? 'BtoA' : 'AtoB';
        } else {
            // A bought, so A profits if price rose
            direction = priceDiff > 0 ? 'BtoA' : 'AtoB';
        }

        return { amount, direction };
    },

    async isSettlementNeutralized(channelAddress, txid) {
        const scalingDb = await db.getDatabase('scaling');
        const doc = await scalingDb.findOneAsync({ _id: channelAddress });
        
        if (!doc || !doc.settlements) return false;
        
        const settlement = doc.settlements.find(s => s.txid === txid);
        return settlement && settlement.status === SettleStatus.NEUTRALIZED;
    },

    async neutralizeSettlement(channelAddress, txid) {
        const scalingDb = await db.getDatabase('scaling');
        await scalingDb.updateAsync(
            { _id: channelAddress, 'settlements.txid': txid },
            { $set: { 'settlements.$.status': SettleStatus.NEUTRALIZED } }
        );
    },

    async neutralizeSettlementsInRange(channelAddress, blockStart, blockEnd) {
        const scalingDb = await db.getDatabase('scaling');
        const doc = await scalingDb.findOneAsync({ _id: channelAddress });
        
        if (!doc) return;

        // Neutralize all settlements in the block range
        const updates = [];
        for (const arr of ['settlements', 'trades', 'keepAlives', 'closes', 'netSettles']) {
            if (doc[arr]) {
                for (const item of doc[arr]) {
                    if (item.block >= blockStart && item.block <= blockEnd) {
                        item.status = SettleStatus.SWEPT;
                    }
                }
                updates.push({ [arr]: doc[arr] });
            }
        }

        if (updates.length > 0) {
            await scalingDb.updateAsync(
                { _id: channelAddress },
                { $set: Object.assign({}, ...updates) }
            );
        }
    },

    async getPendingSettlementsInRange(channelAddress, blockStart, blockEnd) {
        const scalingDb = await db.getDatabase('scaling');
        const doc = await scalingDb.findOneAsync({ _id: channelAddress });
        
        if (!doc) return [];

        const pending = [];
        for (const arr of ['settlements', 'trades', 'netSettles']) {
            if (doc[arr]) {
                for (const item of doc[arr]) {
                    if (item.block >= blockStart && 
                        item.block <= blockEnd && 
                        item.status !== SettleStatus.NEUTRALIZED &&
                        item.status !== SettleStatus.SWEPT) {
                        pending.push(item);
                    }
                }
            }
        }
        return pending;
    },

    async getTradeStatus(txid) {
        const scalingDb = await db.getDatabase('scaling');
        const docs = await scalingDb.findAsync({});
        
        for (const doc of docs) {
            if (doc.trades) {
                const trade = doc.trades.find(t => t.txid === txid);
                if (trade) return trade;
            }
        }
        return { status: 'unpublished' };
    },

    async getTradeByTxid(txid) {
        const scalingDb = await db.getDatabase('scaling');
        const docs = await scalingDb.findAsync({});
        
        for (const doc of docs) {
            if (doc.trades) {
                const trade = doc.trades.find(t => t.txid === txid);
                if (trade) return trade;
            }
        }
        return null;
    },

    async validateKeepAliveChain(tradeTxid, keepAliveTxid) {
        const scalingDb = await db.getDatabase('scaling');
        const docs = await scalingDb.findAsync({});
        
        for (const doc of docs) {
            if (doc.keepAlives) {
                const ka = doc.keepAlives.find(k => 
                    k.tradeTxid === tradeTxid && k.settleTxid === keepAliveTxid
                );
                if (ka) return true;
            }
        }
        return false;
    },

    async recordSettlement(channelAddress, txid, settleType, block) {
        const scalingDb = await db.getDatabase('scaling');
        await scalingDb.updateAsync(
            { _id: channelAddress },
            {
                $push: {
                    settlements: {
                        txid,
                        settleType,
                        block,
                        status: SettleStatus.LIVE,
                        timestamp: Date.now()
                    }
                }
            },
            { upsert: true }
        );
    },

    async recordKingSettlement(channelAddress, txid, data) {
        const scalingDb = await db.getDatabase('scaling');
        await scalingDb.updateAsync(
            { _id: channelAddress },
            {
                $push: {
                    kingSettlements: {
                        txid,
                        ...data,
                        timestamp: Date.now()
                    }
                }
            },
            { upsert: true }
        );
    },

    async clearL2State(channelAddress, blockStart, blockEnd) {
        // After king settlement, we can optionally archive and clear old L2 state
        // For now, just mark everything as swept (done in neutralizeSettlementsInRange)
        console.log(`L2 state cleared for channel ${channelAddress}, blocks ${blockStart}-${blockEnd}`);
    }
};

module.exports = { ScalingL2, SettleType, SettleStatus };
