#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const a = require('./tradelayer_dlc_adaptor_sig');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const {
  verifyTaprootReserveVaultManifest,
  verifyTaprootReserveVaultOnChain,
  verifyGuardianApproval
} = require('./taproot_reserve_vault');

const DEFAULT_DATADIR = 'D:\\BitcoinTestnet';
const DEFAULT_ARTIFACT = path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_reserve_vault_latest.json');
const DEFAULT_KEY_FILE = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
const DEFAULT_RECEIPT = path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_reserve_recovery_latest.json');
const DEFAULT_RPC_PORT = 48332;

function parseArgs(argv) {
  const result = { broadcast: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--broadcast') { result.broadcast = true; continue; }
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    result[name] = argv[++index];
  }
  return result;
}

function usage() {
  return [
    'Recover the recorded Bitcoin testnet4 reserve vault.',
    '',
    'Dry-run and mempool preflight:',
    '  node recover_btc_testnet4_reserve_vault.js',
    '',
    'Broadcast only after every local and RPC check passes:',
    '  node recover_btc_testnet4_reserve_vault.js --broadcast',
    '',
    'Options:',
    '  --artifact <path>',
    '  --key-file <path>',
    '  --receipt <path>',
    '  --datadir <path>',
    '  --rpc-url <url>',
    '  --rpc-user <user>',
    '  --rpc-pass <pass>'
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

function resolveRpc(args) {
  const datadir = path.resolve(args.datadir || process.env.BTCTEST_DATADIR || DEFAULT_DATADIR);
  const conf = readBitcoinConf(datadir);
  const cookie = readCookie(datadir, conf);
  const rpcUser = args.rpcUser || process.env.BTC_RPC_USER || conf.rpcuser || cookie?.user;
  const rpcPass = args.rpcPass || process.env.BTC_RPC_PASS || conf.rpcpassword || cookie?.pass;
  const rpcUrl = args.rpcUrl || process.env.BTC_RPC_URL || `http://127.0.0.1:${conf.rpcport || DEFAULT_RPC_PORT}`;
  if (!rpcUser || !rpcPass) throw new Error('Bitcoin testnet4 RPC credentials are unavailable');
  return { datadir, rpc: rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId: 'utxoref-vault-recovery' }) };
}

function parseRecoveryKeys(text, fundingOutpoint) {
  const matches = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = {};
    for (const token of line.trim().split(/\s+/).slice(2)) {
      const equals = token.indexOf('=');
      if (equals > 0) fields[token.slice(0, equals)] = token.slice(equals + 1);
    }
    if (fields.fundingOutpoint === fundingOutpoint) matches.push(fields);
  }
  if (!matches.length) throw new Error(`no recovery keys match ${fundingOutpoint}`);
  const selected = matches[matches.length - 1];
  for (const name of ['operatorSecret', 'guardianSecret']) {
    if (!/^[0-9a-fA-F]{64}$/.test(selected[name] || '')) throw new Error(`${name} is missing or malformed`);
  }
  return selected;
}

function doubleSha256(value) {
  return crypto.createHash('sha256').update(
    crypto.createHash('sha256').update(value).digest()
  ).digest();
}

function txidFromUnsignedHex(unsignedHex) {
  return Buffer.from(doubleSha256(Buffer.from(unsignedHex, 'hex'))).reverse().toString('hex');
}

function buildRecoverySpendPackage(artifact, keyText) {
  const manifest = artifact?.manifest;
  const manifestCheck = verifyTaprootReserveVaultManifest(manifest);
  if (!manifestCheck.ok) throw new Error(`manifest verification failed: ${manifestCheck.reason}`);
  const core = manifest.core;
  const fundingOutpoint = `${core.fundingOutpoint.txid}:${core.fundingOutpoint.vout}`;
  const keys = parseRecoveryKeys(keyText, fundingOutpoint);
  const operatorSecret = BigInt(`0x${keys.operatorSecret}`);
  const guardianSecret = BigInt(`0x${keys.guardianSecret}`);
  if (a.xOnlyPubkey(operatorSecret).toString('hex') !== core.operatorXonly) {
    throw new Error('operator recovery key does not match the vault manifest');
  }
  if (a.xOnlyPubkey(guardianSecret).toString('hex') !== core.guardianXonly) {
    throw new Error('guardian recovery key does not match the vault manifest');
  }
  const approval = artifact.guardianApproval;
  const approvalCheck = verifyGuardianApproval(approval, manifest);
  if (!approvalCheck.ok || !approvalCheck.approved) {
    throw new Error(`guardian approval is invalid: ${approvalCheck.reason || 'not approved'}`);
  }
  if (artifact.validSpend?.proposalHash !== approval.proposalHash) {
    throw new Error('approved proposal hash does not match the recorded spend');
  }
  const unsignedTxHex = String(artifact.validSpend?.unsignedHex || '').toLowerCase();
  const parsed = tr.parseTx(unsignedTxHex);
  if (parsed.vin.length !== 1 || parsed.vin[0].outpoint.toString('hex') !== tr.outpoint(core.fundingOutpoint.txid, core.fundingOutpoint.vout)) {
    throw new Error('recovery transaction does not spend the recorded vault outpoint');
  }
  const outputTotalSats = parsed.vout.reduce((sum, output) => sum + output.value, 0n);
  const feeSats = BigInt(core.amountSats) - outputTotalSats;
  if (feeSats < 0n) throw new Error('recovery transaction outputs exceed the vault amount');
  const leaf = core.leaves['immediate-operator-guardian'];
  const sighash = ts.scriptPathSighash(
    parsed,
    [{ scriptPubKey: core.p2trScriptPubKey, amountSats: core.amountSats }],
    0,
    Buffer.from(leaf.leafHash, 'hex')
  );
  if (approval.sighash !== sighash.toString('hex')) throw new Error('guardian approval sighash mismatch');
  if (!a.schnorrVerify(
    Buffer.from(core.guardianXonly, 'hex'),
    sighash,
    Buffer.from(approval.signature, 'hex')
  )) throw new Error('guardian approval signature is invalid');
  const operatorSignature = a.schnorrSign(operatorSecret, sighash).toString('hex');
  if (!a.schnorrVerify(Buffer.from(core.operatorXonly, 'hex'), sighash, Buffer.from(operatorSignature, 'hex'))) {
    throw new Error('operator recovery signature self-check failed');
  }
  const witness = [approval.signature, operatorSignature, leaf.scriptHex, leaf.controlBlock];
  const finalSpendHex = tr.serializeWitnessTx(
    parsed.version,
    parsed.vin.map((input) => ({
      outpoint: input.outpoint.toString('hex'),
      scriptSig: input.scriptSig.toString('hex'),
      sequence: input.sequence,
      witness
    })),
    parsed.vout.map((output) => ({ valueSats: output.value, script: output.script.toString('hex') })),
    parsed.locktime
  );
  return {
    kind: 'btc_testnet4_reserve_vault_recovery_package',
    manifestHash: manifest.manifestHash,
    vaultId: core.vaultId,
    fundingOutpoint,
    amountSats: String(core.amountSats),
    feeSats: feeSats.toString(),
    unsignedTxid: txidFromUnsignedHex(unsignedTxHex),
    unsignedTxHex,
    finalSpendHex,
    outputCount: parsed.vout.length,
    operatorSignatureVerified: true,
    guardianSignatureVerified: true
  };
}

