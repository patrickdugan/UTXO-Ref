#!/usr/bin/env node

/**
 * Live reserve reconciliation driver.
 *
 * Pulls real spendable UTXOs from a Litecoin Core wallet via `listunspent`,
 * credits them as the deposit reserve, and reconciles the tokenization peg
 * invariant (withdrawal cap <= credited reserve) against live chain state.
 *
 * One-command live use (node must be running on the RPC port):
 *   node bitvm3/utxo_referee/tradelayer_live_reserve_demo.js \
 *     --rpc-url http://127.0.0.1:19332 --rpc-user user --rpc-pass pass \
 *     --wallet tl-wallet
 *
 * Offline use against a captured snapshot:
 *   node bitvm3/utxo_referee/tradelayer_live_reserve_demo.js \
 *     --unspent bitvm3/utxo_referee/artifacts/live/tl_wallet_unspent.json
 */

const fs = require('fs');
const path = require('path');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { resolveChainEnv } = require('./m1_chain_env');
const { buildLiveReserveFromUnspent } = require('./tradelayer_live_reserve_adapter');
const {
  buildTradeLayerBitvmStackBundle,
  verifyTradeLayerBitvmStackBundle
} = require('./tradelayer_bitvm_stack');
const {
  buildTradeLayerReserveInsolvencyChallenge
} = require('./tradelayer_reserve_reconciliation_referee');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts', 'live');
const DEFAULT_OUT = path.join(ARTIFACTS_DIR, 'reserve_reconciliation_latest.json');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    args[key] = value;
    i++;
  }
  return args;
}

function readJsonBomTolerant(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
}

async function loadUnspent(args) {
  if (args.unspent) {
    return readJsonBomTolerant(path.resolve(args.unspent));
  }
  const chainEnv = resolveChainEnv();
  const rpc = rpcFactory({
    rpcUrl: args.rpcUrl || chainEnv.rpcUrl,
    rpcUser: args.rpcUser || chainEnv.rpcUser,
    rpcPass: args.rpcPass || chainEnv.rpcPass,
    requestId: 'tradelayer-live-reserve'
  });
  const minConf = Number(args.minConfirmations || 0);
  return rpc('listunspent', [minConf, 9999999], args.wallet || null);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('See header of tradelayer_live_reserve_demo.js for usage.');
    return;
  }

  const unspent = await loadUnspent(args);
  const reserve = buildLiveReserveFromUnspent(unspent, {
    network: args.network || 'litecoin-testnet',
    minConfirmations: Number(args.minConfirmations || 1),
    currentHeight: args.currentHeight ? Number(args.currentHeight) : undefined
  });

  const bundle = buildTradeLayerBitvmStackBundle({ reserve: reserve.snapshot });
  const verification = verifyTradeLayerBitvmStackBundle(bundle);
  const reconciliation = bundle.reserveReconciliation;
  const insolvencyChallenge = buildTradeLayerReserveInsolvencyChallenge(reconciliation);

  const artifact = {
    kind: 'tradelayer_live_reserve_reconciliation',
    createdAt: new Date().toISOString(),
    source: args.unspent ? `file:${path.resolve(args.unspent)}` : `rpc:${args.wallet || 'default'}`,
    reserve: {
      creditedCount: reserve.creditedCount,
      observedCount: reserve.observedCount,
      reservedSats: reserve.reservedSats.toString(),
      reserveSourceKind: reconciliation.core.reserveSourceKind,
      reserveSourceHash: reconciliation.core.reserveSourceHash
    },
    reconciliation: reconciliation.core,
    reconciliationHash: reconciliation.reconciliationHash,
    insolvencyChallenge: {
      challengeable: insolvencyChallenge.challengeable,
      challengeHash: insolvencyChallenge.challengeHash,
      shortfallSats: insolvencyChallenge.core.shortfallSats
    },
    stackHash: bundle.stackHash,
    dashboardStatus: bundle.dashboard.status,
    walletAction: bundle.productionPolicy.walletAction,
    stackVerification: verification.ok ? 'ok' : verification.reason
  };

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const outPath = path.resolve(args.out || DEFAULT_OUT);
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log('Live reserve reconciliation:');
  console.log(`  credited reserve : ${reserve.reservedSats} sats (${reserve.creditedCount}/${reserve.observedCount} UTXOs)`);
  console.log(`  withdrawal cap   : ${reconciliation.core.capSats} sats`);
  console.log(`  margin           : ${reconciliation.core.marginSats} sats`);
  console.log(`  solvent          : ${reconciliation.solvent}`);
  console.log(`  walletAction     : ${bundle.productionPolicy.walletAction}`);
  console.log(`  dashboard        : ${bundle.dashboard.status}`);
  console.log(`  stack verify     : ${artifact.stackVerification}`);
  console.log(`  artifact         : ${outPath}`);

  if (!verification.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Live reserve reconciliation failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { readJsonBomTolerant };
