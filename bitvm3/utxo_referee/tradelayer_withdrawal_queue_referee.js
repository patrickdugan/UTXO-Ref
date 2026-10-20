const {
  CommitmentPackage,
  PayoutLeaf
} = require('./types');
const {
  buildTreeWithProofs
} = require('./merkle');
const {
  stableStringify,
  sha256Hex,
  addressToScriptPubKey
} = require('./tradelayer_pnl_route_adapter');
const { toSats } = require('./money');
const { verifyChallengeVerdict } = require('./challenge_verdict');

function normalizeRequest(request, index) {
  if (!request || typeof request !== 'object') throw new Error(`request[${index}] must be an object`);
  if (!request.address) throw new Error(`request[${index}] requires address`);
  if (!request.txid) throw new Error(`request[${index}] requires txid (origin send)`);
  const sats = toSats(request.sats ?? request.amountSats, `request[${index}].sats`);
  if (sats <= 0n) throw new Error(`request[${index}].sats must be positive`);
  return {
    id: String(request.id || request.withdrawalId || `${request.txid || 'request'}:${index}`),
    txid: String(request.txid).toLowerCase(),
    address: String(request.address),
    sats: sats.toString(),
    propertyId: request.propertyId ?? null,
    status: request.status || 'approved'
  };
}

// Fail-closed: only these statuses are ever swept. Anything else (pending,
// cancelled, rejected, invalid, or an unrecognized value) is excluded from the
// payable set so an unknown status cannot become a payout.
const PAYABLE_STATUSES = Object.freeze(['approved', 'settled']);

function queueEntries(requests, network) {
  if (!Array.isArray(requests) || !requests.length) throw new Error('withdrawal requests must be a non-empty array');
  const entries = requests.map(normalizeRequest);
  const seenIds = new Set();
  const seenPayouts = new Set();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) throw new Error(`duplicate withdrawal request id: ${entry.id}`);
    seenIds.add(entry.id);
    // Two distinct ids paying the same withdrawal would double-pay it. The payout
    // identity is the recipient script (not the address spelling), amount,
    // property and origin send. A send that fans out to several recipients does
    // not collide, because those entries differ by script and/or amount.
    const scriptHex = addressToScriptPubKey(entry.address, network).toString('hex');
    const payoutFingerprint = `${scriptHex}|${entry.sats}|${entry.propertyId ?? ''}|${entry.txid}`;
    if (seenPayouts.has(payoutFingerprint)) {
      throw new Error(`duplicate withdrawal payout: ${entry.id} repeats ${payoutFingerprint}`);
    }
    seenPayouts.add(payoutFingerprint);
  }
  return entries;
}

function approvedEntries(entries) {
  return entries.filter((entry) => PAYABLE_STATUSES.includes(String(entry.status).toLowerCase()));
}

function residualScript(options, network) {
  if (options.residualScriptPubKey) return Buffer.from(String(options.residualScriptPubKey), 'hex');
  if (options.residualAddress) return addressToScriptPubKey(options.residualAddress, network);
  return Buffer.from('6a', 'hex');
}

// The payout tree, cap and commitment a queue commits to. Build and verify both derive
// them here, so the committed root is always the root of the entries that were checked.
function queueCommitment({ entries, network, epochId, residualDest }) {
  const payable = approvedEntries(entries);
  const leaves = payable.map((entry) => new PayoutLeaf({
    epochId,
    recipientScriptPubKey: addressToScriptPubKey(entry.address, network),
    amountSats: BigInt(entry.sats)
  }));
  const { root, proofs } = buildTreeWithProofs(leaves);
  const totalSats = payable.reduce((sum, entry) => sum + BigInt(entry.sats), 0n);
  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: totalSats,
    residualDest
  });
  return {
    payable,
    root,
    proofs,
    totalSats,
    commitmentHash: commitment.hash()
  };
}

