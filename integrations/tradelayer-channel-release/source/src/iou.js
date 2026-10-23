// pnlIou.js
//
// STATIC IOU BUCKET
// Records PnL mismatch or loss shortfalls per (contractId, propertyId).
// No instance state. No RAM caching.
// Compatible with NeDB or Mongo via your db.js wrapper.
//
// KEY CHANGE: Track blockLosses and blockProfits separately.
// - blockLosses: real tokens debited from losers (available to pay IOU holders)
// - blockProfits: unfunded gains that become IOU claims
// - blockDelta: kept for backward compat (= blockLosses - blockProfits from bucket perspective)

const BigNumber = require('bignumber.js');
const dbInstance = require('./db.js');

class PnlIou {
    // -----------------------
    // Helpers
    // -----------------------
    static key(contractId, propertyId) {
        return `${contractId}:${propertyId}`;
    }

    static async _db() {
        return await dbInstance.getDatabase('iou');
    }

    // -----------------------
    // Audit helper (same DB)
    // -----------------------
    static async audit(event) {
        const db = await PnlIou._db();

        const doc = {
            _id: `audit:${event.block}:${event.contractId}:${event.propertyId}:${Date.now()}:${Math.random()}`,
            type: 'audit',
            ts: Date.now(),
            ...event
        };

        try {
            await db.insertAsync(doc);
        } catch (e) {
            // audit must never break consensus
            console.warn('IOU audit insert failed:', e.message);
        }
    }

    static claimKey(contractId, propertyId) {
        return `claims:${Number(contractId)}:${Number(propertyId)}`;
    }

    static async getClaimMap(contractId, propertyId) {
        const db = await dbInstance.getDatabase('iou');
        return await db.findOneAsync({
            _id: PnlIou.claimKey(contractId, propertyId)
        });
    }

    static async saveClaimMap(doc) {
        const db = await dbInstance.getDatabase('iou');
        await db.updateAsync(
            { _id: doc._id },
            doc,
            { upsert: true }
        );
    }

    static async getBucket(contractId, propertyId) {
        const key = PnlIou.key(contractId, propertyId);
        const db = await PnlIou._db();

        let doc = null;
        try {
            doc = await db.findOneAsync({ _id: key });
        } catch (e) {
            return null;
        }

        if (!doc) return null;

        return {
            ...doc,
            amount: new BigNumber(doc.amount || 0),
            blockStartAmount: new BigNumber(doc.blockStartAmount || 0),
            blockDelta: new BigNumber(doc.blockDelta || 0),
            blockLosses: new BigNumber(doc.blockLosses || 0),
            blockProfits: new BigNumber(doc.blockProfits || 0)
        };
    }

    static async addIouClaims(
        contractId,
        propertyId,
        block,
        buyerAddr,
        sellerAddr,
        buyerPnl,
        sellerPnl,
        delta
    ) {
        const d = new BigNumber(delta || 0);
        if (d.lte(0)) return null;

        const bP = new BigNumber(buyerPnl || 0);
        const sP = new BigNumber(sellerPnl || 0);

        const posBuyer  = BigNumber.max(bP, 0);
        const posSeller = BigNumber.max(sP, 0);
        const sumPos = posBuyer.plus(posSeller);
        if (sumPos.lte(0)) return null;

        const buyerShare  = posBuyer.gt(0)  ? d.times(posBuyer.div(sumPos))  : new BigNumber(0);
        const sellerShare = posSeller.gt(0) ? d.times(posSeller.div(sumPos)) : new BigNumber(0);

        let doc = await PnlIou.getClaimMap(contractId, propertyId);

        if (!doc) {
            doc = {
                _id: PnlIou.claimKey(contractId, propertyId),
                contractId: Number(contractId),
                propertyId: Number(propertyId),
                claims: {},
                lastBlock: block
            };
        }

        if (buyerShare.gt(0)) {
            doc.claims[buyerAddr] = new BigNumber(doc.claims[buyerAddr] || 0)
                .plus(buyerShare)
                .toString(10);
        }

        if (sellerShare.gt(0)) {
            doc.claims[sellerAddr] = new BigNumber(doc.claims[sellerAddr] || 0)
                .plus(sellerShare)
                .toString(10);
        }

        doc.lastBlock = block;
        await PnlIou.saveClaimMap(doc);

        // optional but recommended for traceability
        await PnlIou.audit({
            event: 'claim_accrual',
            block,
            contractId: Number(contractId),
            propertyId: Number(propertyId),
            delta: d.toString(10),
            buyerAddr,
            sellerAddr,
            buyerShare: buyerShare.toString(10),
            sellerShare: sellerShare.toString(10)
        });

        return doc;
    }

