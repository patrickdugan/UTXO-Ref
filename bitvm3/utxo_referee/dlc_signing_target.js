'use strict';

/**
 * What a DLC adaptor signature may sign.
 *
 * A signing request no longer names a sighash or an adaptor point. It names
 * one CET of a validated transaction set and carries the oracle
 * announcements, and the signing target is derived from them:
 *
 *   - the transaction set must be the one the signed contract receipts commit
 *     to (CET set, funding template, refund and fee policy digests);
 *   - the signer must be one of the two parties of the funding output;
 *   - the sighash is the BIP341 script-path sighash of the CET leaf for that
 *     CET spending the committed funding outpoint;
 *   - the announcements must be the set the contract's oracle_policy receipt
 *     commits to, signed by the pinned oracle keys, and the adaptor point is
 *     the sum of the outcome points of the CET's oracle subset for the CET's
 *     outcome.
 *
 * The native signer (native/dlc-signer/src/signing_target.rs) performs the
 * same derivation from the same request fields.
 */

const crypto = require('crypto');
const { canonicalJson, snapshotOwnDataArguments, snapshotPlainData } = require('./dlc_canonical_json');
const {
  normalizeDlcTransactionSet,
  parseCanonicalUnsignedTransaction,
  dlcFundingOutputForTransactionSet
} = require('./dlc_transaction_validator');
const { settlementSighashForTransactionSet } = require('./dlc_signature_validator');
const { buildThresholdOutcomeSets } = require('./dlc_threshold_oracle');
const {
  bytes32,
  pointAdd,
  dlcOutcomePoint,
  verifyDlcOracleAnnouncement
} = require('./tradelayer_dlc_adaptor_sig');

