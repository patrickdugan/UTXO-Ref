const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { URL } = require('url');
const { Worker } = require('worker_threads');
const { readJsonStrictProfile } = require('../../bitvm3/utxo_referee/strict_artifact_profiles');
const { inspectArtifact } = require('../../bitvm3/utxo_referee/utxoref_v2_watchtower');
const { stableStringify } = require('../../bitvm3/utxo_referee/tradelayer_pnl_route_adapter');
const { verifyGuardianQuorumVaultManifest } = require('../../bitvm3/utxo_referee/utxoref_v2_guardian_quorum_reserve');
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

function loadGuardianRegistry(filePath, expectedGraphHash) {
  const registry = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!registry || registry.kind !== 'utxoref_beta_guardian_registry' || registry.version !== 1) {
    throw new Error('guardian registry has the wrong kind or version');
  }
  if (registry.graphHash !== expectedGraphHash || !/^[0-9a-f]{64}$/.test(registry.graphHash)) {
    throw new Error('guardian registry graph hash is not pinned to the beta graph');
  }
  if (!Array.isArray(registry.guardians) || registry.guardians.length < 2 || registry.guardians.length > 15) {
    throw new Error('guardian registry must contain 2..15 guardians');
  }
  if (!Number.isSafeInteger(registry.quorum) || registry.quorum < 2 || registry.quorum > registry.guardians.length) {
    throw new Error('guardian registry quorum is invalid');
  }
  const ids = new Set();
  const xonlys = new Set();
  for (const guardian of registry.guardians) {
    if (!/^[0-9a-f]{24}$/.test(String(guardian.guardianId || ''))) throw new Error('guardian id is invalid');
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(String(guardian.label || ''))) throw new Error('guardian label is invalid');
    if (!/^[0-9a-f]{64}$/.test(String(guardian.guardianXonly || ''))) throw new Error('guardian x-only key is invalid');
    const publicKey = crypto.createPublicKey(guardian.heartbeatPublicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('guardian heartbeat key must be Ed25519');
    if (ids.has(guardian.guardianId) || xonlys.has(guardian.guardianXonly)) throw new Error('guardian identities and custody keys must be unique');
    ids.add(guardian.guardianId);
    xonlys.add(guardian.guardianXonly);
  }
  return registry;
}

function guardianStatus(registry, state, now, maxAgeSeconds, clockSkewSeconds = 0) {
  if (!registry) return { configured: 0, quorum: 0, fresh: 0, quorumHealthy: null, guardians: [] };
  const nowMs = new Date(now).getTime();
  const guardians = registry.guardians.map((guardian) => {
    const heartbeat = state.guardianHeartbeats[guardian.guardianId] || null;
    const observedMs = heartbeat ? Date.parse(heartbeat.core.observedAt) : 0;
    const ageSeconds = heartbeat ? Math.max(0, Math.floor((nowMs - observedMs) / 1000)) : null;
    const fresh = Boolean(
      heartbeat &&
      observedMs <= nowMs + clockSkewSeconds * 1000 &&
      nowMs - observedMs <= maxAgeSeconds * 1000
    );
    return {
      guardianId: guardian.guardianId,
      label: guardian.label,
      guardianXonly: guardian.guardianXonly,
      fresh,
      ageSeconds,
      sequence: heartbeat?.core.sequence || null,
      blockHeight: heartbeat?.core.blockHeight || null,
      heartbeatHash: heartbeat?.heartbeatHash || null,
      observedAt: heartbeat?.core.observedAt || null
    };
  });
  const fresh = guardians.filter((guardian) => guardian.fresh).length;
  return {
    configured: guardians.length,
    quorum: registry.quorum,
    fresh,
    quorumHealthy: fresh >= registry.quorum,
    guardians
  };
}

