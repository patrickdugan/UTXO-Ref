const { sha256Hex, stableStringify } = require('./tradelayer_pnl_route_adapter');
const ts = require('./tradelayer_taproot_script');
const a = require('./tradelayer_dlc_adaptor_sig');
const { buildTaprootTree, controlBlockWithPath } = require('./tradelayer_taproot_tree');
const {
  normalizeNetwork,
  toSats,
  outpointKey,
  deriveReserveVaultInternalXonly,
  buildRecoveryLeafScript,
  recoveryStatus,
  normalizeChainTxoutForEvidence
} = require('./taproot_reserve_vault');

const OP_DROP = 0x75;
const OP_CHECKSIGVERIFY = 0xad;
const OP_CHECKSIG = 0xac;
const OP_CHECKSIGADD = 0xba;
const OP_NUMEQUAL = 0x9c;
const OP_PUSH32 = 0x20;
const MAX_GUARDIANS = 15;
const DEFAULT_RECOVERY_SAFETY_BLOCKS = 6;

function assertHex(value, bytes, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  }
  return text;
}

function assertXonly(value, fieldName) {
  const text = assertHex(value, 32, fieldName);
  try { a.liftX(a.bufToBig(Buffer.from(text, 'hex'))); }
  catch (err) { throw new Error(`${fieldName} is not a valid x-only secp256k1 pubkey: ${err.message}`); }
  return text;
}

