/**
 * Lightning Integration Prototype Demo
 *
 * Run:
 *   node bitvm3/utxo_referee/lightning_integration_demo.js
 */

const fs = require('fs');
const path = require('path');
const {
  buildAllLightningIntegrationPrototypes,
  verifyLightningPayoutCompression
} = require('./lightning_integration');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'lightning_integration_latest.json');
const REPORT_PATH = path.join(ARTIFACTS_DIR, 'lightning_integration_latest.md');

function stringifyJson(value) {
  return JSON.stringify(
    value,
    (_key, current) => (typeof current === 'bigint' ? current.toString() : current),
    2
  );
}

function buildMarkdownReport(bundle) {
  const { prototypes } = bundle;
  const payoutCheck = verifyLightningPayoutCompression(prototypes.payoutCompression);

  return [
    '# Lightning + BitVM/DLC Prototype Bundle',
    '',
    `Bundle ID: \`${bundle.bundleId}\``,
    '',
    '## Prototypes',
    '',
    `- Lightning-funded position open: \`${prototypes.positionOpen.transcriptId}\``,
    `- Lightning payout compression root: \`${prototypes.payoutCompression.root}\``,
    `- Watchtower bounty: \`${prototypes.watchtowerBounty.bountyId}\``,
    `- LDK/BDK-style contract-open API session: \`${prototypes.contractOpenApi.sessionId}\``,
    `- Lightning-funded rollover root: \`${prototypes.rollover.nextCommitment.root}\``,
    '',
    '## Checks',
    '',
    `- Position atomicity hash lock: ${prototypes.positionOpen.atomicityChecklist.sameHashLocksLightningAndSwap ? 'ok' : 'fail'}`,
    `- Position fee accounting: ${prototypes.positionOpen.atomicityChecklist.feeAccountingBalances ? 'ok' : 'fail'}`,
    `- Payout compression verification: ${payoutCheck.ok ? 'ok' : payoutCheck.reason}`,
    `- Watchtower receipt preimage: ${prototypes.watchtowerBounty.verification.preimageMatchesPaymentHash ? 'ok' : 'fail'}`,
    `- Rollover conservation: ${prototypes.rollover.conservation.holds ? 'ok' : 'fail'}`,
    '',
    '## Production Boundary',
    '',
    'These artifacts are deterministic protocol transcripts. A production implementation still needs real LDK/LND/CLN invoice handling, BDK/Bitcoin Core PSBT signing, mempool policy checks, and live refund-path enforcement.'
  ].join('\n');
}

function main() {
  const bundle = buildAllLightningIntegrationPrototypes();
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, `${stringifyJson(bundle)}\n`);
  fs.writeFileSync(REPORT_PATH, `${buildMarkdownReport(bundle)}\n`);

  console.log('Lightning integration prototypes written:');
  console.log(`  ${OUT_PATH}`);
  console.log(`  ${REPORT_PATH}`);
  console.log(`Bundle ID: ${bundle.bundleId}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildMarkdownReport
};
