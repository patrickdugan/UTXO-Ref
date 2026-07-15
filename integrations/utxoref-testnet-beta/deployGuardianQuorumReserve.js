#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadPolicy } = require('./betaPolicy');
const { resolveRpc } = require('./server');
const adaptor = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const {
  buildGuardianQuorumVaultManifest,
  buildGuardianQuorumVaultTemplate,
  verifyGuardianQuorumVaultManifest
} = require('../../bitvm3/utxo_referee/utxoref_v2_guardian_quorum_reserve');

function parseArgs(argv) {
  const options = { amountSats: 10000, broadcast: false, reconcile: false };
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--registry') options.registryPath = path.resolve(argv[++index]);
    else if (argument === '--output') options.outputPath = path.resolve(argv[++index]);
    else if (argument === '--secret-dir') options.secretDir = path.resolve(argv[++index]);
    else if (argument === '--amount-sats') options.amountSats = Number(argv[++index]);
    else if (argument === '--broadcast') options.broadcast = true;
    else if (argument === '--reconcile') options.reconcile = true;
    else if (argument === '--help') options.help = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  if (!Number.isSafeInteger(options.amountSats) || options.amountSats < 1000 || options.amountSats > 1000000) {
    throw new Error('--amount-sats must be 1000..1000000');
  }
  if (options.broadcast && options.reconcile) throw new Error('--broadcast and --reconcile are mutually exclusive');
  return options;
}

function scalar() {
  while (true) {
    const candidate = adaptor.bufToBig(crypto.randomBytes(32));
    if (candidate > 0n && candidate < adaptor.N) return candidate;
  }
}

function loadOrCreateScalar(filePath) {
  if (fs.existsSync(filePath)) {
    const value = String(fs.readFileSync(filePath, 'utf8')).trim();
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${filePath} is not a scalar`);
    const parsed = BigInt(`0x${value}`);
    if (parsed <= 0n || parsed >= adaptor.N) throw new Error(`${filePath} is outside secp256k1 order`);
    return parsed;
  }
  const value = scalar();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${adaptor.bytes32(value).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_err) { /* Best effort on Windows. */ }
  return value;
}

function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

async function deploy(options, env = process.env) {
  if (!options.registryPath || !options.outputPath || !options.secretDir) {
    throw new Error('--registry, --output, and --secret-dir are required');
  }
  if (options.broadcast && fs.existsSync(options.outputPath)) {
    throw new Error('output already exists; refusing to fund another quorum reserve implicitly');
  }
  const registry = JSON.parse(fs.readFileSync(options.registryPath, 'utf8'));
  if (registry?.kind !== 'utxoref_beta_guardian_registry' || registry.version !== 1 ||
      !Array.isArray(registry.guardians) || registry.guardians.length < 2 || registry.quorum < 2) {
    throw new Error('guardian registry is invalid');
  }
  if (options.reconcile) return reconcile(options, registry, env);
  const operatorSecret = loadOrCreateScalar(path.join(options.secretDir, 'quorum_operator.hex'));
  const recoverySecret = loadOrCreateScalar(path.join(options.secretDir, 'quorum_recovery.hex'));
  const operatorXonly = adaptor.xOnlyPubkey(operatorSecret).toString('hex');
  const recoveryXonly = adaptor.xOnlyPubkey(recoverySecret).toString('hex');
  const guardianXonlys = registry.guardians.map((guardian) => guardian.guardianXonly);
  const template = buildGuardianQuorumVaultTemplate({
    network: 'bitcoin-testnet4',
    bindingHash: registry.graphHash,
    operatorXonly,
    guardianXonlys,
    guardianThreshold: registry.quorum,
    recoveryXonly,
    recoveryCsvDelay: 2016
  });
  const policy = loadPolicy(env);
  const rpc = resolveRpc(env);
  const decoded = await rpc('decodescript', [template.p2trScriptPubKey]);
  if (!decoded.address || !String(decoded.address).startsWith('tb1p')) {
    throw new Error('Bitcoin Core did not derive a testnet Taproot address for the quorum script');
  }
  const preview = {
    kind: 'utxoref_beta_guardian_quorum_reserve_deployment',
    version: 1,
    createdAt: new Date().toISOString(),
    network: 'bitcoin-testnet4',
    graphHash: registry.graphHash,
    guardianRegistry: path.basename(options.registryPath),
    guardianIds: registry.guardians.map((guardian) => guardian.guardianId),
    guardianXonlys,
    guardianThreshold: registry.quorum,
    guardianSetHash: template.guardianSetHash,
    operatorXonly,
    recoveryXonly,
    recoveryCsvDelay: template.recoveryCsvDelay,
    p2trAddress: decoded.address,
    p2trScriptPubKey: template.p2trScriptPubKey,
    amountSats: String(options.amountSats),
    broadcast: false
  };
  if (!options.broadcast) {
    saveJson(options.outputPath, preview);
    return preview;
  }
  const txid = await rpc('sendtoaddress', [
    decoded.address,
    options.amountSats / 100000000,
    `UTXORef guardian quorum ${template.guardianSetHash.slice(0, 16)}`,
    '',
    false,
    true,
    6,
    'economical'
  ], policy.wallet);
  const transaction = await rpc('getrawtransaction', [txid, true]);
  const vout = transaction.vout.find((output) => output.scriptPubKey?.hex === template.p2trScriptPubKey);
  if (!vout) throw new Error('funding transaction does not contain the guardian quorum script');
  const chain = await rpc('getblockchaininfo');
  const manifest = buildGuardianQuorumVaultManifest({
    network: 'bitcoin-testnet4',
    fundingOutpoint: { txid, vout: vout.n },
    amountSats: options.amountSats,
    observedAtHeight: Number(chain.blocks),
    reserveEpochId: `beta-guardian-quorum-${chain.blocks}`,
    bindingHash: registry.graphHash,
    operatorXonly,
    guardianXonlys,
    guardianThreshold: registry.quorum,
    recoveryXonly,
    recoveryCsvDelay: 2016,
    internalXonly: template.internalXonly
  });
  const verification = verifyGuardianQuorumVaultManifest(manifest, { currentHeight: Number(chain.blocks) });
  if (!verification.ok) throw new Error(`generated quorum manifest failed verification: ${verification.reason}`);
  const chainTxout = await rpc('gettxout', [txid, vout.n, true]);
  const artifact = {
    ...preview,
    broadcast: true,
    funding: {
      txid,
      vout: vout.n,
      outpoint: `${txid}:${vout.n}`,
      explorer: `https://mempool.space/testnet4/tx/${txid}`,
      confirmations: Number(chainTxout?.confirmations || 0),
      chainTxoutPresent: Boolean(chainTxout)
    },
    manifest,
    verification
  };
  saveJson(options.outputPath, artifact);
  return artifact;
}

