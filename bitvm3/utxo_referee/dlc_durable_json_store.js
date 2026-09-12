'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function requireByteLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > 16 * 1024 * 1024) {
    throw new Error('durable JSON byte limit must be an integer from 2 through 16777216');
  }
  return maxBytes;
}

function assertNonSymlinkDirectory(directory, label = 'durable JSON') {
  const metadata = fs.lstatSync(directory, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} directory must be a non-symlink directory`);
  }
  return metadata;
}

function ensureNonSymlinkDirectory(directory, label = 'durable JSON') {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return assertNonSymlinkDirectory(directory, label);
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
    const before = fs.lstatSync(finalPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw new Error(`${label} publication did not produce one regular file`);
    }
    const finalFd = fs.openSync(finalPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(finalFd, { bigint: true });
      if (!sameOpenedFile(opened, before)) throw new Error(`${label} changed before final flush`);
      fs.fsyncSync(finalFd);
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

module.exports = {
  assertNonSymlinkDirectory,
  ensureNonSymlinkDirectory,
  readBoundedJson,
  writeJsonAppendOnce
};
