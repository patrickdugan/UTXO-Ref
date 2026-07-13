const {
  normalizeNetwork,
  toSats,
  outpointKey,
  buildTaprootReserveVaultManifest,
  verifyTaprootReserveVaultOnChain,
  normalizeChainTxoutForEvidence
} = require('./taproot_reserve_vault');
const { sha256Hex } = require('./tradelayer_pnl_route_adapter');

const DEFAULT_RECOVERY_SAFETY_BLOCKS = 6;

function assertHex32(value, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${fieldName} must be 32 bytes of hex`);
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

function buildUtxorefV2FeeReserve(input = {}) {
  const graphHash = assertHex32(input.graphHash, 'graphHash');
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

  const vaultManifest = buildTaprootReserveVaultManifest({
    network,
    fundingOutpoint: input.fundingOutpoint,
    amountSats,
    observedAtHeight: fundingHeight,
    recoveryCsvDelay,
    operatorXonly: input.challengerXonly,
    guardianXonly: input.guardianXonly,
    recoveryXonly: input.refundXonly,
    bindingHash: graphHash,
    reserveEpochId: disputeId,
    vaultId: input.reserveId,
    p2trScriptPubKey: input.p2trScriptPubKey
  });
  const core = {
    kind: 'utxoref_v2_fee_reserve_v1',
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

function verifyUtxorefV2FeeReserve(reserve, options = {}) {
  if (!reserve || reserve.kind !== 'utxoref_v2_fee_reserve' || reserve.version !== 1) {
    return { ok: false, counted: false, reason: 'wrong fee reserve kind or version' };
  }
  if (!reserve.core || reserve.core.kind !== 'utxoref_v2_fee_reserve_v1') {
    return { ok: false, counted: false, reason: 'fee reserve core is missing or invalid' };
  }
  const core = reserve.core;
  if (reserve.reserveHash !== sha256Hex(core)) {
    return { ok: false, counted: false, reason: 'fee reserve hash mismatch' };
  }
  try {
    const expectedGraphHash = options.graphHash ? assertHex32(options.graphHash, 'expected graphHash') : core.graphHash;
    if (assertHex32(core.graphHash, 'reserve graphHash') !== expectedGraphHash) {
      return { ok: false, counted: false, reason: 'fee reserve graph hash mismatch' };
    }
    if (core.vaultManifest?.core?.bindingHash !== core.graphHash) {
      return { ok: false, counted: false, reason: 'vault tapscript is not bound to the graph hash' };
    }
    if (core.vaultManifest?.core?.reserveEpochId !== core.disputeId) {
      return { ok: false, counted: false, reason: 'vault dispute id mismatch' };
    }
    const amountSats = toSats(core.amountSats, 'reserve amountSats');
    const maxFeeSats = toSats(core.maxFeeSats, 'reserve maxFeeSats');
    const requiredMaxFeeSats = toSats(options.minimumFeeReserveSats ?? maxFeeSats, 'minimumFeeReserveSats');
    if (amountSats < maxFeeSats || amountSats < requiredMaxFeeSats) {
      return { ok: false, counted: false, reason: 'fee reserve amount is below policy minimum' };
    }
    if (core.vaultManifest.core.amountSats !== amountSats.toString()) {
      return { ok: false, counted: false, reason: 'vault amount differs from fee reserve amount' };
    }
    const currentHeight = boundedInteger(options.currentHeight, 'currentHeight');
    const fundingHeight = boundedInteger(core.fundingHeight, 'fundingHeight');
    const confirmations = Number(options.txout?.confirmations || 0);
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
      return { ok: false, counted: false, reason: 'fee reserve must be confirmed' };
    }
    const observedFundingHeight = currentHeight - confirmations + 1;
    if (observedFundingHeight !== fundingHeight) {
      return { ok: false, counted: false, reason: 'fee reserve funding height does not match Core confirmations' };
    }
    const requiredHorizon = boundedInteger(core.minimumRecoveryHorizon, 'minimumRecoveryHorizon', 1, 65535);
    const remainingBlocks = fundingHeight + Number(core.vaultManifest.core.recoveryCsvDelay) - currentHeight;
    if (remainingBlocks <= requiredHorizon) {
      return { ok: false, counted: false, reason: 'fee reserve recovery is inside the challenge horizon', remainingBlocks };
    }
    const vaultCheck = verifyTaprootReserveVaultOnChain(core.vaultManifest, {
      network: core.network,
      currentHeight,
      recoveryRiskMarginBlocks: requiredHorizon,
      txout: options.txout
    });
    if (!vaultCheck.ok || !vaultCheck.counted) {
      return { ok: false, counted: false, reason: vaultCheck.reason, vaultCheck, remainingBlocks };
    }
    return {
      ok: true,
      counted: true,
      reason: null,
      graphHash: core.graphHash,
      disputeId: core.disputeId,
      outpoint: outpointKey(core.vaultManifest.core.fundingOutpoint),
      amountSats: amountSats.toString(),
      maxFeeSats: maxFeeSats.toString(),
      remainingBlocks,
      vaultCheck
    };
  } catch (err) {
    return { ok: false, counted: false, reason: err.message };
  }
}

function buildUtxorefV2FeeReserveRegistry(input = {}) {
  const reserves = input.reserves || [];
  if (!Array.isArray(reserves)) throw new Error('reserves must be an array');
  const currentHeight = boundedInteger(input.currentHeight, 'currentHeight');
  const outpoints = new Set();
  const disputes = new Set();
  const entries = [];
  for (const reserve of reserves) {
    const outpoint = outpointKey(reserve.core.vaultManifest.core.fundingOutpoint);
    const disputeKey = `${reserve.core.graphHash}:${reserve.core.disputeId}`;
    if (outpoints.has(outpoint)) throw new Error(`fee reserve outpoint is assigned more than once: ${outpoint}`);
    if (disputes.has(disputeKey)) throw new Error(`dispute has more than one fee reserve: ${disputeKey}`);
    outpoints.add(outpoint);
    disputes.add(disputeKey);
    const txout = input.chainTxouts?.[outpoint] || null;
    const verification = verifyUtxorefV2FeeReserve(reserve, {
      currentHeight,
      txout,
      graphHash: reserve.core.graphHash,
      minimumFeeReserveSats: input.minimumFeeReserveSats ?? reserve.core.maxFeeSats
    });
    entries.push({
      graphHash: reserve.core.graphHash,
      disputeId: reserve.core.disputeId,
      outpoint,
      reserveHash: reserve.reserveHash,
      chainTxout: normalizeChainTxoutForEvidence(txout),
      verification
    });
  }
  const core = {
    kind: 'utxoref_v2_fee_reserve_registry_v1',
    currentHeight,
    reserveCount: entries.length,
    countedReserveCount: entries.filter((entry) => entry.verification.counted).length,
    entries
  };
  return {
    kind: 'utxoref_v2_fee_reserve_registry',
    version: 1,
    registryHash: sha256Hex(core),
    core
  };
}

async function buildUtxorefV2FeeReserveRegistryFromRpc(input = {}) {
  if (typeof input.rpc !== 'function') throw new Error('rpc function is required');
  const currentHeight = input.currentHeight === undefined
    ? Number(await input.rpc('getblockcount'))
    : boundedInteger(input.currentHeight, 'currentHeight');
  const chainTxouts = {};
  for (const reserve of input.reserves || []) {
    const funding = reserve.core.vaultManifest.core.fundingOutpoint;
    chainTxouts[outpointKey(funding)] = await input.rpc('gettxout', [funding.txid, funding.vout, true]);
  }
  return buildUtxorefV2FeeReserveRegistry({ ...input, currentHeight, chainTxouts });
}

module.exports = {
  DEFAULT_RECOVERY_SAFETY_BLOCKS,
  buildUtxorefV2FeeReserve,
  verifyUtxorefV2FeeReserve,
  buildUtxorefV2FeeReserveRegistry,
  buildUtxorefV2FeeReserveRegistryFromRpc
};
