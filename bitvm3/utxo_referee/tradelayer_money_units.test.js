/**
 * Run: node bitvm3/utxo_referee/tradelayer_money_units.test.js
 *
 * Characterization of every caller of the amount parsers (sats as integers,
 * decimal coin strings, token units). Each row is the accept/reject outcome and
 * value of a public entry point, so collapsing the parsers into one module must
 * leave every caller's behaviour unchanged unless a row is marked as a fix.
 */

const { addressToScriptPubKey } = require('./tradelayer_pnl_route_adapter');
const pa = require('./tradelayer_pnl_route_adapter');
const rr = require('./tradelayer_reserve_reconciliation_referee');
const sp = require('./tradelayer_send_sweep_psbt');
const lr = require('./tradelayer_live_reserve_adapter');
const ex = require('./tradelayer_send_oracle_extractor');
const rb = require('./tradelayer_rbtc_hourly_autoroll');

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

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

// Returns the value as a string, or 'ERR' when the entry point rejects the input.
function outcome(fn) {
  try {
    return String(fn());
  } catch (_err) {
    return 'ERR';
  }
}

const ADDR = 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22';
const BAD_INTEGERS = [-1, '-1', 1.5, '1.5', '', '0x10', ' 5', '5 ', Number.MAX_SAFE_INTEGER + 1, true, null];

console.log('\n=== Money Units Characterization ===\n');

test('deposit amountSats accepts non-negative integer strings, numbers and bigints', () => {
  assertEq(outcome(() => rr.reservedSatsFromDepositSnapshot({ deposits: [{ depositId: 'd', status: 'credited', amountSats: '5' }] })), '5');
  assertEq(outcome(() => rr.reservedSatsFromDepositSnapshot({ deposits: [{ depositId: 'd', status: 'credited', amountSats: 5 }] })), '5');
  assertEq(outcome(() => rr.reservedSatsFromDepositSnapshot({ deposits: [{ depositId: 'd', status: 'credited', amountSats: 5n }] })), '5');
  assertEq(outcome(() => rr.reservedSatsFromDepositSnapshot({ deposits: [{ depositId: 'd', status: 'credited', amountSats: '0005' }] })), '5');
});

test('deposit amountSats rejects negative, fractional, empty, hex, padded and unsafe values', () => {
  for (const value of BAD_INTEGERS) {
    assertEq(outcome(() => rr.reservedSatsFromDepositSnapshot({ deposits: [{ depositId: 'd', status: 'credited', amountSats: value }] })), 'ERR', `deposit ${JSON.stringify(value)}`);
  }
});

test('explicit reservedSats follows the same integer rule as deposit amounts', () => {
  assertEq(outcome(() => rr.resolveReserve({ reservedSats: '5' }).reservedSats), '5');
  assertEq(outcome(() => rr.resolveReserve({ reservedSats: 5n }).reservedSats), '5');
  assertEq(outcome(() => rr.resolveReserve(7).reservedSats), '7');
  for (const value of BAD_INTEGERS.filter((v) => v !== true && v !== null)) {
    assertEq(outcome(() => rr.resolveReserve({ reservedSats: value }).reservedSats), 'ERR', `reservedSats ${JSON.stringify(value)}`);
  }
});

test('satsToCoinString renders eight decimal places and keeps the sign', () => {
  assertEq(sp.satsToCoinString(0n), '0.00000000');
  assertEq(sp.satsToCoinString(1n), '0.00000001');
  assertEq(sp.satsToCoinString(123456789n), '1.23456789');
  assertEq(sp.satsToCoinString(-5n), '-0.00000005');
  assertEq(sp.satsToCoinString('100'), '0.00000100');
  assertEq(outcome(() => sp.satsToCoinString(1.5)), 'ERR');
  assertEq(outcome(() => sp.satsToCoinString('1.5')), 'ERR');
});

function payoutFor(amount) {
  return pa.buildTradeLayerPnlCommitment({
    route: 'pnl-netting',
    network: 'litecoin-testnet',
    outputPlan: [{ address: ADDR, amount }]
  }, { epochId: 1 }).payoutTotalSats.toString();
}

