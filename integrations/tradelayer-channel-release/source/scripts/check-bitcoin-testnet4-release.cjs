'use strict';
// Release rehearsal for the channel rules gate, on unsigned transaction fixtures in a separate
// rehearsal profile (its own state namespace). Nothing is signed or sent; the deployment state is
// untouched. Keys come from a fixed seed so that two checkouts produce comparable state digests.
//
// Order (fixture block heights from --height):
//   H     36 genesis activations naming another release (the frozen one stands in)
//   H+1   channel commit                      -> refused, rules not activated for this release
//   H+2   re-activation of types 3 and 4 naming this release
//   H+3   channel commit                      -> valid
//   H+4   9-part trade, expiry H+4            -> valid, settles (at its expiry block)
//   H+5   9-part trade, expiry H+4            -> refused, expired
//   H+6   re-activation of type 3 naming a third release -> indexing stops (superseded)
//
// Usage: node scripts/check-bitcoin-testnet4-release.cjs <observer-datadir> <report.json> [--height N] [--seed S]
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict'), crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const datadir = path.resolve(args[0]), reportFile = path.resolve(args[1]);
const seed = option('--seed', 'tradelayer release rehearsal v1');
const profile = require('../config/bitcoin-testnet4-deployment.json');
const fixtureFile = path.resolve(__dirname, '../config/bitcoin-testnet4-release-rehearsal.json');
const cookie = fs.readFileSync(path.join(datadir, 'testnet4/.cookie'), 'utf8').trim();
async function rpc(method, params = []) {
    const res = await fetch('http://127.0.0.1:48332', { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cookie).toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }) });
    const data = await res.json(); if (data.error) throw Error(data.error.message); return data.result;
}
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const keyFor = (label) => { const k = crypto.createECDH('secp256k1'); k.setPrivateKey(Buffer.from(sha(seed + ' ' + label), 'hex')); return k.getPublicKey(undefined, 'compressed'); };
const report = { checkedAt: new Date().toISOString(), outcome: 'running', rehearsalOnly: true, transactionsSigned: 0, transactionsBroadcast: 0, seed, stages: [] };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); save();
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value;

