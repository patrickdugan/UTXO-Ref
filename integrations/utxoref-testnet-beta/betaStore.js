const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function initialState() {
  return {
    kind: 'utxoref_testnet_beta_state',
    version: 1,
    createdAt: new Date().toISOString(),
    privacySalt: crypto.randomBytes(32).toString('hex'),
    invitations: {},
    claims: {},
    stressRuns: {},
    rateLimits: {},
    guardianHeartbeats: {}
  };
}

function validateState(state) {
  if (!state || state.kind !== 'utxoref_testnet_beta_state' || state.version !== 1) {
    throw new Error('wrong beta state kind or version');
  }
  for (const field of ['invitations', 'claims', 'stressRuns', 'rateLimits', 'guardianHeartbeats']) {
    if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) {
      throw new Error(`beta state ${field} must be an object`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(String(state.privacySalt || ''))) {
    throw new Error('beta state privacy salt is invalid');
  }
  return state;
}

function saveAtomic(filePath, state) {
  validateState(state);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_err) { /* Best effort on Windows. */ }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(filePath, options = {}) {
  const lockPath = `${filePath}.lock`;
  const timeoutMs = Number(options.timeoutMs || 5000);
  const staleMs = Number(options.staleMs || 30000);
  const startedAt = Date.now();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockPath); } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (ageMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error('timed out acquiring beta state lock');
      await sleep(25);
    }
  }
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    const state = initialState();
    saveAtomic(filePath, state);
    return state;
  }
  const stat = fs.statSync(filePath);
  if (stat.size > 8 * 1024 * 1024) throw new Error('beta state exceeds 8 MiB');
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (state?.kind === 'utxoref_testnet_beta_state' && state.version === 1) {
    if (state.rateLimits === undefined) state.rateLimits = {};
    if (state.guardianHeartbeats === undefined) state.guardianHeartbeats = {};
  }
  return validateState(state);
}

function tokenHash(token) {
  return sha256(`UTXOREF_BETA_INVITE_V1\0${String(token || '')}`);
}

function privateHash(state, namespace, value) {
  return sha256(`${namespace}\0${state.privacySalt}\0${String(value || '')}`);
}

function createInvitations(state, options = {}) {
  validateState(state);
  const count = Number(options.count || 1);
  const maxClaims = Number(options.maxClaims || 1);
  const maxStressRuns = Number(options.maxStressRuns || 10);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('invite count must be 1..100');
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 10) throw new Error('maxClaims must be 1..10');
  if (!Number.isSafeInteger(maxStressRuns) || maxStressRuns < 1 || maxStressRuns > 100) {
    throw new Error('maxStressRuns must be 1..100');
  }
  const createdAt = new Date().toISOString();
  const invitations = [];
  for (let index = 0; index < count; index++) {
    const token = `ubeta_${crypto.randomBytes(24).toString('base64url')}`;
    const hash = tokenHash(token);
    const invitation = {
      inviteId: sha256(`${hash}:${createdAt}`).slice(0, 24),
      label: String(options.label || 'beta-invite').slice(0, 80),
      createdAt,
      expiresAt: options.expiresAt || null,
      maxClaims,
      maxStressRuns,
      claimIds: [],
      disabled: false
    };
    state.invitations[hash] = invitation;
    invitations.push({ token, ...invitation });
  }
  return invitations;
}

class StateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.tail = Promise.resolve();
  }

  read() {
    return loadState(this.filePath);
  }

  transact(callback) {
    const operation = this.tail.then(async () => {
      const release = await acquireLock(this.filePath);
      try {
        const state = loadState(this.filePath);
        const result = await callback(state);
        saveAtomic(this.filePath, state);
        return result;
      } finally {
        release();
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}

module.exports = {
  sha256,
  initialState,
  validateState,
  saveAtomic,
  loadState,
  tokenHash,
  privateHash,
  createInvitations,
  acquireLock,
  StateStore
};
