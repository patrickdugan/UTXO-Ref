/**
 * Run: node bitvm3/utxo_referee/quirk_indexed_route_referee.test.js
 */

const {
  buildQuirkIndexedRouteClaim,
  verifyQuirkIndexedRouteClaim,
  buildQuirkIndexedChallengeEvidence
} = require('./quirk_indexed_route_referee');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertIncludes(values, expected, message) {
  if (!values.includes(expected)) {
    throw new Error(message || `expected ${expected} in ${values.join(',')}`);
  }
}

const SEMANTIC = '11'.repeat(32);
const ROUTE = '22'.repeat(32);
const ALT_ROUTE = '23'.repeat(32);
const UNKNOWN_ROUTE = '24'.repeat(32);
const WITHDRAWAL_ROOT = '33'.repeat(32);
const OUTPUT_HASH = '44'.repeat(32);
const LIVE_TRACE = '55'.repeat(32);
const COMMITMENT = '66'.repeat(32);
const OUTPOINT = `${'aa'.repeat(32)}:0`;

function context(overrides = {}) {
  return {
    quirkManifest: {
      entries: [
        {
          entry_id: 'qi-1-transcript_alias_router_dispute_graft',
          motif: 'transcript_multiplicity',
          surface_id: 'transcript_alias_router_dispute_graft',
          utxoref_binding: {
            route_transcript_candidate_hash: ROUTE
          }
        },
        {
          entry_id: 'qi-2-identifier_namespace_router_dispute_graft',
          motif: 'identifier_bifurcation',
          surface_id: 'identifier_namespace_router_dispute_graft',
          utxoref_binding: {
            route_transcript_candidate_hash: ALT_ROUTE
          }
        }
      ]
    },
    liveImportBundle: {
      imports: [
        {
          kind: 'btctest4_lnbtc_grant_import_v1',
          bindings: {
            semanticStateHash: SEMANTIC
          }
        },
        {
          kind: 'btctest4_utxoref_reserve_vault_import_v1',
          chain_ref: {
            outpoint: OUTPOINT
          },
          bindings: {
            bindingStatus: 'live_unspent_reserve_countable',
            withdrawalRootHex: WITHDRAWAL_ROOT,
            candidateFinalOutputVectorHash: OUTPUT_HASH,
            liveTraceHash: LIVE_TRACE,
            commitmentHashHex: COMMITMENT,
            routeTranscriptCandidates: [
              {
                entryId: 'qi-1-transcript_alias_router_dispute_graft',
                motif: 'transcript_multiplicity',
                routeTranscriptCandidateHash: ROUTE
              },
              {
                entryId: 'qi-2-identifier_namespace_router_dispute_graft',
                motif: 'identifier_bifurcation',
                routeTranscriptCandidateHash: ALT_ROUTE
              }
            ]
          },
          checks: {
            scriptMatchesManifest: true,
            valueMatchesManifest: true,
            recoveryStatus: {
              countable: true
            }
          }
        }
      ]
    },
    ...overrides
  };
}

function claim(overrides = {}) {
  return buildQuirkIndexedRouteClaim({
    motif: 'transcript_multiplicity',
    publicHandle: 'alias-aa',
    semanticStateHash: SEMANTIC,
    routeTranscriptHash: ROUTE,
    withdrawalRootHex: WITHDRAWAL_ROOT,
    finalOutputVectorHash: OUTPUT_HASH,
    liveTraceHash: LIVE_TRACE,
    commitmentHashHex: COMMITMENT,
    reserveOutpoint: OUTPOINT,
    challengeWindow: {
      startHeight: 143198,
      endHeight: 143342
    },
    ...overrides
  });
}

console.log('\n=== Quirk Indexed Route Referee Tests ===\n');

test('accepts a transcript alias over the live reserve witness', () => {
  const c = claim({ publicHandle: 'hybrid_transcript_alias_aa', transcriptAlias: 'aa' });
  const result = verifyQuirkIndexedRouteClaim(c, context());
  assert(result.ok, result.reason);
  assert(result.admissible, 'claim should be admissible');
});

test('accepts a rotated public namespace over the same semantic state', () => {
  const c = claim({
    motif: 'identifier_bifurcation',
    publicHandle: 'namespace-32',
    namespace: 'dummy_32',
    routeTranscriptHash: ALT_ROUTE
  });
  const result = verifyQuirkIndexedRouteClaim(c, context());
  assert(result.ok, result.reason);
});

test('rejects semantic mutation under an existing alias', () => {
  const c = claim({ semanticStateHash: '12'.repeat(32) });
  const result = verifyQuirkIndexedRouteClaim(c, context());
  assert(!result.ok, 'semantic mutation must fail');
  assertIncludes(result.failedChecks, 'semantic_state');
});

test('rejects a mutated withdrawal root', () => {
  const c = claim({ withdrawalRootHex: '34'.repeat(32) });
  const result = verifyQuirkIndexedRouteClaim(c, context());
  assert(!result.ok, 'withdrawal root mutation must fail');
  assertIncludes(result.failedChecks, 'withdrawal_root');
});

test('rejects a mutated final output vector hash', () => {
  const c = claim({ finalOutputVectorHash: '45'.repeat(32) });
  const result = verifyQuirkIndexedRouteClaim(c, context());
  assert(!result.ok, 'final output vector mutation must fail');
  assertIncludes(result.failedChecks, 'final_output_vector');
});

test('rejects a route transcript not present in the quirk candidate set', () => {
  const c = claim({ routeTranscriptHash: UNKNOWN_ROUTE });
  const result = verifyQuirkIndexedRouteClaim(c, context());
  assert(!result.ok, 'unknown route must fail');
  assertIncludes(result.failedChecks, 'route_transcript_candidate');
});

test('rejects a non-countable reserve import', () => {
  const badContext = context();
  badContext.liveImportBundle.imports[1].bindings.bindingStatus = 'live_unspent_reserve_not_countable';
  badContext.liveImportBundle.imports[1].checks.recoveryStatus.countable = false;
  const result = verifyQuirkIndexedRouteClaim(claim(), badContext);
  assert(!result.ok, 'non-countable reserve must fail');
  assertIncludes(result.failedChecks, 'live_reserve_status');
  assertIncludes(result.failedChecks, 'reserve_csv_countable');
});

test('challenge evidence is challengeable for rejected claims', () => {
  const c = claim({ finalOutputVectorHash: '45'.repeat(32) });
  const challenge = buildQuirkIndexedChallengeEvidence(c, context());
  assert(challenge.challengeable, 'rejected claim must produce challenge evidence');
  assertIncludes(challenge.core.violations, 'final_output_vector');
});

if (failed) {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed, ${failed} failed`);
