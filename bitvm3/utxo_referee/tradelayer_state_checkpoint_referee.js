const {
  sha256Hex
} = require('./tradelayer_pnl_route_adapter');
const { verifyChallengeVerdict } = require('./challenge_verdict');

const HEX32_RE = /^[0-9a-f]{64}$/i;

function normalizeHex32(value, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!HEX32_RE.test(text)) throw new Error(`${fieldName} must be a 32-byte hex string`);
  return text;
}

function normalizeTxids(value, fieldName) {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  const normalized = value.map((txid, index) => normalizeHex32(txid, `${fieldName}[${index}]`));
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) throw new Error(`${fieldName} must not contain duplicates`);
  return normalized;
}

function txidRoot(txids) {
  return sha256Hex(txids);
}

// A txid is either accepted or rejected by a checkpoint, never both.
function acceptedRejectedOverlap(acceptedTxids, rejectedTxids) {
  const accepted = new Set(acceptedTxids);
  return rejectedTxids.find((txid) => accepted.has(txid)) || null;
}

function buildTradeLayerStateCheckpoint(input = {}) {
  const acceptedTxids = normalizeTxids(input.acceptedTxids || ['11'.repeat(32)], 'acceptedTxids');
  const rejectedTxids = normalizeTxids(input.rejectedTxids || [], 'rejectedTxids');
  const overlap = acceptedRejectedOverlap(acceptedTxids, rejectedTxids);
  if (overlap) throw new Error(`txid ${overlap} is both accepted and rejected`);
  const previousStateRoot = normalizeHex32(input.previousStateRoot || '00'.repeat(32), 'previousStateRoot');
  const nextStateRoot = normalizeHex32(
    input.nextStateRoot || sha256Hex({ previousStateRoot, acceptedTxids, rejectedTxids }),
    'nextStateRoot'
  );
  const publisher = {
    address: String(input.publisher?.address || input.publisherAddress || 'tl-state-oracle-demo'),
    keyId: String(input.publisher?.keyId || input.publisherKeyId || 'checkpoint-publisher-v1'),
    signatureHash: input.publisher?.signatureHash
      ? normalizeHex32(input.publisher.signatureHash, 'publisher.signatureHash')
      : sha256Hex({ previousStateRoot, nextStateRoot, acceptedTxids })
  };

  const core = {
    kind: 'tradelayer_state_checkpoint_v1',
    chain: input.chain || 'litecoin-testnet',
    epochId: String(input.epochId ?? 0),
    height: Number(input.height ?? 0),
    previousStateRoot,
    nextStateRoot,
    acceptedTxids,
    acceptedTxRoot: txidRoot(acceptedTxids),
    rejectedTxids,
    rejectedTxRoot: txidRoot(rejectedTxids),
    publisher,
    fraudWindowBlocks: Number(input.fraudWindowBlocks || 144)
  };

  return {
    kind: 'tradelayer_state_checkpoint',
    checkpointHash: sha256Hex(core),
    core
  };
}

function verifyTradeLayerStateCheckpoint(checkpoint) {
  if (!checkpoint || checkpoint.kind !== 'tradelayer_state_checkpoint') {
    return { ok: false, reason: 'wrong checkpoint kind' };
  }
  if (!checkpoint.core || typeof checkpoint.core !== 'object') {
    return { ok: false, reason: 'checkpoint core is missing' };
  }

  let acceptedTxids;
  let rejectedTxids;
  try {
    acceptedTxids = normalizeTxids(checkpoint.core.acceptedTxids || [], 'acceptedTxids');
    rejectedTxids = normalizeTxids(checkpoint.core.rejectedTxids || [], 'rejectedTxids');
    normalizeHex32(checkpoint.core.previousStateRoot, 'previousStateRoot');
    normalizeHex32(checkpoint.core.nextStateRoot, 'nextStateRoot');
    normalizeHex32(checkpoint.core.publisher?.signatureHash, 'publisher.signatureHash');
  } catch (err) {
    return { ok: false, reason: err.message };
  }

  if (checkpoint.core.acceptedTxRoot !== txidRoot(acceptedTxids)) {
    return { ok: false, reason: 'accepted tx root mismatch' };
  }
  if (checkpoint.core.rejectedTxRoot !== txidRoot(rejectedTxids)) {
    return { ok: false, reason: 'rejected tx root mismatch' };
  }
  if (acceptedRejectedOverlap(acceptedTxids, rejectedTxids)) {
    return { ok: false, reason: 'accepted and rejected txids overlap' };
  }
  const checkpointHash = sha256Hex(checkpoint.core);
  if (checkpoint.checkpointHash !== checkpointHash) {
    return { ok: false, reason: 'checkpoint hash mismatch', checkpointHash };
  }
  return {
    ok: true,
    checkpointHash,
    acceptedTxCount: acceptedTxids.length,
    rejectedTxCount: rejectedTxids.length
  };
}

