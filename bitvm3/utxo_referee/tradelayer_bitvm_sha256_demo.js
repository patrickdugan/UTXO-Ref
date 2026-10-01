#!/usr/bin/env node

/**
 * On-chain BitVM SHA256 disprove (final-output-equality predicate, Blocks 9-10).
 *
 * Expresses SHA256(final-output bytes) as a ~108k-gate boolean circuit and bonds
 * EVERY gate-disprove leaf (~427k) into one taproot output. The operator
 * publishes a fraudulent SHA256 execution (tampers one gate, e.g. to claim the
 * swept outputs hash to the committed root when they don't); a challenger
 * localizes the inconsistent gate and disproves it on the script path with a
 * deep (~19) merkle-path control block. The network executes that one gate's
 * reveal tapscript and punishes the lie.
 *
 *   node --max-old-space-size=4096 tradelayer_bitvm_sha256_demo.js \
 *     --rpc-url http://127.0.0.1:19332 --rpc-user user --rpc-pass pass \
 *     --wallet wallet.dat --broadcast
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const treeMod = require('./tradelayer_taproot_tree');
const sha = require('./tradelayer_bitvm_sha256');
const circ = require('./tradelayer_bitvm_circuit');
const sol = require('./tradelayer_bitvm_solvency_referee');
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
  const fee = 800;

  const internalSecret = randScalar();
  const internalXonly = a.bytes32(a.pointMul(a.G, internalSecret).x);
  const challengerSecret = randScalar();
  const challengerXonly = a.xOnlyPubkey(challengerSecret).toString('hex');

  // SHA256 of the (demo) final-output bytes as a circuit
  const message = Buffer.from(args.message || 'utxoref-final-output-vector');
  const t0 = Date.now();
  const built = sha.buildSha256Circuit(message.length);
  const wireMap = sol.commitBoundWires({ labels: built.labels }, 'sha256-final-output');
  const { trace } = sha.evaluateSha256(built, message);
  const honestDigest = sha.evaluateSha256(built, message).digestHex;

  // operator tampers one gate to fake the SHA256 result
  const victim = built.gates[Math.floor(built.gates.length * 0.4)];
  trace[victim.output] = 1 - trace[victim.output];
  const fraud = circ.findGatesFraud(built.gates, wireMap, trace, challengerXonly);
  if (!fraud) throw new Error('expected a tampered-gate fraud');

  // bond EVERY disprove leaf of the SHA256 circuit
  console.log(`building SHA256 disprove tree: ${built.gates.length} gates ...`);
  const allLeaves = circ.buildGatesDisproveLeaves(built.gates, wireMap, challengerXonly).map((l) => ({ scriptHex: l.script }));
  const tree = treeMod.buildTaprootTree(allLeaves);
  const fraudLeaf = tree.leaves.find((l) => l.scriptHex === fraud.script);
  if (!fraudLeaf) throw new Error('fraud leaf not in tree');
  const tw = ts.taprootTweakWithRoot(internalXonly, tree.root);
  const p2trSpk = ts.taprootScriptPubKeyWithRoot(internalXonly, tree.root).toString('hex');
  const control = treeMod.controlBlockWithPath(internalXonly, tw.parity, fraudLeaf.leafVersion, fraudLeaf.path).toString('hex');
  console.log(`  ${allLeaves.length} leaves, merkle path depth ${fraudLeaf.path.length}, built in ${Date.now() - t0}ms`);

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

  console.log('BitVM SHA256 disprove (final-output predicate):');
  console.log(`  message bytes     : ${message.length} -> honest digest ${honestDigest.slice(0, 16)}..`);
  console.log(`  circuit           : ${built.gates.length} gates, ${allLeaves.length} disprove leaves bonded`);
  console.log(`  tampered gate     : ${fraud.gate.type} -> ${fraud.gate.output} (merkle path depth ${fraudLeaf.path.length})`);
  console.log('  P2TR scriptPubKey :', p2trSpk);
  console.log('  funding txid      :', fundTxid);
  console.log('  disprove spend    :', spendTxid);

  const result = {
    kind: 'tradelayer_bitvm_sha256_disprove', messageLen: message.length, honestDigest,
    gates: built.gates.length, leaves: allLeaves.length, merklePathDepth: fraudLeaf.path.length,
    tamperedGate: { type: fraud.gate.type, output: fraud.gate.output }, treeRoot: tree.root.toString('hex'),
    p2trScriptPubKey: p2trSpk, fundingTxid: fundTxid, spendTxid
  };

  if (args.broadcast) {
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `bitvm-sha256 internal=${a.bytes32(internalSecret).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });
    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    console.log('  BROADCAST funding :', fid);
    const sa = await rpc('testmempoolaccept', [[spendHex]]);
    if (!sa[0].allowed) { console.error('  SPEND REJECTED:', JSON.stringify(sa[0]), '\n  recover via', keyFile); throw new Error('disprove spend rejected'); }
    const sid = await rpc('sendrawtransaction', [spendHex]);
    result.broadcast = { fundingTxid: fid, spendTxid: sid };
    console.log('  BROADCAST spend   :', sid, '(network executed the SHA256 gate-disprove from the bonded circuit)');
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bitvm_sha256_disprove_latest.json'), JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error('bitvm sha256 demo failed:', e.message); process.exit(1); });
