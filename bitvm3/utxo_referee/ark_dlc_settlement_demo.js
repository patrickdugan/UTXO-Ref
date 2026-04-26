#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildArkDlcSettlementBundle,
  verifyArkDlcSettlementBundle
} = require('./ark_dlc_settlement');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const JSON_OUT = path.join(ARTIFACT_DIR, 'ark_dlc_settlement_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'ark_dlc_settlement_latest.md');

function renderMarkdown(bundle, verification) {
  const c = bundle.contract.contractCore;
  const s = bundle.settlementEvidence.settlementCore;
  const f = bundle.feeModel.modelCore;
  return `# Ark DLC Settlement With BitVM ASP Governor

## Thesis

${bundle.thesis}

## Contract

- Contract: ${c.contractId}
- ASP: ${c.aspId}
- Oracle event: ${c.oracleEventId}
- Total collateral: ${c.totalCollateralSats} sats
- Outcomes: ${c.outcomeCount}
- Contract commitment: \`${bundle.contract.contractCommitmentId}\`
- Virtual CET set: \`${bundle.virtualCetSet.virtualCetSetId}\`

## Happy-Path Settlement

- Settlement id: \`${bundle.settlementEvidence.settlementId}\`
- Oracle outcome: ${s.oracleOutcomeId}
- Selected virtual CET: \`${s.selectedVirtualCetId}\`
- Ark transition: \`${s.arkTransitionId}\`
- No on-chain CET broadcast: ${s.noOnchainCetBroadcast}
- Avoided on-chain CET txid: \`${s.avoidedOnchainCetTxid}\`
- Verification: ${verification.ok ? 'ok' : verification.reason}

## Payouts

${Object.entries(s.payouts)
  .map(([party, payout]) => `- ${party}: ${payout.amountSats} sats to ${payout.arkAddress}`)
  .join('\n')}

## ASP Challenge Case

- Challenge id: \`${bundle.challengeEvidence.challengeId}\`
- Slashable: ${bundle.challengeEvidence.slashable}
- Violations: ${bundle.challengeEvidence.challengeCore.violations.join(', ')}

## Fee Model

- Outcomes modeled: ${f.outcomeCount}
- Fee rate: ${f.feeRateSatVb} sat/vB
- On-chain happy path CET: ${f.onchainHappyPathSats} sats
- On-chain CET fanout exposure: ${f.onchainCetWorstCaseSats} sats
- Ark happy path: ${f.arkHappyPathSats} sats
- Governed Ark with challenge reserve: ${f.governedArkSats} sats
- Avoids on-chain CET happy path: ${f.avoidsOnchainCetHappyPath}
- Avoids CET fanout on-chain exposure: ${f.avoidsCetFanoutOnchainExposure}

## Caveats

${bundle.caveats.map(item => `- ${item}`).join('\n')}
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const bundle = buildArkDlcSettlementBundle({
    contractId: 'ark-dlc-btc-usd-demo',
    aspId: 'ark-asp-regtest',
    oracleEventId: 'btc-usd-2026-06-30',
    arkRoundId: 'ark-round-dlc-settlement-demo',
    oracleOutcomeId: 'btc_up',
    aspSettledOutcomeId: 'btc_down',
    challengeMissingForfeitPath: true,
    outcomeCount: 5000,
    feeRateSatVb: 25,
    cetVbytes: 180,
    arkRoundParticipants: 50,
    aspFeeSats: 250n,
    bitvmChallengeReserveSats: 5000n
  });
  const verification = verifyArkDlcSettlementBundle(bundle);
  fs.writeFileSync(JSON_OUT, `${JSON.stringify({ ...bundle, verification }, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(bundle, verification));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
}

if (require.main === module) {
  main();
}
