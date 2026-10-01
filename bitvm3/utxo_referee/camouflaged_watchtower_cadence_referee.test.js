/**
 * Run: node bitvm3/utxo_referee/camouflaged_watchtower_cadence_referee.test.js
 */

const {
  buildSemanticAlertHash,
  buildCamouflagedWatchtowerCadenceClaim,
  verifyCamouflagedWatchtowerCadenceClaim,
  buildCamouflagedWatchtowerCadenceChallenge
} = require('./camouflaged_watchtower_cadence_referee');

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

const ROUTE_CLAIM_HASH = '11'.repeat(32);
const WRONG_ROUTE_CLAIM_HASH = '12'.repeat(32);
const LIVE_TRACE = '22'.repeat(32);
const OUTPOINT = `${'aa'.repeat(32)}:0`;
const CURRENT_HEIGHT = 2000;
const WATCHTOWER_EPOCH = 'watchtower-2000';
const PUBLICATION_HANDLE = 'sweep-cover-watchtower-2000';
const PAYOUT_HANDLE = 'payout-batch-watchtower-2000';
const SEMANTIC_ALERT = buildSemanticAlertHash({
  routeClaimHash: ROUTE_CLAIM_HASH,
  reserveOutpoint: OUTPOINT,
  watchtowerEpoch: WATCHTOWER_EPOCH
});

function context(overrides = {}) {
  return {
    currentHeight: CURRENT_HEIGHT,
    routeDemo: {
      scenarios: [
        {
          id: 'accepted_transcript_alias_compact',
          claim: {
            claimHash: ROUTE_CLAIM_HASH
          },
          verification: {
            admissible: true
          }
        },
        {
          id: 'rejected_unknown_route_transcript',
          claim: {
            claimHash: WRONG_ROUTE_CLAIM_HASH
          },
          verification: {
            admissible: false
          }
        }
      ]
    },
    publicationRegistry: [
      {
        publicationHandle: PUBLICATION_HANDLE,
        routeClaimHash: ROUTE_CLAIM_HASH,
        semanticAlertHash: SEMANTIC_ALERT
      },
      {
        publicationHandle: PAYOUT_HANDLE,
        routeClaimHash: ROUTE_CLAIM_HASH,
        semanticAlertHash: SEMANTIC_ALERT
      },
      {
        publicationHandle: 'wrong-route-watchtower-2000',
        routeClaimHash: WRONG_ROUTE_CLAIM_HASH,
        semanticAlertHash: SEMANTIC_ALERT
      }
    ],
    liveImportBundle: {
      node: {
        blocks: CURRENT_HEIGHT
      },
      imports: [
        {
          kind: 'btctest4_utxoref_reserve_vault_import_v1',
          chain_ref: {
            outpoint: OUTPOINT
          },
          bindings: {
            bindingStatus: 'live_unspent_reserve_countable',
            liveTraceHash: LIVE_TRACE
          },
          checks: {
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
  return buildCamouflagedWatchtowerCadenceClaim({
    reserveOutpoint: OUTPOINT,
    liveTraceHash: LIVE_TRACE,
    watchtowerEpoch: WATCHTOWER_EPOCH,
    expectedCadenceBlocks: 12,
    publicationHeight: 1994,
    carrierProfile: 'wallet_sweep_checkpoint',
    publicationHandle: PUBLICATION_HANDLE,
    semanticAlertHash: SEMANTIC_ALERT,
    routeClaimHash: ROUTE_CLAIM_HASH,
    ...overrides
  });
}

console.log('\n=== Camouflaged Watchtower Cadence Referee Tests ===\n');

test('accepts a sweep-like checkpoint for an admitted route claim', () => {
  const result = verifyCamouflagedWatchtowerCadenceClaim(claim(), context());
  assert(result.ok, result.reason);
});

test('accepts a payout-batch checkpoint for the same semantic alert', () => {
  const result = verifyCamouflagedWatchtowerCadenceClaim(claim({
    carrierProfile: 'payout_batch_checkpoint',
    publicationHandle: PAYOUT_HANDLE
  }), context());
  assert(result.ok, result.reason);
});

test('rejects stale cadence checkpoints', () => {
  const result = verifyCamouflagedWatchtowerCadenceClaim(claim({
    publicationHeight: 1980
  }), context());
  assert(!result.ok, 'stale checkpoint must fail');
  assertIncludes(result.failedChecks, 'cadence_freshness');
});

test('rejects alert handles bound to the wrong route claim', () => {
  const result = verifyCamouflagedWatchtowerCadenceClaim(claim({
    publicationHandle: 'wrong-route-watchtower-2000'
  }), context());
  assert(!result.ok, 'wrong handle binding must fail');
  assertIncludes(result.failedChecks, 'publication_handle_binding');
});

test('rejects non-admitted route claims', () => {
  const badAlert = buildSemanticAlertHash({
    routeClaimHash: WRONG_ROUTE_CLAIM_HASH,
    reserveOutpoint: OUTPOINT,
    watchtowerEpoch: WATCHTOWER_EPOCH
  });
  const result = verifyCamouflagedWatchtowerCadenceClaim(claim({
    routeClaimHash: WRONG_ROUTE_CLAIM_HASH,
    semanticAlertHash: badAlert
  }), context());
  assert(!result.ok, 'non-admitted route claim must fail');
  assertIncludes(result.failedChecks, 'admitted_route_claim');
});

test('rejects stale reserve evidence', () => {
  const badContext = context();
  badContext.liveImportBundle.imports[0].bindings.bindingStatus = 'live_unspent_reserve_not_countable';
  badContext.liveImportBundle.imports[0].checks.recoveryStatus.countable = false;
  const result = verifyCamouflagedWatchtowerCadenceClaim(claim(), badContext);
  assert(!result.ok, 'non-countable reserve must fail');
  assertIncludes(result.failedChecks, 'live_reserve_status');
  assertIncludes(result.failedChecks, 'reserve_csv_countable');
});

test('challenge evidence is challengeable for rejected checkpoints', () => {
  const c = claim({ publicationHeight: 1980 });
  const challenge = buildCamouflagedWatchtowerCadenceChallenge(c, context());
  assert(challenge.challengeable, 'stale checkpoint must produce challenge evidence');
  assertIncludes(challenge.core.violations, 'cadence_freshness');
});

if (failed) {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\n${passed} passed, ${failed} failed`);
