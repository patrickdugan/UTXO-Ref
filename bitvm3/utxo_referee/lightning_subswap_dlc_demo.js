#!/usr/bin/env node

/**
 * Live regtest submarine-swap-shaped funding demo.
 *
 * Flow:
 * 1. Ensure the local WSL CLN regtest sandbox is running.
 * 2. Create a fresh Bob invoice.
 * 3. Create and broadcast a real Bitcoin regtest P2WSH hashlock output using
 *    that invoice payment hash.
 * 4. Pay the invoice from Alice to reveal the preimage.
 * 5. Spend the hashlock output with that preimage into a BitVM/DLC funding
 *    output commitment.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildFundingOutputCommitment } = require('./lightning_integration');

const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const CLN_ARTIFACT = path.join(ARTIFACT_DIR, 'cln_regtest_demo_latest.json');
const JSON_OUT = path.join(ARTIFACT_DIR, 'lightning_subswap_dlc_latest.json');
const MD_OUT = path.join(ARTIFACT_DIR, 'lightning_subswap_dlc_latest.md');
const CLN_BOOTSTRAP = '/mnt/c/projects/UTXORef/UTXO-Ref/bitvm3/utxo_referee/cln_regtest_demo.sh';
const CURVE_P = BigInt('0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f');
const CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const CURVE_G = {
  x: BigInt('0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
  y: BigInt('0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8')
};

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function sha256Hex(buf) {
  return sha256(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))).toString('hex');
}

function hash256(buf) {
  return sha256(sha256(buf));
}

function mod(value, m) {
  const result = value % m;
  return result >= 0n ? result : result + m;
}

function modPow(base, exponent, m) {
  let result = 1n;
  let x = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * x, m);
    x = mod(x * x, m);
    e >>= 1n;
  }
  return result;
}

function modInv(value, m) {
  return modPow(mod(value, m), m - 2n, m);
}

function pointAdd(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.x === b.x && mod(a.y + b.y, CURVE_P) === 0n) return null;

  const lambda = a.x === b.x && a.y === b.y
    ? mod((3n * a.x * a.x) * modInv(2n * a.y, CURVE_P), CURVE_P)
    : mod((b.y - a.y) * modInv(b.x - a.x, CURVE_P), CURVE_P);
  const x = mod(lambda * lambda - a.x - b.x, CURVE_P);
  const y = mod(lambda * (a.x - x) - a.y, CURVE_P);
  return { x, y };
}

function scalarMultiply(scalar, point = CURVE_G) {
  let n = mod(scalar, CURVE_N);
  let result = null;
  let addend = point;
  while (n > 0n) {
    if (n & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    n >>= 1n;
  }
  return result;
}

function bufferToBigInt(buf) {
  return BigInt(`0x${buf.toString('hex') || '0'}`);
}

function bigIntToBuffer(value, size = 32) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const raw = Buffer.from(hex, 'hex');
  if (raw.length > size) return raw.subarray(raw.length - size);
  if (raw.length === size) return raw;
  return Buffer.concat([Buffer.alloc(size - raw.length), raw]);
}

function reverseHex(hex) {
  return Buffer.from(hex, 'hex').reverse();
}

function u32le(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0);
  return buf;
}

function u64le(n) {
  let value = BigInt(n);
  const buf = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return buf;
}

function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(n, 1);
    return buf;
  }
  const buf = Buffer.alloc(5);
  buf[0] = 0xfe;
  buf.writeUInt32LE(n, 1);
  return buf;
}

function pushData(buf) {
  if (buf.length > 75) throw new Error('pushData only supports short pushes in this demo');
  return Buffer.concat([Buffer.from([buf.length]), buf]);
}

function pushScriptNumber(value) {
  let n = BigInt(value);
  if (n === 0n) return Buffer.from([0x00]);
  const bytes = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return pushData(Buffer.from(bytes));
}

function encodeTxInput(input, withScript) {
  return Buffer.concat([
    reverseHex(input.txid),
    u32le(input.vout),
    withScript ? Buffer.concat([varint(input.script.length), input.script]) : Buffer.from([0x00]),
    u32le(input.sequence)
  ]);
}

function encodeTxOutput(output) {
  return Buffer.concat([
    u64le(output.valueSats),
    varint(output.scriptPubKey.length),
    output.scriptPubKey
  ]);
}

function encodeWitness(stack) {
  return Buffer.concat([
    varint(stack.length),
    ...stack.map(item => Buffer.concat([varint(item.length), item]))
  ]);
}

function encodeTransaction(tx, includeWitness) {
  const base = [
    u32le(tx.version)
  ];
  if (includeWitness) base.push(Buffer.from([0x00, 0x01]));
  base.push(varint(tx.inputs.length));
  base.push(...tx.inputs.map(input => encodeTxInput(input, false)));
  base.push(varint(tx.outputs.length));
  base.push(...tx.outputs.map(encodeTxOutput));
  if (includeWitness) {
    base.push(...tx.inputs.map(input => encodeWitness(input.witness || [])));
  }
  base.push(u32le(tx.locktime));
  return Buffer.concat(base);
}

function bip143Sighash(tx, inputIndex, witnessScript, inputValueSats, sighashType = 1) {
  const hashPrevouts = hash256(Buffer.concat(tx.inputs.map(input => Buffer.concat([
    reverseHex(input.txid),
    u32le(input.vout)
  ]))));
  const hashSequence = hash256(Buffer.concat(tx.inputs.map(input => u32le(input.sequence))));
  const hashOutputs = hash256(Buffer.concat(tx.outputs.map(encodeTxOutput)));
  const input = tx.inputs[inputIndex];
  const preimage = Buffer.concat([
    u32le(tx.version),
    hashPrevouts,
    hashSequence,
    reverseHex(input.txid),
    u32le(input.vout),
    varint(witnessScript.length),
    witnessScript,
    u64le(inputValueSats),
    u32le(input.sequence),
    hashOutputs,
    u32le(tx.locktime),
    u32le(sighashType)
  ]);
  return hash256(preimage);
}

function derLen(len) {
  return len < 128 ? Buffer.from([len]) : Buffer.from([0x81, len]);
}

function sec1PrivateKeyDer(privateKey, publicKeyUncompressed) {
  const oid = Buffer.from('06052b8104000a', 'hex');
  const params = Buffer.concat([Buffer.from([0xa0]), derLen(oid.length), oid]);
  const pubBitString = Buffer.concat([
    Buffer.from([0x03]),
    derLen(publicKeyUncompressed.length + 1),
    Buffer.from([0x00]),
    publicKeyUncompressed
  ]);
  const pubTagged = Buffer.concat([Buffer.from([0xa1]), derLen(pubBitString.length), pubBitString]);
  const body = Buffer.concat([Buffer.from('0201010420', 'hex'), privateKey, params, pubTagged]);
  return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
}

function readDerInt(buf, offset) {
  if (buf[offset] !== 0x02) throw new Error('invalid DER integer');
  const len = buf[offset + 1];
  return {
    value: buf.subarray(offset + 2, offset + 2 + len),
    next: offset + 2 + len
  };
}

function intBufferToBigInt(buf) {
  return BigInt(`0x${buf.toString('hex') || '0'}`);
}

function bigIntToDerInt(value) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let buf = Buffer.from(hex, 'hex');
  while (buf.length > 1 && buf[0] === 0x00 && (buf[1] & 0x80) === 0) {
    buf = buf.subarray(1);
  }
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return Buffer.concat([Buffer.from([0x02, buf.length]), buf]);
}

function ecdsaSignDer(privateKey, digest) {
  const d = bufferToBigInt(privateKey);
  const z = bufferToBigInt(digest);
  for (let counter = 0; counter < 1024; counter++) {
    const seed = Buffer.concat([
      privateKey,
      digest,
      Buffer.from(`:${counter}`)
    ]);
    const k = mod(bufferToBigInt(sha256(seed)), CURVE_N - 1n) + 1n;
    const point = scalarMultiply(k);
    if (!point) continue;
    const r = mod(point.x, CURVE_N);
    if (r === 0n) continue;
    const sRaw = mod(modInv(k, CURVE_N) * (z + r * d), CURVE_N);
    if (sRaw === 0n) continue;
    const s = sRaw > CURVE_N / 2n ? CURVE_N - sRaw : sRaw;
    const body = Buffer.concat([bigIntToDerInt(r), bigIntToDerInt(s)]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  }
  throw new Error('failed to generate ECDSA signature');
}

function normalizeLowSDer(sig) {
  if (sig[0] !== 0x30) throw new Error('invalid DER signature');
  const r = readDerInt(sig, 2);
  const s = readDerInt(sig, r.next);
  const sValue = intBufferToBigInt(s.value);
  const lowS = sValue > CURVE_N / 2n ? CURVE_N - sValue : sValue;
  const body = Buffer.concat([
    bigIntToDerInt(intBufferToBigInt(r.value)),
    bigIntToDerInt(lowS)
  ]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function signDigest(privateKey, publicKeyUncompressed, digest) {
  return ecdsaSignDer(privateKey, digest);
}

function newKeyPair() {
  let privateKey = crypto.randomBytes(32);
  while (bufferToBigInt(privateKey) === 0n || bufferToBigInt(privateKey) >= CURVE_N) {
    privateKey = crypto.randomBytes(32);
  }
  const point = scalarMultiply(bufferToBigInt(privateKey));
  const publicKeyCompressed = Buffer.concat([
    Buffer.from([point.y & 1n ? 0x03 : 0x02]),
    bigIntToBuffer(point.x)
  ]);
  const publicKeyUncompressed = Buffer.concat([
    Buffer.from([0x04]),
    bigIntToBuffer(point.x),
    bigIntToBuffer(point.y)
  ]);
  return {
    privateKey,
    publicKeyCompressed,
    publicKeyUncompressed
  };
}

function buildSimpleHashlockWitnessScript(publicKeyCompressed, paymentHashHex) {
  return Buffer.concat([
    Buffer.from([0xa8]),
    pushData(Buffer.from(paymentHashHex, 'hex')),
    Buffer.from([0x87])
  ]);
}

function buildSwapWitnessScript(publicKeyCompressed, paymentHashHex) {
  return buildSimpleHashlockWitnessScript(publicKeyCompressed, paymentHashHex);
}

function buildFullHtlcWitnessScript({
  claimPublicKeyCompressed,
  refundPublicKeyCompressed,
  paymentHashHex,
  refundLocktime
}) {
  return Buffer.concat([
    Buffer.from([0x63]),
    Buffer.from([0xa8]),
    pushData(Buffer.from(paymentHashHex, 'hex')),
    Buffer.from([0x88]),
    pushData(claimPublicKeyCompressed),
    Buffer.from([0xac]),
    Buffer.from([0x67]),
    pushScriptNumber(refundLocktime),
    Buffer.from([0xb1, 0x75]),
    pushData(refundPublicKeyCompressed),
    Buffer.from([0xac]),
    Buffer.from([0x68])
  ]);
}

function buildCommittedDlcWitnessScript(publicKeyCompressed, commitmentHashHex) {
  return Buffer.concat([
    Buffer.from([0x00, 0x63]),
    pushData(Buffer.from(commitmentHashHex, 'hex')),
    Buffer.from([0x68]),
    pushData(publicKeyCompressed),
    Buffer.from([0xac])
  ]);
}

function p2wshScriptPubKey(witnessScript) {
  return Buffer.concat([Buffer.from([0x00, 0x20]), sha256(witnessScript)]);
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= generators[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  return [
    ...Buffer.from(hrp, 'utf8').map(ch => ch >> 5),
    0,
    ...Buffer.from(hrp, 'utf8').map(ch => ch & 31)
  ];
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) {
    ret.push((acc << (toBits - bits)) & maxv);
  }
  return ret;
}

function bech32Encode(hrp, data) {
  const values = [...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = bech32Polymod(values) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map(v => BECH32_CHARSET[v]).join('')}`;
}

function p2wshAddress(witnessScript, hrp = 'bcrt') {
  const program = sha256(witnessScript);
  return bech32Encode(hrp, [0, ...convertBits(program, 8, 5, true)]);
}

function base58Encode(buf) {
  let value = BigInt(`0x${buf.toString('hex') || '0'}`);
  let out = '';
  while (value > 0n) {
    const mod = Number(value % 58n);
    out = BASE58_ALPHABET[mod] + out;
    value /= 58n;
  }
  for (const byte of buf) {
    if (byte === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

function base58CheckEncode(payload) {
  const checksum = hash256(payload).subarray(0, 4);
  return base58Encode(Buffer.concat([payload, checksum]));
}

function privateKeyToRegtestWif(privateKey) {
  return base58CheckEncode(Buffer.concat([
    Buffer.from([0xef]),
    privateKey,
    Buffer.from([0x01])
  ]));
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 30000
  }).trim();
}

function wsl(args, options = {}) {
  return run('wsl', ['-d', 'Ubuntu', '--exec', ...args], options);
}

function loadClnArtifact() {
  if (!fs.existsSync(CLN_ARTIFACT)) return null;
  return JSON.parse(fs.readFileSync(CLN_ARTIFACT, 'utf8'));
}

function ensureClnRegtest() {
  let artifact = loadClnArtifact();
  if (artifact) {
    try {
      lightningCli(artifact, 'alice', ['getinfo'], { timeout: 10000 });
      return artifact;
    } catch (_) {
      // Fall through and restart the demo sandbox.
    }
  }
  wsl(['/bin/bash', CLN_BOOTSTRAP], { timeout: 360000, stdio: ['ignore', 'pipe', 'pipe'] });
  artifact = loadClnArtifact();
  if (!artifact) throw new Error('CLN regtest artifact was not created');
  lightningCli(artifact, 'alice', ['getinfo'], { timeout: 10000 });
  return artifact;
}

function envWithLd(base) {
  return ['/usr/bin/env', `LD_LIBRARY_PATH=${base}/lib`, `PATH=${base}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`];
}

function lightningCli(artifact, node, args, options = {}) {
  const dir = `${artifact.runDir}/${node}`;
  return JSON.parse(wsl([
    ...envWithLd(artifact.base),
    `${artifact.base}/bin/lightning-cli`,
    `--lightning-dir=${dir}`,
    '--network=regtest',
    ...args
  ], options));
}

function bitcoinCli(artifact, args, options = {}) {
  return wsl([
    ...envWithLd(artifact.base),
    `${artifact.base}/bin/bitcoin-cli`,
    '-regtest',
    `-datadir=${artifact.runDir}/bitcoin`,
    '-rpcconnect=127.0.0.1',
    `-rpcport=${artifact.bitcoin.rpcPort}`,
    '-rpcuser=utxoref',
    '-rpcpassword=utxorefpass',
    ...args
  ], options);
}

function bitcoinCliJson(artifact, args, options = {}) {
  return JSON.parse(bitcoinCli(artifact, args, options));
}

function signSwapInputWithBitcoinCore({
  artifact,
  unsignedTxHex,
  privateKey,
  fundingTxid,
  fundingVout,
  swapScriptPubKey,
  swapWitnessScript,
  swapAmountSats
}) {
  const wif = privateKeyToRegtestWif(privateKey);
  const prevtx = {
    txid: fundingTxid,
    vout: fundingVout,
    scriptPubKey: swapScriptPubKey.toString('hex'),
    witnessScript: swapWitnessScript.toString('hex'),
    amount: btcAmount(swapAmountSats)
  };
  const signed = bitcoinCliJson(artifact, [
    'signrawtransactionwithkey',
    unsignedTxHex,
    JSON.stringify([wif]),
    JSON.stringify([prevtx])
  ], { timeout: 30000 });
  const decoded = bitcoinCliJson(artifact, ['decoderawtransaction', signed.hex], { timeout: 30000 });
  const witness = decoded.vin && decoded.vin[0] && decoded.vin[0].txinwitness;
  if (!Array.isArray(witness)) {
    throw new Error(`Bitcoin Core did not return a witness signature: ${JSON.stringify(signed)}`);
  }
  const signatureHex = witness.find(item => item.startsWith('30') && item.endsWith('01'));
  if (!signatureHex) {
    throw new Error(`Bitcoin Core witness did not include a signature: ${JSON.stringify(witness)}`);
  }
  return Buffer.from(signatureHex, 'hex');
}

function btcAmount(sats) {
  const value = BigInt(sats);
  const whole = value / 100000000n;
  const frac = (value % 100000000n).toString().padStart(8, '0');
  return `${whole}.${frac}`;
}

function findVoutByScript(tx, scriptPubKeyHex) {
  const outputs = tx.vout || (tx.decoded && tx.decoded.vout) || [];
  const vout = outputs.find(out => out.scriptPubKey && out.scriptPubKey.hex === scriptPubKeyHex);
  if (!vout) throw new Error(`could not find vout for script ${scriptPubKeyHex}`);
  return vout.n;
}

function buildMarkdown(summary) {
  return `# Lightning Submarine Swap Into DLC Funding Demo

Created: ${summary.createdAt}

## Live Flow

- Network: ${summary.network}
- Invoice amount: ${summary.lightning.invoiceAmountMsat} msat
- Payment hash: \`${summary.lightning.paymentHashHex}\`
- Payment preimage: \`${summary.lightning.paymentPreimageHex}\`
- LN payment status: ${summary.lightning.paymentStatus}

## Swap Output

- Swap funding txid: \`${summary.swap.fundingTxid}\`
- Swap funding vout: ${summary.swap.fundingVout}
- Swap address: \`${summary.swap.address}\`
- Swap amount: ${summary.swap.amountSats} sats
- Refund locktime: ${summary.swap.refundLocktime}
- Claim pubkey: \`${summary.swap.claimPublicKeyHex}\`
- Refund pubkey: \`${summary.swap.refundPublicKeyHex}\`
- Swap witness script: \`${summary.swap.witnessScriptHex}\`

## DLC Funding Spend

- Claim/funding txid: \`${summary.dlcFunding.claimTxid}\`
- Claim/funding wtxid: \`${summary.dlcFunding.claimWtxid}\`
- DLC output vout: ${summary.dlcFunding.outputVout}
- DLC output amount: ${summary.dlcFunding.outputAmountSats} sats
- DLC commitment hash: \`${summary.dlcFunding.commitmentHash}\`
- DLC witness script: \`${summary.dlcFunding.witnessScriptHex}\`

## Refund Branch Proof

- Refund funding txid: \`${summary.refundPath.fundingTxid}\`
- Refund funding vout: ${summary.refundPath.fundingVout}
- Refund txid: \`${summary.refundPath.refundTxid}\`
- Refund wtxid: \`${summary.refundPath.refundWtxid}\`
- Refund locktime: ${summary.refundPath.refundLocktime}
- Chain height at refund: ${summary.refundPath.chainHeightAtRefund}
- Refund destination: \`${summary.refundPath.refundDestinationAddress}\`
- Refund amount: ${summary.refundPath.refundAmountSats} sats

## Checks

${Object.entries(summary.checks).map(([name, ok]) => `- ${name}: ${ok ? 'ok' : 'failed'}`).join('\n')}
`;
}

function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const artifact = ensureClnRegtest();
  const swapAmountSats = BigInt(process.env.SUBSWAP_DLC_AMOUNT_SATS || '50000');
  const claimFeeSats = BigInt(process.env.SUBSWAP_DLC_CLAIM_FEE_SATS || '1000');
  const invoiceMsat = `${swapAmountSats * 1000n}msat`;
  const label = `subswap-dlc-${Date.now()}`;

  const invoice = lightningCli(artifact, 'bob', [
    'invoice',
    invoiceMsat,
    label,
    'UTXORef submarine swap into BitVM/DLC funding'
  ], { timeout: 30000 });

  const claimKey = newKeyPair();
  const refundKey = newKeyPair();
  const startBlockHeight = Number(bitcoinCli(artifact, ['getblockcount']));
  const refundLocktime = startBlockHeight + Number(process.env.SUBSWAP_DLC_REFUND_BLOCKS || '6');
  const swapWitnessScript = buildFullHtlcWitnessScript({
    claimPublicKeyCompressed: claimKey.publicKeyCompressed,
    refundPublicKeyCompressed: refundKey.publicKeyCompressed,
    paymentHashHex: invoice.payment_hash,
    refundLocktime
  });
  const swapScriptPubKey = p2wshScriptPubKey(swapWitnessScript);
  const swapAddress = p2wshAddress(swapWitnessScript);

  const fundingTxid = bitcoinCli(artifact, [
    '-rpcwallet=miner',
    'sendtoaddress',
    swapAddress,
    btcAmount(swapAmountSats)
  ], { timeout: 30000 }).replace(/"/g, '');
  const minerAddress = bitcoinCli(artifact, ['-rpcwallet=miner', 'getnewaddress', 'subswap-miner', 'bech32']);
  bitcoinCliJson(artifact, ['-rpcwallet=miner', 'generatetoaddress', '1', minerAddress], { timeout: 30000 });

  const fundingTx = bitcoinCliJson(artifact, ['getrawtransaction', fundingTxid, 'true'], { timeout: 30000 });
  const fundingVout = findVoutByScript(fundingTx, swapScriptPubKey.toString('hex'));

  const payment = lightningCli(artifact, 'alice', ['pay', invoice.bolt11], { timeout: 60000 });
  const paymentPreimageHex = payment.payment_preimage;
  const paymentHashHex = sha256(Buffer.from(paymentPreimageHex, 'hex')).toString('hex');

  const dlcKey = newKeyPair();
  const refundAddress = bitcoinCli(artifact, ['-rpcwallet=miner', 'getnewaddress', 'subswap-refund', 'bech32']);
  const blockHeight = Number(bitcoinCli(artifact, ['getblockcount']));
  const outputAmountSats = swapAmountSats - claimFeeSats;
  const fundingOutput = buildFundingOutputCommitment({
    epochId: 1n,
    dlcId: label,
    bitvmCommitmentRoot: sha256Hex(`bitvm-dlc-root:${label}`),
    collateralSats: outputAmountSats,
    refundAddress,
    timeoutBlock: blockHeight + 144
  });
  const dlcWitnessScript = buildCommittedDlcWitnessScript(dlcKey.publicKeyCompressed, fundingOutput.commitmentHash);
  const dlcScriptPubKey = p2wshScriptPubKey(dlcWitnessScript);

  const claimTx = {
    version: 2,
    locktime: 0,
    inputs: [{
      txid: fundingTxid,
      vout: fundingVout,
      script: Buffer.alloc(0),
      sequence: 0xfffffffd
    }],
    outputs: [{
      valueSats: outputAmountSats,
      scriptPubKey: dlcScriptPubKey
    }]
  };

  const digest = bip143Sighash(claimTx, 0, swapWitnessScript, swapAmountSats);
  const signature = Buffer.concat([
    signDigest(claimKey.privateKey, claimKey.publicKeyUncompressed, digest),
    Buffer.from([0x01])
  ]);
  claimTx.inputs[0].witness = [
    signature,
    Buffer.from(paymentPreimageHex, 'hex'),
    Buffer.from([0x01]),
    swapWitnessScript
  ];

  const claimRaw = encodeTransaction(claimTx, true).toString('hex');
  const mempoolCheck = bitcoinCliJson(artifact, ['testmempoolaccept', `[\"${claimRaw}\"]`], { timeout: 30000 })[0];
  if (!mempoolCheck.allowed) {
    throw new Error(`claim transaction rejected: ${mempoolCheck['reject-reason'] || JSON.stringify(mempoolCheck)}`);
  }
  const claimTxid = bitcoinCli(artifact, ['sendrawtransaction', claimRaw], { timeout: 30000 }).replace(/"/g, '');
  bitcoinCliJson(artifact, ['-rpcwallet=miner', 'generatetoaddress', '1', minerAddress], { timeout: 30000 });

  const claimNoWitness = encodeTransaction(claimTx, false);
  const claimWithWitness = encodeTransaction(claimTx, true);
  const localClaimTxid = hash256(claimNoWitness).reverse().toString('hex');
  const claimWtxid = hash256(claimWithWitness).reverse().toString('hex');
  const claimVerbose = bitcoinCliJson(artifact, ['getrawtransaction', claimTxid, 'true'], { timeout: 30000 });
  const dlcOutputVout = findVoutByScript(claimVerbose, dlcScriptPubKey.toString('hex'));

  const refundAmountSats = BigInt(process.env.SUBSWAP_DLC_REFUND_AMOUNT_SATS || '30000');
  const refundFeeSats = BigInt(process.env.SUBSWAP_DLC_REFUND_FEE_SATS || '1000');
  const refundFundingTxid = bitcoinCli(artifact, [
    '-rpcwallet=miner',
    'sendtoaddress',
    swapAddress,
    btcAmount(refundAmountSats)
  ], { timeout: 30000 }).replace(/"/g, '');
  bitcoinCliJson(artifact, ['-rpcwallet=miner', 'generatetoaddress', '1', minerAddress], { timeout: 30000 });
  let currentHeight = Number(bitcoinCli(artifact, ['getblockcount']));
  if (currentHeight < refundLocktime) {
    bitcoinCliJson(artifact, [
      '-rpcwallet=miner',
      'generatetoaddress',
      String(refundLocktime - currentHeight),
      minerAddress
    ], { timeout: 30000 });
  }
  currentHeight = Number(bitcoinCli(artifact, ['getblockcount']));
  const refundFundingTx = bitcoinCliJson(artifact, ['getrawtransaction', refundFundingTxid, 'true'], { timeout: 30000 });
  const refundFundingVout = findVoutByScript(refundFundingTx, swapScriptPubKey.toString('hex'));
  const refundDestinationAddress = bitcoinCli(artifact, ['-rpcwallet=miner', 'getnewaddress', 'subswap-htlc-refund', 'bech32']);
  const refundDestinationInfo = bitcoinCliJson(artifact, ['-rpcwallet=miner', 'getaddressinfo', refundDestinationAddress], { timeout: 30000 });
  const refundTx = {
    version: 2,
    locktime: refundLocktime,
    inputs: [{
      txid: refundFundingTxid,
      vout: refundFundingVout,
      script: Buffer.alloc(0),
      sequence: 0xfffffffe
    }],
    outputs: [{
      valueSats: refundAmountSats - refundFeeSats,
      scriptPubKey: Buffer.from(refundDestinationInfo.scriptPubKey, 'hex')
    }]
  };
  const refundDigest = bip143Sighash(refundTx, 0, swapWitnessScript, refundAmountSats);
  const refundSignature = Buffer.concat([
    signDigest(refundKey.privateKey, refundKey.publicKeyUncompressed, refundDigest),
    Buffer.from([0x01])
  ]);
  refundTx.inputs[0].witness = [
    refundSignature,
    Buffer.alloc(0),
    swapWitnessScript
  ];
  const refundRaw = encodeTransaction(refundTx, true).toString('hex');
  const refundMempoolCheck = bitcoinCliJson(artifact, ['testmempoolaccept', `[\"${refundRaw}\"]`], { timeout: 30000 })[0];
  if (!refundMempoolCheck.allowed) {
    throw new Error(`refund transaction rejected: ${refundMempoolCheck['reject-reason'] || JSON.stringify(refundMempoolCheck)}`);
  }
  const refundTxid = bitcoinCli(artifact, ['sendrawtransaction', refundRaw], { timeout: 30000 }).replace(/"/g, '');
  bitcoinCliJson(artifact, ['-rpcwallet=miner', 'generatetoaddress', '1', minerAddress], { timeout: 30000 });
  const localRefundTxid = hash256(encodeTransaction(refundTx, false)).reverse().toString('hex');
  const refundWtxid = hash256(encodeTransaction(refundTx, true)).reverse().toString('hex');

  const summary = {
    kind: 'lightning_subswap_into_dlc_funding_demo',
    createdAt: new Date().toISOString(),
    network: 'bitcoin-regtest',
    clnRunDir: artifact.runDir,
    lightning: {
      label,
      bolt11: invoice.bolt11,
      invoiceAmountMsat: invoiceMsat,
      paymentHashHex: invoice.payment_hash,
      paymentPreimageHex,
      paymentStatus: payment.status
    },
    swap: {
      address: swapAddress,
      amountSats: swapAmountSats.toString(),
      fundingTxid,
      fundingVout,
      refundLocktime,
      claimPublicKeyHex: claimKey.publicKeyCompressed.toString('hex'),
      refundPublicKeyHex: refundKey.publicKeyCompressed.toString('hex'),
      scriptPubKeyHex: swapScriptPubKey.toString('hex'),
      witnessScriptHex: swapWitnessScript.toString('hex')
    },
    dlcFunding: {
      claimTxid,
      localClaimTxid,
      claimWtxid,
      rawTxHex: claimRaw,
      outputVout: dlcOutputVout,
      outputAmountSats: outputAmountSats.toString(),
      scriptPubKeyHex: dlcScriptPubKey.toString('hex'),
      witnessScriptHex: dlcWitnessScript.toString('hex'),
      commitmentHash: fundingOutput.commitmentHash,
      fundingOutput
    },
    refundPath: {
      fundingTxid: refundFundingTxid,
      fundingVout: refundFundingVout,
      refundTxid,
      localRefundTxid,
      refundWtxid,
      rawTxHex: refundRaw,
      refundLocktime,
      chainHeightAtRefund: currentHeight,
      refundDestinationAddress,
      refundAmountSats: (refundAmountSats - refundFeeSats).toString(),
      witnessSelectsRefundBranch: refundTx.inputs[0].witness[1].length === 0
    },
    checks: {
      invoiceHashMatchesPreimage: paymentHashHex === invoice.payment_hash,
      swapScriptUsesInvoiceHash: swapWitnessScript.includes(Buffer.from(invoice.payment_hash, 'hex')),
      swapScriptHasSuccessSignatureBranch: swapWitnessScript.includes(claimKey.publicKeyCompressed),
      swapScriptHasRefundTimeoutBranch: swapWitnessScript.includes(refundKey.publicKeyCompressed),
      claimSpendsSwapFundingTx: claimTxid === localClaimTxid,
      claimWitnessRevealsPreimage: claimTx.inputs[0].witness[1].toString('hex') === paymentPreimageHex,
      claimWitnessSelectsSuccessBranch: claimTx.inputs[0].witness[2].equals(Buffer.from([0x01])),
      claimPaysDlcFundingOutput: claimVerbose.vout[dlcOutputVout].scriptPubKey.hex === dlcScriptPubKey.toString('hex'),
      dlcOutputCommitsFundingHash: dlcWitnessScript.includes(Buffer.from(fundingOutput.commitmentHash, 'hex')),
      successBroadcasted: Boolean(claimTxid),
      refundLocktimeReached: currentHeight >= refundLocktime,
      refundSpendsSecondHtlcOutput: refundTxid === localRefundTxid,
      refundWitnessSelectsRefundBranch: refundTx.inputs[0].witness[1].length === 0,
      refundBroadcasted: Boolean(refundTxid)
    }
  };

  fs.writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(MD_OUT, buildMarkdown(summary));
  console.log(`Wrote ${JSON_OUT}`);
  console.log(`Wrote ${MD_OUT}`);
  console.log(`Claim txid ${claimTxid}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildSwapWitnessScript,
  buildSimpleHashlockWitnessScript,
  buildFullHtlcWitnessScript,
  buildCommittedDlcWitnessScript,
  bip143Sighash,
  p2wshAddress,
  p2wshScriptPubKey
};
