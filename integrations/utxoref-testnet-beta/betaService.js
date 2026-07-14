const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { Worker } = require('worker_threads');
const { readJsonStrictProfile } = require('../../bitvm3/utxo_referee/strict_artifact_profiles');
const { inspectArtifact } = require('../../bitvm3/utxo_referee/utxoref_v2_watchtower');
const { sha256, tokenHash, privateHash } = require('./betaStore');

const EXPLORER_TX = 'https://mempool.space/testnet4/tx/';
const BODY_LIMIT = 16 * 1024;
const COUNTED_CLAIM_STATES = new Set(['sending', 'broadcast', 'broadcast_unknown']);

class HttpError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function utcDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function safeInteger(value, minimum, maximum, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, 'invalid_request', `${fieldName} must be an integer in ${minimum}..${maximum}`);
  }
  return parsed;
}

function claimCounts(state, now, policy) {
  const today = utcDay(now);
  const counted = Object.values(state.claims).filter((claim) => COUNTED_CLAIM_STATES.has(claim.status));
  const todayClaims = counted.filter((claim) => utcDay(claim.createdAt) === today);
  const dailyIssuedSats = todayClaims.reduce((sum, claim) => sum + BigInt(claim.amountSats), 0n);
  return {
    totalClaims: counted.length,
    todayClaims: todayClaims.length,
    dailyIssuedSats,
    dailyRemainingSats: BigInt(policy.dailyBudgetSats) > dailyIssuedSats
      ? BigInt(policy.dailyBudgetSats) - dailyIssuedSats
      : 0n
  };
}

function publicClaim(claim) {
  return {
    claimId: claim.claimId,
    status: claim.status,
    amountSats: claim.amountSats,
    address: claim.address,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    txid: claim.txid || null,
    explorer: claim.txid ? `${EXPLORER_TX}${claim.txid}` : null,
    errorCode: claim.errorCode || null
  };
}

function publicStressRun(run) {
  return {
    runId: run.runId,
    status: run.status,
    iterations: run.iterations,
    passed: run.passed,
    failed: run.failed,
    elapsedMs: run.elapsedMs,
    verificationsPerSecond: run.verificationsPerSecond,
    graphHash: run.graphHash,
    resultDigest: run.resultDigest,
    errorCode: run.errorCode || null,
    createdAt: run.createdAt
  };
}

function executeStressWorker(workerPath, workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData });
    let settled = false;
    worker.once('message', (message) => {
      settled = true;
      if (message?.ok) resolve(message.result);
      else reject(new Error(message?.error || 'stress worker failed'));
    });
    worker.once('error', (err) => { settled = true; reject(err); });
    worker.once('exit', (code) => {
      if (!settled && code !== 0) reject(new Error(`stress worker exited with code ${code}`));
      else if (!settled) reject(new Error('stress worker exited without a result'));
    });
  });
}

function loadGraph(policy) {
  const artifact = readJsonStrictProfile(policy.artifactPath, 'utxoref-v2-public-artifact', 'beta public artifact');
  const trustPolicy = readJsonStrictProfile(policy.trustPolicyPath, 'utxoref-v2-trust-policy', 'beta trust policy');
  const inspection = inspectArtifact(artifact, trustPolicy);
  return { artifact, trustPolicy, inspection };
}

function requestIp(req, policy) {
  if (policy.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        reject(new HttpError(413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (bytes === 0) return resolve({});
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body must be an object');
        resolve(value);
      } catch (err) {
        reject(new HttpError(400, 'invalid_json', err.message));
      }
    });
    req.on('error', reject);
  });
}

function responseHeaders(policy, contentType) {
  const headers = {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()'
  };
  if (policy.publicOrigin) headers['access-control-allow-origin'] = policy.publicOrigin;
  return headers;
}

function sendJson(res, status, payload, policy) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    ...responseHeaders(policy, 'application/json; charset=utf-8'),
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function invitationForToken(state, token, now) {
  if (!/^ubeta_[A-Za-z0-9_-]{30,80}$/.test(String(token || ''))) {
    throw new HttpError(401, 'invalid_invite', 'invite token is invalid');
  }
  const hash = tokenHash(token);
  const invitation = state.invitations[hash];
  if (!invitation || invitation.disabled) throw new HttpError(401, 'invalid_invite', 'invite token is invalid');
  if (invitation.expiresAt && Date.parse(invitation.expiresAt) <= new Date(now).getTime()) {
    throw new HttpError(401, 'invite_expired');
  }
  return { hash, invitation };
}

