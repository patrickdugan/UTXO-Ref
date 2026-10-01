/**
 * TradeLayer procedural-token wiring for halal-oriented capital commitments.
 *
 * This adapter keeps principal receipts, service revenue, and role transitions
 * explicit so the same funding outpoint cannot quietly become multiple yield
 * products.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');
const {
  OUT_JSON: MARKETPLACE_JSON,
  buildHalalCapitalMarketplaceSnapshot,
  verifyHalalCapitalMarketplaceSnapshot
} = require('./halal_capital_marketplace_demo');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'halal_capital_tradelayer_tokens_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'halal_capital_tradelayer_tokens_latest.md');

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

function sumSats(values) {
  return values.reduce((acc, value) => acc + BigInt(value || 0), 0n).toString();
}

function eventWithId(eventCore) {
  return {
    kind: 'tradelayer_procedural_capital_event',
    eventId: hashCanonical(eventCore),
    eventCore
  };
}

function buildTradeLayerTokenSpec(template) {
  const specCore = {
    version: 1,
    protocol: 'tradelayer-procedural-token',
    propertyId: template.propertyId,
    symbol: template.symbol,
    templateId: template.templateId,
    templateHash: template.templateHash,
    targetProtocol: template.targetProtocol,
    activeRole: template.capitalRole,
    tokenKind: 'capital_principal_receipt',
    principalUnit: 'sat',
    mintRule: 'mint one receipt unit per committed backing sat',
    burnRule: 'burn or retire before reissue into a different propertyId',
    revenueRule: 'service revenue is credited separately from principal supply',
    transferScope: 'same_property_id_only',
    rehypothecationAllowed: false
  };

  return {
    kind: 'tradelayer_procedural_capital_token_spec',
    specId: hashCanonical(specCore),
    specCore
  };
}

function buildPrincipalMintEvent(commitment) {
  return eventWithId({
    version: 1,
    eventType: 'mint_principal_receipt',
    propertyId: commitment.commitmentCore.propertyId,
    templateId: commitment.commitmentCore.templateId,
    commitmentId: commitment.commitmentId,
    accountId: commitment.commitmentCore.holderId,
    operatorId: commitment.commitmentCore.operatorId,
    amountUnits: commitment.commitmentCore.amountSats,
    fundingOutpoint: commitment.commitmentCore.fundingOutpoint,
    publicHandleId: commitment.commitmentCore.publicHandleId,
    carrierCommitmentId: commitment.commitmentCore.carrierCommitmentId
  });
}

function buildServiceRevenueCreditEvent(revenueEvent, commitment) {
  return eventWithId({
    version: 1,
    eventType: 'credit_service_revenue',
    propertyId: revenueEvent.eventCore.propertyId,
    templateId: revenueEvent.eventCore.templateId,
    commitmentId: revenueEvent.eventCore.commitmentId,
    revenueEventId: revenueEvent.eventId,
    accountId: commitment.commitmentCore.holderId,
    amountUnits: revenueEvent.eventCore.revenueSats,
    revenueSource: revenueEvent.eventCore.revenueSource,
    servicePeriod: revenueEvent.eventCore.servicePeriod,
    sourceTxid: revenueEvent.eventCore.sourceTxid
  });
}

function buildRoleTransitionInstruction(snapshot) {
  const transition = snapshot.roleTransitionDemo?.transition || null;
  if (!transition) return null;

  const fromCommitment = snapshot.commitments.find(
    (commitment) => commitment.commitmentId === transition.transitionCore.fromCommitmentId
  );
  if (!fromCommitment) return null;

  const burnEvent = eventWithId({
    version: 1,
    eventType: 'burn_principal_for_role_transition',
    propertyId: transition.transitionCore.fromPropertyId,
    templateId: transition.transitionCore.fromTemplateId,
    commitmentId: transition.transitionCore.fromCommitmentId,
    accountId: fromCommitment.commitmentCore.holderId,
    amountUnits: transition.transitionCore.amountSats,
    fundingOutpoint: transition.transitionCore.fundingOutpoint,
    burnReceiptId: transition.transitionCore.burnReceiptId,
    transitionId: transition.transitionId
  });
  const reissueEvent = eventWithId({
    version: 1,
    eventType: 'reissue_principal_after_burn',
    propertyId: transition.transitionCore.toPropertyId,
    templateId: transition.transitionCore.toTemplateId,
    sourcePropertyId: transition.transitionCore.fromPropertyId,
    sourceBurnEventId: burnEvent.eventId,
    accountId: fromCommitment.commitmentCore.holderId,
    amountUnits: transition.transitionCore.amountSats,
    fundingOutpoint: transition.transitionCore.fundingOutpoint,
    reissueReceiptId: transition.transitionCore.reissueReceiptId,
    transitionId: transition.transitionId
  });
  const instructionCore = {
    version: 1,
    transitionId: transition.transitionId,
    burnEventId: burnEvent.eventId,
    reissueEventId: reissueEvent.eventId,
    oldStatusRequired: transition.transitionCore.requiresOldCommitmentStatus,
    burnBeforeReissue: transition.transitionCore.burnBeforeReissue,
    rehypothecationAllowed: transition.transitionCore.rehypothecationAllowed
  };

  return {
    kind: 'tradelayer_procedural_role_transition_instruction',
    instructionId: hashCanonical(instructionCore),
    instructionCore,
    burnEvent,
    reissueEvent
  };
}

function buildBalanceRows(snapshot) {
  const commitmentsById = new Map(snapshot.commitments.map((commitment) => [commitment.commitmentId, commitment]));
  return snapshot.registry.templates.map((template) => {
    const commitments = snapshot.commitments.filter(
      (commitment) => commitment.commitmentCore.propertyId === template.propertyId
    );
    const revenueEvents = snapshot.revenueEvents.filter(
      (event) => event.eventCore.propertyId === template.propertyId
    );
    const holderIds = new Set(commitments.map((commitment) => commitment.commitmentCore.holderId));
    return {
      propertyId: template.propertyId,
      symbol: template.symbol,
      activeRole: template.capitalRole,
      targetProtocol: template.targetProtocol,
      principalSupplyUnits: sumSats(commitments.map((commitment) => commitment.commitmentCore.amountSats)),
      accruedServiceRevenueUnits: sumSats(revenueEvents.map((event) => event.eventCore.revenueSats)),
      activeCommitmentCount: commitments.length,
      holderCount: holderIds.size,
      revenueBackedByKnownCommitments: revenueEvents.every((event) => commitmentsById.has(event.eventCore.commitmentId))
    };
  });
}

function buildHalalCapitalTradeLayerTokenPlan(options = {}) {
  const marketplaceSnapshot = options.marketplaceSnapshot || buildHalalCapitalMarketplaceSnapshot(options);
  const tokenSpecs = marketplaceSnapshot.registry.templates.map(buildTradeLayerTokenSpec);
  const principalMintEvents = marketplaceSnapshot.commitments.map(buildPrincipalMintEvent);
  const commitmentsById = new Map(
    marketplaceSnapshot.commitments.map((commitment) => [commitment.commitmentId, commitment])
  );
  const serviceRevenueCreditEvents = marketplaceSnapshot.revenueEvents.map((event) => (
    buildServiceRevenueCreditEvent(event, commitmentsById.get(event.eventCore.commitmentId))
  ));
  const balanceRows = buildBalanceRows(marketplaceSnapshot);
  const roleTransitionInstruction = buildRoleTransitionInstruction(marketplaceSnapshot);
  const planCore = {
    version: 1,
    marketplaceArtifact: MARKETPLACE_JSON,
    marketplaceSnapshotId: marketplaceSnapshot.snapshotId,
    registryId: marketplaceSnapshot.registry.registryId,
    tokenSpecIds: tokenSpecs.map((spec) => spec.specId),
    principalMintEventIds: principalMintEvents.map((event) => event.eventId),
    serviceRevenueCreditEventIds: serviceRevenueCreditEvents.map((event) => event.eventId),
    roleTransitionInstructionId: roleTransitionInstruction?.instructionId || null,
    totalPrincipalUnits: sumSats(principalMintEvents.map((event) => event.eventCore.amountUnits)),
    totalServiceRevenueUnits: sumSats(serviceRevenueCreditEvents.map((event) => event.eventCore.amountUnits)),
    accountingRule: 'principal receipt supply and service revenue accrual are separate ledgers'
  };

  return {
    kind: 'halal_capital_tradelayer_token_plan',
    planId: hashCanonical(planCore),
    planCore,
    marketplaceSnapshot,
    tokenSpecs,
    principalMintEvents,
    serviceRevenueCreditEvents,
    balanceRows,
    roleTransitionInstruction
  };
}

function verifyEventIds(events) {
  for (const event of events || []) {
    if (!event || event.kind !== 'tradelayer_procedural_capital_event') {
      return { ok: false, reason: 'wrong procedural event kind' };
    }
    if (event.eventId !== hashCanonical(event.eventCore)) {
      return { ok: false, reason: `event id mismatch ${event.eventId}` };
    }
  }
  return { ok: true };
}

function verifyHalalCapitalTradeLayerTokenPlan(plan) {
  if (!plan || plan.kind !== 'halal_capital_tradelayer_token_plan') {
    return { ok: false, reason: 'wrong token plan kind' };
  }
  if (plan.planId !== hashCanonical(plan.planCore)) {
    return { ok: false, reason: 'plan id mismatch' };
  }
  const snapshotCheck = verifyHalalCapitalMarketplaceSnapshot(plan.marketplaceSnapshot);
  if (!snapshotCheck.ok) return { ok: false, reason: `marketplace snapshot failed: ${snapshotCheck.reason}` };

  const expectedTokenSpecs = plan.marketplaceSnapshot.registry.templates.map(buildTradeLayerTokenSpec);
  if (stringifyJson(plan.tokenSpecs) !== stringifyJson(expectedTokenSpecs)) {
    return { ok: false, reason: 'token specs mismatch' };
  }
  if (stringifyJson(plan.planCore.tokenSpecIds) !== stringifyJson(expectedTokenSpecs.map((spec) => spec.specId))) {
    return { ok: false, reason: 'token spec id list mismatch' };
  }

  const eventCheck = verifyEventIds([
    ...(plan.principalMintEvents || []),
    ...(plan.serviceRevenueCreditEvents || []),
    plan.roleTransitionInstruction?.burnEvent,
    plan.roleTransitionInstruction?.reissueEvent
  ].filter(Boolean));
  if (!eventCheck.ok) return eventCheck;

  const expectedMintEvents = plan.marketplaceSnapshot.commitments.map(buildPrincipalMintEvent);
  if (stringifyJson(plan.principalMintEvents) !== stringifyJson(expectedMintEvents)) {
    return { ok: false, reason: 'principal mint events mismatch' };
  }

  const commitmentsById = new Map(
    plan.marketplaceSnapshot.commitments.map((commitment) => [commitment.commitmentId, commitment])
  );
  const expectedRevenueEvents = plan.marketplaceSnapshot.revenueEvents.map((event) => (
    buildServiceRevenueCreditEvent(event, commitmentsById.get(event.eventCore.commitmentId))
  ));
  if (stringifyJson(plan.serviceRevenueCreditEvents) !== stringifyJson(expectedRevenueEvents)) {
    return { ok: false, reason: 'service revenue credit events mismatch' };
  }

  const totalPrincipalUnits = sumSats(plan.principalMintEvents.map((event) => event.eventCore.amountUnits));
  const totalServiceRevenueUnits = sumSats(plan.serviceRevenueCreditEvents.map((event) => event.eventCore.amountUnits));
  if (plan.planCore.totalPrincipalUnits !== totalPrincipalUnits) {
    return { ok: false, reason: 'principal total mismatch' };
  }
  if (plan.planCore.totalServiceRevenueUnits !== totalServiceRevenueUnits) {
    return { ok: false, reason: 'service revenue total mismatch' };
  }
  if (plan.planCore.totalPrincipalUnits !== plan.marketplaceSnapshot.snapshotCore.totalActiveCapitalSats) {
    return { ok: false, reason: 'principal total differs from active capital' };
  }
  if (plan.planCore.totalServiceRevenueUnits !== plan.marketplaceSnapshot.snapshotCore.totalServiceRevenueSats) {
    return { ok: false, reason: 'service revenue total differs from marketplace revenue' };
  }

  const expectedRows = buildBalanceRows(plan.marketplaceSnapshot);
  if (stringifyJson(plan.balanceRows) !== stringifyJson(expectedRows)) {
    return { ok: false, reason: 'balance rows mismatch' };
  }

  const expectedTransition = buildRoleTransitionInstruction(plan.marketplaceSnapshot);
  if (stringifyJson(plan.roleTransitionInstruction) !== stringifyJson(expectedTransition)) {
    return { ok: false, reason: 'role transition instruction mismatch' };
  }
  if (expectedTransition && !expectedTransition.instructionCore.burnBeforeReissue) {
    return { ok: false, reason: 'role transition does not burn before reissue' };
  }

  return {
    ok: true,
    planId: plan.planId,
    totalPrincipalUnits,
    totalServiceRevenueUnits,
    tokenSpecCount: plan.tokenSpecs.length
  };
}

function renderTokenPlanMarkdown(plan) {
  const lines = [];
  lines.push('# Halal Capital TradeLayer Token Plan');
  lines.push('');
  lines.push(`- Plan id: \`${plan.planId}\``);
  lines.push(`- Marketplace snapshot: \`${plan.planCore.marketplaceSnapshotId}\``);
  lines.push(`- Principal receipt supply: \`${plan.planCore.totalPrincipalUnits}\``);
  lines.push(`- Service revenue accrual: \`${plan.planCore.totalServiceRevenueUnits}\``);
  lines.push(`- Token specs: \`${plan.tokenSpecs.length}\``);
  lines.push('');
  lines.push('## Procedural Flow');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart LR');
  lines.push('  C[capital commitment] --> M[mint principal receipt]');
  lines.push('  M --> P[TradeLayer propertyId token]');
  lines.push('  S[measured service revenue] --> R[credit service revenue ledger]');
  lines.push('  P --> B[burn or retire]');
  lines.push('  B --> N[reissue into new propertyId]');
  lines.push('  P --> X[attempt same outpoint in another active role]');
  lines.push('  X --> Reject[reject]');
  lines.push('```');
  lines.push('');
  lines.push('## Property Balances');
  lines.push('');
  lines.push('| propertyId | symbol | role | principal units | service revenue units | commitments |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const row of plan.balanceRows) {
    lines.push(
      `| ${row.propertyId} | ${row.symbol} | ${row.activeRole} | ${row.principalSupplyUnits} | ${row.accruedServiceRevenueUnits} | ${row.activeCommitmentCount} |`
    );
  }
  lines.push('');
  lines.push('## Accounting Boundary');
  lines.push('');
  lines.push('Principal receipt supply is a claim on committed backing sats. Service revenue is a separate accrual ledger entry. The verifier can therefore reject hidden leverage by checking that active principal receipts sum to active committed capital, while revenue credits sum only to measured service events.');
  if (plan.roleTransitionInstruction) {
    lines.push('');
    lines.push('## Burn Before Reissue');
    lines.push('');
    lines.push(`- Instruction id: \`${plan.roleTransitionInstruction.instructionId}\``);
    lines.push(`- Burn event: \`${plan.roleTransitionInstruction.burnEvent.eventId}\``);
    lines.push(`- Reissue event: \`${plan.roleTransitionInstruction.reissueEvent.eventId}\``);
    lines.push(`- Old status required: \`${plan.roleTransitionInstruction.instructionCore.oldStatusRequired}\``);
  }
  return lines.join('\n');
}

function writeHalalCapitalTradeLayerTokenPlan(plan, outJsonPath = OUT_JSON, outMdPath = OUT_MD) {
  ensureDir(path.dirname(outJsonPath));
  fs.writeFileSync(outJsonPath, stringifyJson(plan, true));
  fs.writeFileSync(outMdPath, renderTokenPlanMarkdown(plan));
  return { outJsonPath, outMdPath };
}

function run() {
  const plan = buildHalalCapitalTradeLayerTokenPlan();
  const verification = verifyHalalCapitalTradeLayerTokenPlan(plan);
  if (!verification.ok) {
    throw new Error(verification.reason);
  }
  const written = writeHalalCapitalTradeLayerTokenPlan(plan);
  console.log('=== Halal Capital TradeLayer Token Plan ===');
  console.log(`planId=${plan.planId}`);
  console.log(`tokenSpecs=${plan.tokenSpecs.length}`);
  console.log(`principalUnits=${plan.planCore.totalPrincipalUnits}`);
  console.log(`serviceRevenueUnits=${plan.planCore.totalServiceRevenueUnits}`);
  console.log(`jsonPath=${written.outJsonPath}`);
  console.log(`mdPath=${written.outMdPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Halal capital TradeLayer token plan failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  OUT_JSON,
  OUT_MD,
  buildTradeLayerTokenSpec,
  buildPrincipalMintEvent,
  buildServiceRevenueCreditEvent,
  buildRoleTransitionInstruction,
  buildBalanceRows,
  buildHalalCapitalTradeLayerTokenPlan,
  verifyHalalCapitalTradeLayerTokenPlan,
  writeHalalCapitalTradeLayerTokenPlan,
  renderTokenPlanMarkdown
};
