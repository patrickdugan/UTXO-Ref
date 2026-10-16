#!/usr/bin/env node

const {
  buildArkDlcContract,
  buildVirtualCetSet,
  buildArkDlcSettlement,
  buildArkDlcAspChallenge,
  buildArkDlcFeeModel,
  buildArkDlcSettlementBundle,
  verifyArkDlcSettlementBundle
} = require('./ark_dlc_settlement');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

// Edit a bundle and re-derive every id above the edit, so only the verifier's own
// recomputation can refuse it.
function rebound(bundle, edit) {
  const out = JSON.parse(JSON.stringify(bundle));
  edit(out);
  if (out.settlementEvidence) {
    out.settlementEvidence.settlementId = hashCanonical(out.settlementEvidence.settlementCore);
    out.bundleCore.settlementId = out.settlementEvidence.settlementId;
  }
  if (out.challengeEvidence) {
    out.challengeEvidence.challengeId = hashCanonical(out.challengeEvidence.challengeCore);
    out.bundleCore.challengeId = out.challengeEvidence.challengeId;
  }
  out.bundleId = hashCanonical(out.bundleCore);
  return out;
}

console.log('\n=== Ark DLC Settlement Tests ===\n');

test('a settlement whose payouts do not follow the selected CET is refused', () => {
  const bundle = buildArkDlcSettlementBundle({ oracleOutcomeId: 'btc_up' });
  const forged = rebound(bundle, (b) => {
    const payouts = b.settlementEvidence.settlementCore.payouts;
    const [offer, accept] = Object.keys(payouts);
    payouts[offer].amountSats = (BigInt(payouts[offer].amountSats) + 1n).toString();
    payouts[accept].amountSats = (BigInt(payouts[accept].amountSats) - 1n).toString();
  });
  const result = verifyArkDlcSettlementBundle(forged);
  assert(!result.ok && /payoutsFollowCet/.test(result.reason), 'payouts must follow the CET, not the check flags');
});

test('a challenge whose violations do not follow from its core is refused', () => {
  const bundle = buildArkDlcSettlementBundle({
    oracleOutcomeId: 'btc_up',
    aspSettledOutcomeId: 'btc_down',
    challengeMissingForfeitPath: true
  });
  const forged = rebound(bundle, (b) => {
    b.challengeEvidence.challengeCore.violations = [];
  });
  const result = verifyArkDlcSettlementBundle(forged);
  assert(!result.ok && /violations/.test(result.reason), 'violations are recomputed from the core');
});



test('contract commits to parties, oracle, ASP, and outcome root', () => {
  const contract = buildArkDlcContract({ contractId: 'dlc-a', aspId: 'asp-a' });
  assert(contract.kind === 'ark_dlc_contract_commitment', 'wrong kind');
  assert(contract.contractCore.aspId === 'asp-a', 'asp mismatch');
  assert(contract.contractCore.totalCollateralSats === '100000', 'total collateral mismatch');
  assert(contract.contractCore.outcomesRoot.length === 64, 'missing outcome root');
});

test('virtual CET set commits all outcomes without on-chain CET broadcast', () => {
  const contract = buildArkDlcContract();
  const set = buildVirtualCetSet({ contract });
  assert(set.virtualCets.length === contract.outcomes.length, 'cet count mismatch');
  assert(set.virtualCetSetCore.noOnchainCet, 'expected virtual CET set');
  assert(set.virtualCets.every(cet => cet.cetCore.noOnchainCet), 'CET should be virtual');
});

test('settlement chooses oracle-selected CET and preserves collateral', () => {
  const contract = buildArkDlcContract();
  const virtualCetSet = buildVirtualCetSet({ contract });
  const settlement = buildArkDlcSettlement({
    contract,
    virtualCetSet,
    oracleOutcomeId: 'btc_up'
  });
  assert(settlement.settlementCore.noOnchainCetBroadcast, 'should not broadcast CET');
  assert(settlement.selectedCet.cetCore.outcomeId === 'btc_up', 'wrong outcome selected');
  assert(settlement.checks.payoutSumPreservesCollateral, 'collateral not preserved');
});

test('ASP challenge is slashable when ASP routes wrong outcome', () => {
  const bundle = buildArkDlcSettlementBundle({
    oracleOutcomeId: 'btc_up',
    aspSettledOutcomeId: 'btc_down',
    challengeMissingForfeitPath: true
  });
  assert(bundle.challengeEvidence.slashable, 'challenge should be slashable');
  assert(
    bundle.challengeEvidence.challengeCore.violations.includes('asp_settled_wrong_oracle_outcome'),
    'missing wrong-outcome violation'
  );
  assert(
    bundle.taprootProofManifest.manifestCore.selectedLeafRole === 'dlc_virtual_cet_settlement',
    'wrong taproot proof leaf'
  );
  assert(
    bundle.taprootProofManifest.manifestCore.selectedVirtualCetId ===
      bundle.settlementEvidence.settlementCore.selectedVirtualCetId,
    'taproot proof manifest should bind selected virtual CET'
  );
  assert(verifyArkDlcSettlementBundle(bundle).ok, 'bundle should verify');
});

test('fee model shows Ark happy path avoids on-chain CET fee', () => {
  const model = buildArkDlcFeeModel({
    outcomeCount: 5000,
    feeRateSatVb: 25,
    cetVbytes: 180,
    arkRoundParticipants: 50,
    aspFeeSats: 250n
  });
  assert(model.modelCore.avoidsOnchainCetHappyPath, 'Ark happy path should be cheaper');
  assert(model.modelCore.avoidsCetFanoutOnchainExposure, 'should avoid CET fanout onchain exposure');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
