/**
 * Run: node bitvm3/utxo_referee/tradelayer_watchtower_daemon.test.js
 *
 * Validates SECURITY_BLOCKERS.md #5's watchtower daemon: state persists and
 * resumes correctly across a simulated abrupt kill (no graceful shutdown),
 * and a fault (insolvency or staleness) is independently detected and
 * durably logged as an alert. Uses a fake RPC (dependency-injected into
 * runTick) so this suite needs no live node.
 */

const fs = require('fs');
const path = require('path');
const {
  initOrResumeState,
  runTick,
  saveStateAtomic,
  loadState
} = require('./tradelayer_watchtower_daemon');
const { publishTrace } = require('./tradelayer_trace_publication');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function assertEq(x, e, msg) { if (x !== e) throw new Error(msg || `expected ${e}, got ${x}`); }

const TMP_DIR = path.join(__dirname, 'artifacts', 'live', 'test-tmp');
function tmpPath(name) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return path.join(TMP_DIR, `watchtower_${name}_${process.pid}.json`);
}

// Fake RPC: returns a fixed set of confirmed UTXOs and a controllable height.
// listunspent amounts are in whole-coin units (matches Litecoin Core's own
// convention, which buildLiveReserveFromUnspent already expects).
function fakeRpc({ amountsLtc, height }) {
  return async (method) => {
    if (method === 'listunspent') {
      return amountsLtc.map((amount, i) => ({
        txid: `${(i + 1).toString().padStart(2, '0')}`.repeat(32).slice(0, 64),
        vout: 0,
        address: `fake-addr-${i}`,
        amount,
        confirmations: 100,
        spendable: true
      }));
    }
    if (method === 'getblockcount') return height;
    throw new Error(`fakeRpc: unexpected method ${method}`);
  };
}