    // -----------------------
    // Add a LOSS to the bucket (positive amount = real tokens debited from loser)
    // These tokens are available to pay out to IOU claimants
    // -----------------------
    static async addLoss(contractId, propertyId, lossAmount, block) {
        const loss = new BigNumber(lossAmount || 0);
        if (loss.lte(0)) return null;

        const key = PnlIou.key(contractId, propertyId);
        const db = await dbInstance.getDatabase('iou');
        
        let existing = null;
        try { existing = await db.findOneAsync({ _id: key }); } catch (e) {}

        const current = new BigNumber((existing && existing.amount) || 0);
        const isNewBlock = !(existing && Number(existing.lastBlock) === Number(block));

        const blockStart = isNewBlock
            ? current
            : new BigNumber((existing && existing.blockStartAmount) || current);

        const prevBlockDelta = isNewBlock
            ? new BigNumber(0)
            : new BigNumber((existing && existing.blockDelta) || 0);

        const prevBlockLosses = isNewBlock
            ? new BigNumber(0)
            : new BigNumber((existing && existing.blockLosses) || 0);

        const prevBlockProfits = isNewBlock
            ? new BigNumber(0)
            : new BigNumber((existing && existing.blockProfits) || 0);

        // Loss adds to bucket (positive delta from bucket's perspective - tokens flowed in)
        const nextBlockDelta = prevBlockDelta.plus(loss);
        const nextBlockLosses = prevBlockLosses.plus(loss);
        const updated = current.plus(loss);

        const doc = {
            _id: key,
            contractId: Number(contractId),
            propertyId: Number(propertyId),
            amount: updated.toString(10),
            lastBlock: block,
            blockStartAmount: blockStart.toString(10),
            blockDelta: nextBlockDelta.toString(10),
            blockLosses: nextBlockLosses.toString(10),
            blockProfits: prevBlockProfits.toString(10)
        };

        await db.updateAsync({ _id: key }, doc, { upsert: true });

        await PnlIou.audit({
            event: 'bucket_loss',
            block,
            contractId: Number(contractId),
            propertyId: Number(propertyId),
            loss: loss.toString(10),
            amountBefore: current.toString(10),
            amountAfter: updated.toString(10),
            blockLosses: nextBlockLosses.toString(10),
            blockProfits: prevBlockProfits.toString(10)
        });

        return doc;
    }