function loadGuardianReserve(filePath, registry) {
  const deployment = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!deployment || deployment.kind !== 'utxoref_beta_guardian_quorum_reserve_deployment' ||
      deployment.version !== 1 || deployment.broadcast !== true || !deployment.manifest?.core) {
    throw new Error('guardian reserve deployment has the wrong kind, version, or state');
  }
  const core = deployment.manifest.core;
  if (deployment.graphHash !== registry.graphHash || core.bindingHash !== registry.graphHash) {
    throw new Error('guardian reserve is not bound to the registry graph');
  }
  if (deployment.guardianThreshold !== registry.quorum || core.guardianThreshold !== registry.quorum ||
      stableStringify(core.guardianXonlys) !== stableStringify(registry.guardians.map((guardian) => guardian.guardianXonly))) {
    throw new Error('guardian reserve does not match the registry quorum');
  }
  return deployment;
}

function guardianReserveStatus(deployment, txout, currentHeight) {
  if (!deployment) return { configured: false, healthy: null };
  const manifest = deployment.manifest;
  const verification = verifyGuardianQuorumVaultManifest(manifest, { currentHeight });
  const expectedAmount = BigInt(manifest.core.amountSats);
  const observedAmount = txout ? BigInt(Math.round(Number(txout.value) * 100000000)) : null;
  const scriptMatches = Boolean(txout && txout.scriptPubKey?.hex === manifest.core.p2trScriptPubKey);
  const amountMatches = observedAmount === expectedAmount;
  const confirmations = Number(txout?.confirmations || 0);
  const confirmed = confirmations >= 1;
  const fundingHeight = confirmed ? currentHeight - confirmations + 1 : null;
  const fundingHeightMatches = confirmed && manifest.core.observedAtHeight === fundingHeight;
  return {
    configured: true,
    healthy: verification.ok && verification.countable && scriptMatches && amountMatches && fundingHeightMatches,
    outpoint: `${manifest.core.fundingOutpoint.txid}:${manifest.core.fundingOutpoint.vout}`,
    amountSats: manifest.core.amountSats,
    confirmations,
    fundingHeight,
    fundingHeightMatches,
    unspent: Boolean(txout),
    scriptMatches,
    amountMatches,
    manifestVerified: verification.ok,
    recoveryCountable: verification.countable,
    guardianThreshold: manifest.core.guardianThreshold,
    guardianCount: manifest.core.guardianXonlys.length,
    guardianSetHash: manifest.core.guardianSetHash,
    explorer: `${EXPLORER_TX}${manifest.core.fundingOutpoint.txid}`
  };
}

