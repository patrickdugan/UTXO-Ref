/**
 * TradeLayer Reserve Reconciliation Referee
 *
 * Binds the deposit side (tokenized UTXO reserve) to the withdrawal side
 * (payable withdrawal cap) and enforces the core peg invariant:
 *
 *   sum(payable withdrawals) <= sum(credited, non-rolled-back deposit reserve)
 *
 * Until now the deposit indexer/ledger and the withdrawal queue were never
 * reconciled against each other: the queue would commit to a cap that was just
 * the sum of approved requests, with no check that the reserve could cover it.
 * This referee makes solvency a verifiable, challengeable commitment.
 *
 * Reserve sources accepted (in priority order):
 *   1. a BTC testnet4 Taproot reserve vault set
 *      (kind: 'taproot-reserve-vault-set')
 *   2. explicit { reservedSats } legacy/demo snapshots
 *   3. a ReceiptDepositIndexer snapshot (kind: 'receipt-deposit-indexer')
 *      -> sums amountSats of deposits whose status === 'credited'
 *   4. a ReceiptLedger snapshot (has totalSupplySats)
 *
 * SECURITY_BLOCKERS.md #4 (partial fix - freshness window, not encumbrance):
 * `reservedSats` is a `listunspent` snapshot of ordinary spendable wallet
 * UTXOs at one point in time - nothing stops those UTXOs being spent
 * elsewhere after the snapshot is taken (full fix requires a covenant/
 * timelock, not attempted here). This referee instead bounds how OLD a
 * reserve snapshot is allowed to be before it's trusted at all: pass
 * `observedAtHeight` (the chain height when the snapshot was taken) and
 * `currentHeight` (the height "now"); if the snapshot is older than
 * `maxReserveAgeBlocks`, the reconciliation is fail-closed - `solvent` is
 * forced to `false` regardless of the cap<=reserve math - both at build
 * time and, critically, again at verify time with a FRESH `currentHeight`
 * (so a reconciliation that was fresh when built but has since gone stale
 * is caught the next time it's checked, not just once). This is opt-in and
 * fully backward compatible: omit `observedAtHeight` and staleness is not
 * enforced, exactly as before.
 */

const {
  sha256Hex
} = require('./tradelayer_pnl_route_adapter');
const {
  verifyTradeLayerWithdrawalQueue
} = require('./tradelayer_withdrawal_queue_referee');
const {
  reservedSatsFromTaprootReserveVaultSet
} = require('./taproot_reserve_vault');

// Default staleness window: 6 blocks (~15 min at Litecoin's ~2.5 min target
// block time). Deliberately tight - this is a mitigation for "reserve proof
// can go stale," not a substitute for actual on-chain encumbrance. Override
// via options.maxReserveAgeBlocks per call if a different window is needed.
const DEFAULT_MAX_RESERVE_AGE_BLOCKS = 6;

function computeStaleness(observedAtHeight, currentHeight, maxReserveAgeBlocks) {
  if (observedAtHeight === undefined || observedAtHeight === null
    || currentHeight === undefined || currentHeight === null) {
    return { checked: false, ageBlocks: null, stale: false };
  }
  const ageBlocks = Number(currentHeight) - Number(observedAtHeight);
  if (!Number.isFinite(ageBlocks) || ageBlocks < 0) {
    // currentHeight before observedAtHeight is nonsensical (reorg, bad input,
    // clock skew) - fail closed rather than silently accepting it.
    return { checked: true, ageBlocks, stale: true, reason: 'currentHeight precedes observedAtHeight' };
  }
  return { checked: true, ageBlocks, stale: ageBlocks > maxReserveAgeBlocks };
}

