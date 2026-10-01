#!/usr/bin/env node

/**
 * On-chain BitVM circuit disprove (the whole predicate bonded in one UTXO).
 *
 * Commits EVERY gate-disprove leaf of the cap<=reserve comparator into a single
 * taproot output. The operator then publishes a fraudulent solvency claim
 * (truly reserve < cap, but asserts solvent). A challenger localizes the
 * inconsistent gate and spends its disprove leaf on the script path, using the
 * leaf's merkle-path control block, so the network executes that one gate's
 * reveal tapscript and punishes the lie - even though the bonded output commits
 * the entire ~300-leaf circuit.
 *
 *   node tradelayer_bitvm_circuit_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet wallet.dat --broadcast
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const tree = require('./tradelayer_taproot_tree');
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = rpcFactory({ rpcUrl: args.rpcUrl || 'http://127.0.0.1:19332', rpcUser: args.rpcUser || 'user', rpcPass: args.rpcPass || 'pass' });
  const wallet = args.wallet || 'wallet.dat';
  const lockSats = Number(args.lockSats || 100000);
  const fee = 600;
  const nBits = Number(args.nbits || 16);

  const internalSecret = randScalar();
  const internalXonly = a.bytes32(a.pointMul(a.G, internalSecret).x);
  const challengerSecret = randScalar();
  const challengerXonly = a.xOnlyPubkey(challengerSecret).toString('hex');

  // comparator over committed wires; operator lies about solvency
  const circuit = cmp.buildComparatorCircuit(nBits);
  const wireMap = cmp.commitCircuitWires(circuit);
  const reserve = Number(args.reserve || 1000);
  const cap = Number(args.cap || 2000); // cap > reserve => truly insolvent
  const trace = cmp.evaluateComparator(circuit, reserve, cap);
  const honestSolvent = trace.solvent;
  trace.solvent = 1; // the lie: claim solvent while insolvent

  const fraud = cmp.findComparatorFraud(circuit, wireMap, trace, challengerXonly);
  if (!fraud) throw new Error('expected a detectable fraud');

  // bond EVERY disprove leaf of the whole circuit into one taproot output
  const allLeaves = cmp.buildComparatorDisproveLeaves(circuit, wireMap, challengerXonly)
    .map((l) => ({ scriptHex: l.script }));
  const built = tree.buildTaprootTree(allLeaves);
  const fraudLeaf = built.leaves.find((l) => l.scriptHex === fraud.script);
  if (!fraudLeaf) throw new Error('fraud leaf not found in committed tree');
  const tw = ts.taprootTweakWithRoot(internalXonly, built.root);
  const p2trSpk = ts.taprootScriptPubKeyWithRoot(internalXonly, built.root).toString('hex');
  const control = tree.controlBlockWithPath(internalXonly, tw.parity, fraudLeaf.leafVersion, fraudLeaf.path).toString('hex');

  // fund + spend
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
  const witness = [sig.toString('hex'), ...fraud.revealPreimages, fraud.script, control];
  const spendHex = tr.serializeWitnessTx(2,
    [{ outpoint: tr.outpoint(fundTxid, 0), scriptSig: '', sequence: 0xfffffffd, witness }],
    [{ valueSats: lockSats - fee, script: recoverySpk }], 0);
  const spendTxid = (await rpc('decoderawtransaction', [spendHex])).txid;

  console.log('BitVM circuit disprove (cap<=reserve, whole circuit bonded):');
  console.log(`  predicate         : ${nBits}-bit cap<=reserve, ${circuit.gates.length} gates, ${allLeaves.length} disprove leaves`);
  console.log(`  reserve=${reserve} cap=${cap} -> honest solvent=${honestSolvent}; operator lied solvent=1`);
  console.log(`  localized bad gate: ${fraud.gate.type}(${fraud.gate.inputs.join(',')}) -> ${fraud.gate.output}`);
  console.log(`  merkle path depth : ${fraudLeaf.path.length}`);
  console.log('  P2TR scriptPubKey :', p2trSpk);
  console.log('  funding txid      :', fundTxid);
  console.log('  disprove spend    :', spendTxid);

  const result = {
    kind: 'tradelayer_bitvm_circuit_disprove', nBits, gates: circuit.gates.length, leaves: allLeaves.length,
    reserve, cap, honestSolvent, claimedSolvent: 1,
    badGate: { type: fraud.gate.type, inputs: fraud.gate.inputs, output: fraud.gate.output },
    merklePathDepth: fraudLeaf.path.length, treeRoot: built.root.toString('hex'),
    p2trScriptPubKey: p2trSpk, fundingTxid: fundTxid, spendTxid
  };

  if (args.broadcast) {
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `bitvm-circuit internal=${a.bytes32(internalSecret).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });
    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    console.log('  BROADCAST funding :', fid);
    const sa = await rpc('testmempoolaccept', [[spendHex]]);
    if (!sa[0].allowed) { console.error('  SPEND REJECTED:', JSON.stringify(sa[0]), '\n  recover via', keyFile); throw new Error('disprove spend rejected'); }
    const sid = await rpc('sendrawtransaction', [spendHex]);
    result.broadcast = { fundingTxid: fid, spendTxid: sid };
    console.log('  BROADCAST spend   :', sid, '(network executed the localized gate-disprove from the bonded circuit)');
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bitvm_circuit_disprove_latest.json'), JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error('bitvm circuit demo failed:', e.message); process.exit(1); });
