'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isMainThread } = require('worker_threads');

function requireByteLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > 16 * 1024 * 1024) {
    throw new Error('durable JSON byte limit must be an integer from 2 through 16777216');
  }
  return maxBytes;
}

function assertNonSymlinkDirectory(directory, label = 'durable JSON') {
  const resolved = path.resolve(directory);
  const metadata = fs.lstatSync(resolved, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} directory must be a non-symlink directory`);
  }
  const realPath = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  const normalizeForComparison = (filePath) => process.platform === 'win32'
    ? path.resolve(filePath).toLowerCase()
    : path.resolve(filePath);
  if (normalizeForComparison(realPath) !== normalizeForComparison(resolved)) {
    throw new Error(`${label} directory must not traverse filesystem links`);
  }
  return metadata;
}

function ensureNonSymlinkDirectory(directory, label = 'durable JSON') {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return assertNonSymlinkDirectory(directory, label);
}

// An entry created or removed in a directory is durable only after that
// directory is fsynced. Node cannot open a directory for fsync on Windows, so
// there the flush is a no-op and the gap is recorded as a maintainer decision.
function flushDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function createDurableDirectory(directory) {
  fs.mkdirSync(directory, { mode: 0o700 });
  flushDirectory(path.dirname(directory));
}

function sameOpenedFile(metadata, expected) {
  return metadata.isFile() && metadata.nlink === 1n &&
    metadata.dev === expected.dev && metadata.ino === expected.ino && metadata.size === expected.size &&
    metadata.mtimeNs === expected.mtimeNs && metadata.ctimeNs === expected.ctimeNs;
}

function sameDirectory(metadata, expected) {
  return metadata.isDirectory() && !metadata.isSymbolicLink() &&
    metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function readBoundedJson(filePath, { maxBytes, label = 'durable JSON record' }) {
  requireByteLimit(maxBytes);
  const parentPath = path.dirname(filePath);
  const parentBefore = assertNonSymlinkDirectory(parentPath, label);
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size < 2n || before.size > BigInt(maxBytes)) {
    throw new Error(`${label} must be one bounded regular file`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameOpenedFile(opened, before)) throw new Error(`${label} changed while opening`);
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count < 1) throw new Error(`${label} was truncated while reading`);
      offset += count;
    }
    const pathAfter = fs.lstatSync(filePath, { bigint: true });
    if (!sameOpenedFile(pathAfter, opened)) throw new Error(`${label} path changed while reading`);
    const after = fs.fstatSync(fd, { bigint: true });
    if (!sameOpenedFile(after, opened)) throw new Error(`${label} changed while reading`);
    const parentAfter = assertNonSymlinkDirectory(parentPath, label);
    if (!sameDirectory(parentAfter, parentBefore)) throw new Error(`${label} directory changed while reading`);
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    if (bytes) bytes.fill(0);
    fs.closeSync(fd);
  }
}

function writeJsonAppendOnce(directory, name, record, { maxBytes, label = 'durable JSON record' }) {
  requireByteLimit(maxBytes);
  const directoryBefore = assertNonSymlinkDirectory(directory, label);
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new Error(`${label} filename is invalid`);
  }
  const finalPath = path.join(directory, name);
  const temporaryPath = path.join(
    directory,
    `.${name}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (bytes.length > maxBytes) {
    bytes.fill(0);
    throw new Error(`${label} exceeds its byte limit`);
  }
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch (_cleanupError) {}
    throw error;
  } finally {
    bytes.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
  }
  try {
    // Linking publishes without replacing an existing record. A crash before
    // unlinking the temporary name leaves nlink=2, which all reads reject.
    fs.linkSync(temporaryPath, finalPath);
    fs.unlinkSync(temporaryPath);
    flushDirectory(directory);
    const before = fs.lstatSync(finalPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error(`${label} publication did not produce one regular file`);
    }
    const finalFd = fs.openSync(finalPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(finalFd, { bigint: true });
      if (!sameOpenedFile(opened, before)) throw new Error(`${label} changed before final flush`);
      fs.fsyncSync(finalFd);
      const pathAfter = fs.lstatSync(finalPath, { bigint: true });
      if (!sameOpenedFile(pathAfter, opened)) throw new Error(`${label} path changed during final flush`);
      const flushed = fs.fstatSync(finalFd, { bigint: true });
      if (!sameOpenedFile(flushed, opened)) throw new Error(`${label} changed during final flush`);
    } finally { fs.closeSync(finalFd); }
    const directoryAfter = assertNonSymlinkDirectory(directory, label);
    if (!sameDirectory(directoryAfter, directoryBefore)) {
      throw new Error(`${label} directory changed during publication`);
    }
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch (_cleanupError) {}
    throw error;
  }
  return finalPath;
}

