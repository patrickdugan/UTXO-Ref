/**
 * Lightning wallet integration tests
 *
 * Run: node bitvm3/utxo_referee/lightning_wallet_integration.test.js
 */

const {
  buildLiquidityLeaseBundle,
  buildWalletIntegrationManifest,
  verifyWalletIntegrationManifest
} = require('./index');

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

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed');
}

console.log('\n=== Lightning Wallet Integration Tests ===\n');

test('manifest exposes LDK Server and ZEUS integration targets', () => {
  const htlcProof = {
    lightning: { paymentHashHex: '11'.repeat(32) },
    swap: { fundingTxid: '22'.repeat(32), refundLocktime: 100 },
    dlcFunding: {
      claimTxid: '33'.repeat(32),
      outputVout: 0,
      commitmentHash: '44'.repeat(32),
      outputAmountSats: '50000'
    }
  };
  const leaseBundle = {
    ...buildLiquidityLeaseBundle({
      htlcProof,
      promisedInboundSats: 50000n,
      observedInboundSats: 50000n
    }),
    verification: { ok: true }
  };
  const manifest = buildWalletIntegrationManifest({ leaseBundle, subswapProof: htlcProof });
  const result = verifyWalletIntegrationManifest(manifest);
  assert(result.ok, result.reason);
  assert(manifest.ldkServer.methods.includes('QuoteLiquidityLease'), 'missing quote method');
  assert(manifest.zeus.screenFile.includes('LiquidityLeaseScreen'), 'missing ZEUS screen');
  assert(manifest.zeus.tlusdPatch.screenFile.includes('TlusdLiquidityPatchScreen'), 'missing TLUSD patch screen');
  assert(manifest.zeus.tlusdPatch.demoProfile === 'litecoin-testnet-local', 'wrong demo profile');
  assert(manifest.zeus.tlusdPatch.goLiveProfile === 'bitcoin-testnet-lnd', 'wrong go-live profile');
  assert(manifest.walletView.status === 'verified', 'expected verified wallet status');
});

console.log(`\nTests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
