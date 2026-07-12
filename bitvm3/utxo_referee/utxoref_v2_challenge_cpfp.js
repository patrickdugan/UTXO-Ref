#!/usr/bin/env node

const path = require('path');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const { txidFromUnsignedHex } = require('./recover_btc_testnet4_reserve_vault');
const { loadState, saveJsonAtomic } = require('./utxoref_v2_watchtower');

const DEFAULT_STATE_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_state.json');
const MIN_OUTPUT_SATS = 330n;

function parseArgs(argv) {
  const args = { broadcast: false, replaceChild: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (arg === '--replace-child') { args.replaceChild = true; continue; }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    args[key] = value;
  }
  return args;
}

function usage() {
  return [
    'Build a wallet-signed CPFP child for an unconfirmed UTXORef V2 challenge.',
    '',
    'Preflight only:',
    '  node utxoref_v2_challenge_cpfp.js --state-path <watchtower-state.json> \\',
    '    --wallet <wallet-name> --fee-sats 1000',
    '',
    'Broadcast after a successful preflight:',
    '  node utxoref_v2_challenge_cpfp.js --state-path <watchtower-state.json> \\',
    '    --wallet <wallet-name> --fee-sats 1000 --broadcast',
    '',
    'Replace the tracked unconfirmed CPFP child at a higher fee:',
    '  node utxoref_v2_challenge_cpfp.js --state-path <watchtower-state.json> \\',
    '    --wallet <wallet-name> --fee-sats 2000 --replace-child --broadcast',
    '',
    'RPC credentials are read from BTC_RPC_URL, BTC_RPC_USER, and BTC_RPC_PASS,',
    'or passed as --rpc-url, --rpc-user, and --rpc-pass.'
  ].join('\n');
}