function buildTradeLayerWithdrawalQueue(input = {}) {
  const network = input.network || 'litecoin-testnet';
  const epochId = BigInt(input.epochId ?? 0);
  const entries = queueEntries(input.requests || input.withdrawals || [], network);
  const residualDest = residualScript(input, network);
  const built = queueCommitment({ entries, network, epochId, residualDest });
  const queueCore = {
    kind: 'tradelayer_withdrawal_queue_v1',
    chain: input.chain || network,
    network,
    queueId: String(input.queueId || `tl-withdrawals-${epochId}`),
    epochId: epochId.toString(),
    stateRoot: input.stateRoot || null,
    entries,
    payableRequestIds: built.payable.map((entry) => entry.id),
    queueRoot: sha256Hex(entries),
    residualDestHex: residualDest.toString('hex'),
    withdrawalRootHex: built.root.toString('hex'),
    commitmentHashHex: built.commitmentHash.toString('hex'),
    totalSats: built.totalSats.toString()
  };

  return {
    kind: 'tradelayer_withdrawal_queue',
    queueHash: sha256Hex(queueCore),
    queueCore,
    commitment: {
      epochId: epochId.toString(),
      withdrawalRootHex: built.root.toString('hex'),
      commitmentHashHex: built.commitmentHash.toString('hex'),
      capSats: built.totalSats.toString()
    },
    proofs: built.proofs.map((proof, index) => ({
      requestId: built.payable[index].id,
      proof
    }))
  };
}

function verifyTradeLayerWithdrawalQueue(queue) {
  if (!queue || queue.kind !== 'tradelayer_withdrawal_queue') return { ok: false, reason: 'wrong queue kind' };
  if (!queue.queueCore || typeof queue.queueCore !== 'object') return { ok: false, reason: 'queue core missing' };
  const queueHash = sha256Hex(queue.queueCore);
  if (queue.queueHash !== queueHash) return { ok: false, reason: 'queue hash mismatch', queueHash };
  const core = queue.queueCore;
  let entries;
  try {
    entries = queueEntries(core.entries || [], core.network);
  } catch (err) {
    return { ok: false, reason: `queue entries do not parse: ${err.message}` };
  }
  if (sha256Hex(entries) !== core.queueRoot) return { ok: false, reason: 'queue root mismatch' };
  let rebuilt;
  try {
    rebuilt = queueCommitment({
      entries,
      network: core.network,
      epochId: BigInt(core.epochId),
      residualDest: Buffer.from(core.residualDestHex, 'hex')
    });
  } catch (err) {
    return { ok: false, reason: `queue does not rebuild: ${err.message}` };
  }
  if (rebuilt.totalSats.toString() !== core.totalSats) return { ok: false, reason: 'queue total mismatch' };
  if (rebuilt.root.toString('hex') !== core.withdrawalRootHex) return { ok: false, reason: 'withdrawal root mismatch' };
  if (rebuilt.commitmentHash.toString('hex') !== core.commitmentHashHex) {
    return { ok: false, reason: 'commitment hash mismatch' };
  }
  if (stableStringify(rebuilt.payable.map((entry) => entry.id)) !== stableStringify(core.payableRequestIds)) {
    return { ok: false, reason: 'payable request ids mismatch' };
  }
  if (queue.commitment?.withdrawalRootHex !== core.withdrawalRootHex) {
    return { ok: false, reason: 'commitment withdrawal root mismatch' };
  }
  if (queue.commitment?.commitmentHashHex !== core.commitmentHashHex) {
    return { ok: false, reason: 'commitment hash mismatch' };
  }
  return {
    ok: true,
    queueHash,
    queueRoot: queue.queueCore.queueRoot,
    withdrawalRootHex: queue.queueCore.withdrawalRootHex,
    payableCount: queue.queueCore.payableRequestIds.length
  };
}

// The queue entry a claim names, or null. Entry ids are unique (queueEntries refuses a repeat).
function queueEntryFor(queue, requestId) {
  return queue.queueCore.entries.find((entry) => entry.id === String(requestId)) || null;
}

// Each fact a claim states about a request must be what the queue holds for it.
function claimMismatch(core, queue) {
  const claimed = core.claimed || {};
  const entry = queueEntryFor(queue, claimed.requestId);
  switch (core.challengeType) {
    case 'omitted_withdrawal':
      return claimed.includedInPayableSet === queue.queueCore.payableRequestIds.includes(String(claimed.requestId))
        ? null
        : 'includedInPayableSet does not match the queue';
    case 'duplicate_withdrawal':
      return Number(claimed.duplicateCount) === (entry ? 1 : 0) ? null : 'duplicateCount does not match the queue';
    case 'amount_mismatch':
      return entry && claimed.expectedSats === entry.sats ? null : 'expectedSats is not the queue amount';
    case 'destination_mismatch':
      return entry && claimed.expectedAddress === entry.address ? null : 'expectedAddress is not the queue address';
    default:
      return `unknown withdrawal challenge type: ${core.challengeType}`;
  }
}

