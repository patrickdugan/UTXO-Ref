/**
 * Halal-oriented capital marketplace demo.
 *
 * Builds a deterministic snapshot of capital commitments, observer indexes,
 * service revenue events, and a burn-before-reissue role transition.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  OUT_JSON: ROADMAP_JSON,
  CAPITAL_PROPERTY_TEMPLATES,
  buildCapitalTemplateRegistry,
  buildCapitalCommitment,
  verifyExclusiveCapitalSet,
  buildCapitalRoleTransition,
  verifyCapitalRoleTransition
} = require('./halal_capital_template_registry');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'halal_capital_marketplace_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'halal_capital_marketplace_latest.md');

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

function demoOutpoint(index) {
  return `${sha256Hex(`halal-capital-outpoint:${index}`)}:${index % 2}`;
}

function buildDemoCommitments(options = {}) {
  const amountBaseSats = normalizeAmountSats(options.amountBaseSats || 1000000n, 'amountBaseSats');
  return CAPITAL_PROPERTY_TEMPLATES.map((template, index) => buildCapitalCommitment({
    propertyId: template.propertyId,
    fundingOutpoint: demoOutpoint(index + 1),
    amountSats: amountBaseSats + BigInt(index) * 250000n,
    holderId: `holder-${index + 1}`,
    operatorId: `operator-${template.symbol.toLowerCase()}`
  }));
}

function buildServiceRevenueEvent(commitment, options = {}) {
  const revenueSats = normalizeAmountSats(options.revenueSats || 1000n, 'revenueSats');
  const eventCore = {
    version: 1,
    propertyId: commitment.commitmentCore.propertyId,
    commitmentId: commitment.commitmentId,
    templateId: commitment.commitmentCore.templateId,
    activeRole: commitment.commitmentCore.activeRole,
    revenueSats: revenueSats.toString(),
    revenueSource: options.revenueSource || commitment.template.serviceRevenue,
    servicePeriod: options.servicePeriod || 'demo-period-1',
    sourceTxid: options.sourceTxid || sha256Hex(`service-revenue:${commitment.commitmentId}`)
  };

  return {
    kind: 'halal_capital_service_revenue_event',
    eventId: hashCanonical(eventCore),
    eventCore
  };
}

function buildObserverIndex(commitments) {
  const byPropertyId = {};
  const byPublicHandleId = {};
  const byCarrierCommitmentId = {};
  for (const commitment of commitments) {
    const entry = {
      commitmentId: commitment.commitmentId,
      propertyId: commitment.commitmentCore.propertyId,
      templateId: commitment.commitmentCore.templateId,
      activeRole: commitment.commitmentCore.activeRole,
      amountSats: commitment.commitmentCore.amountSats
    };
    if (!byPropertyId[commitment.commitmentCore.propertyId]) {
      byPropertyId[commitment.commitmentCore.propertyId] = [];
    }
    byPropertyId[commitment.commitmentCore.propertyId].push(entry);
    byPublicHandleId[commitment.commitmentCore.publicHandleId] = entry;
    byCarrierCommitmentId[commitment.commitmentCore.carrierCommitmentId] = entry;
  }

  return {
    kind: 'halal_capital_observer_index',
    indexId: hashCanonical({
      byPropertyId,
      byPublicHandleId,
      byCarrierCommitmentId
    }),
    byPropertyId,
    byPublicHandleId,
    byCarrierCommitmentId
  };
}

function sumSats(values) {
  return values.reduce((acc, value) => acc + BigInt(value), 0n).toString();
}

function buildRoleTransitionDemo(commitments) {
  const from = commitments.find((commitment) => commitment.commitmentCore.propertyId === 1101);
  if (!from) {
    return {
      retiredCommitmentId: null,
      transition: null,
      verification: {
        ok: false,
        reason: 'missing HLN-LEASE commitment for role transition demo'
      }
    };
  }
  const retired = {
    ...from,
    commitmentCore: {
      ...from.commitmentCore,
      status: 'retired'
    }
  };
  const transition = buildCapitalRoleTransition({
    fromCommitment: from,
    toPropertyId: 3101,
    burnReceiptId: `burn:${from.commitmentId}`,
    reissueReceiptId: `reissue:${from.commitmentId}:3101`
  });
  const verification = verifyCapitalRoleTransition(transition, retired);
  return {
    retiredCommitmentId: retired.commitmentId,
    transition,
    verification
  };
}

function buildHalalCapitalMarketplaceSnapshot(options = {}) {
  const registry = buildCapitalTemplateRegistry();
  const commitments = options.commitments || buildDemoCommitments(options);
  const exclusivity = verifyExclusiveCapitalSet(commitments);
  const revenueEvents = commitments.map((commitment, index) => buildServiceRevenueEvent(commitment, {
    revenueSats: BigInt(index + 1) * 1000n,
    servicePeriod: 'demo-period-1'
  }));
  const observerIndex = buildObserverIndex(commitments);
  const roleTransitionDemo = buildRoleTransitionDemo(commitments);
  const snapshotCore = {
    version: 1,
    roadmapArtifact: ROADMAP_JSON,
    registryId: registry.registryId,
    commitmentIds: commitments.map((commitment) => commitment.commitmentId),
    revenueEventIds: revenueEvents.map((event) => event.eventId),
    observerIndexId: observerIndex.indexId,
    totalActiveCapitalSats: sumSats(commitments.map((commitment) => commitment.commitmentCore.amountSats)),
    totalServiceRevenueSats: sumSats(revenueEvents.map((event) => event.eventCore.revenueSats)),
    exclusivityOk: exclusivity.ok,
    roleTransitionOk: roleTransitionDemo.verification.ok
  };

  return {
    kind: 'halal_capital_marketplace_snapshot',
    snapshotId: hashCanonical(snapshotCore),
    snapshotCore,
    registry,
    commitments,
    exclusivity,
    revenueEvents,
    observerIndex,
    roleTransitionDemo
  };
}

function verifyHalalCapitalMarketplaceSnapshot(snapshot) {
  if (!snapshot || snapshot.kind !== 'halal_capital_marketplace_snapshot') {
    return { ok: false, reason: 'wrong snapshot kind' };
  }
  if (snapshot.snapshotId !== hashCanonical(snapshot.snapshotCore)) {
    return { ok: false, reason: 'snapshot id mismatch' };
  }
  const exclusivity = verifyExclusiveCapitalSet(snapshot.commitments);
  if (!exclusivity.ok) return exclusivity;
  const commitmentIds = new Set(snapshot.commitments.map((commitment) => commitment.commitmentId));
  if (snapshot.snapshotCore.registryId !== snapshot.registry.registryId) {
    return { ok: false, reason: 'registry id mismatch' };
  }
  if (stringifyJson(snapshot.snapshotCore.commitmentIds) !== stringifyJson([...commitmentIds])) {
    return { ok: false, reason: 'commitment id list mismatch' };
  }
  const observerIndex = buildObserverIndex(snapshot.commitments);
  if (!snapshot.observerIndex || snapshot.observerIndex.indexId !== observerIndex.indexId) {
    return { ok: false, reason: 'observer index mismatch' };
  }
  if (snapshot.snapshotCore.observerIndexId !== observerIndex.indexId) {
    return { ok: false, reason: 'snapshot observer index id mismatch' };
  }
  if (snapshot.snapshotCore.totalActiveCapitalSats !== sumSats(snapshot.commitments.map((commitment) => commitment.commitmentCore.amountSats))) {
    return { ok: false, reason: 'active capital total mismatch' };
  }
  for (const event of snapshot.revenueEvents || []) {
    if (!commitmentIds.has(event.eventCore.commitmentId)) {
      return { ok: false, reason: `unknown revenue commitment ${event.eventCore.commitmentId}` };
    }
    if (event.eventId !== hashCanonical(event.eventCore)) {
      return { ok: false, reason: `revenue event id mismatch ${event.eventId}` };
    }
  }
  const revenueEventIds = (snapshot.revenueEvents || []).map((event) => event.eventId);
  if (stringifyJson(snapshot.snapshotCore.revenueEventIds) !== stringifyJson(revenueEventIds)) {
    return { ok: false, reason: 'revenue event id list mismatch' };
  }
  if (snapshot.snapshotCore.totalServiceRevenueSats !== sumSats((snapshot.revenueEvents || []).map((event) => event.eventCore.revenueSats))) {
    return { ok: false, reason: 'service revenue total mismatch' };
  }
  if (!snapshot.roleTransitionDemo || !snapshot.roleTransitionDemo.verification.ok) {
    return { ok: false, reason: 'role transition demo failed' };
  }
  return { ok: true };
}

function renderMarketplaceMarkdown(snapshot) {
  const lines = [];
  lines.push('# Halal Capital Marketplace Snapshot');
  lines.push('');
  lines.push(`- Snapshot id: \`${snapshot.snapshotId}\``);
  lines.push(`- Registry id: \`${snapshot.registry.registryId}\``);
  lines.push(`- Total active capital sats: \`${snapshot.snapshotCore.totalActiveCapitalSats}\``);
  lines.push(`- Total service revenue sats: \`${snapshot.snapshotCore.totalServiceRevenueSats}\``);
  lines.push(`- Exclusivity: \`${snapshot.exclusivity.ok ? 'ok' : snapshot.exclusivity.reason}\``);
  lines.push('');
  lines.push('## Marketplace Flow');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart LR');
  lines.push('  H[capital holder] --> C[capital commitment]');
  lines.push('  C --> P[TradeLayer propertyId]');
  lines.push('  P --> U[UTXORef verifier]');
  lines.push('  U --> O[observer index]');
  lines.push('  O --> R[service revenue event]');
  lines.push('  R --> H');
  lines.push('  U --> X[reject reused outpoints]');
  lines.push('```');
  lines.push('');
  lines.push('## Active Commitments');
  lines.push('');
  lines.push('| propertyId | role | amount sats | public handle prefix | carrier prefix |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const commitment of snapshot.commitments) {
    lines.push(
      `| ${commitment.commitmentCore.propertyId} | ${commitment.commitmentCore.activeRole} | ${commitment.commitmentCore.amountSats} | ${commitment.commitmentCore.publicHandleId.slice(0, 12)} | ${commitment.commitmentCore.carrierCommitmentId.slice(0, 12)} |`
    );
  }
  lines.push('');
  lines.push('## Revenue Events');
  lines.push('');
  lines.push('| propertyId | role | revenue sats | source |');
  lines.push('| --- | --- | --- | --- |');
  for (const event of snapshot.revenueEvents) {
    lines.push(
      `| ${event.eventCore.propertyId} | ${event.eventCore.activeRole} | ${event.eventCore.revenueSats} | ${event.eventCore.revenueSource} |`
    );
  }
  lines.push('');
  lines.push('## Burn Before Reissue Demo');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart TD');
  lines.push('  A[HLN-LEASE active commitment] --> B[retire old receipt]');
  lines.push('  B --> C[burn receipt id]');
  lines.push('  C --> D[reissue as HARK-LIQ propertyId 3101]');
  lines.push('  A --> X[direct active reuse]');
  lines.push('  X --> R[reject]');
  lines.push('```');
  lines.push('');
  lines.push(`- Transition id: \`${snapshot.roleTransitionDemo.transition.transitionId}\``);
  lines.push(`- Verification: \`${snapshot.roleTransitionDemo.verification.ok ? 'ok' : snapshot.roleTransitionDemo.verification.reason}\``);
  return lines.join('\n');
}

function writeHalalCapitalMarketplaceSnapshot(snapshot, outJsonPath = OUT_JSON, outMdPath = OUT_MD) {
  ensureDir(path.dirname(outJsonPath));
  fs.writeFileSync(outJsonPath, stringifyJson(snapshot, true));
  fs.writeFileSync(outMdPath, renderMarketplaceMarkdown(snapshot));
  return { outJsonPath, outMdPath };
}

function run() {
  const snapshot = buildHalalCapitalMarketplaceSnapshot();
  const verification = verifyHalalCapitalMarketplaceSnapshot(snapshot);
  if (!verification.ok) {
    throw new Error(verification.reason);
  }
  const written = writeHalalCapitalMarketplaceSnapshot(snapshot);
  console.log('=== Halal Capital Marketplace Snapshot ===');
  console.log(`snapshotId=${snapshot.snapshotId}`);
  console.log(`commitments=${snapshot.commitments.length}`);
  console.log(`revenueEvents=${snapshot.revenueEvents.length}`);
  console.log(`jsonPath=${written.outJsonPath}`);
  console.log(`mdPath=${written.outMdPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Halal capital marketplace demo failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  OUT_JSON,
  OUT_MD,
  buildDemoCommitments,
  buildServiceRevenueEvent,
  buildObserverIndex,
  buildRoleTransitionDemo,
  buildHalalCapitalMarketplaceSnapshot,
  verifyHalalCapitalMarketplaceSnapshot,
  writeHalalCapitalMarketplaceSnapshot,
  renderMarketplaceMarkdown
};