async function reconcile(options, registry, env = process.env) {
  if (!fs.existsSync(options.outputPath)) throw new Error('reconcile output artifact does not exist');
  const artifact = JSON.parse(fs.readFileSync(options.outputPath, 'utf8'));
  if (artifact?.kind !== 'utxoref_beta_guardian_quorum_reserve_deployment' ||
      artifact.version !== 1 || artifact.broadcast !== true || !artifact.manifest?.core) {
    throw new Error('output is not a broadcast guardian reserve deployment');
  }
  const core = artifact.manifest.core;
  if (artifact.graphHash !== registry.graphHash || core.bindingHash !== registry.graphHash) {
    throw new Error('reserve artifact and registry graph do not match');
  }
  const rpc = resolveRpc(env);
  const chain = await rpc('getblockchaininfo');
  const txout = await rpc('gettxout', [core.fundingOutpoint.txid, core.fundingOutpoint.vout, true]);
  const confirmations = Number(txout?.confirmations || 0);
  if (!txout || confirmations < 1) throw new Error('guardian reserve is not confirmed and unspent');
  const amountSats = Math.round(Number(txout.value) * 100000000);
  if (String(amountSats) !== core.amountSats || txout.scriptPubKey?.hex !== core.p2trScriptPubKey) {
    throw new Error('guardian reserve chain amount or script does not match the artifact');
  }
  const fundingHeight = Number(chain.blocks) - confirmations + 1;
  const manifest = buildGuardianQuorumVaultManifest({
    network: core.network,
    fundingOutpoint: core.fundingOutpoint,
    amountSats,
    observedAtHeight: fundingHeight,
    reserveEpochId: core.reserveEpochId,
    vaultId: core.vaultId,
    bindingHash: core.bindingHash,
    operatorXonly: core.operatorXonly,
    guardianXonlys: core.guardianXonlys,
    guardianThreshold: core.guardianThreshold,
    recoveryXonly: core.recoveryXonly,
    recoveryCsvDelay: core.recoveryCsvDelay,
    internalXonly: core.internalXonly
  });
  const verification = verifyGuardianQuorumVaultManifest(manifest, { currentHeight: Number(chain.blocks) });
  if (!verification.ok || !verification.countable) {
    throw new Error(`reconciled quorum manifest failed verification: ${verification.reason}`);
  }
  const reconciled = {
    ...artifact,
    reconciledAt: new Date().toISOString(),
    funding: { ...artifact.funding, confirmations, chainTxoutPresent: true, fundingHeight },
    manifest,
    verification
  };
  saveJson(options.outputPath, reconciled);
  return reconciled;
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log('Usage: node deployGuardianQuorumReserve.js --registry PATH --output PATH --secret-dir PATH [--amount-sats N] [--broadcast|--reconcile]');
    return;
  }
  console.log(JSON.stringify(await deploy(options), null, 2));
}

if (require.main === module) main().catch((err) => {
  console.error(`Guardian quorum deployment failed: ${err.message}`);
  process.exit(1);
});

module.exports = { parseArgs, scalar, loadOrCreateScalar, deploy, reconcile };
