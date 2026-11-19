#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildDemoScenario, attestDemoOutcome } = require('./fixtures/demo-scenario');
const { buildSettlementPackage, createResearchPartySignatures, finalizeRecoveryPackage } = require('./src/settlement');

function writeJson(dir, name, data) {
  const filename = path.join(dir, name);
  fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return filename;
}

function restoreInFreshProcess(args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'restore.js'), ...args], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    // No inherited API credentials, wallet config or fixture/signing inputs.
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
  });
  if (result.error || result.status !== 0) throw new Error(`public recovery process failed: ${result.error?.message || result.stderr}`);
  return JSON.parse(result.stdout);
}

function runDemo(outputDirectory) {
  const directory = path.resolve(outputDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const scenario = buildDemoScenario();
  const settlementPackage = buildSettlementPackage({
    plan: scenario.plan,
    oracleAnnouncements: scenario.oracles,
    fundingOutpoint: scenario.fundingOutpoint
  });
  const partySignatures = scenario.partySecrets.map((partySecret) => createResearchPartySignatures({
    settlementPackage, partySecret, acknowledgeResearchCrypto: true
  }));
  const recoveryPackage = finalizeRecoveryPackage({ settlementPackage, partySignatures });
  const packagePath = writeJson(directory, 'recovery-package.json', recoveryPackage);
  const pins = {
    planDigest: scenario.plan.planDigest,
    recoveryDigest: recoveryPackage.recoveryDigest,
    fundingOutpoint: scenario.fundingOutpoint
  };
  writeJson(directory, 'wallet-pins.json', pins);
  // Real wallet integration must retain these independently before funding.
  // Co-locating them here is only a reproducible offline fixture convenience.
  const outcome = scenario.plan.outcomes.find((entry) => entry.priceUsdCents === '11000000');
  const allAttestations = attestDemoOutcome(scenario, outcome.outcomeMessage);
  const attestationsPath = writeJson(directory, 'oracle-attestations.json', allAttestations.slice(1));
  const args = ['--package', packagePath, '--plan-digest', pins.planDigest, '--recovery-digest', pins.recoveryDigest];
  const settlement = restoreInFreshProcess([...args, '--outcome', outcome.outcomeMessage, '--attestations', attestationsPath]);
  const refund = restoreInFreshProcess([...args, '--refund']);
  writeJson(directory, 'settlement.json', settlement);
  writeJson(directory, 'refund.json', refund);
  const summary = {
    kind: 'lnmarkets_utxoref_demo_result_v1',
    evidenceTier: 'LOCAL_SIMULATION',
    sampledFromNetwork: false,
    fundedExecutionAllowed: false,
    chainMaturityVerified: false,
    venueConnectionUsedDuringRecovery: false,
    partySigningKeysProvidedToRecovery: false,
    restoreProcesses: 2,
    oraclePolicy: '2 of 3 fixture keys; one omitted during settlement',
    ...pins,
    fundingValueSats: scenario.plan.fundingValueSats,
    settlementFeeSats: scenario.plan.terms.settlementFeeSats,
    anchorSats: scenario.plan.terms.anchorSats,
    outcomeCount: scenario.plan.outcomes.length,
    cetCount: settlementPackage.transactionSet.cets.length,
    payoutTable: scenario.plan.outcomes.map(({ priceUsdCents, traderPayoutSats, makerPayoutSats, capped }) => ({ priceUsdCents, traderPayoutSats, makerPayoutSats, capped })),
    settlement: { txid: settlement.txid, outputs: settlement.outputs, chainMaturityVerified: settlement.chainMaturityVerified },
    refund: { txid: refund.txid, outputs: refund.outputs, refundHeight: refund.refundHeight, refundCsvBlocks: refund.refundCsvBlocks, chainMaturityVerified: refund.chainMaturityVerified },
    files: ['recovery-package.json', 'wallet-pins.json', 'oracle-attestations.json', 'settlement.json', 'refund.json', 'summary.json']
  };
  writeJson(directory, 'summary.json', summary);
  return summary;
}

function main(argv) {
  if (argv.length && (argv.length !== 2 || argv[0] !== '--out' || !argv[1])) throw new Error('Usage: node LNMarkets/demo.js [--out DIRECTORY]');
  const output = argv.length ? argv[1] : path.join(__dirname, 'artifacts', 'demo');
  console.log(JSON.stringify(runDemo(output), null, 2));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { runDemo };
