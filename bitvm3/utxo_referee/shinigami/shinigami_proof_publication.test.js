#!/usr/bin/env node

const {
  buildShinigamiProgramState,
  buildShinigamiProofPublication,
  buildShinigamiProofPublicationBundle,
  verifyShinigamiProofPublicationBundle
} = require('./shinigami_proof_publication');

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

console.log('\n=== Shinigami Proof Publication Tests ===\n');

test('program state builds a stable semantic state id', () => {
  const a = buildShinigamiProgramState({ programId: 'program-a', claimAmountSats: 100000n });
  const b = buildShinigamiProgramState({ programId: 'program-a', claimAmountSats: 100000n });

  assert(a.kind === 'shinigami_program_state', 'wrong state kind');
  assert(a.stateId === b.stateId, 'state id should be deterministic');
  assert(a.stateCore.claimAmountSats === '100000', 'amount mismatch');
});

test('publication carries Jurassic proof handles over one program state', () => {
  const programState = buildShinigamiProgramState({ programId: 'program-b' });
  const publication = buildShinigamiProofPublication({ programState });

  assert(publication.publicationCore.programStateId === programState.stateId, 'state not bound');
  assert(publication.publicationCore.transcriptSwitchboardId.length === 64, 'missing switchboard id');
  assert(publication.publicationCore.verifierHandleId.length === 64, 'missing verifier handle id');
  assert(publication.publicationCore.carrierCommitmentId.length === 64, 'missing carrier commitment id');
  assert(publication.publicationCore.taprootProofManifestId === programState.stateCore.taprootProofManifestId, 'missing taproot proof binding');
  assert(publication.publicationCore.status === 'scaffold_only', 'Shinigami should remain scaffold-only');
});

test('bundle verifies accepted receipt and slashable challenge', () => {
  const bundle = buildShinigamiProofPublicationBundle({
    programId: 'program-c',
    claimAmountSats: 123456n
  });
  const result = verifyShinigamiProofPublicationBundle(bundle);

  assert(result.ok, result.reason || 'bundle should verify');
  assert(bundle.challenge.slashable, 'challenge should be slashable');
  assert(bundle.bundleCore.jurassicMechanismRefId === bundle.publication.publicationCore.jurassicMechanismRefId);
  assert(bundle.bundleCore.taprootProofManifestId === bundle.taprootProofManifest.manifestId, 'bundle should bind taproot proof manifest');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
