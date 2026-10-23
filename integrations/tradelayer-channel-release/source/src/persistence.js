// persistence.js — Final Production-Ready Version
// ---------------------------------------------------------------
// • API identical to your previous version (getInstance + auto-init)
// • Option 1 network handling ("ltc" + test→"ltc-test")
// • Safe snapshots, safe restores, Windows-compatible
// • No nested backup folders inside dbDir
//---------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const db = require("./db.js");
const ClientWrapper = require("./client.js");
const ConsensusDatabase = require("./consensus.js");
const { readDeploymentProfile, deploymentStateRoot } = require('./deploymentProfile');

// small async sleep helper
const delay = ms => new Promise(res => setTimeout(res, ms));

class Persistence {
    static instance = null;

    //-------------------------------------------------------
    // STATIC GET INSTANCE (Main calls this!)
    //-------------------------------------------------------
    static async getInstance(options = {}) {
        if (!Persistence.instance) {
            Persistence.instance = new Persistence(options);
            await Persistence.instance.init(options);
        }
        return Persistence.instance;
    }

    //-------------------------------------------------------
    // CONSTRUCTOR (does NOT auto-init)
    //-------------------------------------------------------
    constructor(options = {}) {
        if (Persistence.instance) return Persistence.instance;

        // store raw fields (network/test may not be valid yet)
        this.rawNetwork = options.network || null;
        this.rawTestFlag = typeof options.test === "boolean" ? options.test : null;
        this.snapshotInterval =
            typeof options.snapshotInterval === "number"
                ? options.snapshotInterval
                : 1000;

        // directories will be set after network detection
        this.networkFull = null;
        this.dbDir = null;
        this.snapshotsDir = null;
        this.backupsDir = null;

        this.client = null;

        Persistence.instance = this;
    }

    //-------------------------------------------------------
    // INIT — auto-called by getInstance
    //-------------------------------------------------------
    async init(options = {}) {
        // we need RPC client before determining network if missing
        if (!this.client) {
            this.client = await ClientWrapper.getInstance(true);
        }

        // compute network name
        let chain = this.rawNetwork;
        let isTest = this.rawTestFlag;

        if (!chain) {
            chain = await this.client.getChain(); // "ltc" or "btc"
        }
        if (isTest === null) {
            isTest = await this.client.getTest(); // boolean
        }

        chain = chain.toLowerCase().trim();
        this.networkFull = `${chain}-${isTest ? "test" : "main"}`;

        const deployment = readDeploymentProfile();
        if (deployment && (chain !== 'btc' || isTest !== true)) throw new Error('Deployment persistence requires Bitcoin testnet4');
        const rootOverride = deployment ? deploymentStateRoot(deployment) : process.env.TL_NEDB_ROOT;
        const baseDir = rootOverride
            ? (path.isAbsolute(rootOverride) ? rootOverride : path.join(__dirname, "..", rootOverride))
            : path.join(__dirname, "..", "nedb-data");

        this.dbDir = path.join(baseDir, this.networkFull);
        this.snapshotsDir = path.join(baseDir, `${this.networkFull}-snapshots`);
        this.backupsDir = path.join(baseDir, `${this.networkFull}-backups`);

        await fs.promises.mkdir(this.dbDir, { recursive: true });
        await fs.promises.mkdir(this.snapshotsDir, { recursive: true });
        await fs.promises.mkdir(this.backupsDir, { recursive: true });

        return this;
    }

    //-------------------------------------------------------
    // RECORD & FETCH BLOCK HEADERS
    //-------------------------------------------------------
    async recordBlockHeader(height, hash, prevHash) {
        const base = await db.getDatabase("persistence");
        await base.updateAsync(
            { _id: `block-${height}` },
            {
                $set: {
                    height,
                    hash,
                    prevHash,
                    createdAt: Date.now(),
                },
            },
            { upsert: true }
        );
    }

    async getBlockHeader(height) {
        const base = await db.getDatabase("persistence");
        return base.findOneAsync({ _id: `block-${height}` });
    }

    async getLastKnownBlock() {
        const base = await db.getDatabase("persistence");
        const docs = await base.findAsync({ height: { $exists: true } });
        if (!docs || docs.length === 0) return null;
        docs.sort((a, b) => a.height - b.height);
        return docs[docs.length - 1];
    }

