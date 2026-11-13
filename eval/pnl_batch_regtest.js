#!/usr/bin/env node
'use strict';

/**
 * Isolated, valueless Bitcoin Core regtest exercise of guarded PnL settlement.
 *
 * BITCOIN_BIN=/path/to/bitcoin/bin node eval/pnl_batch_regtest.js
 * BITCOIN_BIN also accepts the full bitcoind executable path.
 * Optional: --out /explicit/path/receipt.json
 *
 * This harness creates its own datadir, loopback RPC port, cookie and wallet.
 * It disables peer connectivity and always stops its own daemon and removes
 * its temporary files. It never connects to a pre-existing node or wallet.
 * Reserve keys and both checkpoint signers share this disposable test process;
 * the exercise establishes no independent-custody or ZK security claim.
 */

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  buildSignedPnlBatchCheckpointV2, TRUST_POLICY_KIND
} = require('../bitvm3/utxo_referee/utxoref_v2_pnl_batch_checkpoint');
const {
  PnlBatchStateStore, ledgerFromSnapshot, hashLedgerState
} = require('../bitvm3/utxo_referee/tradelayer_pnl_batch_state_store');
const {
  hashPnlBatchTransactionPolicy, verifyPnlBatchSignedTransaction
} = require('../bitvm3/utxo_referee/tradelayer_pnl_batch_transaction');
const { hashPnlSettlementSnapshot } = require('../bitvm3/utxo_referee/tradelayer_pnl_batch_settlement');
const { parseCanonicalUnsignedTransaction } = require('../bitvm3/utxo_referee/dlc_transaction_validator');
const { outpoint, serializeUnsignedTx, serializeWitnessTx } = require('../bitvm3/utxo_referee/tradelayer_taproot');
const {
  buildUtxoRefPnlBatchSettlementV2, verifyUtxoRefPnlBatchSettlementV2
} = require('../bitvm3/utxo_referee/utxoref_v2_pnl_batch');
const {
  signPnlBatchSettlementV2, broadcastPnlBatchSettlementV2, confirmPnlBatchSettlementV2
} = require('../bitvm3/utxo_referee/utxoref_v2_pnl_batch_execution');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const copy = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function sourceProvenance() {
  const repository = path.resolve(__dirname, '..');
  const fixture = path.resolve(repository, 'bitvm3/utxo_referee/artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json');
  const filenames = new Set([__filename, fixture]);
  const visited = new Set();
  const pending = [require.cache[__filename]];
  while (pending.length) {
    const loaded = pending.pop();
    if (!loaded || visited.has(loaded.filename)) continue;
    visited.add(loaded.filename);
    const relative = path.relative(repository, loaded.filename);
    if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) filenames.add(loaded.filename);
    pending.push(...loaded.children);
  }
  const files = [...filenames].map((filename) => ({
    path: path.relative(repository, filename).split(path.sep).join('/'),
    sha256: sha256(fs.readFileSync(filename))
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    kind: 'utxoref_pnl_batch_regtest_source_manifest_v1',
    coverage: 'Harness, its loaded repository CommonJS dependencies, and the synthetic snapshot fixture',
    aggregateEncoding: 'SHA256 of UTF-8 UTXOREF_PNL_BATCH_REGTEST_SOURCES_V1 followed by NUL and JSON.stringify(files)',
    sourceManifestSha256: sha256(`UTXOREF_PNL_BATCH_REGTEST_SOURCES_V1\0${JSON.stringify(files)}`),
    files
  };
}

function binaryPath() {
  const configured = process.env.BITCOIN_BIN;
  if (!configured) return process.platform === 'win32' ? 'bitcoind.exe' : 'bitcoind';
  if (fs.statSync(configured).isDirectory()) return path.join(configured, process.platform === 'win32' ? 'bitcoind.exe' : 'bitcoind');
  return path.resolve(configured);
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function makeRpc(port, cookiePath, wallet = null) {
  let serial = 0;
  return async function rpc(method, params = []) {
    const cookie = fs.readFileSync(cookiePath, 'utf8').trim();
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++serial, method, params });
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port, method: 'POST',
        path: wallet ? `/wallet/${encodeURIComponent(wallet)}` : '/',
        headers: { Authorization: `Basic ${Buffer.from(cookie).toString('base64')}`,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (part) => {
          text += part;
          if (text.length > 8 * 1024 * 1024) request.destroy(new Error('regtest RPC response exceeds bound'));
        });
        response.on('end', () => {
          try {
            const decoded = JSON.parse(text);
            if (decoded.error) {
              const error = new Error(`Core ${method}: ${decoded.error.message}`);
              Object.defineProperty(error, 'code', { value: decoded.error.code });
              reject(error);
            } else if (response.statusCode !== 200) reject(new Error(`Core ${method}: HTTP ${response.statusCode}`));
            else resolve(decoded.result);
          } catch (error) { reject(error); }
        });
      });
      request.on('timeout', () => request.destroy(new Error(`Core ${method}: RPC timeout`)));
      request.on('error', reject);
      request.end(body);
    });
  };
}