function positiveSats(value, fieldName) {
  const text = String(value || '');
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${fieldName} must be a positive integer`);
  return BigInt(text);
}

function btcToSats(value) {
  const text = String(value);
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) throw new Error('Core returned an invalid BTC amount');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 8) throw new Error('Core returned a sub-satoshi BTC amount');
  return BigInt(whole) * 100000000n + BigInt((fraction + '00000000').slice(0, 8));
}

function nativeSegwitScript(scriptPubKeyHex) {
  const script = String(scriptPubKeyHex || '').toLowerCase();
  if (!/^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/.test(script)) {
    throw new Error('CPFP requires a native P2WPKH or P2TR wallet-owned challenge output');
  }
  return script;
}

function buildCpfpPlan(state, args) {
  const tracked = state?.challenge;
  if (!tracked?.txid || !/^[0-9a-f]{64}$/.test(tracked.txid)) throw new Error('state has no valid tracked challenge txid');
  const vout = Number(tracked.vout || 0);
  if (!Number.isSafeInteger(vout) || vout < 0) throw new Error('tracked challenge vout is invalid');
  const parentAmount = positiveSats(tracked.outputSats, 'tracked challenge outputSats');
  const feeSats = positiveSats(args.feeSats, 'feeSats');
  const existingChild = tracked.cpfp || null;
  if (existingChild && !args.replaceChild) throw new Error('state already tracks a CPFP child; use --replace-child to fee-bump it');
  if (args.replaceChild) {
    if (!existingChild?.txid || !/^[0-9a-f]{64}$/.test(existingChild.txid)) throw new Error('state has no valid CPFP child to replace');
    if (feeSats <= positiveSats(existingChild.feeSats, 'tracked CPFP feeSats')) {
      throw new Error('replacement CPFP fee must exceed the tracked child fee');
    }
  }
  if (feeSats > parentAmount - MIN_OUTPUT_SATS) throw new Error('CPFP fee would reduce the child output below the dust floor');
  const outputSats = parentAmount - feeSats;
  const scriptPubKeyHex = nativeSegwitScript(tracked.challengeScriptPubKeyHex);
  const unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(tracked.txid, vout),
    sequence: 0xfffffffd
  }], [{ valueSats: outputSats, script: scriptPubKeyHex }], 0);
  return {
    kind: 'utxoref_v2_challenge_cpfp_plan',
    version: 1,
    graphHash: tracked.graphHash,
    replacementOf: args.replaceChild ? existingChild.txid : null,
    parentTxid: tracked.txid,
    parentVout: vout,
    parentAmountSats: parentAmount.toString(),
    parentScriptPubKeyHex: scriptPubKeyHex,
    feeSats: feeSats.toString(),
    outputSats: outputSats.toString(),
    unsignedTxHex,
    txid: txidFromUnsignedHex(unsignedTxHex)
  };
}

async function preflightCpfp(plan, args, rpc) {
  const chain = await rpc('getblockchaininfo');
  if (chain.chain !== 'testnet4') throw new Error(`wrong chain: ${chain.chain}`);
  if (plan.replacementOf) {
    const existing = await rpc('getmempoolentry', [plan.replacementOf]);
    if (existing?.['bip125-replaceable'] !== true) throw new Error('tracked CPFP child is not BIP125-replaceable');
    const parent = await rpc('getrawtransaction', [plan.parentTxid, true]);
    const output = parent?.vout?.find((candidate) => Number(candidate.n) === plan.parentVout);
    if (!output) throw new Error('tracked challenge parent output is unavailable');
    if (btcToSats(output.value) !== BigInt(plan.parentAmountSats)) throw new Error('tracked challenge amount does not match Core');
    if (String(output.scriptPubKey?.hex || '').toLowerCase() !== plan.parentScriptPubKeyHex) {
      throw new Error('tracked challenge script does not match Core');
    }
  } else {
    const parent = await rpc('gettxout', [plan.parentTxid, plan.parentVout, true]);
    if (!parent) throw new Error('tracked challenge output is spent or missing');
    if (Number(parent.confirmations || 0) !== 0) throw new Error('CPFP is restricted to an unconfirmed challenge output');
    if (btcToSats(parent.value) !== BigInt(plan.parentAmountSats)) throw new Error('tracked challenge amount does not match Core');
    if (String(parent.scriptPubKey?.hex || '').toLowerCase() !== plan.parentScriptPubKeyHex) {
      throw new Error('tracked challenge script does not match Core');
    }
  }
  if (!args.wallet) throw new Error('--wallet is required for CPFP signing');
  const signed = await rpc('signrawtransactionwithwallet', [plan.unsignedTxHex], args.wallet);
  if (!signed?.complete || !signed.hex) throw new Error('wallet could not completely sign the CPFP child');
  const [mempoolAccept] = plan.replacementOf
    ? [{ allowed: null, replacementPreflight: 'sendrawtransaction-required-for-conflict' }]
    : await rpc('testmempoolaccept', [[signed.hex]]);
  return { signedHex: signed.hex, mempoolAccept };
}

async function runCpfp(state, args, rpc) {
  const plan = buildCpfpPlan(state, args);
  const preflight = await preflightCpfp(plan, args, rpc);
  const result = { ...plan, mempoolAccept: preflight.mempoolAccept, broadcast: false };
  if (!plan.replacementOf && !preflight.mempoolAccept?.allowed) return { action: 'cpfp_preflight_rejected', result };
  if (!args.broadcast) return { action: plan.replacementOf ? 'cpfp_replacement_ready_for_broadcast' : 'cpfp_ready_for_broadcast', result };
  const broadcastTxid = await rpc('sendrawtransaction', [preflight.signedHex]);
  if (broadcastTxid !== plan.txid) throw new Error(`CPFP txid mismatch: expected ${plan.txid}, got ${broadcastTxid}`);
  const at = new Date().toISOString();
  const priorChild = state.challenge.cpfp || null;
  state.challenge.cpfp = {
    txid: broadcastTxid,
    vout: 0,
    parentTxid: plan.parentTxid,
    feeSats: plan.feeSats,
    outputSats: plan.outputSats,
    broadcastAt: at,
    confirmation: null,
    replacements: priorChild
      ? [...(priorChild.replacements || []), {
          txid: priorChild.txid,
          feeSats: String(priorChild.feeSats),
          outputSats: String(priorChild.outputSats),
          replacedAt: at,
          replacementTxid: broadcastTxid
        }]
      : []
  };
  result.broadcast = true;
  result.broadcastTxid = broadcastTxid;
  return { action: plan.replacementOf ? 'cpfp_replaced' : 'cpfp_broadcast', result };
}

function resolveRpc(args) {
  const rpcUrl = args.rpcUrl || process.env.BTC_RPC_URL;
  const rpcUser = args.rpcUser || process.env.BTC_RPC_USER;
  const rpcPass = args.rpcPass || process.env.BTC_RPC_PASS;
  if (!rpcUrl || !rpcUser || !rpcPass) throw new Error('CPFP signer requires BTC_RPC_URL, BTC_RPC_USER, and BTC_RPC_PASS');
  return rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId: 'utxoref-v2-cpfp' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const statePath = path.resolve(args.statePath || DEFAULT_STATE_PATH);
  const state = loadState(statePath);
  const outcome = await runCpfp(state, args, resolveRpc(args));
  if (outcome.action === 'cpfp_broadcast' || outcome.action === 'cpfp_replaced') saveJsonAtomic(statePath, state);
  console.log(JSON.stringify(outcome));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef V2 CPFP failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  btcToSats,
  nativeSegwitScript,
  buildCpfpPlan,
  preflightCpfp,
  runCpfp
};