// Challengeable when the queue shows the claim true. A request the queue holds is not
// omitted, whatever its status: a pending or rejected entry is held out on purpose.
function withdrawalChallengeable(core, queue) {
  const claimed = core.claimed || {};
  switch (core.challengeType) {
    case 'omitted_withdrawal':
      return !queueEntryFor(queue, claimed.requestId);
    case 'duplicate_withdrawal':
      return Number(claimed.duplicateCount) > 1;
    case 'amount_mismatch':
      return claimed.expectedSats !== claimed.claimedSats;
    case 'destination_mismatch':
      return claimed.expectedAddress !== claimed.claimedAddress;
    default:
      return false;
  }
}

function buildTradeLayerWithdrawalQueueChallenge(queue, options = {}) {
  const result = verifyTradeLayerWithdrawalQueue(queue);
  if (!result.ok) throw new Error(`invalid queue: ${result.reason}`);
  const challengeType = options.challengeType || 'omitted_withdrawal';
  const request = options.request || queue.queueCore.entries[0];
  const requestId = String(request.id ?? request.withdrawalId);
  const expected = {
    queueHash: queue.queueHash,
    queueRoot: queue.queueCore.queueRoot,
    withdrawalRootHex: queue.queueCore.withdrawalRootHex
  };
  let claimed;
  if (challengeType === 'omitted_withdrawal') {
    claimed = {
      requestId,
      requestHash: sha256Hex(request),
      includedInPayableSet: queue.queueCore.payableRequestIds.includes(requestId)
    };
  } else if (challengeType === 'duplicate_withdrawal') {
    claimed = {
      requestId,
      duplicateCount: Number(options.duplicateCount || 2)
    };
  } else if (challengeType === 'amount_mismatch') {
    claimed = {
      requestId,
      expectedSats: String(request.sats),
      claimedSats: (BigInt(request.sats) + 1n).toString()
    };
  } else if (challengeType === 'destination_mismatch') {
    claimed = {
      requestId,
      expectedAddress: request.address,
      claimedAddress: options.claimedAddress || `${request.address}:wrong`
    };
  } else {
    throw new Error(`unsupported withdrawal queue challenge: ${challengeType}`);
  }
  const core = {
    kind: 'tradelayer_withdrawal_queue_challenge_v1',
    challengeType,
    expected,
    claimed
  };
  return {
    kind: 'tradelayer_withdrawal_queue_challenge',
    challengeType,
    challengeHash: sha256Hex(core),
    challengeable: withdrawalChallengeable(core, queue),
    core
  };
}

// The queue is the input every claim is read against, so it is required.
function verifyTradeLayerWithdrawalQueueChallenge(challenge, queue) {
  if (!queue) return { ok: false, reason: 'queue required to judge a withdrawal challenge' };
  const queueResult = verifyTradeLayerWithdrawalQueue(queue);
  if (!queueResult.ok) return { ok: false, reason: `invalid queue: ${queueResult.reason}` };
  if (challenge?.core?.expected?.queueHash !== queue.queueHash) return { ok: false, reason: 'queue hash mismatch' };
  const verdict = verifyChallengeVerdict(challenge, {
    kind: 'tradelayer_withdrawal_queue_challenge',
    coreKind: 'tradelayer_withdrawal_queue_challenge_v1',
    labelField: 'challengeType',
    verdict: (core) => withdrawalChallengeable(core, queue)
  });
  if (!verdict.ok) return verdict;
  const mismatch = claimMismatch(challenge.core, queue);
  if (mismatch) return { ok: false, reason: mismatch };
  return verdict;
}

module.exports = {
  PAYABLE_STATUSES,
  buildTradeLayerWithdrawalQueue,
  verifyTradeLayerWithdrawalQueue,
  buildTradeLayerWithdrawalQueueChallenge,
  verifyTradeLayerWithdrawalQueueChallenge
};