async function run(args) {
  const artifactPath = path.resolve(args.artifact || DEFAULT_ARTIFACT);
  const keyFile = path.resolve(args.keyFile || DEFAULT_KEY_FILE);
  const receiptPath = path.resolve(args.receipt || DEFAULT_RECEIPT);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  const recovery = buildRecoverySpendPackage(artifact, fs.readFileSync(keyFile, 'utf8'));
  const { rpc } = resolveRpc(args);
  const chain = await rpc('getblockchaininfo');
  if (chain.chain !== 'testnet4') throw new Error(`wrong RPC chain: ${chain.chain}`);
  const [fundingTxid, voutText] = recovery.fundingOutpoint.split(':');
  const txout = await rpc('gettxout', [fundingTxid, Number(voutText), true]);
  let status;
  let mempoolAccept = null;
  let broadcastTxid = null;
  let currentlyCountableAsReserve = null;
  if (!txout) {
    const known = await rpc('getrawtransaction', [recovery.unsignedTxid, true]).catch(() => null);
    if (!known) throw new Error('vault outpoint is absent and the recovery transaction is unknown');
    status = known.confirmations > 0 ? 'already-confirmed' : 'already-in-mempool';
    broadcastTxid = recovery.unsignedTxid;
  } else {
    const chainCheck = verifyTaprootReserveVaultOnChain(artifact.manifest, {
      network: 'bitcoin-testnet4',
      currentHeight: chain.blocks,
      txout
    });
    const authenticButMature = !chainCheck.ok &&
      chainCheck.manifestCheck?.ok === true &&
      chainCheck.chainTxout?.present === true &&
      /recovery path is mature|recovery delay is inside risk margin/.test(chainCheck.reason || '');
    if (!chainCheck.ok && !authenticButMature) {
      throw new Error(`on-chain vault verification failed: ${chainCheck.reason}`);
    }
    currentlyCountableAsReserve = chainCheck.counted === true;
    [mempoolAccept] = await rpc('testmempoolaccept', [[recovery.finalSpendHex]]);
    if (!mempoolAccept.allowed) throw new Error(`recovery preflight rejected: ${mempoolAccept['reject-reason'] || 'unknown reason'}`);
    status = args.broadcast ? 'broadcast' : 'preflight-only';
    if (args.broadcast) {
      broadcastTxid = await rpc('sendrawtransaction', [recovery.finalSpendHex]);
      if (broadcastTxid !== recovery.unsignedTxid) throw new Error('broadcast txid differs from the preflight txid');
    }
  }
  const receipt = {
    kind: 'btc_testnet4_reserve_vault_recovery_receipt',
    version: 1,
    createdAt: new Date().toISOString(),
    network: 'bitcoin-testnet4',
    status,
    manifestHash: recovery.manifestHash,
    vaultId: recovery.vaultId,
    fundingOutpoint: recovery.fundingOutpoint,
    amountSats: recovery.amountSats,
    feeSats: recovery.feeSats,
    recoveryTxid: recovery.unsignedTxid,
    broadcastTxid,
    explorer: `https://mempool.space/testnet4/tx/${recovery.unsignedTxid}`,
    checks: {
      manifest: true,
      onChainOutpoint: Boolean(txout),
      currentlyCountableAsReserve,
      operatorSignature: recovery.operatorSignatureVerified,
      guardianSignature: recovery.guardianSignatureVerified,
      mempoolAccept: mempoolAccept?.allowed ?? null
    },
    mempoolAccept
  };
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
  return receipt;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
  } else {
    run(args).catch((err) => {
      console.error(`Bitcoin testnet4 vault recovery failed: ${err.message}`);
      process.exit(1);
    });
  }
}

module.exports = {
  parseRecoveryKeys,
  txidFromUnsignedHex,
  buildRecoverySpendPackage,
  run
};
