/**
 * Quirk-indexed UTXORef route claims.
 *
 * This layer does not change the Taproot vault spend path. It binds Jurassic
 * quirk-isomorphism route candidates to live UTXORef reserve evidence before a
 * BitVM route/spend proposal can be treated as admissible application state.
 */

const {
  stableStringify,
  sha256Hex
} = require('./tradelayer_pnl_route_adapter');

const CLAIM_KIND = 'quirk_indexed_utxoref_route_claim_v1';
const CHALLENGE_KIND = 'quirk_indexed_utxoref_route_challenge_v1';
const CLAIM_WRAPPER_KIND = 'quirk_indexed_utxoref_route_claim';
const CHALLENGE_WRAPPER_KIND = 'quirk_indexed_utxoref_route_challenge';
const DEFAULT_NETWORK = 'bitcoin-testnet4';
const MOTIFS = new Set([
  'transcript_multiplicity',
  'identifier_bifurcation',
  'carrier_camouflage'
]);

function normalizeString(value, fieldName) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${fieldName} is required`);
  return text;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeHex(value, bytes, fieldName) {
  const text = normalizeString(value, fieldName).toLowerCase();
  const pattern = new RegExp(`^[0-9a-f]{${bytes * 2}}$`);
  if (!pattern.test(text)) throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  return text;
}

function normalizeOutpoint(value) {
  const text = normalizeString(value, 'reserveOutpoint');
  if (!/^[0-9a-f]{64}:\d+$/i.test(text)) {
    throw new Error('reserveOutpoint must be <txid>:<vout>');
  }
  const [txid, vout] = text.toLowerCase().split(':');
  return `${txid}:${Number(vout)}`;
}

function normalizeChallengeWindow(value = {}) {
  const startHeight = Number(value.startHeight ?? value.start ?? 0);
  const endHeight = Number(value.endHeight ?? value.end ?? 0);
  if (!Number.isInteger(startHeight) || startHeight < 0) {
    throw new Error('challengeWindow.startHeight must be a non-negative integer');
  }
  if (!Number.isInteger(endHeight) || endHeight <= startHeight) {
    throw new Error('challengeWindow.endHeight must be greater than startHeight');
  }
  return { startHeight, endHeight };
}

function normalizeMotif(value) {
  const motif = normalizeString(value, 'motif');
  if (!MOTIFS.has(motif)) throw new Error(`unsupported motif: ${motif}`);
  return motif;
}

function claimCore(input = {}) {
  const network = String(input.network || DEFAULT_NETWORK);
  const core = {
    kind: CLAIM_KIND,
    network,
    motif: normalizeMotif(input.motif),
    publicHandle: normalizeString(input.publicHandle, 'publicHandle'),
    semanticStateHash: normalizeHex(input.semanticStateHash, 32, 'semanticStateHash'),
    routeTranscriptHash: normalizeHex(input.routeTranscriptHash, 32, 'routeTranscriptHash'),
    withdrawalRootHex: normalizeHex(input.withdrawalRootHex, 32, 'withdrawalRootHex'),
    finalOutputVectorHash: normalizeHex(input.finalOutputVectorHash, 32, 'finalOutputVectorHash'),
    liveTraceHash: normalizeHex(input.liveTraceHash, 32, 'liveTraceHash'),
    reserveOutpoint: normalizeOutpoint(input.reserveOutpoint),
    challengeWindow: normalizeChallengeWindow(input.challengeWindow)
  };
  const commitmentHashHex = optionalString(input.commitmentHashHex);
  if (commitmentHashHex) core.commitmentHashHex = normalizeHex(commitmentHashHex, 32, 'commitmentHashHex');
  const namespace = optionalString(input.namespace);
  if (namespace) core.namespace = namespace;
  const transcriptAlias = optionalString(input.transcriptAlias);
  if (transcriptAlias) core.transcriptAlias = transcriptAlias;
  return core;
}

function buildQuirkIndexedRouteClaim(input = {}) {
  const core = claimCore(input);
  return {
    kind: CLAIM_WRAPPER_KIND,
    claimHash: sha256Hex(core),
    core
  };
}

function claimHashOk(claim) {
  if (!claim || claim.kind !== CLAIM_WRAPPER_KIND) {
    return { ok: false, reason: 'wrong claim kind' };
  }
  if (!claim.core || claim.core.kind !== CLAIM_KIND) {
    return { ok: false, reason: 'wrong claim core kind' };
  }
  const claimHash = sha256Hex(claim.core);
  if (claim.claimHash !== claimHash) {
    return { ok: false, reason: 'claim hash mismatch', claimHash };
  }
  return { ok: true, claimHash };
}

function importsByKind(liveImportBundle = {}) {
  const imports = Array.isArray(liveImportBundle.imports) ? liveImportBundle.imports : [];
  const grant = imports.find((item) => item.kind === 'btctest4_lnbtc_grant_import_v1') || null;
  const vault = imports.find((item) => item.kind === 'btctest4_utxoref_reserve_vault_import_v1') || null;
  return { grant, vault };
}

function routeCandidatesFromContext(context = {}) {
  const candidates = [];
  const quirkManifest = context.quirkManifest || {};
  for (const entry of quirkManifest.entries || []) {
    const hash = entry?.utxoref_binding?.route_transcript_candidate_hash;
    if (!hash) continue;
    candidates.push({
      routeTranscriptHash: String(hash),
      entryId: String(entry.entry_id || ''),
      motif: String(entry.motif || ''),
      surfaceId: String(entry.surface_id || '')
    });
  }

  const { vault } = importsByKind(context.liveImportBundle);
  for (const row of vault?.bindings?.routeTranscriptCandidates || []) {
    if (!row.routeTranscriptCandidateHash) continue;
    candidates.push({
      routeTranscriptHash: String(row.routeTranscriptCandidateHash),
      entryId: String(row.entryId || ''),
      motif: String(row.motif || ''),
      surfaceId: String(row.surfaceId || '')
    });
  }
  return candidates;
}

function findRouteCandidate(claim, context) {
  const wanted = claim.core.routeTranscriptHash;
  return routeCandidatesFromContext(context).find((row) => (
    row.routeTranscriptHash === wanted && (!row.motif || row.motif === claim.core.motif)
  )) || null;
}

function verifyQuirkIndexedRouteClaim(claim, context = {}) {
  const base = claimHashOk(claim);
  const checks = [];
  function add(name, ok, details = {}) {
    checks.push({ name, ok: !!ok, details });
  }
  if (!base.ok) {
    add('claim_hash', false, base);
    return {
      ok: false,
      admissible: false,
      reason: base.reason,
      failedChecks: checks.map((check) => check.name),
      checks
    };
  }
  add('claim_hash', true, { claimHash: base.claimHash });

  const { grant, vault } = importsByKind(context.liveImportBundle);
  const routeCandidate = findRouteCandidate(claim, context);
  add('route_transcript_candidate', !!routeCandidate, {
    routeTranscriptHash: claim.core.routeTranscriptHash,
    candidate: routeCandidate
  });

  const grantSemantic = grant?.bindings?.semanticStateHash || null;
  add('semantic_state', grantSemantic === claim.core.semanticStateHash, {
    expected: grantSemantic,
    actual: claim.core.semanticStateHash
  });

  const reserveStatus = vault?.bindings?.bindingStatus || null;
  add('live_reserve_status', reserveStatus === 'live_unspent_reserve_countable', {
    bindingStatus: reserveStatus
  });
  add('reserve_outpoint', vault?.chain_ref?.outpoint === claim.core.reserveOutpoint, {
    expected: vault?.chain_ref?.outpoint || null,
    actual: claim.core.reserveOutpoint
  });
  add('live_trace_hash', vault?.bindings?.liveTraceHash === claim.core.liveTraceHash, {
    expected: vault?.bindings?.liveTraceHash || null,
    actual: claim.core.liveTraceHash
  });
  add('withdrawal_root', vault?.bindings?.withdrawalRootHex === claim.core.withdrawalRootHex, {
    expected: vault?.bindings?.withdrawalRootHex || null,
    actual: claim.core.withdrawalRootHex
  });
  add('final_output_vector', vault?.bindings?.candidateFinalOutputVectorHash === claim.core.finalOutputVectorHash, {
    expected: vault?.bindings?.candidateFinalOutputVectorHash || null,
    actual: claim.core.finalOutputVectorHash
  });
  if (claim.core.commitmentHashHex) {
    add('commitment_hash', vault?.bindings?.commitmentHashHex === claim.core.commitmentHashHex, {
      expected: vault?.bindings?.commitmentHashHex || null,
      actual: claim.core.commitmentHashHex
    });
  }
  add('reserve_chain_checks', vault?.checks?.scriptMatchesManifest === true && vault?.checks?.valueMatchesManifest === true, {
    scriptMatchesManifest: vault?.checks?.scriptMatchesManifest === true,
    valueMatchesManifest: vault?.checks?.valueMatchesManifest === true
  });
  add('reserve_csv_countable', vault?.checks?.recoveryStatus?.countable === true, {
    recoveryStatus: vault?.checks?.recoveryStatus || null
  });

  const failedChecks = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: failedChecks.length === 0,
    admissible: failedChecks.length === 0,
    reason: failedChecks.length ? `failed checks: ${failedChecks.join(',')}` : null,
    claimHash: claim.claimHash,
    routeCandidate,
    failedChecks,
    checks
  };
}

function buildQuirkIndexedChallengeEvidence(claim, context = {}, violation = null) {
  const verification = verifyQuirkIndexedRouteClaim(claim, context);
  const violations = violation
    ? [String(violation)]
    : verification.failedChecks.slice();
  const core = {
    kind: CHALLENGE_KIND,
    claimHash: claim?.claimHash || null,
    reserveOutpoint: claim?.core?.reserveOutpoint || null,
    routeTranscriptHash: claim?.core?.routeTranscriptHash || null,
    violations,
    verificationHash: sha256Hex({
      checks: verification.checks,
      failedChecks: verification.failedChecks
    })
  };
  return {
    kind: CHALLENGE_WRAPPER_KIND,
    challengeHash: sha256Hex(core),
    challengeable: violations.length > 0,
    core,
    verification
  };
}

function summarizeQuirkIndexedRouteClaim(claim, verification = null) {
  return {
    claimHash: claim.claimHash,
    motif: claim.core.motif,
    publicHandle: claim.core.publicHandle,
    reserveOutpoint: claim.core.reserveOutpoint,
    routeTranscriptHash: claim.core.routeTranscriptHash,
    admissible: verification ? verification.admissible : null,
    failedChecks: verification ? verification.failedChecks : []
  };
}

module.exports = {
  CLAIM_KIND,
  CLAIM_WRAPPER_KIND,
  CHALLENGE_KIND,
  CHALLENGE_WRAPPER_KIND,
  buildQuirkIndexedRouteClaim,
  verifyQuirkIndexedRouteClaim,
  buildQuirkIndexedChallengeEvidence,
  summarizeQuirkIndexedRouteClaim,
  _internal: {
    claimCore,
    routeCandidatesFromContext,
    importsByKind,
    stableStringify
  }
};