function boundedInteger(value, fieldName, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${fieldName} must be an integer in ${minimum}..${maximum}`);
  }
  return parsed;
}

function boundedId(value, fieldName) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(text)) {
    throw new Error(`${fieldName} must be 1..128 printable identifier characters`);
  }
  return text;
}

function normalizeFundingOutpoint(outpoint) {
  if (typeof outpoint === 'string') {
    const [txid, vout] = outpoint.split(':');
    return normalizeFundingOutpoint({ txid, vout: Number(vout) });
  }
  if (!outpoint || typeof outpoint !== 'object') throw new Error('fundingOutpoint is required');
  return {
    txid: assertHex(outpoint.txid, 32, 'fundingOutpoint.txid'),
    vout: boundedInteger(outpoint.vout, 'fundingOutpoint.vout')
  };
}

function scriptNumberOpcode(value, fieldName) {
  const n = boundedInteger(value, fieldName, 1, 16);
  return 0x50 + n;
}

function normalizeGuardianPolicy(input = {}) {
  const guardians = input.guardianXonlys || input.guardians;
  if (!Array.isArray(guardians) || guardians.length < 2 || guardians.length > MAX_GUARDIANS) {
    throw new Error(`guardianXonlys must contain 2..${MAX_GUARDIANS} keys`);
  }
  const guardianXonlys = guardians.map((key, index) => assertXonly(key, `guardianXonlys[${index}]`));
  if (new Set(guardianXonlys).size !== guardianXonlys.length) throw new Error('guardian keys must be unique');
  const guardianThreshold = boundedInteger(
    input.guardianThreshold ?? input.threshold,
    'guardianThreshold',
    2,
    guardianXonlys.length
  );
  return { guardianXonlys, guardianThreshold };
}

function guardianSetHash(input = {}) {
  const policy = normalizeGuardianPolicy(input);
  return sha256Hex({
    kind: 'utxoref_v2_guardian_set_v1',
    guardianXonlys: policy.guardianXonlys,
    guardianThreshold: policy.guardianThreshold
  });
}

function bindingPrefix(bindingHash) {
  return Buffer.concat([
    Buffer.from([OP_PUSH32]),
    Buffer.from(assertHex(bindingHash, 32, 'bindingHash'), 'hex'),
    Buffer.from([OP_DROP])
  ]);
}

function buildGuardianQuorumLeafScript(input = {}) {
  const operatorXonly = assertXonly(input.operatorXonly, 'operatorXonly');
  const bindingHash = assertHex(input.bindingHash, 32, 'bindingHash');
  const policy = normalizeGuardianPolicy(input);
  if (policy.guardianXonlys.includes(operatorXonly)) throw new Error('challenger key cannot also be a guardian key');
  const parts = [
    bindingPrefix(bindingHash),
    Buffer.from([OP_PUSH32]),
    Buffer.from(operatorXonly, 'hex'),
    Buffer.from([OP_CHECKSIGVERIFY])
  ];
  policy.guardianXonlys.forEach((guardian, index) => {
    parts.push(Buffer.from([OP_PUSH32]));
    parts.push(Buffer.from(guardian, 'hex'));
    parts.push(Buffer.from([index === 0 ? OP_CHECKSIG : OP_CHECKSIGADD]));
  });
  parts.push(Buffer.from([
    scriptNumberOpcode(policy.guardianThreshold, 'guardianThreshold'),
    OP_NUMEQUAL
  ]));
  return Buffer.concat(parts).toString('hex');
}

function buildGuardianQuorumVaultTemplate(input = {}) {
  const network = normalizeNetwork(input.network || 'bitcoin-testnet4');
  const operatorXonly = assertXonly(input.operatorXonly, 'operatorXonly');
  const recoveryXonly = assertXonly(input.recoveryXonly, 'recoveryXonly');
  const bindingHash = assertHex(input.bindingHash, 32, 'bindingHash');
  const recoveryCsvDelay = boundedInteger(input.recoveryCsvDelay, 'recoveryCsvDelay', 1, 65535);
  const policy = normalizeGuardianPolicy(input);
  if (policy.guardianXonlys.includes(operatorXonly)) throw new Error('challenger key cannot also be a guardian key');
  if (policy.guardianXonlys.includes(recoveryXonly)) throw new Error('refund key cannot also be a guardian key');
  if (operatorXonly === recoveryXonly) throw new Error('refund key must differ from the challenger key');
  const internalXonly = input.internalXonly
    ? assertXonly(input.internalXonly, 'internalXonly')
    : deriveReserveVaultInternalXonly(network);
  const immediateScript = buildGuardianQuorumLeafScript({
    operatorXonly,
    bindingHash,
    ...policy
  });
  const recoveryScript = buildRecoveryLeafScript(recoveryXonly, recoveryCsvDelay, bindingHash);
  const tree = buildTaprootTree([
    { kind: 'immediate-operator-guardian-quorum', scriptHex: immediateScript },
    { kind: 'recovery-refund-csv', scriptHex: recoveryScript }
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
    operatorXonly,
    recoveryXonly,
    guardianXonlys: policy.guardianXonlys,
    guardianThreshold: policy.guardianThreshold,
    guardianSetHash: guardianSetHash(policy),
    recoveryCsvDelay,
    internalXonly,
    merkleRoot: tree.root.toString('hex'),
    p2trScriptPubKey,
    leaves,
    immediateLeaf: leaves['immediate-operator-guardian-quorum'],
    recoveryLeaf: leaves['recovery-refund-csv']
  };
}

function buildGuardianQuorumVaultManifest(input = {}) {
  const network = normalizeNetwork(input.network || 'bitcoin-testnet4');
  const fundingOutpoint = normalizeFundingOutpoint(input.fundingOutpoint);
  const amountSats = toSats(input.amountSats, 'amountSats');
  if (amountSats <= 0n) throw new Error('amountSats must be positive');
  const observedAtHeight = boundedInteger(input.observedAtHeight, 'observedAtHeight');
  const bindingHash = assertHex(input.bindingHash, 32, 'bindingHash');
  const reserveEpochId = boundedId(input.reserveEpochId, 'reserveEpochId');
  const template = buildGuardianQuorumVaultTemplate({ ...input, network, bindingHash });
  const vaultId = String(input.vaultId || sha256Hex({
    kind: 'taproot_reserve_guardian_quorum_v1',
    network,
    fundingOutpoint,
    operatorXonly: template.operatorXonly,
    guardianXonlys: template.guardianXonlys,
    guardianThreshold: template.guardianThreshold,
    guardianSetHash: template.guardianSetHash,
    reserveEpochId
  }).slice(0, 32));
  const core = {
    kind: 'taproot_reserve_guardian_quorum_manifest_v1',
    network,
    vaultId,
    fundingOutpoint,
    amountSats: amountSats.toString(),
    operatorXonly: template.operatorXonly,
    guardianXonlys: template.guardianXonlys,
    guardianThreshold: template.guardianThreshold,
    guardianSetHash: template.guardianSetHash,
    recoveryXonly: template.recoveryXonly,
    internalXonly: template.internalXonly,
    p2trScriptPubKey: template.p2trScriptPubKey,
    observedAtHeight,
    recoveryCsvDelay: template.recoveryCsvDelay,
    reserveEpochId,
    bindingHash,
    merkleRoot: template.merkleRoot,
    leaves: template.leaves
  };
  return {
    kind: 'taproot_reserve_guardian_quorum_manifest',
    version: 1,
    manifestHash: sha256Hex(core),
    core
  };
}

function verifyGuardianQuorumVaultManifest(manifest, options = {}) {
  if (!manifest || manifest.kind !== 'taproot_reserve_guardian_quorum_manifest' || manifest.version !== 1) {
    return { ok: false, countable: false, reason: 'wrong guardian quorum vault manifest kind or version' };
  }
  if (!manifest.core || manifest.core.kind !== 'taproot_reserve_guardian_quorum_manifest_v1') {
    return { ok: false, countable: false, reason: 'guardian quorum vault core is invalid' };
  }
  if (manifest.manifestHash !== sha256Hex(manifest.core)) {
    return { ok: false, countable: false, reason: 'guardian quorum vault manifest hash mismatch' };
  }
  try {
    const core = manifest.core;
    normalizeFundingOutpoint(core.fundingOutpoint);
    toSats(core.amountSats, 'manifest.amountSats');
    const template = buildGuardianQuorumVaultTemplate({
      network: core.network,
      operatorXonly: core.operatorXonly,
      guardianXonlys: core.guardianXonlys,
      guardianThreshold: core.guardianThreshold,
      recoveryXonly: core.recoveryXonly,
      recoveryCsvDelay: core.recoveryCsvDelay,
      bindingHash: core.bindingHash,
      internalXonly: core.internalXonly
    });
    if (core.p2trScriptPubKey !== template.p2trScriptPubKey) throw new Error('guardian quorum P2TR script mismatch');
    if (core.guardianSetHash !== template.guardianSetHash) throw new Error('guardian quorum set hash mismatch');
    if (core.merkleRoot !== template.merkleRoot) throw new Error('guardian quorum merkle root mismatch');
    if (stableStringify(core.leaves) !== stableStringify(template.leaves)) throw new Error('guardian quorum leaves mismatch');
    const recovery = recoveryStatus({ core }, options);
    return {
      ok: true,
      countable: recovery.countable,
      reason: recovery.reason,
      manifestHash: manifest.manifestHash,
      guardianThreshold: core.guardianThreshold,
      guardianCount: core.guardianXonlys.length,
      guardianSetHash: core.guardianSetHash,
      recoveryStatus: recovery
    };
  } catch (err) {
    return { ok: false, countable: false, reason: err.message };
  }
}

function buildGuardianQuorumFeeReserve(input = {}) {
  const graphHash = assertHex(input.graphHash, 32, 'graphHash');
  const disputeId = boundedId(input.disputeId, 'disputeId');
  const network = normalizeNetwork(input.network || 'bitcoin-testnet4');
  const amountSats = toSats(input.amountSats, 'amountSats');
  const maxFeeSats = toSats(input.maxFeeSats, 'maxFeeSats');
  if (maxFeeSats <= 0n || amountSats < maxFeeSats) throw new Error('fee reserve amount must cover maxFeeSats');
  const fundingHeight = boundedInteger(input.fundingHeight, 'fundingHeight');
  const challengeWindowBlocks = boundedInteger(input.challengeWindowBlocks, 'challengeWindowBlocks', 2, 65535);
  const confirmationTarget = boundedInteger(input.confirmationTarget ?? 2, 'confirmationTarget', 1, 1000);
  const recoverySafetyBlocks = boundedInteger(
    input.recoverySafetyBlocks ?? DEFAULT_RECOVERY_SAFETY_BLOCKS,
    'recoverySafetyBlocks',
    1,
    10000
  );
  const minimumRecoveryHorizon = challengeWindowBlocks + confirmationTarget + recoverySafetyBlocks;
  const recoveryCsvDelay = boundedInteger(input.recoveryCsvDelay, 'recoveryCsvDelay', 1, 65535);
  if (recoveryCsvDelay <= minimumRecoveryHorizon) {
    throw new Error(`recoveryCsvDelay must exceed the ${minimumRecoveryHorizon}-block challenge horizon`);
  }
  const vaultManifest = buildGuardianQuorumVaultManifest({
    network,
    fundingOutpoint: input.fundingOutpoint,
    amountSats,
    observedAtHeight: fundingHeight,
    recoveryCsvDelay,
    operatorXonly: input.challengerXonly,
    guardianXonlys: input.guardianXonlys,
    guardianThreshold: input.guardianThreshold,
    recoveryXonly: input.refundXonly,
    bindingHash: graphHash,
    reserveEpochId: disputeId,
    vaultId: input.reserveId,
    internalXonly: input.internalXonly
  });
  const core = {
    kind: 'utxoref_v2_fee_reserve_guardian_quorum_v1',
    network,
    graphHash,
    disputeId,
    fundingHeight,
    amountSats: amountSats.toString(),
    maxFeeSats: maxFeeSats.toString(),
    challengeWindowBlocks,
    confirmationTarget,
    recoverySafetyBlocks,
    minimumRecoveryHorizon,
    vaultManifest
  };
  return {
    kind: 'utxoref_v2_fee_reserve',
    version: 1,
    reserveHash: sha256Hex(core),
    core
  };
}

function isGuardianQuorumFeeReserve(reserve) {
  return reserve?.kind === 'utxoref_v2_fee_reserve' &&
    reserve.version === 1 &&
    reserve.core?.kind === 'utxoref_v2_fee_reserve_guardian_quorum_v1';
}

function verifyGuardianQuorumFeeReserve(reserve, options = {}) {
  if (!isGuardianQuorumFeeReserve(reserve)) {
    return { ok: false, counted: false, reason: 'wrong guardian quorum fee reserve kind or version' };
  }
  if (reserve.reserveHash !== sha256Hex(reserve.core)) {
    return { ok: false, counted: false, reason: 'guardian quorum fee reserve hash mismatch' };
  }
  try {
    const core = reserve.core;
    const expectedGraphHash = options.graphHash
      ? assertHex(options.graphHash, 32, 'expected graphHash')
      : core.graphHash;
    if (assertHex(core.graphHash, 32, 'reserve graphHash') !== expectedGraphHash) {
      return { ok: false, counted: false, reason: 'fee reserve graph hash mismatch' };
    }
    const manifest = core.vaultManifest;
    if (manifest.core.bindingHash !== core.graphHash) {
      return { ok: false, counted: false, reason: 'guardian quorum tapscript is not graph-bound' };
    }
    if (manifest.core.reserveEpochId !== core.disputeId) {
      return { ok: false, counted: false, reason: 'guardian quorum dispute id mismatch' };
    }
    const amountSats = toSats(core.amountSats, 'reserve amountSats');
    const maxFeeSats = toSats(core.maxFeeSats, 'reserve maxFeeSats');
    const requiredMaxFeeSats = toSats(options.minimumFeeReserveSats ?? maxFeeSats, 'minimumFeeReserveSats');
    if (amountSats < maxFeeSats || amountSats < requiredMaxFeeSats) {
      return { ok: false, counted: false, reason: 'fee reserve amount is below policy minimum' };
    }
    if (manifest.core.amountSats !== amountSats.toString()) {
      return { ok: false, counted: false, reason: 'guardian quorum vault amount mismatch' };
    }
    const currentHeight = boundedInteger(options.currentHeight, 'currentHeight');
    const confirmations = Number(options.txout?.confirmations || 0);
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
      return { ok: false, counted: false, reason: 'fee reserve must be confirmed' };
    }
    const fundingHeight = boundedInteger(core.fundingHeight, 'fundingHeight');
    if (currentHeight - confirmations + 1 !== fundingHeight) {
      return { ok: false, counted: false, reason: 'fee reserve funding height does not match Core confirmations' };
    }
    const requiredHorizon = boundedInteger(core.minimumRecoveryHorizon, 'minimumRecoveryHorizon', 1, 65535);
    const manifestCheck = verifyGuardianQuorumVaultManifest(manifest, {
      currentHeight,
      recoveryRiskMarginBlocks: requiredHorizon
    });
    if (!manifestCheck.ok || !manifestCheck.countable) {
      return { ok: false, counted: false, reason: manifestCheck.reason, manifestCheck };
    }
    const txout = normalizeChainTxoutForEvidence(options.txout);
    if (!txout.present) return { ok: false, counted: false, reason: 'vault UTXO spent or missing', manifestCheck };
    if (txout.valueSats !== amountSats.toString()) {
      return { ok: false, counted: false, reason: 'vault UTXO amount mismatch', manifestCheck, chainTxout: txout };
    }
    if (txout.scriptPubKey !== manifest.core.p2trScriptPubKey) {
      return { ok: false, counted: false, reason: 'vault UTXO scriptPubKey mismatch', manifestCheck, chainTxout: txout };
    }
    const remainingBlocks = fundingHeight + Number(manifest.core.recoveryCsvDelay) - currentHeight;
    return {
      ok: true,
      counted: true,
      reason: null,
      graphHash: core.graphHash,
      disputeId: core.disputeId,
      outpoint: outpointKey(manifest.core.fundingOutpoint),
      amountSats: amountSats.toString(),
      maxFeeSats: maxFeeSats.toString(),
      guardianThreshold: manifest.core.guardianThreshold,
      guardianCount: manifest.core.guardianXonlys.length,
      guardianSetHash: manifest.core.guardianSetHash,
      remainingBlocks,
      manifestCheck,
      chainTxout: txout
    };
  } catch (err) {
    return { ok: false, counted: false, reason: err.message };
  }
}

module.exports = {
  MAX_GUARDIANS,
  normalizeGuardianPolicy,
  guardianSetHash,
  buildGuardianQuorumLeafScript,
  buildGuardianQuorumVaultTemplate,
  buildGuardianQuorumVaultManifest,
  verifyGuardianQuorumVaultManifest,
  buildGuardianQuorumFeeReserve,
  isGuardianQuorumFeeReserve,
  verifyGuardianQuorumFeeReserve
};