(async () => {
    const net = bitcoin.networks.testnet;
    const adminPub = keyFor('admin');
    const fixtureAdmin = bitcoin.payments.p2wpkh({ pubkey: adminPub, network: net }).address;
    assert.notEqual(fixtureAdmin, profile.adminAddress, 'rehearsal must not use the deployment admin');
    const genesisBlock = Number(option('--genesis', profile.genesisBlock + 2));
    const fixture = { ...profile, adminAddress: fixtureAdmin, genesisBlock, genesisBlockHash: await rpc('getblockhash', [genesisBlock]) };
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2) + '\n');
    // Fresh namespace for this profile only: the deterministic seed would otherwise reuse earlier state.
    const { deploymentStateRoot } = require('../src/deploymentProfile');
    const stateRoot = deploymentStateRoot(fixture);
    assert.match(path.basename(stateRoot), /^bitcoin-testnet4-[0-9a-f]{16}$/);
    fs.rmSync(stateRoot, { recursive: true, force: true });
    Object.assign(process.env, { TL_DEPLOYMENT_PROFILE: fixtureFile, CHAIN: 'BTC', AUTODETECT: '0', RPC_PORT: '48332', RPC_HOST: '127.0.0.1', RPC_COOKIE_FILE: path.join(datadir, 'testnet4/.cookie') });

    const Main = require('../src/main'), TxIndex = require('../src/txIndex'), Activation = require('../src/activation'), db = require('../src/db');
    const Encode = require('../src/txEncoder'), Release = require('../src/releaseIdentity');
    const main = await Main.getInstance(); await main.initialize({ followBlocks: false });
    const own = Release.ownCodeHash();
    report.releaseCodeHash = own.hex;
    const genesisRelease = 'e38f55e9e2306f0c05fd8fb03507798fd8db471c195a6e3d03eddf54983646db';
    const thirdRelease = sha(seed + ' third release');
    const height = Number(option('--height', (await rpc('getblockcount')) - 8));
    assert.ok(height > genesisBlock, 'fixture height must follow the rehearsal genesis');

    const adminScript = bitcoin.address.toOutputScript(fixtureAdmin, net).toString('hex');
    const prevout = { value: 0.01, scriptPubKey: { type: 'witness_v0_keyhash', hex: adminScript, address: fixtureAdmin } };
    const payloadOutput = (payload, n) => ({ n, value: 0, scriptPubKey: { type: 'nulldata', hex: bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(payload)]).toString('hex') } });
    const adminTx = (label, payload) => ({ txid: sha(seed + ' ' + label), vin: [{ txid: sha(seed + ' input ' + label), vout: 0, prevout }],
        vout: [{ n: 0, value: 0.00999, scriptPubKey: { address: fixtureAdmin, hex: adminScript, type: 'witness_v0_keyhash' } }, payloadOutput(payload, 1)] });
    const base = await db.getDatabase('txIndex');
    const client = await require('../src/client').getInstance(), getRaw = client.getRawTransaction.bind(client), fixtures = new Map();
    client.getRawTransaction = (txid, ...rest) => fixtures.has(txid) ? Promise.resolve(fixtures.get(txid)) : getRaw(txid, ...rest);
    const processAt = async (block, txs, expect) => {
        for (const tx of txs) fixtures.set(tx.txid, tx);
        await TxIndex.processBlockData({ hash: sha(seed + ' block ' + block), tx: txs }, block);
        await main.constructConsensusFromIndex(block);
        const rows = await base.findAsync({ _id: { $regex: new RegExp('^tx-' + block + '-') } });
        assert.equal(rows.length, txs.length, `block ${block}: indexed rows`);
        for (const row of rows) {
            assert.equal(row.valid, expect.valid, `block ${block}: ${JSON.stringify(row)}`);
            if (expect.reason) assert.match(String(row.reason), expect.reason, `block ${block}`);
        }
        report.stages.push({ block, txids: txs.map((tx) => tx.txid), valid: expect.valid, reasons: rows.map((r) => r.reason || '') }); save();
        return rows;
    };

    // H: genesis activations of every type, naming the frozen release.
    await processAt(height, Array.from({ length: 36 }, (_, id) => adminTx('activation ' + id, Encode.encodeActivateTradeLayer({ txTypeToActivate: id, codeHash: genesisRelease }))), { valid: true });
    const activation = Activation.getInstance();
    assert.equal((await activation.getTypeEntry(3)).codeHash, Release.hexToBase36(genesisRelease));

    // Genesis token setup, as in check-bitcoin-testnet4-channel.cjs: 10 TL from the sponsor to the fixture admin.
    const Vesting = require('../src/vesting'), manager = await Vesting.getInstance(), Tally = require('../src/tally');
    await Tally.updateBalance(manager.sponsorAddress, 1, -10, 0, 0, 0, 'releaseRehearsalSeed', height);
    await Tally.updateBalance(fixtureAdmin, 1, 10, 0, 0, 0, 'releaseRehearsalSeed', height);

    const buyerPub = keyFor('buyer'), buyer = bitcoin.payments.p2wpkh({ pubkey: buyerPub, network: net });
    const witness = bitcoin.payments.p2ms({ m: 2, pubkeys: [adminPub, buyerPub] }).output;
    const channel = bitcoin.payments.p2wsh({ redeem: { output: witness }, network: net });
    const addressOutput = (address, n, value) => ({ n, value, scriptPubKey: { address, hex: bitcoin.address.toOutputScript(address, net).toString('hex'), type: address === channel.address ? 'witness_v0_scripthash' : 'witness_v0_keyhash' } });
    const commitTx = (label) => ({ txid: sha(seed + ' ' + label), vin: [{ txid: sha(seed + ' input ' + label), vout: 0, prevout, txinwitness: ['00', adminPub.toString('hex')] }],
        vout: [addressOutput(channel.address, 0, 0.0000546), addressOutput(fixtureAdmin, 1, 0.0099154),
            payloadOutput(Encode.encodeCommit({ propertyId: 1, amount: 10, channelAddress: channel.address, ref: 0, payEnabled: false, clearLists: [], isColoredOutput: false }), 2)] });

    // H+1: a commit before this release is activated is refused and moves nothing.
    await processAt(height + 1, [commitTx('early commit')], { valid: false, reason: /not activated for this release/ });
    assert.equal((await Tally.getTally(channel.address, 1)).channel || 0, 0);

    // H+2: the cutover activation for types 3 and 4.
    await processAt(height + 2, [adminTx('cutover', Encode.encodeActivateTradeLayer({ txTypeToActivate: [3, 4], codeHash: own.hex }))], { valid: true });
    for (const type of [3, 4]) {
        const entry = await activation.getTypeEntry(type);
        assert.equal(entry.codeHash, own.base36); assert.equal(entry.activationBlock, height + 2);
    }

    // H+3: the commit is valid now.
    const commit = commitTx('commit');
    await processAt(height + 3, [commit], { valid: true });
    const Channels = require('../src/channels'), committed = await Channels.getChannel(channel.address);
    const column = committed.participants.A === fixtureAdmin ? 'A' : 'B';
    assert.equal(committed[column][1], 10);

    const tradeTx = (label, expiryBlock) => ({ txid: sha(seed + ' ' + label),
        vin: [{ txid: commit.txid, vout: 0, prevout: commit.vout[0], txinwitness: ['', '00', '00', witness.toString('hex')] },
            { txid: sha(seed + ' buyer input ' + label), vout: 0, prevout: { value: 0.02, scriptPubKey: { address: buyer.address, hex: buyer.output.toString('hex'), type: 'witness_v0_keyhash' } } }],
        vout: [addressOutput(buyer.address, 0, 0.0100246), addressOutput(fixtureAdmin, 1, 0.01),
            payloadOutput(Encode.encodeTradeTokenForUTXO({ propertyId: 1, amount: 1, columnA: column === 'A', satsExpected: 0.01, tokenOutput: 0, payToAddress: 1, isColoredOutput: false, expiryBlock }), 2)] });

    // H+4: a trade confirming at its expiry block settles.
    await processAt(height + 4, [tradeTx('trade', height + 4)], { valid: true });
    assert.equal((await Tally.getTally(channel.address, 1)).channel, 9);
    assert.equal((await Tally.getTally(buyer.address, 1)).available, 0.99995);

    // H+5: the same terms confirming one block after the expiry are refused and move nothing.
    await processAt(height + 5, [tradeTx('late trade', height + 4)], { valid: false, reason: /expired/i });
    assert.equal((await Tally.getTally(channel.address, 1)).channel, 9);
    assert.equal((await Tally.getTally(buyer.address, 1)).available, 0.99995);

    // State digest before the superseded block, for comparing checkouts.
    const finalChannel = await Channels.getChannel(channel.address);
    const registry = {};
    for (const type of [3, 4]) { const e = await activation.getTypeEntry(type); registry[type] = { active: e.active, activationBlock: e.activationBlock, codeHash: e.codeHash }; }
    const state = canonical({
        tallies: Object.fromEntries(await Promise.all([manager.sponsorAddress, fixtureAdmin, channel.address, buyer.address].map(async (a) => [a, await Tally.getTally(a, 1)]))),
        channel: { participants: finalChannel.participants, A: finalChannel.A, B: finalChannel.B }, registry,
        stages: report.stages.map(({ block, txids, valid, reasons }) => ({ block, txids, valid, reasons })),
    });
    report.stateDigest = sha(JSON.stringify(state));
    report.state = state;

    // H+6: a re-activation naming a third release stops indexing; nothing is recorded or marked processed.
    const superseding = adminTx('superseding', Encode.encodeActivateTradeLayer({ txTypeToActivate: [3], codeHash: thirdRelease }));
    fixtures.set(superseding.txid, superseding);
    await TxIndex.processBlockData({ hash: sha(seed + ' block ' + (height + 6)), tx: [superseding] }, height + 6);
    await assert.rejects(main.constructConsensusFromIndex(height + 6), (error) => error.superseded === true && /Superseded code: type 3/.test(error.message));
    assert.equal((await activation.getTypeEntry(3)).codeHash, own.base36, 'the superseding activation must not be recorded');
    report.supersededHalt = { block: height + 6, recordedUnchanged: true };

    Object.assign(report, { outcome: 'passed', statePath: db.path, fixtureAdmin, channelAddress: channel.address, column, height, genesisBlock });
    save();
    process.exit(0);
})().catch((error) => { Object.assign(report, { outcome: 'failed', error: error.stack }); save(); console.error(error); process.exit(1); });