// Takes an exclusive lock by creating lockPath as a directory, which only one
// process can do at a time. The holder writes an owner record (owner.json) with
// its pid, host and a random per-acquisition token. On Linux it also records its
// boot id, its pid namespace and its process start ticks.
//
// A held lock is reclaimed only when one check proves its holder gone. The
// checks run in this order:
// - another host: never judged here, the lock is held.
// - another boot id: the holder ran before a reboot, so it is gone.
// - another pid namespace: a pid means something only in the namespace that
//   wrote it. Containers in one pod share a hostname and can reuse pid numbers,
//   so the lock is held and never judged dead.
// - this process's own pid: gone unless its token is held by a live acquisition
//   in this process.
// - no such pid (ESRCH): gone. EPERM means the pid exists under another user, so
//   it is judged by its start ticks like any other live pid.
// - a start-ticks mismatch: the pid was reused, so gone.
// A check uses an identity field only when the record has it and this process
// can read it. Anything else keeps the lock held (fail closed).
//
// Fallbacks for records from earlier builds. Those records carry fewer fields:
// `{pid}` alone, which is still read, `{pid, host}` (from d110709),
// `{pid, host, token}` (from 7b13578), and `{pid, host, token, startTime}` (from
// 6d7f3a9, where startTime was written but never read). Each is judged by the
// fields it has. A pid reused after a reboot therefore keeps such a lock held
// until an operator removes it. Off Linux no identity is recorded, so a reused
// pid keeps the lock held there too.
//
// A lock with no owner record is reclaimed once it is older than the grace
// period, which covers a crash between creating the directory and writing the
// owner. An owner record that exists but cannot be read is never reclaimed
// automatically; LOCK_HELD names its path so an operator can inspect it.
//
// The returned function releases the lock and throws LOCK_LOST if the lock is
// no longer the one it acquired. Callers use withDirectoryLock, which keeps a
// release failure from replacing the error or the result of the critical section.
const LOCK_OWNER_FILE = 'owner.json';
const OWNERLESS_LOCK_GRACE_MS = 60 * 1000;
// Tokens of the locks this process holds right now. A pid can be reused after a
// crash, so a lock recorded with this pid is live only while its token is here.
// The set lives on globalThis so every copy of this module in the process sees
// the same locks. A worker thread has its own globalThis and shares the pid, so
// acquireDirectoryLock refuses to run off the main thread.
const heldLockTokens = (globalThis[Symbol.for('utxoref.dlc.heldLockTokens')] ??= new Set());

// field 22 of /proc/<pid>/stat, in clock ticks since boot. The command name
// (field 2) is parenthesised and may contain spaces or ')', so fields are
// counted from the last ')'.
function parseProcStatStartTicks(stat) {
  const close = String(stat).lastIndexOf(')');
  if (close < 0) return null;
  const startTicks = String(stat).slice(close + 2).split(' ')[19];
  return /^[0-9]+$/.test(startTicks || '') ? startTicks : null;
}

// Overridable in tests; null wherever the platform does not provide it.
const lockIdentity = {
  bootId() {
    if (process.platform !== 'linux') return null;
    try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; }
    catch (_error) { return null; }
  },
  processStartTicks(pid) {
    if (process.platform !== 'linux') return null;
    try { return parseProcStatStartTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); }
    catch (_error) { return null; }
  },
  // Namespace inode numbers are per kernel, so this compares only within one boot.
  pidNamespace() {
    if (process.platform !== 'linux') return null;
    try { return fs.readlinkSync('/proc/self/ns/pid') || null; }
    catch (_error) { return null; }
  }
};

// An owner record that exists but cannot be read now (EBUSY or EPERM from an
// antivirus or sync client on Windows) is not ownerless: treating it so would
// reclaim a live lock once the grace period passed.
const UNREADABLE_OWNER = Object.freeze({ unreadable: true });

function readLockOwner(lockPath) {
  let text;
  try { text = fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? null : UNREADABLE_OWNER; }
  try { return JSON.parse(text); }
  catch (_error) { return null; }
}