function sats(value) {
  const text = typeof value === 'number' ? value.toFixed(8) : String(value);
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error('unexpected Core coin amount');
  const [whole, fraction = ''] = text.split('.');
  return (BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, '0'))).toString();
}

async function rejected(action, label) {
  try {
    const result = await action();
    if (result && result.ok === false) return { rejected: true, reason: result.reason || result.code || label };
  } catch (error) { return { rejected: true, reason: error.message }; }
  throw new Error(`${label} was accepted`);
}

function newCheckpointKey() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  return { privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    trusted: { keyId: sha256(der), publicKeySpki: der.toString('base64') } };
}

function transactionPolicyFor(snapshot) {
  return { kind: 'tradelayer_pnl_batch_transaction_policy_v1', network: 'bitcoin-regtest', version: 2, locktime: 0,
    inputSequences: snapshot.vaults.flatMap((vault) => vault.utxos.map((input) => ({
      txid: input.txid, vout: input.vout, sequence: 0xfffffffd
    }))) };
}

async function checkpointSettlement(snapshot, trustPolicy, privateKeys, rpc) {
  const transactionPolicy = transactionPolicyFor(snapshot);
  const expectedTransactionPolicyHash = hashPnlBatchTransactionPolicy(transactionPolicy);
  const chain = await rpc('getblockchaininfo');
  const stateVerification = { trustPolicy,
    expectedPreviousStateRoot: snapshot.previousStateRoot, expectedEpochId: snapshot.epochId,
    currentHeight: chain.blocks, expectedSnapshotBlockHash: chain.bestblockhash };
  const stateEnvelope = buildSignedPnlBatchCheckpointV2({
    policyId: trustPolicy.policyId, chainGenesisHash: trustPolicy.chainGenesisHash,
    contractId: trustPolicy.contractId, snapshotHeight: chain.blocks,
    snapshotBlockHash: chain.bestblockhash, transactionPolicyHash: expectedTransactionPolicyHash, snapshot
  }, { privateKeys });
  const settlement = buildUtxoRefPnlBatchSettlementV2({
    stateEnvelope, stateVerification, transactionPolicy, expectedTransactionPolicyHash
  });
  const checked = verifyUtxoRefPnlBatchSettlementV2(settlement, {
    stateVerification, transactionPolicy, expectedTransactionPolicyHash
  });
  assert.equal(checked.ok, true, checked.reason);
  return { settlement, transactionPolicy, expectedTransactionPolicyHash, stateVerification };
}

function rawWithForeignOutput(unsignedTxHex, script) {
  const parsed = parseCanonicalUnsignedTransaction(unsignedTxHex);
  return serializeUnsignedTx(parsed.version,
    parsed.inputs.map((input) => ({ outpoint: outpoint(input.txid, input.vout), sequence: input.sequence })),
    parsed.outputs.map((output, index) => ({ valueSats: output.valueSats,
      script: index === 0 ? script : output.scriptPubKeyHex })), parsed.locktime);
}

