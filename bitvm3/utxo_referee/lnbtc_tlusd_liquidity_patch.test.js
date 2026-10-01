#!/usr/bin/env node

const {
  usdUnitsFromBtcSats,
  buildLnBtcToTlUsdConversion,
  buildTlUsdLiquidityStake,
  buildLnBtcTlUsdLiquidityPatchBundle,
  verifyLnBtcTlUsdLiquidityPatchBundle
} = require('./lnbtc_tlusd_liquidity_patch');

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

const lease = {
  bundleId: 'lease-demo',
  verification: { ok: true },
  successEvidence: {
    evidenceCore: {
      channelOutpoint: `${'44'.repeat(32)}:0`
    }
  }
};

console.log('\n=== LN-BTC tlUSD Liquidity Patch Tests ===\n');

test('BTC/USD conversion derives tlUSD micro-units from LN sats', () => {
  const units = usdUnitsFromBtcSats(50000n, 100000000000n);
  assert(units === 50000000n, '50k sats at 100k USD/BTC should be 50 tlUSD in micro-units');
});

test('LN-BTC conversion builds TLUSD Taproot Asset settlement evidence', () => {
  const conversion = buildLnBtcToTlUsdConversion({
    lnbtcSats: 50000n,
    btcUsdPriceMicros: 100000000000n,
    liquidityLease: lease
  });
  assert(conversion.kind === 'lnbtc_to_tlusd_conversion', 'wrong conversion kind');
  assert(conversion.stablecoin.asset.descriptorCore.ticker === 'TLUSD', 'asset should be TLUSD');
  assert(conversion.conversionCore.tlusdUnits === '50000000', 'wrong tlUSD amount');
  assert(Object.values(conversion.checks).every(Boolean), 'conversion checks should pass');
});

test('tlUSD stake is bounded by conversion balance and LN-BTC notional', () => {
  const conversion = buildLnBtcToTlUsdConversion({ lnbtcSats: 50000n, liquidityLease: lease });
  const stake = buildTlUsdLiquidityStake({
    conversion,
    stakedTlUsdUnits: 25000000n,
    routingNotionalSats: 25000n
  });
  assert(stake.stakeCore.assetTicker === 'TLUSD', 'stake asset mismatch');
  assert(stake.checks.stakeDoesNotExceedTlUsdBalance, 'stake should fit balance');
  assert(stake.checks.routingNotionalBackedByLnBtc, 'routing notional should be backed');
});

test('end-to-end bundle verifies conversion, stake, Ark patching, and BitVM challenge surface', () => {
  const bundle = buildLnBtcTlUsdLiquidityPatchBundle({
    lnbtcSats: 60000n,
    btcUsdPriceMicros: 100000000000n,
    liquidityLease: lease
  });
  const verification = verifyLnBtcTlUsdLiquidityPatchBundle(bundle);
  assert(verification.ok, verification.reason || 'bundle should verify');
  assert(bundle.mandate.managerVerification.ok, 'manager should verify');
  assert(BigInt(bundle.mandate.manager.allocation.totals.assignedInboundSats) > 0n, 'missing assigned liquidity');
  assert(bundle.mandate.checks.assignedLiquidityWithinStakeNotional, 'assigned liquidity should fit stake notional');
});

test('slashable Ark route propagates to liquidity patch mandate', () => {
  const bundle = buildLnBtcTlUsdLiquidityPatchBundle({
    lnbtcSats: 90000n,
    liquidityLease: lease,
    routeObservations: [
      {
        routeId: 'tlusd-edge-b-patch',
        deliveredInboundSats: 10000n,
        observedFeePpm: 2500,
        observedCltvDelta: 80,
        missingForfeitPath: true
      }
    ]
  });
  assert(bundle.mandate.manager.challengeEvidence.slashable, 'manager challenge should be slashable');
  assert(
    bundle.mandate.manager.challengeEvidence.challengeCore.violations.includes('assignment_liquidity_obligation_failed'),
    'missing assignment failure violation'
  );
  assert(verifyLnBtcTlUsdLiquidityPatchBundle(bundle).ok, 'slashable bundle should remain internally valid');
});

if (failed) {
  console.error(`\nTests: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\nTests: ${passed} passed, ${failed} failed`);
