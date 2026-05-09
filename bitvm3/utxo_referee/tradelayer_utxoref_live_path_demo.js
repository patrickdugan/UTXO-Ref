#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildUtxoRefLivePathEvidence,
  loadDecodedFinalTxFromRpc,
  verifyUtxoRefLivePathEvidence,
  normalizeLivePathInput
} = require('./tradelayer_utxoref_live_path');
const {
  resolveChainEnv
} = require('./m1_chain_env');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DEFAULT_JSON_OUT = path.join(ARTIFACTS_DIR, 'utxoref_live_path_latest.json');
const DEFAULT_MD_OUT = path.join(ARTIFACTS_DIR, 'utxoref_live_path_latest.md');

function usage() {
  return [
    'Usage: node bitvm3/utxo_referee/tradelayer_utxoref_live_path_demo.js [options]',
    '',
    'Options:',
    '  --input <path>             TradeLayer consensus/history JSON or state-oracle JSON. Uses built-in sample if omitted.',
    '  --state-oracle <path>      Explicit state-oracle JSON blob.',
    '  --decoded-final-tx <path>  Core decoderawtransaction JSON for the final sweep.',
    '  --final-hex <hex>          Decode this final transaction hex through Core RPC.',
    '  --final-txid <txid>        Load and decode this final transaction through Core RPC.',
    '  --rpc-url <url>            Override BITVM/LTC/BTC RPC URL.',
    '  --rpc-user <user>          Override BITVM/LTC/BTC RPC user.',
    '  --rpc-pass <pass>          Override BITVM/LTC/BTC RPC password.',
    '  --out <path>               JSON artifact output path.',
    '  --md <path>                Markdown summary output path.',
    '  --send-id <id>             Select send record by id.',
    '  --help                    Show this help.'
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

function readLivePathInput(consensusInputPath, stateOraclePath) {
  if (stateOraclePath) {
    return normalizeLivePathInput({
      stateOracleBlob: readJson(path.resolve(stateOraclePath))
    });
  }
  if (!consensusInputPath) return {};
  return normalizeLivePathInput(readJson(path.resolve(consensusInputPath)));
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

function markdownSummary(evidence, verification) {
  const checklist = evidence.operatorChecklist
    .map((item) => `- ${item.step}: ${item.status} (${item.check})`)
    .join('\n');
  const reviewText = evidence.finalOutputReview.ok
    ? '- ok'
    : evidence.finalOutputReview.core.mismatches.map((item) => `- ${item.code}`).join('\n');
  return [
    '# UTXORef Live Path Evidence',
    '',
    `Created: ${new Date().toISOString()}`,
    `Network: ${evidence.core.network}`,
    `Verification: ${verification.ok ? 'ok' : verification.reason}`,
    '',
    '## Path',
    '',
    `- Funding outpoint: ${evidence.core.fundingOutpoint}`,
    `- TradeLayer send txid: ${evidence.core.selectedSendTxid}`,
    `- State oracle hash: ${evidence.core.stateOracleHash}`,
    `- Registry hash: ${evidence.core.dlcFunderRegistryHash}`,
    `- Route transcript hash: ${evidence.core.plannedRouteTranscriptHash}`,
    `- Final route transcript hash: ${evidence.core.finalRouteTranscriptHash}`,
    `- Withdrawal root: ${evidence.core.withdrawalRootHex}`,
    `- Final tx output hash: ${evidence.core.finalTxOutputHash}`,
    `- Final output review: ${evidence.core.finalOutputReviewHash}`,
    `- Final spend binding: ${evidence.core.finalSpendBindingHash}`,
    `- Stack hash: ${evidence.core.stackHash}`,
    `- Dashboard view hash: ${evidence.core.dashboardViewHash}`,
    '',
    '## Challenge Evidence',
    '',
    `- Send fraud bundle: ${evidence.core.fraudBundleHash}`,
    `- Checkpoint fraud proof: ${evidence.core.checkpointFraudProofHash}`,
    `- Final output challenge: ${evidence.core.finalOutputChallengeHash}`,
    `- Challengeable count: ${evidence.core.challengeableCount}`,
    '',
    '## Final Output Review',
    '',
    reviewText,
    '',
    '## Operator Checklist',
    '',
    checklist,
    '',
    '## Live Swap Points',
    '',
    `- Consensus input: ${evidence.liveSwapPoints.consensusInput}`,
    `- Decoded final tx: ${evidence.liveSwapPoints.decodedFinalTx}`,
    `- Signer policy: ${evidence.liveSwapPoints.signerPolicy}`,
    `- Dashboard: ${evidence.liveSwapPoints.dashboard}`,
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
  if (args.decodedFinalTx && (args.finalHex || args.finalTxid)) {
    throw new Error('Use either --decoded-final-tx or --final-hex/--final-txid, not both');
  }
  const livePathInput = readLivePathInput(args.input, args.stateOracle);
  let decodedFinalTx = args.decodedFinalTx ? readJson(path.resolve(args.decodedFinalTx)) : undefined;
  if (!decodedFinalTx && (args.finalHex || args.finalTxid)) {
    const chainEnv = resolveChainEnv();
    decodedFinalTx = await loadDecodedFinalTxFromRpc({
      finalHex: args.finalHex,
      finalTxid: args.finalTxid,
      rpcUrl: args.rpcUrl || chainEnv.rpcUrl,
      rpcUser: args.rpcUser || chainEnv.rpcUser,
      rpcPass: args.rpcPass || chainEnv.rpcPass
    });
  }
  const evidence = buildUtxoRefLivePathEvidence({
    ...livePathInput,
    decodedFinalTx,
    sendId: args.sendId
  });
  const verification = verifyUtxoRefLivePathEvidence(evidence);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(outPath, `${stringifyJson(evidence)}\n`);
  fs.writeFileSync(mdPath, markdownSummary(evidence, verification));

  console.log('UTXORef live path artifacts written:');
  console.log(`  ${outPath}`);
  console.log(`  ${mdPath}`);
  console.log(`verification=${verification.ok ? 'ok' : verification.reason}`);
  console.log(`evidenceHash=${evidence.evidenceHash}`);
  console.log(`finalTxOutputHash=${evidence.core.finalTxOutputHash}`);
  console.log(`finalOutputReview=${evidence.finalOutputReview.ok ? 'ok' : evidence.finalOutputReview.mismatchCodes.join(',')}`);

  if (!verification.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef live path demo failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  markdownSummary
};
