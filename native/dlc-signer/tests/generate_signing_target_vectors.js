#!/usr/bin/env node
'use strict';

/**
 * Writes tests/signing_target_vectors.json: one valid signing context with the
 * values the host derives for it, and invalid contexts each signer must refuse.
 * The vectors are a frozen snapshot (oracle nonces are random); both
 * bitvm3/utxo_referee/dlc_signing_target.test.js and `cargo test --lib`
 * check their implementation against the same file.
 *
 *   node native/dlc-signer/tests/generate_signing_target_vectors.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const referee = path.join(__dirname, '..', '..', '..', 'bitvm3', 'utxo_referee');
const dlc = require(path.join(referee, 'tradelayer_dlc_adaptor_sig'));
const { canonicalJson } = require(path.join(referee, 'dlc_canonical_json'));
const { deriveDlcFundingInternalXonly } = require(path.join(referee, 'dlc_funding_output'));
const { buildDlcSigningFixture } = require(path.join(referee, 'dlc_signing_fixture'));
const { deriveSigningContextTarget } = require(path.join(referee, 'dlc_signing_target'));

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const digestJson = (value) => sha256(Buffer.from(canonicalJson(value), 'utf8')).toString('hex');
const scalar = (label) => (dlc.bufToBig(sha256(`signing-target-vectors:${label}`)) % (dlc.N - 1n)) + 1n;

const announcements = [0, 1, 2].map((index) => dlc.buildDlcOracle(scalar(`oracle:${index}`), scalar(`nonce:${index}`), {
  eventId: 'signing-target-vector-event',
  outcomeMessages: [sha256('vector:yes'), sha256('vector:no')]
}));
const signerSecret = scalar('signer');
const fixture = buildDlcSigningFixture({
  signerSecret,
  counterpartySecret: scalar('counterparty'),
  announcements,
  fundingTxid: 'b7'.repeat(32),
  fundingVout: 1
});
const target = deriveSigningContextTarget(fixture.signingContext);
const signingContext = JSON.parse(canonicalJson({
  transactionSet: fixture.transactionSet,
  cetTxid: fixture.cetTxid,
  oracleAnnouncements: fixture.oracleAnnouncements
}));
const signerPubkeyX = dlc.xOnlyPubkey(signerSecret).toString('hex');
const signed = {
  signerPubkeyX,
  cetTxid: target.cetTxid,
  cetSetDigest: target.cetSetDigest,
  fundingTemplateDigest: target.fundingTemplateDigest,
  oracleAnnouncementsDigest: target.oracleAnnouncementsDigest,
  oracleEventId: target.oracleEventId,
  sighash: target.sighash,
  adaptorPoint: { x: target.adaptorPoint.x, y: target.adaptorPoint.y }
};

const clone = () => JSON.parse(JSON.stringify(signingContext));
const redigestCets = (context) => { context.transactionSet.cetSetDigest = digestJson(context.transactionSet.cets); };
const namedCet = (context) => context.transactionSet.cets.find((cet) => cet.txid === context.cetTxid);
const txidOf = (rawTxHex) => Buffer.from(sha256(sha256(Buffer.from(rawTxHex, 'hex')))).reverse().toString('hex');

const invalid = [];
function invalidCase(name, errorContains, mutate) {
  const context = clone();
  mutate(context);
  invalid.push({ name, errorContains, signingContext: context });
}
invalidCase('uncommitted CET txid', 'absent from the committed CET set', (context) => {
  context.cetTxid = sha256('vector:uncommitted').toString('hex');
});
invalidCase('CET set digest does not match the CETs', 'cetSetDigest does not match', (context) => {
  context.transactionSet.cetSetDigest = '00'.repeat(32);
});
invalidCase('single-key funding script', 'not the two-party DLC output', (context) => {
  const funding = context.transactionSet.funding;
  funding.scriptPubKeyHex = `5120${funding.partyPubkeyXs[0]}`;
  context.transactionSet.fundingTemplateDigest = digestJson(funding);
});
invalidCase('CET bytes do not hash to the named txid', 'does not hash to the named txid', (context) => {
  const cet = namedCet(context);
  cet.rawTxHex = `${cet.rawTxHex.slice(0, -8)}01000000`;
  redigestCets(context);
});
invalidCase('CET spends another outpoint', 'does not spend the committed funding outpoint', (context) => {
  const cet = namedCet(context);
  cet.rawTxHex = `${cet.rawTxHex.slice(0, 10)}${'cd'.repeat(32)}${cet.rawTxHex.slice(74)}`;
  cet.txid = txidOf(cet.rawTxHex);
  context.cetTxid = cet.txid;
  redigestCets(context);
});
invalidCase('forged oracle announcement', 'does not verify', (context) => {
  const announcement = context.oracleAnnouncements[0];
  announcement.signature = `${announcement.signature.slice(0, -1)}${announcement.signature.endsWith('0') ? '1' : '0'}`;
});
invalidCase('CET outcome not committed by the oracles', 'not committed by the oracle announcement', (context) => {
  namedCet(context).outcomeMessage = sha256('vector:uncommitted-outcome').toString('hex');
  redigestCets(context);
});
invalidCase('CET oracle outside the announcement set', 'not in the announcement set', (context) => {
  const cet = namedCet(context);
  cet.oraclePubkeys = [cet.oraclePubkeys[0], 'ff'.repeat(31) + 'fe'].sort();
  redigestCets(context);
});

const vectors = {
  kind: 'utxoref_dlc_signing_target_vectors_v1',
  valid: {
    signingContext,
    expected: {
      internalXonly: deriveDlcFundingInternalXonly(),
      scriptPubKeyHex: fixture.transactionSet.funding.scriptPubKeyHex,
      ...signed
    },
    payload: signed,
    request: { ...signed, signingContext }
  },
  invalid
};
const outputPath = path.join(__dirname, 'signing_target_vectors.json');
fs.writeFileSync(outputPath, `${JSON.stringify(vectors, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), outputPath)} (${invalid.length} invalid cases)`);
