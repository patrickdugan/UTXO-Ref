/**
 * Milestone 1 Fast Roll Tests
 *
 * Run: node bitvm3/utxo_referee/m1_fast_roll.test.js
 */

const {
  buildOracleDeltaPublication,
  buildFastRollHandoff,
  buildChallengeWitnessBundle
} = require('./index');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(msg || `expected ${expected}, got ${actual}`);
  }
}

console.log('\n=== Milestone 1 Fast Roll Tests ===\n');

const baseBundle = {
  bundleHash: 'aa'.repeat(32),
  binding: {
    fundingOutpoint: {
      txid: '11'.repeat(32),
      vout: 0,
      valueSats: '798100'
    }
  },
  selectedPathId: 'roll',
  selectedPath: {
    pathId: 'roll',
    txid: '22'.repeat(32),
    residualSats: '758195',
    rolloverCollateralSats: '758195',
    dustCarrySats: '0',
    adaptorSignaturePlaceholder: 'adaptor_sig_for_roll',
    adaptorPointPlaceholder: 'adaptor_point_for_roll'
  },
  oracleBinding: {
    eventId: 'm1_oracle_event_123',
    quorumId: 'quorum_1of1',
    keyId: 'oracle_key_1',
    oracleMapId: 'abcd1234ef567890',
    adaptorSignaturePlaceholder: 'adaptor_sig_for_roll',
    adaptorPointPlaceholder: 'adaptor_point_for_roll',
    messageDigestHex: 'bb'.repeat(32),
    messagePayload: 'm1_oracle_attestation'
  }
};

test('oracle delta publication emits a compact OP_RETURN script', () => {
  const publication = buildOracleDeltaPublication({
    oracleBinding: baseBundle.oracleBinding,
    selectedPath: baseBundle.selectedPath,
    bundleHash: baseBundle.bundleHash,
    deltaSats: 758195n
  });

  assertEq(publication.kind, 'm1_oracle_delta_publication');
  assertEq(publication.oracleMapId, baseBundle.oracleBinding.oracleMapId);
  assertEq(publication.deltaSats, '758195');
  assert(publication.opReturnScriptHex.startsWith('6a'), 'OP_RETURN prefix missing');
  assertEq(publication.rollTrigger.canRoll, true);
  assertEq(publication.adaptorMapping.adaptorSignaturePlaceholder, 'adaptor_sig_for_roll');
});

test('fast roll handoff binds publication to next contract id', () => {
  const handoff = buildFastRollHandoff({
    challengeBundle: baseBundle,
    oracleWiring: {
      oracle: baseBundle.oracleBinding,
      binding: baseBundle.binding
    }
  });

  assertEq(handoff.kind, 'm1_fast_roll_handoff');
  assertEq(handoff.oracleMapId, baseBundle.oracleBinding.oracleMapId);
  assertEq(handoff.publication.rollTrigger.activation, 'send');
  assertEq(handoff.nextContract.cadence, 'event-driven');
  assertEq(handoff.nextContract.route, 'roll');
  assert(handoff.nextContract.contractId.length > 0, 'next contract id missing');
});

test('challenge witness carries delta publication metadata', () => {
  const publication = buildOracleDeltaPublication({
    oracleBinding: baseBundle.oracleBinding,
    selectedPath: baseBundle.selectedPath,
    bundleHash: baseBundle.bundleHash,
    deltaSats: 758195n
  });

  const witness = buildChallengeWitnessBundle({
    challengeBundle: {
      ...baseBundle,
      deltaPublication: publication
    },
    transitionState: {
      epochId: 1n,
      challengeWindowStart: 1n,
      challengeWindowLength: 2n,
      challengeWindowEnd: 3n
    }
  });

  assertEq(witness.transitionState.deltaPublicationId, publication.publicationId);
  assertEq(witness.transitionState.deltaPublicationNextContractId, publication.rollTrigger.nextContractId);
  assertEq(witness.honestPath.deltaPublication.publicationId, publication.publicationId);
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