function toSats(value, fieldName) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    if (value < 0) throw new Error(`${fieldName} must be non-negative`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${fieldName} must be an integer sat amount`);
}

function reservedSatsFromDepositSnapshot(snapshot) {
  if (!Array.isArray(snapshot.deposits)) {
    throw new Error('deposit indexer snapshot requires a deposits array');
  }
  let sum = 0n;
  for (const deposit of snapshot.deposits) {
    if (deposit && deposit.status === 'credited') {
      sum += toSats(deposit.amountSats, `deposit ${deposit.depositId}`);
    }
  }
  return sum;
}

/**
 * Resolve the reserve into { reservedSats: BigInt, reserveSourceKind, reserveSourceHash }.
 * The source hash binds the exact reserve evidence the cap was checked against.
 */
function resolveReserve(reserve) {
  if (reserve === null || reserve === undefined) {
    throw new Error('reserve is required');
  }
  if (typeof reserve === 'bigint' || typeof reserve === 'number' || typeof reserve === 'string') {
    const reservedSats = toSats(reserve, 'reserve');
    return {
      reservedSats,
      reserveSourceKind: 'explicit',
      reserveSourceHash: sha256Hex({ reservedSats: reservedSats.toString() })
    };
  }
  if (typeof reserve !== 'object') throw new Error('reserve must be an object or sat amount');

  if (reserve.kind === 'taproot-reserve-vault-set') {
    const vaultSummary = reservedSatsFromTaprootReserveVaultSet(reserve);
    return {
      reservedSats: vaultSummary.reservedSats,
      reserveSourceKind: 'taproot-reserve-vault-set',
      reserveSourceHash: sha256Hex(reserve),
      reserveEvidenceSummary: {
        vaultSetHash: vaultSummary.vaultSetHash,
        countedVaultCount: vaultSummary.countedVaultCount,
        rejectedVaultCount: vaultSummary.rejectedVaultCount
      }
    };
  }

  if (reserve.reservedSats !== undefined) {
    const reservedSats = toSats(reserve.reservedSats, 'reserve.reservedSats');
    return {
      reservedSats,
      reserveSourceKind: reserve.kind || 'explicit',
      reserveSourceHash: sha256Hex(reserve)
    };
  }
  if (reserve.kind === 'receipt-deposit-indexer') {
    return {
      reservedSats: reservedSatsFromDepositSnapshot(reserve),
      reserveSourceKind: 'receipt-deposit-indexer',
      reserveSourceHash: sha256Hex(reserve)
    };
  }
  if (reserve.totalSupplySats !== undefined) {
    return {
      reservedSats: toSats(reserve.totalSupplySats, 'reserve.totalSupplySats'),
      reserveSourceKind: 'receipt-ledger',
      reserveSourceHash: sha256Hex(reserve)
    };
  }
  throw new Error('unrecognized reserve source: provide reservedSats, a deposit indexer snapshot, or a ledger snapshot');
}

function buildTradeLayerReserveReconciliation(input = {}) {
  const queue = input.queue;
  const queueResult = verifyTradeLayerWithdrawalQueue(queue);
  if (!queueResult.ok) throw new Error(`invalid withdrawal queue: ${queueResult.reason}`);

  const {
    reservedSats,
    reserveSourceKind,
    reserveSourceHash,
    reserveEvidenceSummary
  } = resolveReserve(input.reserve);
  const capSats = toSats(queue.queueCore.totalSats, 'queue.totalSats');
  const marginSats = reservedSats - capSats;
  const mathSolvent = marginSats >= 0n;

  const maxReserveAgeBlocks = input.maxReserveAgeBlocks !== undefined
    ? Number(input.maxReserveAgeBlocks)
    : DEFAULT_MAX_RESERVE_AGE_BLOCKS;
  const observedAtHeight = input.observedAtHeight !== undefined && input.observedAtHeight !== null
    ? Number(input.observedAtHeight)
    : null;
  const staleness = computeStaleness(observedAtHeight, input.currentHeight, maxReserveAgeBlocks);
  // Fail-closed: a stale reserve snapshot is never treated as solvent,
  // regardless of the cap<=reserve arithmetic. See file header.
  const solvent = mathSolvent && !staleness.stale;

  const core = {
    kind: 'tradelayer_reserve_reconciliation_v1',
    network: input.network || queue.queueCore.network || 'litecoin-testnet',
    epochId: queue.queueCore.epochId,
    queueHash: queue.queueHash,
    withdrawalRootHex: queue.queueCore.withdrawalRootHex,
    capSats: capSats.toString(),
    payableCount: queueResult.payableCount,
    reserveSourceKind,
    reserveSourceHash,
    reservedSats: reservedSats.toString(),
    reserveEvidenceSummary: reserveEvidenceSummary || null,
    marginSats: marginSats.toString(),
    mathSolvent,
    observedAtHeight,
    maxReserveAgeBlocks,
    staleAtBuild: staleness.checked ? staleness.stale : null,
    ageBlocksAtBuild: staleness.checked ? staleness.ageBlocks : null,
    solvent
  };

  return {
    kind: 'tradelayer_reserve_reconciliation',
    reconciliationHash: sha256Hex(core),
    solvent,
    core
  };
}

function verifyTradeLayerReserveReconciliation(reconciliation, queue, options = {}) {
  if (!reconciliation || reconciliation.kind !== 'tradelayer_reserve_reconciliation') {
    return { ok: false, reason: 'wrong reconciliation kind' };
  }
  if (!reconciliation.core || typeof reconciliation.core !== 'object') {
    return { ok: false, reason: 'reconciliation core missing' };
  }
  const core = reconciliation.core;
  const reconciliationHash = sha256Hex(core);
  if (reconciliation.reconciliationHash !== reconciliationHash) {
    return { ok: false, reason: 'reconciliation hash mismatch', reconciliationHash };
  }

  let capSats;
  let reservedSats;
  try {
    capSats = toSats(core.capSats, 'core.capSats');
    reservedSats = toSats(core.reservedSats, 'core.reservedSats');
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  const marginSats = reservedSats - capSats;
  if (marginSats.toString() !== core.marginSats) {
    return { ok: false, reason: 'margin mismatch' };
  }
  const mathSolvent = marginSats >= 0n;
  // Older committed cores (pre-staleness-window) won't have mathSolvent -
  // fall back to the plain solvent flag so existing artifacts still verify.
  const expectedMathSolvent = core.mathSolvent !== undefined ? core.mathSolvent : core.solvent;
  if (mathSolvent !== expectedMathSolvent) {
    return { ok: false, reason: 'solvency math mismatch' };
  }

  const builtSolvent = mathSolvent && !(core.staleAtBuild === true);
  if (builtSolvent !== core.solvent || builtSolvent !== reconciliation.solvent) {
    return { ok: false, reason: 'solvency flag mismatch' };
  }

  // If the caller supplies the queue, bind the reconciliation to it so a cap
  // checked against one queue cannot be replayed against another.
  if (queue) {
    const queueResult = verifyTradeLayerWithdrawalQueue(queue);
    if (!queueResult.ok) return { ok: false, reason: `invalid withdrawal queue: ${queueResult.reason}` };
    if (queue.queueHash !== core.queueHash) return { ok: false, reason: 'queue hash mismatch' };
    if (queue.queueCore.totalSats !== core.capSats) return { ok: false, reason: 'cap mismatch against queue' };
  }

  // SECURITY_BLOCKERS.md #4: re-check staleness against a FRESH currentHeight
  // supplied at verify time, not just the height recorded at build time. A
  // reconciliation that was fresh when built can go stale by the time it's
  // actually used to gate a spend - this is what catches that, every time
  // the gate is checked, not just once.
  let solvent = builtSolvent;
  let liveStaleness = null;
  if (options.currentHeight !== undefined && options.currentHeight !== null && core.observedAtHeight !== null) {
    liveStaleness = computeStaleness(core.observedAtHeight, options.currentHeight, core.maxReserveAgeBlocks);
    if (liveStaleness.stale) solvent = false;
  }

  return {
    ok: true,
    reconciliationHash,
    solvent,
    mathSolvent,
    capSats: capSats.toString(),
    reservedSats: reservedSats.toString(),
    marginSats: marginSats.toString(),
    staleAtBuild: core.staleAtBuild === true,
    staleNow: liveStaleness ? liveStaleness.stale : null,
    ageBlocksNow: liveStaleness ? liveStaleness.ageBlocks : null
  };
}

/**
 * Build a challengeable insolvency proof: the committed withdrawal cap exceeds
 * the proven reserve. This is the fraud handle for "the queue promised to pay
 * out more than the deposit reserve can back".
 */
function buildTradeLayerReserveInsolvencyChallenge(reconciliation) {
  const result = verifyTradeLayerReserveReconciliation(reconciliation);
  if (!result.ok) throw new Error(`invalid reconciliation: ${result.reason}`);
  const core = reconciliation.core;
  const capSats = toSats(core.capSats, 'core.capSats');
  const reservedSats = toSats(core.reservedSats, 'core.reservedSats');
  const shortfallSats = capSats - reservedSats;
  const challengeable = shortfallSats > 0n;

  const challengeCore = {
    kind: 'tradelayer_reserve_insolvency_challenge_v1',
    reconciliationHash: reconciliation.reconciliationHash,
    queueHash: core.queueHash,
    reserveSourceHash: core.reserveSourceHash,
    capSats: capSats.toString(),
    reservedSats: reservedSats.toString(),
    shortfallSats: shortfallSats.toString()
  };

  return {
    kind: 'tradelayer_reserve_insolvency_challenge',
    challengeHash: sha256Hex(challengeCore),
    challengeable,
    core: challengeCore
  };
}

function verifyTradeLayerReserveInsolvencyChallenge(challenge, reconciliation) {
  if (!challenge || challenge.kind !== 'tradelayer_reserve_insolvency_challenge') {
    return { ok: false, reason: 'wrong challenge kind' };
  }
  if (!challenge.core || typeof challenge.core !== 'object') {
    return { ok: false, reason: 'challenge core missing' };
  }
  const challengeHash = sha256Hex(challenge.core);
  if (challenge.challengeHash !== challengeHash) {
    return { ok: false, reason: 'challenge hash mismatch', challengeHash };
  }
  if (reconciliation && challenge.core.reconciliationHash !== reconciliation.reconciliationHash) {
    return { ok: false, reason: 'reconciliation hash mismatch' };
  }
  return { ok: true, challengeHash, challengeable: challenge.challengeable };
}

module.exports = {
  reservedSatsFromDepositSnapshot,
  resolveReserve,
  buildTradeLayerReserveReconciliation,
  verifyTradeLayerReserveReconciliation,
  buildTradeLayerReserveInsolvencyChallenge,
  verifyTradeLayerReserveInsolvencyChallenge
};
