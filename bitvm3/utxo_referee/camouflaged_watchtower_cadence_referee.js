/**
 * Carrier-camouflaged watchtower cadence claims.
 *
 * This layer builds on quirk-indexed route admission. A watchtower checkpoint is
 * only admissible when it references an already-admitted route claim, binds to
 * the same live reserve witness, and arrives within the expected cadence.
 */

const {
  sha256Hex
} = require('./tradelayer_pnl_route_adapter');

const CLAIM_KIND = 'camouflaged_watchtower_cadence_claim_v1';
const CHALLENGE_KIND = 'camouflaged_watchtower_cadence_challenge_v1';
const CLAIM_WRAPPER_KIND = 'camouflaged_watchtower_cadence_claim';
const CHALLENGE_WRAPPER_KIND = 'camouflaged_watchtower_cadence_challenge';
const DEFAULT_NETWORK = 'bitcoin-testnet4';
const CARRIER_PROFILES = new Set([
  'wallet_sweep_checkpoint',
  'payout_batch_checkpoint',
  'rebalance_checkpoint'
]);

function normalizeString(value, fieldName) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${fieldName} is required`);
  return text;
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

function normalizePositiveInteger(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${fieldName} must be a positive integer`);
  return n;
}

function normalizeNonNegativeInteger(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${fieldName} must be a non-negative integer`);
  return n;
}

function normalizeCarrierProfile(value) {
  const profile = normalizeString(value, 'carrierProfile');
  if (!CARRIER_PROFILES.has(profile)) throw new Error(`unsupported carrierProfile: ${profile}`);
  return profile;
}

function buildSemanticAlertHash(input = {}) {
  return sha256Hex({
    kind: 'camouflaged_watchtower_semantic_alert_v1',
    routeClaimHash: normalizeHex(input.routeClaimHash, 32, 'routeClaimHash'),
    reserveOutpoint: normalizeOutpoint(input.reserveOutpoint),
    watchtowerEpoch: normalizeString(input.watchtowerEpoch, 'watchtowerEpoch')
  });
}

function claimCore(input = {}) {
  return {
    kind: CLAIM_KIND,
    network: String(input.network || DEFAULT_NETWORK),
    reserveOutpoint: normalizeOutpoint(input.reserveOutpoint),
    liveTraceHash: normalizeHex(input.liveTraceHash, 32, 'liveTraceHash'),
    watchtowerEpoch: normalizeString(input.watchtowerEpoch, 'watchtowerEpoch'),
    expectedCadenceBlocks: normalizePositiveInteger(input.expectedCadenceBlocks, 'expectedCadenceBlocks'),
    publicationHeight: normalizeNonNegativeInteger(input.publicationHeight, 'publicationHeight'),
    carrierProfile: normalizeCarrierProfile(input.carrierProfile),
    publicationHandle: normalizeString(input.publicationHandle, 'publicationHandle'),
    semanticAlertHash: normalizeHex(input.semanticAlertHash, 32, 'semanticAlertHash'),
    routeClaimHash: normalizeHex(input.routeClaimHash, 32, 'routeClaimHash')
  };
}

function buildCamouflagedWatchtowerCadenceClaim(input = {}) {
  const core = claimCore(input);
  return {
    kind: CLAIM_WRAPPER_KIND,
    claimHash: sha256Hex(core),
    core
  };
}

function claimHashOk(claim) {
  if (!claim || claim.kind !== CLAIM_WRAPPER_KIND) return { ok: false, reason: 'wrong claim kind' };
  if (!claim.core || claim.core.kind !== CLAIM_KIND) return { ok: false, reason: 'wrong claim core kind' };
  const claimHash = sha256Hex(claim.core);
  if (claim.claimHash !== claimHash) return { ok: false, reason: 'claim hash mismatch', claimHash };
  return { ok: true, claimHash };
}

function importsByKind(liveImportBundle = {}) {
  const imports = Array.isArray(liveImportBundle.imports) ? liveImportBundle.imports : [];
  return {
    vault: imports.find((item) => item.kind === 'btctest4_utxoref_reserve_vault_import_v1') || null
  };
}

function routeClaimRows(context = {}) {
  const explicit = Array.isArray(context.admittedRouteClaims) ? context.admittedRouteClaims : [];
  const fromDemo = Array.isArray(context.routeDemo?.scenarios)
    ? context.routeDemo.scenarios.map((scenario) => ({
        claimHash: scenario.claim?.claimHash,
        admissible: scenario.verification?.admissible === true,
        routeClaim: scenario.claim,
        source: scenario.id
      }))
    : [];
  return explicit.concat(fromDemo).filter((row) => row.claimHash);
}

function findAdmittedRouteClaim(routeClaimHash, context = {}) {
  return routeClaimRows(context).find((row) => (
    row.claimHash === routeClaimHash && row.admissible === true
  )) || null;
}

function handleRegistryRows(context = {}) {
  return Array.isArray(context.publicationRegistry) ? context.publicationRegistry : [];
}

function findHandleBinding(claim, context = {}) {
  return handleRegistryRows(context).find((row) => (
    row.publicationHandle === claim.core.publicationHandle
  )) || null;
}

function verifyCamouflagedWatchtowerCadenceClaim(claim, context = {}) {
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

  const currentHeight = Number(context.currentHeight ?? context.liveImportBundle?.node?.blocks ?? 0);
  const ageBlocks = currentHeight - claim.core.publicationHeight;
  add('cadence_freshness', Number.isInteger(currentHeight) && ageBlocks >= 0 && ageBlocks <= claim.core.expectedCadenceBlocks, {
    currentHeight,
    publicationHeight: claim.core.publicationHeight,
    ageBlocks,
    expectedCadenceBlocks: claim.core.expectedCadenceBlocks
  });

  const routeClaim = findAdmittedRouteClaim(claim.core.routeClaimHash, context);
  add('admitted_route_claim', !!routeClaim, {
    routeClaimHash: claim.core.routeClaimHash,
    source: routeClaim?.source || null
  });

  const expectedSemanticAlertHash = buildSemanticAlertHash(claim.core);
  add('semantic_alert_hash', claim.core.semanticAlertHash === expectedSemanticAlertHash, {
    expected: expectedSemanticAlertHash,
    actual: claim.core.semanticAlertHash
  });

  const handleBinding = findHandleBinding(claim, context);
  add('publication_handle_binding', !!handleBinding
    && handleBinding.routeClaimHash === claim.core.routeClaimHash
    && handleBinding.semanticAlertHash === claim.core.semanticAlertHash, {
      publicationHandle: claim.core.publicationHandle,
      binding: handleBinding || null
    });

  const { vault } = importsByKind(context.liveImportBundle);
  add('live_reserve_status', vault?.bindings?.bindingStatus === 'live_unspent_reserve_countable', {
    bindingStatus: vault?.bindings?.bindingStatus || null
  });
  add('reserve_outpoint', vault?.chain_ref?.outpoint === claim.core.reserveOutpoint, {
    expected: vault?.chain_ref?.outpoint || null,
    actual: claim.core.reserveOutpoint
  });
  add('live_trace_hash', vault?.bindings?.liveTraceHash === claim.core.liveTraceHash, {
    expected: vault?.bindings?.liveTraceHash || null,
    actual: claim.core.liveTraceHash
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
    routeClaim,
    handleBinding,
    failedChecks,
    checks
  };
}

function buildCamouflagedWatchtowerCadenceChallenge(claim, context = {}, violation = null) {
  const verification = verifyCamouflagedWatchtowerCadenceClaim(claim, context);
  const violations = violation ? [String(violation)] : verification.failedChecks.slice();
  const core = {
    kind: CHALLENGE_KIND,
    claimHash: claim?.claimHash || null,
    routeClaimHash: claim?.core?.routeClaimHash || null,
    reserveOutpoint: claim?.core?.reserveOutpoint || null,
    publicationHandle: claim?.core?.publicationHandle || null,
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

function summarizeCamouflagedWatchtowerCadenceClaim(claim, verification = null) {
  return {
    claimHash: claim.claimHash,
    routeClaimHash: claim.core.routeClaimHash,
    publicationHandle: claim.core.publicationHandle,
    carrierProfile: claim.core.carrierProfile,
    watchtowerEpoch: claim.core.watchtowerEpoch,
    admissible: verification ? verification.admissible : null,
    failedChecks: verification ? verification.failedChecks : []
  };
}

module.exports = {
  CLAIM_KIND,
  CLAIM_WRAPPER_KIND,
  CHALLENGE_KIND,
  CHALLENGE_WRAPPER_KIND,
  CARRIER_PROFILES,
  buildSemanticAlertHash,
  buildCamouflagedWatchtowerCadenceClaim,
  verifyCamouflagedWatchtowerCadenceClaim,
  buildCamouflagedWatchtowerCadenceChallenge,
  summarizeCamouflagedWatchtowerCadenceClaim,
  _internal: {
    claimCore,
    importsByKind,
    routeClaimRows,
    findAdmittedRouteClaim,
    handleRegistryRows
  }
};
