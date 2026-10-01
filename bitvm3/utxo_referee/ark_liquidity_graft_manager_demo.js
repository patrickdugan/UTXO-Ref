#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildArkLiquidityGraftManagerBundle,
  verifyArkLiquidityGraftManagerBundle
} = require('./ark_liquidity_graft_manager');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const LEASE_PATH = path.join(ARTIFACT_DIR, 'lightning_liquidity_lease_latest.json');
const SUBSWAP_PATH = path.join(ARTIFACT_DIR, 'lightning_subswap_dlc_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'ark_liquidity_graft_manager_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'ark_liquidity_graft_manager_latest.md');

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function renderMarkdown(bundle, verification) {
  const inventory = bundle.inventory.inventoryCore;
  const policy = bundle.policy.policyCore;
  const allocation = bundle.allocation;
  const cost = bundle.costModel.modelCore;
  return `# Ark Liquidity Graft Manager With BitVM Enforcement

## Thesis

${bundle.thesis}

The manager is the operator-facing layer: it chooses Ark VTXOs, binds each to
a Lightning route quote, records settlement observations, and emits BitVM
challenge evidence when the ASP/LSP path fails.

## Inventory

- ASP: ${inventory.aspId}
- Inventory id: \`${bundle.inventory.inventoryId}\`
- Template commitment: \`${inventory.templateCommitmentId}\`
- VTXOs available: ${inventory.vtxos.length}
- Total VTXO sats: ${inventory.vtxos.reduce((sum, vtxo) => sum + BigInt(vtxo.vtxoAmountSats), 0n).toString()}

## BitVM Policy

- Policy id: \`${bundle.policy.policyId}\`
- Governor circuit: ${policy.governorCircuitId}
- ASP bond outpoint: \`${policy.aspBondOutpoint}\`
- Max ASP exposure: ${policy.maxAspExposureSats} sats
- Slash reserve: ${policy.slashReserveSats} sats
- Challenge window: ${policy.challengeWindowBlocks} blocks
- Requires exit path: ${policy.requireExitPath}
- Requires forfeit path: ${policy.requireForfeitPath}

## Allocation

- Allocation id: \`${allocation.allocationId}\`
- Requested inbound: ${allocation.totals.requestedInboundSats} sats
- Assigned inbound: ${allocation.totals.assignedInboundSats} sats
- Delivered inbound: ${allocation.totals.deliveredInboundSats} sats
- Settled assignments: ${allocation.totals.settledAssignments}
- Slashable assignments: ${allocation.totals.slashableAssignments}
- Unmet routes: ${allocation.unmetRoutes.length}

${allocation.assignments
  .map(
    assignment => `### ${assignment.assignmentCore.routeId}

- Status: ${assignment.assignmentCore.status}
- Assignment id: \`${assignment.assignmentId}\`
- VTXO commitment: \`${assignment.vtxo.vtxoCommitmentId}\`
- Quote id: \`${assignment.quote.quoteId}\`
- Promised inbound: ${assignment.assignmentCore.promisedInboundSats} sats
- Delivered inbound: ${assignment.assignmentCore.deliveredInboundSats} sats
- Settlement id: \`${assignment.settlementEvidence.settlementId}\`
- Challenge id: \`${assignment.challengeEvidence.challengeId}\`
- Challengeable: ${assignment.challengeEvidence.slashable}
- Violations: ${assignment.challengeEvidence.challengeCore.violations.join(', ') || 'none'}
`
  )
  .join('\n')}

## Manager Challenge

- Challenge id: \`${bundle.challengeEvidence.challengeId}\`
- Slashable: ${bundle.challengeEvidence.slashable}
- Violations: ${bundle.challengeEvidence.challengeCore.violations.join(', ') || 'none'}
- Remedy: ${bundle.challengeEvidence.remedy}

## Cost Model

- Grafts modeled: ${cost.graftCount}
- Average graft amount: ${cost.graftAmountSats} sats
- Baseline per graft: ${cost.baseline.perGraftSats} sats
- Ark per graft: ${cost.ark.perGraftSats} sats
- Baseline total: ${cost.baseline.totalSats} sats
- Ark total: ${cost.ark.totalSats} sats
- Savings: ${cost.comparison.savingsSats} sats
- Lower total cost: ${cost.comparison.lowerTotalCost}

## Verification

- Result: ${verification.ok ? 'ok' : verification.reason}

## Caveats

${bundle.caveats.map(item => `- ${item}`).join('\n')}
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const liquidityLease = readJsonIfPresent(LEASE_PATH);
  const htlcProof = readJsonIfPresent(SUBSWAP_PATH);

  const bundle = buildArkLiquidityGraftManagerBundle({
    managerId: 'ark-ln-liquidity-manager-regtest',
    aspId: 'ark-asp-regtest',
    templateId: 'ark-template-ln-manager-v1',
    inventoryEpoch: 'regtest-ark-liquidity-epoch-1',
    demandEpoch: 'regtest-ln-routes-1',
    vtxoAmountsSats: [50000n, 75000n, 100000n, 125000n],
    routeIntents: [
      { routeId: 'ldk-edge-a-inbound', edgeNodeId: 'ldk-node-a', requestedInboundSats: 50000n, priority: 3, maxFeePpm: 900 },
      { routeId: 'ldk-edge-b-inbound', edgeNodeId: 'ldk-node-b', requestedInboundSats: 75000n, priority: 2, maxFeePpm: 1000 },
      { routeId: 'ldk-edge-c-inbound', edgeNodeId: 'ldk-node-c', requestedInboundSats: 100000n, priority: 1, maxFeePpm: 1100 }
    ],
    routeObservations: [
      {
        routeId: 'ldk-edge-c-inbound',
        deliveredInboundSats: 65000n,
        observedFeePpm: 1600,
        observedCltvDelta: 65,
        missingForfeitPath: true
      }
    ],
    liquidityLease,
    htlcProof,
    slashReserveSats: 25000n,
    maxAspExposureSats: 400000n,
    graftPremiumSats: 750n,
    graftCount: 3,
    feeRateSatVb: 25,
    arkRoundParticipants: 32,
    bitvmChallengeReserveSats: 25000n
  });
  const verification = verifyArkLiquidityGraftManagerBundle(bundle);
  const artifact = { ...bundle, verification };

  fs.writeFileSync(JSON_OUT, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(bundle, verification));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
}

if (require.main === module) {
  main();
}