// The checks and their fallbacks are described in the header above.
function lockOwnerIsGone(owner) {
  if (!owner || owner === UNREADABLE_OWNER || !Number.isSafeInteger(owner.pid)) return false;
  if (owner.host !== undefined && owner.host !== os.hostname()) return false;
  // No process survives a reboot.
  if (typeof owner.bootId === 'string') {
    const bootId = lockIdentity.bootId();
    if (!bootId) return false;
    if (bootId !== owner.bootId) return true;
  }
  // A recorded namespace this process cannot compare against its own is not a match: held, not reclaimed.
  if (typeof owner.pidNamespace === 'string') {
    const pidNamespace = lockIdentity.pidNamespace();
    if (!pidNamespace || pidNamespace !== owner.pidNamespace) return false;
  }
  if (owner.pid === process.pid) return !heldLockTokens.has(owner.token);
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return true;
    if (error.code !== 'EPERM') return false;
  }
  // The pid is in use: it is the holder only if it started when the holder did.
  if (typeof owner.startTicks === 'string') {
    const startTicks = lockIdentity.processStartTicks(owner.pid);
    if (startTicks && startTicks !== owner.startTicks) return true;
  }
  return false;
}

function lockAgeMs(lockPath) {
  try { return Date.now() - fs.lstatSync(lockPath).mtimeMs; }
  catch (_error) { return 0; }
}

function lockIsAbandoned(lockPath, owner) {
  return owner ? lockOwnerIsGone(owner) : lockAgeMs(lockPath) > OWNERLESS_LOCK_GRACE_MS;
}

// An owner record is written once and never changed, so the same record means
// the same acquisition.
function sameLockOwner(left, right) {
  if (left === null || right === null) return left === right;
  return left.pid === right.pid && left.host === right.host && left.token === right.token;
}

// Moves an abandoned lock aside and discards it. The rename is not conditional,
// so the owner is read again from the moved directory, and if it is not the
// abandoned lock it is put back. Residual race: between the rename and the
// restore the path is empty, so a third process can acquire it. The restore then
// fails and this call throws, and the displaced holder and the new holder both
// believe they hold the lock until their critical sections end. Release never
// removes a lock that it does not own (see releaseDirectoryLock), so the overlap
// ends without deleting the new holder's lock. Closing it needs a compare-and-swap
// the filesystem does not offer, or an O_EXCL lock file with fencing.
function reclaimAbandonedLock(lockPath) {
  const owner = readLockOwner(lockPath);
  if (!lockIsAbandoned(lockPath, owner)) return false;
  const aside = `${lockPath}.abandoned-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try { fs.renameSync(lockPath, aside); } catch (_error) { return false; }
  if (sameLockOwner(readLockOwner(aside), owner) && lockIsAbandoned(aside, owner)) {
    fs.rmSync(aside, { recursive: true, force: true });
    return true;
  }
  try { fs.renameSync(aside, lockPath); }
  catch (_error) { throw new Error(`lock ${lockPath} was displaced and could not be restored; recover it from ${aside}`); }
  return false;
}

// The lock is released by one rename, owner record included, so the lock path
// is never a directory without an owner. A failure to remove the moved copy
// leaves the lock released.
function releaseDirectoryLock(lockPath, token) {
  heldLockTokens.delete(token);
  const owner = readLockOwner(lockPath);
  if (owner === UNREADABLE_OWNER) {
    throw Object.assign(new Error(`the owner record of lock ${lockPath} cannot be read, so the lock was not removed; inspect ${path.join(lockPath, LOCK_OWNER_FILE)} and remove the directory when no process holds it`), { code: 'LOCK_OWNER_UNREADABLE' });
  }
  if (!owner || owner.token !== token) {
    throw Object.assign(new Error(`lock ${lockPath} was taken over while held; it was not removed`), { code: 'LOCK_LOST' });
  }
  const released = `${lockPath}.released-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.renameSync(lockPath, released);
  fs.rmSync(released, { recursive: true, force: true });
}