function assertNodeReady(node, policy) {
  if (node.chain !== policy.chain) throw new HttpError(503, 'wrong_chain');
  if (node.initialBlockDownload) throw new HttpError(503, 'node_syncing');
  if (node.headers - node.blocks > policy.maxChainLagBlocks) throw new HttpError(503, 'node_lagging');
}

function createBetaService(options) {
  const { policy, store, bitcoin } = options;
  const clock = options.clock || (() => new Date());
  const publicDir = options.publicDir || path.join(__dirname, 'public');
  const stressWorkerPath = options.stressWorkerPath || path.join(__dirname, 'stressWorker.js');
  const postWindows = new Map();
  let graphCache = null;
  let statusCache = null;
  let statusInFlight = null;
  let activeStressRuns = 0;

  function currentGraph() {
    const artifactStat = fs.statSync(policy.artifactPath);
    const trustStat = fs.statSync(policy.trustPolicyPath);
    const cacheKey = [
      policy.artifactPath, artifactStat.size, artifactStat.mtimeMs,
      policy.trustPolicyPath, trustStat.size, trustStat.mtimeMs
    ].join(':');
    if (!graphCache || graphCache.key !== cacheKey) {
      graphCache = { key: cacheKey, value: loadGraph(policy) };
    }
    return graphCache.value;
  }

  function postRateLimit(ip, now) {
    const minute = Math.floor(new Date(now).getTime() / 60000);
    const key = `${ip}:${minute}`;
    const count = (postWindows.get(key) || 0) + 1;
    postWindows.set(key, count);
    if (postWindows.size > 2048) {
      for (const oldKey of postWindows.keys()) {
        if (!oldKey.endsWith(`:${minute}`)) postWindows.delete(oldKey);
      }
    }
    if (count > policy.postRequestsPerMinute) throw new HttpError(429, 'rate_limited');
  }

  async function buildBetaStatus() {
    const now = clock().toISOString();
    const [node, graph] = await Promise.all([bitcoin.status(), Promise.resolve().then(currentGraph)]);
    const state = store.read();
    const counts = claimCounts(state, now, policy);
    const outpoint = graph.artifact.graph.assertionOutpoint;
    const assertion = await bitcoin.getTxout(outpoint.txid, outpoint.vout);
    const trusted = BigInt(node.walletTrustedSats);
    const available = trusted > BigInt(policy.walletReserveFloorSats)
      ? trusted - BigInt(policy.walletReserveFloorSats)
      : 0n;
    const graphVerified = graph.inspection.verification?.ok === true;
    return {
      kind: 'utxoref_testnet_beta_status',
      checkedAt: now,
      service: { name: policy.serviceName, mode: 'invite-only-testnet-beta' },
      chain: {
        network: node.chain,
        blocks: node.blocks,
        headers: node.headers,
        lagBlocks: node.headers - node.blocks,
        initialBlockDownload: node.initialBlockDownload,
        verificationProgress: node.verificationProgress,
        pruned: node.pruned
      },
      graph: {
        graphHash: graph.inspection.graphHash,
        verified: graphVerified,
        artifactStatus: graph.artifact.status || null,
        assertionOutpoint: `${outpoint.txid}:${outpoint.vout}`,
        assertionUnspent: Boolean(assertion),
        assertionConfirmations: Number(assertion?.confirmations || 0),
        explorer: `${EXPLORER_TX}${outpoint.txid}`
      },
      faucet: {
        enabled: node.chain === policy.chain && !node.initialBlockDownload,
        amountSats: String(policy.faucetAmountSats),
        walletAvailableAboveReserveSats: available.toString(),
        reserveFloorSats: String(policy.walletReserveFloorSats),
        dailyBudgetSats: String(policy.dailyBudgetSats),
        dailyIssuedSats: counts.dailyIssuedSats.toString(),
        dailyRemainingSats: counts.dailyRemainingSats.toString(),
        todayClaims: counts.todayClaims,
        totalClaims: counts.totalClaims
      },
      stress: {
        maxIterationsPerRun: policy.maxStressIterations,
        completedRuns: Object.values(state.stressRuns).filter((run) => run.status === 'complete').length
      },
      betaReady: graphVerified && node.chain === policy.chain && !node.initialBlockDownload &&
        node.headers - node.blocks <= policy.maxChainLagBlocks && available >= BigInt(policy.faucetAmountSats + policy.feeBufferSats)
    };
  }

  async function betaStatus() {
    const nowMs = clock().getTime();
    if (statusCache && nowMs < statusCache.expiresAt) return statusCache.value;
    if (statusInFlight) return statusInFlight;
    statusInFlight = buildBetaStatus().then((value) => {
      statusCache = { value, expiresAt: clock().getTime() + policy.statusCacheMs };
      return value;
    }).finally(() => { statusInFlight = null; });
    return statusInFlight;
  }

  async function claimFaucet(body, req) {
    const now = clock().toISOString();
    const ip = requestIp(req, policy);
    const idempotencyKey = String(req.headers['idempotency-key'] || body.idempotencyKey || '');
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
      throw new HttpError(400, 'idempotency_key_required', 'idempotency-key must be 16..128 safe characters');
    }
    invitationForToken(store.read(), body.inviteToken, now);
    let destination;
    try {
      destination = await bitcoin.validateDestination(body.address);
    } catch (err) {
      throw new HttpError(400, 'invalid_destination', err.message);
    }
    const node = await bitcoin.status();
    assertNodeReady(node, policy);

    const reservation = await store.transact((state) => {
      const { hash: inviteHash, invitation } = invitationForToken(state, body.inviteToken, now);
      const addressHash = privateHash(state, 'address', destination.address);
      const ipHash = privateHash(state, 'ip', ip);
      const claimId = sha256(`${inviteHash}:${addressHash}:${idempotencyKey}`).slice(0, 24);
      if (state.claims[claimId]) {
        return { shouldBroadcast: false, claim: publicClaim(state.claims[claimId]) };
      }
      if (invitation.claimIds.length >= invitation.maxClaims) throw new HttpError(409, 'invite_exhausted');

      const counted = Object.values(state.claims).filter((claim) => COUNTED_CLAIM_STATES.has(claim.status));
      const today = utcDay(now);
      const ipToday = counted.filter((claim) => claim.ipHash === ipHash && utcDay(claim.createdAt) === today).length;
      const addressTotal = counted.filter((claim) => claim.addressHash === addressHash).length;
      if (ipToday >= policy.ipClaimsPerDay) throw new HttpError(429, 'ip_daily_limit');
      if (addressTotal >= policy.addressClaimsTotal) throw new HttpError(409, 'address_limit');
      const counts = claimCounts(state, now, policy);
      if (counts.dailyRemainingSats < BigInt(policy.faucetAmountSats)) throw new HttpError(503, 'daily_budget_exhausted');
      if (BigInt(node.walletTrustedSats) < BigInt(policy.walletReserveFloorSats + policy.faucetAmountSats + policy.feeBufferSats)) {
        throw new HttpError(503, 'faucet_reserve_floor');
      }

      const claim = {
        claimId,
        inviteId: invitation.inviteId,
        inviteHash,
        address: destination.address,
        addressHash,
        ipHash,
        idempotencyHash: sha256(idempotencyKey),
        amountSats: String(policy.faucetAmountSats),
        status: 'sending',
        createdAt: now,
        updatedAt: now,
        txid: null,
        errorCode: null
      };
      state.claims[claimId] = claim;
      invitation.claimIds.push(claimId);
      return { shouldBroadcast: true, claimId, address: destination.address };
    });

    if (!reservation.shouldBroadcast) return reservation.claim;
    let txid;
    try {
      txid = await bitcoin.sendFaucet(reservation.address, policy.faucetAmountSats, reservation.claimId);
    } catch (_err) {
      await store.transact((state) => {
        const claim = state.claims[reservation.claimId];
        if (claim && claim.status === 'sending') {
          claim.status = 'broadcast_unknown';
          claim.errorCode = 'bitcoin_rpc_result_unknown';
          claim.updatedAt = clock().toISOString();
        }
      });
      throw new HttpError(
        502,
        'bitcoin_rpc_result_unknown',
        `claim ${reservation.claimId} requires operator reconciliation`
      );
    }
    return store.transact((state) => {
      const claim = state.claims[reservation.claimId];
      if (!claim) throw new Error('reserved claim disappeared');
      claim.txid = txid;
      claim.status = 'broadcast';
      claim.errorCode = null;
      claim.updatedAt = clock().toISOString();
      return publicClaim(claim);
    });
  }

  async function runStress(body) {
    const now = clock().toISOString();
    const state = store.read();
    const { invitation } = invitationForToken(state, body.inviteToken, now);
    const iterations = safeInteger(body.iterations || 25, 1, policy.maxStressIterations, 'iterations');
    if (activeStressRuns >= policy.maxConcurrentStressRuns) throw new HttpError(503, 'stress_capacity_reached');
    activeStressRuns += 1;
    let runId;
    try {
      const graph = currentGraph();
      const reserved = await store.transact((nextState) => {
        const { invitation: currentInvitation } = invitationForToken(nextState, body.inviteToken, now);
        const priorRuns = Object.values(nextState.stressRuns)
          .filter((run) => run.inviteId === currentInvitation.inviteId).length;
        const runLimit = currentInvitation.maxStressRuns || policy.maxStressRunsPerInvite;
        if (priorRuns >= runLimit) throw new HttpError(429, 'invite_stress_limit');
        const id = sha256(`${currentInvitation.inviteId}:${now}:${iterations}:${priorRuns}`).slice(0, 24);
        nextState.stressRuns[id] = {
          runId: id,
          inviteId: currentInvitation.inviteId,
          status: 'running',
          iterations,
          passed: 0,
          failed: 0,
          elapsedMs: null,
          verificationsPerSecond: null,
          graphHash: graph.inspection.graphHash,
          resultDigest: null,
          errorCode: null,
          createdAt: now
        };
        return id;
      });
      runId = reserved;
      const result = await executeStressWorker(stressWorkerPath, {
        artifactPath: policy.artifactPath,
        trustPolicyPath: policy.trustPolicyPath,
        iterations
      });
      if (result.graphHash !== graph.inspection.graphHash) {
        throw new Error('stress worker graph hash does not match reserved graph');
      }
      return store.transact((nextState) => {
        const run = nextState.stressRuns[runId];
        Object.assign(run, result, { status: 'complete', errorCode: null });
        return publicStressRun(run);
      });
    } catch (err) {
      if (runId) {
        await store.transact((nextState) => {
          const run = nextState.stressRuns[runId];
          if (run) {
            run.status = 'failed';
            run.errorCode = 'verification_worker_failed';
          }
        });
      }
      throw err;
    } finally {
      activeStressRuns -= 1;
    }
  }

  async function handler(req, res) {
    try {
      const parsed = new URL(req.url, 'http://beta.local');
      const now = clock().toISOString();
      if (req.method === 'POST') postRateLimit(requestIp(req, policy), now);

      if (req.method === 'OPTIONS' && policy.publicOrigin) {
        res.writeHead(204, {
          ...responseHeaders(policy, 'text/plain'),
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, idempotency-key'
        });
        return res.end();
      }
      if (req.method === 'GET' && parsed.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, service: policy.serviceName }, policy);
      }
      if (req.method === 'GET' && parsed.pathname === '/v1/beta/status') {
        return sendJson(res, 200, await betaStatus(), policy);
      }
      if (req.method === 'POST' && parsed.pathname === '/v1/faucet/claim') {
        return sendJson(res, 201, await claimFaucet(await readBody(req), req), policy);
      }
      if (req.method === 'POST' && parsed.pathname === '/v1/stress/verify') {
        return sendJson(res, 201, await runStress(await readBody(req)), policy);
      }
      const runMatch = parsed.pathname.match(/^\/v1\/runs\/([0-9a-f]{24})$/);
      if (req.method === 'GET' && runMatch) {
        const run = store.read().stressRuns[runMatch[1]];
        if (!run) throw new HttpError(404, 'run_not_found');
        return sendJson(res, 200, publicStressRun(run), policy);
      }

      const staticFiles = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
        '/styles.css': ['styles.css', 'text/css; charset=utf-8']
      };
      if (req.method === 'GET' && staticFiles[parsed.pathname]) {
        const [name, contentType] = staticFiles[parsed.pathname];
        const body = fs.readFileSync(path.join(publicDir, name));
        res.writeHead(200, { ...responseHeaders(policy, contentType), 'content-length': body.length });
        return res.end(body);
      }
      throw new HttpError(404, 'not_found');
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : 'internal_error';
      return sendJson(res, status, { ok: false, error: code, message: status < 500 ? err.message : 'internal server error' }, policy);
    }
  }

  return {
    handler,
    betaStatus,
    claimFaucet,
    runStress,
    createServer: () => http.createServer(handler)
  };
}

module.exports = {
  EXPLORER_TX,
  HttpError,
  utcDay,
  claimCounts,
  publicClaim,
  publicStressRun,
  executeStressWorker,
  loadGraph,
  requestIp,
  invitationForToken,
  assertNodeReady,
  createBetaService
};