function buildTradeLayerCheckpointFraudProof(checkpoint, options = {}) {
  const checkpointResult = verifyTradeLayerStateCheckpoint(checkpoint);
  if (!checkpointResult.ok) throw new Error(`invalid checkpoint: ${checkpointResult.reason}`);

  const proofType = options.proofType || 'invalid_accepted_tx';
  const txid = normalizeHex32(
    options.txid || checkpoint.core.acceptedTxids[0] || 'ff'.repeat(32),
    'txid'
  );
  const expected = {
    checkpointHash: checkpoint.checkpointHash,
    acceptedTxRoot: checkpoint.core.acceptedTxRoot,
    rejectedTxRoot: checkpoint.core.rejectedTxRoot,
    nextStateRoot: checkpoint.core.nextStateRoot
  };
  let claimed;
  if (proofType === 'invalid_accepted_tx') {
    claimed = {
      txid,
      includedInAcceptedSet: checkpoint.core.acceptedTxids.includes(txid),
      txValid: false,
      rejectReason: options.rejectReason || 'consensus invalid'
    };
  } else if (proofType === 'omitted_valid_tx') {
    claimed = {
      txid,
      includedInAcceptedSet: checkpoint.core.acceptedTxids.includes(txid),
      txValid: true,
      inclusionRequired: true
    };
  } else if (proofType === 'state_root_mismatch') {
    claimed = {
      recomputedNextStateRoot: normalizeHex32(options.recomputedNextStateRoot || 'aa'.repeat(32), 'recomputedNextStateRoot'),
      publishedNextStateRoot: checkpoint.core.nextStateRoot
    };
  } else {
    throw new Error(`unsupported checkpoint fraud proof type: ${proofType}`);
  }

  const core = {
    kind: 'tradelayer_state_checkpoint_fraud_proof_v1',
    proofType,
    checkpointHash: checkpoint.checkpointHash,
    expected,
    claimed,
    evidence: options.evidence || {}
  };
  return {
    kind: 'tradelayer_state_checkpoint_fraud_proof',
    proofType,
    proofHash: sha256Hex(core),
    challengeable: fraudProofChallengeable(core),
    core
  };
}

function fraudProofChallengeable(core) {
  const claimed = core.claimed || {};
  return Boolean(
    (core.proofType === 'invalid_accepted_tx' && claimed.includedInAcceptedSet && claimed.txValid === false)
    || (core.proofType === 'omitted_valid_tx' && !claimed.includedInAcceptedSet && claimed.txValid && claimed.inclusionRequired)
    || (core.proofType === 'state_root_mismatch' && claimed.recomputedNextStateRoot !== claimed.publishedNextStateRoot)
  );
}

// The claim's facts are read against the checkpoint it names.
function fraudProofClaimMismatch(core, checkpoint) {
  const claimed = core.claimed || {};
  if (core.proofType === 'state_root_mismatch') {
    return claimed.publishedNextStateRoot === checkpoint.core.nextStateRoot ? null : 'published root is not the checkpoint next state root';
  }
  return claimed.includedInAcceptedSet === checkpoint.core.acceptedTxids.includes(claimed.txid)
    ? null
    : 'includedInAcceptedSet does not match the checkpoint';
}

function verifyTradeLayerCheckpointFraudProof(proof, checkpoint) {
  if (!checkpoint) return { ok: false, reason: 'checkpoint required to verify fraud proof' };
  const checkpointResult = verifyTradeLayerStateCheckpoint(checkpoint);
  if (!checkpointResult.ok) return { ok: false, reason: `invalid checkpoint: ${checkpointResult.reason}` };
  const verdict = verifyChallengeVerdict(proof, {
    kind: 'tradelayer_state_checkpoint_fraud_proof',
    coreKind: 'tradelayer_state_checkpoint_fraud_proof_v1',
    hashField: 'proofHash',
    labelField: 'proofType',
    verdict: fraudProofChallengeable
  });
  if (!verdict.ok) return verdict;
  if (proof.core.checkpointHash !== checkpoint.checkpointHash) {
    return { ok: false, reason: 'fraud proof checkpoint mismatch' };
  }
  const mismatch = fraudProofClaimMismatch(proof.core, checkpoint);
  if (mismatch) return { ok: false, reason: mismatch };
  return { ok: true, proofHash: verdict.challengeHash, challengeable: verdict.challengeable };
}

module.exports = {
  buildTradeLayerStateCheckpoint,
  verifyTradeLayerStateCheckpoint,
  buildTradeLayerCheckpointFraudProof,
  verifyTradeLayerCheckpointFraudProof,
  _private: { txidRoot }
};
