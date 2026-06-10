#!/usr/bin/env node

/**
 * On-chain adaptor-signature DLC settlement over taproot.
 *
 * Funds a P2TR keypath output and settles it with a witness signature that is
 * produced by completing an adaptor pre-signature with the oracle's attestation
 * scalar. The taproot tweak + BIP341 sighash are the vector-validated ones in
 * tradelayer_taproot.js, so the hand-built P2TR output is safe to fund even on a
 * Core build without taproot address tooling.
 *
 *   node tradelayer_taproot_dlc_demo.js --rpc-url http://127.0.0.1:19332 \
 *     --rpc-user user --rpc-pass pass --wallet wallet.dat --broadcast
 *
 * Without --broadcast it builds and self-verifies everything offline.
 *
 * Note: this is a single-key keypath spend, so it demonstrates that an
 * adaptor-completed signature settles on-chain. Forcing the signer to wait for
 * the oracle (no unilateral spend) additionally needs a 2-party MuSig2 funding
 * key; the adaptor primitive is identical.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const a = require('./tradelayer_dlc_adaptor_sig');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected arg ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[key] = argv[++i];
  }
  return args;
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

  // 1. internal key + P2TR output (single-key keypath, no script tree)
  const d = a.mod(a.bufToBig(crypto.randomBytes(32)), a.N);
  const internalXonly = a.bytes32(a.pointMul(a.G, d).x);
  const outKey = tr.taprootOutputKey(internalXonly, null);
  const p2trSpk = tr.taprootScriptPubKey(internalXonly, null).toString('hex');
  const tweakedSecret = tr.taprootTweakSecret(d, null);

  // 2. pick a funding input + recovery script
  const us = await rpc('listunspent', [1, 9999999], wallet);
  const utxo = us.filter((u) => Math.round(u.amount * 1e8) >= lockSats + fee + fee && u.spendable)
    .sort((x, y) => x.amount - y.amount)[0];
  if (!utxo) throw new Error('no spendable funding UTXO large enough');
  const inSats = Math.round(utxo.amount * 1e8);
  const recovery = await rpc('getaddressinfo', [utxo.address], wallet);
  const recoverySpk = recovery.scriptPubKey;

  // 3. funding tx: vout0 = P2TR, vout1 = change (hand-built, wallet signs the input)
  const fundUnsignedHex = tr.serializeUnsignedTx(2, [
    { outpoint: tr.outpoint(utxo.txid, utxo.vout), sequence: 0xfffffffd }
  ], [
    { valueSats: lockSats, script: p2trSpk },
    { valueSats: inSats - lockSats - fee, script: recoverySpk }
  ], 0);
  const fundSigned = await rpc('signrawtransactionwithwallet', [fundUnsignedHex], wallet);
  if (!fundSigned.complete) throw new Error('funding sign incomplete: ' + JSON.stringify(fundSigned.errors));
  const fundDecoded = await rpc('decoderawtransaction', [fundSigned.hex]);
  const fundTxid = fundDecoded.txid;

  // 4. spend tx structure (P2TR keypath -> recovery)
  const spendParsed = {
    version: 2,
    vin: [{ outpoint: Buffer.from(tr.outpoint(fundTxid, 0), 'hex'), sequence: 0xfffffffd }],
    vout: [{ value: BigInt(lockSats - fee), script: Buffer.from(recoverySpk, 'hex') }],
    locktime: 0
  };
  const sighash = tr.bip341SighashDefault(spendParsed, [{ scriptPubKey: p2trSpk, amountSats: lockSats }], 0);

  // 5. oracle adaptor flow gating the keypath signature
  const oracle = a.buildDlcOracle(
    a.mod(a.bufToBig(crypto.randomBytes(32)), a.N),
    a.mod(a.bufToBig(crypto.randomBytes(32)), a.N)
  );
  const outcomeId = args.outcome || 'settle-loss';
  const outcomeMsg = crypto.createHash('sha256').update(outcomeId).digest();
  const T = a.dlcOutcomePoint(oracle, outcomeMsg);
  const presig = a.adaptorSign(tweakedSecret, sighash, T);
  if (!a.adaptorVerify(outKey.xonly, sighash, presig)) throw new Error('adaptor pre-sig failed to verify');
  const attestation = a.dlcAttest(oracle, outcomeMsg);
  const sig = a.adaptorComplete(presig, attestation);
  if (!a.schnorrVerify(outKey.xonly, sighash, sig)) throw new Error('completed signature failed verification');

  const spendHex = tr.serializeWitnessTx(2, [
    { outpoint: tr.outpoint(fundTxid, 0), scriptSig: '', sequence: 0xfffffffd, witness: [sig.toString('hex')] }
  ], [
    { valueSats: lockSats - fee, script: recoverySpk }
  ], 0);
  const spendDecoded = await rpc('decoderawtransaction', [spendHex]);

  const result = {
    kind: 'tradelayer_taproot_adaptor_dlc',
    p2trScriptPubKey: p2trSpk,
    outputKey: outKey.xonly.toString('hex'),
    fundingTxid: fundTxid,
    spendTxid: spendDecoded.txid,
    outcomeId,
    oraclePx: oracle.px,
    oracleRx: oracle.rx,
    attestation: a.bytes32(attestation).toString('hex'),
    adaptorPresigVerified: true,
    completedSigVerified: true
  };

  console.log('taproot adaptor DLC built:');
  console.log('  P2TR scriptPubKey :', p2trSpk);
  console.log('  funding txid      :', fundTxid);
  console.log('  spend txid        :', spendDecoded.txid);
  console.log('  adaptor pre-sig   : verified');
  console.log('  completed sig     : valid BIP340 vs output key');

  if (args.broadcast) {
    // Persist the internal key so the P2TR is recoverable even if this process
    // dies between funding and spend (throwaway testnet key; not committed).
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'taproot_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `${a.bytes32(d).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });

    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    console.log('  BROADCAST funding :', fid);
    const sa = await rpc('testmempoolaccept', [[spendHex]]); // funding now in mempool
    if (!sa[0].allowed) {
      console.error('  SPEND REJECTED:', JSON.stringify(sa[0]));
      console.error('  recovery key saved to', keyFile, '- P2TR is keypath-spendable with it');
      throw new Error('spend rejected after funding; recover via saved key');
    }
    const sid = await rpc('sendrawtransaction', [spendHex]);
    result.broadcast = { fundingTxid: fid, spendTxid: sid };
    console.log('  BROADCAST spend   :', sid, '(taproot keypath, adaptor-completed witness)');
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'taproot_adaptor_dlc_latest.json'), JSON.stringify(result, null, 2) + '\n');
}

main().catch((e) => { console.error('taproot DLC demo failed:', e.message); process.exit(1); });