    /**
     * Hybrid reorg detection:
     *   1. Fast path: compare incoming prevhash to our stored blockhash for (h-1)
     *   2. If mismatch → confirm via RPC (canonical)
     *   3. Only if both disagree → actual reorg
     *
     * Returns:
     *   false → no reorg
     *   true  → confirmed reorg
     */
    async checkForReorgForNewBlock(blockHeight, incomingPrevHash) {
        try {
            const prevHeight = blockHeight - 1;
            if (prevHeight <= 0) return false; // genesis cannot reorg

            const persistenceDB = await db.getDatabase("persistence");

            // -----------------------------------------
            // FAST PATH: LOCAL HASH CHAIN CHECK
            // -----------------------------------------
            const prevDoc = await persistenceDB.findOneAsync({ height: prevHeight });
            let localPrevHash = null;

            if (prevDoc && prevDoc.hash) {
                localPrevHash = prevDoc.hash;

                // If hashes match → definitely no reorg
                if (localPrevHash === incomingPrevHash) {
                    return false;
                }

                // If mismatch → MAYBE reorg, confirm via RPC
                console.log(
                    `[reorg?] Local mismatch at height=${blockHeight}. ` +
                    `localPrev=${localPrevHash}, incomingPrev=${incomingPrevHash}. Confirming via RPC...`
                );
            } else {
                // No local previous hash — could be startup or partial DB
                // Must confirm with RPC
                console.log(
                    `[reorg?] No local metadata at height=${prevHeight}. Checking RPC for canonical chain...`
                );
            }

            let nodePrevHash;
            try {
                const rpcPrevHash = await this.client.getBlockHash(prevHeight);
                const rpcPrevBlock = await this.client.getBlock(rpcPrevHash);
                nodePrevHash = rpcPrevBlock.hash;
            } catch (e) {
                logger.warn("[reorg] RPC failure during reorg check", e);
                return true //{ reorg: true, depth: 1, uncertain: true };
            }

            if (nodePrevHash !== localPrevHash) {
                return {
                    reorg: true,
                    depth: 1,
                    expected: nodePrevHash,
                    received: localPrevHash
                };
            }

            // Now compare canonical vs incoming
            if (nodePrevHash !== incomingPrevHash) {
                console.log(
                    `[reorg CONFIRMED] height=${blockHeight}. ` +
                    `nodePrev=${nodePrevHash}, incomingPrev=${incomingPrevHash}`
                );
                return true;
            }

            // RPC confirms no reorg → local mismatch was stale or snapshot-induced
            console.log(
                `[reorg false-positive resolved] Local mismatch at height=${blockHeight} ` +
                `but RPC chain matches incoming block. No reorg.`
            );
            return false;

        } catch (err) {
            console.error('[persistence] Error in hybrid reorg detection:', err);
            // safer to assume no reorg in case of RPC failure — do not reorg-loop
            return false;
        }
    }


    //-------------------------------------------------------
    // REORG CHECK FOR NEW BLOCK (top-of-chain equality removed)
    //-------------------------------------------------------
    async detectAndHandleReorg() {
        const last = await this.getLastKnownBlock();
        if (!last) return null;

        const nodeHash = await this.client.getBlockHash(last.height);

        if (nodeHash === last.hash) return null;

        console.warn(
            `Reorg suspected: local(${last.height})=${last.hash}, node=${nodeHash}`
        );

        //---------------------------------------------------
        // Find common ancestor (still useful for debugging)
        //---------------------------------------------------
        let h = last.height;
        let ancestor = 0;

        while (h > 0) {
            const local = await this.getBlockHeader(h);
            const node = await this.client.getBlockHash(h);
            if (local && local.hash === node) {
                ancestor = h;
                break;
            }
            h--;
        }

        //---------------------------------------------------
        // Choose a snapshot — prefer the one closest BELOW last.height
        //---------------------------------------------------
        const snaps = await this.listSnapshots();
        if (!snaps.length) {
            console.warn("No snapshots available — full replay needed");
            return {
                restoredFrom: 0,
                commonAncestor: ancestor,
                lastLocal: last.height,
            };
        }

        // pick the highest snapshot <= last.height
        let best = null;
        for (const s of snaps) {
            if (s.blockHeight <= last.height) {
                if (!best || s.blockHeight > best.blockHeight) best = s;
            }
        }
        if (!best) {
            best = snaps[0];
        }

        await this.restoreSnapshot(best);

        return {
            restoredFrom: best.blockHeight,
            commonAncestor: ancestor,
            lastLocal: last.height,
        };
    }

