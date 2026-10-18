/**
 * Run: node bitvm3/utxo_referee/csv_delay.test.js
 *
 * Every relative-timelock leaf in the tree encodes its delay through csv_delay.js.
 * The same delay must give the same script bytes in every leaf, and a delay that
 * is not a canonical integer in 1..65535 must be refused by every leaf.
 */

const { buildTimeoutLeafScript } = require('./tradelayer_bitvm_dispute');
const { buildRefundLeafScript } = require('./tradelayer_dlc_refund_cet_demo');
const { buildDlcRefundLeafScript } = require('./dlc_funding_output');
const { buildRecoveryLeafScript } = require('./taproot_reserve_vault');
const { buildArkTaprootLeafSet } = require('./ark_taproot_miniscript_proof_manifest');

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

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function refuses(fn) {
  try {
    fn();
    return false;
  } catch (_err) {
    return true;
  }
}

// Valid x-only secp256k1 public keys (G and 2G).
const PK_A = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const PK_B = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5';

const LEAVES = {
  'bitvm dispute timeout': (delay) => buildTimeoutLeafScript(PK_A, delay),
  'dlc refund cet demo': (delay) => buildRefundLeafScript(PK_A, PK_B, delay),
  'dlc funding refund': (delay) => buildDlcRefundLeafScript([PK_A, PK_B], delay),
  'taproot vault recovery': (delay) => buildRecoveryLeafScript(PK_A, delay)
};

console.log('\n=== CSV delay encoding across leaf builders ===\n');

test('every CSV leaf encodes 144 the same way, from a number or its digits', () => {
  for (const [name, build] of Object.entries(LEAVES)) {
    const script = build(144);
    assert(script.startsWith('029000b275'), `${name}: 144 must push 0x9000 then OP_CSV OP_DROP, got ${script.slice(0, 12)}`);
    assertEq(build('144'), script, `${name}: '144' must match 144`);
  }
});

test('every CSV leaf refuses zero, hex, exponent, empty, padded, fractional and out-of-range delays', () => {
  const bad = ['0x10', '', '1e3', '16.5', ' 144', '0', 0, 65536, -1, null, true];
  for (const [name, build] of Object.entries(LEAVES)) {
    for (const delay of bad) {
      assert(refuses(() => build(delay)), `${name}: delay ${JSON.stringify(delay)} must be refused`);
    }
  }
});

// The ark leaves are miniscript policies, so their delays are checked by refusal only: the same bad delay must throw
// from the exit leaf and from the forfeit leaf.
const ARK_LEAVES = {
  'ark owner exit': (delay) => buildArkTaprootLeafSet({ exitDelayBlocks: delay }),
  'ark asp forfeit': (delay) => buildArkTaprootLeafSet({ aspForfeitCsv: delay })
};

test('every ark CSV leaf refuses zero, hex, exponent, empty, padded, fractional and out-of-range delays', () => {
  const bad = ['0x10', '', '1e3', '16.5', ' 144', '0', 0, 65536, -1, true, 'abc', -5];
  for (const [name, build] of Object.entries(ARK_LEAVES)) {
    for (const delay of bad) {
      assert(refuses(() => build(delay)), `${name}: delay ${JSON.stringify(delay)} must be refused`);
    }
  }
});

test("an ark exit leaf given '144' is older(144) with a 144-block timelock", () => {
  const exit = buildArkTaprootLeafSet({ exitDelayBlocks: '144' }).find((leaf) => leaf.role === 'owner_csv_exit');
  assertEq(exit.leafCore.relativeTimelockBlocks, 144);
  assert(exit.leafCore.policyExpression.startsWith('and_v(v:older(144),pk('), exit.leafCore.policyExpression);
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
