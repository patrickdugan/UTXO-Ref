#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildTradeLayerBitvmStackBundle,
  verifyTradeLayerBitvmStackBundle,
  dashboardJsonSchema
} = require('./tradelayer_bitvm_stack');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DEFAULT_JSON_OUT = path.join(ARTIFACTS_DIR, 'tradelayer_bitvm_stack_latest.json');
const DEFAULT_MD_OUT = path.join(ARTIFACTS_DIR, 'tradelayer_bitvm_stack_latest.md');

function usage() {
  return [
    'Usage: node bitvm3/utxo_referee/tradelayer_bitvm_stack_demo.js [options]',
    '',
    'Options:',
    '  --input <path>   TradeLayer consensus/history JSON. Uses built-in sample if omitted.',
    '  --out <path>     JSON artifact output path.',
    '  --md <path>      Markdown summary output path.',
    '  --send-id <id>   Select send record by id.',
    '  --help          Show this help.'
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    args[key] = value;
    i++;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stringifyJson(value) {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') return current.toString();
    if (Buffer.isBuffer(current)) return current.toString('hex');
    if (current && current.type === 'Buffer' && Array.isArray(current.data)) {
      return Buffer.from(current.data).toString('hex');
    }
    return current;
  }, 2);
}

function markdownSummary(bundle, verification) {
  const dashboard = bundle.dashboard;
  const schema = dashboardJsonSchema();
  const alertText = dashboard.alerts.length
    ? dashboard.alerts.map((alert) => `- ${alert.severity}: ${alert.code} - ${alert.message}`).join('\n')
    : '- none';

  return [
    '# TradeLayer BitVM Stack Demo',
    '',
    `Created: ${new Date().toISOString()}`,
    `Network: ${bundle.network}`,
    `Verification: ${verification.ok ? 'ok' : verification.reason}`,
    '',
    '## Chain Of Custody',
    '',
    `- State checkpoint: ${bundle.stateCheckpoint.checkpointHash}`,
    `- State oracle: ${bundle.hashes.stateOracleHash}`,
    `- Selected send txid: ${bundle.selectedSend.txid}`,
    `- Route transcript: ${bundle.hashes.routeTranscriptHash}`,
    `- Sweep output root: ${bundle.commitment.withdrawalRootHex}`,
    `- Final stack hash: ${bundle.stackHash}`,
    '',
    '## BitVM Challenge Surfaces',
    '',
    `- Send fraud bundle: ${bundle.fraudChallenges.bundleHash}`,
    `- Checkpoint fraud proof: ${bundle.checkpointFraudProof.proofHash}`,
    `- Withdrawal queue: ${bundle.withdrawalQueue.queueHash}`,
    `- Perp PNL settlement: ${bundle.perpPnl.settlementHash}`,
    `- Liquidity lease: ${bundle.liquidityLease.leaseHash}`,
    `- Arena report: ${bundle.arenaSecurity.reportHash}`,
    '',
    '## Dashboard Contract',
    '',
    `- Schema: ${schema.schema}`,
    `- View hash: ${dashboard.viewHash}`,
    `- Status: ${dashboard.status}`,
    `- Next step: ${dashboard.nextStep}`,
    '',
    '## Alerts',
    '',
    alertText,
    ''
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const outPath = path.resolve(args.out || DEFAULT_JSON_OUT);
  const mdPath = path.resolve(args.md || DEFAULT_MD_OUT);
  const consensusInput = args.input ? readJson(path.resolve(args.input)) : undefined;
  const bundle = buildTradeLayerBitvmStackBundle({
    consensusInput,
    sendId: args.sendId
  });
  const verification = verifyTradeLayerBitvmStackBundle(bundle);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(outPath, `${stringifyJson(bundle)}\n`);
  fs.writeFileSync(mdPath, markdownSummary(bundle, verification));

  console.log('TradeLayer BitVM stack artifacts written:');
  console.log(`  ${outPath}`);
  console.log(`  ${mdPath}`);
  console.log(`verification=${verification.ok ? 'ok' : verification.reason}`);
  console.log(`stackHash=${bundle.stackHash}`);
  console.log(`dashboardViewHash=${bundle.dashboard.viewHash}`);

  if (!verification.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`TradeLayer BitVM stack demo failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  markdownSummary
};