    //-------------------------------------------------------
    // CHECKPOINT (called by Main)
    //-------------------------------------------------------
    async maybeCheckpoint(blockHeight) {
        if (this.snapshotInterval <= 0) return;
        if (blockHeight % this.snapshotInterval !== 0) return;

        // Compute consensus state hash
        const consensusHash = await ConsensusDatabase.stateConsensusHash();

        // Store hash keyed by height
        await ConsensusDatabase.storeConsensusHash(blockHeight, consensusHash);

        // Create snapshot (EBUSY-safe)
        await this.createSnapshot(blockHeight, consensusHash);
    }

    
    //-------------------------------------------------------
    // SNAPSHOT CREATION (EBUSY-safe)
    //-------------------------------------------------------
    async createSnapshot(height, consensusHash) {
        if (this.snapshotInterval <= 0) return;

        const short = (consensusHash || "nohash").slice(0, 12);
        const dirName = `${height}-${short}`;

        const snapPath = path.join(this.snapshotsDir, dirName);
        await fs.promises.mkdir(snapPath, { recursive: true });

        const files = await fs.promises.readdir(this.dbDir);
        const copied = [];

        for (const file of files) {
            if (!file.endsWith(".db")) continue;
            const src = path.join(this.dbDir, file);
            const dst = path.join(snapPath, file);
            await this.safeCopy(src, dst);
            copied.push(file);
        }

        await fs.promises.writeFile(
            path.join(snapPath, "meta.json"),
            JSON.stringify(
                {
                    blockHeight: height,
                    consensusHash,
                    createdAt: new Date().toISOString(),
                    files: copied,
                },
                null,
                2
            )
        );

        await this.pruneOldSnapshots(2);
        await this.updateMaxProcessed(height)
        await this.cleanupPersistence(height)
        console.log(`Snapshot created at ${height} (${dirName})`);
    }

    /**
     * Delete all persistence entries older than the checkpointHeight.
     */
    async cleanupPersistence(checkpointHeight) {
        const persistenceDB = await db.getDatabase("persistence");
        let height = checkpointHeight-1000
        // delete everything older than the new checkpoint
        await persistenceDB.removeAsync(
            { height: { $lt: height } },
            { multi: true }
        );
        console.log(`[persistence] Cleaned entries < ${checkpointHeight}`);
    }

    async updateMaxProcessed(height) {
        const consensusDB = await db.getDatabase('consensus'); // Access the consensus sub-database

        try {
            // Upsert the document with _id = 'MaxProcessedHeight'
            await consensusDB.updateAsync(
                { _id: 'MaxProcessedHeight' },
                { $set: { value: height } },
                { upsert: true }
            );

            //console.log('MaxProcessedHeight updated:', height);
            return height;
        } catch (error) {
            console.error('Error updating MaxProcessedHeight:', error);
            throw error;
        }
    }


