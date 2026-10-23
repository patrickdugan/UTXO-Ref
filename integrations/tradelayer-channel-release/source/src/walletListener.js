const ClientWrapper = require('./client.js');
const express = require('express');
const axios = require('axios');
const TallyMap = require('./tally.js');
const TxIndex = require('./txIndex.js');
const PropertyManager = require('./property.js');
const Main = require('./main.js');
const Activations = require('./activation.js');
const Orderbook = require('./orderbook.js');
const ContractRegistry = require('./contractRegistry.js');
const OracleList = require('./oracle.js');
const MarginMap = require('./marginMap.js');
const TxUtils = require('./txUtils.js')
const Consensus = require('./consensus.js')
const Channels = require('./channels.js')
const Types = require('./types.js')
const ClearList = require('./clearlist.js')
const Clearing = require('./clearing.js')
const TradeHistory = require('./tradeHistoryManager.js')
const VolumeIndex = require('./volumeIndex.js')
const db = require('./db.js')
const IssuanceIntent = require('./issuanceIntent.js')

let isInitialized = false; // A flag to track the initialization status
let isInitializing = false;
let initPromise = null;
const app = express();
const port = Number(process.env.TL_WALLET_PORT || 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback listener port');
app.use((req, res, next) => {
    const allowed = new Set(['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]);
    if (!allowed.has(req.headers.host) || req.headers.origin) return res.status(403).json({ error: 'Local backend requests only' });
    next();
});

app.use(express.json()); // Middleware to parse JSON bodies

// Function to check if the ClientWrapper is ready (with retries)
async function waitForClientWrapper(maxRetries = 10, interval = 500) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            const client = await ClientWrapper.getInstance();  // Check if client is ready
            if (client.chain) {
                console.log('Client is ready.');
                return client;
            }
        } catch (error) {
            console.log('ClientWrapper initialization not ready, retrying...');
        }
        retries++;
        await new Promise(resolve => setTimeout(resolve, interval));  // Wait for interval before retrying
    }
    throw new Error('ClientWrapper failed to initialize after max retries.');
}

let lastInitCall = Date.now();

app.post('/tl_getSyncStatus', async (req, res) => {
    try {
        const client = await ClientWrapper.getInstance();
        const info = await client.getBlockchainInfo();
        const consensus = await db.getDatabase('consensus');
        const processed = await consensus.findOneAsync({ _id: 'MaxProcessedHeight' });
        const indexedHeight = await TxIndex.findMaxIndexedBlock();
        const profile = require('./deploymentProfile').readDeploymentProfile();
        const currentHeight = processed?.value ?? null;
        const failure = Main.instance?.followError;
        res.json({ initialized: isInitialized, phase: failure ? 'failed' : isInitialized ? 'realtime' : 'waiting',
            message: failure || '', network: info.chain, chainTip: info.blocks, targetHeight: info.blocks,
            currentHeight, processedHeight: currentHeight, indexedHeight, genesisBlock: profile?.genesisBlock ?? null,
            adminAddress: profile?.adminAddress ?? null, updatedAt: Date.now() });
    } catch (error) { res.status(503).json({ error: error.message }); }
});

