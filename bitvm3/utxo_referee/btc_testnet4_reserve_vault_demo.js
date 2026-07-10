#!/usr/bin/env node

/**
 * BTC testnet4 reserve vault demo.
 *
 * Defaults to the local node/wallet from the handoff:
 *   datadir D:\BitcoinTestnet, chain testnet4, RPC 127.0.0.1:48332,
 *   wallet utxoref-testnet.
 *
 * Dry run (no broadcast):
 *   node btc_testnet4_reserve_vault_demo.js
 *
 * Broadcast only the vault funding transaction:
 *   node btc_testnet4_reserve_vault_demo.js --broadcast
 *
 * Broadcast funding and then the guardian-approved spend:
 *   node btc_testnet4_reserve_vault_demo.js --broadcast --broadcast-spend
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const {
  addressToScriptPubKey
} = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerWithdrawalQueue
} = require('./tradelayer_withdrawal_queue_referee');
const {
  buildTradeLayerReserveReconciliation
} = require('./tradelayer_reserve_reconciliation_referee');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const a = require('./tradelayer_dlc_adaptor_sig');
const {
  buildTaprootReserveVaultTemplate,
  buildTaprootReserveVaultManifest,
  buildTaprootReserveVaultSet,
  buildTaprootReserveVaultSetFromRpc,
  buildVaultSpendProposal,
  approveTaprootReserveVaultSpend,
  coinValueToSats,
  csvSequence
} = require('./taproot_reserve_vault');

const DEFAULT_DATADIR = 'D:\\BitcoinTestnet';
const DEFAULT_WALLET = 'utxoref-testnet';
const DEFAULT_RPC_PORT = 48332;
const EXPLORER_BASE = 'https://mempool.space/testnet4/tx/';
const BITCOIND_CANDIDATES = [
  'C:\\projects\\BitcoinConsensusObservatory\\jurassic-bitcoin\\tools\\bitcoin-core-30.2\\bitcoin-30.2\\bin\\bitcoind.exe',
  'C:\\Program Files\\Bitcoin\\daemon\\bitcoind.exe',
  'C:\\Program Files\\Bitcoin\\bitcoind.exe'
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (arg === '--broadcast-spend') { args.broadcastSpend = true; continue; }
    if (arg === '--start-node') { args.startNode = true; continue; }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected arg ${arg}`);
    args[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}

function usage() {
  return [
    'Usage: node btc_testnet4_reserve_vault_demo.js [options]',
    '',
    'Options:',
    '  --datadir <path>          default D:\\BitcoinTestnet',
    '  --wallet <name>           default utxoref-testnet',
    '  --rpc-url <url>           default from bitcoin.conf or http://127.0.0.1:48332',
    '  --rpc-user <user>         default from bitcoin.conf or BTC_RPC_USER',
    '  --rpc-pass <pass>         default from bitcoin.conf or BTC_RPC_PASS/BTC_RPC_PASSWORD',
    '  --lock-sats <n>           default 20000',
    '  --funding-fee-sats <n>    default 700',
    '  --spend-fee-sats <n>      default 1000',
    '  --recovery-csv <n>        default 2016 blocks',
    '  --start-node             start bitcoind first using BITCOIND or a known local path',
    '  --broadcast               broadcast the vault funding transaction',
    '  --broadcast-spend         also broadcast the approved policy spend'
  ].join('\n');
}

function readBitcoinConf(datadir) {
  const confPath = path.join(datadir, 'bitcoin.conf');
  const result = {};
  if (!fs.existsSync(confPath)) return result;
  const sections = { global: {} };
  let section = 'global';
  for (const raw of fs.readFileSync(confPath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const match = line.match(/^\[([^\]]+)\]$/);
    if (match) {
      section = match[1].toLowerCase();
      sections[section] = sections[section] || {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    sections[section][key] = value;
  }
  Object.assign(result, sections.global || {}, sections.testnet4 || {});
  return result;
}

function readCookieAuth(datadir, conf = {}) {
  const candidates = [];
  if (conf.rpccookiefile) {
    candidates.push(path.isAbsolute(conf.rpccookiefile)
      ? conf.rpccookiefile
      : path.join(datadir, conf.rpccookiefile));
  }
  candidates.push(
    path.join(datadir, 'testnet4', '.cookie'),
    path.join(datadir, '.cookie')
  );
  for (const cookiePath of candidates) {
    if (!fs.existsSync(cookiePath)) continue;
    const text = fs.readFileSync(cookiePath, 'utf8').trim();
    const sep = text.indexOf(':');
    if (sep > 0) {
      return {
        rpcUser: text.slice(0, sep),
        rpcPass: text.slice(sep + 1),
        cookiePath
      };
    }
  }
  return null;
}

function resolveRpcConfig(args) {
  const datadir = args.datadir || process.env.BTCTEST_DATADIR || DEFAULT_DATADIR;
  const wallet = args.wallet || process.env.BTCTEST_WALLET || DEFAULT_WALLET;
  const conf = readBitcoinConf(datadir);
  const cookie = readCookieAuth(datadir, conf);
  const rpcPort = Number(args.rpcPort || process.env.BTC_RPC_PORT || conf.rpcport || DEFAULT_RPC_PORT);
  const rpcUrl = args.rpcUrl || process.env.BTC_RPC_URL || `http://127.0.0.1:${rpcPort}`;
  const rpcUser = args.rpcUser || process.env.BTC_RPC_USER || conf.rpcuser || cookie?.rpcUser;
  const rpcPass = args.rpcPass || process.env.BTC_RPC_PASS || process.env.BTC_RPC_PASSWORD || conf.rpcpassword || conf.rpcpass || cookie?.rpcPass;
  if (!rpcUser || !rpcPass) {
    throw new Error(`missing RPC credentials; set --rpc-user/--rpc-pass, configure ${path.join(datadir, 'bitcoin.conf')}, or start Bitcoin Core so the RPC cookie exists`);
  }
  return { datadir, wallet, rpcUrl, rpcUser, rpcPass, auth: cookie && rpcUser === cookie.rpcUser ? 'cookie' : 'config' };
}

function locateBitcoind(args = {}) {
  const candidates = [args.bitcoind, process.env.BITCOIND, ...BITCOIND_CANDIDATES].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function startBitcoind(args, config) {
  const bitcoind = locateBitcoind(args);
  if (!bitcoind) {
    throw new Error('bitcoind.exe not found; set BITCOIND or pass --bitcoind <path>');
  }
  const child = spawn(bitcoind, [
    `-datadir=${config.datadir}`,
    '-chain=testnet4',
    '-server'
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return { bitcoind, pid: child.pid };
}

async function waitForRpc(rpc, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await rpc('getblockchaininfo');
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error(`RPC did not become ready within ${timeoutMs} ms: ${lastError ? lastError.message : 'unknown error'}`);
}

function randScalar() {
  let scalar = 0n;
  while (scalar === 0n) scalar = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
  return scalar;
}

function pickFundingUtxo(unspent, requiredSats) {
  const candidates = unspent
    .filter((row) => row.spendable !== false)
    .map((row) => ({ ...row, amountSats: coinValueToSats(row.amount, 'utxo.amount') }))
    .filter((row) => row.amountSats >= BigInt(requiredSats))
    .sort((x, y) => (x.amountSats < y.amountSats ? -1 : x.amountSats > y.amountSats ? 1 : 0));
  return candidates[0] || null;
}

function keyFileLine(label, values) {
  return `${new Date().toISOString()} ${label} ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ')}\n`;
}

async function testMempoolAccept(rpc, hex) {
  const result = await rpc('testmempoolaccept', [[hex]]);
  return Array.isArray(result) ? result[0] : result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const config = resolveRpcConfig(args);
  const rpc = rpcFactory({
    rpcUrl: config.rpcUrl,
    rpcUser: config.rpcUser,
    rpcPass: config.rpcPass,
    requestId: 'btc-testnet4-reserve-vault'
  });
  const wallet = config.wallet;
  const lockSats = Number(args.lockSats || 20000);
  const fundingFeeSats = Number(args.fundingFeeSats || 700);
  const spendFeeSats = Number(args.spendFeeSats || 1000);
  const recoveryCsvDelay = csvSequence(args.recoveryCsv || 2016);
  if (!Number.isSafeInteger(lockSats) || lockSats <= 0) throw new Error('lock-sats must be positive');
  if (!Number.isSafeInteger(fundingFeeSats) || fundingFeeSats < 0) throw new Error('funding-fee-sats must be non-negative');
  if (!Number.isSafeInteger(spendFeeSats) || spendFeeSats < 0 || spendFeeSats >= lockSats) {
    throw new Error('spend-fee-sats must be non-negative and less than lock-sats');
  }

  let nodeStart = null;
  let chainInfo;
  try {
    chainInfo = await rpc('getblockchaininfo');
  } catch (err) {
    if (!args.startNode) {
      throw new Error(`${err.message}; start Bitcoin Core testnet4 first or rerun with --start-node`);
    }
    nodeStart = startBitcoind(args, config);
    chainInfo = await waitForRpc(rpc);
  }
  if (chainInfo.chain !== 'testnet4') {
    throw new Error(`expected Bitcoin Core chain testnet4, got ${chainInfo.chain}`);
  }
  const observedAtHeight = Number(chainInfo.blocks);

  const operatorSecret = randScalar();
  const guardianSecret = randScalar();
  const operatorXonly = a.xOnlyPubkey(operatorSecret).toString('hex');
  const guardianXonly = a.xOnlyPubkey(guardianSecret).toString('hex');
  const template = buildTaprootReserveVaultTemplate({
    network: 'bitcoin-testnet4',
    operatorXonly,
    guardianXonly,
    recoveryCsvDelay
  });

  const unspent = await rpc('listunspent', [1, 9999999], wallet);
  const fundingUtxo = pickFundingUtxo(unspent, lockSats + fundingFeeSats + 546);
  if (!fundingUtxo) {
    throw new Error(`wallet ${wallet} has no spendable testnet4 UTXO >= ${lockSats + fundingFeeSats + 546} sats`);
  }
  const changeAddress = await rpc('getrawchangeaddress', ['bech32'], wallet);
  const changeInfo = await rpc('getaddressinfo', [changeAddress], wallet);
  const changeSats = Number(fundingUtxo.amountSats - BigInt(lockSats) - BigInt(fundingFeeSats));
  const fundingOutputs = [{ valueSats: lockSats, script: template.p2trScriptPubKey }];
  if (changeSats >= 546) fundingOutputs.push({ valueSats: changeSats, script: changeInfo.scriptPubKey });
  const fundingUnsignedHex = tr.serializeUnsignedTx(2, [
    { outpoint: tr.outpoint(fundingUtxo.txid, fundingUtxo.vout), sequence: 0xfffffffd }
  ], fundingOutputs, 0);
  const fundingSigned = await rpc('signrawtransactionwithwallet', [fundingUnsignedHex], wallet);
  if (!fundingSigned.complete) throw new Error('funding sign incomplete: ' + JSON.stringify(fundingSigned.errors || []));
  const fundingDecoded = await rpc('decoderawtransaction', [fundingSigned.hex]);
  const fundingTxid = fundingDecoded.txid;

  const manifest = buildTaprootReserveVaultManifest({
    network: 'bitcoin-testnet4',
    vaultId: `btc-testnet4-reserve-${observedAtHeight}-${fundingTxid.slice(0, 8)}`,
    fundingOutpoint: { txid: fundingTxid, vout: 0 },
    amountSats: lockSats,
    operatorXonly,
    guardianXonly,
    observedAtHeight,
    recoveryCsvDelay,
    reserveEpochId: `btc-testnet4-${observedAtHeight}`
  });

  let broadcastFunding = null;
  if (args.broadcast) {
    const accept = await testMempoolAccept(rpc, fundingSigned.hex);
    if (!accept.allowed && !String(accept.rejectReason || '').includes('txn-already-known')) {
      throw new Error('funding transaction rejected: ' + JSON.stringify(accept));
    }
    const sentTxid = await rpc('sendrawtransaction', [fundingSigned.hex]);
    broadcastFunding = { txid: sentTxid, explorer: EXPLORER_BASE + sentTxid, mempoolAccept: accept };

    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, keyFileLine('btc-testnet4-reserve-vault', {
      vaultId: manifest.core.vaultId,
      fundingOutpoint: `${sentTxid}:0`,
      operatorSecret: a.bytes32(operatorSecret).toString('hex'),
      guardianSecret: a.bytes32(guardianSecret).toString('hex'),
      p2trScriptPubKey: manifest.core.p2trScriptPubKey
    }), { flag: 'a' });
  }

  const currentHeight = Number(await rpc('getblockcount'));
  let reserveSet;
  let reserveEvidenceMode;
  if (args.broadcast) {
    reserveSet = await buildTaprootReserveVaultSetFromRpc({
      rpc,
      network: 'bitcoin-testnet4',
      reserveEpochId: manifest.core.reserveEpochId,
      currentHeight,
      manifests: [manifest]
    });
    reserveEvidenceMode = 'rpc-gettxout';
  } else {
    reserveSet = buildTaprootReserveVaultSet({
      network: 'bitcoin-testnet4',
      reserveEpochId: manifest.core.reserveEpochId,
      currentHeight,
      manifests: [manifest],
      chainTxouts: {
        [`${fundingTxid}:0`]: {
          valueSats: lockSats,
          scriptPubKey: { hex: manifest.core.p2trScriptPubKey },
          confirmations: 0
        }
      }
    });
    reserveEvidenceMode = 'dry-run-simulated-chain-txout';
  }

  const payoutSats = lockSats - spendFeeSats;
  const payoutAddress = await rpc('getnewaddress', ['reserve-vault-withdrawal', 'bech32'], wallet);
  const payoutSpk = addressToScriptPubKey(payoutAddress, 'bitcoin-testnet4').toString('hex');
  const withdrawalQueue = buildTradeLayerWithdrawalQueue({
    network: 'bitcoin-testnet4',
    epochId: observedAtHeight,
    requests: [{
      id: 'btc-testnet4-reserve-withdrawal-1',
      txid: fundingTxid,
      address: payoutAddress,
      sats: payoutSats,
      propertyId: 0,
      status: 'approved'
    }]
  });
  const reconciliation = buildTradeLayerReserveReconciliation({
    network: 'bitcoin-testnet4',
    queue: withdrawalQueue,
    reserve: reserveSet,
    observedAtHeight: currentHeight,
    currentHeight,
    maxReserveAgeBlocks: 6
  });

  const validSpendHex = tr.serializeUnsignedTx(2, [
    { outpoint: tr.outpoint(fundingTxid, 0), sequence: 0xfffffffd }
  ], [
    { valueSats: payoutSats, script: payoutSpk }
  ], 0);
  const validProposal = buildVaultSpendProposal({
    manifest,
    unsignedTxHex: validSpendHex,
    expectedOutputs: [{ valueSats: payoutSats, scriptPubKey: payoutSpk }],
    reserveReconciliation: reconciliation,
    withdrawalQueue
  });
  const validApproval = approveTaprootReserveVaultSpend({
    manifest,
    proposal: validProposal,
    guardianSecret,
    reserveReconciliation: reconciliation,
    withdrawalQueue,
    currentHeight
  });

  const badSpendHex = tr.serializeUnsignedTx(2, [
    { outpoint: tr.outpoint(fundingTxid, 0), sequence: 0xfffffffd }
  ], [
    { valueSats: payoutSats - 1, script: payoutSpk }
  ], 0);
  const badProposal = buildVaultSpendProposal({
    manifest,
    unsignedTxHex: badSpendHex,
    expectedOutputs: [{ valueSats: payoutSats, scriptPubKey: payoutSpk }],
    reserveReconciliation: reconciliation,
    withdrawalQueue
  });
  const refusal = approveTaprootReserveVaultSpend({
    manifest,
    proposal: badProposal,
    guardianSecret,
    reserveReconciliation: reconciliation,
    withdrawalQueue,
    currentHeight
  });

  let spendBroadcast = null;
  if (args.broadcastSpend) {
    if (!args.broadcast) throw new Error('--broadcast-spend requires --broadcast');
    if (!validApproval.approved) throw new Error('cannot broadcast spend: guardian did not approve');
    const parsed = tr.parseTx(validSpendHex);
    const leaf = manifest.core.leaves['immediate-operator-guardian'];
    const sighash = ts.scriptPathSighash(
      parsed,
      [{ scriptPubKey: manifest.core.p2trScriptPubKey, amountSats: manifest.core.amountSats }],
      0,
      Buffer.from(leaf.leafHash, 'hex')
    );
    const operatorSig = a.schnorrSign(operatorSecret, sighash).toString('hex');
    const finalSpendHex = tr.serializeWitnessTx(2, [
      {
        outpoint: tr.outpoint(fundingTxid, 0),
        scriptSig: '',
        sequence: 0xfffffffd,
        witness: [validApproval.signature, operatorSig, leaf.scriptHex, leaf.controlBlock]
      }
    ], [
      { valueSats: payoutSats, script: payoutSpk }
    ], 0);
    const accept = await testMempoolAccept(rpc, finalSpendHex);
    if (!accept.allowed) throw new Error('approved spend rejected: ' + JSON.stringify(accept));
    const spendTxid = await rpc('sendrawtransaction', [finalSpendHex]);
    spendBroadcast = { txid: spendTxid, explorer: EXPLORER_BASE + spendTxid, mempoolAccept: accept };
  }

  const artifact = {
    kind: 'btc_testnet4_taproot_reserve_vault_demo',
    createdAt: new Date().toISOString(),
    network: 'bitcoin-testnet4',
    datadir: config.datadir,
    rpcUrl: config.rpcUrl,
    wallet,
    chain: {
      chain: chainInfo.chain,
      observedAtHeight,
      currentHeight
    },
    nodeStart,
    dryRun: !args.broadcast,
    reserveEvidenceMode,
    funding: {
      input: { txid: fundingUtxo.txid, vout: fundingUtxo.vout, amountSats: fundingUtxo.amountSats.toString() },
      unsignedHex: fundingUnsignedHex,
      signedHex: fundingSigned.hex,
      txid: fundingTxid,
      vaultOutpoint: `${fundingTxid}:0`,
      broadcast: broadcastFunding
    },
    manifest,
    reserveSet,
    withdrawalQueue,
    reconciliation,
    guardianRefusal: refusal,
    guardianApproval: validApproval,
    validSpend: {
      unsignedHex: validSpendHex,
      proposalHash: validProposal.proposalHash,
      broadcast: spendBroadcast
    },
    explorer: {
      funding: EXPLORER_BASE + fundingTxid,
      spend: spendBroadcast ? spendBroadcast.explorer : null
    }
  };

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'btc_testnet4_reserve_vault_latest.json');
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');

  console.log('BTC testnet4 Taproot reserve vault demo:');
  console.log(`  chain             : ${chainInfo.chain} height=${currentHeight}`);
  console.log(`  wallet            : ${wallet}`);
  console.log(`  vault outpoint    : ${fundingTxid}:0 (${lockSats} sats)`);
  console.log(`  P2TR scriptPubKey : ${manifest.core.p2trScriptPubKey}`);
  console.log(`  reserve counted   : ${reserveSet.reservedSats} sats via ${reserveEvidenceMode}`);
  console.log(`  bad proposal      : approved=${refusal.approved} failed=${refusal.policyResult.failedChecks.join(',')}`);
  console.log(`  valid proposal    : approved=${validApproval.approved} outputHash=${validApproval.approvedTxOutputHash}`);
  if (broadcastFunding) console.log(`  BROADCAST funding : ${broadcastFunding.explorer}`);
  else console.log('  dry run           : funding not broadcast; pass --broadcast to send');
  if (spendBroadcast) console.log(`  BROADCAST spend   : ${spendBroadcast.explorer}`);
  console.log(`  artifact          : ${outPath}`);
}

main().catch((err) => {
  console.error('BTC testnet4 reserve vault demo failed:', err.message);
  process.exit(1);
});
