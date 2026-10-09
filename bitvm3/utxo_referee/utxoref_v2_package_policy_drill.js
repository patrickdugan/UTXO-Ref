#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startNode, stopNode, waitFor } = require('./utxoref_v2_two_node_survival_drill');
const { addressToScriptPubKey } = require('./tradelayer_pnl_route_adapter');
const tr = require('./tradelayer_taproot');
const a = require('./tradelayer_dlc_adaptor_sig');
const {
  buildTaprootReserveVaultTemplate,
  coinValueToSats
} = require('./taproot_reserve_vault');
const {
  buildUtxorefV2FeeReserve,
  buildUtxorefV2FeeReserveRegistryFromRpc
} = require('./utxoref_v2_fee_reserve');
const { saveJsonAtomic } = require('./utxoref_v2_watchtower');

const DEFAULT_BITCOIND = 'C:\\projects\\BitcoinConsensusObservatory\\jurassic-bitcoin\\tools\\bitcoin-core-30.2\\bitcoin-30.2\\bin\\bitcoind.exe';
const DEFAULT_RECEIPT = path.join(__dirname, 'artifacts', 'tmp', 'utxoref_v2_package_policy_latest.json');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--keep-datadir') { args.keepDatadir = true; continue; }
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
    'Exercise real Bitcoin Core replacement economics and a graph-bound fee reserve.',
    '',
    '  node utxoref_v2_package_policy_drill.js --bitcoind <path-to-bitcoind.exe>',
    '',
    'The drill uses one isolated temporary regtest node with full-RBF enabled.'
  ].join('\n');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function p2wshOpTrueScript() {
  return `0020${sha256Hex(Buffer.from('51', 'hex'))}`;
}

async function ensureWallet(rpc, wallet) {
  try { await rpc('getwalletinfo', [], wallet); } catch (_err) {
    await rpc('createwallet', [wallet, false, false, '', false, true]);
  }
}

async function signWalletTransaction(rpc, wallet, unsignedTxHex) {
  const signed = await rpc('signrawtransactionwithwallet', [unsignedTxHex], wallet);
  if (!signed.complete) throw new Error(`wallet failed to sign transaction: ${JSON.stringify(signed.errors || [])}`);
  return signed.hex;
}

async function buildParent(rpc, wallet, utxo, anchorScript, anchorAmountSats, feeSats, changeScript) {
  const inputSats = coinValueToSats(utxo.amount, 'utxo.amount');
  const changeSats = inputSats - BigInt(anchorAmountSats) - BigInt(feeSats);
  if (changeSats <= 0n) throw new Error('parent input cannot cover anchor and fee');
  const unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(utxo.txid, utxo.vout),
    sequence: 0xfffffffd
  }], [
    { valueSats: BigInt(anchorAmountSats), script: anchorScript },
    { valueSats: changeSats, script: changeScript }
  ], 0);
  const hex = await signWalletTransaction(rpc, wallet, unsignedTxHex);
  const decoded = await rpc('decoderawtransaction', [hex]);
  return { hex, txid: decoded.txid, feeSats: Number(feeSats), anchorAmountSats: Number(anchorAmountSats) };
}

function buildAnyoneCanSpendChild(parentTxid, amountSats, feeSats, destinationScript) {
  const outputSats = BigInt(amountSats) - BigInt(feeSats);
  if (outputSats < 330n) throw new Error('pin child output would be dust');
  return tr.serializeWitnessTx(2, [{
    outpoint: tr.outpoint(parentTxid, 0),
    sequence: 0xfffffffd,
    witness: ['51']
  }], [{ valueSats: outputSats, script: destinationScript }], 0);
}

async function broadcastOrError(rpc, rawTx) {
  try { return { accepted: true, txid: await rpc('sendrawtransaction', [rawTx]), error: null }; }
  catch (err) { return { accepted: false, txid: null, error: err.message }; }
}