    // -----------------------
    // Add a PROFIT to the bucket (positive amount = unfunded gains, creates IOU obligation)
    // These are tracked separately and do NOT reduce the payout pool
    // -----------------------
    static async addProfit(contractId, propertyId, profitAmount, block) {
        const profit = new BigNumber(profitAmount || 0);
        if (profit.lte(0)) return null;

        const key = PnlIou.key(contractId, propertyId);
        const db = await dbInstance.getDatabase('iou');
        
        let existing = null;
        try { existing = await db.findOneAsync({ _id: key }); } catch (e) {}

        const current = new BigNumber((existing && existing.amount) || 0);
        const isNewBlock = !(existing && Number(existing.lastBlock) === Number(block));

        const blockStart = isNewBlock
            ? current
            : new BigNumber((existing && existing.blockStartAmount) || current);

        const prevBlockDelta = isNewBlock
            ? new BigNumber(0)
            : new BigNumber((existing && existing.blockDelta) || 0);

        const prevBlockLosses = isNewBlock
            ? new BigNumber(0)
            : new BigNumber((existing && existing.blockLosses) || 0);

        const prevBlockProfits = isNewBlock
            ? new BigNumber(0)
            : new BigNumber((existing && existing.blockProfits) || 0);

        // Profit subtracts from bucket (negative delta - system owes more)
        const nextBlockDelta = prevBlockDelta.minus(profit);
        const nextBlockProfits = prevBlockProfits.plus(profit);
        const updated = current.minus(profit);

        const doc = {
            _id: key,
            contractId: Number(contractId),
            propertyId: Number(propertyId),
            amount: updated.toString(10),
            lastBlock: block,
            blockStartAmount: blockStart.toString(10),
            blockDelta: nextBlockDelta.toString(10),
            blockLosses: prevBlockLosses.toString(10),
            blockProfits: nextBlockProfits.toString(10)
        };

        await db.updateAsync({ _id: key }, doc, { upsert: true });

        await PnlIou.audit({
            event: 'bucket_profit',
            block,
            contractId: Number(contractId),
            propertyId: Number(propertyId),
            profit: profit.toString(10),
            amountBefore: current.toString(10),
            amountAfter: updated.toString(10),
            blockLosses: prevBlockLosses.toString(10),
            blockProfits: nextBlockProfits.toString(10)
        });

        return doc;
    }

    // -----------------------
    // DEPRECATED: Use addLoss/addProfit instead
    // Kept for backward compatibility
    // -----------------------
    static async addDelta(contractId, propertyId, delta, block) {
        const d = new BigNumber(delta || 0);
        if (d.isZero()) return null;

        // Positive delta = loss (tokens flowed into bucket)
        // Negative delta = profit (system owes more)
        if (d.gt(0)) {
            return await PnlIou.addLoss(contractId, propertyId, d, block);
        } else {
            return await PnlIou.addProfit(contractId, propertyId, d.abs(), block);
        }
    }

    static blockReductionTowardZero(doc) {
        const start = new BigNumber((doc && doc.blockStartAmount) || 0);
        const end   = new BigNumber((doc && doc.amount) || 0);

        const reduction = start.abs().minus(end.abs());
        return reduction.gt(0) ? reduction : new BigNumber(0);
    }

    static async applyToLosers(contractId, markDelta, blockHeight, propertyId) {
        let deficit = await this.get(contractId, propertyId);

        if (deficit.gte(0)) return;
        if (markDelta.lte(0)) return;

        const payout = BigNumber.min(markDelta, deficit.abs());
        await this.addDelta(contractId, propertyId, payout.negated(), blockHeight);
    }
    
