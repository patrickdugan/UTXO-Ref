#!/usr/bin/env node

/**
 * Quirk-indexed UTXORef route demo.
 *
 * This demo reads the live BTCTEST4 import produced by Jurassic Bitcoin and
 * shows how ossified-quirk route candidates become admissible only after they
 * are bound to live UTXORef reserve evidence.
 */

const fs = require('fs');
const path = require('path');
const {
  buildQuirkIndexedRouteClaim,
  verifyQuirkIndexedRouteClaim,
  buildQuirkIndexedChallengeEvidence,
  summarizeQuirkIndexedRouteClaim
} = require('./quirk_indexed_route_referee');

const DEFAULT_IMPORT = 'C:\\projects\\BitcoinConsensusObservatory\\jurassic-bitcoin\\artifacts\\bitcoin-testnet4\\utxoref-live-import-latest.json';
const DEFAULT_OUT = path.join(__dirname, 'artifacts', 'quirk_indexed_route', 'quirk_indexed_route_latest.json');
const DEFAULT_MD = path.join(__dirname, 'artifacts', 'quirk_indexed_route', 'quirk_indexed_route_latest.md');

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
    'Usage: node bitvm3/utxo_referee/quirk_indexed_route_demo.js [options]',
    '',
    'Options:',
    `  --import <path>       default ${DEFAULT_IMPORT}`,
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
    grant: imports.find((item) => item.kind === 'btctest4_lnbtc_grant_import_v1'),
    vault: imports.find((item) => item.kind === 'btctest4_utxoref_reserve_vault_import_v1')
  };
}

function candidateByMotif(vault, motif) {
  const candidates = vault?.bindings?.routeTranscriptCandidates || [];
  const candidate = candidates.find((row) => row.motif === motif);
  if (!candidate) throw new Error(`missing route transcript candidate for motif ${motif}`);
  return candidate;
}

function baseClaimInput(bundle, motif) {
  const { grant, vault } = importsByKind(bundle);
  if (!grant) throw new Error('live import missing grant import');
  if (!vault) throw new Error('live import missing vault import');
  const candidate = candidateByMotif(vault, motif);
  const currentHeight = Number(bundle.node?.blocks || vault.chain_ref?.tipHeight || 0);
  return {
    network: 'bitcoin-testnet4',
    motif,
    semanticStateHash: grant.bindings.semanticStateHash,
    routeTranscriptHash: candidate.routeTranscriptCandidateHash,
    withdrawalRootHex: vault.bindings.withdrawalRootHex,
    finalOutputVectorHash: vault.bindings.candidateFinalOutputVectorHash,
    liveTraceHash: vault.bindings.liveTraceHash,
    commitmentHashHex: vault.bindings.commitmentHashHex,
    reserveOutpoint: vault.chain_ref.outpoint,
    challengeWindow: {
      startHeight: currentHeight,
      endHeight: currentHeight + 144
    }
  };
}

function buildScenario(bundle, scenario) {
  const input = {
    ...baseClaimInput(bundle, scenario.motif),
    publicHandle: scenario.publicHandle,
    namespace: scenario.namespace,
    transcriptAlias: scenario.transcriptAlias
  };
  if (scenario.mutate) scenario.mutate(input);
  const claim = buildQuirkIndexedRouteClaim(input);
  const verification = verifyQuirkIndexedRouteClaim(claim, { liveImportBundle: bundle });
  const challenge = buildQuirkIndexedChallengeEvidence(claim, { liveImportBundle: bundle });
  return {
    id: scenario.id,
    expected: scenario.expected,
    claim,
    verification,
    challenge,
    summary: summarizeQuirkIndexedRouteClaim(claim, verification)
  };
}

