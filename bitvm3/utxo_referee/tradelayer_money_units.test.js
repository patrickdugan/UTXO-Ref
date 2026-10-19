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
const { normalizeAmountSats } = require('./m1_spec');
const { buildAspReserveBond } = require('./asp_bitvm_reserve_bond');
const { csvSequence } = require('./taproot_reserve_vault');
const { buildArkGraftCostModel } = require('./lightning_ark_liquidity_graft');

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

const RBTC_BASE = {
  startsAtUnix: 1000,
  durationSeconds: 3600,
  vaultAddress: ADDR,
  fundingAddress: ADDR,
  fundingOutpoint: { txid: 'aa'.repeat(32), vout: 0 },
  rbtcPropertyId: 1,
  dlcRef: 'x'
};

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
  assertEq(payoutFor(1e-8), '1');
  assertEq(payoutFor('0.1'), '10000000');
  assertEq(payoutFor('21000000'), '2100000000000000');
  assertEq(payoutFor(21000000), '2100000000000000');
  for (const value of ['0.123456789', '1e-8', '', '-1', 0.1 + 0.2, '1.', '.5', ' 0.5', '0x1']) {
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
  assertEq(outcome(() => ex.decimalToUnits('-2', 'f', scale)), '-2');
  assertEq(outcome(() => ex.decimalToUnits('-2.5', 'f', scale)), '-250000000');
  assertEq(outcome(() => ex.decimalToUnits(-2, 'f', scale)), 'ERR', 'a JSON number is refused as token units');
  assertEq(outcome(() => ex.decimalToUnits(1.5, 'f', scale)), 'ERR', 'a JSON number is refused as token units');
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

// Encodings that the older helpers accepted silently (BigInt('') is 0n, BigInt('0x10') is 16n).
test('empty, hex and padded amounts are refused by every amount parser', () => {
  for (const value of ['', '0x10', ' 5']) {
    assertEq(outcome(() => lr.toAmountSats({ txid: 'aa', vout: 0, amountSats: value })), 'ERR', `live amountSats ${JSON.stringify(value)}`);
    assertEq(outcome(() => normalizeAmountSats(value)), 'ERR', `normalizeAmountSats ${JSON.stringify(value)}`);
    assertEq(outcome(() => rb.buildHourlyRbtcDlcContract({ ...RBTC_BASE, startingRbtcBalance: value })), 'ERR', `rbtc ${JSON.stringify(value)}`);
  }
  assertEq(outcome(() => normalizeAmountSats('5')), '5');
});

test('addressToScriptPubKey is the single bech32 decoder used by the route layer', () => {
  const script = addressToScriptPubKey(ADDR, 'litecoin-testnet').toString('hex');
  assertEq(script.slice(0, 4), '0014');
});

// One spelling per integer field: the bps, fee-ppm and block-delay fields reject the
// same non-canonical forms as the amount fields, in every module that reads them.
test('bps, ppm and csv delay fields refuse non-canonical integer spellings in every module', () => {
  const asp = (value) => { buildAspReserveBond({ watcherBountyBps: value }); return 'OK'; };
  const ppm = (value) => { buildArkGraftCostModel({ arkAspFeePpm: value }); return 'OK'; };
  for (const value of ['0x10', ' 16 ', '1e3', '16.0', '', true, 1.5]) {
    assertEq(outcome(() => asp(value)), 'ERR', `asp watcherBountyBps ${JSON.stringify(value)}`);
    assertEq(outcome(() => csvSequence(value)), 'ERR', `csv ${JSON.stringify(value)}`);
    assertEq(outcome(() => ppm(value)), 'ERR', `ppm ${JSON.stringify(value)}`);
  }
  assertEq(outcome(() => asp('250')), 'OK');
  assertEq(outcome(() => csvSequence('144')), '144');
  assertEq(outcome(() => ppm(250)), 'OK');
});

// The number and string spellings of one decimal amount must produce the same units,
// or both must fail. A JSON number cannot carry trailing zeros, so the string form
// is canonicalised the same way.
test('a decimal amount has one meaning whether it arrives as a number or a string', () => {
  const money = require('./money');
  const units = (value, options) => outcome(() => money.decimalToUnits(value, 'f', options));
  assertEq(units('1.100000000', {}), '110000000');
  assertEq(units(1.1, {}), '110000000');
  assertEq(units('5.00000000', { integersAreUnits: true }), '500000000');
  assertEq(units(5, { integersAreUnits: true }), 'ERR', 'a JSON number cannot be read as base units');
  assertEq(units(5n, { integersAreUnits: true }), '5');
  assertEq(units(1e20, { integersAreUnits: true }), 'ERR');
  assertEq(outcome(() => money.toInt(1e20, 'f')), 'ERR');
  assertEq(units('1.100000001', {}), 'ERR');
  assertEq(units(1.100000001, {}), 'ERR');
});

// The spelling of an amount fixes its scale. Under integersAreUnits, integer text
// is base units, and a JSON number is refused because its spelling is gone (5 and 5.0 are one double);
// any decimal point is a coin amount and is scaled. Trailing zeros never change
// the spelling. Each row: [value, options, expected].
test('the amount spelling rule, table-driven, for strings and numbers', () => {
  const money = require('./money');
  const units = (value, options) => outcome(() => money.decimalToUnits(value, 'f', options));
  const TOKEN = { integersAreUnits: true };
  const COINS = {};
  const SIGNED_TOKEN = { integersAreUnits: true, signed: true };
  const rows = [
    ['5', TOKEN, '5'],
    ['5.0', TOKEN, '500000000'],
    ['5.00000000', TOKEN, '500000000'],
    ['2500.00000000', TOKEN, '250000000000'],
    [5, TOKEN, 'ERR'],
    [5n, TOKEN, '5'],
    [1.1, TOKEN, 'ERR'],
    ['1.100000000', TOKEN, '110000000'],
    ['1.100000001', TOKEN, 'ERR'],
    ['1e3', TOKEN, 'ERR'],
    [1e3, TOKEN, 'ERR'],
    ['-0', SIGNED_TOKEN, '0'],
    ['-0', TOKEN, 'ERR'],
    ['', TOKEN, 'ERR'],
    [' 5', TOKEN, 'ERR'],
    ['5', COINS, '500000000'],
    ['5.0', COINS, '500000000'],
    ['5.00000000', COINS, '500000000'],
    [5, COINS, '500000000'],
    [1.1, COINS, '110000000'],
    ['1.100000000', COINS, '110000000'],
    ['1e3', COINS, 'ERR'],
    ['', COINS, 'ERR'],
    [' 5', COINS, 'ERR']
  ];
  for (const [value, options, expected] of rows) {
    assertEq(units(value, options), expected, `${String(value)} ${JSON.stringify(options)}`);
  }
});

test('heightOf takes one canonical block height and refuses every other spelling', () => {
  const { heightOf } = require('./money');
  const ok = [[144, 144], ['144', 144], [0, 0], [0n, 0], ['0', 0], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]];
  for (const [value, expected] of ok) assertEq(heightOf(value, "h"), expected, `heightOf(${String(value)})`);
  const bad = [undefined, null, '', 'abc', 'NaN', '1e3', '0x90', ' 144', '144 ', '+144', '-1', -1, 1.5, '1.5',
    NaN, Infinity, '9007199254740993', 9007199254740992, true];
  for (const value of bad) {
    let threw = false;
    try { heightOf(value, 'h'); } catch (_err) { threw = true; }
    if (!threw) throw new Error(`heightOf(${String(value)}) must throw`);
  }
  assertEq(heightOf(-5, 'h', { signed: true }), -5, 'signed heightOf takes a negative age');
});

