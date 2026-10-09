#!/usr/bin/env node

const {
  buildArkLiquidityInventory,
  buildLightningRouteDemand,
  buildBitvmEnforcementPolicy,
  allocateArkGrafts,
  buildArkLiquidityGraftManagerBundle,
  verifyArkLiquidityGraftManagerBundle
} = require('./ark_liquidity_graft_manager');

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

console.log('\n=== Ark Liquidity Graft Manager Tests ===\n');

test('inventory commits Ark VTXOs to one ASP and template', () => {
  const inventory = buildArkLiquidityInventory({
    aspId: 'asp-a',
    templateId: 'tpl-a',
    vtxoAmountsSats: [25000n, 50000n]
  });
  assert(inventory.kind === 'ark_ln_liquidity_inventory', 'wrong inventory kind');
  assert(inventory.inventoryCore.aspId === 'asp-a', 'asp mismatch');
  assert(inventory.inventoryCore.vtxos.length === 2, 'vtxo count mismatch');
  assert(
    inventory.inventoryCore.vtxos.every(vtxo => vtxo.exitTxid && vtxo.forfeitTxid),
    'inventory should expose exit and forfeit paths'
  );
});

test('route demand commits public Lightning constraints without leaking preimages', () => {
  const demand = buildLightningRouteDemand({
    routeIntents: [{ routeId: 'r-a', requestedInboundSats: 25000n, maxFeePpm: 700 }]
  });
  assert(demand.demandCore.routeIntents[0].routeId === 'r-a', 'route id mismatch');
  assert(demand.demandCore.routeIntents[0].paymentHashHex.length === 64, 'missing payment hash');
  assert(!Object.prototype.hasOwnProperty.call(demand.demandCore.routeIntents[0], 'preimageHex'), 'preimage leaked');
  assert(demand.routeIntents[0].preimageHex.length === 64, 'private preimage missing for local settlement');
});

test('allocation respects amount, fee, CLTV, and policy exposure', () => {
  const inventory = buildArkLiquidityInventory({ vtxoAmountsSats: [25000n, 50000n] });
  const demand = buildLightningRouteDemand({
    routeIntents: [
      { routeId: 'small', requestedInboundSats: 25000n, priority: 2 },
      { routeId: 'large', requestedInboundSats: 75000n, priority: 1 }
    ]
  });
  const policy = buildBitvmEnforcementPolicy({ maxAspExposureSats: 50000n });
  const allocation = allocateArkGrafts({ inventory, demand, policy });
  assert(allocation.assignments.length === 1, 'only one route should be assigned');
  assert(allocation.unmetRoutes.length === 1, 'large route should be unmet');
  assert(allocation.assignments[0].assignmentCore.routeId === 'small', 'wrong route assigned');
});

test('manager bundle verifies settled routes plus BitVM challengeable underdelivery', () => {
  const bundle = buildArkLiquidityGraftManagerBundle({
    routeIntents: [
      { routeId: 'edge-a', requestedInboundSats: 50000n, priority: 3, maxFeePpm: 900 },
      { routeId: 'edge-b', requestedInboundSats: 75000n, priority: 2, maxFeePpm: 1000 },
      { routeId: 'edge-c', requestedInboundSats: 100000n, priority: 1, maxFeePpm: 1100 }
    ],
    routeObservations: [
      { routeId: 'edge-c', deliveredInboundSats: 65000n, observedFeePpm: 1600, missingForfeitPath: true }
    ],
    liquidityLease: {
      bundleId: 'lease-demo',
      verification: { ok: true },
      successEvidence: { evidenceCore: { channelOutpoint: `${'44'.repeat(32)}:0` } }
    }
  });
  const verification = verifyArkLiquidityGraftManagerBundle(bundle);
  assert(verification.ok, verification.reason || 'manager bundle should verify');
  assert(!bundle.demand.routeIntents, 'bundle should only expose public demand commitment');
  assert(!bundle.allocation.assignments[0].route.preimageHex, 'assignment route should not expose preimage');
  assert(bundle.allocation.totals.slashableAssignments === 1, 'expected one slashable assignment');
  assert(bundle.challengeEvidence.slashable, 'manager challenge should be slashable');
  assert(
    bundle.challengeEvidence.challengeCore.violations.includes('assignment_liquidity_obligation_failed'),
    'missing assignment failure violation'
  );
});

test('exhausted inventory records unmet route demand as manager evidence', () => {
  const bundle = buildArkLiquidityGraftManagerBundle({
    vtxoAmountsSats: [20000n],
    routeIntents: [
      { routeId: 'too-large', requestedInboundSats: 50000n, priority: 1 },
      { routeId: 'also-large', requestedInboundSats: 60000n, priority: 1 }
    ]
  });
  assert(bundle.allocation.assignments.length === 0, 'no route should be assigned');
  assert(bundle.allocation.unmetRoutes.length === 2, 'all routes should be unmet');
  assert(bundle.challengeEvidence.challengeCore.violations.includes('unmet_route_demand'), 'missing unmet demand violation');
  assert(verifyArkLiquidityGraftManagerBundle(bundle).ok, 'unmet-demand bundle should still be internally valid');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
