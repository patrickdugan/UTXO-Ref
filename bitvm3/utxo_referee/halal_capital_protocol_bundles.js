/**
 * Protocol-specific halal capital demo bundles.
 *
 * Binds property-scoped capital receipts to concrete application artifacts:
 * Lightning lease, Ark liquidity graft, and TradeLayer DLC margin.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');
const {
  buildCapitalRoleTransition,
  verifyCapitalRoleTransition
} = require('./halal_capital_template_registry');
const {
  OUT_JSON: TOKEN_PLAN_JSON,
  buildHalalCapitalTradeLayerTokenPlan,
  verifyHalalCapitalTradeLayerTokenPlan
} = require('./halal_capital_tradelayer_tokens');
const {
  buildLiquidityLeaseBundle,
  verifyLiquidityLeaseBundle
} = require('./lightning_liquidity_lease');
const {
  buildArkLiquidityGraftBundle,
  verifyArkLiquidityGraftBundle
} = require('./lightning_ark_liquidity_graft');
const {
  buildLightningTradeLayerOracleDlcBundle,
  verifyLightningTradeLayerOracleDlcBundle
} = require('./lightning_tradelayer_oracle_dlc');
const {
  buildTradeLayerPerpPnlSettlement,
  verifyTradeLayerPerpPnlSettlement,
  buildTradeLayerPerpPnlChallenge,
  verifyTradeLayerPerpPnlChallenge
} = require('./tradelayer_perp_pnl_referee');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_JSON = path.join(ARTIFACTS_DIR, 'halal_capital_protocol_bundles_latest.json');
const OUT_MD = path.join(ARTIFACTS_DIR, 'halal_capital_protocol_bundles_latest.md');

const PROTOCOL_PROPERTY_IDS = Object.freeze([1101, 3101, 4101]);
const REISSUE_TARGETS = Object.freeze({
  1101: 3101,
  3101: 4101,
  4101: 5101
});

const TL_TEST_ADDRESS_A = 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa';
const TL_TEST_ADDRESS_B = 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22';

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

function eventWithId(eventCore) {
  return {
    kind: 'halal_capital_protocol_transition_event',
    eventId: hashCanonical(eventCore),
    eventCore
  };
}

function findByPropertyId(rows, propertyId, extractor) {
  const row = rows.find((item) => extractor(item) === propertyId);
  if (!row) throw new Error(`missing property ${propertyId}`);
  return row;
}

function findCommitment(tokenPlan, propertyId) {
  return findByPropertyId(
    tokenPlan.marketplaceSnapshot.commitments,
    propertyId,
    (commitment) => commitment.commitmentCore.propertyId
  );
}

function findTokenSpec(tokenPlan, propertyId) {
  return findByPropertyId(
    tokenPlan.tokenSpecs,
    propertyId,
    (spec) => spec.specCore.propertyId
  );
}

function findPrincipalMintEvent(tokenPlan, propertyId) {
  return findByPropertyId(
    tokenPlan.principalMintEvents,
    propertyId,
    (event) => event.eventCore.propertyId
  );
}

function findRevenueCreditEvent(tokenPlan, propertyId) {
  return findByPropertyId(
    tokenPlan.serviceRevenueCreditEvents,
    propertyId,
    (event) => event.eventCore.propertyId
  );
}

function buildSupportingLease(commitment, label) {
  const amountSats = BigInt(commitment.commitmentCore.amountSats);
  const [fundingTxid, fundingVout] = commitment.commitmentCore.fundingOutpoint.split(':');
  const fundingCommitmentHash = sha256Hex(`funding-commitment:${label}:${commitment.commitmentId}`);
  const lease = buildLiquidityLeaseBundle({
    leaseId: `${label}-${commitment.commitmentId.slice(0, 12)}`,
    promisedInboundSats: amountSats,
    leasePremiumSats: amountSats / 1000n || 1n,
    htlcProof: {
      dlcFunding: {
        claimTxid: fundingTxid,
        outputVout: Number(fundingVout),
        commitmentHash: fundingCommitmentHash
      },
      swap: {
        fundingTxid,
        refundLocktime: 410400
      }
    },
    channelOutpoint: commitment.commitmentCore.fundingOutpoint,
    fundingCommitmentHash,
    observedInboundSats: amountSats,
    observedFeePpm: 500,
    observedCltvDelta: 24,
    observedAtBlock: 410100
  });
  return {
    ...lease,
    verification: verifyLiquidityLeaseBundle(lease)
  };
}

function buildLightningLeaseProtocolArtifact(commitment) {
  const lease = buildSupportingLease(commitment, 'hln-lease');
  return {
    kind: 'hln_lease_protocol_artifact',
    artifactId: lease.bundleId,
    artifactCore: {
      protocol: 'lightning',
      bundleId: lease.bundleId,
      offerId: lease.offer.offerId,
      successEvidenceId: lease.successEvidence.evidenceId,
      challengeId: lease.challengeEvidence.challengeId
    },
    lease
  };
}

function buildArkLiquidityProtocolArtifact(commitment) {
  const amountSats = BigInt(commitment.commitmentCore.amountSats);
  const supportingLease = buildSupportingLease(commitment, 'hark-liq-supporting-lease');
  const preimageHex = sha256Hex(`hark-liq-preimage:${commitment.commitmentId}`);
  const paymentHashHex = sha256Hex(Buffer.from(preimageHex, 'hex'));
  const graft = buildArkLiquidityGraftBundle({
    aspId: 'hark-demo-asp',
    templateId: `hark-template-${commitment.commitmentId.slice(0, 12)}`,
    ownerNodeId: commitment.commitmentCore.holderId,
    aspRoundId: `hark-round-${commitment.commitmentId.slice(0, 12)}`,
    connectorOutpoint: commitment.commitmentCore.fundingOutpoint,
    vtxoAmountSats: amountSats,
    promisedInboundSats: amountSats,
    deliveredInboundSats: amountSats,
    graftPremiumSats: amountSats / 1250n || 1n,
    liquidityLease: supportingLease,
    preimageHex,
    paymentHashHex,
    observedFeePpm: 500,
    observedCltvDelta: 24,
    observedBlock: 410220,
    challengeMissingForfeitPath: true
  });
  return {
    kind: 'hark_liq_protocol_artifact',
    artifactId: graft.bundleId,
    artifactCore: {
      protocol: 'ark',
      bundleId: graft.bundleId,
      quoteId: graft.quote.quoteId,
      settlementId: graft.settlementEvidence.settlementId,
      challengeId: graft.challengeEvidence.challengeId,
      supportingLeaseBundleId: supportingLease.bundleId
    },
    supportingLease,
    graft
  };
}

function buildDlcMarginProtocolArtifact(commitment) {
  const amountSats = BigInt(commitment.commitmentCore.amountSats);
  const longCollateralSats = amountSats / 2n;
  const shortCollateralSats = amountSats - longCollateralSats;
  const dlcBundle = buildLightningTradeLayerOracleDlcBundle({
    contract: {
      contractId: `htl-dlcm-${commitment.commitmentId.slice(0, 12)}`,
      longCollateralSats,
      shortCollateralSats,
      entryPrice: '65000',
      lastAcceptedPrice: '64000'
    },
    trigger: {
      price: '65100',
      blockHeight: 410300,
      maturityHeight: 410301
    },
    challengeClaimedOutcomeId: 'price_below_entry'
  });
  const perpSettlement = buildTradeLayerPerpPnlSettlement({
    network: 'litecoin-testnet',
    epochId: 4101,
    position: {
      contractId: `htl-dlcm-perp-${commitment.commitmentId.slice(0, 12)}`,
      side: 'long',
      entryPrice: 65000,
      quantityUnits: 10,
      collateralSats: amountSats,
      traderAddress: TL_TEST_ADDRESS_A,
      counterpartyAddress: TL_TEST_ADDRESS_B
    },
    close: {
      price: 65125,
      vwap: { price: 65125, samples: 5 }
    }
  });
  const perpChallenge = buildTradeLayerPerpPnlChallenge(perpSettlement);
  const artifactCore = {
    protocol: 'tradelayer_dlc_margin',
    dlcBundleId: dlcBundle.bundleId,
    perpSettlementHash: perpSettlement.settlementHash,
    perpChallengeHash: perpChallenge.challengeHash
  };

  return {
    kind: 'htl_dlcm_protocol_artifact',
    artifactId: hashCanonical(artifactCore),
    artifactCore,
    dlcBundle,
    perpSettlement,
    perpChallenge
  };
}

function buildProtocolArtifact(propertyId, commitment) {
  if (propertyId === 1101) return buildLightningLeaseProtocolArtifact(commitment);
  if (propertyId === 3101) return buildArkLiquidityProtocolArtifact(commitment);
  if (propertyId === 4101) return buildDlcMarginProtocolArtifact(commitment);
  throw new Error(`unsupported protocol propertyId ${propertyId}`);
}

function verifyProtocolArtifact(propertyId, artifact) {
  if (propertyId === 1101) {
    if (!artifact || artifact.kind !== 'hln_lease_protocol_artifact') {
      return { ok: false, reason: 'wrong HLN-LEASE artifact kind' };
    }
    if (artifact.artifactId !== artifact.lease.bundleId) {
      return { ok: false, reason: 'HLN-LEASE artifact id mismatch' };
    }
    return verifyLiquidityLeaseBundle(artifact.lease);
  }
  if (propertyId === 3101) {
    if (!artifact || artifact.kind !== 'hark_liq_protocol_artifact') {
      return { ok: false, reason: 'wrong HARK-LIQ artifact kind' };
    }
    if (artifact.artifactId !== artifact.graft.bundleId) {
      return { ok: false, reason: 'HARK-LIQ artifact id mismatch' };
    }
    const supportingLease = verifyLiquidityLeaseBundle(artifact.supportingLease);
    if (!supportingLease.ok) return { ok: false, reason: `supporting lease failed: ${supportingLease.reason}` };
    return verifyArkLiquidityGraftBundle(artifact.graft);
  }
  if (propertyId === 4101) {
    if (!artifact || artifact.kind !== 'htl_dlcm_protocol_artifact') {
      return { ok: false, reason: 'wrong HTL-DLCM artifact kind' };
    }
    if (artifact.artifactId !== hashCanonical(artifact.artifactCore)) {
      return { ok: false, reason: 'HTL-DLCM artifact id mismatch' };
    }
    const dlc = verifyLightningTradeLayerOracleDlcBundle(artifact.dlcBundle);
    if (!dlc.ok) return { ok: false, reason: `DLC bundle failed: ${dlc.reason}` };
    const settlement = verifyTradeLayerPerpPnlSettlement(artifact.perpSettlement);
    if (!settlement.ok) return { ok: false, reason: `perp settlement failed: ${settlement.reason}` };
    const challenge = verifyTradeLayerPerpPnlChallenge(artifact.perpChallenge, artifact.perpSettlement);
    if (!challenge.ok) return { ok: false, reason: `perp challenge failed: ${challenge.reason}` };
    return { ok: true };
  }
  return { ok: false, reason: `unsupported protocol propertyId ${propertyId}` };
}

function buildProtocolRetirementFlow({ commitment, tokenSpec, principalMintEvent, toPropertyId }) {
  const transition = buildCapitalRoleTransition({
    fromCommitment: commitment,
    toPropertyId,
    burnReceiptId: `burn:${principalMintEvent.eventId}`,
    reissueReceiptId: `reissue:${principalMintEvent.eventId}:${toPropertyId}`
  });
  const retiredCommitment = {
    ...commitment,
    commitmentCore: {
      ...commitment.commitmentCore,
      status: 'retired'
    }
  };
  const verification = verifyCapitalRoleTransition(transition, retiredCommitment);
  const burnEvent = eventWithId({
    version: 1,
    eventType: 'retire_protocol_capital_receipt',
    propertyId: commitment.commitmentCore.propertyId,
    templateId: commitment.commitmentCore.templateId,
    commitmentId: commitment.commitmentId,
    tokenSpecId: tokenSpec.specId,
    principalMintEventId: principalMintEvent.eventId,
    amountUnits: commitment.commitmentCore.amountSats,
    fundingOutpoint: commitment.commitmentCore.fundingOutpoint,
    transitionId: transition.transitionId
  });
  const reissueEvent = eventWithId({
    version: 1,
    eventType: 'reissue_protocol_capital_receipt',
    propertyId: toPropertyId,
    sourcePropertyId: commitment.commitmentCore.propertyId,
    sourceCommitmentId: commitment.commitmentId,
    sourceBurnEventId: burnEvent.eventId,
    amountUnits: commitment.commitmentCore.amountSats,
    fundingOutpoint: commitment.commitmentCore.fundingOutpoint,
    transitionId: transition.transitionId
  });
  const flowCore = {
    version: 1,
    fromPropertyId: commitment.commitmentCore.propertyId,
    toPropertyId,
    transitionId: transition.transitionId,
    burnEventId: burnEvent.eventId,
    reissueEventId: reissueEvent.eventId,
    oldStatusRequired: transition.transitionCore.requiresOldCommitmentStatus,
    burnBeforeReissue: transition.transitionCore.burnBeforeReissue,
    rehypothecationAllowed: transition.transitionCore.rehypothecationAllowed
  };

  return {
    kind: 'halal_capital_protocol_retirement_flow',
    flowId: hashCanonical(flowCore),
    flowCore,
    transition,
    retiredCommitment,
    verification,
    burnEvent,
    reissueEvent
  };
}

function verifyProtocolRetirementFlow(flow, bundleCore) {
  if (!flow || flow.kind !== 'halal_capital_protocol_retirement_flow') {
    return { ok: false, reason: 'wrong retirement flow kind' };
  }
  if (flow.flowId !== hashCanonical(flow.flowCore)) {
    return { ok: false, reason: 'retirement flow id mismatch' };
  }
  if (flow.flowCore.fromPropertyId !== bundleCore.propertyId) {
    return { ok: false, reason: 'retirement flow source property mismatch' };
  }
  if (!flow.flowCore.burnBeforeReissue || flow.flowCore.rehypothecationAllowed !== false) {
    return { ok: false, reason: 'retirement flow must burn before reissue without rehypothecation' };
  }
  if (flow.burnEvent.eventId !== hashCanonical(flow.burnEvent.eventCore)) {
    return { ok: false, reason: 'burn event id mismatch' };
  }
  if (flow.reissueEvent.eventId !== hashCanonical(flow.reissueEvent.eventCore)) {
    return { ok: false, reason: 'reissue event id mismatch' };
  }
  const transitionCheck = verifyCapitalRoleTransition(flow.transition, flow.retiredCommitment);
  if (!transitionCheck.ok) return transitionCheck;
  return { ok: true };
}

function buildPropertyProtocolBundle(propertyId, options = {}) {
  const tokenPlan = options.tokenPlan || buildHalalCapitalTradeLayerTokenPlan(options);
  const commitment = findCommitment(tokenPlan, propertyId);
  const tokenSpec = findTokenSpec(tokenPlan, propertyId);
  const principalMintEvent = findPrincipalMintEvent(tokenPlan, propertyId);
  const serviceRevenueCreditEvent = findRevenueCreditEvent(tokenPlan, propertyId);
  const protocolArtifact = options.protocolArtifact || buildProtocolArtifact(propertyId, commitment);
  const protocolVerification = verifyProtocolArtifact(propertyId, protocolArtifact);
  const retirementFlow = buildProtocolRetirementFlow({
    commitment,
    tokenSpec,
    principalMintEvent,
    toPropertyId: REISSUE_TARGETS[propertyId]
  });
  const bundleCore = {
    version: 1,
    propertyId,
    symbol: tokenSpec.specCore.symbol,
    activeRole: tokenSpec.specCore.activeRole,
    targetProtocol: tokenSpec.specCore.targetProtocol,
    commitmentId: commitment.commitmentId,
    tokenSpecId: tokenSpec.specId,
    principalMintEventId: principalMintEvent.eventId,
    serviceRevenueCreditEventId: serviceRevenueCreditEvent.eventId,
    serviceRevenueUnits: serviceRevenueCreditEvent.eventCore.amountUnits,
    protocolArtifactKind: protocolArtifact.kind,
    protocolArtifactId: protocolArtifact.artifactId,
    protocolVerificationOk: protocolVerification.ok,
    retirementFlowId: retirementFlow.flowId,
    reissueTargetPropertyId: REISSUE_TARGETS[propertyId],
    jurassicMechanismRefId: commitment.commitmentCore.jurassicMechanismRefId,
    publicHandleId: commitment.commitmentCore.publicHandleId,
    carrierCommitmentId: commitment.commitmentCore.carrierCommitmentId
  };

  return {
    kind: 'halal_capital_property_protocol_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    commitment,
    tokenSpec,
    principalMintEvent,
    serviceRevenueCreditEvent,
    protocolArtifact,
    protocolVerification,
    retirementFlow
  };
}

function verifyPropertyProtocolBundle(bundle, tokenPlan = null) {
  if (!bundle || bundle.kind !== 'halal_capital_property_protocol_bundle') {
    return { ok: false, reason: 'wrong property protocol bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'property protocol bundle id mismatch' };
  }
  const { propertyId } = bundle.bundleCore;
  if (bundle.commitment.commitmentCore.propertyId !== propertyId) {
    return { ok: false, reason: 'commitment property mismatch' };
  }
  if (bundle.tokenSpec.specCore.propertyId !== propertyId) {
    return { ok: false, reason: 'token spec property mismatch' };
  }
  if (bundle.principalMintEvent.eventCore.propertyId !== propertyId) {
    return { ok: false, reason: 'principal mint property mismatch' };
  }
  if (bundle.serviceRevenueCreditEvent.eventCore.propertyId !== propertyId) {
    return { ok: false, reason: 'service revenue property mismatch' };
  }
  if (bundle.bundleCore.serviceRevenueUnits !== bundle.serviceRevenueCreditEvent.eventCore.amountUnits) {
    return { ok: false, reason: 'service revenue units mismatch' };
  }
  const protocolVerification = verifyProtocolArtifact(propertyId, bundle.protocolArtifact);
  if (!protocolVerification.ok) return protocolVerification;
  if (!bundle.bundleCore.protocolVerificationOk) {
    return { ok: false, reason: 'bundle core records protocol verification failure' };
  }
  if (bundle.bundleCore.protocolArtifactId !== bundle.protocolArtifact.artifactId) {
    return { ok: false, reason: 'protocol artifact id mismatch' };
  }
  const retirement = verifyProtocolRetirementFlow(bundle.retirementFlow, bundle.bundleCore);
  if (!retirement.ok) return retirement;

  if (tokenPlan) {
    if (findCommitment(tokenPlan, propertyId).commitmentId !== bundle.commitment.commitmentId) {
      return { ok: false, reason: 'token plan commitment mismatch' };
    }
    if (findTokenSpec(tokenPlan, propertyId).specId !== bundle.tokenSpec.specId) {
      return { ok: false, reason: 'token plan spec mismatch' };
    }
    if (findPrincipalMintEvent(tokenPlan, propertyId).eventId !== bundle.principalMintEvent.eventId) {
      return { ok: false, reason: 'token plan principal mint mismatch' };
    }
    if (findRevenueCreditEvent(tokenPlan, propertyId).eventId !== bundle.serviceRevenueCreditEvent.eventId) {
      return { ok: false, reason: 'token plan revenue credit mismatch' };
    }
  }

  return { ok: true };
}

function buildHalalCapitalProtocolBundlePortfolio(options = {}) {
  const tokenPlan = options.tokenPlan || buildHalalCapitalTradeLayerTokenPlan(options);
  const propertyIds = options.propertyIds || PROTOCOL_PROPERTY_IDS;
  const protocolBundles = propertyIds.map((propertyId) => buildPropertyProtocolBundle(propertyId, {
    ...options,
    tokenPlan
  }));
  const portfolioCore = {
    version: 1,
    tokenPlanArtifact: TOKEN_PLAN_JSON,
    tokenPlanId: tokenPlan.planId,
    marketplaceSnapshotId: tokenPlan.marketplaceSnapshot.snapshotId,
    propertyIds,
    protocolBundleIds: protocolBundles.map((bundle) => bundle.bundleId),
    totalPrincipalUnits: tokenPlan.planCore.totalPrincipalUnits,
    coveredPrincipalUnits: protocolBundles
      .reduce((sum, bundle) => sum + BigInt(bundle.principalMintEvent.eventCore.amountUnits), 0n)
      .toString(),
    coveredServiceRevenueUnits: protocolBundles
      .reduce((sum, bundle) => sum + BigInt(bundle.serviceRevenueCreditEvent.eventCore.amountUnits), 0n)
      .toString()
  };

  return {
    kind: 'halal_capital_protocol_bundle_portfolio',
    portfolioId: hashCanonical(portfolioCore),
    portfolioCore,
    tokenPlan,
    protocolBundles
  };
}

function verifyHalalCapitalProtocolBundlePortfolio(portfolio) {
  if (!portfolio || portfolio.kind !== 'halal_capital_protocol_bundle_portfolio') {
    return { ok: false, reason: 'wrong protocol bundle portfolio kind' };
  }
  if (portfolio.portfolioId !== hashCanonical(portfolio.portfolioCore)) {
    return { ok: false, reason: 'protocol portfolio id mismatch' };
  }
  const tokenPlan = verifyHalalCapitalTradeLayerTokenPlan(portfolio.tokenPlan);
  if (!tokenPlan.ok) return { ok: false, reason: `token plan failed: ${tokenPlan.reason}` };
  const propertyIds = portfolio.protocolBundles.map((bundle) => bundle.bundleCore.propertyId);
  if (stringifyJson(propertyIds) !== stringifyJson(portfolio.portfolioCore.propertyIds)) {
    return { ok: false, reason: 'portfolio property id list mismatch' };
  }
  if (stringifyJson(portfolio.protocolBundles.map((bundle) => bundle.bundleId)) !== stringifyJson(portfolio.portfolioCore.protocolBundleIds)) {
    return { ok: false, reason: 'portfolio bundle id list mismatch' };
  }
  for (const bundle of portfolio.protocolBundles) {
    const result = verifyPropertyProtocolBundle(bundle, portfolio.tokenPlan);
    if (!result.ok) return { ok: false, reason: `property ${bundle.bundleCore.propertyId} failed: ${result.reason}` };
  }
  const coveredPrincipalUnits = portfolio.protocolBundles
    .reduce((sum, bundle) => sum + BigInt(bundle.principalMintEvent.eventCore.amountUnits), 0n)
    .toString();
  const coveredServiceRevenueUnits = portfolio.protocolBundles
    .reduce((sum, bundle) => sum + BigInt(bundle.serviceRevenueCreditEvent.eventCore.amountUnits), 0n)
    .toString();
  if (portfolio.portfolioCore.coveredPrincipalUnits !== coveredPrincipalUnits) {
    return { ok: false, reason: 'covered principal mismatch' };
  }
  if (portfolio.portfolioCore.coveredServiceRevenueUnits !== coveredServiceRevenueUnits) {
    return { ok: false, reason: 'covered service revenue mismatch' };
  }
  return {
    ok: true,
    portfolioId: portfolio.portfolioId,
    protocolBundleCount: portfolio.protocolBundles.length,
    coveredPrincipalUnits,
    coveredServiceRevenueUnits
  };
}

function renderProtocolBundleMarkdown(portfolio) {
  const lines = [];
  lines.push('# Halal Capital Protocol Bundles');
  lines.push('');
  lines.push(`- Portfolio id: \`${portfolio.portfolioId}\``);
  lines.push(`- Token plan id: \`${portfolio.tokenPlan.planId}\``);
  lines.push(`- Covered principal units: \`${portfolio.portfolioCore.coveredPrincipalUnits}\``);
  lines.push(`- Covered service revenue units: \`${portfolio.portfolioCore.coveredServiceRevenueUnits}\``);
  lines.push('');
  lines.push('## Protocol Flow');
  lines.push('');
  lines.push('```mermaid');
  lines.push('flowchart LR');
  lines.push('  P[propertyId receipt] --> A[protocol artifact]');
  lines.push('  A --> R[measured service revenue]');
  lines.push('  R --> C[revenue credit event]');
  lines.push('  P --> B[burn/retire principal receipt]');
  lines.push('  B --> N[reissue into next propertyId]');
  lines.push('  A --> V[UTXORef verifier]');
  lines.push('```');
  lines.push('');
  lines.push('## Bundles');
  lines.push('');
  lines.push('| propertyId | symbol | protocol artifact | service revenue | reissue target | verification |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const bundle of portfolio.protocolBundles) {
    lines.push(
      `| ${bundle.bundleCore.propertyId} | ${bundle.bundleCore.symbol} | ${bundle.bundleCore.protocolArtifactKind} | ${bundle.bundleCore.serviceRevenueUnits} | ${bundle.bundleCore.reissueTargetPropertyId} | ${bundle.protocolVerification.ok ? 'ok' : bundle.protocolVerification.reason} |`
    );
  }
  lines.push('');
  lines.push('## Property Notes');
  for (const bundle of portfolio.protocolBundles) {
    lines.push('');
    lines.push(`### ${bundle.bundleCore.symbol}`);
    lines.push('');
    lines.push(`- Bundle id: \`${bundle.bundleId}\``);
    lines.push(`- Commitment id: \`${bundle.commitment.commitmentId}\``);
    lines.push(`- Protocol artifact id: \`${bundle.bundleCore.protocolArtifactId}\``);
    lines.push(`- Public handle: \`${bundle.bundleCore.publicHandleId}\``);
    lines.push(`- Carrier commitment: \`${bundle.bundleCore.carrierCommitmentId}\``);
    lines.push(`- Retirement flow: \`${bundle.retirementFlow.flowId}\``);
  }
  return lines.join('\n');
}

function writeHalalCapitalProtocolBundlePortfolio(portfolio, outJsonPath = OUT_JSON, outMdPath = OUT_MD) {
  ensureDir(path.dirname(outJsonPath));
  fs.writeFileSync(outJsonPath, stringifyJson(portfolio, true));
  fs.writeFileSync(outMdPath, renderProtocolBundleMarkdown(portfolio));
  return { outJsonPath, outMdPath };
}

function run() {
  const portfolio = buildHalalCapitalProtocolBundlePortfolio();
  const verification = verifyHalalCapitalProtocolBundlePortfolio(portfolio);
  if (!verification.ok) {
    throw new Error(verification.reason);
  }
  const written = writeHalalCapitalProtocolBundlePortfolio(portfolio);
  console.log('=== Halal Capital Protocol Bundles ===');
  console.log(`portfolioId=${portfolio.portfolioId}`);
  console.log(`protocolBundles=${portfolio.protocolBundles.length}`);
  console.log(`coveredPrincipalUnits=${portfolio.portfolioCore.coveredPrincipalUnits}`);
  console.log(`coveredServiceRevenueUnits=${portfolio.portfolioCore.coveredServiceRevenueUnits}`);
  console.log(`jsonPath=${written.outJsonPath}`);
  console.log(`mdPath=${written.outMdPath}`);
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error('Halal capital protocol bundle generation failed:', err.message);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  OUT_JSON,
  OUT_MD,
  PROTOCOL_PROPERTY_IDS,
  REISSUE_TARGETS,
  buildProtocolArtifact,
  verifyProtocolArtifact,
  buildProtocolRetirementFlow,
  verifyProtocolRetirementFlow,
  buildPropertyProtocolBundle,
  verifyPropertyProtocolBundle,
  buildHalalCapitalProtocolBundlePortfolio,
  verifyHalalCapitalProtocolBundlePortfolio,
  writeHalalCapitalProtocolBundlePortfolio,
  renderProtocolBundleMarkdown
};
