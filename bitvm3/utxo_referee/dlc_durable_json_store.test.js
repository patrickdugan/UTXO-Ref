/**
 * Run: node bitvm3/utxo_referee/dlc_durable_json_store.test.js
 *
 * Every durable store takes its exclusive lock through acquireDirectoryLock.
 * A lock left by a process that died while holding it must be reclaimed, so
 * one crash cannot block a contract, oracle event or nonce journal forever.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireDirectoryLock } = require('./dlc_durable_json_store');
const { DlcStateStore } = require('./dlc_state_store');
const { DlcOracleEventStore } = require('./dlc_oracle_event_store');
const { reserveNonceUsage, NonceReuseError } = require('./legacy/tradelayer_nonce_journal');

const DEAD_PID = 2147483646;
// Well past the grace period, so the test does not depend on its exact edge.
const OWNERLESS_AGE_MS = 10 * 60 * 1000;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function heldBy(owner) {
  return { pid: owner.pid, host: os.hostname() };
}
function plantLock(lockPath, owner) {
  fs.mkdirSync(lockPath, { mode: 0o700 });
  if (owner !== undefined) fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner));
}
function ageLock(lockPath) {
  const past = new Date(Date.now() - OWNERLESS_AGE_MS);
  fs.utimesSync(lockPath, past, past);
}

console.log('\n=== DLC Durable Store Lock Tests ===\n');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-durable-lock-'));
try {
  test('a lock held by a dead process is reclaimed', () => {
    const lockPath = path.join(root, 'dead.lock');
    plantLock(lockPath, heldBy({ pid: DEAD_PID }));
    const release = acquireDirectoryLock(lockPath, 'held');
    release();
    assert(!fs.existsSync(lockPath), 'released lock was not removed');
  });

  test('a lock held by a live process is never reclaimed', () => {
    const lockPath = path.join(root, 'live.lock');
    plantLock(lockPath, heldBy({ pid: process.pid }));
    ageLock(lockPath);
    let code = null;
    try { acquireDirectoryLock(lockPath, 'held'); } catch (err) { code = err.code; }
    assert(code === 'LOCK_HELD', 'live holder must keep the lock');
  });

  test('an owner-less lock is held during the grace period and reclaimed after it', () => {
    const lockPath = path.join(root, 'ownerless.lock');
    plantLock(lockPath, undefined);
    let code = null;
    try { acquireDirectoryLock(lockPath, 'held'); } catch (err) { code = err.code; }
    assert(code === 'LOCK_HELD', 'fresh owner-less lock must not be reclaimed');
    ageLock(lockPath);
    acquireDirectoryLock(lockPath, 'held')();
    assert(!fs.existsSync(lockPath), 'aged owner-less lock was not reclaimed');
  });

  test('the DLC state store recovers a contract lock left by a crashed writer', () => {
    const store = new DlcStateStore(path.join(root, 'state'));
    plantLock(store._lockDirectory('contract-a'), heldBy({ pid: DEAD_PID }));
    assert(store._withLock('contract-a', () => 'ran') === 'ran', 'stale state lock blocked the store');
    assert(!fs.existsSync(store._lockDirectory('contract-a')), 'state lock was not released');
  });

  test('the DLC state store reports a held contract lock with its contract id', () => {
    const store = new DlcStateStore(path.join(root, 'state-held'));
    plantLock(store._lockDirectory('contract-b'), heldBy({ pid: process.pid }));
    let message = null;
    try { store._withLock('contract-b', () => 'ran'); } catch (err) { message = err.message; }
    assert(message === 'DLC state store lock is held for contract-b', `unexpected message: ${message}`);
  });

  test('the oracle event store recovers an event lock left by a crashed writer', () => {
    const store = new DlcOracleEventStore({
      baseDirectory: path.join(root, 'oracle'),
      wrappingKey: Buffer.alloc(32, 7),
      network: 'bitcoin-regtest'
    });
    plantLock(store._lockDirectory('event-a'), heldBy({ pid: DEAD_PID }));
    assert(store._withLock('event-a', () => 'ran') === 'ran', 'stale oracle lock blocked the store');
    assert(!fs.existsSync(store._lockDirectory('event-a')), 'oracle lock was not released');
  });

  test('the nonce journal recovers a lock left by a crashed writer and still refuses reuse', () => {
    const journalPath = path.join(root, 'nonce', 'journal.json');
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    plantLock(`${journalPath}.lock`, heldBy({ pid: DEAD_PID }));
    const secnonce = Buffer.alloc(64, 1);
    const first = reserveNonceUsage(secnonce, Buffer.alloc(32, 2), { journalPath });
    assert(first.reused === false, 'first reservation after recovery was not fresh');
    assert(reserveNonceUsage(secnonce, Buffer.alloc(32, 2), { journalPath }).reused === true,
      'identical replay was not idempotent');
    let refused = false;
    try { reserveNonceUsage(secnonce, Buffer.alloc(32, 3), { journalPath }); }
    catch (err) { refused = err instanceof NonceReuseError; }
    assert(refused, 'reuse of a committed nonce was not refused');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
