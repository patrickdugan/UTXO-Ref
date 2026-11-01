/**
 * BTC testnet4 Taproot reserve vaults.
 *
 * This is not a covenant. The on-chain encumbrance is a tapscript policy:
 *   - normal reserve spend: operator signature AND watchtower guardian signature
 *   - recovery spend: operator signature after a CSV timeout
 *
 * The reserve layer only counts a vault when its manifest matches the live
 * chain UTXO and the recovery path is still safely before maturity.
 */

const crypto = require('crypto');
const { stableStringify, sha256Hex, addressToScriptPubKey } = require('./tradelayer_pnl_route_adapter');
const { verifyTradeLayerWithdrawalQueue } = require('./tradelayer_withdrawal_queue_referee');
const { toSats, decimalToUnits, heightOf } = require('./money');
const { pushScriptNum, csvSequence } = require('./csv_delay');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const { buildTaprootTree, controlBlockWithPath } = require('./tradelayer_taproot_tree');
const a = require('./tradelayer_dlc_adaptor_sig');

const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_DROP = 0x75;
const OP_CHECKSIGVERIFY = 0xad;
const OP_CHECKSIG = 0xac;
const OP_PUSH32 = 0x20;

const DEFAULT_NETWORK = 'bitcoin-testnet4';
const DEFAULT_RECOVERY_CSV_DELAY = 2016;
const DEFAULT_RECOVERY_RISK_MARGIN_BLOCKS = 144;
const DEFAULT_GUARDIAN_MAX_FEE_SATS = 5000n;
const DEFAULT_GUARDIAN_MAX_FEE_BPS = 500;

function normalizeNetwork(network) {
  const n = String(network || DEFAULT_NETWORK).toLowerCase();
  if (n === 'testnet4' || n === 'bitcoin-testnet4' || n === 'btc-testnet4') return 'bitcoin-testnet4';
  if (n === 'test' || n === 'testnet' || n === 'bitcoin-testnet') return 'bitcoin-testnet';
  if (n === 'regtest' || n === 'bitcoin-regtest') return 'bitcoin-regtest';
  if (n === 'main' || n === 'mainnet' || n === 'bitcoin') return 'bitcoin';
  return n;
}

function assertHex(value, bytes, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  }
  return text;
}

function assertXonly(value, fieldName) {
  const text = assertHex(value, 32, fieldName);
  try {
    a.liftX(a.bufToBig(Buffer.from(text, 'hex')));
  } catch (err) {
    throw new Error(`${fieldName} is not a valid x-only secp256k1 pubkey: ${err.message}`);
  }
  return text;
}

function normalizeFundingOutpoint(outpoint) {
  if (typeof outpoint === 'string') {
    const [txid, voutText] = outpoint.split(':');
    return normalizeFundingOutpoint({ txid, vout: Number(voutText) });
  }
  if (!outpoint || typeof outpoint !== 'object') {
    throw new Error('fundingOutpoint is required');
  }
  const txid = assertHex(outpoint.txid, 32, 'fundingOutpoint.txid');
  const vout = Number(outpoint.vout);
  if (!Number.isInteger(vout) || vout < 0) throw new Error('fundingOutpoint.vout must be a non-negative integer');
  return { txid, vout };
}

function outpointKey(outpoint) {
  const o = normalizeFundingOutpoint(outpoint);
  return `${o.txid}:${o.vout}`;
}

function deriveReserveVaultInternalXonly(network = DEFAULT_NETWORK) {
  const normalized = normalizeNetwork(network);
  for (let counter = 0; counter < 1024; counter++) {
    const candidate = crypto
      .createHash('sha256')
      .update(`UTXORef reserve vault NUMS internal key v1:${normalized}:${counter}`, 'utf8')
      .digest();
    try {
      a.liftX(a.bufToBig(candidate));
      return candidate.toString('hex');
    } catch (_err) {
      // Try the next x-coordinate. About half are valid curve x values.
    }
  }
  throw new Error('failed to derive reserve vault internal key');
}

// The reserve output must not have a key path. The internal key is always the
// deterministic NUMS point for the network; a caller (or a manifest under
// verification) may restate it, but any other key is rejected, because its
// holder could spend the reserve alone with no guardian and no CSV.
function requireReserveVaultInternalXonly(network, suppliedInternalXonly) {
  const derived = deriveReserveVaultInternalXonly(network);
  if (suppliedInternalXonly !== undefined && suppliedInternalXonly !== null && suppliedInternalXonly !== '' &&
      assertHex(suppliedInternalXonly, 32, 'internalXonly') !== derived) {
    throw new Error('custom internal key is forbidden; the reserve vault requires the deterministic NUMS key');
  }
  return derived;
}