test('route output amount (decimal LTC) parses up to eight places', () => {
  assertEq(payoutFor('0.5'), '50000000');
  assertEq(payoutFor(0.5), '50000000');
  assertEq(payoutFor('0.00000001'), '1');
  assertEq(payoutFor('0.1'), '10000000');
  assertEq(payoutFor('21000000'), '2100000000000000');
  assertEq(payoutFor(21000000), '2100000000000000');
  for (const value of ['0.123456789', 1e-8, '1e-8', '', '-1', 0.1 + 0.2, '1.', '.5', ' 0.5', '0x1']) {
    assertEq(outcome(() => payoutFor(value)), 'ERR', `amount ${JSON.stringify(value)}`);
  }
});

function payoutForSats(sats) {
  return pa.buildTradeLayerPnlCommitment({
    route: 'pnl-netting',
    network: 'litecoin-testnet',
    outputPlan: [{ address: ADDR, sats }]
  }, { epochId: 1 }).payoutTotalSats.toString();
}

test('route output sats accept positive integers and reject negative, fractional or hex values', () => {
  assertEq(payoutForSats('546'), '546');
  assertEq(payoutForSats(546), '546');
  for (const value of ['-5', -5, '1.5', '0x10', '']) {
    assertEq(outcome(() => payoutForSats(value)), 'ERR', `sats ${JSON.stringify(value)}`);
  }
});

test('live reserve amounts: integer sats, decimal LTC from Core, and empty-string handling', () => {
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amountSats: 5 })), '5');
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amountSats: '5' })), '5');
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amountSats: -1 })), 'ERR');
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amountSats: '1.5' })), 'ERR');
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amountSats: 0.5 })), 'ERR');
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amount: 0.29 })), '29000000');
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amount: 0.00000001 })), '1');
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amount: '0.29' })), '29000000');
  assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amount: 21000000 })), '2100000000000000');
});

test('token units with eight decimals: integers are units, decimals are scaled', () => {
  const scale = 100000000n;
  assertEq(outcome(() => ex.decimalToUnits('1', 'f', scale)), '1');
  assertEq(outcome(() => ex.decimalToUnits('1.5', 'f', scale)), '150000000');
  assertEq(outcome(() => ex.decimalToUnits('1.00000001', 'f', scale)), '100000001');
  assertEq(outcome(() => ex.decimalToUnits(-2, 'f', scale)), '-2');
  assertEq(outcome(() => ex.decimalToUnits('-2.5', 'f', scale)), '-250000000');
  assertEq(outcome(() => ex.decimalToUnits(1.5, 'f', scale)), '150000000');
  for (const value of ['1.000000001', '', null, '1e3', '0x10', ' 1']) {
    assertEq(outcome(() => ex.decimalToUnits(value, 'f', scale)), 'ERR', `units ${JSON.stringify(value)}`);
  }
});

test('rbtc starting balance is a non-negative integer of base units', () => {
  const base = {
    startsAtUnix: 1000,
    durationSeconds: 3600,
    vaultAddress: ADDR,
    fundingAddress: ADDR,
    fundingOutpoint: { txid: 'aa'.repeat(32), vout: 0 },
    rbtcPropertyId: 1,
    dlcRef: 'x'
  };
  const balance = (value) => rb.buildHourlyRbtcDlcContract({ ...base, startingRbtcBalance: value }).core.startingRbtcBalance;
  assertEq(outcome(() => balance('5')), '5');
  assertEq(outcome(() => balance(5)), '5');
  assertEq(outcome(() => balance('00012')), '12');
  for (const value of ['-1', '1.5', '1e3']) {
    assertEq(outcome(() => balance(value)), 'ERR', `balance ${JSON.stringify(value)}`);
  }
});

test('addressToScriptPubKey is the single bech32 decoder used by the route layer', () => {
  const script = addressToScriptPubKey(ADDR, 'litecoin-testnet').toString('hex');
  assertEq(script.slice(0, 4), '0014');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