async function runPackagePolicyDrill(args = {}) {
  const bitcoind = path.resolve(args.bitcoind || process.env.BITCOIND || DEFAULT_BITCOIND);
  if (!fs.existsSync(bitcoind)) throw new Error(`bitcoind does not exist: ${bitcoind}`);
  const rpcPort = Number(args.rpcPort || 18463);
  const p2pPort = Number(args.p2pPort || 18464);
  if (![rpcPort, p2pPort].every((port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535) || rpcPort === p2pPort) {
    throw new Error('RPC and P2P ports must be distinct integers in 1024..65535');
  }
  const autoRoot = !args.datadirRoot;
  const root = autoRoot ? fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-package-policy-')) : path.resolve(args.datadirRoot);
  const auth = { user: `package-${process.pid}`, pass: `policy-${Date.now()}-${process.pid}` };
  let node;
  try {
    node = startNode(bitcoind, path.join(root, 'node'), { rpc: rpcPort, p2p: p2pPort }, auth, 'package-policy');
    await waitFor(async () => {
      if (node.child.startError) throw node.child.startError;
      if (node.child.exitCode !== null) throw new Error(`bitcoind exited ${node.child.exitCode}: ${node.child.output}`);
      return node.rpc('getblockchaininfo');
    }, 'package-policy RPC', 60000);
    const wallet = 'utxoref-package-policy';
    await ensureWallet(node.rpc, wallet);
    const miningAddress = await node.rpc('getnewaddress', ['mining', 'bech32'], wallet);
    await node.rpc('generatetoaddress', [1, miningAddress]);
    await node.rpc('generatetodescriptor', [100, 'raw(51)']);

    const splitAddresses = [];
    const splitAmounts = {};
    for (let index = 0; index < 3; index++) {
      const address = await node.rpc('getnewaddress', [`split-${index}`, 'bech32'], wallet);
      splitAddresses.push(address);
      splitAmounts[address] = 1;
    }
    await node.rpc('sendmany', ['', splitAmounts], wallet);
    await node.rpc('generatetoaddress', [1, miningAddress]);
    const utxos = await node.rpc('listunspent', [1, 9999999, splitAddresses], wallet);
    if (utxos.length !== 3) throw new Error(`expected three split UTXOs, got ${utxos.length}`);

    const destinationAddress = await node.rpc('getnewaddress', ['pin-destination', 'bech32'], wallet);
    const destinationScript = addressToScriptPubKey(destinationAddress, 'bitcoin-regtest').toString('hex');
    const changeAddress = await node.rpc('getrawchangeaddress', ['bech32'], wallet);
    const changeScript = addressToScriptPubKey(changeAddress, 'bitcoin-regtest').toString('hex');
    const publicAnchorScript = p2wshOpTrueScript();
    const anchorAmountSats = 12000;

    const baselineParent = await buildParent(node.rpc, wallet, utxos[0], publicAnchorScript, anchorAmountSats, 1000, changeScript);
    await node.rpc('sendrawtransaction', [baselineParent.hex]);
    const baselineReplacement = await buildParent(node.rpc, wallet, utxos[0], publicAnchorScript, anchorAmountSats, 2500, changeScript);
    const baselineResult = await broadcastOrError(node.rpc, baselineReplacement.hex);
    if (!baselineResult.accepted) throw new Error(`unpinned replacement was rejected: ${baselineResult.error}`);

    const pinnedParent = await buildParent(node.rpc, wallet, utxos[1], publicAnchorScript, anchorAmountSats, 1000, changeScript);
    await node.rpc('sendrawtransaction', [pinnedParent.hex]);
    const pinChildHex = buildAnyoneCanSpendChild(pinnedParent.txid, anchorAmountSats, 11000, destinationScript);
    const pinChildTxid = await node.rpc('sendrawtransaction', [pinChildHex]);
    const pinnedModerate = await buildParent(node.rpc, wallet, utxos[1], publicAnchorScript, anchorAmountSats, 2500, changeScript);
    const pinnedModerateResult = await broadcastOrError(node.rpc, pinnedModerate.hex);
    if (pinnedModerateResult.accepted) throw new Error('economically pinned moderate replacement unexpectedly succeeded');
    const pinnedRescue = await buildParent(node.rpc, wallet, utxos[1], publicAnchorScript, anchorAmountSats, 15000, changeScript);
    const pinnedRescueResult = await broadcastOrError(node.rpc, pinnedRescue.hex);
    if (!pinnedRescueResult.accepted) throw new Error(`high-fee package replacement was rejected: ${pinnedRescueResult.error}`);

    const graphHash = sha256Hex('UTXORef V2 package-policy graph binding v1');
    const challengerXonly = a.xOnlyPubkey(11n).toString('hex');
    const guardianXonly = a.xOnlyPubkey(12n).toString('hex');
    const refundXonly = a.xOnlyPubkey(13n).toString('hex');
    const safeTemplate = buildTaprootReserveVaultTemplate({
      network: 'bitcoin-regtest',
      operatorXonly: challengerXonly,
      guardianXonly,
      recoveryXonly: refundXonly,
      recoveryCsvDelay: 144,
      bindingHash: graphHash
    });
    const safeParent = await buildParent(
      node.rpc, wallet, utxos[2], safeTemplate.p2trScriptPubKey, anchorAmountSats, 1000, changeScript
    );
    await node.rpc('sendrawtransaction', [safeParent.hex]);
    const unauthorizedSpend = tr.serializeUnsignedTx(2, [{
      outpoint: tr.outpoint(safeParent.txid, 0),
      sequence: 0xfffffffd
    }], [{ valueSats: 11000n, script: destinationScript }], 0);
    const [unauthorizedResult] = await node.rpc('testmempoolaccept', [[unauthorizedSpend]]);
    if (unauthorizedResult.allowed) throw new Error('graph-bound reserve accepted an empty-witness spend');

    const [confirmationBlockHash] = await node.rpc('generatetoaddress', [1, miningAddress]);
    const fundingHeight = Number(await node.rpc('getblockcount'));
    const feeReserve = buildUtxorefV2FeeReserve({
      network: 'bitcoin-regtest',
      graphHash,
      disputeId: 'package-policy-drill',
      fundingOutpoint: { txid: safeParent.txid, vout: 0 },
      fundingHeight,
      amountSats: anchorAmountSats,
      maxFeeSats: 10000,
      challengeWindowBlocks: 18,
      confirmationTarget: 2,
      recoverySafetyBlocks: 6,
      recoveryCsvDelay: 144,
      challengerXonly,
      guardianXonly,
      refundXonly,
      p2trScriptPubKey: safeTemplate.p2trScriptPubKey
    });
    const registry = await buildUtxorefV2FeeReserveRegistryFromRpc({ rpc: node.rpc, reserves: [feeReserve] });
    if (registry.core.countedReserveCount !== 1) throw new Error('live graph-bound fee reserve was not counted');

    const receipt = {
      kind: 'utxoref_v2_package_policy_drill_receipt',
      version: 1,
      observedAt: new Date().toISOString(),
      bitcoinCore: path.basename(bitcoind),
      chain: 'regtest',
      replacementPolicy: 'bitcoin-core-30-default',
      baseline: {
        parentTxid: baselineParent.txid,
        replacementTxid: baselineResult.txid,
        initialFeeSats: baselineParent.feeSats,
        replacementFeeSats: baselineReplacement.feeSats,
        accepted: baselineResult.accepted
      },
      economicPin: {
        parentTxid: pinnedParent.txid,
        childTxid: pinChildTxid,
        parentFeeSats: pinnedParent.feeSats,
        childFeeSats: 11000,
        moderateReplacementFeeSats: pinnedModerate.feeSats,
        moderateAccepted: pinnedModerateResult.accepted,
        moderateRejectReason: pinnedModerateResult.error,
        rescueReplacementFeeSats: pinnedRescue.feeSats,
        rescueAccepted: pinnedRescueResult.accepted,
        rescueTxid: pinnedRescueResult.txid,
        feeAmplification: 12
      },
      graphBoundReserve: {
        graphHash,
        outpoint: `${safeParent.txid}:0`,
        reserveHash: feeReserve.reserveHash,
        scriptPubKey: safeTemplate.p2trScriptPubKey,
        unauthorizedSpendAllowed: unauthorizedResult.allowed,
        unauthorizedRejectReason: unauthorizedResult['reject-reason'] || null,
        registryHash: registry.registryHash,
        countedReserveCount: registry.core.countedReserveCount
      },
      confirmationBlockHash
    };
    saveJsonAtomic(path.resolve(args.receipt || DEFAULT_RECEIPT), receipt);
    return receipt;
  } finally {
    await stopNode(node);
    if (autoRoot && !args.keepDatadir) {
      const resolvedRoot = path.resolve(root);
      const tempRoot = path.resolve(os.tmpdir()) + path.sep;
      if (!resolvedRoot.startsWith(tempRoot)) throw new Error(`refusing to remove non-temporary datadir ${resolvedRoot}`);
      fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  console.log(JSON.stringify(await runPackagePolicyDrill(args), null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef V2 package-policy drill failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  p2wshOpTrueScript,
  buildAnyoneCanSpendChild,
  runPackagePolicyDrill
};
