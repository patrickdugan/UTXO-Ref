#!/usr/bin/env node

/**
 * On-chain BitVM solvency referee with input binding (Block 8).
 *
 * Takes a real (insolvent) reconciliation from the reserve referee, bonds the
 * full solvency assert tree (gate-disprove + input-binding + CSV timeout) into a
 * P2TR output, then has the operator fake a reserve input bit to claim solvent.
 * The challenger disproves on-chain via the input-binding leaf for that bit -
 * the operator can't feed fake inputs to the circuit.
 *
 *   node tradelayer_bitvm_solvency_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet wallet.dat --broadcast
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const treeMod = require('./tradelayer_taproot_tree');
const cmp = require('./tradelayer_bitvm_comparator');
const sol = require('./tradelayer_bitvm_solvency_referee');
const a = require('./tradelayer_dlc_adaptor_sig');
const referee = require('./index');

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
  const fee = 700;
  const nBits = 32;
  const csvDelay = Number(args.csv || 144);

  // real insolvent reconciliation from the reserve referee
  const queue = referee.buildTradeLayerWithdrawalQueue({ requests: [{ id: 'w1', txid: '11'.repeat(32), address: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz', sats: 17164718 }] });
  const recon = referee.buildTradeLayerReserveReconciliation({ queue, reserve: 99000 });
  const reserve = Number(recon.core.reservedSats);
  const cap = Number(recon.core.capSats);

  const circuit = cmp.buildComparatorCircuit(nBits);
  const wireMap = sol.commitBoundWires(circuit, recon.reconciliationHash);
  const internalSecret = randScalar();
  const internalXonly = a.bytes32(a.pointMul(a.G, internalSecret).x);
  const challengerSecret = randScalar();
  const challengerXonly = a.xOnlyPubkey(challengerSecret).toString('hex');
  const operatorXonly = a.xOnlyPubkey(randScalar()).toString('hex');

  // operator fakes a high reserve bit to push reserve above cap (claim solvent)
  const trueR = sol.valueBits(reserve, nBits);
  const fakeBit = 25; // 2^25 = 33554432 > cap, flips the comparison
  const fakedR = [...trueR]; fakedR[fakeBit] = 1;
  const asserted = { r: fakedR, c: sol.valueBits(cap, nBits) };
  const fakedReserve = fakedR.reduce((acc, b, i) => acc + (b ? 2 ** i : 0), 0);
  const fakedSolvent = cmp.evaluateComparator(circuit, fakedReserve, cap).solvent;

  const inputFraud = sol.findInputFraud(circuit, wireMap, reserve, cap, asserted, challengerXonly);
  if (!inputFraud) throw new Error('expected input-binding fraud');

  // bond the full assert tree, locate the input-binding leaf for the faked bit
  const tree = sol.buildSolvencyAssertTree({ circuit, wireMap, reserve, cap, challengerXonly, operatorXonly, csvDelay });
  const fraudLeaf = tree.leaves.find((l) => l.scriptHex === inputFraud.script);
  if (!fraudLeaf) throw new Error('input-binding leaf not in assert tree');
  const tw = ts.taprootTweakWithRoot(internalXonly, tree.root);
  const p2trSpk = ts.taprootScriptPubKeyWithRoot(internalXonly, tree.root).toString('hex');
  const control = treeMod.controlBlockWithPath(internalXonly, tw.parity, fraudLeaf.leafVersion, fraudLeaf.path).toString('hex');

  // fund + disprove spend
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
  const sighash = ts.scriptPathSighash(spendParsed, [{ scriptPubKey: p2trSpk, amountSats: lockSats }], 0, fraudLeaf.leafHash);
  const sig = a.schnorrSign(challengerSecret, sighash);
  const witness = [sig.toString('hex'), ...inputFraud.revealPreimages, inputFraud.script, control];
  const spendHex = tr.serializeWitnessTx(2,
    [{ outpoint: tr.outpoint(fundTxid, 0), scriptSig: '', sequence: 0xfffffffd, witness }],
    [{ valueSats: lockSats - fee, script: recoverySpk }], 0);
  const spendTxid = (await rpc('decoderawtransaction', [spendHex])).txid;

  console.log('BitVM solvency referee disprove (input binding):');
  console.log(`  reconciliation    : reserve=${reserve} cap=${cap} -> solvent=${recon.solvent} (hash ${recon.reconciliationHash.slice(0, 16)}..)`);
  console.log(`  operator faked    : r${fakeBit}=1 -> fakedReserve=${fakedReserve} -> circuit solvent=${fakedSolvent}`);
  console.log(`  assert tree       : ${tree.gateLeafCount} gate + ${tree.inputLeafCount} input-binding + 1 timeout leaves`);
  console.log(`  bad input wire    : ${inputFraud.wire} asserted ${inputFraud.bit} (true ${sol.valueBits(reserve, nBits)[fakeBit]})`);
  console.log('  P2TR scriptPubKey :', p2trSpk);
  console.log('  funding txid      :', fundTxid);
  console.log('  disprove spend    :', spendTxid);

  const result = {
    kind: 'tradelayer_bitvm_solvency_input_disprove', reconciliationHash: recon.reconciliationHash,
    reserve, cap, honestSolvent: recon.solvent ? 1 : 0, fakedReserve, fakedSolvent,
    badInputWire: inputFraud.wire, gateLeaves: tree.gateLeafCount, inputLeaves: tree.inputLeafCount,
    p2trScriptPubKey: p2trSpk, fundingTxid: fundTxid, spendTxid
  };

  if (args.broadcast) {
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `bitvm-solvency internal=${a.bytes32(internalSecret).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });
    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    console.log('  BROADCAST funding :', fid);
    const sa = await rpc('testmempoolaccept', [[spendHex]]);
    if (!sa[0].allowed) { console.error('  SPEND REJECTED:', JSON.stringify(sa[0]), '\n  recover via', keyFile); throw new Error('disprove spend rejected'); }
    const sid = await rpc('sendrawtransaction', [spendHex]);
    result.broadcast = { fundingTxid: fid, spendTxid: sid };
    console.log('  BROADCAST spend   :', sid, '(network punished the faked solvency input)');
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bitvm_solvency_disprove_latest.json'), JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error('bitvm solvency demo failed:', e.message); process.exit(1); });
