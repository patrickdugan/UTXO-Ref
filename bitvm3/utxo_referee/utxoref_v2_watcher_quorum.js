const crypto = require('crypto');
const { stableStringify, sha256Hex } = require('./tradelayer_pnl_route_adapter');

function identifier(value, fieldName) {
  const text = String(value || '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(text)) throw new Error(`${fieldName} is not a bounded ASCII identifier`);
  return text;
}

function hex32(value, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${fieldName} must be 32 bytes of hex`);
  return text;
}

function integer(value, fieldName, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${fieldName} must be an integer >= ${minimum}`);
  return parsed;
}

function normalizeWatcherStatement(input = {}) {
  const action = identifier(input.action, 'statement.action');
  const assertionOutpoint = String(input.assertionOutpoint || '').toLowerCase();
  if (!/^[0-9a-f]{64}:[0-9]+$/.test(assertionOutpoint)) throw new Error('statement.assertionOutpoint is invalid');
  const challengeTxid = input.challengeTxid ? hex32(input.challengeTxid, 'statement.challengeTxid') : null;
  return {
    kind: 'utxoref_v2_watcher_statement_v1',
    roundId: identifier(input.roundId, 'statement.roundId'),
    graphHash: hex32(input.graphHash, 'statement.graphHash'),
    trustPolicyId: identifier(input.trustPolicyId, 'statement.trustPolicyId'),
    network: identifier(input.network || 'bitcoin-testnet4', 'statement.network'),
    height: integer(input.height, 'statement.height'),
    bestBlockHash: hex32(input.bestBlockHash, 'statement.bestBlockHash'),
    authorizationBlockHash: hex32(input.authorizationBlockHash, 'statement.authorizationBlockHash'),
    assertionOutpoint,
    assertionUnspent: input.assertionUnspent === true,
    fraudDetected: input.fraudDetected === true,
    fraudType: input.fraudType === null || input.fraudType === undefined ? null : identifier(input.fraudType, 'statement.fraudType'),
    action,
    challengeTxid
  };
}

function statementFromWatchtowerTick(tick) {
  return normalizeWatcherStatement({
    graphHash: tick.graphHash,
    roundId: tick.watcherRoundId,
    trustPolicyId: tick.trustPolicyId,
    network: tick.network || 'bitcoin-testnet4',
    height: tick.height,
    bestBlockHash: tick.chainBestBlockHash,
    authorizationBlockHash: tick.authorization?.activeBlockHash,
    assertionOutpoint: tick.assertionOutpoint,
    assertionUnspent: tick.assertionUnspent,
    fraudDetected: tick.fraudDetected,
    fraudType: tick.fraudType,
    action: tick.action,
    challengeTxid: tick.challenge?.txid || tick.disprove?.broadcastTxid || tick.disprove?.txid || null
  });
}

function publicKeyFingerprint(publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  return sha256Hex(key.export({ type: 'spki', format: 'der' }));
}

