/**
 * Run: node bitvm3/utxo_referee/dlc_durable_json_store.test.js
 *
 * Every durable store takes its exclusive lock through acquireDirectoryLock.
 * A lock left by a process that died while holding it must be reclaimed, so
 * one crash cannot block a contract, oracle event or nonce journal forever.
 */

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireDirectoryLock, lockIdentity, lockReporter, parseProcStatStartTicks, withDirectoryLock, withDirectoryLockAsync } = require('./dlc_durable_json_store');
const { DlcStateStore } = require('./dlc_state_store');
const { DlcOracleEventStore } = require('./dlc_oracle_event_store');
const { reserveNonceUsage, NonceReuseError } = require('./legacy/tradelayer_nonce_journal');
const { DlcWatchtowerJournal, contractKey: journalContractKey } = require('./dlc_watchtower_journal');

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
// Another holder takes the lock while the critical section runs, so its release
// reports LOCK_LOST. The failure the critical section raised must still reach the caller.
function takeOverLock(lockPath) {
  fs.rmSync(lockPath, { recursive: true, force: true });
  plantLock(lockPath, heldBy({ pid: process.ppid }));
}
function failureAfterTakeover(lockPath, run) {
  try { run(); }
  catch (err) { return err; }
  throw new Error('critical section did not fail');
}
function assertOwnFailureKept(err, lockPath, message) {
  assert(err.message === message, `caller must see its own failure, got: ${err.message}`);
  assert(err.releaseError && err.releaseError.code === 'LOCK_LOST',
    `the release failure must be attached to the error, got ${err.releaseError && err.releaseError.code}`);
  fs.rmSync(lockPath, { recursive: true, force: true });
}
function ageLock(lockPath) {
  const past = new Date(Date.now() - OWNERLESS_AGE_MS);
  fs.utimesSync(lockPath, past, past);
}
// The boot id and process start time come from /proc on Linux; here they are
// replaced so the reclaim decisions run on every platform.
function withLockIdentity(identity, run) {
  const original = { bootId: lockIdentity.bootId, processStartTicks: lockIdentity.processStartTicks, pidNamespace: lockIdentity.pidNamespace };
  lockIdentity.bootId = () => identity.bootId ?? null;
  lockIdentity.processStartTicks = (pid) => (identity.startTicks ? identity.startTicks(pid) : null);
  lockIdentity.pidNamespace = () => identity.pidNamespace ?? null;
  try { return run(); }
  finally { Object.assign(lockIdentity, original); }
}
// Makes kill(pid, 0) fail with EPERM for the listed pids, as it does for a pid
// that exists under another user.
function withOtherUserPids(pids, run) {
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    if (pids.includes(pid)) throw Object.assign(new Error(`kill EPERM ${pid}`), { code: 'EPERM' });
    return realKill(pid, signal);
  };
  try { return run(); }
  finally { process.kill = realKill; }
}
// Whether this account can run a child in a new pid namespace here.
function canUnsharePidNamespace() {
  const probe = spawnSync('unshare', ['--user', '--map-root-user', '--pid', '--fork', 'true'], { encoding: 'utf8' });
  return probe.status === 0;
}
const asyncTests = [];
function asyncTest(name, fn) { asyncTests.push({ name, fn }); }
function lockCode(lockPath) {
  try { acquireDirectoryLock(lockPath, 'held')(); return null; }
  catch (err) { return err.code; }
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

  test('a lock written by the earlier pid-only format is reclaimed after its holder dies', () => {
    const lockPath = path.join(root, 'pid-only.lock');
    plantLock(lockPath, { pid: DEAD_PID });
    acquireDirectoryLock(lockPath, 'held')();
    assert(!fs.existsSync(lockPath), 'pid-only lock was not reclaimed');
  });

  test('a lock held by a live process is never reclaimed', () => {
    const lockPath = path.join(root, 'live.lock');
    plantLock(lockPath, heldBy({ pid: process.ppid }));
    ageLock(lockPath);
    let code = null;
    try { acquireDirectoryLock(lockPath, 'held'); } catch (err) { code = err.code; }
    assert(code === 'LOCK_HELD', 'live holder must keep the lock');
  });

  test('a lock held by a live acquisition in this process is not reclaimed', () => {
    const lockPath = path.join(root, 'in-process.lock');
    const release = acquireDirectoryLock(lockPath, 'held');
    let code = null;
    try { acquireDirectoryLock(lockPath, 'held'); } catch (err) { code = err.code; }
    assert(code === 'LOCK_HELD', 'a second acquisition in the same process must be refused');
    release();
    assert(!fs.existsSync(lockPath), 'released lock was not removed');
  });

  test('a lock recorded by this pid with no live acquisition is a dead earlier incarnation and is reclaimed', () => {
    const lockPath = path.join(root, 'same-pid.lock');
    plantLock(lockPath, { pid: process.pid, host: os.hostname() });
    acquireDirectoryLock(lockPath, 'held')();
    assert(!fs.existsSync(lockPath), 'same-pid lock from an earlier incarnation was not reclaimed');
  });

  test('a lock recorded by this pid under an unknown token is reclaimed', () => {
    const lockPath = path.join(root, 'same-pid-token.lock');
    plantLock(lockPath, { pid: process.pid, host: os.hostname(), token: 'f'.repeat(32) });
    acquireDirectoryLock(lockPath, 'held')();
    assert(!fs.existsSync(lockPath), 'same-pid lock with an unknown token was not reclaimed');
  });

  test('a lock whose recorded pid now belongs to a different process is reclaimed', () => {
    if (!fs.existsSync('/proc/self/stat')) return;
    const lockPath = path.join(root, 'pid-reused.lock');
    plantLock(lockPath, { pid: process.ppid, host: os.hostname(), token: 'e'.repeat(32), startTicks: '1' });
    acquireDirectoryLock(lockPath, 'held')();
    assert(!fs.existsSync(lockPath), 'a lock whose pid was reused by an unrelated process was not reclaimed');
  });

  test('a live acquisition in another process is refused by a contender, and records its start time', () => {
    const libPath = require.resolve('./dlc_durable_json_store');
    const lockPath = path.join(root, 'live-owner.lock');
    const script = path.join(root, 'live-owner-holder.js');
    fs.writeFileSync(script, `const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const [libPath, lockPath, role] = process.argv.slice(2);
const { acquireDirectoryLock } = require(libPath);
if (role === 'contend') {
  try { acquireDirectoryLock(lockPath, 'held')(); console.log('ACQUIRED'); }
  catch (err) { console.log(err.code); }
} else {
  const release = acquireDirectoryLock(lockPath, 'held');
  console.log('OWNER ' + fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  const contender = spawnSync(process.execPath, [__filename, libPath, lockPath, 'contend'], { encoding: 'utf8' });
  release();
  console.log('CONTENDER ' + contender.stdout.trim());
}
`);
    const run = spawnSync(process.execPath, [script, libPath, lockPath, 'hold'], { encoding: 'utf8' });
    const owner = /OWNER (.*)/.exec(run.stdout);
    const contender = /CONTENDER (.*)/.exec(run.stdout);
    assert(owner && contender, `holder did not run: ${run.stderr}`);
    assert(contender[1] === 'LOCK_HELD', `a live holder in another process must be refused, got ${contender[1]}`);
    if (fs.existsSync('/proc/self/stat')) {
      assert(typeof JSON.parse(owner[1]).startTicks === 'string', 'the owner record must carry the holder start ticks');
    }
    assert(!fs.existsSync(lockPath), 'the holder did not release its lock');
  });

  test('a release that finds an extra file in the lock directory still removes the lock', () => {
    const lockPath = path.join(root, 'extra-file.lock');
    const release = acquireDirectoryLock(lockPath, 'held');
    fs.writeFileSync(path.join(lockPath, 'extra'), 'stray');
    release();
    assert(!fs.existsSync(lockPath), 'release left the lock directory behind');
  });

  test('release refuses to remove a lock another holder took over', () => {
    const lockPath = path.join(root, 'taken-over.lock');
    const release = acquireDirectoryLock(lockPath, 'held');
    fs.rmSync(lockPath, { recursive: true, force: true });
    plantLock(lockPath, heldBy({ pid: process.ppid }));
    let code = null;
    try { release(); } catch (err) { code = err.code; }
    assert(code === 'LOCK_LOST', `release of a lost lock must report LOCK_LOST, got ${code}`);
    assert(fs.existsSync(lockPath), 'release removed the lock of another holder');
    fs.rmSync(lockPath, { recursive: true, force: true });
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

  test('the process start time is field 22 of /proc/<pid>/stat, counted past the command name', () => {
    const stat = '4242 (node (a) b) S 1 4242 4242 0 -1 4194560 300 0 0 0 5 2 0 0 20 0 11 0 987654 1000 200 18446744073709551615';
    assert(parseProcStatStartTicks(stat) === '987654', `start ticks parsed as ${parseProcStatStartTicks(stat)}`);
    assert(parseProcStatStartTicks('garbage') === null, 'a stat line without a command name must not parse');
  });

  test('an acquisition records the boot id and process start time when the platform provides them', () => {
    const lockPath = path.join(root, 'identity.lock');
    withLockIdentity({ bootId: 'boot-a', startTicks: () => '1234' }, () => {
      const release = acquireDirectoryLock(lockPath, 'held');
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      release();
      assert(owner.bootId === 'boot-a' && owner.startTicks === '1234', `owner record ${JSON.stringify(owner)}`);
    });
    withLockIdentity({}, () => {
      const release = acquireDirectoryLock(lockPath, 'held');
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      release();
      assert(!('bootId' in owner) && !('startTicks' in owner), `owner record ${JSON.stringify(owner)}`);
    });
  });

  test('a lock from an earlier boot is reclaimed even when its pid is alive now', () => {
    const lockPath = path.join(root, 'earlier-boot.lock');
    withLockIdentity({ bootId: 'boot-b' }, () => {
      plantLock(lockPath, { ...heldBy({ pid: process.ppid }), token: 'a'.repeat(32), bootId: 'boot-b' });
      assert(lockCode(lockPath) === 'LOCK_HELD', 'a live holder from this boot must keep the lock');
      fs.rmSync(lockPath, { recursive: true, force: true });
      plantLock(lockPath, { ...heldBy({ pid: process.ppid }), token: 'a'.repeat(32), bootId: 'boot-a' });
      assert(lockCode(lockPath) === null, 'a lock written before the reboot was not reclaimed');
      assert(!fs.existsSync(lockPath), 'reclaimed lock was not released');
    });
  });

  test('a lock whose pid now belongs to a process started later is reclaimed', () => {
    const lockPath = path.join(root, 'reused-pid.lock');
    withLockIdentity({ bootId: 'boot-a', startTicks: (pid) => (pid === process.ppid ? '5000' : null) }, () => {
      plantLock(lockPath, { ...heldBy({ pid: process.ppid }), token: 'b'.repeat(32), bootId: 'boot-a', startTicks: '5000' });
      assert(lockCode(lockPath) === 'LOCK_HELD', 'the holder that started when the lock was taken must keep it');
      fs.rmSync(lockPath, { recursive: true, force: true });
      plantLock(lockPath, { ...heldBy({ pid: process.ppid }), token: 'b'.repeat(32), bootId: 'boot-a', startTicks: '4000' });
      assert(lockCode(lockPath) === null, 'a lock whose pid was reused was not reclaimed');
    });
    withLockIdentity({}, () => {
      plantLock(lockPath, { ...heldBy({ pid: process.ppid }), token: 'b'.repeat(32), bootId: 'boot-a', startTicks: '4000' });
      assert(lockCode(lockPath) === 'LOCK_HELD', 'without a start time to compare, a live pid must keep the lock');
      fs.rmSync(lockPath, { recursive: true, force: true });
    });
  });

  test('an owner record that exists but cannot be read keeps the lock held past the grace period', () => {
    const lockPath = path.join(root, 'unreadable-owner.lock');
    fs.mkdirSync(lockPath);
    fs.mkdirSync(path.join(lockPath, 'owner.json'));
    ageLock(lockPath);
    assert(lockCode(lockPath) === 'LOCK_HELD', 'an unreadable owner record was treated as ownerless');
    fs.rmSync(lockPath, { recursive: true, force: true });
  });

  test('an unreadable owner record is reported as unknown, with the path an operator should inspect', () => {
    const lockPath = path.join(root, 'unreadable-report.lock');
    fs.mkdirSync(lockPath);
    fs.mkdirSync(path.join(lockPath, 'owner.json'));
    ageLock(lockPath);
    let err = null;
    try { acquireDirectoryLock(lockPath, 'held'); } catch (caught) { err = caught; }
    assert(err && err.code === 'LOCK_HELD', `expected LOCK_HELD, got ${err && err.code}`);
    assert(err.holder === null, 'an unreadable owner has no holder to show');
    const ownerPath = path.join(lockPath, 'owner.json');
    assert(err.ownerPath === ownerPath, `ownerPath ${err.ownerPath}`);
    assert(err.message.startsWith('held; the owner record ' + ownerPath + ' exists but cannot be read'),
      `message does not name the unreadable owner record: ${err.message}`);
    assert(err.message.includes(`remove ${lockPath} only when none does`), 'message does not say when the lock may be removed');
    fs.rmSync(lockPath, { recursive: true, force: true });
  });

  test('a pid owned by another user (EPERM) is judged by its start ticks, and reclaimed when they differ', () => {
    const lockPath = path.join(root, 'eperm-reused.lock');
    const otherUserPid = 2147483645;
    withOtherUserPids([otherUserPid], () => {
      withLockIdentity({ bootId: 'boot-a', startTicks: (pid) => (pid === otherUserPid ? '9000' : null) }, () => {
        plantLock(lockPath, { ...heldBy({ pid: otherUserPid }), token: 'c'.repeat(32), bootId: 'boot-a', startTicks: '4000' });
        assert(lockCode(lockPath) === null, 'an EPERM pid whose start ticks differ was not reclaimed');
        assert(!fs.existsSync(lockPath), 'reclaimed lock was not released');
      });
    });
  });

  test('a pid owned by another user keeps the lock when its start ticks match, or cannot be read', () => {
    const lockPath = path.join(root, 'eperm-held.lock');
    const otherUserPid = 2147483645;
    withOtherUserPids([otherUserPid], () => {
      withLockIdentity({ bootId: 'boot-a', startTicks: () => '4000' }, () => {
        plantLock(lockPath, { ...heldBy({ pid: otherUserPid }), token: 'c'.repeat(32), bootId: 'boot-a', startTicks: '4000' });
        assert(lockCode(lockPath) === 'LOCK_HELD', 'an EPERM holder with matching start ticks must keep the lock');
        fs.rmSync(lockPath, { recursive: true, force: true });
      });
      withLockIdentity({ bootId: 'boot-a', startTicks: () => null }, () => {
        plantLock(lockPath, { ...heldBy({ pid: otherUserPid }), token: 'c'.repeat(32), bootId: 'boot-a', startTicks: '4000' });
        assert(lockCode(lockPath) === 'LOCK_HELD', 'an EPERM holder whose start ticks cannot be read must keep the lock');
        fs.rmSync(lockPath, { recursive: true, force: true });
      });
    });
  });

  test('pid 1, which another user owns, is judged by its start time in the real process table', () => {
    let eperm = false;
    try { process.kill(1, 0); } catch (err) { eperm = err.code === 'EPERM'; }
    if (!eperm || !fs.existsSync('/proc/1/stat')) {
      console.log('       (skipped: pid 1 is signalable from this account, so the EPERM path cannot be reached)');
      return;
    }
    const lockPath = path.join(root, 'pid-one.lock');
    plantLock(lockPath, { ...heldBy({ pid: 1 }), token: 'd'.repeat(32), startTicks: '1' });
    acquireDirectoryLock(lockPath, 'held')();
    assert(!fs.existsSync(lockPath), 'a lock whose pid 1 start time differs was not reclaimed');
  });

  test('an acquisition records its pid namespace when the platform provides it', () => {
    const lockPath = path.join(root, 'namespace.lock');
    withLockIdentity({ pidNamespace: 'pid:[7]' }, () => {
      const release = acquireDirectoryLock(lockPath, 'held');
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      release();
      assert(owner.pidNamespace === 'pid:[7]', `owner record ${JSON.stringify(owner)}`);
    });
  });

  test('a lock held by a live pid in another pid namespace of this host is held, not judged by its pid', () => {
    const lockPath = path.join(root, 'other-namespace.lock');
    withLockIdentity({ pidNamespace: 'pid:[2]' }, () => {
      plantLock(lockPath, { ...heldBy({ pid: DEAD_PID }), token: 'e'.repeat(32), pidNamespace: 'pid:[1]' });
      assert(lockCode(lockPath) === 'LOCK_HELD', 'a holder in another pid namespace was judged dead by its pid');
      assert(fs.existsSync(lockPath), 'a lock from another namespace was removed');
      fs.rmSync(lockPath, { recursive: true, force: true });
      plantLock(lockPath, { ...heldBy({ pid: process.pid }), token: 'f'.repeat(32), pidNamespace: 'pid:[1]' });
      assert(lockCode(lockPath) === 'LOCK_HELD', 'this pid number in another namespace was taken for this process');
      fs.rmSync(lockPath, { recursive: true, force: true });
    });
  });

  test('a pid namespace is not judged when the record has none or this process cannot read its own', () => {
    const lockPath = path.join(root, 'namespace-unknown.lock');
    withLockIdentity({ pidNamespace: 'pid:[2]' }, () => {
      plantLock(lockPath, { ...heldBy({ pid: DEAD_PID }), token: 'e'.repeat(32) });
      assert(lockCode(lockPath) === null, 'a record without a namespace must keep the pid-based reclaim');
    });
    withLockIdentity({}, () => {
      plantLock(lockPath, { ...heldBy({ pid: DEAD_PID }), token: 'e'.repeat(32), pidNamespace: 'pid:[1]' });
      assert(lockCode(lockPath) === 'LOCK_HELD', 'a recorded namespace this process cannot read must keep the lock held');
      fs.rmSync(lockPath, { recursive: true, force: true });
    });
  });

  test('a live holder in a new pid namespace of this host keeps its lock against a real contender', () => {
    if (!canUnsharePidNamespace()) {
      console.log('       (skipped: unshare cannot create a pid namespace here)');
      return;
    }
    const libPath = require.resolve('./dlc_durable_json_store');
    const lockPath = path.join(root, 'real-namespace.lock');
    const contenderPath = path.join(root, 'real-namespace-contender.js');
    fs.writeFileSync(contenderPath, `const { acquireDirectoryLock } = require(${JSON.stringify(libPath)});
try { acquireDirectoryLock(${JSON.stringify(lockPath)}, 'held')(); console.log('ACQUIRED'); }
catch (err) { console.log(err.code); }`);
    const release = acquireDirectoryLock(lockPath, 'held');
    const contender = spawnSync('unshare', ['--user', '--map-root-user', '--pid', '--fork', process.execPath, contenderPath],
      { encoding: 'utf8' });
    release();
    assert(contender.stdout.trim() === 'LOCK_HELD', `a contender in another pid namespace must be refused, got ${contender.stdout.trim()} ${contender.stderr}`);
    assert(!fs.existsSync(lockPath), 'the holder did not release its lock');
  });

  test('a held lock reports its holder', () => {
    const lockPath = path.join(root, 'reported-holder.lock');
    plantLock(lockPath, heldBy({ pid: process.ppid }));
    let holder = null;
    try { acquireDirectoryLock(lockPath, 'held'); } catch (err) { holder = err.holder; }
    assert(holder && holder.pid === process.ppid && holder.host === os.hostname(), `holder ${JSON.stringify(holder)}`);
    fs.rmSync(lockPath, { recursive: true, force: true });
  });

  test('a second copy of the module in this process refuses a lock the first copy holds', () => {
    const lockPath = path.join(root, 'second-copy.lock');
    const libPath = require.resolve('./dlc_durable_json_store');
    const release = acquireDirectoryLock(lockPath, 'held');
    delete require.cache[libPath];
    const secondCopy = require(libPath);
    let code = null;
    try { secondCopy.acquireDirectoryLock(lockPath, 'held'); } catch (err) { code = err.code; }
    release();
    assert(code === 'LOCK_HELD', `a lock held by another copy of the module must stay held, got ${code}`);
    assert(!fs.existsSync(lockPath), 'released lock was not removed');
  });

  test('a worker thread cannot take a directory lock, because it shares the pid of the process holding it', () => {
    const lockPath = path.join(root, 'worker-thread.lock');
    const libPath = require.resolve('./dlc_durable_json_store');
    const worker = `const { parentPort } = require('worker_threads');
const { acquireDirectoryLock } = require(${JSON.stringify(libPath)});
try { acquireDirectoryLock(${JSON.stringify(lockPath)}, 'held')(); parentPort.postMessage('ACQUIRED'); }
catch (err) { parentPort.postMessage(err.code || err.message); }`;
    const child = spawnSync(process.execPath, ['-e', `const { Worker } = require('worker_threads');
const w = new Worker(${JSON.stringify(worker)}, { eval: true });
w.on('message', (m) => console.log('RESULT ' + m));
w.on('error', (e) => { console.log('RESULT ERROR ' + e.message); });`], { encoding: 'utf8' });
    const result = /RESULT (.*)/.exec(child.stdout);
    assert(result && result[1] !== 'ACQUIRED', `a worker thread must not acquire a directory lock, got ${result && result[1]}`);
    assert(!fs.existsSync(lockPath), 'a refused worker thread must leave no lock behind');
  });

  test('the DLC state store recovers a contract lock left by a crashed writer', () => {
    const store = new DlcStateStore(path.join(root, 'state'));
    plantLock(store._lockDirectory('contract-a'), heldBy({ pid: DEAD_PID }));
    assert(store._withLock('contract-a', () => 'ran') === 'ran', 'stale state lock blocked the store');
    assert(!fs.existsSync(store._lockDirectory('contract-a')), 'state lock was not released');
  });

  test('the DLC state store reports a held contract lock with its contract id', () => {
    const store = new DlcStateStore(path.join(root, 'state-held'));
    plantLock(store._lockDirectory('contract-b'), heldBy({ pid: process.ppid }));
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
  test('a failed state write is reported as itself when the lock was taken over during it', () => {
    const store = new DlcStateStore(path.join(root, 'state-lost'));
    const lockPath = store._lockDirectory('contract-d');
    const err = failureAfterTakeover(lockPath, () => store._withLock('contract-d', () => {
      takeOverLock(lockPath);
      throw new Error('state write failed');
    }));
    assertOwnFailureKept(err, lockPath, 'state write failed');
  });

  test('a failed oracle write is reported as itself when the lock was taken over during it', () => {
    const store = new DlcOracleEventStore({
      baseDirectory: path.join(root, 'oracle-lost'),
      wrappingKey: Buffer.alloc(32, 7),
      network: 'bitcoin-regtest'
    });
    const lockPath = store._lockDirectory('event-b');
    const err = failureAfterTakeover(lockPath, () => store._withLock('event-b', () => {
      takeOverLock(lockPath);
      throw new Error('oracle write failed');
    }));
    assertOwnFailureKept(err, lockPath, 'oracle write failed');
  });

  test('a failed watchtower journal write is reported as itself when the lock was taken over during it', () => {
    const keys = crypto.generateKeyPairSync('ed25519');
    const journal = new DlcWatchtowerJournal(path.join(root, 'journal-lost'), {
      watchtowerId: 'independent-watchtower-1',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const lockPath = path.join(root, 'journal-lost', `.${journalContractKey('contract-e')}.lock`);
    const err = failureAfterTakeover(lockPath, () => journal._withLock('contract-e', () => {
      takeOverLock(lockPath);
      throw new Error('journal write failed');
    }));
    assertOwnFailureKept(err, lockPath, 'journal write failed');
  });

  test('a failed nonce journal write is reported as itself when the lock was taken over during it', () => {
    const journalPath = path.join(root, 'nonce-lost', 'journal.json');
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const lockPath = `${journalPath}.lock`;
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to !== journalPath) return realRename(from, to);
      takeOverLock(lockPath);
      throw new Error('nonce journal write failed');
    };
    let err;
    try { reserveNonceUsage(Buffer.alloc(64, 4), Buffer.alloc(32, 5), { journalPath }); }
    catch (caught) { err = caught; }
    finally { fs.renameSync = realRename; }
    assert(err, 'the nonce reservation did not fail');
    assertOwnFailureKept(err, lockPath, 'nonce journal write failed');
  });

  test('a successful section whose lock was taken over fails with LOCK_LOST and carries its result', () => {
    const lockPath = path.join(root, 'release-lost-success-throw.lock');
    let err = null;
    try {
      withDirectoryLock(lockPath, 'held', () => {
        takeOverLock(lockPath);
        return 'overlapped-result';
      });
    } catch (caught) { err = caught; }
    try {
      assert(err && err.code === 'LOCK_LOST', `an overlapped section must fail with LOCK_LOST, got ${err && (err.code || err.message)}`);
      assert(err.result === 'overlapped-result', `the section's result must be attached, got ${err.result}`);
      assert(fs.existsSync(lockPath), 'release removed the lock of another holder');
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  });

  test('a nonce reservation whose lock was taken over fails, so the caller does not sign', () => {
    const journalPath = path.join(root, 'nonce-overlap', 'journal.json');
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const lockPath = `${journalPath}.lock`;
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === journalPath) takeOverLock(lockPath);
      return realRename(from, to);
    };
    let err = null;
    try { reserveNonceUsage(Buffer.alloc(64, 6), Buffer.alloc(32, 7), { journalPath }); }
    catch (caught) { err = caught; }
    finally {
      fs.renameSync = realRename;
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
    assert(err && err.code === 'LOCK_LOST',
      `an overlapped nonce reservation must not report success, got ${err ? err.code || err.message : 'success'}`);
  });

  test("an append-once store's successful section keeps its result when its lock was taken over, and reports it", () => {
    const lockPath = path.join(root, 'release-lost-success.lock');
    const reported = [];
    const realReport = lockReporter.releaseFailed;
    lockReporter.releaseFailed = (releaseError) => reported.push(releaseError);
    try {
      const result = withDirectoryLock(lockPath, 'held', () => {
        takeOverLock(lockPath);
        return 'committed-result';
      }, { lostLock: 'report' });
      assert(result === 'committed-result', `the committed result was replaced by ${result}`);
      assert(reported.length === 1 && reported[0].code === 'LOCK_LOST',
        `the lost lock must be reported once, got ${reported.map((item) => item.code)}`);
      assert(fs.existsSync(lockPath), 'release removed the lock of another holder');
    } finally {
      lockReporter.releaseFailed = realReport;
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  });

  test('an unknown lostLock option is refused before the lock is taken', () => {
    const lockPath = path.join(root, 'bad-option.lock');
    let message = null;
    try { withDirectoryLock(lockPath, 'held', () => 'ran', { lostLock: 'ignore' }); } catch (err) { message = err.message; }
    assert(message && /lostLock/.test(message), `an unknown option must be refused, got ${message}`);
    assert(!fs.existsSync(lockPath), 'a refused call must not take the lock');
  });

  test('a recorded identity this process cannot read keeps the lock held instead of judging it by pid', () => {
    const lockPath = path.join(root, 'unreadable-identity.lock');
    withLockIdentity({}, () => {
      plantLock(lockPath, { ...heldBy({ pid: DEAD_PID }), token: 'd'.repeat(32), pidNamespace: 'pid:[1]' });
      assert(lockCode(lockPath) === 'LOCK_HELD', 'a lock with a recorded pid namespace was reclaimed although this process cannot read its own');
      fs.rmSync(lockPath, { recursive: true, force: true });
      plantLock(lockPath, { ...heldBy({ pid: DEAD_PID }), token: 'd'.repeat(32), bootId: 'boot-x' });
      assert(lockCode(lockPath) === 'LOCK_HELD', 'a lock with a recorded boot id was reclaimed although this process cannot read its own');
      fs.rmSync(lockPath, { recursive: true, force: true });
    });
  });

  test('releasing a lock whose owner record cannot be read says so and names the path, and keeps the lock', () => {
    const lockPath = path.join(root, 'unreadable-owner-release.lock');
    const release = acquireDirectoryLock(lockPath, 'held');
    const ownerPath = path.join(lockPath, 'owner.json');
    const realRead = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => {
      if (file === ownerPath) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return realRead(file, ...rest);
    };
    let err;
    try { release(); } catch (caught) { err = caught; } finally { fs.readFileSync = realRead; }
    assert(err && err.code === 'LOCK_OWNER_UNREADABLE', `got ${err && err.code}`);
    assert(String(err.message).includes(ownerPath), 'the message does not name the owner record');
    assert(fs.existsSync(lockPath), 'a lock whose owner cannot be read was removed');
    fs.rmSync(lockPath, { recursive: true, force: true });
  });

  test('a failed section thrown as a non-object still reports its lost lock instead of losing it', () => {
    const lockPath = path.join(root, 'release-lost-thrown.lock');
    const reported = [];
    const realReport = lockReporter.releaseFailed;
    lockReporter.releaseFailed = (releaseError) => reported.push(releaseError);
    let thrown;
    try {
      withDirectoryLock(lockPath, 'held', () => {
        takeOverLock(lockPath);
        throw 'plain failure';
      });
    } catch (caught) { thrown = caught; }
    finally {
      lockReporter.releaseFailed = realReport;
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
    assert(thrown === 'plain failure', `the section's own failure must be rethrown, got ${thrown}`);
    assert(reported.length === 1 && reported[0].code === 'LOCK_LOST', 'the lost lock must be reported');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

asyncTest('an async section whose lock was taken over fails with LOCK_LOST unless it opts into reporting', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-durable-lock-async-'));
  const lockPath = path.join(directory, 'async-release-lost.lock');
  const reported = [];
  const realReport = lockReporter.releaseFailed;
  lockReporter.releaseFailed = (releaseError) => reported.push(releaseError);
  try {
    let err = null;
    try {
      await withDirectoryLockAsync(lockPath, 'held', async () => {
        await Promise.resolve();
        takeOverLock(lockPath);
        return 'overlapped-result';
      });
    } catch (caught) { err = caught; }
    assert(err && err.code === 'LOCK_LOST' && err.result === 'overlapped-result',
      `an overlapped async section must fail with LOCK_LOST and its result, got ${err && (err.code || err.message)}`);
    assert(reported.length === 0, 'a thrown lost lock must not also be reported');
    fs.rmSync(lockPath, { recursive: true, force: true });
    const result = await withDirectoryLockAsync(lockPath, 'held', async () => {
      await Promise.resolve();
      takeOverLock(lockPath);
      return 'committed-result';
    }, { lostLock: 'report' });
    assert(result === 'committed-result', `the committed result was replaced by ${result}`);
    assert(reported.length === 1 && reported[0].code === 'LOCK_LOST', 'the lost lock must be reported once');
  } finally {
    lockReporter.releaseFailed = realReport;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

asyncTest('an async section that fails keeps its own error with the release failure attached', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-durable-lock-async-fail-'));
  const lockPath = path.join(directory, 'async-fail-lost.lock');
  let err = null;
  try {
    await withDirectoryLockAsync(lockPath, 'held', async () => {
      takeOverLock(lockPath);
      throw new Error('async write failed');
    });
  } catch (caught) { err = caught; }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
  assertOwnFailureKept(err, lockPath, 'async write failed');
});

(async () => {
  for (const item of asyncTests) {
    try { await item.fn(); console.log(`  OK  ${item.name}`); passed++; }
    catch (err) { console.log(`  FAIL ${item.name}`); console.log(`       ${err.message}`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