    // -----------------------
    // Pay outstanding IOUs using blockLosses (not blockDelta)
    // This ensures profits don't reduce the payout pool
    // -----------------------
    static async payOutstandingIous(contractId, propertyId, markDelta, blockHeight) {
        const BigNumber = require('bignumber.js');
        const MarginMap = require('./marginMap.js');

        const d = new BigNumber(markDelta || 0);
        console.log('mark delta in payOutstandingIous: ' + markDelta);
        if (d.lte(0)) return [];

        // ------------------------------------
        // 1) Load bucket
        // ------------------------------------
        const bucketDoc = await PnlIou.getBucket(contractId, propertyId);
        console.log('bucket Doc: ' + JSON.stringify(bucketDoc));
        
        if (!bucketDoc) return [];
        
        // CRITICAL: Only pay if the bucket was updated THIS block
        if (Number(bucketDoc.lastBlock) !== Number(blockHeight)) {
            console.log(`[settleIous] Skipping - bucket last updated in block ${bucketDoc.lastBlock}, current is ${blockHeight}`);
            return [];
        }

        // KEY CHANGE: Use blockLosses instead of blockDelta
        // blockLosses = real tokens debited from losers this block
        const availablePayout = bucketDoc.blockLosses || new BigNumber(0);
        console.log('blockLosses available for payout: ' + availablePayout.toString());
        
        if (availablePayout.lte(0)) {
            console.log('[settleIous] No losses this block to pay out');
            return [];
        }

        // markDelta ∩ availablePayout
        const payoutCap = BigNumber.min(d, availablePayout);
        if (payoutCap.lte(0)) return [];

        // ------------------------------------
        // 2) Load claim map
        // ------------------------------------
        const claimDoc = await PnlIou.getClaimMap(contractId, propertyId);
        console.log('claimDoc: ' + JSON.stringify(claimDoc));
        if (!claimDoc || !claimDoc.claims) return [];

        const entries = Object.entries(claimDoc.claims)
            .map(([address, v]) => ({
                address,
                claim: new BigNumber(v || 0)
            }))
            .filter(c => c.claim.gt(0));

        if (!entries.length) return [];

        const totalClaims = entries.reduce(
            (acc, c) => acc.plus(c.claim),
            new BigNumber(0)
        );

        const payout = BigNumber.min(payoutCap, totalClaims);
        if (payout.lte(0)) return [];

        // ------------------------------------
        // 3) Audit payout summary
        // ------------------------------------
        await PnlIou.audit({
            event: 'payout_summary',
            block: blockHeight,
            contractId,
            propertyId,
            payout: payout.toString(10),
            blockLosses: availablePayout.toString(10),
            totalClaims: totalClaims.toString(10),
            claimants: entries.length
        });

        const mm = await MarginMap.getInstance(contractId);
        const allocations = [];

        // ------------------------------------
        // 4) Allocate + credit + reduce claims
        // ------------------------------------
        console.log('entries in payout: ' + JSON.stringify(entries));
        console.log('total claims: ' + totalClaims.toNumber());
        console.log('payout amount: ' + payout.toNumber());
        
        for (const c of entries) {
            const share = payout.times(c.claim).div(totalClaims);

            const remaining = c.claim.minus(share);
            if (remaining.lte(0)) {
                delete claimDoc.claims[c.address];
            } else {
                claimDoc.claims[c.address] = remaining.toString(10);
            }
            console.log('allocation to push: ' + c.address + ' ' + share);

            allocations.push({
                address: c.address,
                amount: share
            });

            await PnlIou.audit({
                event: 'payout_item',
                block: blockHeight,
                contractId,
                propertyId,
                address: c.address,
                paid: share.toString(10),
                claimAfter: BigNumber.max(remaining, 0).toString(10)
            });
        }

        // ------------------------------------
        // 5) Persist updated claim map
        // ------------------------------------
        claimDoc.lastBlock = blockHeight;
        await PnlIou.saveClaimMap(claimDoc);

        return allocations;
    }

    static async get(contractId, propertyId) {
        const key = PnlIou.key(contractId, propertyId);
        const db = await PnlIou._db();

        try {
            const doc = await db.findOneAsync({ _id: key });
            if (!doc) return new BigNumber(0);
            return new BigNumber(doc.amount);
        } catch (err) {
            return new BigNumber(0);
        }
    }

    // -----------------------
    // Get FULL IOU DOC for a (contractId, propertyId)
    // -----------------------
    static async getDoc(contractId, propertyId) {
        const key = PnlIou.key(contractId, propertyId);
        const db = await PnlIou._db();

        try {
            const doc = await db.findOneAsync({ _id: key });
            return doc || null;
        } catch (err) {
            return null;
        }
    }

    static async getTotalForProperty(propertyId) {
        const db = await PnlIou._db();
        const pId = Number(propertyId);

        let docs;
        try { docs = await db.findAsync({}); }
        catch { return new BigNumber(0); }

        let total = new BigNumber(0);
        for (const doc of docs) {
            if (doc.type !== 'audit' && Number(doc.propertyId) === pId) {
                total = total.plus(doc.amount || 0);
            }
        }
        if (total.gte(0)) { return total; } else { return 0; }
    }

    static async delete(contractId, propertyId) {
        const key = PnlIou.key(contractId, propertyId);
        const db = await PnlIou._db();
        await db.removeAsync({ _id: key }, { multi: false });
    }

    static async deleteForProperty(propertyId) {
        const db = await PnlIou._db();
        await db.removeAsync({ propertyId: Number(propertyId) }, { multi: true });
    }
}

module.exports = PnlIou;