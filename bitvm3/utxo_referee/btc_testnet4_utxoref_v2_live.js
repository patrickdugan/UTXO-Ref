#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { readJsonStrictProfile } = require('./strict_artifact_profiles');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { addressToScriptPubKey } = require('./tradelayer_pnl_route_adapter');
const { coinValueToSats } = require('./taproot_reserve_vault');
const a = require('./tradelayer_dlc_adaptor_sig');
const tr = require('./tradelayer_taproot');
const {
  buildSignedStateCheckpointV2,
  publicKeyId
} = require('./utxoref_v2');
const {
  buildWireSecretSetV2,
  buildPublicTraceV2
} = require('./bitvm_trace_v2');
const {
  buildSettlementTraceBindingV2,
  buildBitvmAssertionTemplateV2,
  finalizeBitvmAssertionGraphV2,
  verifyBitvmAssertionGraphV2,
  containsPrivateMaterial
} = require('./bitvm_assertion_graph_v2');
const { txidFromUnsignedHex } = require('./recover_btc_testnet4_reserve_vault');

const DEFAULT_DATADIR = 'D:\\BitcoinTestnet';
const DEFAULT_WALLET = 'utxoref-testnet';
const DEFAULT_RPC_PORT = 48332;
const DEFAULT_ARTIFACT = path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_utxoref_v2_latest.json');
const DEFAULT_SECRET_ROOT = 'D:\\BitcoinTestnet\\key-backups';
const EXPLORER = 'https://mempool.space/testnet4/tx/';

function parseArgs(argv) {
  const result = { broadcast: false, status: false, settle: false, forceNew: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--broadcast') { result.broadcast = true; continue; }
    if (arg === '--status') { result.status = true; continue; }
    if (arg === '--settle') { result.settle = true; result.status = true; continue; }
    if (arg === '--force-new') { result.forceNew = true; continue; }
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    result[name] = argv[++index];
  }
  return result;
}

function usage() {
  return [
    'Stage and broadcast a Bitcoin testnet4 UTXORef V2 assertion graph.',
    '',
    '1. Stage keys, signed state, funding candidate, and pre-signed graph:',
    '   node btc_testnet4_utxoref_v2_live.js',
    '',
    '2. Re-verify and broadcast the exact staged funding transaction:',
    '   node btc_testnet4_utxoref_v2_live.js --broadcast',
    '',
    '3. Inspect CSV maturity and Core settlement preflight:',
    '   node btc_testnet4_utxoref_v2_live.js --status',
    '',
    '4. Broadcast the exact pre-signed settlement after maturity:',
    '   node btc_testnet4_utxoref_v2_live.js --settle',
    '',
    'Options:',
    '  --artifact <path>',
    '  --datadir <path>',
    '  --wallet <name>',
    '  --secret-root <path>',
    '  --funding-fee-sats <n>   default 1000',
    '  --settlement-fee-sats <n> default 1000',
    '  --challenge-csv <n>       default 6 (test profile)',
    '  --recovery-csv <n>        default 2016',
    '  --fraud-mode <honest|gate|input> default honest; stage only',
    '  --force-new               replace an unbroadcast staged artifact'
  ].join('\n');
}

function readBitcoinConf(datadir) {
  const confPath = path.join(datadir, 'bitcoin.conf');
  if (!fs.existsSync(confPath)) return {};
  const sections = { global: {} };
  let section = 'global';
  for (const raw of fs.readFileSync(confPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1].toLowerCase();
      sections[section] = sections[section] || {};
      continue;
    }
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    sections[section][line.slice(0, equals).trim().toLowerCase()] = line.slice(equals + 1).trim();
  }
  return { ...(sections.global || {}), ...(sections.testnet4 || {}) };
}

function readCookie(datadir, conf) {
  const candidates = [];
  if (conf.rpccookiefile) {
    candidates.push(path.isAbsolute(conf.rpccookiefile)
      ? conf.rpccookiefile
      : path.join(datadir, conf.rpccookiefile));
  }
  candidates.push(path.join(datadir, 'testnet4', '.cookie'), path.join(datadir, '.cookie'));
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, 'utf8').trim();
    const separator = text.indexOf(':');
    if (separator > 0) return { user: text.slice(0, separator), pass: text.slice(separator + 1) };
  }
  return null;
}

