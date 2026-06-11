#!/usr/bin/env node

/**
 * On-chain 2-party MuSig2 adaptor-signature DLC over taproot.
 *
 * The funding output is a P2TR keypath whose internal key is the MuSig2
 * aggregate of two parties. Settlement needs BOTH partial signatures AND the
 * oracle attestation scalar: neither party can spend unilaterally, and the spend
 * cannot complete until the oracle attests. This is the enforcement the
 * single-key keypath demo lacked.
 *
 *   node tradelayer_musig2_dlc_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet wallet.dat --broadcast
 *
 * Both party keys are generated here (so the 2-of-2 is fully recoverable);
 * persisted to a gitignored recovery file on --broadcast.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const m = require('./tradelayer_musig2');
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
function makeNonce() {
  const k1 = randScalar(); const k2 = randScalar();
  return {
    sec: Buffer.concat([a.bytes32(k1), a.bytes32(k2)]),
    pub: Buffer.concat([m.cbytes(a.pointMul(a.G, k1)), m.cbytes(a.pointMul(a.G, k2))])
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = rpcFactory({
    rpcUrl: args.rpcUrl || 'http://127.0.0.1:19332',
    rpcUser: args.rpcUser || 'user',
    rpcPass: args.rpcPass || 'pass'
  });
  const wallet = args.wallet || 'wallet.dat';
  const lockSats = Number(args.lockSats || 100000);
  const fee = 500;

  // two parties + MuSig2 aggregate, taproot-tweaked into a P2TR keypath output
  const skA = randScalar(); const skB = randScalar();
  const pkA = m.cbytes(a.pointMul(a.G, skA)); const pkB = m.cbytes(a.pointMul(a.G, skB));
  const ctx = m.keyAgg([pkA, pkB]);
  const internalXonly = m.xbytes(ctx.Q);
  const tweak = a.bytes32(tr.tapTweakScalar(internalXonly, null));
  const tctx = m.applyTweak(ctx, tweak, true);
  const outputKey = m.xbytes(tctx.Q);
  const p2trSpk = '5120' + outputKey.toString('hex');

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
  if (!fundSigned.complete) throw new Error('funding sign incomplete: ' + JSON.stringify(fundSigned.errors));
  const fundTxid = (await rpc('decoderawtransaction', [fundSigned.hex])).txid;

  // spend sighash (P2TR keypath -> recovery)
  const spendParsed = {
    version: 2,
    vin: [{ outpoint: Buffer.from(tr.outpoint(fundTxid, 0), 'hex'), sequence: 0xfffffffd }],
    vout: [{ value: BigInt(lockSats - fee), script: Buffer.from(recoverySpk, 'hex') }],
    locktime: 0
  };
  const sighash = tr.bip341SighashDefault(spendParsed, [{ scriptPubKey: p2trSpk, amountSats: lockSats }], 0);

  // oracle adaptor over the 2-party MuSig2 signature
  const oracle = a.buildDlcOracle(randScalar(), randScalar());
  const outcomeId = args.outcome || 'settle-loss';
  const outcomeMsg = crypto.createHash('sha256').update(outcomeId).digest();
  const T = a.dlcOutcomePoint(oracle, outcomeMsg);

  const nA = makeNonce(); const nB = makeNonce();
  const aggnonce = m.nonceAgg([nA.pub, nB.pub]);
  const session = m.sessionValues(aggnonce, tctx, sighash, T);
  const psA = m.partialSign(nA.sec, a.bytes32(skA), tctx, session);
  const psB = m.partialSign(nB.sec, a.bytes32(skB), tctx, session);
  const preAgg = m.partialSigAggAdaptor([psA, psB], tctx, session);

  // neither party alone, and not without the oracle
  const soloSig = m.adaptorCompleteMuSig(m.partialSigAggAdaptor([psA], tctx, session), a.dlcAttest(oracle, outcomeMsg));
  if (a.schnorrVerify(outputKey, sighash, soloSig)) throw new Error('SECURITY: one party settled alone');
  const preAsSig = Buffer.concat([Buffer.from(preAgg.rx, 'hex'), Buffer.from(preAgg.sPrime, 'hex')]);
  if (a.schnorrVerify(outputKey, sighash, preAsSig)) throw new Error('SECURITY: pre-sig valid without oracle');

  const attestation = a.dlcAttest(oracle, outcomeMsg);
  const sig = m.adaptorCompleteMuSig(preAgg, attestation);
  if (!a.schnorrVerify(outputKey, sighash, sig)) throw new Error('completed 2-party signature failed verification');

  const spendHex = tr.serializeWitnessTx(2,
    [{ outpoint: tr.outpoint(fundTxid, 0), scriptSig: '', sequence: 0xfffffffd, witness: [sig.toString('hex')] }],
    [{ valueSats: lockSats - fee, script: recoverySpk }], 0);
  const spendTxid = (await rpc('decoderawtransaction', [spendHex])).txid;

  console.log('2-party MuSig2 adaptor DLC built:');
  console.log('  P2TR scriptPubKey :', p2trSpk);
  console.log('  aggregate (MuSig2):', internalXonly.toString('hex'));
  console.log('  funding txid      :', fundTxid);
  console.log('  spend txid        :', spendTxid);
  console.log('  one-party-alone   : rejected (good)');
  console.log('  pre-sig w/o oracle: rejected (good)');
  console.log('  completed 2/2+oracle sig: valid BIP340 vs output key');

  const result = {
    kind: 'tradelayer_musig2_taproot_adaptor_dlc',
    p2trScriptPubKey: p2trSpk,
    aggregateInternalKey: internalXonly.toString('hex'),
    outputKey: outputKey.toString('hex'),
    fundingTxid: fundTxid,
    spendTxid,
    outcomeId,
    oraclePx: oracle.px,
    oracleRx: oracle.rx,
    enforcement: { onePartyAlone: 'rejected', preSigWithoutOracle: 'rejected', twoOfTwoPlusOracle: 'valid' }
  };

  if (args.broadcast) {
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `musig2 skA=${a.bytes32(skA).toString('hex')} skB=${a.bytes32(skB).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });
    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    console.log('  BROADCAST funding :', fid);
    const sa = await rpc('testmempoolaccept', [[spendHex]]);
    if (!sa[0].allowed) { console.error('  SPEND REJECTED:', JSON.stringify(sa[0]), '\n  recover via', keyFile); throw new Error('spend rejected'); }
    const sid = await rpc('sendrawtransaction', [spendHex]);
    result.broadcast = { fundingTxid: fid, spendTxid: sid };
    console.log('  BROADCAST spend   :', sid, '(taproot keypath, 2-party adaptor-completed witness)');
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'musig2_taproot_adaptor_dlc_latest.json'), JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error('musig2 DLC demo failed:', e.message); process.exit(1); });
