#!/usr/bin/env node

/**
 * On-chain BitVM gate disprove.
 *
 * A prover fraudulently asserts "1 AND 1 = 0". The gate's disprove leaf for that
 * invalid truth-table row is bonded into a taproot output; the challenger spends
 * it on the script path by revealing the prover's own preimages for a=1, b=1,
 * c=0 plus a signature. The network executes the 3-wire reveal tapscript, so the
 * gate's correctness is enforced by real Bitcoin Script.
 *
 *   node tradelayer_bitvm_gate_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet wallet.dat --broadcast
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const c = require('./tradelayer_bitvm_circuit');
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = rpcFactory({ rpcUrl: args.rpcUrl || 'http://127.0.0.1:19332', rpcUser: args.rpcUser || 'user', rpcPass: args.rpcPass || 'pass' });
  const wallet = args.wallet || 'wallet.dat';
  const lockSats = Number(args.lockSats || 100000);
  const fee = 500;
  const gateType = args.gate || 'and';

  const internalSecret = randScalar();
  const internalXonly = a.bytes32(a.pointMul(a.G, internalSecret).x);
  const challengerSecret = randScalar();
  const challengerXonly = a.xOnlyPubkey(challengerSecret);

  // gate over fresh wires; prover fraudulently asserts 1 AND 1 = 0
  const wires = { inputs: [c.buildWire('a'), c.buildWire('b')], output: c.buildWire('c') };
  const asserted = { inputs: [1, 1], output: 0 };
  const fraud = c.findGateFraud(gateType, wires, asserted, challengerXonly.toString('hex'));
  if (!fraud) throw new Error('assertion is not fraudulent for this gate');

  // bond the disprove leaf into a taproot output
  const leafHash = ts.tapLeafHash(fraud.script);
  const root = ts.merkleRoot([leafHash]);
  const tweak = ts.taprootTweakWithRoot(internalXonly, root);
  const p2trSpk = ts.taprootScriptPubKeyWithRoot(internalXonly, root).toString('hex');
  const control = ts.controlBlock(internalXonly, tweak.parity, ts.LEAF_VERSION_TAPSCRIPT, []).toString('hex');

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

  const spendParsed = {
    version: 2,
    vin: [{ outpoint: Buffer.from(tr.outpoint(fundTxid, 0), 'hex'), sequence: 0xfffffffd }],
    vout: [{ value: BigInt(lockSats - fee), script: Buffer.from(recoverySpk, 'hex') }],
    locktime: 0
  };
  const sighash = ts.scriptPathSighash(spendParsed, [{ scriptPubKey: p2trSpk, amountSats: lockSats }], 0, leafHash);
  const sig = a.schnorrSign(challengerSecret, sighash);
  // witness: [sig, pre_a1, pre_b1, pre_c0, script, control]
  const witness = [sig.toString('hex'), ...fraud.revealPreimages, fraud.script, control];
  const spendHex = tr.serializeWitnessTx(2,
    [{ outpoint: tr.outpoint(fundTxid, 0), scriptSig: '', sequence: 0xfffffffd, witness }],
    [{ valueSats: lockSats - fee, script: recoverySpk }], 0);
  const spendTxid = (await rpc('decoderawtransaction', [spendHex])).txid;

  console.log(`BitVM gate disprove (${gateType}, prover claimed 1 ${gateType} 1 = 0):`);
  console.log('  disprove script  :', fraud.script);
  console.log('  P2TR scriptPubKey:', p2trSpk);
  console.log('  funding txid     :', fundTxid);
  console.log('  disprove spend   :', spendTxid, '(reveals a=1,b=1,c=0 -> punishes the lie)');

  const result = { kind: 'tradelayer_bitvm_gate_disprove', gateType, asserted, disproveScript: fraud.script, p2trScriptPubKey: p2trSpk, fundingTxid: fundTxid, spendTxid };

  if (args.broadcast) {
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `bitvm-gate internal=${a.bytes32(internalSecret).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });
    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    console.log('  BROADCAST funding:', fid);
    const sa = await rpc('testmempoolaccept', [[spendHex]]);
    if (!sa[0].allowed) { console.error('  SPEND REJECTED:', JSON.stringify(sa[0]), '\n  recover via', keyFile); throw new Error('disprove spend rejected'); }
    const sid = await rpc('sendrawtransaction', [spendHex]);
    result.broadcast = { fundingTxid: fid, spendTxid: sid };
    console.log('  BROADCAST spend  :', sid, '(network executed the gate-disprove tapscript)');
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bitvm_gate_disprove_latest.json'), JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error('bitvm gate demo failed:', e.message); process.exit(1); });
