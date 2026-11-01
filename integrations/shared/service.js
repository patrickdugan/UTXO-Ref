'use strict';

// The one implementation of the HTTP, input and file rules shared by the Node services in integrations/ (beta
// faucet, liquidity sidecar, BetweenBits adapter). Keep it dependency-free: services load it by relative path.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class HttpError extends Error {
  constructor(statusCode, code, message = code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

// Reads one JSON object from a request body. An empty body is {}. Oversized bodies are refused with 413 while the
// rest of the stream is discarded, so the 413 reaches the client. A non-object body is a 400, never a TypeError
// later in a handler.
function readJsonBody(req, { limit = 16 * 1024, requireJson = false } = {}) {
  return new Promise((resolve, reject) => {
    if (requireJson && !String(req.headers['content-type'] || '').startsWith('application/json')) {
      reject(new HttpError(415, 'unsupported_media_type', 'content-type must be application/json'));
      return;
    }
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new HttpError(413, 'body_too_large', 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (bytes > limit) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      let value;
      try {
        value = JSON.parse(text);
      } catch (err) {
        reject(new HttpError(400, 'invalid_json', err.message));
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject(new HttpError(400, 'invalid_json', 'body must be a JSON object'));
        return;
      }
      resolve(value);
    });
    req.on('error', reject);
  });
}

// An integer in [minimum, maximum] written as a JSON number or a plain decimal string. Anything else is null, so
// "1e3", "0x10" and " " never reach a handler as a different number than the one the caller meant.
function boundedInteger(value, minimum, maximum) {
  const text = typeof value === 'string' ? value.trim() : value;
  if (typeof text === 'string' ? !/^-?\d+$/.test(text) : typeof text !== 'number') return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function envValue(env, name, fallback = '') {
  const value = env[name];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function fsyncDirectory(directory) {
  // Not every platform opens directories for fsync (Windows does not); the rename is still atomic there.
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (_err) {
    /* Unsupported here. */
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

// Writes the whole file to disk before it replaces the old one, then makes the rename itself durable. A claim
// that reached Bitcoin Core must not disappear from the journal because the host lost power before the write.
function writeAtomicPrivate(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, text);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
  } catch (err) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw err;
  }
  fs.renameSync(temporary, filePath);
  fsyncDirectory(path.dirname(filePath));
  try { fs.chmodSync(filePath, 0o600); } catch (_err) { /* Best effort on Windows. */ }
}

module.exports = { HttpError, sendJson, readJsonBody, boundedInteger, envValue, writeAtomicPrivate };
