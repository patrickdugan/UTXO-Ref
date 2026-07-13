#!/usr/bin/env node

const path = require('path');
const { saveJsonAtomic } = require('./utxoref_v2_watchtower');
const {
  parseArgs,
  buildReserveCpfpPlan,
  buildReserveGuardianApproval,
  preflightReserveCpfpInputs,
  readSecretFile,
  resolveRpc,
  loadInputs
} = require('./utxoref_v2_reserve_cpfp');

function usage() {
  return [
    'Validate and authorize an exact reserve-backed UTXORef V2 CPFP transaction.',
    '',
    '  node utxoref_v2_fee_reserve_guardian.js --artifact <artifact.json> \\',
    '    --state-path <state.json> --trust-policy <policy.json> \\',
    '    --fee-reserve <reserve.json> --fee-sats 2000 \\',
    '    --guardian-secret-file <secret.hex> --output <approval.json>',
    '',
    'Add --replace-child when authorizing a replacement of the tracked child.',
    'For a quorum reserve, each guardian runs this command independently.',
    'This command accepts no challenger secret and performs no broadcast.'
  ].join('\n');
}

async function runGuardian(args, rpc) {
  if (!args.guardianSecretFile) throw new Error('--guardian-secret-file is required');
  if (!args.output) throw new Error('--output is required');
  if (args.broadcast) throw new Error('guardian command cannot broadcast');
  if (args.challengerSecretFile) throw new Error('guardian command must not receive the challenger secret');
  const inputs = loadInputs(args);
  const plan = buildReserveCpfpPlan(inputs.state, args, inputs.artifact, inputs.reserve);
  const preflight = await preflightReserveCpfpInputs(plan, inputs.reserve, rpc);
  const guardianSecret = readSecretFile(args.guardianSecretFile, 'guardianSecret');
  const approval = buildReserveGuardianApproval(
    plan,
    inputs.reserve,
    preflight.chainEvidence,
    guardianSecret
  );
  saveJsonAtomic(path.resolve(args.output), approval);
  return {
    kind: 'utxoref_v2_reserve_cpfp_guardian_receipt',
    version: 1,
    approved: true,
    approvalHash: approval.approvalHash,
    guardianXonly: approval.core.guardianXonly,
    guardianSetHash: approval.core.guardianSetHash || null,
    guardianThreshold: approval.core.guardianThreshold || 1,
    guardianCount: approval.core.guardianCount || 1,
    planHash: plan.planHash,
    transactionTxid: plan.txid,
    reserveOutpoint: plan.reserve.outpoint,
    feeSats: plan.feeSats,
    chainEvidence: preflight.chainEvidence,
    output: path.resolve(args.output)
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const receipt = await runGuardian(args, resolveRpc(args, 'utxoref-v2-fee-reserve-guardian'));
  console.log(JSON.stringify(receipt));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef V2 fee reserve guardian failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { usage, runGuardian };
