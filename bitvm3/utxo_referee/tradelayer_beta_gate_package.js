/**
 * Real-money beta gate package.
 *
 * This intentionally does not make a system "beta ready" by assertion. It
 * collects the required evidence and returns a conservative gate status.
 */

const { stableStringify, sha256Hex } = require('./tradelayer_pnl_route_adapter');

const BETA_GATE_PACKAGE_KIND = 'tradelayer_real_money_beta_gate_package_v1';
const KEY_CEREMONY_KIND = 'tradelayer_beta_key_separation_ceremony_v1';
const DRILL_CHECKLIST_KIND = 'tradelayer_beta_operational_drill_checklist_v1';

const REQUIRED_ROLES = Object.freeze([
  'reserveOperator',
  'watchtowerGuardian',
  'stateOracle',
  'challenger',
  'emergencyRecovery'
]);

const DEFAULT_ROLE_ACTIONS = Object.freeze({
  reserveOperator: ['propose-vault-spend', 'fund-vault', 'initiate-rebalance'],
  watchtowerGuardian: ['approve-policy-matching-vault-spend', 'refuse-policy-violations'],
  stateOracle: ['attest-tradelayer-state', 'sign-tx30-relay-bundle'],
  challenger: ['monitor-relay-bundles', 'publish-fault', 'initiate-dispute'],
  emergencyRecovery: ['execute-csv-recovery-after-delay']
});

const REQUIRED_DRILLS = Object.freeze([
  'rbf_fee_bump',
  'cpfp_fee_bump',
  'node_restart_recovery',
  'stale_indexer_detection',
  'reorg_reserve_reconciliation',
  'watchtower_restart_alerting',
  'relay_retrieval_fault'
]);

function hasSecretLikeField(value) {
  const text = stableStringify(value || {});
  return /privateKey|privkey|secretKey|secnonce|seedPhrase|mnemonic/i.test(text);
}

function normalizePublicKey(value, role) {
  const s = String(value || '').trim();
  if (!s) throw new Error(`${role}.publicKey is required`);
  if (/(private|secret|mnemonic|seed)/i.test(s)) throw new Error(`${role}.publicKey appears to contain secret material`);
  return s;
}

function fingerprintPublicKey(publicKey) {
  return sha256Hex(String(publicKey).trim().toLowerCase()).slice(0, 32);
}

function buildKeySeparationCeremony(input = {}) {
  const rolesInput = input.roles || {};
  const roles = {};
  const errors = [];
  const warnings = [];
  const seen = new Map();

  if (hasSecretLikeField(rolesInput)) errors.push('role material includes private-key-like fields');

  for (const role of REQUIRED_ROLES) {
    const spec = rolesInput[role] || {};
    try {
      const publicKey = normalizePublicKey(spec.publicKey, role);
      const fingerprint = fingerprintPublicKey(publicKey);
      if (seen.has(fingerprint)) {
        errors.push(`${role}.publicKey duplicates ${seen.get(fingerprint)} public key`);
      } else {
        seen.set(fingerprint, role);
      }
      roles[role] = {
        role,
        owner: String(spec.owner || ''),
        custody: String(spec.custody || ''),
        publicKey,
        fingerprint,
        allowedActions: spec.allowedActions || DEFAULT_ROLE_ACTIONS[role],
        rotation: String(spec.rotation || ''),
        emergencyContact: String(spec.emergencyContact || '')
      };
      if (!roles[role].owner) warnings.push(`${role}.owner is not recorded`);
      if (!roles[role].custody) warnings.push(`${role}.custody is not recorded`);
    } catch (err) {
      errors.push(err.message);
      roles[role] = {
        role,
        owner: String(spec.owner || ''),
        custody: String(spec.custody || ''),
        publicKey: '',
        fingerprint: null,
        allowedActions: spec.allowedActions || DEFAULT_ROLE_ACTIONS[role],
        rotation: String(spec.rotation || ''),
        emergencyContact: String(spec.emergencyContact || '')
      };
    }
  }

  const ceremony = {
    kind: KEY_CEREMONY_KIND,
    createdAt: input.createdAt || new Date().toISOString(),
    roles,
    requiredRoles: REQUIRED_ROLES,
    errors,
    warnings,
    ok: errors.length === 0
  };
  ceremony.ceremonyHash = sha256Hex({
    kind: ceremony.kind,
    roles,
    errors,
    warnings
  });
  return ceremony;
}

function buildOperationalDrillChecklist(input = {}) {
  const drillInput = input.drills || {};
  const drills = {};
  const missing = [];
  for (const id of REQUIRED_DRILLS) {
    const row = drillInput[id] || {};
    const status = String(row.status || 'not_run');
    const ok = status === 'passed';
    drills[id] = {
      id,
      status,
      artifact: row.artifact || null,
      txid: row.txid || null,
      notes: row.notes || ''
    };
    if (!ok) missing.push(id);
  }
  const checklist = {
    kind: DRILL_CHECKLIST_KIND,
    createdAt: input.createdAt || new Date().toISOString(),
    drills,
    requiredDrills: REQUIRED_DRILLS,
    ok: missing.length === 0,
    missing
  };
  checklist.checklistHash = sha256Hex({
    kind: checklist.kind,
    drills,
    missing
  });
  return checklist;
}