// Initialize Main once ClientWrapper is ready
app.post('/tl_initmain', async (req, res) => {
    try {

        if(req.wallet){
            const now = Date.now();
            if (now - lastInitCall < 30000) {  // Only allow one call per second, adjust timing as needed
                return res.status(429).send('Too many requests');  // Or simply ignore this call
            }
            lastInitCall = now;
        }

        if (isInitialized) {
            res.status(200).send('Main process already initialized');
            return;
        }
        if (isInitializing && initPromise) {
            await initPromise;
            res.status(200).send(isInitialized ? 'Main process initialized successfully' : 'Main process initialization failed');
            return;
        }

        console.log('Waiting for ClientWrapper initialization...');
        const client = await waitForClientWrapper();  // Ensure ClientWrapper is initialized
        
        console.log('Client and Database initialized successfully.');

        // Initialize Main only after ClientWrapper is ready
        const mainProcessor = await Main.getInstance(client);  // Pass client to Main
        isInitializing = true;
        initPromise = (async () => {
            await mainProcessor.initialize();
            isInitialized = true;  // Mark as initialized only after successful init
        })();

        await initPromise;
        res.status(200).send('Main process initialized successfully');
    } catch (error) {
        isInitialized = false;
        console.error('Error during initialization:', error);
        res.status(500).send('Error: ' + error.message);
    } finally {
        isInitializing = false;
        initPromise = null;
    }
});
// Validate address
app.post('/tl_validateaddress', async (req, res) => {
    try {
        const { address } = req.body;
        const validationResponse = await TxUtils.validateAddress(address)
        res.json(validationResponse);
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});


app.post('/tl_getTransaction', async (req, res) => {
    try {
        const { txid } = req.body;
        const txInfo = await Consensus.getTxParams(txid)
        res.json(txInfo);
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_getChannelColumn', async (req,res) =>{
    try {
        // Accepts { params: [channelAddress, newCommitAddress, cpAddress] } or the named fields.
        // predictColumnForAddress takes the channel record, not its address.
        const body = req.body || {};
        const [channelAddress, newCommitAddress, cpAddress] = Array.isArray(body.params)
            ? body.params
            : [body.channelAddress, body.newCommitAddress, body.cpAddress];
        if (![channelAddress, newCommitAddress, cpAddress].every(value => typeof value === 'string' && value)) {
            return res.status(400).json({ error: 'channelAddress, newCommitAddress and cpAddress are required' });
        }
        const channel = await Channels.getChannel(channelAddress);
        const column = Channels.predictColumnForAddress(channel, newCommitAddress, cpAddress);
        if (column !== 'A' && column !== 'B') return res.status(409).json({ error: 'Channel column is not predictable' });
        res.json({ data: { column, columnA: column === "A" } });
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
})

// Wallets confirm these before a seller commits tokens to a channel. A listener that lacks
// this route predates the type-3 expiry field: it does not enforce a trade's expiry, and a
// frozen release decodes a nine-part trade while dropping the expiry.
app.post('/tl_getProtocolCapabilities', async (req, res) => {
    try {
        const ReleaseIdentity = require('./releaseIdentity.js');
        const activations = Activations.getInstance();
        const recorded = {};
        for (const type of ReleaseIdentity.GATED_TYPES) {
            const entry = await activations.getTypeEntry(type);
            recorded[type] = { active: !!entry?.active, activationBlock: entry?.activationBlock ?? null,
                codeHash: entry?.codeHash ? ReleaseIdentity.base36ToHex(entry.codeHash) : null, rulesActive: ReleaseIdentity.rulesActive(entry) };
        }
        res.json({ data: { tradeTokenForUTXO: { maxParts: 9, expiryBlock: true }, channelColumn: { version: 2 },
            codeHash: ReleaseIdentity.ownCodeHash().hex, recorded } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/tl_getAttestations', async (req, res) => {
    try {
        const { address, id } = req.body;

        // Fetch and sort attestations
        const attestationHistory = await ClearList.getAttestationHistory(address, id);

        res.json(attestationHistory); // Send the sorted array back
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_getIssuanceIntents', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address) return res.status(400).json({ error: 'Missing address' });
        const intents = await IssuanceIntent.getIntentsByAddress(address);
        return res.status(200).json(intents || []);
    } catch (error) {
        console.error('Error fetching issuance intents:', error);
        return res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_prepareCommitFromIssuance', async (req, res) => {
    try {
        const { issuanceTxid, fromAddress, channelAddress, autoSend = false, payEnabled = false, clearLists } = req.body;
        if (!issuanceTxid || !fromAddress || !channelAddress) {
            return res.status(400).json({ error: 'Missing issuanceTxid/fromAddress/channelAddress' });
        }

        const intent = await IssuanceIntent.getIntent(issuanceTxid);
        if (!intent) return res.status(404).json({ error: 'Issuance intent not found' });
        if (intent.mode !== 'commit') return res.status(400).json({ error: 'Issuance intent is not commit mode' });
        if (intent.recipientAddress !== fromAddress) {
            return res.status(400).json({ error: 'fromAddress must match issuance recipient' });
        }

        const commitParams = {
            propertyId: intent.propertyId,
            amount: intent.amount,
            channelAddress,
            payEnabled: Boolean(payEnabled),
            clearLists: Array.isArray(clearLists)
                ? clearLists
                : (intent.clearlistId ? [intent.clearlistId] : [])
        };

        if (!autoSend) {
            return res.status(200).json({ prepared: true, commitParams, intent });
        }

        const txid = await TxUtils.createCommitTransaction(fromAddress, commitParams);
        return res.status(200).json({ prepared: true, broadcast: true, txid, commitParams, intent });
    } catch (error) {
        console.error('Error preparing commit from issuance:', error);
        return res.status(500).send('Error: ' + error.message);
    }
});


/*app.post('/tl_decodeTx', async (req, res) => {
    try {
        const { txid } = req.body;
        const txData = await TxIndex.getTx(txid)
        const txId = txData.value[0].txId;

        res.json(txInfo);
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});*/

app.post('/tl_loadWallet', async (req, res) => {
    try {
        const {} = req.body;
        const wallet = TxUtils.load()
        res.json('loading wallet');
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_gettransactionsforaddress', async (req, res) => {
    try {
        const { address } = req.body;
        const txInfo = await Consensus.getTxParamsForAddress(address)
        res.json(txInfo);
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});


app.post('/tl_gettransactionforblock', async (req, res) => {
    try {
        const { blockHeight } = req.body;
        const txInfo = await Consensus.getTxParamsForBlock(blockHeight)
        res.json(txInfo);
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_getMaxProcessedHeight', async (req, res) => {
    try {
        const maxProcessedHeight = await Consensus.getMaxProcessedBlock();
        res.status(200).json({ maxProcessedHeight: maxProcessedHeight ?? null });
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_getMaxParsedHeight', async (req, res) => {
    try {
        const maxParsedHeight = await TxIndex.findMaxIndexedBlock();
        res.status(200).json({ maxParsedHeight: maxParsedHeight ?? null });
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_getTrackHeight', async (req, res) => {
    try {
        // TrackHeight is persisted in consensus DB; do not initialize Main for read-only status.
        const consensusDB = await db.getDatabase('consensus');
        const trackDoc = await consensusDB.findOneAsync({ _id: 'TrackHeight' });
        const trackHeight = trackDoc ? trackDoc.value : null;
        const maxProcessedHeight = await Consensus.getMaxProcessedBlock();
        res.status(200).json({
            trackHeight: trackHeight ?? maxProcessedHeight ?? null,
            source: trackHeight != null ? 'track' : 'maxProcessed'
        });
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_checkSync', async (req, res) => {
    try {
        // Lightweight sync check from persisted heights to keep this endpoint stable under load.
        const [consensusHeight, txIndexHeight] = await Promise.all([
            Consensus.getMaxProcessedBlock(),
            TxIndex.findMaxIndexedBlock()
        ]);
        res.status(200).json({
            available: true,
            consensus: consensusHeight ?? null,
            txIndex: txIndexHeight ?? null
        });
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_pause', async (req, res) => {
    try {
        const {} = req.body;
        const mainInstance = typeof Main.getInstance === 'function' ? await Main.getInstance() : null;
        if (!mainInstance || typeof mainInstance.setPause !== 'function') {
            return res.status(200).json({
                available: false,
                reason: 'Main.setPause unavailable'
            });
        }
        const pause = mainInstance.setPause();
        res.json({ available: true, pause });
    } catch (error) {
        console.error('Error validating address:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// Get all balances for an address
app.post('/tl_getAllBalancesForAddress', async (req, res) => {
    console.log('Trying to load balances for: ' + req.body.params);

    try {
        const balances = await TallyMap.getAddressBalances(req.body.params);
        res.status(200).json(balances);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_getChannel', async (req, res) => {
    console.log('Trying to load channel for: ' + req.body.params);

    try {
        // Fetch the channel information
        const channel = await Channels.getChannel(req.body.params);

        // Handle the case where the channel is undefined or null (no channel exists)
        if (!channel) {
            return res.status(200).json({ message: 'No channel found for the given address', channel: null });
        }

        // If the channel exists, return it as a successful response
        return res.status(200).json(channel);
    } catch (error) {
        // Handle other unexpected errors and return a 500 status for genuine server-side issues
        console.error('Error loading channel:', error);
        return res.status(500).send('Error: ' + error.message);
    }
});

// Add OP_Return to tx blob
 app.post('/tl_createrawtx_opreturn', async (req, res) => {
    try {
        const [txHex, payload] = req.body.params;
        const payloadedTx = await TxUtils.addOPReturn(txHex, payload);
        const result = { data: payloadedTx.toString('hex') };
        res.status(200).send(result);
    } catch (error) {
        console.error(error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_getProperty', async (req, res) => {
    try {
        const pid = req.body.params;
        console.log('tl_getproperty: ' + pid);
        const data = await PropertyManager.getPropertyData(pid);
        res.json(data);
    } catch (error) {
        console.error('Error fetching property data:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// List properties
app.post('/tl_listProperties', async (req, res) => {
    try {
        console.log('Express calling property list');
        const propertiesArray = await PropertyManager.getPropertyIndex();
        res.json(propertiesArray);
    } catch (error) {
        console.error('Error fetching property list:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_listClearlists', async (req, res) => {
    try {
        console.log('Express calling clearlists');
        const clearLists = await ClearList.loadClearlists();
        res.json(clearLists);
    } catch (error) {
        console.error('Error fetching property list:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

app.post('/tl_showClearlist', async (req, res) => {
    try {
        console.log('Express calling clearlist');
        
        // Corrected the destructuring syntax
        const { id } = req.body;
        
        const clearList = await ClearList.getClearlistById(Number(id));
        res.json(clearList);
    } catch (error) {
        console.error('Error fetching property list:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// Protocol-canonical clearlist lookup for infra/attestation tooling.
// Returns the clearlist registry record (admin + backup + metadata) or false if not found.
app.post('/tl_getClearlistById', async (req, res) => {
    try {
        const { id } = req.body;
        const n = Number(id);
        if (!Number.isInteger(n) || n < 0) {
            return res.status(400).json({ error: 'Invalid clearlist id' });
        }
        const clearList = await ClearList.getClearlistById(n);
        res.json(clearList);
    } catch (error) {
        console.error('Error fetching clearlist:', error);
        res.status(500).send('Error: ' + error.message);
    }
});


app.post('/tl_listFeeCache', async(req,res)=>{
    try{
        console.log('Pulling fees for all properties');
        const feeCache = await PropertyManager.loadFeeCacheFromDB();
        res.json(feeCache);
    } catch (error) {
        console.error('Error fetching fee cache', error);
        res.status(500).send('Error: ' + error.message);
    }
})

app.post('/tl_propertyFeeCache', async(req,res)=>{
    try{
        console.log('Pulling fees for all properties');
        const feeCache = await PropertyManager.loadFeeCacheForProperty(req.id);
        res.json(feeCache);
    } catch (error) {
        console.error('Error fetching fee cache', error);
        res.status(500).send('Error: ' + error.message);
    }
})

function envNum(name, fallback = 0) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === '') return Number(fallback || 0);
    const n = Number(raw);
    return Number.isFinite(n) ? n : Number(fallback || 0);
}

function parseWindowIndex(id) {
    const m = String(id || '').match(/^bitvm-risk-window-\d+-(\d+)$/);
    if (!m) return null;
    const idx = Number(m[1]);
    return Number.isFinite(idx) ? idx : null;
}

app.post('/tl_bitvmStatus', async (req, res) => {
    try {
        const body = req.body || {};
        const propertyIdRaw = body.propertyId;
        const propertyId = Number(propertyIdRaw);
        const hasPropertyFilter = Number.isFinite(propertyId) && propertyId > 0;
        const dlcRef = String(body.dlcRef || '').trim();
        const expiringWithinBlocks = Math.max(1, Math.floor(envNum('TL_BITVM_EXPIRING_WITHIN_BLOCKS', 6)));

        const currentBlock = Number(await Consensus.getMaxProcessedBlock()) || 0;
        const proceduralDB = await db.getDatabase('procedural');
        const caches = await proceduralDB.findAsync({ type: 'bitvmCache' });
        const globalRisk = await proceduralDB.findAsync({ type: 'bitvmRiskEscrowGlobal' });
        const dlcRisk = await proceduralDB.findAsync({ type: 'bitvmRiskEscrowDlc' });
        const windowRisk = await proceduralDB.findAsync({ type: 'bitvmRiskWindow' });

        const filteredCaches = caches.filter((doc) => {
            if (hasPropertyFilter && Number(doc.propertyId) !== propertyId) return false;
            if (dlcRef && String(doc.dlcRef || '') !== dlcRef) return false;
            return true;
        });

        const pendingStatuses = new Set(['PENDING', 'CHALLENGED']);
        const openCaches = filteredCaches.filter((doc) => pendingStatuses.has(String(doc.status || '').toUpperCase())).length;
        const activeChallenges = filteredCaches.filter((doc) => String(doc.status || '').toUpperCase() === 'CHALLENGED').length;
        const expiringSoon = filteredCaches.filter((doc) => {
            const status = String(doc.status || '').toUpperCase();
            if (!pendingStatuses.has(status)) return false;
            const deadline = Number(doc.challengeDeadlineBlock || 0);
            if (!Number.isFinite(deadline) || deadline <= 0) return false;
            return deadline <= currentBlock + expiringWithinBlocks;
        }).length;
        const expiringTargets = filteredCaches
            .filter((doc) => {
                const status = String(doc.status || '').toUpperCase();
                if (!pendingStatuses.has(status)) return false;
                const deadline = Number(doc.challengeDeadlineBlock || 0);
                if (!Number.isFinite(deadline) || deadline <= 0) return false;
                return deadline <= currentBlock + expiringWithinBlocks;
            })
            .sort((a, b) => Number(a.challengeDeadlineBlock || 0) - Number(b.challengeDeadlineBlock || 0))
            .slice(0, 50)
            .map((doc) => ({
                cacheId: String(doc.cacheId || ''),
                dlcRef: String(doc.dlcRef || ''),
                propertyId: Number(doc.propertyId || 0),
                amount: Number(doc.amount || 0),
                fromAddress: String(doc.fromAddress || ''),
                toAddress: String(doc.toAddress || ''),
                challengeDeadlineBlock: Number(doc.challengeDeadlineBlock || 0),
                resolverAddress: String(doc.resolverAddress || '')
            }));
        const fraudProofsSubmitted = filteredCaches.reduce((sum, doc) => {
            const n = Array.isArray(doc.challenged) ? doc.challenged.length : 0;
            return sum + n;
        }, 0);

        const filteredGlobalRisk = globalRisk.filter((doc) => {
            if (!hasPropertyFilter) return true;
            return Number(doc.propertyId) === propertyId;
        });
        const pendingEscrow = filteredGlobalRisk.reduce((sum, doc) => sum + (Number(doc.pendingAmount || 0) || 0), 0);

        const filteredDlcRisk = dlcRisk.filter((doc) => {
            if (hasPropertyFilter && Number(doc.propertyId) !== propertyId) return false;
            if (dlcRef && String(doc.dlcRef || '') !== dlcRef) return false;
            return true;
        });
        const pendingEscrowPerDlc = filteredDlcRisk.reduce((max, doc) => {
            const amt = Number(doc.pendingAmount || 0) || 0;
            return amt > max ? amt : max;
        }, 0);

        const windowBlocks = Math.max(1, Math.floor(envNum('TL_BITVM_SCHED_WINDOW_BLOCKS', 144)));
        const currentWindowIdx = Math.floor(Math.max(0, currentBlock) / windowBlocks);
        const currentWindowRows = windowRisk.filter((doc) => {
            if (hasPropertyFilter && Number(doc.propertyId) !== propertyId) return false;
            const idx = parseWindowIndex(doc._id);
            return idx === currentWindowIdx;
        });

        const depositsThisWindow = currentWindowRows.reduce((sum, doc) => sum + (Number(doc.depositAmount || 0) || 0), 0);
        const withdrawalsThisWindow = currentWindowRows.reduce((sum, doc) => sum + (Number(doc.withdrawAmount || 0) || 0), 0);
        const sweepsThisWindow = currentWindowRows.reduce((sum, doc) => sum + (Number(doc.sweepAmount || 0) || 0), 0);

        const commitSchemeRaw = String(process.env.TL_ORACLE_STATE_COMMIT_SCHEME || '').trim().toLowerCase();
        const status = {
            source: 'walletListener',
            atBlock: currentBlock,
            featureEnabled: process.env.TL_ORACLE_REQUIRE_STATE_ROOT === '1',
            commitScheme: commitSchemeRaw === 'binohash' ? 'experimental-binohash' : 'legacy-merkle',
            updatedAt: Date.now(),
            cache: {
                openCaches,
                pendingEscrow,
                pendingEscrowCap: envNum('TL_BITVM_MAX_PENDING_ESCROW', 0),
                pendingEscrowPerDlc: pendingEscrowPerDlc,
                pendingEscrowPerDlcCap: envNum('TL_BITVM_MAX_PENDING_ESCROW_PER_DLC', 0),
            },
            challenge: {
                active: activeChallenges,
                expiringSoon,
                expiringTargets,
                fraudProofsSubmitted,
                watchtowerLastTick: 0,
            },
            sweep: {
                windowBlocks,
                depositsThisWindow,
                withdrawalsThisWindow,
                sweepsThisWindow,
                maxDepositPerWindow: envNum('TL_BITVM_MAX_DEPOSIT_PER_WINDOW', 0),
                maxWithdrawPerWindow: envNum('TL_BITVM_MAX_WITHDRAW_PER_WINDOW', 0),
                maxSweepPerWindow: envNum('TL_BITVM_MAX_SWEEP_PER_WINDOW', 0),
            }
        };
        res.json(status);
    } catch (error) {
        console.error('Error fetching bitvm status:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// Get activations
app.post('/tl_getActivations', async (req, res) => {
    try {
        console.log('Express calling activations');
        const activations = await Activations.getInstance().loadActivationsList();
        res.json(activations);
    } catch (error) {
        console.error('Error fetching activations:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// Get order book
app.post('/tl_getOrderbook', async (req, res) => {
    try {
        const { propertyId1, propertyId2 } = req.body;
        const orderBookKey = `${propertyId1}-${propertyId2}`;
        const orderbook = new Orderbook(orderBookKey);
        const orderBookData = await orderbook.loadOrderBook(orderBookKey);
        res.json(orderBookData);
    } catch (error) {
        console.error('Error fetching order book:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// Get contract order book
app.post('/tl_getContractOrderbook', async (req, res) => {
    try {
        const { contractId } = req.body;
        const orderBookKey = `contract-${contractId}`;
        const orderbook = new Orderbook(orderBookKey);
        await orderbook.loadOrCreateOrderBook();
        const orderBookData = orderbook.getOrderBookData();
        res.json(orderBookData);
    } catch (error) {
        console.error('Error fetching contract order book:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// List contract series
app.post('/tl_listContractSeries', async (req, res) => {
    try {
        console.log('Fetching contract series list');
        const { contractId } = req.body;
        const contractSeriesArray = await ContractRegistry.getContractInfo(contractId);
        console.log('Contract series array ' + JSON.stringify(contractSeriesArray));
        res.json(contractSeriesArray);
    } catch (error) {
        console.error('Error fetching contract series:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// List oracles
app.post('/tl_listOracles', async (req, res) => {
    try {
        console.log('Fetching oracle list');
        const oracleArray = await OracleList.getAllOracles();
        res.json(oracleArray);
    } catch (error) {
        console.error('Error fetching oracle list:', error);
        res.status(500).send('Error: ' + error.message);
    }
});

// Get contract position for address and contract ID
app.get('/tl_contractPosition', async (req, res) => {
    try {
        const { address, contractId } = req.query;
        if (!address || !contractId) {
            return res.status(400).json({ error: "Missing address or contractId" });
        }
        const contractIdNum = Number(contractId);
        if (isNaN(contractIdNum)) {
            return res.status(400).json({ error: "contractId must be a number" });
        }
        const map = await MarginMap.getInstance(contractIdNum)
        const position = await map.getPositionForAddress(address,contractIdNum);
        res.json(position);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// Get sum of open channel balances for commit address and prop ID
app.get('/tl_channelBalanceForCommiter', async (req, res) => {
    try {
        const { address, propertyId } = req.query;
        if (!address || !propertyId) {
            return res.status(400).json({ error: "Missing address or contractId" });
        }
        const propIdNum = Number(propertyId);
        if (isNaN(propIdNum)) {
            return res.status(400).json({ error: "contractId must be a number" });
        }
        const rows = await Channels.getChannelBalancesForAddress(address, propertyId)
        const total = rows.reduce((s, r) => s + r.amount, 0);
        res.json({ total, rows });
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

function parsePropertyKey(raw) {
  // "s123-2001" => redeem; "123" => mint
  if (typeof raw === 'string' && /^s\d+-\d+$/i.test(raw)) {
    const [, p, c] = raw.match(/^s(\d+)-(\d+)$/i);
    return { mode: 'redeem', basePid: Number(p), contractId: Number(c), synthKey: raw };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('Invalid propertyId');
  return { mode: 'mint', basePid: n };
}


function parseValue(doc) {
  // Your samples look like: { _id, block, value: "<JSON string>" }
  const raw = doc?.value ?? doc?.data ?? doc?.map ?? null;
  if (raw == null) return null;

  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* fall-through */ }
  }
  return raw;
}

app.get('/tl_getMaxSynth', async (req, res) => {
  try {
    const { address, propId } = req.query;
    if (!address || !propId) {
      return res.status(400).json({ error: 'address and propertyId are required' });
    }

    const { mode, basePid, contractId: redeemCid, synthKey } = parsePropertyKey(propId);

    // list candidate contracts for this base property (inverse + native)
    let candidates = await ContractRegistry.lookupInverseNativeByNotionalPid(basePid);
    if (mode === 'redeem') {
      candidates = candidates.filter(c => Number(c.contractId) === Number(redeemCid));
    }

    const tokenPriceLTC = await VolumeIndex.getTokenPriceInLTC(basePid).catch(() => null);

    const eligible = [];
    for (const c of candidates) {
    const map = await MarginMap.getInstance(c.seriesId)

      // read position for this address in this contract’s series
      const pos = await map.readPosition(c.seriesId, address); // 👈 new helper

      const contracts = Number(pos?.contracts || 0);
      const shortContracts = contracts < 0 ? -contracts : 0;

        let mark = Number(pos?.lastMark);
      if (!mark || mark <= 0) {
        mark = tokenPriceLTC || 0;
      }

      let notionalPerContract = 0;
      if (shortContracts > 0 && mark > 0) {
        const nv = await ContractRegistry.getNotionalValue(c.contractId, mark);
        notionalPerContract = Number(nv?.notionalValue || 0);
      }

      const maxByPositionUnits = shortContracts * notionalPerContract;

      eligible.push({
        contractId: c.contractId,
        seriesId: c.seriesId,
        symbol: c.symbol,
        notionalPropertyId: c.notionalPropertyId,
        mark,
        tokenPriceLTC: tokenPriceLTC ?? null,
        shortContracts,
        perContractUnits: notionalPerContract,
        maxMintUnits: maxByPositionUnits,
      });
    }

    res.json({
      mode,
      basePropertyId: basePid,
      ...(synthKey ? { synthKey } : {}),
      tokenPriceLTC: tokenPriceLTC ?? null,
      eligible
    });
  } catch (err) {
    console.error('tl_getMaxSynth error', err);
    res.status(500).json({ error: String(err && err.message || err) });
  }
});


// Get trade history
app.get('/tl_tradeHistory', async (req, res) => {
    try {
        const { propertyId1, propertyId2 } = req.query;
        const tradeHistory = await TradeHistory.getTradeHistoryByPropertyIdPair(propertyId1, propertyId2);
        console.log('Returning trade history ' + JSON.stringify(tradeHistory));
        res.json(tradeHistory);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

app.get('/tl_tokenTradeHistoryForAddress', async (req, res) => {
    try {
        const { propertyId1, propertyId2, address } = req.query;
        const tradeHistory = await TradeHistory.getTokenTradeHistoryForAddress(propertyId1, propertyId2,address);
        console.log('Returning trade history ' + JSON.stringify(tradeHistory));
        res.json(tradeHistory);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// Get initial margin for wallet UI and associated parameters (like commiting to channel for a contract trade)
app.get('/tl_getInitMargin', async (req, res) => {
    try {
        const { contractId, price } = req.query;
        const initialMargin = await ContractRegistry.getInitialMargin(contractId, price);
        console.log('Init. Margin for contract at price ' + JSON.stringify(initialMargin));
        res.json(initialMargin);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

app.get('/tl_getContractInfo', async (req, res) => {
  try {
    const { contractId } = req.query;
    const info = await ContractRegistry.getContractInfo(contractId);
    if (!info) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    res.json(info);
  } catch (error) {
    res.status(500).send('Error: ' + error.message);
  }
});


// Get contract trade history
app.get('/tl_contractTradeHistory', async (req, res) => {
    try {
        const { contractId } = req.query;
        const contractTradeHistory = await Orderbook.getContractTradeHistoryByContractId(contractId);
        res.json(contractTradeHistory);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

app.get('/tl_contractTradeHistoryForAddress', async (req, res) => {
    try {
        const { contractId, address } = req.query;
        const contractTradeHistory = await TradeHistory.getContractTradeHistoryForAddress(contractId,address);
        res.json(contractTradeHistory);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

app.get('/tl_totalTradeHistoryForAddress', async (req, res) => {
    try {
        const { address } = req.query;
        const totalTradeHistory = await TradeHistory.getTradeHistoryForAddress(address);
        res.json(totalTradeHistory);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// Get funding history
app.get('/tl_fundingHistory', async (req, res) => {
    try {
        const { contractId } = req.query;
        if (!contractId) return res.status(400).send("Missing contractId");

        const startBlock = req.query.startBlock || await Main.getGenesisBlock();
        const endBlock = req.query.endBlock || await Main.getLastBlock();

        const fundingHistory = await Clearing.loadFundingEvents(contractId, startBlock, endBlock);
        res.json(fundingHistory);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// Get oracle history
app.get('/tl_oracleHistory', async (req, res) => {
    try {
        const { contractId } = req.query;
        const oracleHistory = await Oracles.getHistory(contractId);
        res.json(oracleHistory);
    } catch (error) {
        res.status(500).send('Error: ' + error.message);
    }
});

// ... Other endpoints ...

app.listen(port, '127.0.0.1', () => {
    // const params = ['a1','c3'];
    // const body = { params };
    // console.log(`body:${JSON.stringify(body)}`)
    console.log(`Express server running on port ${port}`);
});