function resolveRuntime(args) {
  const datadir = path.resolve(args.datadir || process.env.BTCTEST_DATADIR || DEFAULT_DATADIR);
  const wallet = args.wallet || process.env.BTCTEST_WALLET || DEFAULT_WALLET;
  const artifactPath = path.resolve(args.artifact || DEFAULT_ARTIFACT);
  const secretRoot = path.resolve(args.secretRoot || DEFAULT_SECRET_ROOT);
  const conf = readBitcoinConf(datadir);
  const cookie = readCookie(datadir, conf);
  const rpcUser = args.rpcUser || process.env.BTC_RPC_USER || conf.rpcuser || cookie?.user;
  const rpcPass = args.rpcPass || process.env.BTC_RPC_PASS || conf.rpcpassword || cookie?.pass;
  const rpcUrl = args.rpcUrl || process.env.BTC_RPC_URL || `http://127.0.0.1:${conf.rpcport || DEFAULT_RPC_PORT}`;
  if (!rpcUser || !rpcPass) throw new Error('Bitcoin testnet4 RPC credentials are unavailable');
  return {
    datadir,
    wallet,
    artifactPath,
    secretRoot,
    rpc: rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId: 'utxoref-v2-live' })
  };
}

function randomScalar() {
  let scalar = 0n;
  while (scalar === 0n) scalar = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
  return scalar;
}

function ceremonyId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase();
}

function writeSecret(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, { flag: 'wx', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_err) { /* Best effort on Windows. */ }
}