function rawWithInvalidWitness(unsignedTxHex) {
  const parsed = parseCanonicalUnsignedTransaction(unsignedTxHex);
  return serializeWitnessTx(parsed.version,
    parsed.inputs.map((input) => ({ outpoint: outpoint(input.txid, input.vout), sequence: input.sequence, witness: ['00'] })),
    parsed.outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })), parsed.locktime);
}

async function runRegtest() {
  const executable = binaryPath();
  const versionRun = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (versionRun.error || versionRun.status !== 0) throw new Error(`bitcoind is unavailable: ${versionRun.error?.message || versionRun.stderr}`);
  const sources = sourceProvenance();
  const coreBinary = fs.existsSync(executable) ? {
    filename: path.basename(executable), bytes: fs.statSync(executable).size,
    sha256: sha256(fs.readFileSync(executable))
  } : null;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-pnl-batch-regtest-'));
  const datadir = path.join(scratch, 'node');
  fs.mkdirSync(datadir, { mode: 0o700 });
  const port = await unusedPort();
  const cookiePath = path.join(datadir, 'regtest', '.cookie');
  const nodeRpc = makeRpc(port, cookiePath);
  const child = spawn(executable, ['-regtest=1', '-server=1', `-datadir=${datadir}`,
    '-listen=0', '-connect=0', '-dnsseed=0', '-discover=0', '-listenonion=0',
    '-networkactive=0', '-txindex=1', '-fallbackfee=0.00001', `-rpcport=${port}`, '-rpcbind=127.0.0.1',
    '-rpcallowip=127.0.0.1', '-printtoconsole=0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let daemonLog = '';
  let exited = false;
  let spawnError = null;
  child.stdout.on('data', (data) => { daemonLog = (daemonLog + data).slice(-4000); });
  child.stderr.on('data', (data) => { daemonLog = (daemonLog + data).slice(-4000); });
  child.on('error', (error) => { spawnError = error; });
  child.on('exit', () => { exited = true; });
  let result;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError || exited) throw new Error(`private regtest daemon failed: ${spawnError?.message || daemonLog}`);
      try { await nodeRpc('getblockchaininfo'); ready = true; break; }
      catch { await sleep(100); }
    }
    if (!ready) throw new Error(`private regtest RPC did not become ready: ${daemonLog}`);
    const wallet = 'pnl-batch-regtest';
    await nodeRpc('createwallet', [wallet]);
    const rpc = makeRpc(port, cookiePath, wallet);
    const miningAddress = await rpc('getnewaddress', ['mining', 'bech32']);
    await rpc('generatetoaddress', [101, miningAddress]);
    const addresses = {};
    for (const label of ['fundingA', 'fundingB', 'residualA', 'residualB', 'depositor', 'foreign']) {
      addresses[label] = await rpc('getnewaddress', [label, 'bech32']);
    }
    const scripts = {};
    for (const [label, address] of Object.entries(addresses)) scripts[label] = (await rpc('getaddressinfo', [address])).scriptPubKey;
    const fundingTxid = await rpc('sendmany', ['', { [addresses.fundingA]: 0.0011, [addresses.fundingB]: 0.00105 }]);
    await rpc('generatetoaddress', [1, miningAddress]);
    const funding = await rpc('getrawtransaction', [fundingTxid, true]);
    const fundingOutput = (name, expectedSats) => {
      const output = funding.vout.find((row) => row.scriptPubKey.hex === scripts[name]);
      assert(output, `missing ${name} funding output`);
      assert.equal(sats(output.value), expectedSats);
      return { txid: fundingTxid, vout: output.n, sats: expectedSats, scriptPubKey: output.scriptPubKey.hex };
    };
    const snapshot = copy(require('../bitvm3/utxo_referee/artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json'));
    snapshot.vaults[0].utxos = [fundingOutput('fundingA', '110000')];
    snapshot.vaults[1].utxos = [fundingOutput('fundingB', '105000')];
    snapshot.vaults[0].changeScriptPubKey = scripts.residualA;
    snapshot.vaults[1].changeScriptPubKey = scripts.residualB;
    snapshot.accounts[1].payoutScriptPubKey = scripts.depositor;
    snapshot.obligations[0].id = 'regtest-close-A-B';
    const ledger = ledgerFromSnapshot(snapshot, { previousEpochId: '0' });
    snapshot.previousStateRoot = hashLedgerState(ledger);
    const keys = [newCheckpointKey(), newCheckpointKey()];
    const trustPolicy = { kind: TRUST_POLICY_KIND, version: 1, policyId: 'regtest-pnl-2-of-2',
      network: 'bitcoin-regtest', chainGenesisHash: await rpc('getblockhash', [0]),
      contractId: sha256('UTXORef isolated PnL batch regtest book v1'), threshold: 2,
      maxAgeBlocks: 6, trustedSigners: keys.map((key) => key.trusted) };
    const privateKeys = keys.map((key) => key.privateKeyPem);
    const built = await checkpointSettlement(snapshot, trustPolicy, privateKeys, rpc);
    const { settlement, transactionPolicy, expectedTransactionPolicyHash } = built;
    const storeDirectory = path.join(scratch, 'journal');
    let store = new PnlBatchStateStore(storeDirectory, trustPolicy.contractId);
    const initial = store.initialize(ledger, { expectedHeadHash: null });
    const executionPolicy = { minFundingConfirmations: 1, minSettlementConfirmations: 1,
      maxFeeSats: '10000', maxFeeRateSatsPerVbyte: 100 };
    let signerCalls = 0;
    const signer = async ({ unsignedTxHex }) => {
      signerCalls++;
      const signed = await rpc('signrawtransactionwithwallet', [unsignedTxHex]);
      assert.equal(signed.complete, true, 'wallet failed to sign every input');
      return signed.hex;
    };
    const common = { settlement, trustPolicy, transactionPolicy, expectedTransactionPolicyHash,
      executionPolicy, store, expectedHeadHash: initial.headHash, rpc };

    const foreign = copy(settlement);
    foreign.transaction.unsignedTxHex = rawWithForeignOutput(settlement.transaction.unsignedTxHex, scripts.foreign);
    const foreignRejected = await rejected(() => signPnlBatchSettlementV2({ ...common, settlement: foreign, signer }), 'foreign payout');
    assert.equal(signerCalls, 0, 'foreign payout reached the signer');
    assert.equal(store.read().headHash, initial.headHash, 'foreign payout changed the journal');

    const invalidWitnessHex = rawWithInvalidWitness(settlement.transaction.unsignedTxHex);
    const byteCheck = verifyPnlBatchSignedTransaction(invalidWitnessHex, {
      batch: settlement.batch, settlementContext: { snapshot, expectedSnapshotHash: hashPnlSettlementSnapshot(snapshot) },
      transactionPolicy, expectedTransactionPolicyHash
    });
    assert.equal(byteCheck.ok, true, byteCheck.reason);
    assert.equal(byteCheck.executionVerified, false);
    const invalidPolicy = await rpc('testmempoolaccept', [[invalidWitnessHex]]);
    assert.equal(invalidPolicy[0].allowed, false, 'Core accepted the deliberately invalid witness');

    const signed = await signPnlBatchSettlementV2({ ...common, signer });
    assert.equal(signerCalls, 1);
    const signedState = store.read({ expectedHeadHash: signed.headHash });
    assert.equal(signedState.pending.status, 'SIGNED');
    assert.equal(signedState.ledger.epochId, '0', 'signing advanced the ledger before settlement');
    const pendingReplay = await rejected(() => signPnlBatchSettlementV2({ ...common, expectedHeadHash: signed.headHash, signer }), 'pending replay');
    assert.equal(signerCalls, 1);
    // Reload the append-only journal before broadcast to exercise recovery.
    store = new PnlBatchStateStore(storeDirectory, trustPolicy.contractId);
    assert.equal(store.read({ expectedHeadHash: signed.headHash }).pending.signedTxHex, signed.signedTxHex);
    const broadcast = await broadcastPnlBatchSettlementV2({ ...common, store, expectedHeadHash: signed.headHash });
    assert.equal(broadcast.txid, signed.txid);
    const mined = await rpc('generatetoaddress', [1, miningAddress]);
    const confirmationBlockHash = mined[0];
    const confirmed = await confirmPnlBatchSettlementV2({ ...common, store, expectedHeadHash: broadcast.headHash });
    const finalState = store.read({ expectedHeadHash: confirmed.headHash });
    assert.equal(finalState.pending, null);
    assert.equal(finalState.ledger.epochId, '1');
    assert.equal(finalState.ledger.accounts.find((row) => row.id === 'trader-A').equitySats, '90000');
    assert.equal(finalState.ledger.accounts.find((row) => row.id === 'trader-B').equitySats, '106000');
    const observedOutputs = [];
    for (const vault of finalState.ledger.vaults) {
      assert.equal(vault.utxos.length, 1);
      assert.equal(vault.utxos[0].txid, signed.txid);
      const observed = await rpc('gettxout', [signed.txid, vault.utxos[0].vout, true]);
      assert(observed && observed.confirmations >= 1, `vault ${vault.id} residual lacks confirmation`);
      assert.equal(sats(observed.value), vault.utxos[0].sats);
      assert.equal(observed.scriptPubKey.hex, vault.utxos[0].scriptPubKey);
      observedOutputs.push({ vaultId: vault.id, txid: signed.txid, vout: vault.utxos[0].vout,
        sats: vault.utxos[0].sats, confirmations: observed.confirmations });
    }
    assert.deepEqual(observedOutputs.map((row) => row.sats), ['99500', '110500']);
    const actual = await rpc('getrawtransaction', [signed.txid, true]);
    const paid = actual.vout.find((output) => output.scriptPubKey.hex === scripts.depositor);
    assert(paid);
    assert.equal(sats(paid.value), '4000');
    const confirmedReplay = await rejected(() => signPnlBatchSettlementV2({ ...common, store, expectedHeadHash: confirmed.headHash, signer }), 'confirmed replay');
    assert.equal(signerCalls, 1);
    store = new PnlBatchStateStore(storeDirectory, trustPolicy.contractId);
    const restarted = store.read({ expectedHeadHash: confirmed.headHash });
    assert.equal(restarted.ledgerHash, finalState.ledgerHash);
    assert.equal(restarted.signingTombstones.length, 1);

    await rpc('invalidateblock', [confirmationBlockHash]);
    const nextSnapshot = { kind: snapshot.kind, network: snapshot.network, epochId: '2',
      previousStateRoot: restarted.ledgerHash, nettingSets: restarted.ledger.nettingSets,
      vaults: restarted.ledger.vaults.map((vault) => ({ ...vault, feeSats: '500' })),
      accounts: restarted.ledger.accounts.map((account) => ({ ...account, payoutSats: '0' })),
      obligations: [], consumedObligationIds: restarted.ledger.consumedObligationIds,
      spentOutpoints: restarted.ledger.spentOutpoints, routes: restarted.ledger.routes };
    const afterReorg = await checkpointSettlement(nextSnapshot, trustPolicy, privateKeys, rpc);
    const reorgRejected = await rejected(() => signPnlBatchSettlementV2({
      settlement: afterReorg.settlement, trustPolicy, transactionPolicy: afterReorg.transactionPolicy,
      expectedTransactionPolicyHash: afterReorg.expectedTransactionPolicyHash, executionPolicy,
      store, expectedHeadHash: confirmed.headHash, rpc, signer
    }), 'reorged prior confirmation');
    assert.equal(signerCalls, 1, 'reorged history reached the signer');
    const frozen = store.read();
    assert(frozen.frozen, 'reorg detection did not freeze the book');

    const network = await rpc('getnetworkinfo');
    assert.equal(await rpc('getconnectioncount'), 0);
    assert.deepEqual(sourceProvenance(), sources, 'source files changed during the regtest exercise');
    result = {
      kind: 'utxoref_pnl_batch_isolated_regtest_receipt_v1', ok: true,
      network: 'regtest', coreVersion: versionRun.stdout.split('\n')[0], coreSubversion: network.subversion,
      provenance: { nodeVersion: process.version, platform: process.platform, architecture: process.arch, coreBinary, sources },
      custodyProfile: 'One disposable wallet controls native P2WPKH reserve inputs; both Ed25519 checkpoint keys are local test keys',
      proofSystem: 'none', zkProofVerified: false, peerConnections: 0,
      signerQuorum: { threshold: trustPolicy.threshold, distinctKeyIds: trustPolicy.trustedSigners.map((key) => key.keyId) },
      snapshotHash: hashPnlSettlementSnapshot(snapshot), checkpointHash: settlement.stateEnvelope.bodyHash,
      transactionPolicyHash: expectedTransactionPolicyHash,
      funding: { txid: fundingTxid, totalSats: '215000', inputs: snapshot.vaults.flatMap((vault) => vault.utxos) },
      foreignOutput: { ...foreignRejected, signerCalls: 0 },
      invalidWitness: { transactionBytesVerified: byteCheck.transactionBytesVerified,
        executionVerified: false, coreAllowed: invalidPolicy[0].allowed,
        rejectReason: invalidPolicy[0]['reject-reason'] || invalidPolicy[0]['package-error'] || null },
      settlement: { txid: signed.txid, wtxid: signed.wtxid, confirmationBlockHash,
        feeSats: '1000', payoutSats: '4000', retainedProfitSats: '6000', residuals: observedOutputs,
        initialHeadHash: initial.headHash, signedHeadHash: signed.headHash,
        confirmedHeadHash: confirmed.headHash, confirmedLedgerHash: finalState.ledgerHash,
        accountEquities: finalState.ledger.accounts.map((account) => ({ accountId: account.id, equitySats: account.equitySats })) },
      replay: { whilePending: pendingReplay, afterConfirmation: confirmedReplay, totalSignerCalls: signerCalls },
      persistence: { reopenedBeforeBroadcast: true, reopenedAfterConfirmation: true, signingTombstoneCount: restarted.signingTombstones.length },
      reorg: { invalidatedBlockHash: confirmationBlockHash, ...reorgRejected,
        frozen: Boolean(frozen.frozen), reason: frozen.frozen.reason, frozenHeadHash: frozen.headHash },
      scope: 'Observed local wallet signing, Core script policy, broadcast, mining and guarded journal transitions; no independent custody or public-chain execution' };
  } finally {
    if (!exited && !spawnError) {
      try { await nodeRpc('stop'); } catch { /* Kill only the child created above if RPC is unavailable. */ }
      for (let attempt = 0; attempt < 50 && !exited; attempt++) await sleep(100);
      if (!exited) child.kill('SIGTERM');
      for (let attempt = 0; attempt < 30 && !exited; attempt++) await sleep(100);
      if (!exited) child.kill('SIGKILL');
      for (let attempt = 0; attempt < 20 && !exited; attempt++) await sleep(100);
    }
    if (!exited && !spawnError) throw new Error('could not stop the private regtest child; datadir retained');
    fs.rmSync(scratch, { recursive: true, force: true });
    if (result) result.cleanup = { ownDaemonStopped: true, ownDatadirRemoved: !fs.existsSync(scratch) };
  }
  return result;
}

function parseArgs(argv) {
  if (argv.length === 0) return null;
  if (argv.length === 2 && argv[0] === '--out' && argv[1]) return path.resolve(argv[1]);
  throw new Error('Usage: node eval/pnl_batch_regtest.js [--out /explicit/receipt.json]');
}

if (require.main === module) {
  (async () => {
    const output = parseArgs(process.argv.slice(2));
    const result = await runRegtest();
    const encoded = `${JSON.stringify(result, null, 2)}\n`;
    if (output) fs.writeFileSync(output, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    process.stdout.write(encoded);
  })().catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}

module.exports = { runRegtest };
