'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildContractPlan } = require('../src/contract');
const {
  buildSettlementPackage, verifySettlementPackage, createResearchPartySignatures,
  finalizeRecoveryPackage, verifyRecoveryPackage, completeSettlement, getRefundTransaction
} = require('../src/settlement');
const {
  xOnlyPubkey, buildDlcOracle, dlcAttest, bytes32
} = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const {
  parseCanonicalUnsignedTransaction, parseCanonicalSignedTaprootTransaction
} = require('../../bitvm3/utxo_referee/dlc_transaction_validator');
const { verifySettlementWitness } = require('../../bitvm3/utxo_referee/dlc_signature_validator');
const { deriveDlcFundingInternalXonly } = require('../../bitvm3/utxo_referee/dlc_funding_output');
const { canonicalJson } = require('../../bitvm3/utxo_referee/dlc_canonical_json');

const PARTY_SECRETS = [11n, 22n];
const ORACLE_SECRETS = [101n, 202n, 303n];
const pubkey = (secret) => xOnlyPubkey(secret).toString('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
const hash = (value) => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const plan = buildContractPlan({
  schemaVersion: 1,
  network: 'bitcoin-regtest',
  quoteId: 'lnm-offline-fixture',
  market: { venue: 'lnmarkets', instrument: 'inverse_perp', pair: 'btc_usd' },
  side: 'long',
  entryPriceUsdCents: '10000000',
  notionalUsdCents: '100000',
  traderCollateralSats: '1000000',
  makerCollateralSats: '1000000',
  settlementFeeSats: '1000',
  anchorSats: '330',
  minimumPayoutSats: '1000',
  traderPayoutScript: `5120${pubkey(111n)}`,
  makerPayoutScript: `5120${pubkey(222n)}`,
  anchorScript: `5120${pubkey(333n)}`,
  traderPubkeyX: pubkey(PARTY_SECRETS[0]),
  makerPubkeyX: pubkey(PARTY_SECRETS[1]),
  refundCsvBlocks: 12,
  maturityHeight: 220,
  refundHeight: 250,
  oracleEventId: 'lnm-fixture-btcusd-220',
  settlementPricesUsdCents: ['9000000', '10000000', '11000000'],
  oracleThreshold: 2,
  oraclePubkeys: ORACLE_SECRETS.map(pubkey).sort()
});
const oracleStates = ORACLE_SECRETS.map((secret, index) => buildDlcOracle(secret, BigInt(index + 500), {
  eventId: plan.terms.oracleEventId,
  outcomeMessages: plan.outcomes.map((row) => Buffer.from(row.outcomeMessage, 'hex'))
}));
const settlementPackage = buildSettlementPackage({
  plan,
  oracleAnnouncements: oracleStates,
  fundingOutpoint: { txid: 'a1'.repeat(32), vout: 1 }
});
const partySignatures = PARTY_SECRETS.map((partySecret) => createResearchPartySignatures({
  settlementPackage, partySecret, acknowledgeResearchCrypto: true
}));
const recoveryPackage = finalizeRecoveryPackage({ settlementPackage, partySignatures });
const outcomeId = plan.outcomes[2].outcomeMessage;
const attestations = oracleStates.map((oracle) => ({
  oraclePubkeyX: oracle.px,
  scalarHex: bytes32(dlcAttest(oracle, Buffer.from(outcomeId, 'hex'))).toString('hex')
}));
const expectedPlanId = plan.planDigest;
const expectedRecoveryDigest = recoveryPackage.recoveryDigest;

test('builds nine Bitcoin CETs covering every two-of-three pair, with one fixed funding output', () => {
  const { transactionSet } = settlementPackage;
  assert.equal(transactionSet.cets.length, plan.outcomes.length * 3);
  assert.equal(new Set(transactionSet.cets.map((cet) => cet.txid)).size, 9);
  assert.equal(transactionSet.funding.valueSats, '2001330');
  assert.equal(transactionSet.funding.partyPubkeyXs.length, 2);
  assert.ok(!transactionSet.funding.partyPubkeyXs.includes(deriveDlcFundingInternalXonly()));
  for (const cet of transactionSet.cets) {
    const decoded = parseCanonicalUnsignedTransaction(cet.rawTxHex);
    assert.equal(decoded.inputs.length, 1);
    assert.equal(decoded.inputs[0].txid, settlementPackage.fundingOutpoint.txid);
    assert.equal(decoded.inputs[0].vout, 1);
    assert.equal(decoded.locktime, 220);
    assert.equal(decoded.inputs[0].sequence >>> 31, 1);
    assert.ok(decoded.inputs[0].sequence < 0xfffffffe);
    assert.equal(cet.outputs[2].scriptPubKeyHex, plan.terms.anchorScript);
    assert.equal(cet.outputs[2].valueSats, '330');
    const total = cet.outputs.reduce((sum, entry) => sum + BigInt(entry.valueSats), 0n);
    assert.equal(total + BigInt(cet.feeSats), BigInt(plan.fundingValueSats));
  }
  assert.equal(settlementPackage.fundedExecutionAllowed, false);
  assert.equal(settlementPackage.evidenceTier, 'LOCAL_SIMULATION');
});

test('reference signing requires the fixture acknowledgement and a committed party key', () => {
  assert.throws(() => createResearchPartySignatures({ settlementPackage, partySecret: 11n }), /acknowledgeResearchCrypto/);
  assert.throws(() => createResearchPartySignatures({
    settlementPackage, partySecret: 99n, acknowledgeResearchCrypto: true
  }), /not a party/);
});

test('recovery cannot be prepared with one party, a duplicate signer, or an incomplete CET set', () => {
  assert.throws(() => finalizeRecoveryPackage({ settlementPackage, partySignatures: [partySignatures[0]] }), /both parties/);
  assert.throws(() => finalizeRecoveryPackage({
    settlementPackage, partySignatures: [partySignatures[0], partySignatures[0]]
  }), /distinct signature bundle/);
  const missing = clone(partySignatures);
  missing[0].cetSignatures.pop();
  assert.throws(() => finalizeRecoveryPackage({ settlementPackage, partySignatures: missing }), /every transaction/);
});

test('rejects a broken refund signature and a CET presignature for another oracle point', () => {
  const refund = clone(partySignatures);
  refund[0].refundSignature = '00'.repeat(64);
  assert.throws(() => finalizeRecoveryPackage({ settlementPackage, partySignatures: refund }), /refund signature is invalid/);
  const cet = clone(partySignatures);
  cet[0].cetSignatures[0].presignature = cet[0].cetSignatures[1].presignature;
  assert.throws(() => finalizeRecoveryPackage({ settlementPackage, partySignatures: cet }), /adaptor point does not match/);
});

test('a fresh process completes settlement from public saved JSON and attestations after the venue disappears', () => {
  const executable = path.resolve(__dirname, '../src/settlement.js');
  const child = spawnSync(process.execPath, ['-e', [
    "const fs = require('node:fs');",
    'const { completeSettlement } = require(process.argv[1]);',
    "const request = JSON.parse(fs.readFileSync(0, 'utf8'));",
    'process.stdout.write(JSON.stringify(completeSettlement(request)));'
  ].join('\n'), executable], {
    input: JSON.stringify({ recoveryPackage, expectedPlanId, expectedRecoveryDigest, outcomeId, attestations: attestations.slice(0, 2) }),
    encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  const settled = JSON.parse(child.stdout);
  const decoded = verifySettlementWitness({
    transactionSet: settlementPackage.transactionSet, executionType: 'cet',
    cetTxid: settled.txid, signedTxHex: settled.rawTxHex
  });
  assert.equal(decoded.txid, settled.txid);
  assert.equal(settled.outputs[0].valueSats, plan.outcomes[2].traderPayoutSats);
  assert.equal(settled.outputs[1].valueSats, plan.outcomes[2].makerPayoutSats);
  assert.equal(settled.fundedExecutionAllowed, false);
  assert.equal(settled.chainMaturityVerified, false);
});

test('every oracle pair completes the same payout while preserving unique transaction identities', () => {
  const transactions = [[0, 1], [0, 2], [1, 2]].map((indices) => completeSettlement({
    recoveryPackage: clone(recoveryPackage), expectedPlanId, expectedRecoveryDigest, outcomeId,
    attestations: indices.map((index) => attestations[index])
  }));
  assert.equal(new Set(transactions.map((tx) => tx.txid)).size, 3);
  for (const tx of transactions) assert.deepEqual(tx.outputs, transactions[0].outputs);
});

test('fails on duplicate, missing, or unpinned oracle attestations', () => {
  const request = { recoveryPackage, expectedPlanId, expectedRecoveryDigest, outcomeId };
  assert.throws(() => completeSettlement({ ...request, attestations: [attestations[0]] }), /exactly two/);
  assert.throws(() => completeSettlement({
    ...request, attestations: [attestations[0], attestations[0]]
  }), /duplicate oracle/);
  const foreign = { ...attestations[1], oraclePubkeyX: pubkey(404n) };
  assert.throws(() => completeSettlement({
    ...request, attestations: [attestations[0], foreign]
  }), /not in the pinned set/);
});

test('attestations cannot select another committed payoff or an unknown outcome', () => {
  assert.throws(() => completeSettlement({
    recoveryPackage, expectedPlanId, expectedRecoveryDigest, outcomeId: plan.outcomes[0].outcomeMessage,
    attestations: attestations.slice(0, 2)
  }), /invalid oracle attestation/);
  assert.throws(() => completeSettlement({
    recoveryPackage, expectedPlanId, expectedRecoveryDigest, outcomeId: 'ff'.repeat(32), attestations: attestations.slice(0, 2)
  }), /outside the committed payoff/);
});

test('a saved refund restores with both signatures and the committed CSV delay, without oracle data', () => {
  const restored = getRefundTransaction({ recoveryPackage: clone(recoveryPackage), expectedPlanId, expectedRecoveryDigest });
  const parsed = parseCanonicalSignedTaprootTransaction(restored.rawTxHex);
  assert.equal(parsed.unsignedTransaction.inputs[0].sequence, 12);
  assert.equal(parsed.unsignedTransaction.locktime, 250);
  assert.equal(parsed.witness[0].length, 4);
  assert.equal(parsed.witness[0][0].length, 128);
  assert.equal(parsed.witness[0][1].length, 128);
  assert.equal(restored.outputs[0].valueSats, '1000000');
  assert.equal(restored.outputs[1].valueSats, '1000000');
  assert.equal(restored.rawTxHex, recoveryPackage.signedRefundTxHex);
  assert.equal(restored.chainMaturityVerified, false);
});

test('the independent plan pin prevents a replacement package from being accepted', () => {
  assert.throws(() => verifyRecoveryPackage(recoveryPackage, { expectedPlanId: 'ff'.repeat(32), expectedRecoveryDigest }), /pinned plan digest/);
  assert.throws(() => verifyRecoveryPackage(recoveryPackage, {}), /expectedPlanId/);
  assert.throws(() => verifyRecoveryPackage(recoveryPackage, { expectedPlanId }), /expectedRecoveryDigest/);
});

test('two valid packages for the same terms cannot exchange their independently retained recovery pins', () => {
  const anotherSettlement = buildSettlementPackage({
    plan, oracleAnnouncements: oracleStates,
    fundingOutpoint: { txid: 'b2'.repeat(32), vout: 2 }
  });
  const anotherSignatures = PARTY_SECRETS.map((partySecret) => createResearchPartySignatures({
    settlementPackage: anotherSettlement, partySecret, acknowledgeResearchCrypto: true
  }));
  const anotherRecovery = finalizeRecoveryPackage({
    settlementPackage: anotherSettlement, partySignatures: anotherSignatures
  });
  assert.equal(anotherSettlement.plan.planDigest, expectedPlanId);
  assert.notEqual(anotherRecovery.recoveryDigest, expectedRecoveryDigest);
  assert.throws(() => verifyRecoveryPackage(anotherRecovery, {
    expectedPlanId, expectedRecoveryDigest
  }), /pinned recovery digest/);
  assert.equal(verifyRecoveryPackage(anotherRecovery, {
    expectedPlanId, expectedRecoveryDigest: anotherRecovery.recoveryDigest
  }).settlementPackage.fundingOutpoint.txid, 'b2'.repeat(32));
});

test('transaction reconstruction rejects edited bytes even if package hashes are recomputed', () => {
  const forged = clone(settlementPackage);
  forged.transactionSet.cets[0].outputs[0].valueSats = '1';
  delete forged.packageDigest;
  forged.packageDigest = hash(forged);
  assert.throws(() => verifySettlementPackage(forged), /rebuilt from its committed plan/);
  const changedOutpoint = clone(settlementPackage);
  changedOutpoint.fundingOutpoint.txid = 'b2'.repeat(32);
  assert.throws(() => verifySettlementPackage(changedOutpoint), /rebuilt from its committed plan/);
});

test('recovery verification rejects a replaced signed refund and a changed signature binding', () => {
  const forged = clone(recoveryPackage);
  forged.signedRefundTxHex = '00';
  delete forged.recoveryDigest;
  forged.recoveryDigest = hash(forged);
  assert.throws(() => verifyRecoveryPackage(forged, { expectedPlanId, expectedRecoveryDigest }), /pinned recovery digest/);
  const unbound = clone(recoveryPackage);
  unbound.partySignatures[0].packageDigest = '00'.repeat(32);
  assert.throws(() => verifyRecoveryPackage(unbound, { expectedPlanId, expectedRecoveryDigest }), /does not bind this settlement package/);
});

test('stored public packages contain no party secrets or oracle signer state', () => {
  const forbidden = new Set(['partySecret', 'oracleSecret', 'nonceSecret', 'privateKey', 'secret']);
  function visit(value) {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), `unexpected secret field ${key}`);
      visit(child);
    }
  }
  visit(recoveryPackage);
  assert.deepEqual(verifyRecoveryPackage(clone(recoveryPackage), { expectedPlanId, expectedRecoveryDigest }), recoveryPackage);
});

test('signature packet fields reject injected private material at the restore boundary', () => {
  const forged = clone(recoveryPackage);
  forged.partySignatures[0].cetSignatures[0].partySecret = 'fixture-secret';
  assert.throws(() => verifyRecoveryPackage(forged, {
    expectedPlanId, expectedRecoveryDigest
  }), /CET signature entries must contain only/);
});

test('deserialization rejects executable getters before reading them', () => {
  let invoked = false;
  const forged = { ...recoveryPackage };
  Object.defineProperty(forged, 'signedRefundTxHex', {
    enumerable: true,
    get() { invoked = true; return recoveryPackage.signedRefundTxHex; }
  });
  assert.throws(() => verifyRecoveryPackage(forged, { expectedPlanId, expectedRecoveryDigest }), /enumerable data property/);
  assert.equal(invoked, false);
});