function normalizeQuorumPolicy(policy) {
  if (!policy || policy.kind !== 'utxoref_v2_watcher_quorum_policy' || policy.version !== 1) {
    throw new Error('wrong watcher quorum policy kind or version');
  }
  const threshold = integer(policy.threshold, 'policy.threshold', 1);
  const minFaultDomains = integer(policy.minFaultDomains, 'policy.minFaultDomains', 1);
  const maxStatementAgeBlocks = integer(policy.maxStatementAgeBlocks ?? 2, 'policy.maxStatementAgeBlocks', 0);
  const watchers = {};
  const fingerprints = new Set();
  for (const [rawId, entry] of Object.entries(policy.watchers || {})) {
    const watcherId = identifier(rawId, 'policy watcher id');
    const faultDomain = identifier(entry?.faultDomain, `policy watcher ${watcherId} faultDomain`);
    const publicKey = crypto.createPublicKey(entry?.publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(`policy watcher ${watcherId} key must be Ed25519`);
    const fingerprint = publicKeyFingerprint(publicKey);
    if (fingerprints.has(fingerprint)) throw new Error('watcher policy reuses a signing key');
    fingerprints.add(fingerprint);
    watchers[watcherId] = { watcherId, faultDomain, publicKey, fingerprint };
  }
  const watcherCount = Object.keys(watchers).length;
  if (threshold > watcherCount) throw new Error('watcher threshold exceeds watcher count');
  if (minFaultDomains > threshold) throw new Error('minimum fault domains exceeds threshold');
  return {
    kind: 'normalized_utxoref_v2_watcher_quorum_policy',
    policyId: identifier(policy.policyId, 'policy.policyId'),
    threshold,
    minFaultDomains,
    maxStatementAgeBlocks,
    watchers
  };
}

function buildWatcherReceipt(statementInput, identity, privateKeyInput) {
  const statement = normalizeWatcherStatement(statementInput);
  const watcherId = identifier(identity?.watcherId, 'watcherId');
  const faultDomain = identifier(identity?.faultDomain, 'faultDomain');
  const privateKey = privateKeyInput?.type === 'private' ? privateKeyInput : crypto.createPrivateKey(privateKeyInput);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('watcher private key must be Ed25519');
  const publicKey = crypto.createPublicKey(privateKey);
  const core = {
    kind: 'utxoref_v2_watcher_receipt_v1',
    watcherId,
    faultDomain,
    publicKeyFingerprint: publicKeyFingerprint(publicKey),
    statementHash: sha256Hex(statement),
    statement
  };
  const signature = crypto.sign(null, Buffer.from(stableStringify(core), 'utf8'), privateKey).toString('base64');
  return {
    kind: 'utxoref_v2_watcher_receipt',
    version: 1,
    receiptHash: sha256Hex({ core, signature }),
    core,
    signature
  };
}

function verifyWatcherReceipt(receipt, policyInput) {
  try {
    const policy = policyInput?.kind === 'normalized_utxoref_v2_watcher_quorum_policy'
      ? policyInput
      : normalizeQuorumPolicy(policyInput);
    if (!receipt || receipt.kind !== 'utxoref_v2_watcher_receipt' || receipt.version !== 1) {
      return { ok: false, reason: 'wrong watcher receipt kind or version' };
    }
    const core = receipt.core;
    if (!core || core.kind !== 'utxoref_v2_watcher_receipt_v1') return { ok: false, reason: 'watcher receipt core missing' };
    const watcher = policy.watchers[core.watcherId];
    if (!watcher) return { ok: false, reason: 'watcher is not allowlisted' };
    if (core.faultDomain !== watcher.faultDomain) return { ok: false, reason: 'watcher fault domain differs from policy' };
    if (core.publicKeyFingerprint !== watcher.fingerprint) return { ok: false, reason: 'watcher key fingerprint mismatch' };
    const statement = normalizeWatcherStatement(core.statement);
    if (core.statementHash !== sha256Hex(statement)) return { ok: false, reason: 'watcher statement hash mismatch' };
    if (receipt.receiptHash !== sha256Hex({ core, signature: receipt.signature })) {
      return { ok: false, reason: 'watcher receipt hash mismatch' };
    }
    const signature = Buffer.from(String(receipt.signature || ''), 'base64');
    if (!crypto.verify(null, Buffer.from(stableStringify(core), 'utf8'), watcher.publicKey, signature)) {
      return { ok: false, reason: 'watcher signature is invalid' };
    }
    return {
      ok: true,
      watcherId: core.watcherId,
      faultDomain: core.faultDomain,
      statementHash: core.statementHash,
      receiptHash: receipt.receiptHash
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function aggregateWatcherReceipts(receipts, policyInput, options = {}) {
  const policy = normalizeQuorumPolicy(policyInput);
  if (!Array.isArray(receipts) || receipts.length === 0) throw new Error('watcher receipts are required');
  const watcherIds = new Set();
  const faultDomains = new Set();
  let statementHash = null;
  const accepted = [];
  for (const receipt of receipts) {
    const verification = verifyWatcherReceipt(receipt, policy);
    if (!verification.ok) throw new Error(`invalid watcher receipt: ${verification.reason}`);
    if (watcherIds.has(verification.watcherId)) throw new Error(`duplicate watcher receipt: ${verification.watcherId}`);
    watcherIds.add(verification.watcherId);
    faultDomains.add(verification.faultDomain);
    if (statementHash === null) statementHash = verification.statementHash;
    else if (statementHash !== verification.statementHash) throw new Error('watchers disagree on the observed statement');
    accepted.push(verification);
  }
  const thresholdMet = accepted.length >= policy.threshold;
  const faultDomainsMet = faultDomains.size >= policy.minFaultDomains;
  const statement = receipts[0].core.statement;
  if (options.currentHeight !== undefined) {
    const currentHeight = integer(options.currentHeight, 'currentHeight');
    const ageBlocks = currentHeight - statement.height;
    if (ageBlocks < 0 || ageBlocks > policy.maxStatementAgeBlocks) {
      throw new Error(`watcher statement age ${ageBlocks} exceeds policy`);
    }
  }
  if (options.expectedBestBlockHash && statement.bestBlockHash !== hex32(options.expectedBestBlockHash, 'expectedBestBlockHash')) {
    throw new Error('watcher quorum statement is not on the expected chain tip');
  }
  const core = {
    kind: 'utxoref_v2_watcher_quorum_v1',
    policyId: policy.policyId,
    statementHash,
    threshold: policy.threshold,
    minFaultDomains: policy.minFaultDomains,
    maxStatementAgeBlocks: policy.maxStatementAgeBlocks,
    roundId: statement.roundId,
    signerCount: accepted.length,
    faultDomainCount: faultDomains.size,
    thresholdMet,
    faultDomainsMet,
    receiptHashes: accepted.map((entry) => entry.receiptHash).sort()
  };
  return {
    kind: 'utxoref_v2_watcher_quorum',
    version: 1,
    ok: thresholdMet && faultDomainsMet,
    quorumHash: sha256Hex(core),
    core
  };
}

module.exports = {
  normalizeWatcherStatement,
  statementFromWatchtowerTick,
  normalizeQuorumPolicy,
  buildWatcherReceipt,
  verifyWatcherReceipt,
  aggregateWatcherReceipts
};