    //-------------------------------------------------------
    // RESTORE SNAPSHOT (EBUSY-SAFE)
    //-------------------------------------------------------
    async restoreSnapshot(meta) {
        const dir = path.join(this.snapshotsDir, meta.dir || `${meta.blockHeight}`);

        // -----------------------------------------------------------------
        // PRUNE OLD BACKUPS: keep only the most recent backup-* directory
        // -----------------------------------------------------------------
        try {
            const backupEntries = await fs.promises.readdir(this.backupsDir);
            const backups = [];

            for (const name of backupEntries) {
                const fullPath = path.join(this.backupsDir, name);
                const stat = await fs.promises.stat(fullPath);

                // only consider directories that look like "backup-<something>"
                if (!stat.isDirectory()) continue;
                if (!name.startsWith('backup-')) continue;

                backups.push({
                    name,
                    fullPath,
                    mtime: stat.mtimeMs,
                });
            }

            if (backups.length > 1) {
                // sort by newest first
                backups.sort((a, b) => b.mtime - a.mtime);

                // keep the newest one, delete all others
                for (let i = 1; i < backups.length; i++) {
                    try {
                        await fs.promises.rm(backups[i].fullPath, {
                            recursive: true,
                            force: true,
                        });
                    } catch (e) {
                        console.error(
                            '[persistence] Error removing old backup dir:',
                            backups[i].fullPath,
                            e
                        );
                    }
                }
            }
        } catch (e) {
            console.error('[persistence] Error pruning backup dirs:', e);
            // non-fatal: continue restoring snapshot
        }

        // -------------------------------------------------
        // CREATE NEW BACKUP OF CURRENT DB STATE
        // -------------------------------------------------
        const backupDir = path.join(
            this.backupsDir,
            `backup-${Date.now()}`
        );
        await fs.promises.mkdir(backupDir, { recursive: true });

        const curr = await fs.promises.readdir(this.dbDir);
        for (const f of curr) {
            const src = path.join(this.dbDir, f);
            const dst = path.join(backupDir, f);
            await this.safeCopy(src, dst);
        }

        // clear current dbDir of ONLY .db files
        for (const f of curr) {
            if (!f.endsWith(".db")) continue;
            const p = path.join(this.dbDir, f);
            await this.safeDelete(p);
        }

        // restore
        for (const f of meta.files) {
            const src = path.join(dir, f);
            const dst = path.join(this.dbDir, f);
            await this.safeCopy(src, dst);
        }

        this.saveTrackHeight(meta.blockHeight)

        console.log(
            `Restored DB from snapshot ${meta.dir} (block=${meta.blockHeight})`
        );

    }

    async saveTrackHeight(saveHeight){
            const base = await db.getDatabase('consensus')
           await base.updateAsync(
                    { _id: 'TrackHeight' },
                    { $set: { value: saveHeight } },
                    { upsert: true }
                    )
    }
 


    //-------------------------------------------------------
    // LIST + PRUNE SNAPSHOTS
    //-------------------------------------------------------
    async listSnapshots() {
        try {
            const entries = await fs.promises.readdir(this.snapshotsDir, {
                withFileTypes: true,
            });
            const dirs = entries.filter(e => e.isDirectory()).map(d => d.name);

            const snaps = [];
            for (const dir of dirs) {
                try {
                    const meta = JSON.parse(
                        await fs.promises.readFile(
                            path.join(this.snapshotsDir, dir, "meta.json"),
                            "utf8"
                        )
                    );
                    meta.dir = dir;
                    snaps.push(meta);
                } catch (e) {
                    console.warn(`Invalid snapshot meta in ${dir}`);
                }
            }

            snaps.sort((a, b) => a.blockHeight - b.blockHeight);
            return snaps;
        } catch (e) {
            return [];
        }
    }

    async pruneOldSnapshots(keep = 2) {
        const snaps = await this.listSnapshots();
        if (snaps.length <= keep) return;

        const toDelete = snaps.slice(0, snaps.length - keep);
        for (const s of toDelete) {
            const p = path.join(this.snapshotsDir, s.dir);
            await fs.promises.rm(p, { recursive: true, force: true });
        }
    }

    //-------------------------------------------------------
    // EBUSY-SAFE COPY + DELETE
    //-------------------------------------------------------
    async safeCopy(src, dst) {
        for (let i = 0; i < 5; i++) {
            try {
                await fs.promises.copyFile(src, dst);
                return;
            } catch (e) {
                if (e.code === "EBUSY" || e.code === "EPERM") {
                    await delay(50);
                    continue;
                }
                throw e;
            }
        }
        throw new Error(`safeCopy failed: ${src} → ${dst}`);
    }

    async safeDelete(p) {
        for (let i = 0; i < 5; i++) {
            try {
                await fs.promises.unlink(p);
                return;
            } catch (e) {
                if (e.code === "EBUSY" || e.code === "EPERM") {
                    await delay(50);
                    continue;
                }
                if (e.code === "ENOENT") return;
                throw e;
            }
        }
        throw new Error(`safeDelete failed: ${p}`);
    }
}

module.exports = Persistence;