test('a malformed height or CLTV delta in a challenge builder is refused, and a violating value still counts', () => {
  const lease = require('./lightning_liquidity_lease');
  const stablecoin = require('./lightning_taproot_assets_stablecoin');
  const router = require('./bitvm_channel_router');
  const throwsFor = (fn) => { try { fn(); return false; } catch (_err) { return true; } };
  if (!(throwsFor(() => lease.buildLeaseChallengeEvidence({ observedCltvDelta: 'abc' })))) throw new Error('lease observedCltvDelta abc was accepted');
  const leaseProof = { channelOutpoint: `${'11'.repeat(32)}:0`, fundingCommitmentHash: '22'.repeat(32) };
  if (!(throwsFor(() => lease.buildLeaseSuccessEvidence({ ...leaseProof, observedAtBlock: 'x' })))) throw new Error('lease observedAtBlock x was accepted');
  if (!(throwsFor(() => lease.buildLeaseSuccessEvidence({ ...leaseProof, observedCltvDelta: 'abc' })))) throw new Error('lease success observedCltvDelta abc was accepted');
  if (!(throwsFor(() => lease.buildLeaseChallengeEvidence({ challengeBlock: '1e3' })))) throw new Error('lease challengeBlock 1e3 was accepted');
  const lateLease = lease.buildLeaseChallengeEvidence({ observedCltvDelta: '50' });
  if (!(lateLease.challengeCore.violations.includes('cltv_delta_above_ceiling'))) throw new Error('lease CLTV 50 over a ceiling of 40 was not a violation');
  if (!(throwsFor(() => stablecoin.buildStablecoinChallengeEvidence({ observedBlock: 'abc' })))) throw new Error('stablecoin observedBlock abc was accepted');
  const lateStable = stablecoin.buildStablecoinChallengeEvidence({ observedBlock: '300' });
  if (!(lateStable.challengeCore.violations.includes('quote_expired_before_settlement'))) throw new Error('stablecoin block 300 past expiry 250 was not a violation');
  if (!(throwsFor(() => router.buildBitvmChannelRouterBundle({ routeIntent: { maxCltvDelta: 'abc' } })))) throw new Error('router maxCltvDelta abc was accepted');
  if (!(throwsFor(() => router.buildBitvmChannelRouterBundle({ routeIntent: { maxCltvDelta: 1.5 } })))) throw new Error('router maxCltvDelta 1.5 was accepted');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