function requestIp(req, policy) {
  if (policy.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (net.isIP(forwarded)) return forwarded;
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
  const pinnedGraph = currentGraphForRegistry();
  const guardianRegistry = policy.guardianRegistryPath
    ? loadGuardianRegistry(policy.guardianRegistryPath, pinnedGraph.inspection.graphHash)
    : null;
  if (policy.guardianReservePath && !guardianRegistry) {
    throw new Error('guardian reserve requires a guardian registry');
  }
  const guardianReserve = policy.guardianReservePath
    ? loadGuardianReserve(policy.guardianReservePath, guardianRegistry)
    : null;
  if (policy.requireGuardianQuorum && (!guardianRegistry || !guardianReserve)) {
    throw new Error('required guardian quorum must have a registry and funded reserve');
  }
  let graphCache = null;
  let statusCache = null;
  let statusInFlight = null;
  let activeStressRuns = 0;

  function currentGraphForRegistry() {
    return loadGraph(policy);
  }

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

  async function postRateLimit(ip, now) {
    const nowMs = new Date(now).getTime();
    await store.transact((state) => {
      const ipHash = privateHash(state, 'rate-ip', ip);
      const windows = [
        {
          key: `${ipHash}:minute:${Math.floor(nowMs / 60000)}`,
          limit: policy.postRequestsPerMinute,
          expiresAt: new Date((Math.floor(nowMs / 60000) + 2) * 60000).toISOString()
        },
        {
          key: `${ipHash}:hour:${Math.floor(nowMs / 3600000)}`,
          limit: policy.postRequestsPerHour,
          expiresAt: new Date((Math.floor(nowMs / 3600000) + 2) * 3600000).toISOString()
        }
      ];
      for (const window of windows) {
        const current = state.rateLimits[window.key];
        if (current && current.count >= window.limit) throw new HttpError(429, 'rate_limited');
      }
      for (const window of windows) {
        const current = state.rateLimits[window.key] || {
          count: 0,
          createdAt: now,
          expiresAt: window.expiresAt
        };
        current.count += 1;
        current.updatedAt = now;
        state.rateLimits[window.key] = current;
      }
      const keys = Object.keys(state.rateLimits);
      if (keys.length > 4096) {
        for (const key of keys) {
          if (Date.parse(state.rateLimits[key].expiresAt) <= nowMs) delete state.rateLimits[key];
        }
      }
      if (Object.keys(state.rateLimits).length > 8192) throw new HttpError(503, 'rate_limit_capacity');
    });
  }

  async function buildBetaStatus() {
    const now = clock().toISOString();
    const [node, graph] = await Promise.all([bitcoin.status(), Promise.resolve().then(currentGraph)]);
    const state = store.read();
    const counts = claimCounts(state, now, policy);
    const guardians = guardianStatus(
      guardianRegistry,
      state,
      now,
      policy.guardianHeartbeatMaxAgeSeconds,
      policy.guardianClockSkewSeconds
    );
    const outpoint = graph.artifact.graph.assertionOutpoint;
    const reserveOutpoint = guardianReserve?.manifest.core.fundingOutpoint;
    const [assertion, reserveTxout] = await Promise.all([
      bitcoin.getTxout(outpoint.txid, outpoint.vout),
      reserveOutpoint ? bitcoin.getTxout(reserveOutpoint.txid, reserveOutpoint.vout) : Promise.resolve(null)
    ]);
    const reserve = guardianReserveStatus(guardianReserve, reserveTxout, node.blocks);
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
      guardians,
      guardianReserve: reserve,
      betaReady: graphVerified && node.chain === policy.chain && !node.initialBlockDownload &&
        node.headers - node.blocks <= policy.maxChainLagBlocks &&
        available >= BigInt(policy.faucetAmountSats + policy.feeBufferSats) &&
        (!policy.requireGuardianQuorum || (guardians.quorumHealthy === true && reserve.healthy === true))
    };
  }

  async function acceptGuardianHeartbeat(body) {
    if (!guardianRegistry) throw new HttpError(404, 'guardians_not_configured');
    if (!body || body.kind !== 'utxoref_beta_guardian_heartbeat' || body.version !== 1 || !body.core) {
      throw new HttpError(400, 'invalid_guardian_heartbeat');
    }
    const core = body.core;
    if (core.kind !== 'utxoref_beta_guardian_heartbeat_v1' || core.version !== 1) {
      throw new HttpError(400, 'invalid_guardian_heartbeat');
    }
    const guardian = guardianRegistry.guardians.find((entry) => entry.guardianId === core.guardianId);
    if (!guardian) throw new HttpError(401, 'unknown_guardian');
    if (core.label !== guardian.label || core.guardianXonly !== guardian.guardianXonly) {
      throw new HttpError(401, 'guardian_identity_mismatch');
    }
    if (core.graphHash !== guardianRegistry.graphHash || core.chain !== 'testnet4') {
      throw new HttpError(409, 'guardian_observation_mismatch');
    }
    for (const field of ['sequence', 'blockHeight', 'headerHeight', 'chainLagBlocks']) {
      safeInteger(core[field], 0, Number.MAX_SAFE_INTEGER, field);
    }
    if (core.sequence < 1 || core.headerHeight < core.blockHeight || core.chainLagBlocks !== core.headerHeight - core.blockHeight) {
      throw new HttpError(400, 'invalid_guardian_observation');
    }
    const now = clock().toISOString();
    const observedMs = Date.parse(core.observedAt);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(observedMs) || observedMs > nowMs + policy.guardianClockSkewSeconds * 1000 ||
        nowMs - observedMs > policy.guardianHeartbeatMaxAgeSeconds * 1000) {
      throw new HttpError(409, 'stale_guardian_heartbeat');
    }
    if (!/^[A-Za-z0-9+/]{86}==$/.test(String(body.signature || ''))) {
      throw new HttpError(400, 'invalid_guardian_signature');
    }
    const message = Buffer.from(stableStringify(core));
    const signature = Buffer.from(body.signature, 'base64');
    if (!crypto.verify(null, message, guardian.heartbeatPublicKeyPem, signature)) {
      throw new HttpError(401, 'invalid_guardian_signature');
    }
    const heartbeatHash = sha256(message);
    const receipt = await store.transact((state) => {
      const prior = state.guardianHeartbeats[core.guardianId];
      if (prior && core.sequence < prior.core.sequence) throw new HttpError(409, 'guardian_sequence_regression');
      if (prior && core.sequence === prior.core.sequence) {
        if (prior.heartbeatHash !== heartbeatHash) throw new HttpError(409, 'guardian_equivocation');
        return { accepted: true, duplicate: true, heartbeatHash, acceptedAt: prior.acceptedAt };
      }
      state.guardianHeartbeats[core.guardianId] = {
        core,
        signature: body.signature,
        heartbeatHash,
        acceptedAt: now
      };
      return { accepted: true, duplicate: false, heartbeatHash, acceptedAt: now };
    });
    statusCache = null;
    return {
      kind: 'utxoref_beta_guardian_heartbeat_receipt',
      version: 1,
      guardianId: core.guardianId,
      sequence: core.sequence,
      ...receipt
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
      if (policy.basePath && parsed.pathname === policy.basePath) {
        res.writeHead(308, { location: `${policy.basePath}/`, ...responseHeaders(policy, 'text/plain') });
        return res.end();
      }
      if (policy.basePath && !parsed.pathname.startsWith(`${policy.basePath}/`)) {
        throw new HttpError(404, 'not_found');
      }
      const routePath = policy.basePath ? parsed.pathname.slice(policy.basePath.length) : parsed.pathname;
      const now = clock().toISOString();
      if (req.method === 'POST') await postRateLimit(requestIp(req, policy), now);

      if (req.method === 'OPTIONS' && policy.publicOrigin) {
        res.writeHead(204, {
          ...responseHeaders(policy, 'text/plain'),
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, idempotency-key'
        });
        return res.end();
      }
      if (req.method === 'GET' && routePath === '/healthz') {
        return sendJson(res, 200, { ok: true, service: policy.serviceName }, policy);
      }
      if (req.method === 'GET' && routePath === '/v1/beta/status') {
        return sendJson(res, 200, await betaStatus(), policy);
      }
      if (req.method === 'POST' && routePath === '/v1/faucet/claim') {
        return sendJson(res, 201, await claimFaucet(await readBody(req), req), policy);
      }
      if (req.method === 'POST' && routePath === '/v1/stress/verify') {
        return sendJson(res, 201, await runStress(await readBody(req)), policy);
      }
      if (req.method === 'POST' && routePath === '/v1/guardians/heartbeat') {
        return sendJson(res, 201, await acceptGuardianHeartbeat(await readBody(req)), policy);
      }
      const runMatch = routePath.match(/^\/v1\/runs\/([0-9a-f]{24})$/);
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
      if (req.method === 'GET' && staticFiles[routePath]) {
        const [name, contentType] = staticFiles[routePath];
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
    acceptGuardianHeartbeat,
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
  loadGuardianRegistry,
  guardianStatus,
  loadGuardianReserve,
  guardianReserveStatus,
  requestIp,
  invitationForToken,
  assertNodeReady,
  createBetaService
};
