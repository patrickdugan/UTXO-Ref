'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
// process can do at a time. The holder records its pid, host and a random
// per-acquisition token in the directory, so a lock left by a process that no
// longer exists on this host is reclaimed instead of blocking every later run.
// A lock with no readable owner is reclaimed once it is older than the grace
// period, which covers a crash between creating the directory and writing the
// owner. Any other held lock fails closed. The returned function releases the
// lock and throws LOCK_LOST if the lock is no longer the one it acquired. Callers
// use withDirectoryLock, which keeps that release failure from replacing the
// error of the critical section.
const LOCK_OWNER_FILE = 'owner.json';
const OWNERLESS_LOCK_GRACE_MS = 60 * 1000;
// Tokens of the locks this process holds right now. A pid can be reused after a
// crash, so a lock recorded with this pid is live only while its token is here.
const heldLockTokens = new Set();

function readLockOwner(lockPath) {
  try { return JSON.parse(fs.readFileSync(path.join(lockPath, LOCK_OWNER_FILE), 'utf8')); }
  catch (_error) { return null; }
}

// Locks written before the host was recorded carry only a pid. They were
// written by the same local store, so they are judged on this host.
function lockOwnerIsGone(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid)) return false;
  if (owner.host !== undefined && owner.host !== os.hostname()) return false;
  if (owner.pid === process.pid) return !heldLockTokens.has(owner.token);
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
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

function releaseDirectoryLock(lockPath, token) {
  heldLockTokens.delete(token);
  const owner = readLockOwner(lockPath);
  if (!owner || owner.token !== token) {
    throw Object.assign(new Error(`lock ${lockPath} was taken over while held; it was not removed`), { code: 'LOCK_LOST' });
  }
  fs.rmSync(path.join(lockPath, LOCK_OWNER_FILE), { force: true });
  fs.rmdirSync(lockPath);
}

function acquireDirectoryLock(lockPath, heldMessage) {
  for (let attempt = 0; ; attempt++) {
    try { fs.mkdirSync(lockPath, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && reclaimAbandonedLock(lockPath)) continue;
      throw Object.assign(new Error(heldMessage), { code: 'LOCK_HELD' });
    }
  }
  const token = crypto.randomBytes(16).toString('hex');
  heldLockTokens.add(token);
  try {
    fs.writeFileSync(path.join(lockPath, LOCK_OWNER_FILE),
      JSON.stringify({ pid: process.pid, host: os.hostname(), token }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    heldLockTokens.delete(token);
    fs.rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
  return () => releaseDirectoryLock(lockPath, token);
}

// The critical section's own error is the one the caller must see. A release
// that fails after it is attached as releaseError instead of replacing it.
function releaseAfterFailure(release, failure) {
  try { release(); }
  catch (releaseError) {
    if (failure !== null && typeof failure === 'object') failure.releaseError = releaseError;
    else process.emitWarning(releaseError.message);
  }
}

function withDirectoryLock(lockPath, heldMessage, run) {
  const release = acquireDirectoryLock(lockPath, heldMessage);
  let result;
  try { result = run(); }
  catch (error) { releaseAfterFailure(release, error); throw error; }
  release();
  return result;
}

async function withDirectoryLockAsync(lockPath, heldMessage, run) {
  const release = acquireDirectoryLock(lockPath, heldMessage);
  let result;
  try { result = await run(); }
  catch (error) { releaseAfterFailure(release, error); throw error; }
  release();
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
  assertNonSymlinkDirectory,
  createDurableDirectory,
  ensureNonSymlinkDirectory,
  readBoundedJson,
  withDirectoryLock,
  withDirectoryLockAsync,
  writeFileAtomic,
  writeJsonAppendOnce
};
