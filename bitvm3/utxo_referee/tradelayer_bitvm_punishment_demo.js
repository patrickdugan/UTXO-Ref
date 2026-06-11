#!/usr/bin/env node

/**
 * On-chain BitVM-style referee enforcement over taproot script path.
 *
 * Bonds a taproot output with an equivocation-punishment tapscript leaf: if the
 * prover equivocates on the committed referee bit (reveals BOTH preimages), the
 * challenger can take the bond by spending the leaf on the script path. The
 * network executes the tapscript, so the referee constraint is enforced by real
 * Bitcoin Script rather than a JS evidence object.
 *
 *   node tradelayer_bitvm_punishment_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet wallet.dat --broadcast
 *
 * The internal key is held here (keypath recovery always possible); persisted to
 * a gitignored recovery file on --broadcast.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const g = require('./tradelayer_bitvm_gadgets');
const a = require('./tradelayer_dlc_adaptor_sig');

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
function randScalar() { return a.mod(a.bufToBig(crypto.randomBytes(32)), a.N); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = rpcFactory({ rpcUrl: args.rpcUrl || 'http://127.0.0.1:19332', rpcUser: args.rpcUser || 'user', rpcPass: args.rpcPass || 'pass' });
  const wallet = args.wallet || 'wallet.dat';
  const lockSats = Number(args.lockSats || 100000);
  const fee = 500;

  // internal key (keypath recovery) + challenger key + referee bit commitment
  const internalSecret = randScalar();
  const internalXonly = a.bytes32(a.pointMul(a.G, internalSecret).x);
  const challengerSecret = randScalar();
  const challengerXonly = a.xOnlyPubkey(challengerSecret);
  const commitment = g.buildBitCommitment('referee:final-output-review-bit');

  // equivocation-punishment leaf -> taproot output
  const script = g.buildEquivocationPunishmentScript({ hash0: commitment.hash0, hash1: commitment.hash1, challengerXonly: challengerXonly.toString('hex') });
  const leafHash = ts.tapLeafHash(script);
  const root = ts.merkleRoot([leafHash]);
  const tweak = ts.taprootTweakWithRoot(internalXonly, root);
  const p2trSpk = ts.taprootScriptPubKeyWithRoot(internalXonly, root).toString('hex');
  const control = ts.controlBlock(internalXonly, tweak.parity, ts.LEAF_VERSION_TAPSCRIPT, []).toString('hex');

  // funding input + recovery
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

  // script-path spend: prove equivocation by revealing BOTH preimages
  const spendParsed = {
    version: 2,
    vin: [{ outpoint: Buffer.from(tr.outpoint(fundTxid, 0), 'hex'), sequence: 0xfffffffd }],
    vout: [{ value: BigInt(lockSats - fee), script: Buffer.from(recoverySpk, 'hex') }],
    locktime: 0
  };
  const sighash = ts.scriptPathSighash(spendParsed, [{ scriptPubKey: p2trSpk, amountSats: lockSats }], 0, leafHash);
  const challengerSig = a.schnorrSign(challengerSecret, sighash);
  if (!a.schnorrVerify(challengerXonly, sighash, challengerSig)) throw new Error('challenger signature invalid');

  // witness: [sig, preimage0, preimage1, script, controlBlock]
  const witness = [...g.buildEquivocationWitness({ challengerSigHex: challengerSig.toString('hex'), preimage0: commitment.preimage0, preimage1: commitment.preimage1 }), script, control];
  const spendHex = tr.serializeWitnessTx(2,
    [{ outpoint: tr.outpoint(fundTxid, 0), scriptSig: '', sequence: 0xfffffffd, witness }],
    [{ valueSats: lockSats - fee, script: recoverySpk }], 0);
  const spendTxid = (await rpc('decoderawtransaction', [spendHex])).txid;

  console.log('BitVM equivocation-punishment (taproot script path):');
  console.log('  referee bit hashes: hash0', commitment.hash0.slice(0, 16) + '..', 'hash1', commitment.hash1.slice(0, 16) + '..');
  console.log('  punishment script :', script);
  console.log('  P2TR scriptPubKey :', p2trSpk);
  console.log('  funding txid      :', fundTxid);
  console.log('  script-path spend :', spendTxid, '(reveals both preimages = equivocation)');

  const result = {
    kind: 'tradelayer_bitvm_equivocation_punishment',
    refereeBit: 'final-output-review-bit',
    hash0: commitment.hash0, hash1: commitment.hash1,
    punishmentScript: script, leafHash: leafHash.toString('hex'),
    p2trScriptPubKey: p2trSpk, controlBlock: control,
    fundingTxid: fundTxid, spendTxid
  };

  if (args.broadcast) {
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `bitvm internal=${a.bytes32(internalSecret).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });
    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    console.log('  BROADCAST funding :', fid);
    const sa = await rpc('testmempoolaccept', [[spendHex]]);
    if (!sa[0].allowed) { console.error('  SPEND REJECTED:', JSON.stringify(sa[0]), '\n  recover via', keyFile); throw new Error('script-path spend rejected'); }
    const sid = await rpc('sendrawtransaction', [spendHex]);
    result.broadcast = { fundingTxid: fid, spendTxid: sid };
    console.log('  BROADCAST spend   :', sid, '(network executed the tapscript)');
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'bitvm_punishment_latest.json'), JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error('bitvm punishment demo failed:', e.message); process.exit(1); });