function acquireDirectoryLock(lockPath, heldMessage) {
  if (!isMainThread) {
    throw Object.assign(new Error('directory locks are taken on the main thread only: a worker thread shares the pid of the process that holds them'),
      { code: 'LOCK_OFF_MAIN_THREAD' });
  }
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(lockPath, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && reclaimAbandonedLock(lockPath)) continue;
      const holder = readLockOwner(lockPath);
      if (holder === UNREADABLE_OWNER) {
        const ownerPath = path.join(lockPath, LOCK_OWNER_FILE);
        throw Object.assign(new Error(`${heldMessage}; the owner record ${ownerPath} exists but cannot be read, so its holder is unknown. ` +
          `Inspect that file (permissions, a directory in its place, or an antivirus lock) and whether a process still holds the lock; ` +
          `remove ${lockPath} only when none does`), { code: 'LOCK_HELD', holder: null, ownerPath });
      }
      throw Object.assign(new Error(heldMessage), {
        code: 'LOCK_HELD',
        holder: holder ? { pid: holder.pid, host: holder.host } : null
      });
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  heldLockTokens.add(token);
  const owner = { pid: process.pid, host: os.hostname(), token };
  const bootId = lockIdentity.bootId();
  const pidNamespace = lockIdentity.pidNamespace();
  const startTicks = lockIdentity.processStartTicks(process.pid);
  if (bootId) owner.bootId = bootId;
  if (pidNamespace) owner.pidNamespace = pidNamespace;
  if (startTicks) owner.startTicks = startTicks;
  try {
    fs.writeFileSync(path.join(lockPath, LOCK_OWNER_FILE), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    heldLockTokens.delete(token);
    // Remove only the directory this call created, and only while it is still
    // empty: whatever else is there now is not this call's to delete.
    try { fs.rmdirSync(lockPath); } catch (_cleanupError) {}
    throw error;
  }
  return () => releaseDirectoryLock(lockPath, token);
}

// The one channel for a release failure that the caller's result or error cannot
// carry. Overridable in tests, like lockIdentity. The default writes a structured
// line to stderr. A LOCK_LOST here means another holder overlapped the section.
const lockReporter = {
  releaseFailed(releaseError) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'durable_lock_release_failed',
      code: releaseError.code || null,
      message: releaseError.message
    }));
  }
};

// A section that succeeded has committed its writes. What a release failure means then depends on the section:
//   'throw' (the default) - LOCK_LOST means another holder overlapped the section, so a read-modify-write of shared
//     state, or a nonce reservation followed by a signature, may have raced; the caller must see the failure.
//   'report' - the section is idempotent or append-once (an O_EXCL record, a claim that a retry repeats safely),
//     so its result is kept and the lost lock is reported through lockReporter.
// A release failure that leaves the lock released (the moved copy could not be removed) is only reported either way.
function releaseAfterSuccess(release, lostLock) {
  try { release(); }
  catch (releaseError) {
    if (lostLock !== 'report' && (releaseError.code === 'LOCK_LOST' || releaseError.code === 'LOCK_OWNER_UNREADABLE')) throw releaseError;
    lockReporter.releaseFailed(releaseError);
  }
}

// The critical section's own error is the one the caller must see. A release
// that fails after it is attached as releaseError instead of replacing it.
function releaseAfterFailure(release, failure) {
  try { release(); }
  catch (releaseError) {
    if (failure !== null && typeof failure === 'object') failure.releaseError = releaseError;
    else lockReporter.releaseFailed(releaseError);
  }
}

function lostLockPolicy(options) {
  const lostLock = options && options.lostLock !== undefined ? options.lostLock : 'throw';
  if (lostLock !== 'throw' && lostLock !== 'report') throw new Error("withDirectoryLock option lostLock must be 'throw' or 'report'");
  return lostLock;
}

function withDirectoryLock(lockPath, heldMessage, run, options) {
  const lostLock = lostLockPolicy(options);
  const release = acquireDirectoryLock(lockPath, heldMessage);
  let result;
  try { result = run(); }
  catch (error) { releaseAfterFailure(release, error); throw error; }
  releaseAfterSuccess(release, lostLock);
  return result;
}

async function withDirectoryLockAsync(lockPath, heldMessage, run, options) {
  const lostLock = lostLockPolicy(options);
  const release = acquireDirectoryLock(lockPath, heldMessage);
  let result;
  try { result = await run(); }
  catch (error) { releaseAfterFailure(release, error); throw error; }
  releaseAfterSuccess(release, lostLock);
  return result;
}

// Replaces filePath with text. The new bytes are flushed before the rename and
// the directory entry is flushed after it, so after a crash or power loss the
// file holds either the previous content or the complete new content.
function writeFileAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    const fd = fs.openSync(temporaryPath, 'wx');
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch (_cleanupError) {}
    throw error;
  }
  // Windows cannot open a directory to flush it.
  if (process.platform !== 'win32') {
    const directoryFd = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
}

module.exports = {
  acquireDirectoryLock,
  lockIdentity,
  lockReporter,
  parseProcStatStartTicks,
  assertNonSymlinkDirectory,
  createDurableDirectory,
  ensureNonSymlinkDirectory,
  readBoundedJson,
  withDirectoryLock,
  withDirectoryLockAsync,
  writeFileAtomic,
  writeJsonAppendOnce
};