function renderMarkdown(artifact) {
  const lines = [
    '# Quirk-Indexed UTXORef Route Demo',
    '',
    'This no-broadcast demo binds Jurassic quirk route candidates to live Bitcoin testnet4 UTXORef reserve evidence.',
    '',
    '## Source',
    '',
    `- Import bundle: \`${artifact.source.importPath}\``,
    `- Chain: \`${artifact.node.chain}\``,
    `- Height: \`${artifact.node.blocks}\``,
    `- Reserve outpoint: \`${artifact.reserve.outpoint}\``,
    `- Grant txid: \`${artifact.grant.txid}\``,
    '',
    '## Scenarios',
    '',
    '| scenario | expected | admissible | failed checks | claim |',
    '| --- | --- | --- | --- | --- |'
  ];
  for (const scenario of artifact.scenarios) {
    lines.push(
      '| '
      + [
        `\`${scenario.id}\``,
        `\`${scenario.expected}\``,
        `\`${scenario.verification.admissible}\``,
        scenario.verification.failedChecks.length ? scenario.verification.failedChecks.map((x) => `\`${x}\``).join(', ') : '-',
        `\`${scenario.claim.claimHash}\``
      ].join(' | ')
      + ' |'
    );
  }
  lines.push(
    '',
    '## Rule',
    '',
    'A route transcript candidate is not spend authority. It becomes admissible only when the live reserve witness, withdrawal root, final output vector, semantic grant state, and CSV-safe reserve status all match.'
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
  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const mdPath = path.resolve(args.md || DEFAULT_MD);
  const bundle = loadJson(importPath);
  const { grant, vault } = importsByKind(bundle);
  if (!grant || !vault) throw new Error('import bundle must include grant and vault imports');

  const scenarios = [
    {
      id: 'accepted_transcript_alias_compact',
      expected: 'accepted',
      motif: 'transcript_multiplicity',
      publicHandle: 'hybrid_transcript_alias_aa',
      transcriptAlias: 'aa'
    },
    {
      id: 'accepted_identifier_namespace_rotated',
      expected: 'accepted',
      motif: 'identifier_bifurcation',
      publicHandle: 'namespace-32',
      namespace: 'dummy_32'
    },
    {
      id: 'rejected_mutated_withdrawal_root',
      expected: 'rejected',
      motif: 'transcript_multiplicity',
      publicHandle: 'hybrid_transcript_alias_aa_mutated_root',
      transcriptAlias: 'aa',
      mutate(input) {
        input.withdrawalRootHex = '00'.repeat(32);
      }
    },
    {
      id: 'rejected_unknown_route_transcript',
      expected: 'rejected',
      motif: 'carrier_camouflage',
      publicHandle: 'unknown-route-transcript',
      mutate(input) {
        input.routeTranscriptHash = 'ff'.repeat(32);
      }
    }
  ].map((scenario) => buildScenario(bundle, scenario));

  for (const scenario of scenarios) {
    const shouldAccept = scenario.expected === 'accepted';
    if (scenario.verification.admissible !== shouldAccept) {
      throw new Error(`${scenario.id} expected ${scenario.expected}, got admissible=${scenario.verification.admissible}`);
    }
  }

  const artifact = {
    kind: 'quirk_indexed_utxoref_route_demo',
    createdAt: new Date().toISOString(),
    source: { importPath },
    node: bundle.node,
    grant: {
      txid: grant.chain_ref.txid,
      semanticStateHash: grant.bindings.semanticStateHash,
      bindingStatus: grant.bindings.bindingStatus
    },
    reserve: {
      outpoint: vault.chain_ref.outpoint,
      liveTraceHash: vault.bindings.liveTraceHash,
      withdrawalRootHex: vault.bindings.withdrawalRootHex,
      finalOutputVectorHash: vault.bindings.candidateFinalOutputVectorHash,
      bindingStatus: vault.bindings.bindingStatus
    },
    scenarios,
    conclusion: {
      acceptedCount: scenarios.filter((s) => s.verification.admissible).length,
      rejectedCount: scenarios.filter((s) => !s.verification.admissible).length,
      novelty: 'ossified quirk candidates act as BitVM route selectors only after UTXORef binds them to live reserve evidence'
    }
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n');
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, renderMarkdown(artifact));

  console.log('Quirk-indexed UTXORef route demo:');
  console.log(`  import      : ${importPath}`);
  console.log(`  reserve     : ${artifact.reserve.outpoint}`);
  console.log(`  grant txid  : ${artifact.grant.txid}`);
  for (const scenario of scenarios) {
    console.log(`  ${scenario.id}: admissible=${scenario.verification.admissible} failed=${scenario.verification.failedChecks.join(',') || 'none'}`);
  }
  console.log(`  artifact    : ${outPath}`);
  console.log(`  markdown    : ${mdPath}`);
}

main();
