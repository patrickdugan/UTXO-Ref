const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RATE_LIMIT_KIND = 'utxoref_testnet_beta_rate_limits';
const RATE_LIMIT_FILE_LIMIT = 4 * 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

function rateLimitPathFor(statePath) {
  return `${path.resolve(statePath)}.rate-limits.json`;
}

function normalizeCounter(key, value) {
  if (!/^[0-9a-f]{64}:(minute|hour):\d{1,15}$/.test(key) || !value || typeof value !== 'object' ||
      !Number.isSafeInteger(value.count) || value.count < 0 ||
      [value.createdAt, value.expiresAt, value.updatedAt || value.createdAt].some((time) =>
        typeof time !== 'string' || !Number.isFinite(Date.parse(time)))) {
    throw new Error(`rate-limit counter ${key} is malformed`);
  }
  return {
    count: value.count,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt || value.createdAt
  };
}

function loadCounters(filePath) {
  if (!fs.existsSync(filePath)) return null;
  if (fs.statSync(filePath).size > RATE_LIMIT_FILE_LIMIT) throw new Error('rate-limit file exceeds 4 MiB');
  const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!file || file.kind !== RATE_LIMIT_KIND || file.version !== 1 ||
      !file.counters || typeof file.counters !== 'object' || Array.isArray(file.counters)) {
    throw new Error('wrong rate-limit file kind or version');
  }
  return file.counters;
}

// BETA-1: per-address POST counters live in memory and in their own file, so
// an unauthenticated request never takes the state lock or rewrites the beta
// state file. Counters reach disk at most once per flush interval and when the
// server closes; a crash loses at most one interval of counts. One service
// process owns the file.
class RateLimiter {
  constructor({ filePath, maxEntries, flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS, legacyCounters = {} }) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 2) throw new Error('rate-limit table needs at least 2 entries');
    this.filePath = path.resolve(filePath);
    this.maxEntries = maxEntries;
    this.flushIntervalMs = flushIntervalMs;
    this.counters = new Map();
    this.timer = null;
    this.dirty = false;
    const loaded = loadCounters(this.filePath);
    // Counters from a state file written before the split carry over once.
    const initial = loaded || legacyCounters;
    const entries = Object.entries(initial)
      .map(([key, value]) => [key, normalizeCounter(key, value)])
      .sort((left, right) => (left[1].updatedAt < right[1].updatedAt ? -1 : left[1].updatedAt > right[1].updatedAt ? 1 : 0));
    // Map order is least recently updated first.
    for (const [key, counter] of entries) this.counters.set(key, counter);
    if (!loaded && this.counters.size > 0) this.flush();
  }

  get size() {
    return this.counters.size;
  }

  // Counts one request against every window, or returns false without
  // counting if any window is already at its limit.
  hit(windows, now) {
    for (const window of windows) {
      const current = this.counters.get(window.key);
      if (current && current.count >= window.limit) return false;
    }
    for (const window of windows) {
      const current = this.counters.get(window.key) || { count: 0, createdAt: now, expiresAt: window.expiresAt };
      this.counters.delete(window.key);
      this.counters.set(window.key, { ...current, count: current.count + 1, updatedAt: now });
    }
    if (this.counters.size > this.maxEntries) this.evict(Date.parse(now), new Set(windows.map((window) => window.key)));
    this.scheduleFlush();
    return true;
  }

  // A full table evicts, it never refuses: expired counters first, then the
  // least recently updated, never the counters for the current request.
  evict(nowMs, keep) {
    for (const [key, counter] of this.counters) {
      if (Date.parse(counter.expiresAt) <= nowMs && !keep.has(key)) this.counters.delete(key);
    }
    for (const key of this.counters.keys()) {
      if (this.counters.size <= this.maxEntries) break;
      if (!keep.has(key)) this.counters.delete(key);
    }
  }

  scheduleFlush() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
      } catch (err) {
        console.error(`rate-limit flush failed: ${err.message}`);
      }
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  flush() {
    const counters = Object.fromEntries(this.counters);
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ kind: RATE_LIMIT_KIND, version: 1, counters })}\n`,
      { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch (_err) { /* Best effort on Windows. */ }
    this.dirty = false;
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dirty) this.flush();
  }
}

module.exports = { RATE_LIMIT_KIND, rateLimitPathFor, RateLimiter };
