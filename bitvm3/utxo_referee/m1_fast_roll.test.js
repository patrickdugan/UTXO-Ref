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

const settlementBundle = {
  bundleHash: 'cc'.repeat(32),
  binding: {
    fundingOutpoint: {
      txid: '33'.repeat(32),
      vout: 1,
      valueSats: '798100'
    },
    dustCarrySats: '0'
  },
  selectedPathId: 'settle-loss',
  selectedPath: {
    pathId: 'settle-loss',
    kind: 'settlement',
    txid: '44'.repeat(32),
    payoutSats: '12370',
    actualPayoutSats: '12370',
    refundSats: '783735',
    residualSats: '783735',
    rolloverCollateralSats: '783735',
    feeSats: '1995',
    dustCarrySats: '0',
    bucketCapBps: 500,
    realizedPnlBps: 155,
    effectivePnlBps: 155,
    feeBps: 25,
    winnerRole: 'bob',
    winnerAddress: 'tltc1qwinner',
    refundRole: 'residual',
    refundAddress: 'tltc1qrefund',
    feeRole: 'operator',
    feeAddress: 'tltc1qfee',
    dustRole: 'bob',
    dustAddress: 'tltc1qdust',
    adaptorSignaturePlaceholder: 'adaptor_sig_for_settle-loss',
    adaptorPointPlaceholder: 'adaptor_point_for_settle-loss',
    messageDigestHex: 'dd'.repeat(32)
  },
  oracleBinding: {
    eventId: 'm1_oracle_event_settle_loss',
    quorumId: 'quorum_1of1',
    keyId: 'oracle_key_1',
    oracleMapId: 'feed1234ef567890',
    adaptorSignaturePlaceholder: 'adaptor_sig_for_settle-loss',
    adaptorPointPlaceholder: 'adaptor_point_for_settle-loss',
    messageDigestHex: 'dd'.repeat(32),
    messagePayload: 'm1_oracle_attestation_v1|settle-loss',
    oracleSignaturePlaceholder: 'oracle_sig_for_settle-loss'
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

test('settlement publication keeps DLC trigger interpretation from witness template', () => {
  const publication = buildOracleDeltaPublication({
    oracleBinding: settlementBundle.oracleBinding,
    selectedPath: settlementBundle.selectedPath,
    bundleHash: settlementBundle.bundleHash,
    deltaSats: 783735n
  });

  assertEq(publication.pathId, 'settle-loss');
  assertEq(publication.deltaSats, '783735');
  assertEq(publication.adaptorMapping.cetTxid, settlementBundle.selectedPath.txid);
  assertEq(publication.adaptorMapping.messageDigestHex, settlementBundle.selectedPath.messageDigestHex);
  assertEq(publication.adaptorMapping.selectedPathId, 'settle-loss');
  assertEq(publication.adaptorMapping.adaptorSignaturePlaceholder, 'adaptor_sig_for_settle-loss');
  assertEq(publication.adaptorMapping.adaptorPointPlaceholder, 'adaptor_point_for_settle-loss');
  assertEq(publication.rollTrigger.activation, 'send');
  assert(publication.payloadText.includes('settle-loss'), 'publication payload should name the selected DLC path');
});

test('settlement witness propagates oracle trigger fields from template data', () => {
  const publication = buildOracleDeltaPublication({
    oracleBinding: settlementBundle.oracleBinding,
    selectedPath: settlementBundle.selectedPath,
    bundleHash: settlementBundle.bundleHash,
    deltaSats: 783735n
  });

  const witness = buildChallengeWitnessBundle({
    challengeBundle: {
      ...settlementBundle,
      deltaPublication: publication
    },
    transitionState: {
      epochId: 1n,
      challengeWindowStart: 10n,
      challengeWindowLength: 6n,
      challengeWindowEnd: 16n
    },
    cetPreimageOrSig: 'settlement_cet_sig'
  });

  assertEq(witness.route, 'settle-loss');
  assertEq(witness.requiresOracle, true);
  assertEq(witness.transitionState.deltaPublicationId, publication.publicationId);
  assertEq(witness.transitionState.deltaPublicationHash, publication.publicationHash);
  assertEq(witness.transitionState.deltaPublicationNextContractId, publication.rollTrigger.nextContractId);
  assertEq(witness.honestPath.oracleMessageDigestHex, settlementBundle.oracleBinding.messageDigestHex);
  assertEq(witness.honestPath.oracleMessagePayload, settlementBundle.oracleBinding.messagePayload);
  assertEq(witness.honestPath.oracleSignature, settlementBundle.oracleBinding.oracleSignaturePlaceholder);
  assertEq(witness.honestPath.cetPreimageOrSig, 'settlement_cet_sig');
  assertEq(witness.honestPath.deltaPublication.publicationId, publication.publicationId);
  assertEq(witness.challengedPath.attestationDigest, settlementBundle.oracleBinding.messageDigestHex);
  assertEq(witness.challengedPath.deltaPublication.rollTrigger.nextContractId, publication.rollTrigger.nextContractId);
});

test('settlement witness template rejects missing oracle trigger fields', () => {
  let threw = false;
  try {
    buildChallengeWitnessBundle({
      challengeBundle: {
        ...settlementBundle,
        oracleBinding: {
          ...settlementBundle.oracleBinding,
          messageDigestHex: null,
          oracleSignaturePlaceholder: null
        }
      }
    });
  } catch (err) {
    threw = String(err.message).includes('oracle message digest is required');
  }

  assert(threw, 'expected settlement witness assembly to reject missing oracle trigger fields');
});

console.log('\n-----------------------------------');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('-----------------------------------\n');

if (failed > 0) {
  process.exit(1);
}