function gate(name, ok, detail = {}) {
  return { name, ok: Boolean(ok), ...detail };
}

function numericPositive(value) {
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function buildBetaGatePackage(input = {}) {
  const evidence = input.evidence || {};
  const keyCeremony = input.keyCeremony?.kind === KEY_CEREMONY_KIND
    ? input.keyCeremony
    : buildKeySeparationCeremony({ roles: input.roles || {}, createdAt: input.createdAt });
  const drillChecklist = input.drillChecklist?.kind === DRILL_CHECKLIST_KIND
    ? input.drillChecklist
    : buildOperationalDrillChecklist({ drills: input.drills || {}, createdAt: input.createdAt });
  const caps = input.caps || {};
  const externalReview = input.externalReview || {};

  const gates = [
    gate('confirmed_live_reserve', evidence.reserve?.confirmed === true && evidence.reserve?.unspent !== false, {
      txid: evidence.reserve?.txid || null,
      confirmations: evidence.reserve?.confirmations ?? null
    }),
    gate('full_signed_relay_retrieval', evidence.relayRetrieval?.ok === true && evidence.relayRetrieval?.replicaCount >= 2, {
      relayBlobHash: evidence.relayRetrieval?.relayBlobHash || null,
      replicaCount: evidence.relayRetrieval?.replicaCount || 0
    }),
    gate('separated_keys', keyCeremony.ok, {
      ceremonyHash: keyCeremony.ceremonyHash,
      errors: keyCeremony.errors
    }),
    gate('operational_drills', drillChecklist.ok, {
      checklistHash: drillChecklist.checklistHash,
      missing: drillChecklist.missing
    }),
    gate('loss_caps_defined', numericPositive(caps.maxTotalLossSats) && numericPositive(caps.maxPerContractSats), {
      maxTotalLossSats: caps.maxTotalLossSats || null,
      maxPerContractSats: caps.maxPerContractSats || null,
      pausePolicy: caps.pausePolicy || null
    }),
    gate('external_review_scope', externalReview.scopeDefined === true && Boolean(externalReview.reviewer || externalReview.reviewOwner), {
      reviewer: externalReview.reviewer || null,
      reviewOwner: externalReview.reviewOwner || null
    }),
    gate('regression_green', evidence.tests?.fullSuitePassed === true, {
      command: evidence.tests?.command || null,
      suites: evidence.tests?.suites || null
    })
  ];

  const hardPass = gates.every((g) => g.ok);
  const testnetCorePass = gates.find((g) => g.name === 'confirmed_live_reserve')?.ok
    && gates.find((g) => g.name === 'full_signed_relay_retrieval')?.ok
    && gates.find((g) => g.name === 'regression_green')?.ok;
  const status = hardPass ? 'BETA_CANDIDATE' : testnetCorePass ? 'LIMITED_TESTNET_CONTINUE' : 'NO_GO';

  const packageCore = {
    kind: BETA_GATE_PACKAGE_KIND,
    createdAt: input.createdAt || new Date().toISOString(),
    status,
    realMoneyAllowed: status === 'BETA_CANDIDATE',
    gates,
    evidence,
    keyCeremony,
    drillChecklist,
    caps,
    externalReview,
    nextRequiredActions: gates.filter((g) => !g.ok).map((g) => g.name)
  };

  return {
    ...packageCore,
    packageHash: sha256Hex(packageCore)
  };
}

function renderBetaGateMarkdown(pkg) {
  const lines = [];
  lines.push(`# Real-Money Beta Gate Package`);
  lines.push('');
  lines.push(`- Status: \`${pkg.status}\``);
  lines.push(`- Real money allowed: \`${pkg.realMoneyAllowed}\``);
  lines.push(`- Package hash: \`${pkg.packageHash}\``);
  lines.push('');
  lines.push(`## Gates`);
  for (const g of pkg.gates) {
    lines.push(`- ${g.ok ? 'PASS' : 'FAIL'} \`${g.name}\``);
  }
  if (pkg.nextRequiredActions.length) {
    lines.push('');
    lines.push(`## Next Required Actions`);
    for (const action of pkg.nextRequiredActions) lines.push(`- ${action}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  BETA_GATE_PACKAGE_KIND,
  KEY_CEREMONY_KIND,
  DRILL_CHECKLIST_KIND,
  REQUIRED_ROLES,
  REQUIRED_DRILLS,
  DEFAULT_ROLE_ACTIONS,
  buildKeySeparationCeremony,
  buildOperationalDrillChecklist,
  buildBetaGatePackage,
  renderBetaGateMarkdown,
  fingerprintPublicKey
};
