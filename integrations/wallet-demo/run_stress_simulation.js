#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { buildWalletDemoConfig } = require('./walletBackendProfiles');
const { buildStressDashboard, verifyStressDashboard } = require('./stressDashboard');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ARTIFACT_DIR = path.join(REPO_ROOT, 'bitvm3', 'utxo_referee', 'artifacts');
const PATCH_PATH = path.join(ARTIFACT_DIR, 'lnbtc_tlusd_liquidity_patch_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'wallet_stress_simulation_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'wallet_stress_simulation_latest.md');

function parseArgs(argv) {
  const options = {
    scenarios: [96, 512, 2048, 5000],
    profile: process.env.WALLET_DEMO_PROFILE || 'litecoin-testnet-local',
    ltcUsdPriceMicros: 85000000n
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--bots') {
      options.scenarios = [Number(argv[++i])];
    } else if (arg === '--scenarios') {
      options.scenarios = argv[++i].split(',').map(value => Number(value.trim())).filter(Boolean);
    } else if (arg === '--profile') {
      options.profile = argv[++i];
    } else if (arg === '--ltc-usd-micros') {
      options.ltcUsdPriceMicros = BigInt(argv[++i]);
    } else if (arg === '--help') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function pctBps(bps) {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

function summarizeDashboard(dashboard, elapsedMs) {
  const totals = dashboard.totals;
  return {
    botCount: totals.botCount,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    verification: verifyStressDashboard(dashboard),
    tltcCollateralSats: totals.tltcCollateralSats,
    tltcCollateralDisplay: totals.tltcCollateralDisplay,
    tlusdStakedUnits: totals.tlusdStakedUnits,
    tlusdStakedDisplay: totals.tlusdStakedDisplay,
    assignedInboundSats: totals.assignedInboundSats,
    deliveredInboundSats: totals.deliveredInboundSats,
    deliveryBps: totals.deliveryBps,
    challengeCount: totals.challengeCount,
    activeBots: totals.activeBots,
    verifyingBots: totals.verifyingBots,
    routeCount: totals.routeCount,
    arkVtxoCount: totals.arkVtxoCount,
    averageFeePpm: totals.averageFeePpm,
    earnedFeesSats: totals.earnedFeesSats,
    arkSavingsSats: totals.arkSavingsSats,
    sampleChallengeQueue: dashboard.challengeQueue.slice(0, 5)
  };
}

function runScenario({ patch, config, botCount, ltcUsdPriceMicros }) {
  const started = performance.now();
  const dashboard = buildStressDashboard({
    patch,
    config,
    botCount,
    ltcUsdPriceMicros
  });
  const elapsedMs = performance.now() - started;
  return summarizeDashboard(dashboard, elapsedMs);
}

function renderMarkdown(report) {
  const rows = report.scenarios
    .map(
      scenario =>
        `| ${scenario.botCount} | ${scenario.elapsedMs} | ${scenario.tltcCollateralDisplay} | ${scenario.tlusdStakedDisplay} | ${scenario.assignedInboundSats} | ${scenario.deliveredInboundSats} | ${pctBps(scenario.deliveryBps)} | ${scenario.challengeCount} | ${scenario.verification.ok} |`
    )
    .join('\n');

  const largest = report.scenarios[report.scenarios.length - 1];
  const challenges = largest.sampleChallengeQueue
    .map(
      item =>
        `- ${item.botId}: ${item.deliveredInboundSats}/${item.requestedInboundSats} sats, ${item.violations.join(', ')}`
    )
    .join('\n');

  return `# Wallet Stress Simulation

## Configuration

- Profile: ${report.profile}
- Source bundle: \`${report.sourceBundleId}\`
- LTC/USD price: ${report.ltcUsdPriceMicros} micro-USD/LTC
- Generated at: ${report.generatedAt}

## Scenarios

| Bots | Build ms | tLTC collateral | TLUSD staked | Assigned sats | Delivered sats | Delivery | Challenges | Verified |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
${rows}

## Largest Scenario Challenge Sample

${challenges || '- none'}

## Interpretation

This is a deterministic synthetic stress simulation anchored to the latest
LN-BTC -> TLUSD liquidity patch artifact. It does not claim live Ark ASP or
tapd throughput. It exercises the wallet/operator data shape at fleet scale:
bot inventory, tLTC collateral, TLUSD stake, Ark patch assignment, delivery
rate, and BitVM challenge queue growth.
`;
}

function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    console.log('Usage: node integrations/wallet-demo/run_stress_simulation.js [--bots N|--scenarios 96,512,2048,5000] [--profile NAME]');
    return;
  }

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const patch = JSON.parse(fs.readFileSync(PATCH_PATH, 'utf8'));
  const config = buildWalletDemoConfig({ ...process.env, WALLET_DEMO_PROFILE: options.profile });
  const scenarios = options.scenarios.map(botCount =>
    runScenario({
      patch,
      config,
      botCount,
      ltcUsdPriceMicros: options.ltcUsdPriceMicros
    })
  );

  const report = {
    kind: 'wallet_stress_simulation_report',
    generatedAt: new Date().toISOString(),
    profile: config.activeProfileId,
    sourceBundleId: patch.bundleId,
    ltcUsdPriceMicros: options.ltcUsdPriceMicros.toString(),
    scenarios
  };

  fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, renderMarkdown(report));

  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
  for (const scenario of scenarios) {
    console.log(
      `bots=${scenario.botCount} ms=${scenario.elapsedMs} tLTC=${scenario.tltcCollateralDisplay} TLUSD=${scenario.tlusdStakedDisplay} assigned=${scenario.assignedInboundSats} challenges=${scenario.challengeCount} ok=${scenario.verification.ok}`
    );
  }
}

if (require.main === module) {
  main();
}
