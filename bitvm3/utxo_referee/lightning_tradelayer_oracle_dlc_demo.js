#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildLightningTradeLayerOracleDlcBundle,
  verifyLightningTradeLayerOracleDlcBundle
} = require('./lightning_tradelayer_oracle_dlc');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const JSON_OUT = path.join(ARTIFACTS_DIR, 'lightning_tradelayer_oracle_dlc_latest.json');
const MD_OUT = path.join(ARTIFACTS_DIR, 'lightning_tradelayer_oracle_dlc_latest.md');
const BTCTEST_PRICE_PUBLISH_TXID = '22accff5ad661d6bc9fcf8d972ef822305965da866f597dade40ac322124fd63';

function stringifyJson(value) {
  return JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    2
  );
}

function buildMarkdownReport(bundle, verification) {
  const contract = bundle.contract.contractCore;
  const trigger = bundle.trigger;
  const settlement = bundle.settlement.settlementCore;
  const challenge = bundle.challenge.challengeCore;
  const gateTotal = bundle.bitvmOrganizer.gateCounts.reduce((sum, gate) => sum + gate.count, 0);

  return [
    '# Lightning TradeLayer Oracle DLC',
    '',
    `Bundle ID: \`${bundle.bundleId}\``,
    `Verification: ${verification.ok ? 'ok' : verification.reason}`,
    '',
    '## Shape',
    '',
    '- Bilateral DLC collateral is BTC-only and funded by Lightning hold-invoice receipts.',
    '- No TAP asset path is present.',
    '- TradeLayer tx14 OP_RETURN price publication is the oracle trigger.',
    '- BitVM organizes the dispute path over payload inclusion, designated oracle provenance, the 5% solvency band, price bucket selection, and wrong-CET claims.',
    '',
    '## TradeLayer Trigger',
    '',
    `- Publish txid: \`${trigger.publishTxid}\``,
    `- Payload: \`${trigger.payloadText}\``,
    `- OP_RETURN script: \`${trigger.opReturnScriptHex}\``,
    `- Oracle id: \`${trigger.oracleId}\``,
    `- Pair/price: \`${trigger.pair} ${trigger.price}\``,
    `- Designated publisher: \`${trigger.designatedOracleAddress}\``,
    `- Previous accepted mark: \`${trigger.lastAcceptedPrice}\``,
    `- Max deviation: ${trigger.maxDeviationBps} bps`,
    `- Observed deviation: ${trigger.priceDeviationBps} bps (${trigger.solvencyGuard.withinBand ? 'inside band' : 'outside band'})`,
    '',
    '## Contract',
    '',
    `- Contract: \`${contract.contractId}\``,
    `- Oracle policy: designated address hash \`${contract.oraclePolicy.designatedOracleAddressHash}\`, max move ${contract.oraclePolicy.maxDeviationBps} bps`,
    `- Long party: \`${contract.longParty.name}\` / ${contract.longParty.collateralSats} sats`,
    `- Short party: \`${contract.shortParty.name}\` / ${contract.shortParty.collateralSats} sats`,
    `- Outcomes root: \`${contract.outcomesRoot}\``,
    '',
    '## Settlement',
    '',
    `- Selected outcome: \`${settlement.selectedOutcomeId}\``,
    `- Long payout: ${settlement.longPayoutSats} sats`,
    `- Short payout: ${settlement.shortPayoutSats} sats`,
    `- Settlement rail: \`${settlement.settlementRail}\``,
    '',
    '## BitVM Organizer',
    '',
    `- Organizer id: \`${bundle.bitvmOrganizer.organizerId}\``,
    `- Circuit gates: ${gateTotal}`,
    `- Challenge violations in demo: ${challenge.violations.join(', ')}`,
    '',
    '## Boundary',
    '',
    'This is a deterministic protocol artifact. It does not validate all TradeLayer state; the in-protocol BitVM boundary is the designated oracle address plus a 5% maximum move from the previous accepted BTC/USD mark. A live build still needs raw transaction inclusion proofs, real Lightning node receipts, real oracle/admin key policy, and production challenge bond accounting.'
  ].join('\n');
}

function main() {
  const bundle = buildLightningTradeLayerOracleDlcBundle({
    trigger: {
      price: 65000,
      publishTxid: BTCTEST_PRICE_PUBLISH_TXID,
      blockHeight: 132690,
      maturityHeight: 132691
    },
    challengeClaimedOutcomeId: 'price_above_entry'
  });
  const verification = verifyLightningTradeLayerOracleDlcBundle(bundle);
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(JSON_OUT, `${stringifyJson({ ...bundle, verification })}\n`);
  fs.writeFileSync(MD_OUT, `${buildMarkdownReport(bundle, verification)}\n`);

  console.log('Lightning TradeLayer oracle DLC written:');
  console.log(`  ${JSON_OUT}`);
  console.log(`  ${MD_OUT}`);
  console.log(`payload=${bundle.trigger.payloadText}`);
  console.log(`op_return=${bundle.trigger.opReturnScriptHex}`);
  console.log(`verification=${verification.ok ? 'ok' : verification.reason}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMarkdownReport
};