async function main() {
  console.log('\n=== TradeLayer Watchtower Daemon Tests (SECURITY_BLOCKERS.md #5) ===\n');

  test('fresh state has zero ticks and zero restarts', () => {
    const statePath = tmpPath('fresh');
    if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    const state = initOrResumeState(statePath);
    assertEq(state.tickCount, 0);
    assertEq(state.restarts, 0);
    assertEq(state.lastCheckedHeight, null);
  });

  test('state persists and resumes with an incremented restart counter, not reset to zero', () => {
    const statePath = tmpPath('resume');
    const first = initOrResumeState(statePath);
    first.tickCount = 5;
    first.lastCheckedHeight = 12345;
    saveStateAtomic(statePath, first);

    // Simulate an abrupt kill + restart: a brand new process calls
    // initOrResumeState again against the same file.
    const resumed = initOrResumeState(statePath);
    assertEq(resumed.tickCount, 5, 'tick count must survive a restart, not reset to zero');
    assertEq(resumed.lastCheckedHeight, 12345);
    assertEq(resumed.restarts, 1, 'restart counter must increment on resume');
    assert(resumed.startedAt === first.startedAt, 'original startedAt must be preserved across restarts');
  });

  test('a second resume increments the restart counter again (not just once)', () => {
    const statePath = tmpPath('double-resume');
    let state = initOrResumeState(statePath);
    saveStateAtomic(statePath, state);
    state = initOrResumeState(statePath);
    saveStateAtomic(statePath, state);
    state = initOrResumeState(statePath);
    assertEq(state.restarts, 2);
  });

  test('state file written by saveStateAtomic is always valid JSON (no half-written file)', () => {
    const statePath = tmpPath('atomic');
    saveStateAtomic(statePath, { tickCount: 1 });
    saveStateAtomic(statePath, { tickCount: 2 });
    const loaded = loadState(statePath);
    assertEq(loaded.tickCount, 2);
    // No leftover .tmp- files from the atomic write-then-rename.
    const leftovers = fs.readdirSync(path.dirname(statePath)).filter((f) => f.startsWith(path.basename(statePath) + '.tmp-'));
    assertEq(leftovers.length, 0, 'no temp files should remain after atomic saves');
  });

  await testAsync('a solvent, fresh reserve produces no fault and no alert', async () => {
    const statePath = tmpPath('solvent-tick');
    const alertLogPath = tmpPath('solvent-alerts.jsonl');
    if (fs.existsSync(alertLogPath)) fs.unlinkSync(alertLogPath);
    const state = initOrResumeState(statePath);
    const rpc = fakeRpc({ amountsLtc: [1.0], height: 1000 }); // 100,000,000 sats, comfortably solvent
    const result = await runTick({ alertLogPath, maxReserveAgeBlocks: 6 }, rpc, state);
    assert(result.fault === false, 'ample reserve should not fault');
    assert(!fs.existsSync(alertLogPath), 'no alert should be written when there is no fault');
  });

  await testAsync('an insolvent reserve is independently detected and durably alerted', async () => {
    const statePath = tmpPath('insolvent-tick');
    const alertLogPath = tmpPath('insolvent-alerts.jsonl');
    if (fs.existsSync(alertLogPath)) fs.unlinkSync(alertLogPath);
    const state = initOrResumeState(statePath);
    // The stack bundle's default withdrawal cap (see tradelayer_bitvm_stack.js
    // SAMPLE_CONSENSUS_INPUT) is 99,000 sats - a near-empty wallet is insolvent.
    const rpc = fakeRpc({ amountsLtc: [0.00001], height: 1000 }); // 1,000 sats
    const result = await runTick({ alertLogPath, maxReserveAgeBlocks: 6 }, rpc, state);
    assert(result.fault === true, 'near-empty reserve against a 99,000-sat cap must fault');
    assert(fs.existsSync(alertLogPath), 'a fault must be durably logged to the alert log');
    const alertLines = fs.readFileSync(alertLogPath, 'utf8').trim().split('\n');
    assertEq(alertLines.length, 1);
    const alert = JSON.parse(alertLines[0]);
    assertEq(alert.severity, 'block');
    assert(alert.reason.includes('reserve_insolvent'), 'alert reason should identify insolvency');
  });

  // --- SECURITY_BLOCKERS.md #6 wired into #5's loop ---

  await testAsync('a watched assertion with its trace published in time causes no fault', async () => {
    const statePath = tmpPath('watched-ok');
    const alertLogPath = tmpPath('watched-ok-alerts.jsonl');
    const watchedPath = tmpPath('watched-ok-registry.json');
    const tracePath = tmpPath('watched-ok-trace.json');
    if (fs.existsSync(alertLogPath)) fs.unlinkSync(alertLogPath);

    const commitment = publishTrace({ some: 'wire-trace' }, { retrievalPath: tracePath, publishedAtHeight: 1000 });
    fs.writeFileSync(watchedPath, JSON.stringify([{
      label: 'test-assertion', traceHash: commitment.traceHash, retrievalPath: tracePath, bondedAtHeight: 1000, slaBlocks: 6
    }]));

    const state = initOrResumeState(statePath);
    const rpc = fakeRpc({ amountsLtc: [1.0], height: 1003 });
    const result = await runTick({ alertLogPath, maxReserveAgeBlocks: 6, watchedAssertionsPath: watchedPath }, rpc, state);
    assert(result.fault === false, 'published, hash-verified trace within SLA should not fault');
    assertEq(result.watchedAssertionCount, 1);
    assertEq(result.traceFaults.length, 0);
  });

  await testAsync('a watched assertion whose trace was withheld past its SLA causes a durable alert', async () => {
    const statePath = tmpPath('watched-fault');
    const alertLogPath = tmpPath('watched-fault-alerts.jsonl');
    const watchedPath = tmpPath('watched-fault-registry.json');
    if (fs.existsSync(alertLogPath)) fs.unlinkSync(alertLogPath);

    // Never published - retrievalPath deliberately points nowhere.
    fs.writeFileSync(watchedPath, JSON.stringify([{
      label: 'withheld-assertion',
      traceHash: 'cc'.repeat(32),
      retrievalPath: tmpPath('watched-fault-nonexistent-trace.json'),
      bondedAtHeight: 1000,
      slaBlocks: 6
    }]));

    const state = initOrResumeState(statePath);
    const rpc = fakeRpc({ amountsLtc: [1.0], height: 1050 }); // well past the SLA window
    const result = await runTick({ alertLogPath, maxReserveAgeBlocks: 6, watchedAssertionsPath: watchedPath }, rpc, state);
    assert(result.fault === true, 'a withheld trace past its SLA must fault the whole tick');
    assertEq(result.traceFaults.length, 1);
    assert(fs.existsSync(alertLogPath), 'the trace-withholding fault must be durably alerted');
    const alert = JSON.parse(fs.readFileSync(alertLogPath, 'utf8').trim().split('\n')[0]);
    assert(alert.reason.includes('trace_withholding_fault'), 'alert reason must identify the trace-withholding fault specifically');
    assert(alert.reason.includes('withheld-assertion'), 'alert should name which watched assertion faulted');
  });

  console.log(`\nPASS: ${passed} tests${failed ? `, FAIL: ${failed}` : ''}`);
  if (failed > 0) process.exit(1);
}

main();