function bindingPrefix(bindingHash) {
  if (bindingHash === undefined || bindingHash === null || bindingHash === '') return Buffer.alloc(0);
  return Buffer.concat([
    Buffer.from([OP_PUSH32]),
    Buffer.from(assertHex(bindingHash, 32, 'bindingHash'), 'hex'),
    Buffer.from([OP_DROP])
  ]);
}

function buildImmediateLeafScript(operatorXonly, guardianXonly, bindingHash = null) {
  const op = Buffer.from(assertXonly(operatorXonly, 'operatorXonly'), 'hex');
  const guardian = Buffer.from(assertXonly(guardianXonly, 'guardianXonly'), 'hex');
  return Buffer.concat([
    bindingPrefix(bindingHash),
    Buffer.from([OP_PUSH32]), op,
    Buffer.from([OP_CHECKSIGVERIFY, OP_PUSH32]), guardian,
    Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

function buildRecoveryLeafScript(operatorXonly, recoveryCsvDelay = DEFAULT_RECOVERY_CSV_DELAY, bindingHash = null) {
  const op = Buffer.from(assertXonly(operatorXonly, 'recoveryXonly'), 'hex');
  return Buffer.concat([
    bindingPrefix(bindingHash),
    pushScriptNum(csvSequence(recoveryCsvDelay)),
    Buffer.from([OP_CHECKSEQUENCEVERIFY, OP_DROP, OP_PUSH32]), op,
    Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

function buildTaprootReserveVaultTemplate(input = {}) {
  const network = normalizeNetwork(input.network || DEFAULT_NETWORK);
  const operatorXonly = assertXonly(input.operatorXonly, 'operatorXonly');
  const guardianXonly = assertXonly(input.guardianXonly, 'guardianXonly');
  const recoveryXonly = assertXonly(input.recoveryXonly || operatorXonly, 'recoveryXonly');
  const bindingHash = input.bindingHash ? assertHex(input.bindingHash, 32, 'bindingHash') : null;
  const recoveryCsvDelay = csvSequence(input.recoveryCsvDelay ?? DEFAULT_RECOVERY_CSV_DELAY, 'recoveryCsvDelay');
  const internalXonly = requireReserveVaultInternalXonly(network, input.internalXonly);

  const immediateScript = buildImmediateLeafScript(operatorXonly, guardianXonly, bindingHash);
  const recoveryScript = buildRecoveryLeafScript(recoveryXonly, recoveryCsvDelay, bindingHash);
  const tree = buildTaprootTree([
    { kind: 'immediate-operator-guardian', scriptHex: immediateScript },
    { kind: 'recovery-operator-csv', scriptHex: recoveryScript }
  ]);
  const tweak = ts.taprootTweakWithRoot(Buffer.from(internalXonly, 'hex'), tree.root);
  const p2trScriptPubKey = ts
    .taprootScriptPubKeyWithRoot(Buffer.from(internalXonly, 'hex'), tree.root)
    .toString('hex');

  const leaves = {};
  for (const leaf of tree.leaves) {
    leaves[leaf.kind] = {
      kind: leaf.kind,
      leafVersion: leaf.leafVersion,
      scriptHex: leaf.scriptHex,
      leafHash: leaf.leafHash.toString('hex'),
      controlBlock: controlBlockWithPath(
        Buffer.from(internalXonly, 'hex'),
        tweak.parity,
        leaf.leafVersion,
        leaf.path
      ).toString('hex')
    };
  }

  return {
    network,
    bindingHash,
    recoveryXonly,
    internalXonly,
    merkleRoot: tree.root.toString('hex'),
    p2trScriptPubKey,
    leaves,
    immediateLeaf: leaves['immediate-operator-guardian'],
    recoveryLeaf: leaves['recovery-operator-csv']
  };
}

function buildTaprootReserveVaultManifest(input = {}) {
  const network = normalizeNetwork(input.network || DEFAULT_NETWORK);
  const fundingOutpoint = normalizeFundingOutpoint(input.fundingOutpoint);
  const amountSats = toSats(input.amountSats, 'amountSats');
  if (amountSats <= 0n) throw new Error('amountSats must be positive');
  const observedAtHeight = heightOf(input.observedAtHeight, 'observedAtHeight');
  if (!Number.isInteger(observedAtHeight) || observedAtHeight < 0) {
    throw new Error('observedAtHeight must be a non-negative integer');
  }
  const recoveryCsvDelay = csvSequence(input.recoveryCsvDelay ?? DEFAULT_RECOVERY_CSV_DELAY, 'recoveryCsvDelay');
  const operatorXonly = assertXonly(input.operatorXonly, 'operatorXonly');
  const guardianXonly = assertXonly(input.guardianXonly, 'guardianXonly');
  const recoveryXonly = assertXonly(input.recoveryXonly || operatorXonly, 'recoveryXonly');
  const bindingHash = input.bindingHash ? assertHex(input.bindingHash, 32, 'bindingHash') : null;
  const reserveEpochId = String(input.reserveEpochId ?? input.epochId ?? '0');
  const vaultIdPreimage = {
    network,
    fundingOutpoint,
    amountSats: amountSats.toString(),
    operatorXonly,
    guardianXonly,
    reserveEpochId
  };
  if (recoveryXonly !== operatorXonly) vaultIdPreimage.recoveryXonly = recoveryXonly;
  if (bindingHash) vaultIdPreimage.bindingHash = bindingHash;
  const vaultId = String(input.vaultId || sha256Hex(vaultIdPreimage).slice(0, 32));

  const template = buildTaprootReserveVaultTemplate({
    network,
    operatorXonly,
    guardianXonly,
    recoveryXonly,
    bindingHash,
    recoveryCsvDelay,
    internalXonly: input.internalXonly
  });
  const p2trScriptPubKey = String(input.p2trScriptPubKey || template.p2trScriptPubKey).toLowerCase();
  if (p2trScriptPubKey !== template.p2trScriptPubKey) {
    throw new Error('p2trScriptPubKey does not match reserve vault scripts');
  }

  const core = {
    kind: 'taproot_reserve_vault_manifest_v1',
    network,
    vaultId,
    fundingOutpoint,
    amountSats: amountSats.toString(),
    operatorXonly,
    guardianXonly,
    internalXonly: template.internalXonly,
    p2trScriptPubKey,
    observedAtHeight,
    recoveryCsvDelay,
    reserveEpochId,
    merkleRoot: template.merkleRoot,
    leaves: template.leaves
  };
  if (recoveryXonly !== operatorXonly) core.recoveryXonly = recoveryXonly;
  if (bindingHash) core.bindingHash = bindingHash;

  return {
    kind: 'taproot_reserve_vault_manifest',
    manifestHash: sha256Hex(core),
    core
  };
}

function recoveryStatus(manifest, options = {}) {
  const core = manifest.core || manifest;
  const currentHeight = options.currentHeight;
  if (currentHeight === undefined || currentHeight === null) {
    return {
      checked: false,
      countable: false,
      reason: 'currentHeight is required to check recovery freshness',
      observedAtHeight: heightOf(core.observedAtHeight, 'observedAtHeight'),
      maturityHeight: heightOf(core.observedAtHeight, 'observedAtHeight') + csvSequence(core.recoveryCsvDelay, 'recoveryCsvDelay'),
      remainingBlocks: null,
      riskMarginBlocks: heightOf(options.recoveryRiskMarginBlocks ?? DEFAULT_RECOVERY_RISK_MARGIN_BLOCKS, 'recoveryRiskMarginBlocks')
    };
  }
  const height = heightOf(currentHeight, 'currentHeight');
  const observedAtHeight = heightOf(core.observedAtHeight, 'observedAtHeight');
  const recoveryCsvDelay = csvSequence(core.recoveryCsvDelay, 'recoveryCsvDelay');
  const riskMarginBlocks = heightOf(options.recoveryRiskMarginBlocks ?? DEFAULT_RECOVERY_RISK_MARGIN_BLOCKS, 'recoveryRiskMarginBlocks');
  const maturityHeight = observedAtHeight + recoveryCsvDelay;
  const riskHeight = maturityHeight - riskMarginBlocks;
  const remainingBlocks = maturityHeight - height;

  if (!Number.isInteger(height) || height < 0) {
    return { checked: true, countable: false, reason: 'invalid currentHeight', observedAtHeight, maturityHeight, remainingBlocks, riskMarginBlocks };
  }
  if (height < observedAtHeight) {
    return { checked: true, countable: false, reason: 'currentHeight precedes observedAtHeight', observedAtHeight, maturityHeight, remainingBlocks, riskMarginBlocks };
  }
  if (height >= maturityHeight) {
    return { checked: true, countable: false, reason: 'recovery path is mature', observedAtHeight, maturityHeight, remainingBlocks, riskMarginBlocks };
  }
  if (height >= riskHeight) {
    return { checked: true, countable: false, reason: 'recovery path inside risk window', observedAtHeight, maturityHeight, remainingBlocks, riskMarginBlocks };
  }
  return { checked: true, countable: true, reason: null, observedAtHeight, maturityHeight, remainingBlocks, riskMarginBlocks };
}

function verifyTaprootReserveVaultManifest(manifest, options = {}) {
  if (!manifest || manifest.kind !== 'taproot_reserve_vault_manifest') {
    return { ok: false, reason: 'wrong vault manifest kind' };
  }
  if (!manifest.core || typeof manifest.core !== 'object') {
    return { ok: false, reason: 'vault manifest core missing' };
  }
  const core = manifest.core;
  const manifestHash = sha256Hex(core);
  if (manifest.manifestHash !== manifestHash) {
    return { ok: false, reason: 'vault manifest hash mismatch', manifestHash };
  }

  let template;
  try {
    normalizeFundingOutpoint(core.fundingOutpoint);
    toSats(core.amountSats, 'manifest.amountSats');
    template = buildTaprootReserveVaultTemplate({
      network: core.network,
      operatorXonly: core.operatorXonly,
      guardianXonly: core.guardianXonly,
      recoveryXonly: core.recoveryXonly || core.operatorXonly,
      bindingHash: core.bindingHash || null,
      recoveryCsvDelay: core.recoveryCsvDelay,
      internalXonly: core.internalXonly
    });
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  if (normalizeNetwork(core.network) !== template.network) return { ok: false, reason: 'network mismatch' };
  if (core.p2trScriptPubKey !== template.p2trScriptPubKey) return { ok: false, reason: 'p2tr scriptPubKey mismatch' };
  if (core.merkleRoot !== template.merkleRoot) return { ok: false, reason: 'taproot merkle root mismatch' };
  for (const kind of ['immediate-operator-guardian', 'recovery-operator-csv']) {
    if (stableStringify(core.leaves?.[kind]) !== stableStringify(template.leaves[kind])) {
      return { ok: false, reason: `${kind} leaf mismatch` };
    }
  }

  const recovery = recoveryStatus(manifest, options);
  return {
    ok: true,
    manifestHash,
    vaultId: core.vaultId,
    p2trScriptPubKey: core.p2trScriptPubKey,
    countable: recovery.countable,
    recoveryStatus: recovery
  };
}

function normalizeChainTxoutForEvidence(txout) {
  if (!txout) return { present: false };
  const scriptPubKey = typeof txout.scriptPubKey === 'string'
    ? txout.scriptPubKey
    : txout.scriptPubKey?.hex;
  const valueSats = txout.valueSats !== undefined
    ? toSats(txout.valueSats, 'txout.valueSats')
    : decimalToUnits(txout.value, 'txout.value');
  return {
    present: true,
    valueSats: valueSats.toString(),
    scriptPubKey: String(scriptPubKey || '').toLowerCase(),
    confirmations: txout.confirmations ?? null,
    bestblock: txout.bestblock || null
  };
}

// The CSV anchor is the height the funding UTXO confirmed at. The node reports
// confirmations rather than a height, so the height is the tip minus the depth
// plus one. A manifest cannot move it later: its observedAtHeight may not be
// after this height (see verifyTaprootReserveVaultOnChain).
function fundingConfirmationHeight(txout, currentHeight) {
  const confirmations = Number(txout.confirmations);
  if (!Number.isInteger(confirmations) || confirmations < 1) return { error: 'vault UTXO is not confirmed' };
  const tip = heightOf(currentHeight, 'currentHeight');
  if (!Number.isInteger(tip) || tip < 0) return { error: 'chain tip height is required to anchor the vault' };
  return { height: tip - confirmations + 1 };
}

function verifyTaprootReserveVaultOnChain(manifest, options = {}) {
  const manifestCheck = verifyTaprootReserveVaultManifest(manifest, options);
  if (!manifestCheck.ok) return { ok: false, counted: false, reason: manifestCheck.reason, manifestCheck };
  const core = manifest.core;
  const expectedNetwork = normalizeNetwork(options.network || core.network);
  if (normalizeNetwork(core.network) !== expectedNetwork) {
    return { ok: false, counted: false, reason: 'vault network mismatch', manifestCheck };
  }

  const txout = normalizeChainTxoutForEvidence(options.txout);
  if (!txout.present) {
    return { ok: false, counted: false, reason: 'vault UTXO spent or missing', manifestCheck, chainTxout: txout };
  }
  const expectedAmount = toSats(core.amountSats, 'manifest.amountSats').toString();
  if (txout.valueSats !== expectedAmount) {
    return {
      ok: false,
      counted: false,
      reason: 'vault UTXO amount mismatch',
      manifestCheck,
      chainTxout: txout,
      expectedAmountSats: expectedAmount,
      actualAmountSats: txout.valueSats
    };
  }
  if (txout.scriptPubKey !== core.p2trScriptPubKey) {
    return {
      ok: false,
      counted: false,
      reason: 'vault UTXO scriptPubKey mismatch',
      manifestCheck,
      chainTxout: txout,
      expectedScriptPubKey: core.p2trScriptPubKey,
      actualScriptPubKey: txout.scriptPubKey
    };
  }
  const anchor = fundingConfirmationHeight(txout, options.currentHeight);
  if (anchor.error) {
    return { ok: false, counted: false, reason: anchor.error, manifestCheck, chainTxout: txout };
  }
  // Recovery maturity is computed from observedAtHeight. A manifest written
  // before its funding confirmed names the tip it was built at, an earlier
  // height, which only brings the computed maturity forward (conservative). A
  // later height would push it past the real maturity, so it is refused.
  if (heightOf(core.observedAtHeight, 'observedAtHeight') > anchor.height) {
    return {
      ok: false,
      counted: false,
      reason: 'observedAtHeight is after the funding UTXO confirmation height',
      manifestCheck,
      chainTxout: txout,
      confirmationHeight: anchor.height
    };
  }
  if (!manifestCheck.countable) {
    return {
      ok: false,
      counted: false,
      reason: manifestCheck.recoveryStatus.reason,
      manifestCheck,
      chainTxout: txout
    };
  }
  return {
    ok: true,
    counted: true,
    reason: null,
    amountSats: expectedAmount,
    manifestCheck,
    chainTxout: txout
  };
}

function chainTxoutForManifest(manifest, chainTxouts, index) {
  if (Array.isArray(chainTxouts)) return chainTxouts[index];
  if (chainTxouts && typeof chainTxouts === 'object') {
    if (!manifest?.core?.fundingOutpoint) return null;
    return chainTxouts[outpointKey(manifest.core.fundingOutpoint)];
  }
  return null;
}

function buildTaprootReserveVaultSet(input = {}) {
  const manifests = input.manifests || input.vaultManifests || [];
  if (!Array.isArray(manifests)) throw new Error('manifests must be an array');
  const network = normalizeNetwork(input.network || manifests[0]?.core?.network || DEFAULT_NETWORK);
  const currentHeight = input.currentHeight !== undefined ? heightOf(input.currentHeight, 'currentHeight') : null;
  if (!Number.isInteger(currentHeight) || currentHeight < 0) {
    throw new Error('currentHeight is required for taproot reserve vault sets');
  }
  const reserveEpochId = String(input.reserveEpochId ?? manifests[0]?.core?.reserveEpochId ?? '0');
  const recoveryRiskMarginBlocks = heightOf(input.recoveryRiskMarginBlocks ?? DEFAULT_RECOVERY_RISK_MARGIN_BLOCKS, 'recoveryRiskMarginBlocks');
  let reservedSats = 0n;
  // One funding outpoint backs at most one counted vault. A second manifest naming
  // the same UTXO is kept in the set as rejected, so the reserve is not counted twice.
  const countedOutpoints = new Set();
  const vaults = manifests.map((manifest, index) => {
    const txout = chainTxoutForManifest(manifest, input.chainTxouts || input.txouts, index);
    const outpoint = manifest?.core?.fundingOutpoint ? outpointKey(manifest.core.fundingOutpoint) : null;
    const verification = outpoint !== null && countedOutpoints.has(outpoint)
      ? { ok: false, counted: false, reason: 'duplicate funding outpoint' }
      : verifyTaprootReserveVaultOnChain(manifest, {
        txout,
        currentHeight,
        network,
        recoveryRiskMarginBlocks
      });
    if (verification.counted) {
      reservedSats += toSats(verification.amountSats, 'verification.amountSats');
      countedOutpoints.add(outpoint);
    }
    return {
      vaultId: manifest?.core?.vaultId || null,
      outpoint: manifest?.core?.fundingOutpoint ? outpointKey(manifest.core.fundingOutpoint) : null,
      manifest,
      chainTxout: normalizeChainTxoutForEvidence(txout),
      verification: {
        ok: verification.ok,
        counted: verification.counted,
        reason: verification.reason,
        amountSats: verification.amountSats || null,
        recoveryStatus: verification.manifestCheck?.recoveryStatus || null
      }
    };
  });
  const countedVaults = vaults.filter((v) => v.verification.counted);
  const rejectedVaults = vaults.filter((v) => !v.verification.counted);
  const core = {
    kind: 'taproot_reserve_vault_set_v1',
    network,
    reserveEpochId,
    currentHeight,
    recoveryRiskMarginBlocks,
    vaultCount: vaults.length,
    countedVaultCount: countedVaults.length,
    rejectedVaultCount: rejectedVaults.length,
    reservedSats: reservedSats.toString(),
    vaults
  };
  return {
    kind: 'taproot-reserve-vault-set',
    vaultSetHash: sha256Hex(core),
    network,
    reserveEpochId,
    currentHeight,
    recoveryRiskMarginBlocks,
    reservedSats: reservedSats.toString(),
    countedVaultCount: countedVaults.length,
    rejectedVaultCount: rejectedVaults.length,
    core
  };
}

// The tip height and every confirmation count come from one chain snapshot.
// Each anchor is tip - confirmations + 1, so a block arriving between reading
// the tip and reading a UTXO would shift that anchor by one. Every gettxout must
// report the tip getblockchaininfo named, or the snapshot is taken again. The
// height is never taken from the caller for the same reason.
const RESERVE_SNAPSHOT_ATTEMPTS = 3;

async function buildTaprootReserveVaultSetFromRpc(input = {}) {
  if (typeof input.rpc !== 'function') throw new Error('rpc function is required');
  const rpc = input.rpc;
  for (let attempt = 1; ; attempt++) {
    const chain = await rpc('getblockchaininfo');
    const currentHeight = heightOf(chain.blocks, 'blocks');
    const chainTxouts = {};
    let tipMoved = false;
    for (const manifest of input.manifests || []) {
      const txout = await rpc('gettxout', [
        manifest.core.fundingOutpoint.txid,
        Number(manifest.core.fundingOutpoint.vout),
        true
      ]);
      if (txout && txout.bestblock !== chain.bestblockhash) { tipMoved = true; break; }
      chainTxouts[outpointKey(manifest.core.fundingOutpoint)] = txout;
    }
    if (!tipMoved) {
      return buildTaprootReserveVaultSet({ ...input, currentHeight, chainTxouts });
    }
    if (attempt >= RESERVE_SNAPSHOT_ATTEMPTS) {
      throw new Error(`chain tip moved during each of ${RESERVE_SNAPSHOT_ATTEMPTS} reserve snapshot attempts`);
    }
  }
}

function reservedSatsFromTaprootReserveVaultSet(vaultSet) {
  if (!vaultSet || vaultSet.kind !== 'taproot-reserve-vault-set') {
    throw new Error('reserve source must be taproot-reserve-vault-set');
  }
  const rebuilt = buildTaprootReserveVaultSet({
    manifests: (vaultSet.core?.vaults || vaultSet.vaults || []).map((v) => v.manifest || v),
    chainTxouts: Object.fromEntries((vaultSet.core?.vaults || vaultSet.vaults || []).map((v) => [
      v.outpoint || (v.manifest?.core?.fundingOutpoint ? outpointKey(v.manifest.core.fundingOutpoint) : ''),
      v.chainTxout
    ]).filter(([key]) => key)),
    network: vaultSet.network || vaultSet.core?.network,
    reserveEpochId: vaultSet.reserveEpochId || vaultSet.core?.reserveEpochId,
    currentHeight: vaultSet.currentHeight ?? vaultSet.core?.currentHeight,
    recoveryRiskMarginBlocks: vaultSet.recoveryRiskMarginBlocks ?? vaultSet.core?.recoveryRiskMarginBlocks
  });
  return {
    reservedSats: toSats(rebuilt.reservedSats, 'vaultSet.reservedSats'),
    countedVaultCount: rebuilt.countedVaultCount,
    rejectedVaultCount: rebuilt.rejectedVaultCount,
    vaultSetHash: rebuilt.vaultSetHash
  };
}

function normalizeTxOutputsFromParsed(txParsed) {
  return txParsed.vout.map((output, index) => ({
    n: index,
    valueSats: output.value.toString(),
    scriptPubKey: output.script.toString('hex')
  }));
}

function outputVectorHashFromParsed(txParsed) {
  return sha256Hex({
    kind: 'taproot_reserve_vault_tx_outputs_v1',
    outputs: normalizeTxOutputsFromParsed(txParsed)
  });
}

function normalizeExpectedOutputs(outputs) {
  if (!Array.isArray(outputs) || !outputs.length) throw new Error('expectedOutputs must be a non-empty array');
  return outputs.map((output, index) => ({
    n: index,
    valueSats: toSats(output.valueSats ?? output.sats, `expectedOutputs[${index}].valueSats`).toString(),
    scriptPubKey: String(output.scriptPubKey || output.script || '').toLowerCase()
  }));
}

function txOutputsEqualExpected(txParsed, expectedOutputs) {
  const actual = normalizeTxOutputsFromParsed(txParsed);
  const expected = normalizeExpectedOutputs(expectedOutputs);
  return stableStringify(actual) === stableStringify(expected);
}

function buildVaultSpendProposal(input = {}) {
  if (!input.unsignedTxHex) throw new Error('unsignedTxHex is required');
  const txParsed = tr.parseTx(input.unsignedTxHex);
  const inputIndex = Number(input.inputIndex || 0);
  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= txParsed.vin.length) {
    throw new Error('inputIndex out of range');
  }
  const core = {
    kind: 'taproot_reserve_vault_spend_proposal_v1',
    vaultId: input.manifest?.core?.vaultId || input.vaultId || null,
    unsignedTxHex: String(input.unsignedTxHex).toLowerCase(),
    inputIndex,
    expectedOutputs: input.expectedOutputs ? normalizeExpectedOutputs(input.expectedOutputs) : null,
    routePlanHash: input.routePlanHash || input.routePlan?.planHash || null,
    reserveReconciliationHash: input.reserveReconciliation?.reconciliationHash || input.reserveReconciliationHash || null,
    withdrawalQueueHash: input.withdrawalQueue?.queueHash || input.withdrawalQueueHash || null
  };
  return {
    kind: 'taproot_reserve_vault_spend_proposal',
    proposalHash: sha256Hex(core),
    approvedTxOutputHash: outputVectorHashFromParsed(txParsed),
    core
  };
}

// The guardian signs only the transaction its proposal names, and only if the proposal
// is the one that was hashed.
function proposalIntegrityReason(proposal, txParsed) {
  if (!proposal?.core || sha256Hex(proposal.core) !== proposal.proposalHash) return 'proposal hash mismatch';
  if (proposal.approvedTxOutputHash !== outputVectorHashFromParsed(txParsed)) {
    return 'approved output hash does not match the transaction';
  }
  return null;
}

// The spend pays each payable withdrawal of the verified queue once, at its committed
// amount and script, and may return the remainder in one output to the queue's committed
// residual destination. Nothing else may be paid.
function committedOutputsMismatch(txParsed, withdrawalQueue, network) {
  const verified = verifyTradeLayerWithdrawalQueue(withdrawalQueue);
  if (!verified.ok) return `invalid withdrawal queue: ${verified.reason}`;
  const { queueCore } = withdrawalQueue;
  const payable = new Set(queueCore.payableRequestIds);
  const unmatchedPayouts = queueCore.entries
    .filter((entry) => payable.has(entry.id))
    .map((entry) => `${addressToScriptPubKey(entry.address, network).toString('hex')}:${entry.sats}`);
  const residualOutputs = [];
  for (const output of normalizeTxOutputsFromParsed(txParsed)) {
    const index = unmatchedPayouts.indexOf(`${output.scriptPubKey}:${output.valueSats}`);
    if (index >= 0) unmatchedPayouts.splice(index, 1);
    else residualOutputs.push(output);
  }
  if (unmatchedPayouts.length > 0) return 'transaction omits committed payouts';
  if (residualOutputs.length > 1 || residualOutputs.some((output) => output.scriptPubKey !== queueCore.residualDestHex)) {
    return 'transaction pays outputs the queue did not commit';
  }
  return null;
}

function guardianPolicyChecks(input, txParsed, manifestCheck, reconciliationCheck) {
  const manifest = input.manifest;
  const core = manifest.core;
  const inputSats = toSats(core.amountSats, 'manifest.amountSats');
  const outputSats = txParsed.vout.reduce((sum, output) => sum + BigInt(output.value), 0n);
  const feeSats = inputSats - outputSats;
  const policy = input.policy || {};
  const maxFeeSats = toSats(policy.maxFeeSats ?? DEFAULT_GUARDIAN_MAX_FEE_SATS.toString(), 'policy.maxFeeSats');
  const maxFeeBps = heightOf(policy.maxFeeBpsOfInput ?? DEFAULT_GUARDIAN_MAX_FEE_BPS, 'maxFeeBpsOfInput');
  const maxFeeByBps = (inputSats * BigInt(maxFeeBps)) / 10000n;
  const effectiveFeeCap = maxFeeSats < maxFeeByBps ? maxFeeSats : maxFeeByBps;
  const checks = [];
  function add(name, ok, details = {}) {
    checks.push({ name, ok: !!ok, details });
  }

  add('vault_manifest', manifestCheck.ok && manifestCheck.counted, {
    reason: manifestCheck.reason,
    counted: manifestCheck.counted === true
  });
  add('reserve_solvency', reconciliationCheck.ok && reconciliationCheck.solvent === true, {
    reason: reconciliationCheck.reason || null,
    solvent: reconciliationCheck.solvent === true,
    reconciliationHash: input.reserveReconciliation?.reconciliationHash || null
  });
  const integrityIssue = proposalIntegrityReason(input.proposal, txParsed);
  add('proposal_integrity', !integrityIssue, { reason: integrityIssue });
  const payoutIssue = committedOutputsMismatch(txParsed, input.withdrawalQueue, core.network);
  add('committed_outputs', !payoutIssue, { reason: payoutIssue });
  add('expected_outputs', txOutputsEqualExpected(txParsed, input.proposal.core.expectedOutputs || input.expectedOutputs), {
    approvedTxOutputHash: outputVectorHashFromParsed(txParsed)
  });
  add('fee_non_negative', feeSats >= 0n, {
    inputSats: inputSats.toString(),
    outputSats: outputSats.toString(),
    feeSats: feeSats.toString()
  });
  add('fee_cap', feeSats >= 0n && feeSats <= effectiveFeeCap, {
    feeSats: feeSats.toString(),
    maxFeeSats: maxFeeSats.toString(),
    maxFeeBpsOfInput: maxFeeBps,
    effectiveFeeCapSats: effectiveFeeCap.toString()
  });

  const failedChecks = checks.filter((check) => !check.ok).map((check) => check.name);
  const corePolicy = {
    kind: 'taproot_reserve_vault_guardian_policy_v1',
    checks
  };
  return {
    ok: failedChecks.length === 0,
    failedChecks,
    checks,
    policyHash: sha256Hex(corePolicy)
  };
}

function approveTaprootReserveVaultSpend(input = {}) {
  if (!input.manifest) throw new Error('manifest is required');
  if (!input.guardianSecret) throw new Error('guardianSecret is required');
  const guardianSecret = typeof input.guardianSecret === 'bigint'
    ? input.guardianSecret
    : a.bufToBig(Buffer.from(String(input.guardianSecret).replace(/^0x/, ''), 'hex'));
  const guardianXonly = a.xOnlyPubkey(guardianSecret).toString('hex');
  if (guardianXonly !== input.manifest.core.guardianXonly) {
    throw new Error('guardianSecret does not match manifest guardianXonly');
  }

  const proposal = input.proposal || buildVaultSpendProposal({
    manifest: input.manifest,
    unsignedTxHex: input.unsignedTxHex,
    inputIndex: input.inputIndex,
    expectedOutputs: input.expectedOutputs,
    routePlan: input.routePlan,
    reserveReconciliation: input.reserveReconciliation,
    withdrawalQueue: input.withdrawalQueue
  });
  const txParsed = tr.parseTx(proposal.core.unsignedTxHex);
  const inputIndex = Number(proposal.core.inputIndex || 0);
  const manifestCheck = verifyTaprootReserveVaultOnChain(input.manifest, {
    txout: input.vaultTxout,
    currentHeight: input.currentHeight,
    network: input.manifest.core.network,
    recoveryRiskMarginBlocks: input.recoveryRiskMarginBlocks
  });
  const {
    verifyTradeLayerReserveReconciliation
  } = require('./tradelayer_reserve_reconciliation_referee');
  const reconciliationCheck = input.reserveReconciliation
    ? verifyTradeLayerReserveReconciliation(input.reserveReconciliation, input.withdrawalQueue, {
        currentHeight: input.currentHeight,
        reserve: input.reserveEvidence
      })
    : { ok: false, reason: 'missing reserve reconciliation', solvent: false };
  const policyResult = guardianPolicyChecks({
    ...input,
    proposal
  }, txParsed, manifestCheck, reconciliationCheck);
  const outputHash = outputVectorHashFromParsed(txParsed);
  const base = {
    kind: 'taproot_reserve_vault_guardian_approval',
    vaultId: input.manifest.core.vaultId,
    proposalHash: proposal.proposalHash,
    approvedTxOutputHash: policyResult.ok ? outputHash : null,
    guardianXonly,
    signature: null,
    height: input.currentHeight ?? null,
    policyResult
  };

  if (!policyResult.ok) {
    return {
      ...base,
      approved: false,
      approvalHash: sha256Hex({ ...base, approved: false })
    };
  }

  const leaf = input.manifest.core.leaves['immediate-operator-guardian'];
  const sighash = ts.scriptPathSighash(
    txParsed,
    [{ scriptPubKey: input.manifest.core.p2trScriptPubKey, amountSats: input.manifest.core.amountSats }],
    inputIndex,
    Buffer.from(leaf.leafHash, 'hex')
  );
  const signature = a.schnorrSign(guardianSecret, sighash).toString('hex');
  const approved = {
    ...base,
    approved: true,
    signature,
    sighash: sighash.toString('hex')
  };
  approved.approvalHash = sha256Hex(approved);
  return approved;
}

function verifyGuardianApproval(approval, manifest) {
  if (!approval || approval.kind !== 'taproot_reserve_vault_guardian_approval') {
    return { ok: false, reason: 'wrong guardian approval kind' };
  }
  const hash = approval.approvalHash;
  const copy = { ...approval };
  delete copy.approvalHash;
  if (hash !== sha256Hex(copy)) return { ok: false, reason: 'guardian approval hash mismatch' };
  if (manifest && approval.vaultId !== manifest.core.vaultId) return { ok: false, reason: 'vaultId mismatch' };
  return {
    ok: true,
    approved: approval.approved === true,
    approvalHash: hash,
    guardianXonly: approval.guardianXonly,
    proposalHash: approval.proposalHash
  };
}

module.exports = {
  DEFAULT_NETWORK,
  DEFAULT_RECOVERY_CSV_DELAY,
  DEFAULT_RECOVERY_RISK_MARGIN_BLOCKS,
  normalizeNetwork,
  csvSequence,
  outpointKey,
  deriveReserveVaultInternalXonly,
  requireReserveVaultInternalXonly,
  buildImmediateLeafScript,
  buildRecoveryLeafScript,
  buildTaprootReserveVaultTemplate,
  buildTaprootReserveVaultManifest,
  recoveryStatus,
  verifyTaprootReserveVaultManifest,
  normalizeChainTxoutForEvidence,
  verifyTaprootReserveVaultOnChain,
  buildTaprootReserveVaultSet,
  buildTaprootReserveVaultSetFromRpc,
  reservedSatsFromTaprootReserveVaultSet,
  normalizeTxOutputsFromParsed,
  outputVectorHashFromParsed,
  buildVaultSpendProposal,
  approveTaprootReserveVaultSpend,
  verifyGuardianApproval
};
