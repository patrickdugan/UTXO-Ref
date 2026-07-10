#!/usr/bin/env node

/**
 * Carrier-camouflaged watchtower cadence demo.
 *
 * Reads the live BTCTEST4 import plus the quirk-indexed route demo artifact and
 * proves that ordinary-looking watchtower publications can be challengeable
 * without becoming spend authority.
 */

const fs = require('fs');
const path = require('path');
const {
  buildSemanticAlertHash,
  buildCamouflagedWatchtowerCadenceClaim,
  verifyCamouflagedWatchtowerCadenceClaim,
  buildCamouflagedWatchtowerCadenceChallenge,
  summarizeCamouflagedWatchtowerCadenceClaim
} = require('./camouflaged_watchtower_cadence_referee');

const DEFAULT_IMPORT = 'C:\\projects\\BitcoinConsensusObservatory\\jurassic-bitcoin\\artifacts\\bitcoin-testnet4\\utxoref-live-import-latest.json';
const DEFAULT_ROUTE_DEMO = path.join(__dirname, 'artifacts', 'quirk_indexed_route', 'quirk_indexed_route_latest.json');
const DEFAULT_OUT = path.join(__dirname, 'artifacts', 'camouflaged_watchtower_cadence', 'camouflaged_watchtower_cadence_latest.json');
const DEFAULT_MD = path.join(__dirname, 'artifacts', 'camouflaged_watchtower_cadence', 'camouflaged_watchtower_cadence_latest.md');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`unexpected arg ${arg}`);
    args[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}

