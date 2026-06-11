#!/usr/bin/env node

/**
 * On-chain BitVM dispute timeout reclaim.
 *
 * The operator bonds funds into the assert output (the full cap<=reserve
 * disprove tree PLUS a CSV timeout leaf). If no challenger disproves within the
 * challenge window, the operator reclaims the bond by spending the timeout leaf
 * on the script path, with nSequence encoding the relative-block delay so
 * OP_CHECKSEQUENCEVERIFY passes. This is the honest-operator-wins path of the
 * dispute game (the disprove path is tradelayer_bitvm_circuit_demo.js).
 *
 *   node tradelayer_bitvm_timeout_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet wallet.dat --broadcast
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const dispute = require('./tradelayer_bitvm_dispute');
const cmp = require('./tradelayer_bitvm_comparator');
const a = require('./tradelayer_dlc_adaptor_sig');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected arg ${arg}`);
    args[arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = argv[++i];
  }
  return args;
}
function randScalar() { return a.mod(a.bufToBig(crypto.randomBytes(32)), a.N); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = rpcFactory({ rpcUrl: args.rpcUrl || 'http://127.0.0.1:19332', rpcUser: args.rpcUser || 'user', rpcPass: args.rpcPass || 'pass' });
  const wallet = args.wallet || 'wallet.dat';
  const lockSats = Number(args.lockSats || 100000);
  const fee = 600;
  const csvDelay = Number(args.csv || 2);
  const nBits = Number(args.nbits || 8);

  const internalSecret = randScalar();
  const internalXonly = a.bytes32(a.pointMul(a.G, internalSecret).x);
  const operatorSecret = randScalar();
  const operatorXonly = a.xOnlyPubkey(operatorSecret);
  const challengerXonly = a.xOnlyPubkey(randScalar()).toString('hex');

  // assert output: full disprove tree + CSV timeout leaf
  const circuit = cmp.buildComparatorCircuit(nBits);
  const wireMap = cmp.commitCircuitWires(circuit);
  const disproveScripts = cmp.buildComparatorDisproveLeaves(circuit, wireMap, challengerXonly).map((l) => l.script);
  const dtree = dispute.buildDisputeTree({ disproveScripts, operatorXonly: operatorXonly.toString('hex'), csvDelay });
  const tw = ts.taprootTweakWithRoot(internalXonly, dtree.root);
  const p2trSpk = ts.taprootScriptPubKeyWithRoot(internalXonly, dtree.root).toString('hex');
  const timeoutControl = dispute.controlBlockWithPath(internalXonly, tw.parity, dtree.timeoutLeaf.leafVersion, dtree.timeoutLeaf.path).toString('hex');

  // fund the assert output
  const us = await rpc('listunspent', [1, 9999999], wallet);
  const utxo = us.filter((u) => Math.round(u.amount * 1e8) >= lockSats + 2 * fee && u.spendable).sort((x, y) => x.amount - y.amount)[0];
  if (!utxo) throw new Error('no spendable funding UTXO large enough');
  const inSats = Math.round(utxo.amount * 1e8);
  const recoverySpk = (await rpc('getaddressinfo', [utxo.address], wallet)).scriptPubKey;
  const fundUnsignedHex = tr.serializeUnsignedTx(2,
    [{ outpoint: tr.outpoint(utxo.txid, utxo.vout), sequence: 0xfffffffd }],
    [{ valueSats: lockSats, script: p2trSpk }, { valueSats: inSats - lockSats - fee, script: recoverySpk }], 0);
  const fundSigned = await rpc('signrawtransactionwithwallet', [fundUnsignedHex], wallet);
  if (!fundSigned.complete) throw new Error('funding sign incomplete');
  const fundTxid = (await rpc('decoderawtransaction', [fundSigned.hex])).txid;

  // timeout spend (operator reclaims) - nSequence encodes the relative delay
  const seq = dispute.csvSequence(csvDelay);
  const spendParsed = {
    version: 2,
    vin: [{ outpoint: Buffer.from(tr.outpoint(fundTxid, 0), 'hex'), sequence: seq }],
    vout: [{ value: BigInt(lockSats - fee), script: Buffer.from(recoverySpk, 'hex') }],
    locktime: 0
  };
  const sighash = ts.scriptPathSighash(spendParsed, [{ scriptPubKey: p2trSpk, amountSats: lockSats }], 0, dtree.timeoutLeaf.leafHash);
  const opSig = a.schnorrSign(operatorSecret, sighash);
  const witness = [opSig.toString('hex'), dtree.timeoutScript, timeoutControl];
  const spendHex = tr.serializeWitnessTx(2,
    [{ outpoint: tr.outpoint(fundTxid, 0), scriptSig: '', sequence: seq, witness }],
    [{ valueSats: lockSats - fee, script: recoverySpk }], 0);
  const spendTxid = (await rpc('decoderawtransaction', [spendHex])).txid;

  console.log('BitVM dispute timeout reclaim:');
  console.log(`  assert tree       : ${disproveScripts.length} disprove leaves + 1 CSV timeout leaf (csv=${csvDelay} blocks)`);
  console.log('  P2TR scriptPubKey :', p2trSpk);
  console.log('  funding txid      :', fundTxid);
  console.log('  timeout spend txid:', spendTxid, `(nSequence=${seq})`);

  const result = {
    kind: 'tradelayer_bitvm_dispute_timeout', csvDelay, nBits, disproveLeaves: disproveScripts.length,
    timeoutScript: dtree.timeoutScript, p2trScriptPubKey: p2trSpk, fundingTxid: fundTxid, spendTxid
  };

  if (args.broadcast) {
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `bitvm-timeout internal=${a.bytes32(internalSecret).toString('hex')} op=${a.bytes32(operatorSecret).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });
    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    console.log('  BROADCAST funding :', fid, '- waiting for', csvDelay, 'confirmations for CSV maturity...');
    for (let i = 0; i < 60; i++) {
      const d = await rpc('getrawtransaction', [fid, true]);
      if ((d.confirmations || 0) >= csvDelay) break;
      await sleep(15000);
    }
    const sa = await rpc('testmempoolaccept', [[spendHex]]);
    if (!sa[0].allowed) { console.error('  TIMEOUT SPEND REJECTED:', JSON.stringify(sa[0]), '\n  recover via', keyFile); throw new Error('timeout spend rejected'); }
    const sid = await rpc('sendrawtransaction', [spendHex]);
    result.broadcast = { fundingTxid: fid, spendTxid: sid };
    console.log('  BROADCAST timeout :', sid, '(CSV matured, operator reclaimed the bond)');
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bitvm_dispute_timeout_latest.json'), JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error('bitvm timeout demo failed:', e.message); process.exit(1); });