function createKeyCeremony(secretRoot) {
  const id = `utxoref-v2-${ceremonyId()}-${crypto.randomBytes(4).toString('hex')}`;
  const root = path.join(secretRoot, id);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const operatorSecret = randomScalar();
  const challengerSecret = randomScalar();
  writeSecret(
    path.join(root, 'state-signer', 'private-key.pk8.pem'),
    privateKey.export({ type: 'pkcs8', format: 'pem' })
  );
  writeSecret(
    path.join(root, 'state-signer', 'public-key.spki.pem'),
    publicKey.export({ type: 'spki', format: 'pem' })
  );
  writeSecret(path.join(root, 'operator', 'secret.hex'), a.bytes32(operatorSecret).toString('hex') + '\n');
  writeSecret(path.join(root, 'challenger', 'secret.hex'), a.bytes32(challengerSecret).toString('hex') + '\n');
  return {
    id,
    root,
    publicKey,
    privateKey,
    operatorSecret,
    challengerSecret,
    operatorXonly: a.xOnlyPubkey(operatorSecret).toString('hex'),
    challengerXonly: a.xOnlyPubkey(challengerSecret).toString('hex')
  };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function toSafeInteger(value, fieldName) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${fieldName} must be a non-negative safe integer`);
  return result;
}

function pickFundingUtxo(unspent, requiredSats) {
  return unspent
    .filter((item) => item.spendable !== false && item.safe !== false)
    .map((item) => ({ ...item, amountSats: coinValueToSats(item.amount, 'utxo.amount') }))
    .filter((item) => item.amountSats >= requiredSats)
    .sort((left, right) => left.amountSats < right.amountSats ? -1 : left.amountSats > right.amountSats ? 1 : 0)[0] || null;
}

async function newWalletDestination(rpc, wallet, label) {
  const address = await rpc('getnewaddress', [label, 'bech32'], wallet);
  const info = await rpc('getaddressinfo', [address], wallet);
  const scriptPubKeyHex = String(info.scriptPubKey || addressToScriptPubKey(address, 'bitcoin-testnet4').toString('hex'));
  return { address, scriptPubKeyHex };
}

function buildDemoStateBody(input) {
  return {
    network: 'bitcoin-testnet4',
    chainGenesisHash: input.chainGenesisHash,
    contractId: input.contractId,
    epochId: String(input.epochId),
    snapshotHeight: input.snapshotHeight,
    snapshotBlockHash: input.snapshotBlockHash,
    marks: { source: 'testnet4-v2-live-ceremony', price: 2200 },
    settlementAddressMap: {
      A: input.winnerA,
      C: input.winnerC
    },
    pnlRows: [
      {
        id: 'testnet4-a-wins-from-b', contractId: input.contractId, side: 'long',
        entryPrice: 2100, closePrice: 2200, quantityUnits: 30,
        collateralSats: 50000, traderAddress: 'A', counterpartyAddress: 'B'
      },
      {
        id: 'testnet4-c-wins-from-b', contractId: input.contractId, side: 'long',
        entryPrice: 2100, closePrice: 2200, quantityUnits: 20,
        collateralSats: 50000, traderAddress: 'C', counterpartyAddress: 'B'
      }
    ]
  };
}

function traceValuesForMode(mode) {
  switch (String(mode || 'honest').toLowerCase()) {
    case 'honest':
      return {
        mode: 'honest',
        values: { state_checkpoint_valid: 1, payout_vector_exact: 1, settlement_authorized: 1 }
      };
    case 'gate':
      return {
        mode: 'gate',
        values: { state_checkpoint_valid: 1, payout_vector_exact: 1, settlement_authorized: 0 }
      };
    case 'input':
      return {
        mode: 'input',
        values: { state_checkpoint_valid: 0, payout_vector_exact: 1, settlement_authorized: 0 }
      };
    default:
      throw new Error('fraudMode must be honest, gate, or input');
  }
}

function publicKeyPem(publicKey) {
  return publicKey.export({ type: 'spki', format: 'pem' });
}

function graphVerificationOptions(artifact, currentHeight) {
  const publicKey = crypto.createPublicKey(artifact.keyCeremony.stateSignerPublicKeyPem);
  return {
    trustedSigners: { [artifact.keyCeremony.stateSignerKeyId]: publicKey },
    expectedNetwork: 'bitcoin-testnet4',
    expectedGenesisHash: artifact.chain.genesisHash,
    currentHeight,
    maxAgeBlocks: 6
  };
}

async function fundingTransactionStatus(runtime, artifact) {
  const raw = await runtime.rpc('getrawtransaction', [artifact.funding.txid, true]).catch(() => null);
  if (raw) return { known: true, confirmations: Number(raw.confirmations || 0), blockhash: raw.blockhash || null, source: 'mempool-or-txindex' };
  const walletTx = await runtime.rpc('gettransaction', [artifact.funding.txid, true, false], runtime.wallet).catch(() => null);
  if (walletTx) return {
    known: true,
    confirmations: Number(walletTx.confirmations || 0),
    blockhash: walletTx.blockhash || null,
    source: 'wallet'
  };
  return { known: false, confirmations: 0, blockhash: null, source: null };
}

async function authorizationHeightForArtifact(runtime, artifact, chain, fundingStatus) {
  if (!fundingStatus.known) return chain.blocks;
  const authorization = artifact.verificationAtBroadcast;
  if (!authorization || !Number.isInteger(authorization.height) || !authorization.blockHash) {
    throw new Error('broadcast artifact lacks its authorization height and block hash');
  }
  const expectedBlockHash = await runtime.rpc('getblockhash', [authorization.height]);
  if (expectedBlockHash !== authorization.blockHash) throw new Error('funding authorization block is not on the active chain');
  const snapshotHeight = Number(artifact.graph.settlement.stateEnvelope.body.snapshotHeight);
  if (authorization.height < snapshotHeight || authorization.height - snapshotHeight > 6) {
    throw new Error('funding authorization used a stale state checkpoint');
  }
  return authorization.height;
}

function verifyFundingDecode(artifact, decoded) {
  if (decoded.txid !== artifact.funding.txid) throw new Error('decoded funding txid mismatch');
  if (!Array.isArray(decoded.vout) || !decoded.vout[0]) throw new Error('funding assertion output is absent');
  const output = decoded.vout[0];
  const valueSats = coinValueToSats(output.value, 'funding output value').toString();
  if (valueSats !== artifact.funding.assertionAmountSats) throw new Error('funding assertion amount mismatch');
  if (output.scriptPubKey?.hex !== artifact.graph.template.p2trScriptPubKey) {
    throw new Error('funding assertion script mismatch');
  }
}

async function stage(runtime, args) {
  if (fs.existsSync(runtime.artifactPath) && !args.forceNew) {
    throw new Error(`staged artifact already exists at ${runtime.artifactPath}; use --broadcast or --force-new`);
  }
  const fundingFeeSats = BigInt(toSafeInteger(args.fundingFeeSats ?? 1000, 'fundingFeeSats'));
  const settlementFeeSats = BigInt(toSafeInteger(args.settlementFeeSats ?? 1000, 'settlementFeeSats'));
  const challengeCsvBlocks = toSafeInteger(args.challengeCsv ?? 6, 'challengeCsv');
  const recoveryCsvBlocks = toSafeInteger(args.recoveryCsv ?? 2016, 'recoveryCsv');
  if (recoveryCsvBlocks <= challengeCsvBlocks) throw new Error('recoveryCsv must exceed challengeCsv');

  const chain = await runtime.rpc('getblockchaininfo');
  if (chain.chain !== 'testnet4') throw new Error(`wrong RPC chain: ${chain.chain}`);
  if (chain.initialblockdownload || chain.blocks !== chain.headers) throw new Error('Bitcoin testnet4 node is not fully synchronized');
  const genesisHash = await runtime.rpc('getblockhash', [0]);
  const keys = createKeyCeremony(runtime.secretRoot);
  const winnerA = await newWalletDestination(runtime.rpc, runtime.wallet, 'utxoref-v2-winner-a');
  const winnerC = await newWalletDestination(runtime.rpc, runtime.wallet, 'utxoref-v2-winner-c');
  const recovery = await newWalletDestination(runtime.rpc, runtime.wallet, 'utxoref-v2-recovery');
  const change = await newWalletDestination(runtime.rpc, runtime.wallet, 'utxoref-v2-funding-change');
  const contractId = sha256Hex(Buffer.from(`utxoref-v2:${chain.bestblockhash}:${keys.id}`, 'utf8'));
  const stateBody = buildDemoStateBody({
    chainGenesisHash: genesisHash,
    contractId,
    epochId: chain.blocks,
    snapshotHeight: chain.blocks,
    snapshotBlockHash: chain.bestblockhash,
    winnerA,
    winnerC
  });
  const stateSignerKeyId = publicKeyId(keys.publicKey);
  const stateEnvelope = buildSignedStateCheckpointV2(stateBody, {
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    keyId: stateSignerKeyId
  });
  const binding = buildSettlementTraceBindingV2({ stateEnvelope, feeSats: settlementFeeSats });
  const traceMode = traceValuesForMode(args.fraudMode);
  const wireBundle = buildWireSecretSetV2([
    'state_checkpoint_valid',
    'payout_vector_exact',
    'settlement_authorized'
  ]);
  writeSecret(path.join(keys.root, 'operator', 'wire-bundle.json'), JSON.stringify(wireBundle, null, 2) + '\n');
  const publicTrace = buildPublicTraceV2({
    circuitId: 'utxoref-v2-state-and-payout-authorization',
    binding,
    gates: [{
      type: 'and',
      inputs: ['state_checkpoint_valid', 'payout_vector_exact'],
      output: 'settlement_authorized'
    }],
    wireBundle,
    values: traceMode.values
  });
  const expectedInputs = { state_checkpoint_valid: 1, payout_vector_exact: 1 };
  const template = buildBitvmAssertionTemplateV2({
    network: 'bitcoin-testnet4',
    publicTrace,
    expectedInputs,
    operatorXonly: keys.operatorXonly,
    challengerXonly: keys.challengerXonly,
    challengeCsvBlocks,
    recoveryCsvBlocks
  });
  const assertionAmountSats = BigInt(binding.assertionAmountSats);
  const requiredSats = assertionAmountSats + fundingFeeSats + 330n;
  const fundingUtxo = pickFundingUtxo(
    await runtime.rpc('listunspent', [1, 9999999], runtime.wallet),
    requiredSats
  );
  if (!fundingUtxo) throw new Error(`wallet ${runtime.wallet} has no confirmed UTXO of at least ${requiredSats} sats`);
  const changeSats = fundingUtxo.amountSats - assertionAmountSats - fundingFeeSats;
  if (changeSats < 330n) throw new Error('funding change is below the V2 dust floor');
  const fundingUnsignedHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(fundingUtxo.txid, fundingUtxo.vout),
    sequence: 0xfffffffd
  }], [
    { valueSats: assertionAmountSats, script: template.p2trScriptPubKey },
    { valueSats: changeSats, script: change.scriptPubKeyHex }
  ], 0);
  const fundingSigned = await runtime.rpc('signrawtransactionwithwallet', [fundingUnsignedHex], runtime.wallet);
  if (!fundingSigned.complete) throw new Error(`wallet could not sign funding transaction: ${JSON.stringify(fundingSigned.errors || [])}`);
  const fundingDecoded = await runtime.rpc('decoderawtransaction', [fundingSigned.hex]);
  const assertionOutpoint = {
    txid: fundingDecoded.txid,
    vout: 0,
    amountSats: assertionAmountSats.toString(),
    scriptPubKeyHex: template.p2trScriptPubKey
  };
  const stateVerification = {
    trustedSigners: { [stateSignerKeyId]: keys.publicKey },
    expectedNetwork: 'bitcoin-testnet4',
    expectedGenesisHash: genesisHash,
    currentHeight: chain.blocks,
    maxAgeBlocks: 6
  };
  const graph = finalizeBitvmAssertionGraphV2({
    template,
    publicTrace,
    stateEnvelope,
    stateVerification,
    assertionOutpoint,
    feeSats: settlementFeeSats,
    recoveryFeeSats: settlementFeeSats,
    recoveryScriptPubKeyHex: recovery.scriptPubKeyHex,
    operatorSecret: keys.operatorSecret,
    challengerSecret: keys.challengerSecret
  });
  const graphCheck = verifyBitvmAssertionGraphV2(graph, stateVerification);
  if (!graphCheck.ok) throw new Error(`V2 graph verification failed: ${graphCheck.reason}`);
  const [mempoolAccept] = await runtime.rpc('testmempoolaccept', [[fundingSigned.hex]]);
  if (!mempoolAccept.allowed) throw new Error(`funding preflight rejected: ${mempoolAccept['reject-reason'] || 'unknown reason'}`);

  const artifact = {
    kind: 'btc_testnet4_utxoref_v2_live_ceremony',
    version: 2,
    createdAt: new Date().toISOString(),
    network: 'bitcoin-testnet4',
    status: 'staged',
    traceMode: traceMode.mode,
    chain: {
      snapshotHeight: chain.blocks,
      snapshotBlockHash: chain.bestblockhash,
      genesisHash,
      initialBlockDownload: chain.initialblockdownload
    },
    keyCeremony: {
      id: keys.id,
      stateSignerKeyId,
      stateSignerPublicKeyPem: publicKeyPem(keys.publicKey),
      operatorXonly: keys.operatorXonly,
      challengerXonly: keys.challengerXonly,
      model: 'local-test-ceremony-separated-files',
      productionRequirement: 'challenger key and signing process must run on a separately administered host'
    },
    funding: {
      input: { txid: fundingUtxo.txid, vout: fundingUtxo.vout, amountSats: fundingUtxo.amountSats.toString() },
      fundingFeeSats: fundingFeeSats.toString(),
      assertionAmountSats: assertionAmountSats.toString(),
      changeSats: changeSats.toString(),
      unsignedHex: fundingUnsignedHex,
      signedHex: fundingSigned.hex,
      txid: fundingDecoded.txid,
      assertionOutpoint: `${fundingDecoded.txid}:0`,
      mempoolAccept,
      broadcastTxid: null,
      confirmations: 0
    },
    graph,
    verification: graphCheck,
    explorer: {
      funding: EXPLORER + fundingDecoded.txid,
      settlement: EXPLORER + txidFromUnsignedHex(graph.settlement.unsignedTxHex)
    }
  };
  if (containsPrivateMaterial(artifact)) throw new Error('public ceremony artifact contains private material');
  verifyFundingDecode(artifact, fundingDecoded);
  fs.mkdirSync(path.dirname(runtime.artifactPath), { recursive: true });
  fs.writeFileSync(runtime.artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({
    status: artifact.status,
    artifact: runtime.artifactPath,
    fundingTxid: artifact.funding.txid,
    assertionOutpoint: artifact.funding.assertionOutpoint,
    assertionAmountSats: artifact.funding.assertionAmountSats,
    graphHash: artifact.graph.graphHash,
    commitmentHash: artifact.graph.settlement.commitment.commitmentHash,
    p2trScriptPubKey: artifact.graph.template.p2trScriptPubKey,
    mempoolAccept: mempoolAccept.allowed,
    next: 'rerun with --broadcast after reviewing the artifact'
  }, null, 2));
  return artifact;
}

async function broadcast(runtime) {
  if (!fs.existsSync(runtime.artifactPath)) throw new Error(`staged artifact not found: ${runtime.artifactPath}`);
  const artifact = readJsonStrictProfile(runtime.artifactPath, 'utxoref-v2-public-artifact', 'staged UTXORef V2 artifact');
  if (artifact.kind !== 'btc_testnet4_utxoref_v2_live_ceremony' || artifact.version !== 2) {
    throw new Error('wrong staged artifact kind or version');
  }
  if (containsPrivateMaterial(artifact)) throw new Error('staged artifact contains private material');
  const chain = await runtime.rpc('getblockchaininfo');
  if (chain.chain !== 'testnet4' || chain.initialblockdownload || chain.blocks !== chain.headers) {
    throw new Error('Bitcoin testnet4 node is not fully synchronized');
  }
  const existing = await fundingTransactionStatus(runtime, artifact);
  const verificationHeight = await authorizationHeightForArtifact(runtime, artifact, chain, existing);
  const graphCheck = verifyBitvmAssertionGraphV2(
    artifact.graph,
    graphVerificationOptions(artifact, verificationHeight)
  );
  if (!graphCheck.ok) throw new Error(`staged V2 graph no longer verifies: ${graphCheck.reason}`);
  const decoded = await runtime.rpc('decoderawtransaction', [artifact.funding.signedHex]);
  verifyFundingDecode(artifact, decoded);
  let status;
  let broadcastTxid = artifact.funding.txid;
  let mempoolAccept = null;
  if (existing.known) {
    status = existing.confirmations > 0 ? 'confirmed' : 'broadcast';
  } else {
    [mempoolAccept] = await runtime.rpc('testmempoolaccept', [[artifact.funding.signedHex]]);
    if (!mempoolAccept.allowed) throw new Error(`funding preflight rejected: ${mempoolAccept['reject-reason'] || 'unknown reason'}`);
    broadcastTxid = await runtime.rpc('sendrawtransaction', [artifact.funding.signedHex]);
    if (broadcastTxid !== artifact.funding.txid) throw new Error('broadcast funding txid differs from staged txid');
    status = 'broadcast';
  }
  artifact.status = status;
  artifact.broadcastAt = artifact.broadcastAt || new Date().toISOString();
  artifact.funding.broadcastTxid = broadcastTxid;
  artifact.funding.mempoolAcceptAtBroadcast = mempoolAccept;
  artifact.verificationAtBroadcast = {
    height: chain.blocks,
    blockHash: chain.bestblockhash,
    graph: graphCheck
  };
  fs.writeFileSync(runtime.artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  console.log(JSON.stringify({
    status,
    fundingTxid: broadcastTxid,
    explorer: EXPLORER + broadcastTxid,
    graphHash: artifact.graph.graphHash,
    challengeCsvBlocks: artifact.graph.template.challengeCsvBlocks,
    recoveryCsvBlocks: artifact.graph.template.recoveryCsvBlocks
  }, null, 2));
  return artifact;
}

async function status(runtime, args = {}) {
  if (!fs.existsSync(runtime.artifactPath)) throw new Error(`staged artifact not found: ${runtime.artifactPath}`);
  const artifact = readJsonStrictProfile(runtime.artifactPath, 'utxoref-v2-public-artifact', 'staged UTXORef V2 artifact');
  if (artifact.kind !== 'btc_testnet4_utxoref_v2_live_ceremony' || artifact.version !== 2) {
    throw new Error('wrong staged artifact kind or version');
  }
  if (containsPrivateMaterial(artifact)) throw new Error('staged artifact contains private material');
  const chain = await runtime.rpc('getblockchaininfo');
  if (chain.chain !== 'testnet4' || chain.initialblockdownload || chain.blocks !== chain.headers) {
    throw new Error('Bitcoin testnet4 node is not fully synchronized');
  }
  const fundingStatus = await fundingTransactionStatus(runtime, artifact);
  const verificationHeight = await authorizationHeightForArtifact(runtime, artifact, chain, fundingStatus);
  const graphCheck = verifyBitvmAssertionGraphV2(
    artifact.graph,
    graphVerificationOptions(artifact, verificationHeight)
  );
  if (!graphCheck.ok) throw new Error(`V2 graph verification failed: ${graphCheck.reason}`);
  const assertion = artifact.graph.assertionOutpoint;
  const txout = await runtime.rpc('gettxout', [assertion.txid, assertion.vout, true]);
  const confirmations = txout ? Number(txout.confirmations || 0) : fundingStatus.confirmations;
  const challengeCsvBlocks = artifact.graph.template.challengeCsvBlocks;
  const settlementTxid = txidFromUnsignedHex(artifact.graph.settlement.unsignedTxHex);
  const settlementRaw = await runtime.rpc('getrawtransaction', [settlementTxid, true]).catch(() => null);
  const settlementWallet = settlementRaw
    ? null
    : await runtime.rpc('gettransaction', [settlementTxid, true, false], runtime.wallet).catch(() => null);
  const settlementKnown = settlementRaw || settlementWallet;
  const settlementConfirmations = Number(settlementKnown?.confirmations || 0);
  let settlementMempoolAccept = null;
  if (txout && fundingStatus.known) {
    [settlementMempoolAccept] = await runtime.rpc('testmempoolaccept', [[artifact.graph.settlementPath.witnessTxHex]]);
  }
  let settlementBroadcastTxid = settlementKnown ? settlementTxid : null;
  if (args.settle) {
    if (!txout) {
      if (!settlementKnown) throw new Error('assertion outpoint is spent by an unknown transaction');
    } else {
      if (confirmations < challengeCsvBlocks) {
        throw new Error(`settlement is not mature: ${confirmations}/${challengeCsvBlocks} confirmations`);
      }
      if (!settlementMempoolAccept?.allowed) {
        throw new Error(`settlement preflight rejected: ${settlementMempoolAccept?.['reject-reason'] || 'unknown reason'}`);
      }
      settlementBroadcastTxid = await runtime.rpc('sendrawtransaction', [artifact.graph.settlementPath.witnessTxHex]);
      if (settlementBroadcastTxid !== settlementTxid) throw new Error('settlement txid differs from the committed transaction');
      artifact.status = 'settlement-broadcast';
      artifact.settlementBroadcastAt = new Date().toISOString();
      artifact.settlement = {
        txid: settlementTxid,
        mempoolAccept: settlementMempoolAccept,
        explorer: EXPLORER + settlementTxid
      };
      fs.writeFileSync(runtime.artifactPath, JSON.stringify(artifact, null, 2) + '\n');
    }
  }
  const result = {
    status: artifact.status,
    chainHeight: chain.blocks,
    fundingTxid: artifact.funding.txid,
    fundingKnown: fundingStatus.known,
    fundingConfirmations: confirmations,
    assertionUnspent: Boolean(txout),
    assertionAmountSats: txout ? coinValueToSats(txout.value, 'assertion value').toString() : null,
    challengeCsvBlocks,
    settlementMature: Boolean(txout) && confirmations >= challengeCsvBlocks,
    settlementMempoolAccept: settlementMempoolAccept?.allowed ?? null,
    settlementRejectReason: settlementMempoolAccept?.['reject-reason'] || null,
    settlementTxid,
    settlementBroadcastTxid,
    settlementKnown: Boolean(settlementKnown),
    settlementConfirmations,
    explorer: {
      funding: EXPLORER + artifact.funding.txid,
      settlement: EXPLORER + settlementTxid
    },
    graphHash: artifact.graph.graphHash,
    graphVerifiedAtAuthorizationHeight: verificationHeight
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function run(args) {
  const runtime = resolveRuntime(args);
  if (args.settle || args.status) return status(runtime, args);
  return args.broadcast ? broadcast(runtime) : stage(runtime, args);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) console.log(usage());
  else run(args).catch((err) => {
    console.error(`Bitcoin testnet4 UTXORef V2 live ceremony failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildDemoStateBody,
  traceValuesForMode,
  graphVerificationOptions,
  verifyFundingDecode,
  stage,
  broadcast,
  status,
  run
};
