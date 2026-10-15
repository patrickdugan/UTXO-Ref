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

function toSats(value, fieldName) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${fieldName} must be an integer sat amount`);
}

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
  const entries = queueEntries(core.entries || [], core.network);
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

function buildTradeLayerWithdrawalQueueChallenge(queue, options = {}) {
  const result = verifyTradeLayerWithdrawalQueue(queue);
  if (!result.ok) throw new Error(`invalid queue: ${result.reason}`);
  const challengeType = options.challengeType || 'omitted_withdrawal';
  const request = options.request || queue.queueCore.entries[0];
  const expected = {
    queueHash: queue.queueHash,
    queueRoot: queue.queueCore.queueRoot,
    withdrawalRootHex: queue.queueCore.withdrawalRootHex
  };
  let claimed;
  if (challengeType === 'omitted_withdrawal') {
    claimed = {
      requestId: request.id,
      requestHash: sha256Hex(request),
      includedInPayableSet: false
    };
  } else if (challengeType === 'duplicate_withdrawal') {
    claimed = {
      requestId: request.id,
      duplicateCount: Number(options.duplicateCount || 2)
    };
  } else if (challengeType === 'amount_mismatch') {
    claimed = {
      requestId: request.id,
      expectedSats: String(request.sats),
      claimedSats: (BigInt(request.sats) + 1n).toString()
    };
  } else if (challengeType === 'destination_mismatch') {
    claimed = {
      requestId: request.id,
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
  const challengeable = (
    challengeType === 'omitted_withdrawal'
    || (challengeType === 'duplicate_withdrawal' && claimed.duplicateCount > 1)
    || (challengeType === 'amount_mismatch' && claimed.expectedSats !== claimed.claimedSats)
    || (challengeType === 'destination_mismatch' && claimed.expectedAddress !== claimed.claimedAddress)
  );
  return {
    kind: 'tradelayer_withdrawal_queue_challenge',
    challengeType,
    challengeHash: sha256Hex(core),
    challengeable,
    core
  };
}

function verifyTradeLayerWithdrawalQueueChallenge(challenge, queue) {
  if (!challenge || challenge.kind !== 'tradelayer_withdrawal_queue_challenge') {
    return { ok: false, reason: 'wrong challenge kind' };
  }
  if (!challenge.core || typeof challenge.core !== 'object') return { ok: false, reason: 'challenge core missing' };
  if (queue && challenge.core.expected.queueHash !== queue.queueHash) return { ok: false, reason: 'queue hash mismatch' };
  const challengeHash = sha256Hex(challenge.core);
  if (challenge.challengeHash !== challengeHash) return { ok: false, reason: 'challenge hash mismatch', challengeHash };
  return { ok: true, challengeHash, challengeable: challenge.challengeable };
}

module.exports = {
  PAYABLE_STATUSES,
  buildTradeLayerWithdrawalQueue,
  verifyTradeLayerWithdrawalQueue,
  buildTradeLayerWithdrawalQueueChallenge,
  verifyTradeLayerWithdrawalQueueChallenge
};
