#!/usr/bin/env node

/**
 * On-chain DLC refund CET (oracle-non-attestation timeout path).
 *
 * Closes the gap tracked as SECURITY_BLOCKERS.md #9 / NOT_IMPLEMENTED in
 * CLAIMS_MATRIX.md: every prior DLC settlement demo in this repo
 * (tradelayer_taproot_dlc_demo.js, tradelayer_musig2_dlc_demo.js,
 * tradelayer_dlc_cet_oracle_selection.js) assumes the oracle eventually
 * attests some outcome. This demo funds a 2-of-2 DLC collateral output whose
 * ONLY spending path is a CSV-gated refund requiring both parties'
 * signatures and NO oracle input at all — modeling the refund CET both
 * parties pre-sign at contract setup, broadcastable once the timeout
 * matures if the oracle never shows up.
 *
 * Reuses only already-proven, already-tested primitives:
 *   - tradelayer_taproot.js / tradelayer_taproot_script.js (BIP341 tweak,
 *     sighash, script-path machinery - same as every prior on-chain demo)
 *   - tradelayer_taproot_tree.js (single-leaf taproot tree + control block)
 *   - tradelayer_dlc_adaptor_sig.js's existing exports only (pointMul,
 *     schnorrSign, xOnlyPubkey, bytes32, mod, bufToBig, N, G) - no new
 *     functions added to that file, and no adaptor/oracle logic invoked.
 * No MuSig2 aggregation and no adaptor pre-signature are used here on
 * purpose: this path must not depend on the oracle or on the cooperative
 * settlement machinery at all.
 *
 * Self-play caveat: both party keys are generated and controlled by the
 * same operator wallet/process that runs every other demo in this repo.
 * This proves the Script mechanics execute as designed; it does not
 * demonstrate two independent parties. See SECURITY_BLOCKERS.md #3 and
 * docs/ADVERSARIAL_SIGNET_PLAN.md (Scenario E) for the separated-keys
 * rehearsal this demo is a prerequisite for, not a substitute for.
 *
 * Default expiry cadence is 24 hours (576 blocks at Litecoin's ~2.5 min
 * block time), not a toy value - a real refund window needs to be
 * denominated in wall-clock time, not a handful of test blocks. Because
 * 576 confirmations cannot be waited out inline in one script run, this
 * driver is two phases:
 *
 *   1. Fund + pre-sign (fast): builds the refund tx now and saves it.
 *        node tradelayer_dlc_refund_cet_demo.js --rpc-url http://127.0.0.1:19332 \
 *          --rpc-user user --rpc-pass pass --wallet tl-wallet --broadcast
 *
 *   2. Settle (run again once the window has actually passed): checks the
 *      funding tx's confirmation count and broadcasts the saved refund tx
 *      only once csvDelay confirmations have accrued.
 *        node tradelayer_dlc_refund_cet_demo.js --rpc-url http://127.0.0.1:19332 \
 *          --rpc-user user --rpc-pass pass --settle <fundingTxid>
 *
 * Pass --csv <n> to override the block count for testing (e.g. --csv 2).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const { buildTaprootTree, controlBlockWithPath } = require('./tradelayer_taproot_tree');
const a = require('./tradelayer_dlc_adaptor_sig');

const OP_CHECKSEQUENCEVERIFY = 0xb2;
const OP_DROP = 0x75;
const OP_CHECKSIGVERIFY = 0xad;
const OP_CHECKSIG = 0xac;
const OP_PUSH32 = 0x20;

function pushScriptNum(n) {
  if (n < 0) throw new Error('csv delay must be >= 0');
  if (n === 0) return Buffer.from([0x00]);
  if (n <= 16) return Buffer.from([0x50 + n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.push(v & 0xff); v >>= 8; }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return Buffer.concat([Buffer.from([bytes.length]), Buffer.from(bytes)]);
}

function csvSequence(csvDelay) {
  if (csvDelay < 0 || csvDelay > 0xffff) throw new Error('csv delay out of block range');
  return csvDelay;
}

// <csvDelay> OP_CSV OP_DROP <pubkeyA> OP_CHECKSIGVERIFY <pubkeyB> OP_CHECKSIG
// Both signatures required (2-of-2), and only spendable after csvDelay blocks.
// No oracle attestation appears anywhere in this script.
function buildRefundLeafScript(pkAXonly, pkBXonly, csvDelay) {
  const a32 = Buffer.from(pkAXonly, 'hex');
  const b32 = Buffer.from(pkBXonly, 'hex');
  if (a32.length !== 32 || b32.length !== 32) throw new Error('pubkeys must be 32-byte x-only');
  return Buffer.concat([
    pushScriptNum(csvDelay),
    Buffer.from([OP_CHECKSEQUENCEVERIFY, OP_DROP, OP_PUSH32]), a32,
    Buffer.from([OP_CHECKSIGVERIFY, OP_PUSH32]), b32,
    Buffer.from([OP_CHECKSIG])
  ]).toString('hex');
}

// 24h at Litecoin's ~2.5 min (150s) target block time: 86400 / 150 = 576.
const DEFAULT_CSV_BLOCKS = 576;

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

async function settle(args, rpc) {
  const fundTxid = args.settle;
  const artifactPath = path.join(__dirname, 'artifacts', 'live', 'dlc_refund_cet_latest.json');
  if (!fs.existsSync(artifactPath)) throw new Error(`no saved refund artifact at ${artifactPath}`);
  const saved = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  if (saved.fundingTxid !== fundTxid) {
    throw new Error(`saved artifact is for funding txid ${saved.fundingTxid}, not ${fundTxid}`);
  }
  if (!saved.refundSpendHex) throw new Error('saved artifact has no refundSpendHex to broadcast (was it built before this driver supported --settle?)');

  const d = await rpc('getrawtransaction', [fundTxid, true]);
  const confirmations = d.confirmations || 0;
  console.log(`DLC refund CET settle check: funding ${fundTxid} has ${confirmations}/${saved.csvDelay} confirmations`);
  if (confirmations < saved.csvDelay) {
    const remaining = saved.csvDelay - confirmations;
    console.log(`  NOT YET MATURE — ${remaining} more confirmation(s) needed (~${(remaining * 2.5).toFixed(0)} min at Litecoin's average block time)`);
    return;
  }

  const sa = await rpc('testmempoolaccept', [[saved.refundSpendHex]]);
  if (!sa[0].allowed) throw new Error('refund spend rejected: ' + JSON.stringify(sa[0]));
  const sid = await rpc('sendrawtransaction', [saved.refundSpendHex]);
  console.log(`  BROADCAST refund  : ${sid} (CSV matured, both pre-agreed shares paid out, no oracle involved)`);
  saved.settled = { spendTxid: sid, settledAt: new Date().toISOString() };
  fs.writeFileSync(artifactPath, JSON.stringify(saved, null, 2) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpc = rpcFactory({ rpcUrl: args.rpcUrl || 'http://127.0.0.1:19332', rpcUser: args.rpcUser || 'user', rpcPass: args.rpcPass || 'pass' });

  if (args.settle) {
    await settle(args, rpc);
    return;
  }

  const wallet = args.wallet || 'tl-wallet';
  const lockSats = Number(args.lockSats || 20000);
  const fee = 600;
  const csvDelay = Number(args.csv || DEFAULT_CSV_BLOCKS);
  // Pre-agreed refund split, decided at contract setup - not renegotiated later.
  const shareASats = Math.floor((lockSats - fee) * Number(args.shareABps || 5000) / 10000);
  const shareBSats = (lockSats - fee) - shareASats;

  const internalSecret = randScalar();
  const internalXonly = a.bytes32(a.pointMul(a.G, internalSecret).x);
  const secretA = randScalar();
  const secretB = randScalar();
  const xonlyA = a.xOnlyPubkey(secretA);
  const xonlyB = a.xOnlyPubkey(secretB);

  const refundScript = buildRefundLeafScript(xonlyA.toString('hex'), xonlyB.toString('hex'), csvDelay);
  const built = buildTaprootTree([{ scriptHex: refundScript, kind: 'refund' }]);
  const refundLeaf = built.leaves.find((l) => l.kind === 'refund');
  const tw = ts.taprootTweakWithRoot(internalXonly, built.root);
  const p2trSpk = ts.taprootScriptPubKeyWithRoot(internalXonly, built.root).toString('hex');
  const refundControl = controlBlockWithPath(internalXonly, tw.parity, refundLeaf.leafVersion, refundLeaf.path).toString('hex');

  // fund the DLC collateral output
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

  // refund spend: two outputs (party A share, party B share), no oracle input anywhere
  const addrA = await rpc('getnewaddress', ['dlc-refund-party-a', 'bech32'], wallet);
  const addrB = await rpc('getnewaddress', ['dlc-refund-party-b', 'bech32'], wallet);
  const spkA = (await rpc('getaddressinfo', [addrA], wallet)).scriptPubKey;
  const spkB = (await rpc('getaddressinfo', [addrB], wallet)).scriptPubKey;

  const seq = csvSequence(csvDelay);
  const spendParsed = {
    version: 2,
    vin: [{ outpoint: Buffer.from(tr.outpoint(fundTxid, 0), 'hex'), sequence: seq }],
    vout: [
      { value: BigInt(shareASats), script: Buffer.from(spkA, 'hex') },
      { value: BigInt(shareBSats), script: Buffer.from(spkB, 'hex') }
    ],
    locktime: 0
  };
  const sighash = ts.scriptPathSighash(spendParsed, [{ scriptPubKey: p2trSpk, amountSats: lockSats }], 0, refundLeaf.leafHash);
  const sigA = a.schnorrSign(secretA, sighash);
  const sigB = a.schnorrSign(secretB, sighash);
  // Witness stack order for `<pkA> CHECKSIGVERIFY <pkB> CHECKSIG`: sigA must be
  // on top when CHECKSIGVERIFY runs first, so it is the LAST initial-stack item.
  const witness = [sigB.toString('hex'), sigA.toString('hex'), refundScript, refundControl];
  const spendHex = tr.serializeWitnessTx(2,
    [{ outpoint: tr.outpoint(fundTxid, 0), scriptSig: '', sequence: seq, witness }],
    [
      { valueSats: shareASats, script: spkA },
      { valueSats: shareBSats, script: spkB }
    ], 0);
  const spendTxid = (await rpc('decoderawtransaction', [spendHex])).txid;

  console.log('DLC refund CET (oracle-non-attestation timeout path):');
  console.log(`  csv delay         : ${csvDelay} blocks (~${(csvDelay * 2.5 / 60).toFixed(1)} hours at Litecoin's average block time; oracle never consulted)`);
  console.log('  P2TR scriptPubKey :', p2trSpk);
  console.log(`  collateral        : ${lockSats} sats -> party A ${shareASats} sats, party B ${shareBSats} sats (pre-agreed split)`);
  console.log('  funding txid      :', fundTxid);
  console.log('  refund spend txid :', spendTxid, `(nSequence=${seq}, pre-signed now, not yet broadcastable until CSV matures)`);

  const result = {
    kind: 'tradelayer_dlc_refund_cet',
    csvDelay,
    lockSats,
    shareASats,
    shareBSats,
    refundScript,
    refundSpendHex: spendHex,
    p2trScriptPubKey: p2trSpk,
    fundingTxid: fundTxid,
    spendTxid,
    oracleInvolved: false,
    selfPlay: true
  };

  if (args.broadcast) {
    const keyFile = path.join(__dirname, 'artifacts', 'live', 'refund_cet_recovery_key.hex');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `dlc-refund internal=${a.bytes32(internalSecret).toString('hex')} A=${a.bytes32(secretA).toString('hex')} B=${a.bytes32(secretB).toString('hex')} ${p2trSpk} fund?->${fundTxid}:0=${lockSats}\n`, { flag: 'a' });
    const fa = await rpc('testmempoolaccept', [[fundSigned.hex]]);
    if (!fa[0].allowed) throw new Error('funding rejected: ' + JSON.stringify(fa[0]));
    const fid = await rpc('sendrawtransaction', [fundSigned.hex]);
    result.broadcast = { fundingTxid: fid };
    console.log('  BROADCAST funding :', fid);
    console.log(`  refund matures after ${csvDelay} confirmations on the funding tx (~${(csvDelay * 2.5 / 60).toFixed(1)} hours from now).`);
    console.log(`  Re-run once matured: node ${path.basename(__filename)} --rpc-url ${args.rpcUrl || 'http://127.0.0.1:19332'} --rpc-user ${args.rpcUser || 'user'} --rpc-pass ${args.rpcPass || 'pass'} --settle ${fid}`);
  } else {
    console.log('  (dry run; pass --broadcast to send)');
  }

  const outDir = path.join(__dirname, 'artifacts', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'dlc_refund_cet_latest.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`  artifact          : ${path.join(outDir, 'dlc_refund_cet_latest.json')}`);
}

main().catch((e) => { console.error('DLC refund CET demo failed:', e.message); process.exit(1); });
