/**
 * Halal-oriented capital template registry.
 *
 * This is a deterministic product scaffold for non-rehypothecated Bitcoin
 * liquidity yield. It treats each TradeLayer property id as one capital
 * mechanic plus one enforcement template.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const { buildJurassicMechanismRefs } = require('./jurassic_bitvm_mechanisms');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'halal_capital_roadmap_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'halal_capital_roadmap_latest.md');

const CAPITAL_PROPERTY_TEMPLATES = Object.freeze([
  Object.freeze({
    propertyId: 1101,
    symbol: 'HLN-LEASE',
    templateId: 'ln-channel-lease-no-rehypo-v1',
    targetProtocol: 'lightning',
    capitalRole: 'lightning_channel_lease',
    serviceRevenue: 'fixed-duration inbound liquidity lease and routing-quality fee',
    productSurface: 'capital-stakable Lightning channel lease'
  }),
  Object.freeze({
    propertyId: 1102,
    symbol: 'HLN-ROUTE',
    templateId: 'ln-routing-reserve-no-rehypo-v1',
    targetProtocol: 'lightning',
    capitalRole: 'lightning_routing_reserve',
    serviceRevenue: 'routing fees and route availability premiums',
    productSurface: 'active Lightning routing reserve'
  }),
  Object.freeze({
    propertyId: 2101,
    symbol: 'HTAP-RFQ',
    templateId: 'taproot-assets-edge-rfq-no-rehypo-v1',
    targetProtocol: 'taproot_assets',
    capitalRole: 'taproot_assets_edge_rfq_reserve',
    serviceRevenue: 'Edge-node RFQ spread and proof-anchor service fee',
    productSurface: 'Taproot Assets Edge liquidity reserve'
  }),
  Object.freeze({
    propertyId: 3101,
    symbol: 'HARK-LIQ',
    templateId: 'ark-round-liquidity-graft-no-rehypo-v1',
    targetProtocol: 'ark',
    capitalRole: 'ark_round_liquidity_graft',
    serviceRevenue: 'short-duration round liquidity and VTXO exit insurance premium',
    productSurface: 'Ark round liquidity graft'
  }),
  Object.freeze({
    propertyId: 4101,
    symbol: 'HTL-DLCM',
    templateId: 'tradelayer-dlc-margin-reserve-no-rehypo-v1',
    targetProtocol: 'shinigami',
    capitalRole: 'tradelayer_dlc_margin_reserve',
    serviceRevenue: 'DLC margin reservation, bounded PnL settlement, and liquidation service fee',
    productSurface: 'TradeLayer derivatives margin reserve'
  }),
  Object.freeze({
    propertyId: 5101,
    symbol: 'HWT-BOND',
    templateId: 'watchtower-bond-no-rehypo-v1',
    targetProtocol: 'lightning',
    capitalRole: 'watchtower_bond',
    serviceRevenue: 'challenge bounty, alert monitoring fee, and fraud-proof service fee',
    productSurface: 'watchtower and challenger bond'
  }),
  Object.freeze({
    propertyId: 6101,
    symbol: 'HPROOF',
    templateId: 'proof-publication-bond-no-rehypo-v1',
    targetProtocol: 'shinigami',
    capitalRole: 'proof_publication_bond',
    serviceRevenue: 'proof publication, verifier receipt, and challenge-routing fee',
    productSurface: 'proof-carrying execution publication bond'
  })
]);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function stringifyJson(value, pretty = false) {
  return JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    pretty ? 2 : 0
  );
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizePropertyId(propertyId) {
  const normalized = Number(propertyId);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error('propertyId must be a positive integer');
  }
  return normalized;
}

function normalizeOutpoint(value, fieldName = 'fundingOutpoint') {
  const normalized = normalizeString(value, fieldName).toLowerCase();
  const parts = normalized.split(':');
  if (parts.length !== 2 || !/^[0-9a-f]{64}$/.test(parts[0]) || !/^[0-9]+$/.test(parts[1])) {
    throw new Error(`${fieldName} must be txid:vout`);
  }
  return `${parts[0]}:${Number(parts[1])}`;
}

function getTemplateByPropertyId(propertyId) {
  const normalized = normalizePropertyId(propertyId);
  const template = CAPITAL_PROPERTY_TEMPLATES.find((item) => item.propertyId === normalized);
  if (!template) {
    throw new Error(`unknown capital propertyId ${normalized}`);
  }
  return template;
}

function materializeTemplate(template) {
  const core = {
    version: 1,
    propertyId: template.propertyId,
    symbol: template.symbol,
    templateId: template.templateId,
    targetProtocol: template.targetProtocol,
    capitalRole: template.capitalRole,
    productSurface: template.productSurface,
    serviceRevenue: template.serviceRevenue,
    backingAsset: 'BTC',
    accounting: {
      exclusiveCommitment: true,
      oneSatOneRole: true,
      burnBeforeReissue: true,
      rehypothecationAllowed: false,
      guaranteedApyAllowed: false,
      hiddenLeverageAllowed: false
    },
    enforcement: {
      fundingOutpointScope: 'global_unique_active_commitment',
      receiptFungibility: 'same_property_id_only',
      roleTransition: 'retire_or_burn_old_receipt_before_new_property_issue',
      verifier: 'UTXORef plus TradeLayer property-template registry'
    },
    jurassicApplication: buildJurassicMechanismRefs(template.targetProtocol, {
      contractId: template.templateId,
      applicationIntent: template.productSurface,
      route: template.capitalRole,
      amountSats: 1n,
      settlementEpoch: `property:${template.propertyId}`,
      challengeWindowBlocks: 144
    })
  };

  return {
    kind: 'halal_capital_property_template',
    templateHash: hashCanonical(core),
    ...core
  };
}

function buildCapitalTemplateRegistry() {
  const templates = CAPITAL_PROPERTY_TEMPLATES.map(materializeTemplate);
  const registryCore = {
    version: 1,
    principle: 'one sat, one role, one active commitment',
    propertyIdRule: 'one propertyId equals one capital mechanic plus one enforcement template',
    templates: templates.map((template) => ({
      propertyId: template.propertyId,
      symbol: template.symbol,
      templateId: template.templateId,
      templateHash: template.templateHash,
      capitalRole: template.capitalRole,
      targetProtocol: template.targetProtocol
    }))
  };

  return {
    kind: 'halal_capital_template_registry',
    registryId: hashCanonical(registryCore),
    registryCore,
    templates
  };
}

function buildCapitalCommitment(options = {}) {
  const template = materializeTemplate(getTemplateByPropertyId(options.propertyId));
  const amountSats = normalizeAmountSats(options.amountSats || 0n, 'amountSats');
  if (amountSats <= 0n) {
    throw new Error('amountSats must be positive');
  }

  const commitmentCore = {
    version: 1,
    propertyId: template.propertyId,
    templateId: template.templateId,
    templateHash: template.templateHash,
    holderId: normalizeString(options.holderId || 'capital-holder-demo', 'holderId'),
    operatorId: normalizeString(options.operatorId || 'operator-demo', 'operatorId'),
    fundingOutpoint: normalizeOutpoint(options.fundingOutpoint),
    amountSats: amountSats.toString(),
    activeRole: template.capitalRole,
    status: options.status || 'active',
    exclusiveCommitment: true,
    jurassicMechanismRefId: template.jurassicApplication.refId,
    publicHandleId: template.jurassicApplication.primaryPublicHandleId,
    carrierCommitmentId: template.jurassicApplication.primaryCarrierCommitmentId
  };

  return {
    kind: 'halal_capital_commitment',
    commitmentId: hashCanonical(commitmentCore),
    commitmentCore,
    template
  };
}

function verifyCapitalCommitment(commitment) {
  if (!commitment || commitment.kind !== 'halal_capital_commitment') {
    return { ok: false, reason: 'wrong commitment kind' };
  }
  if (commitment.commitmentId !== hashCanonical(commitment.commitmentCore)) {
    return { ok: false, reason: 'commitment id mismatch' };
  }
  let template;
  try {
    template = materializeTemplate(getTemplateByPropertyId(commitment.commitmentCore.propertyId));
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  if (commitment.commitmentCore.templateId !== template.templateId) {
    return { ok: false, reason: 'template id mismatch' };
  }
  if (commitment.commitmentCore.templateHash !== template.templateHash) {
    return { ok: false, reason: 'template hash mismatch' };
  }
  if (commitment.commitmentCore.activeRole !== template.capitalRole) {
    return { ok: false, reason: 'active role mismatch' };
  }
  if (commitment.commitmentCore.exclusiveCommitment !== true) {
    return { ok: false, reason: 'exclusive commitment flag missing' };
  }
  return { ok: true };
}

function verifyExclusiveCapitalSet(commitments) {
  const activeOutpoints = new Map();
  for (const commitment of commitments) {
    const verified = verifyCapitalCommitment(commitment);
    if (!verified.ok) return verified;
    if (commitment.commitmentCore.status !== 'active') {
      continue;
    }
    const outpoint = commitment.commitmentCore.fundingOutpoint;
    const previous = activeOutpoints.get(outpoint);
    if (previous) {
      return {
        ok: false,
        reason: 'funding outpoint reused across active capital commitments',
        fundingOutpoint: outpoint,
        firstCommitmentId: previous.commitmentId,
        secondCommitmentId: commitment.commitmentId
      };
    }
    activeOutpoints.set(outpoint, commitment);
  }
  return {
    ok: true,
    activeCommitmentCount: activeOutpoints.size
  };
}

function buildCapitalRoleTransition(options = {}) {
  const fromCommitment = options.fromCommitment;
  const fromVerified = verifyCapitalCommitment(fromCommitment);
  if (!fromVerified.ok) {
    throw new Error(`invalid fromCommitment: ${fromVerified.reason}`);
  }
  const toTemplate = materializeTemplate(getTemplateByPropertyId(options.toPropertyId));
  const burnReceiptId = normalizeString(options.burnReceiptId || `burn:${fromCommitment.commitmentId}`, 'burnReceiptId');
  const reissueReceiptId = normalizeString(
    options.reissueReceiptId || `reissue:${fromCommitment.commitmentId}:${toTemplate.propertyId}`,
    'reissueReceiptId'
  );
  const transitionCore = {
    version: 1,
    fromCommitmentId: fromCommitment.commitmentId,
    fromPropertyId: fromCommitment.commitmentCore.propertyId,
    fromTemplateId: fromCommitment.commitmentCore.templateId,
    toPropertyId: toTemplate.propertyId,
    toTemplateId: toTemplate.templateId,
    fundingOutpoint: fromCommitment.commitmentCore.fundingOutpoint,
    amountSats: fromCommitment.commitmentCore.amountSats,
    burnReceiptId,
    reissueReceiptId,
    requiresOldCommitmentStatus: 'retired',
    burnBeforeReissue: true,
    rehypothecationAllowed: false
  };

  return {
    kind: 'halal_capital_role_transition',
    transitionId: hashCanonical(transitionCore),
    transitionCore,
    toTemplate
  };
}

function verifyCapitalRoleTransition(transition, retiredCommitment) {
  if (!transition || transition.kind !== 'halal_capital_role_transition') {
    return { ok: false, reason: 'wrong transition kind' };
  }
  if (transition.transitionId !== hashCanonical(transition.transitionCore)) {
    return { ok: false, reason: 'transition id mismatch' };
  }
  if (!retiredCommitment || retiredCommitment.commitmentCore.status !== 'retired') {
    return { ok: false, reason: 'old commitment must be retired before reissue' };
  }
  if (retiredCommitment.commitmentId !== transition.transitionCore.fromCommitmentId) {
    return { ok: false, reason: 'retired commitment id mismatch' };
  }
  return { ok: true };
}

function buildHalalCapitalRoadmap(options = {}) {
  const registry = buildCapitalTemplateRegistry();
  const phases = [
    {
      phase: 0,
      title: 'Constitutional Accounting',
      objective: 'lock one propertyId to one capital mechanic and forbid active outpoint reuse',
      deliverable: 'template registry, exclusivity verifier, role-transition verifier'
    },
    {
      phase: 1,
      title: 'Lightning Capital Buckets',
      objective: 'ship non-rehypothecated Lightning lease and routing-reserve property ids',
      deliverable: 'UTXORef evidence over lease proofs, watchtower handles, and sweep/splice carriers'
    },
    {
      phase: 2,
      title: 'Taproot Assets Edge Liquidity',
      objective: 'add Edge-node RFQ reserves with proof-anchor handles and distribution cover',
      deliverable: 'RFQ quote evidence, proof-anchor namespace, and challengeable spread accounting'
    },
    {
      phase: 3,
      title: 'Ark Short-Term Liquidity',
      objective: 'use Ark round liquidity as short-duration grafts for Lightning and TradeLayer flows',
      deliverable: 'round/VTXO claim handles, exit evidence, and cost/risk model'
    },
    {
      phase: 4,
      title: 'TradeLayer Derivatives',
      objective: 'make margin reserves property-specific and bounded by DLC/UTXORef challenge logic',
      deliverable: 'PnL settlement templates, liquidation bands, oracle proofs, and margin non-reuse checks'
    },
    {
      phase: 5,
      title: 'Public Capital Market',
      objective: 'let holders select audited property templates and receive service revenue from real network work',
      deliverable: 'capital marketplace, operator scorecards, watchtower bounties, and proof dashboards'
    }
  ];

  const jurassicApplications = [
    {
      motif: 'transcript multiplicity',
      productUse: 'alternative proof packages for leases, RFQs, Ark exits, and derivatives settlement',
      capitalControl: 'accept retry-equivalent proofs while rejecting constant-one digest collapse'
    },
    {
      motif: 'identifier bifurcation',
      productUse: 'rotating route, proof-anchor, VTXO, margin, and watchtower handles',
      capitalControl: 'public handles can rotate without changing the committed capital role'
    },
    {
      motif: 'carrier camouflage',
      productUse: 'publish proof hints through sweeps, splices, proof batches, Ark rounds, and settlement batches',
      capitalControl: 'proof publication looks like ordinary service activity instead of an exotic marker'
    }
  ];

  const roadmapCore = {
    version: 1,
    title: options.title || 'Halal-oriented capital-stakable Lightning and TradeLayer roadmap',
    principle: 'capital earns from real service revenue, one sat has one role, and no active outpoint can be reused',
    shariaNote:
      'This is a product-control scaffold, not a religious certification; final templates require qualified review.',
    registryId: registry.registryId,
    phases,
    jurassicApplications,
    propertyIds: registry.templates.map((template) => template.propertyId)
  };

  return {
    kind: 'halal_capital_roadmap',
    roadmapId: hashCanonical(roadmapCore),
    roadmapCore,
    registry
  };
}

function renderRoadmapMarkdown(roadmap) {
  const lines = [];
  lines.push('# Halal-Oriented Capital Staking Roadmap');
  lines.push('');
  lines.push(`- Roadmap id: \`${roadmap.roadmapId}\``);
  lines.push(`- Registry id: \`${roadmap.registry.registryId}\``);
  lines.push(`- Principle: ${roadmap.roadmapCore.principle}`);
  lines.push(`- Note: ${roadmap.roadmapCore.shariaNote}`);
  lines.push('');
  lines.push('## Property Template Constitution');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart LR');
  lines.push('  BTC[BTC funding outpoint] --> P[TradeLayer propertyId]');
  lines.push('  P --> T[one enforcement template]');
  lines.push('  T --> R[one active capital role]');
  lines.push('  R --> U[UTXORef verifier]');
  lines.push('  U --> Y[service revenue distribution]');
  lines.push('  U --> X[reject active outpoint reuse]');
  lines.push('```');
  lines.push('');
  lines.push('| propertyId | symbol | role | service revenue | Jurassic target |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const template of roadmap.registry.templates) {
    lines.push(
      `| ${template.propertyId} | ${template.symbol} | ${template.capitalRole} | ${template.serviceRevenue} | ${template.jurassicApplication.target} |`
    );
  }
  lines.push('');
  lines.push('## Roadmap');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart TD');
  for (const phase of roadmap.roadmapCore.phases) {
    lines.push(`  P${phase.phase}[${phase.phase}: ${phase.title}]`);
  }
  for (let i = 0; i < roadmap.roadmapCore.phases.length - 1; i++) {
    lines.push(`  P${i} --> P${i + 1}`);
  }
  lines.push('```');
  lines.push('');
  for (const phase of roadmap.roadmapCore.phases) {
    lines.push(`### Phase ${phase.phase}: ${phase.title}`);
    lines.push(`- Objective: ${phase.objective}`);
    lines.push(`- Deliverable: ${phase.deliverable}`);
    lines.push('');
  }
  lines.push('## Jurassic Bitcoin Applications');
  lines.push('');
  lines.push('| Motif | Product use | Capital control |');
  lines.push('| --- | --- | --- |');
  for (const application of roadmap.roadmapCore.jurassicApplications) {
    lines.push(`| ${application.motif} | ${application.productUse} | ${application.capitalControl} |`);
  }
  lines.push('');
  lines.push('## Non-Rehypothecation Verifier');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart TD');
  lines.push('  A[capital commitment A] --> O[funding outpoint]');
  lines.push('  B[capital commitment B] --> O');
  lines.push('  O --> V{active twice?}');
  lines.push('  V -->|yes| R[reject]');
  lines.push('  V -->|no| C[accept]');
  lines.push('```');
  lines.push('');
  lines.push('The verifier rejects active reuse even when the two commitments use different property ids.');
  return lines.join('\n');
}

function writeHalalCapitalRoadmap(roadmap, outJsonPath = OUT_JSON, outMdPath = OUT_MD) {
  ensureDir(path.dirname(outJsonPath));
  fs.writeFileSync(outJsonPath, stringifyJson(roadmap, true));
  fs.writeFileSync(outMdPath, renderRoadmapMarkdown(roadmap));
  return { outJsonPath, outMdPath };
}

function run() {
  const roadmap = buildHalalCapitalRoadmap();
  const written = writeHalalCapitalRoadmap(roadmap);
  console.log('=== Halal Capital Roadmap ===');
  console.log(`roadmapId=${roadmap.roadmapId}`);
  console.log(`registryId=${roadmap.registry.registryId}`);
  console.log(`templates=${roadmap.registry.templates.length}`);
  console.log(`jsonPath=${written.outJsonPath}`);
  console.log(`mdPath=${written.outMdPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Halal capital roadmap generation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  OUT_JSON,
  OUT_MD,
  CAPITAL_PROPERTY_TEMPLATES,
  getTemplateByPropertyId,
  materializeTemplate,
  buildCapitalTemplateRegistry,
  buildCapitalCommitment,
  verifyCapitalCommitment,
  verifyExclusiveCapitalSet,
  buildCapitalRoleTransition,
  verifyCapitalRoleTransition,
  buildHalalCapitalRoadmap,
  writeHalalCapitalRoadmap,
  renderRoadmapMarkdown
};
