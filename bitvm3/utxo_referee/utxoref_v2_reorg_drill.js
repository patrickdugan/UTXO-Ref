#!/usr/bin/env node

const path = require('path');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { monitorChallenge, saveJsonAtomic } = require('./utxoref_v2_watchtower');

const DEFAULT_RECEIPT = path.join(__dirname, 'artifacts', 'tmp', 'utxoref_v2_regtest_reorg_latest.json');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
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
    'Exercise UTXORef V2 challenge monitoring through a real isolated Core reorg.',
    'This command refuses to run unless Core reports chain=regtest.',
    '',
    '  node utxoref_v2_reorg_drill.js --wallet utxoref-reorg-drill \\',
    '    --rpc-url http://127.0.0.1:18443 --rpc-user <user> --rpc-pass <pass>'
  ].join('\n');
}

function resolveRpc(args) {
  const rpcUrl = args.rpcUrl || process.env.BTC_RPC_URL;
  const rpcUser = args.rpcUser || process.env.BTC_RPC_USER;
  const rpcPass = args.rpcPass || process.env.BTC_RPC_PASS;
  if (!rpcUrl || !rpcUser || !rpcPass) throw new Error('reorg drill requires RPC URL, user, and password');
  return rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId: 'utxoref-v2-reorg-drill' });
}

async function ensureWallet(rpc, wallet) {
  try {
    await rpc('getwalletinfo', [], wallet);
    return;
  } catch (_err) {
    try { await rpc('loadwallet', [wallet]); return; } catch (_loadErr) { /* Create it below. */ }
  }
  await rpc('createwallet', [wallet, false, false, '', false, true]);
}

function findAddressOutput(decoded, address) {
  const output = decoded.vout.find((candidate) => candidate.scriptPubKey?.address === address);
  if (!output) throw new Error('could not locate the drill output');
  const amountSats = BigInt(Math.round(Number(output.value) * 100000000));
  return {
    vout: Number(output.n),
    amountSats: amountSats.toString(),
    scriptPubKeyHex: String(output.scriptPubKey.hex).toLowerCase()
  };
}

async function runDrill(args, rpc) {
  const chain = await rpc('getblockchaininfo');
  if (chain.chain !== 'regtest') throw new Error(`reorg drill refuses chain ${chain.chain}; use an isolated regtest node`);
  const wallet = args.wallet || 'utxoref-reorg-drill';
  await ensureWallet(rpc, wallet);
  const miningAddress = await rpc('getnewaddress', ['reorg-mining', 'bech32'], wallet);
  const balance = Number(await rpc('getbalance', [], wallet));
  if (balance < 0.001) {
    await rpc('generatetoaddress', [1, miningAddress]);
    await rpc('generatetodescriptor', [100, 'raw(51)']);
  }

  const challengeAddress = await rpc('getnewaddress', ['reorg-challenge', 'bech32'], wallet);
  const txid = await rpc('sendtoaddress', [challengeAddress, 0.0001, 'UTXORef V2 reorg drill'], wallet);
  const decoded = await rpc('getrawtransaction', [txid, true]);
  const output = findAddressOutput(decoded, challengeAddress);
  const state = {
    challenge: {
      graphHash: '00'.repeat(32),
      txid,
      vout: output.vout,
      outputSats: output.amountSats,
      challengeScriptPubKeyHex: output.scriptPubKeyHex,
      confirmation: null,
      confirmationHistory: [],
      reorgPending: false
    }
  };

  let height = Number((await rpc('getblockchaininfo')).blocks);
  const mempool = await monitorChallenge(rpc, state, height);
  if (mempool.action !== 'challenge_in_mempool') throw new Error(`expected mempool state, got ${mempool.action}`);

  const [firstBlockHash] = await rpc('generatetoaddress', [1, miningAddress]);
  height++;
  const confirmed = await monitorChallenge(rpc, state, height);
  if (confirmed.action !== 'challenge_confirmed') throw new Error(`expected confirmation, got ${confirmed.action}`);

  await rpc('invalidateblock', [firstBlockHash]);
  height--;
  const reorged = await monitorChallenge(rpc, state, height);
  if (reorged.action !== 'challenge_in_mempool' || !reorged.reorgDetected || !state.challenge.reorgPending) {
    throw new Error(`expected reorg-to-mempool, got ${reorged.action}`);
  }

  const remineAddress = await rpc('getnewaddress', ['reorg-reconfirmation', 'bech32'], wallet);
  const [secondBlockHash] = await rpc('generatetoaddress', [1, remineAddress]);
  height++;
  const reconfirmed = await monitorChallenge(rpc, state, height);
  if (reconfirmed.action !== 'challenge_reconfirmed' || state.challenge.reorgPending) {
    throw new Error(`expected reconfirmation, got ${reconfirmed.action}`);
  }

  return {
    kind: 'utxoref_v2_regtest_reorg_drill_receipt',
    version: 1,
    observedAt: new Date().toISOString(),
    chain: 'regtest',
    txid,
    vout: output.vout,
    amountSats: output.amountSats,
    firstBlockHash,
    secondBlockHash,
    actions: [mempool.action, confirmed.action, reorged.action, reconfirmed.action],
    reorgDetected: reorged.reorgDetected,
    confirmationHistory: state.challenge.confirmationHistory,
    finalConfirmation: state.challenge.confirmation
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const receipt = await runDrill(args, resolveRpc(args));
  saveJsonAtomic(path.resolve(args.receipt || DEFAULT_RECEIPT), receipt);
  console.log(JSON.stringify(receipt));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef V2 reorg drill failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, findAddressOutput, runDrill };
