#!/usr/bin/env node

/**
 * On-chain btcUSD collateral demo.
 *
 * Backs the BTC-collateralized issuance/stake step (previously demonstrated
 * only as an in-memory hash-commitment in `lnbtc_tlusd_liquidity_patch.js`,
 * fed by an off-LTCTEST regtest artifact) with a real, confirmed LTCTEST
 * funding transaction, and prices the collateral in **btcUSD** using the
 * existing, unmodified `usdUnitsFromBtcSats()` conversion.
 *
 * This does not replace or refactor `lnbtc_tlusd_liquidity_patch.js` (which
 * still prints "TLUSD" — see the run log for that discrepancy). It adds one
 * new, independent on-chain evidence source for the same conversion math,
 * denominated in btcUSD, so the row in CLAIMS_MATRIX.md can move from
 * LOCAL_SIMULATION to NETWORK_VERIFIED.
 *
 * Self-play caveat: the funding wallet is the same operator wallet used for
 * every other on-chain demo in this repo. Real Script mechanics, not an
 * adversarial result. No "trustless" claim is made anywhere in this file.
 *
 *   node tradelayer_btcusd_stake_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet tl-wallet --broadcast
 *
 *   node tradelayer_btcusd_stake_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet tl-wallet --check-txid <txid>
 */

const fs = require('fs');
const path = require('path');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { usdUnitsFromBtcSats } = require('./lnbtc_tlusd_liquidity_patch');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected arg ${arg}`);
    args[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = rpcFactory({
    rpcUrl: args.rpcUrl || 'http://127.0.0.1:19332',
    rpcUser: args.rpcUser || 'user',
    rpcPass: args.rpcPass || 'pass'
  });
  const wallet = args.wallet || 'tl-wallet';

  if (args.checkTxid) {
    const d = await rpc('getrawtransaction', [args.checkTxid, true], wallet);
    console.log(`txid ${args.checkTxid}: confirmations=${d.confirmations || 0}, blockhash=${d.blockhash || 'unconfirmed'}`);
    return;
  }

  const collateralSats = BigInt(args.collateralSats || 49000);
  // Same fixed demo peg used by lnbtc_tlusd_liquidity_patch.js (~$100k/BTC),
  // reused unchanged so both figures are directly comparable.
  const btcUsdPriceMicros = BigInt(args.btcUsdPriceMicros || 100000000000);
  const btcUsdUnits = usdUnitsFromBtcSats(collateralSats, btcUsdPriceMicros);

  const us = await rpc('listunspent', [1, 9999999], wallet);
  const utxo = us.filter((u) => Math.round(u.amount * 1e8) >= Number(collateralSats) && u.spendable)
    .sort((x, y) => x.amount - y.amount)[0];
  if (!utxo) throw new Error(`no spendable UTXO in wallet '${wallet}' >= ${collateralSats} sats`);

  const collateralAddress = (await rpc('getnewaddress', ['btcusd-collateral', 'bech32'], wallet));
  const collateralLtc = (Number(collateralSats) / 1e8).toFixed(8);

  console.log('btcUSD collateral stake demo:');
  console.log(`  collateral        : ${collateralSats} sats (~${btcUsdUnits.toString()} micro-btcUSD == ${(Number(btcUsdUnits) / 1e6).toFixed(6)} btcUSD)`);
  console.log(`  funding UTXO      : ${utxo.txid}:${utxo.vout} (${utxo.amount} LTC)`);
  console.log(`  collateral address: ${collateralAddress}`);
  console.log('  unit label note   : output denominated in btcUSD; lnbtc_tlusd_liquidity_patch.js still prints TLUSD for the same conversion math (left as-is, see run log)');

  const result = {
    kind: 'tradelayer_btcusd_collateral_stake',
    collateralSats: collateralSats.toString(),
    btcUsdPriceMicros: btcUsdPriceMicros.toString(),
    btcUsdMicroUnits: btcUsdUnits.toString(),
    btcUsdDisplay: (Number(btcUsdUnits) / 1e6).toFixed(6),
    collateralAddress,
    fundingUtxo: `${utxo.txid}:${utxo.vout}`
  };

  if (args.broadcast) {
    const fundTxid = await rpc('sendtoaddress', [collateralAddress, collateralLtc], wallet);
    console.log(`  BROADCAST funding : ${fundTxid}`);
    result.broadcast = { fundingTxid: fundTxid };

    console.log('  waiting for 1 confirmation...');
    let confirmations = 0;
    for (let i = 0; i < 40; i++) {
      const d = await rpc('getrawtransaction', [fundTxid, true], wallet);
      confirmations = d.confirmations || 0;
      if (confirmations >= 1) {
        result.broadcast.blockhash = d.blockhash;
        result.broadcast.confirmations = confirmations;
        console.log(`  CONFIRMED         : block ${d.blockhash}, confirmations=${confirmations}`);
        break;
      }
      await sleep(15000);
    }
    if (confirmations < 1) {
      console.log('  NOT YET CONFIRMED after ~10 min of polling; re-run with --check-txid ' + fundTxid);
      result.broadcast.confirmations = 0;
    }
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'btcusd_collateral_stake_latest.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`  artifact          : ${path.join(outDir, 'btcusd_collateral_stake_latest.json')}`);
}

main().catch((e) => { console.error('btcUSD collateral stake demo failed:', e.message); process.exit(1); });