const SIGNING_CONTEXT_KEYS = Object.freeze(['transactionSet', 'cetTxid', 'oracleAnnouncements']);
const RECEIPT_BINDINGS = Object.freeze([
  ['cet_set', 'cetSetDigest'],
  ['funding_template', 'fundingTemplateDigest'],
  ['refund_transaction', 'refundTransactionDigest'],
  ['fee_policy', 'feePolicyDigest']
]);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireHex(value, bytes, fieldName) {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${fieldName} must be lowercase ${bytes}-byte hex`);
  }
  return value;
}

function receiptDigest(contract, stage, kind) {
  const transition = contract.history.find((entry) => entry.to === stage);
  const receipt = transition && transition.evidence.find((entry) => entry.kind === kind);
  if (!receipt) throw new Error(`DLC contract has no authenticated ${kind} receipt`);
  return requireHex(receipt.digest, 32, `${kind} receipt digest`);
}

// Canonical announcement set: verified, lower-case, plain data, sorted by
// oracle key. Its digest is what the oracle_policy receipt commits to.
function normalizeOracleAnnouncements(announcements) {
  announcements = snapshotPlainData(announcements, 'DLC oracle announcements', false);
  if (!Array.isArray(announcements) || announcements.length < 2 || announcements.length > 16) {
    throw new Error('oracleAnnouncements must contain 2..16 announcements');
  }
  const normalized = announcements.map((announcement, index) => {
    if (!verifyDlcOracleAnnouncement(announcement)) {
      throw new Error(`oracleAnnouncements[${index}] is not a validly signed oracle announcement`);
    }
    return {
      kind: announcement.kind,
      eventId: announcement.eventId,
      px: announcement.px.toLowerCase(),
      rx: announcement.rx.toLowerCase(),
      outcomeMessages: announcement.outcomeMessages.map((outcome) => outcome.toLowerCase()),
      signature: announcement.signature.toLowerCase()
    };
  }).sort((left, right) => left.px.localeCompare(right.px));
  if (new Set(normalized.map((announcement) => announcement.px)).size !== normalized.length) {
    throw new Error('oracleAnnouncements must come from distinct oracle keys');
  }
  return normalized;
}

function oracleAnnouncementSetDigest(announcements) {
  return sha256Hex(Buffer.from(canonicalJson(normalizeOracleAnnouncements(announcements)), 'utf8'));
}

function normalizeSigningContext(signingContext) {
  if (signingContext === undefined || signingContext === null) {
    throw new Error('signingContext with transactionSet, cetTxid and oracleAnnouncements is required');
  }
  const raw = snapshotOwnDataArguments(signingContext, SIGNING_CONTEXT_KEYS, 'DLC signing context');
  return {
    transactionSet: normalizeDlcTransactionSet(raw.transactionSet),
    cetTxid: requireHex(raw.cetTxid, 32, 'signingContext.cetTxid'),
    oracleAnnouncements: normalizeOracleAnnouncements(raw.oracleAnnouncements)
  };
}

// What can be derived from the signing context alone - the same derivation
// the native signer performs (native/dlc-signer/src/signing_target.rs).
function deriveSigningContextTarget(signingContext) {
  const { transactionSet, cetTxid, oracleAnnouncements } = normalizeSigningContext(signingContext);
  const fundingOutput = dlcFundingOutputForTransactionSet(transactionSet);
  const cet = transactionSet.cets.find((entry) => entry.txid === cetTxid);
  if (!cet) throw new Error('signing context CET is absent from the committed CET set');
  const parsed = parseCanonicalUnsignedTransaction(cet.rawTxHex);
  if (parsed.txid !== cet.txid) throw new Error('signing context CET transaction digest changed after validation');
  const sighash = settlementSighashForTransactionSet({ transactionSet, executionType: 'cet', cetTxid });

  const first = oracleAnnouncements[0];
  if (oracleAnnouncements.some((announcement) => announcement.eventId !== first.eventId ||
      announcement.outcomeMessages.join(':') !== first.outcomeMessages.join(':'))) {
    throw new Error('oracle announcements must commit to the same event and ordered outcome set');
  }
  const outcome = Buffer.from(cet.outcomeMessage, 'hex');
  let adaptorPoint = null;
  for (const key of cet.oraclePubkeys) {
    const announcement = oracleAnnouncements.find((entry) => entry.px === key);
    if (!announcement) throw new Error('signing context CET oracle is not in the announcement set');
    adaptorPoint = pointAdd(adaptorPoint, dlcOutcomePoint(announcement, outcome));
  }
  if (cet.oraclePubkeys.length < 2 || adaptorPoint === null) {
    throw new Error('signing context CET oracle subset must contain at least two oracles');
  }

  return Object.freeze({
    cetTxid,
    cet,
    sighash: sighash.toString('hex'),
    adaptorPoint: Object.freeze({
      x: bytes32(adaptorPoint.x).toString('hex'),
      y: bytes32(adaptorPoint.y).toString('hex')
    }),
    partyPubkeyXs: fundingOutput.partyPubkeyXs,
    cetSetDigest: transactionSet.cetSetDigest,
    fundingTemplateDigest: transactionSet.fundingTemplateDigest,
    oracleAnnouncementsDigest: sha256Hex(Buffer.from(canonicalJson(oracleAnnouncements), 'utf8')),
    oracleEventId: first.eventId,
    transactionSet,
    oracleAnnouncements
  });
}

// Host side: the context target, plus the contract's receipts, the pinned
// oracle policy and the signer's membership. contract must already be a
// normalized DLC contract.
function deriveCetSigningTarget({ contract, signerPubkeyX, signingContext }) {
  requireHex(signerPubkeyX, 32, 'signerPubkeyX');
  const target = deriveSigningContextTarget(signingContext);
  const { transactionSet, oracleAnnouncements, cet } = target;

  for (const [kind, field] of RECEIPT_BINDINGS) {
    if (receiptDigest(contract, 'CANONICAL_CETS_AND_REFUND', kind) !== transactionSet[field]) {
      throw new Error(`signing context transaction set ${field} does not match the signed contract receipt`);
    }
  }
  if (!target.partyPubkeyXs.includes(signerPubkeyX)) {
    throw new Error('signer is not a party to the two-party DLC funding output');
  }
  if (receiptDigest(contract, 'AUTHENTICATED_ORACLES', 'oracle_policy') !== target.oracleAnnouncementsDigest) {
    throw new Error('signing context oracle announcements are not the set pinned by the contract oracle_policy receipt');
  }
  // The announcements must be for the event both peers agreed in the oracle
  // policy, not merely signed by the pinned oracle keys: the same oracles may
  // announce other events whose attestations would complete the signature.
  const policy = contract.oraclePolicy;
  if (typeof policy.eventId !== 'string' || !Array.isArray(policy.outcomeMessages)) {
    throw new Error('adaptor signing requires a contract oracle policy that names its event and outcomes');
  }
  if (oracleAnnouncements[0].eventId !== policy.eventId ||
      oracleAnnouncements[0].outcomeMessages.join(':') !== policy.outcomeMessages.join(':')) {
    throw new Error('signing context oracle announcements are for a different event than the contract oracle policy');
  }
  const outcomeSets = buildThresholdOutcomeSets({
    announcements: oracleAnnouncements,
    threshold: contract.oraclePolicy.threshold,
    pinnedPubkeys: contract.oraclePolicy.pinnedPubkeys,
    outcomeMsg32: Buffer.from(cet.outcomeMessage, 'hex')
  });
  const subset = outcomeSets.find((entry) => entry.oraclePubkeys.join(':') === cet.oraclePubkeys.join(':'));
  if (!subset || bytes32(subset.outcomePoint.x).toString('hex') !== target.adaptorPoint.x) {
    throw new Error('signing context CET oracle subset is not a threshold subset of the pinned oracle set');
  }

  return Object.freeze({
    cetTxid: target.cetTxid,
    signerPubkeyX,
    sighash: target.sighash,
    adaptorPoint: target.adaptorPoint,
    cetSetDigest: target.cetSetDigest,
    fundingTemplateDigest: target.fundingTemplateDigest,
    oracleAnnouncementsDigest: target.oracleAnnouncementsDigest,
    oracleEventId: policy.eventId,
    // Plain JSON form handed to the native signer, which re-derives everything above.
    signingContext: Object.freeze({
      transactionSet: JSON.parse(canonicalJson(transactionSet)),
      cetTxid: target.cetTxid,
      oracleAnnouncements
    })
  });
}

module.exports = {
  SIGNING_CONTEXT_KEYS,
  normalizeOracleAnnouncements,
  oracleAnnouncementSetDigest,
  deriveSigningContextTarget,
  deriveCetSigningTarget
};
