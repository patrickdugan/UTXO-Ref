#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { monitorChallenge, saveJsonAtomic } = require('./utxoref_v2_watchtower');
const { findAddressOutput } = require('./utxoref_v2_reorg_drill');
const {
  defaultChallengeSurvivalScenarios,
  runChallengeSurvivalScenario
} = require('./utxoref_v2_challenge_survival');

const DEFAULT_BITCOIND = 'C:\\projects\\BitcoinConsensusObservatory\\jurassic-bitcoin\\tools\\bitcoin-core-30.2\\bitcoin-30.2\\bin\\bitcoind.exe';
const DEFAULT_RECEIPT = path.join(__dirname, 'artifacts', 'tmp', 'utxoref_v2_two_node_survival_latest.json');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--keep-datadirs') { args.keepDatadirs = true; continue; }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    args[key] = value;
  }
  return args;
}

function usage() {
  return [
    'Run an isolated two-node Bitcoin Core regtest challenge-survival drill.',
    '',
    '  node utxoref_v2_two_node_survival_drill.js \\',
    '    --bitcoind <path-to-bitcoind.exe> --receipt <receipt.json>',
    '',
    'The drill starts temporary regtest nodes, never uses an existing datadir, and',
    'stops both nodes in a finally block. Use --keep-datadirs only for debugging.'
  ].join('\n');
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(fn, description, timeoutMs = 30000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) { lastError = err; }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function startNode(bitcoind, dataDir, ports, auth, label) {
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(bitcoind, [
    '-regtest=1',
    `-datadir=${dataDir}`,
    '-server=1',
    '-listen=1',
    '-discover=0',
    '-dnsseed=0',
    '-natpmp=0',
    '-fallbackfee=0.0002',
    '-txindex=1',
    '-printtoconsole=0',
    `-rpcbind=127.0.0.1:${ports.rpc}`,
    '-rpcallowip=127.0.0.1',
    `-rpcport=${ports.rpc}`,
    `-port=${ports.p2p}`,
    `-rpcuser=${auth.user}`,
    `-rpcpassword=${auth.pass}`
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  const capture = (chunk) => {
    child.output = (child.output + chunk.toString('utf8')).slice(-8192);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (err) => { child.startError = err; });
  return {
    label,
    child,
    dataDir,
    ports,
    rpc: rpcFactory({
      rpcUrl: `http://127.0.0.1:${ports.rpc}`,
      rpcUser: auth.user,
      rpcPass: auth.pass,
      requestId: `utxoref-survival-${label}`
    })
  };
}

async function stopNode(node) {
  if (!node) return;
  if (node.child.exitCode !== null) return;
  try { await node.rpc('stop'); } catch (_err) { /* Process may already be down. */ }
  const exited = await Promise.race([
    new Promise((resolve) => node.child.once('exit', () => resolve(true))),
    sleep(5000).then(() => false)
  ]);
  if (!exited && node.child.exitCode === null) node.child.kill();
}

async function ensureWallet(rpc, wallet) {
  try { await rpc('getwalletinfo', [], wallet); return; } catch (_err) { /* Create it below. */ }
  await rpc('createwallet', [wallet, false, false, '', false, true]);
}

async function waitForHeight(node, height) {
  return waitFor(async () => Number((await node.rpc('getblockchaininfo')).blocks) >= height, `${node.label} height ${height}`);
}

async function disconnect(node, address) {
  try { await node.rpc('disconnectnode', [address]); } catch (_err) { /* Already disconnected. */ }
}

async function mempoolHas(node, txid) {
  try { await node.rpc('getmempoolentry', [txid]); return true; } catch (_err) { return false; }
}

async function runTwoNodeDrill(args = {}) {
  const bitcoind = path.resolve(args.bitcoind || process.env.BITCOIND || DEFAULT_BITCOIND);
  if (!fs.existsSync(bitcoind)) throw new Error(`bitcoind does not exist: ${bitcoind}`);
  const portsA = {
    rpc: Number(args.nodeARpcPort || 18443),
    p2p: Number(args.nodeAP2pPort || 18444)
  };
  const portsB = {
    rpc: Number(args.nodeBRpcPort || 18453),
    p2p: Number(args.nodeBP2pPort || 18454)
  };
  for (const [label, port] of Object.entries({ ...portsA, ...Object.fromEntries(Object.entries(portsB).map(([key, value]) => [`b-${key}`, value])) })) {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error(`${label} port is invalid`);
  }
  const autoRoot = !args.datadirRoot;
  const root = autoRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-two-node-'))
    : path.resolve(args.datadirRoot);
  const auth = { user: `utxoref-${process.pid}`, pass: `survival-${Date.now()}-${process.pid}` };
  let nodeA;
  let nodeB;
  try {
    nodeA = startNode(bitcoind, path.join(root, 'node-a'), portsA, auth, 'node-a');
    nodeB = startNode(bitcoind, path.join(root, 'node-b'), portsB, auth, 'node-b');
    await waitFor(async () => {
      if (nodeA.child.startError) throw nodeA.child.startError;
      if (nodeA.child.exitCode !== null) throw new Error(`node-a exited ${nodeA.child.exitCode}: ${nodeA.child.output}`);
      return nodeA.rpc('getblockchaininfo');
    }, 'node-a RPC', 60000);
    await waitFor(async () => {
      if (nodeB.child.startError) throw nodeB.child.startError;
      if (nodeB.child.exitCode !== null) throw new Error(`node-b exited ${nodeB.child.exitCode}: ${nodeB.child.output}`);
      return nodeB.rpc('getblockchaininfo');
    }, 'node-b RPC', 60000);
    for (const node of [nodeA, nodeB]) {
      const chain = await node.rpc('getblockchaininfo');
      if (chain.chain !== 'regtest') throw new Error(`${node.label} started on ${chain.chain}`);
    }

    const addressA = `127.0.0.1:${nodeA.ports.p2p}`;
    const addressB = `127.0.0.1:${nodeB.ports.p2p}`;
    await nodeA.rpc('addnode', [addressB, 'onetry']);
    await waitFor(async () => Number(await nodeA.rpc('getconnectioncount')) > 0, 'initial peer connection');

    const wallet = 'utxoref-survival-a';
    await ensureWallet(nodeA.rpc, wallet);
    const miningAddress = await nodeA.rpc('getnewaddress', ['survival-mining', 'bech32'], wallet);
    await nodeA.rpc('generatetoaddress', [1, miningAddress]);
    await nodeA.rpc('generatetodescriptor', [100, 'raw(51)']);
    await waitForHeight(nodeB, 101);

    await disconnect(nodeA, addressB);
    await disconnect(nodeB, addressA);
    await waitFor(async () => Number(await nodeA.rpc('getconnectioncount')) === 0, 'mempool partition');

    const challengeAddress = await nodeA.rpc('getnewaddress', ['survival-challenge', 'bech32'], wallet);
    const txid = await nodeA.rpc('sendtoaddress', [challengeAddress, 0.0001, 'UTXORef two-node survival'], wallet);
    const rawTransaction = await nodeA.rpc('getrawtransaction', [txid, false]);
    const decoded = await nodeA.rpc('getrawtransaction', [txid, true]);
    const output = findAddressOutput(decoded, challengeAddress);
    const nodeAMempoolOnly = await mempoolHas(nodeA, txid) && !(await mempoolHas(nodeB, txid));
    if (!nodeAMempoolOnly) throw new Error('failed to establish divergent node mempools');

    const state = {
      challenge: {
        graphHash: '00'.repeat(32),
        txid,
        vout: output.vout,
        outputSats: output.amountSats,
        challengeScriptPubKeyHex: output.scriptPubKeyHex,
        confirmation: null,
        confirmationHistory: [],
        reorgPending: false
      }
    };
    let height = Number((await nodeA.rpc('getblockchaininfo')).blocks);
    const partitioned = await monitorChallenge(nodeA.rpc, state, height);
    if (partitioned.action !== 'challenge_in_mempool') throw new Error(`unexpected partitioned action ${partitioned.action}`);

    await nodeB.rpc('addnode', [addressA, 'onetry']);
    const rebroadcastTxid = await nodeB.rpc('sendrawtransaction', [rawTransaction]);
    if (rebroadcastTxid !== txid) throw new Error('node-b parent rebroadcast txid mismatch');
    await waitFor(() => mempoolHas(nodeB, txid), 'challenge relay to node-b');
    const convergedMempools = await mempoolHas(nodeA, txid) && await mempoolHas(nodeB, txid);

    const [confirmationBlockHash] = await nodeA.rpc('generatetoaddress', [1, miningAddress]);
    height += 1;
    await waitForHeight(nodeB, height);
    const confirmed = await monitorChallenge(nodeA.rpc, state, height);
    if (confirmed.action !== 'challenge_confirmed') throw new Error(`unexpected confirmed action ${confirmed.action}`);

    await nodeA.rpc('invalidateblock', [confirmationBlockHash]);
    height -= 1;
    const reorged = await monitorChallenge(nodeA.rpc, state, height);
    if (reorged.action !== 'challenge_in_mempool' || !reorged.reorgDetected) {
      throw new Error(`unexpected reorg action ${reorged.action}`);
    }

    await nodeA.rpc('reconsiderblock', [confirmationBlockHash]);
    await waitForHeight(nodeA, height + 1);
    height += 1;
    const reconfirmed = await monitorChallenge(nodeA.rpc, state, height);
    if (reconfirmed.action !== 'challenge_reconfirmed') throw new Error(`unexpected reconfirmed action ${reconfirmed.action}`);

    const deterministic = defaultChallengeSurvivalScenarios().map(runChallengeSurvivalScenario);
    const receipt = {
      kind: 'utxoref_v2_two_node_survival_drill_receipt',
      version: 1,
      observedAt: new Date().toISOString(),
      bitcoinCore: path.basename(bitcoind),
      chain: 'regtest',
      txid,
      vout: output.vout,
      amountSats: output.amountSats,
      nodeAMempoolOnly,
      convergedMempools,
      convergenceMethod: 'exact-parent-rebroadcast',
      confirmationBlockHash,
      actions: [partitioned.action, confirmed.action, reorged.action, reconfirmed.action],
      reorgDetected: reorged.reorgDetected,
      finalConfirmation: state.challenge.confirmation,
      deterministicScenarios: deterministic.map((result) => ({
        name: result.name,
        survived: result.survived,
        finalStatus: result.state.status,
        errors: result.errors.map((entry) => entry.message),
        receiptVerification: result.receiptVerification
      }))
    };
    saveJsonAtomic(path.resolve(args.receipt || DEFAULT_RECEIPT), receipt);
    return receipt;
  } finally {
    await stopNode(nodeA);
    await stopNode(nodeB);
    if (autoRoot && !args.keepDatadirs) {
      const resolvedRoot = path.resolve(root);
      const tempRoot = path.resolve(os.tmpdir()) + path.sep;
      if (!resolvedRoot.startsWith(tempRoot)) throw new Error(`refusing to remove non-temporary datadir ${resolvedRoot}`);
      fs.rmSync(resolvedRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const receipt = await runTwoNodeDrill(args);
  console.log(JSON.stringify(receipt, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef V2 two-node survival drill failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  waitFor,
  startNode,
  stopNode,
  runTwoNodeDrill
};