function usage() {
  return [
    'Usage: node bitvm3/utxo_referee/camouflaged_watchtower_cadence_demo.js [options]',
    '',
    'Options:',
    `  --import <path>       default ${DEFAULT_IMPORT}`,
    `  --route-demo <path>   default ${DEFAULT_ROUTE_DEMO}`,
    `  --out <path>          default ${DEFAULT_OUT}`,
    `  --md <path>           default ${DEFAULT_MD}`
  ].join('\n');
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function importsByKind(bundle) {
  const imports = Array.isArray(bundle.imports) ? bundle.imports : [];
  return {
    vault: imports.find((item) => item.kind === 'btctest4_utxoref_reserve_vault_import_v1')
  };
}

function firstAcceptedRoute(routeDemo) {
  const accepted = (routeDemo.scenarios || []).find((scenario) => scenario.verification?.admissible === true);
  if (!accepted) throw new Error('route demo artifact has no accepted route claim');
  return accepted;
}

function buildRegistry(routeClaimHash, semanticAlertHash) {
  return [
    {
      publicationHandle: 'sweep-cover-watchtower-current',
      routeClaimHash,
      semanticAlertHash
    },
    {
      publicationHandle: 'payout-batch-watchtower-current',
      routeClaimHash,
      semanticAlertHash
    },
    {
      publicationHandle: 'wrong-route-watchtower-current',
      routeClaimHash: '00'.repeat(32),
      semanticAlertHash
    }
  ];
}

function baseClaimInput(bundle, routeScenario, semanticAlertHash) {
  const { vault } = importsByKind(bundle);
  if (!vault) throw new Error('live import missing vault import');
  const currentHeight = Number(bundle.node?.blocks || vault.chain_ref?.tipHeight || 0);
  return {
    network: 'bitcoin-testnet4',
    reserveOutpoint: vault.chain_ref.outpoint,
    liveTraceHash: vault.bindings.liveTraceHash,
    watchtowerEpoch: `watchtower-${currentHeight}`,
    expectedCadenceBlocks: 12,
    publicationHeight: currentHeight - 6,
    carrierProfile: 'wallet_sweep_checkpoint',
    publicationHandle: 'sweep-cover-watchtower-current',
    semanticAlertHash,
    routeClaimHash: routeScenario.claim.claimHash
  };
}

function buildScenario(bundle, routeDemo, scenario) {
  const routeScenario = firstAcceptedRoute(routeDemo);
  const { vault } = importsByKind(bundle);
  const currentHeight = Number(bundle.node?.blocks || vault.chain_ref?.tipHeight || 0);
  const semanticAlertHash = buildSemanticAlertHash({
    routeClaimHash: routeScenario.claim.claimHash,
    reserveOutpoint: vault.chain_ref.outpoint,
    watchtowerEpoch: `watchtower-${currentHeight}`
  });
  const input = {
    ...baseClaimInput(bundle, routeScenario, semanticAlertHash),
    publicationHandle: scenario.publicationHandle || 'sweep-cover-watchtower-current',
    carrierProfile: scenario.carrierProfile || 'wallet_sweep_checkpoint'
  };
  if (scenario.mutate) scenario.mutate(input);
  const context = {
    currentHeight,
    liveImportBundle: bundle,
    routeDemo,
    publicationRegistry: buildRegistry(routeScenario.claim.claimHash, semanticAlertHash)
  };
  const claim = buildCamouflagedWatchtowerCadenceClaim(input);
  const verification = verifyCamouflagedWatchtowerCadenceClaim(claim, context);
  const challenge = buildCamouflagedWatchtowerCadenceChallenge(claim, context);
  return {
    id: scenario.id,
    expected: scenario.expected,
    claim,
    verification,
    challenge,
    summary: summarizeCamouflagedWatchtowerCadenceClaim(claim, verification)
  };
}

function renderMarkdown(artifact) {
  const lines = [
    '# Camouflaged Watchtower Cadence Demo',
    '',
    'This no-broadcast demo makes watchtower publication cadence challengeable while allowing ordinary-looking carrier profiles.',
    '',
    '## Source',
    '',
    `- Import bundle: \`${artifact.source.importPath}\``,
    `- Route demo: \`${artifact.source.routeDemoPath}\``,
    `- Chain: \`${artifact.node.chain}\``,
    `- Height: \`${artifact.node.blocks}\``,
    `- Reserve outpoint: \`${artifact.reserve.outpoint}\``,
    `- Route claim: \`${artifact.route.claimHash}\``,
    '',
    '## Scenarios',
    '',
    '| scenario | expected | admissible | failed checks | carrier | claim |',
    '| --- | --- | --- | --- | --- | --- |'
  ];
  for (const scenario of artifact.scenarios) {
    lines.push(
      '| '
      + [
        `\`${scenario.id}\``,
        `\`${scenario.expected}\``,
        `\`${scenario.verification.admissible}\``,
        scenario.verification.failedChecks.length ? scenario.verification.failedChecks.map((x) => `\`${x}\``).join(', ') : '-',
        `\`${scenario.claim.core.carrierProfile}\``,
        `\`${scenario.claim.claimHash}\``
      ].join(' | ')
      + ' |'
    );
  }
  lines.push(
    '',
    '## Rule',
    '',
    'Carrier camouflage is allowed for watchtower cadence only when the checkpoint references an admitted route claim, a live reserve witness, a bound publication handle, and a fresh cadence window.'
  );
  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const importPath = path.resolve(args.import || DEFAULT_IMPORT);
  const routeDemoPath = path.resolve(args.routeDemo || DEFAULT_ROUTE_DEMO);
  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const mdPath = path.resolve(args.md || DEFAULT_MD);
  const bundle = loadJson(importPath);
  const routeDemo = loadJson(routeDemoPath);
  const routeScenario = firstAcceptedRoute(routeDemo);
  const { vault } = importsByKind(bundle);
  if (!vault) throw new Error('import bundle must include a vault import');

  const scenarios = [
    {
      id: 'accepted_sweep_like_checkpoint',
      expected: 'accepted',
      carrierProfile: 'wallet_sweep_checkpoint',
      publicationHandle: 'sweep-cover-watchtower-current'
    },
    {
      id: 'accepted_payout_batch_checkpoint',
      expected: 'accepted',
      carrierProfile: 'payout_batch_checkpoint',
      publicationHandle: 'payout-batch-watchtower-current'
    },
    {
      id: 'rejected_stale_checkpoint',
      expected: 'rejected',
      mutate(input) {
        input.publicationHeight = Number(bundle.node.blocks) - 20;
      }
    },
    {
      id: 'rejected_wrong_alert_handle_route',
      expected: 'rejected',
      publicationHandle: 'wrong-route-watchtower-current'
    }
  ].map((scenario) => buildScenario(bundle, routeDemo, scenario));

  for (const scenario of scenarios) {
    const shouldAccept = scenario.expected === 'accepted';
    if (scenario.verification.admissible !== shouldAccept) {
      throw new Error(`${scenario.id} expected ${scenario.expected}, got admissible=${scenario.verification.admissible}`);
    }
  }

  const artifact = {
    kind: 'camouflaged_watchtower_cadence_demo',
    createdAt: new Date().toISOString(),
    source: {
      importPath,
      routeDemoPath
    },
    node: bundle.node,
    reserve: {
      outpoint: vault.chain_ref.outpoint,
      liveTraceHash: vault.bindings.liveTraceHash,
      bindingStatus: vault.bindings.bindingStatus
    },
    route: {
      claimHash: routeScenario.claim.claimHash,
      scenarioId: routeScenario.id
    },
    scenarios,
    conclusion: {
      acceptedCount: scenarios.filter((s) => s.verification.admissible).length,
      rejectedCount: scenarios.filter((s) => !s.verification.admissible).length,
      novelty: 'carrier camouflage becomes a watchtower cadence surface only after route and reserve admission'
    }
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, renderMarkdown(artifact));

  console.log('Camouflaged watchtower cadence demo:');
  console.log(`  import      : ${importPath}`);
  console.log(`  route demo  : ${routeDemoPath}`);
  console.log(`  reserve     : ${artifact.reserve.outpoint}`);
  console.log(`  route claim : ${artifact.route.claimHash}`);
  for (const scenario of scenarios) {
    console.log(`  ${scenario.id}: admissible=${scenario.verification.admissible} failed=${scenario.verification.failedChecks.join(',') || 'none'}`);
  }
  console.log(`  artifact    : ${outPath}`);
  console.log(`  markdown    : ${mdPath}`);
}

main();
