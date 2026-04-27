#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT_DIR = path.join(__dirname, 'artifacts');
const DEFAULT_BITCOIN_CLI = 'C:\\projects\\BitcoinConsensusObservatory\\jurassic-bitcoin\\tools\\bitcoin-core-30.2\\bitcoin-30.2\\bin\\bitcoin-cli.exe';
const DEFAULT_DATADIR = 'D:\\BitcoinTestnet';
const DEFAULT_WALLET = 'utxoref-testnet';
const EXPLORER_BASE = 'https://mempool.space/testnet4/tx/';

function cli(args) {
  const bin = process.env.BITCOIN_CLI || DEFAULT_BITCOIN_CLI;
  const datadir = process.env.BTCTEST_DATADIR || DEFAULT_DATADIR;
  const wallet = process.env.BTCTEST_WALLET || DEFAULT_WALLET;
  const base = ['-datadir=' + datadir, '-chain=testnet4'];
  if (args[0] !== 'getblockchaininfo' && args[0] !== 'getblockcount' && args[0] !== 'decodescript') {
    base.push('-rpcwallet=' + wallet);
  }
  return execFileSync(bin, [...base, ...args], { encoding: 'utf8' }).trim();
}

function jsonCli(args) {
  return JSON.parse(cli(args));
}

function push(hex) {
  const bytes = hex.length / 2;
  if (bytes > 75) throw new Error(`push too long: ${bytes}`);
  return bytes.toString(16).padStart(2, '0') + hex;
}

function scriptNumber(n) {
  const bytes = [];
  let value = Number(n);
  while (value > 0) {
    bytes.push(value & 0xff);
    value >>= 8;
  }
  if (bytes.length === 0) bytes.push(0);
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return Buffer.from(bytes).toString('hex');
}

function asciiHex(value) {
  return Buffer.from(String(value), 'utf8').toString('hex');
}

function getPubkey(label) {
  const address = cli(['getnewaddress', label, 'bech32']);
  const info = jsonCli(['getaddressinfo', address]);
  if (!info.pubkey) throw new Error(`wallet did not expose pubkey for ${address}`);
  return { address, pubkey: info.pubkey };
}

function main() {
  const amountBtc = Number(process.env.SUBSWAP_STAGE_AMOUNT_BTC || '0.00025');
  const currentHeight = Number(cli(['getblockcount']));
  const expiryHeight = currentHeight + Number(process.env.SUBSWAP_STAGE_CLTV_DELTA || '144');
  const claim = getPubkey('subswap-htlc-claim');
  const refund = getPubkey('subswap-htlc-refund');
  const changeAddress = cli(['getnewaddress', 'subswap-htlc-change', 'bech32']);
  const preimage = crypto.randomBytes(32);
  const paymentHash = crypto.createHash('sha256').update(preimage).digest();

  const redeemScriptHex =
    '63' + // OP_IF
    'a8' + push(paymentHash.toString('hex')) + '88' + push(claim.pubkey) + 'ac' +
    '67' + push(scriptNumber(expiryHeight)) + 'b1' + '75' + push(refund.pubkey) + 'ac' +
    '68'; // OP_ENDIF

  const decodedScript = jsonCli(['decodescript', redeemScriptHex]);
  const htlcAddress = decodedScript.segwit && decodedScript.segwit.address;
  if (!htlcAddress) throw new Error('bitcoin-cli decodescript did not return a P2WSH address');

  const payload = `UTXORef:subswap-htlc:${paymentHash.toString('hex').slice(0, 16)}:${expiryHeight}`;
  const outputs = [
    { [htlcAddress]: amountBtc },
    { data: asciiHex(payload) }
  ];
  const raw = cli(['createrawtransaction', '[]', JSON.stringify(outputs)]);
  const funded = jsonCli(['fundrawtransaction', raw, JSON.stringify({
    fee_rate: 1,
    changeAddress,
    include_unsafe: true
  })]);
  const signed = jsonCli(['signrawtransactionwithwallet', funded.hex]);
  if (!signed.complete) throw new Error('wallet did not fully sign staged submarine swap transaction');
  const txid = cli(['sendrawtransaction', signed.hex]);

  const artifact = {
    createdAt: new Date().toISOString(),
    network: 'testnet4',
    kind: 'staged_submarine_swap_htlc',
    txid,
    explorer: EXPLORER_BASE + txid,
    amountBtc,
    amountSats: Math.round(amountBtc * 100000000),
    feeBtc: funded.fee,
    payload,
    payloadHex: asciiHex(payload),
    htlc: {
      address: htlcAddress,
      type: decodedScript.segwit.type,
      redeemScriptHex,
      asm: decodedScript.asm,
      paymentHash: paymentHash.toString('hex'),
      preimage: preimage.toString('hex'),
      claimAddress: claim.address,
      claimPubkey: claim.pubkey,
      refundAddress: refund.address,
      refundPubkey: refund.pubkey,
      expiryHeight,
      currentHeight,
      cltvDelta: expiryHeight - currentHeight
    },
    raw: {
      funded,
      signedHex: signed.hex
    }
  };

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const jsonPath = path.join(ARTIFACT_DIR, 'submarine_swap_testnet4_latest.json');
  const mdPath = path.join(ARTIFACT_DIR, 'submarine_swap_testnet4_latest.md');
  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + '\n');
  fs.writeFileSync(mdPath, [
    '# Staged Bitcoin Testnet4 Submarine Swap HTLC',
    '',
    `Created: ${artifact.createdAt}`,
    '',
    `- Txid: \`${txid}\``,
    `- Explorer: ${artifact.explorer}`,
    `- Amount: ${artifact.amountSats} sats`,
    `- HTLC address: \`${htlcAddress}\``,
    `- Payment hash: \`${artifact.htlc.paymentHash}\``,
    `- Preimage: \`${artifact.htlc.preimage}\``,
    `- CLTV expiry height: ${expiryHeight}`,
    '',
    '## Redeem Script',
    '',
    '```text',
    decodedScript.asm,
    '```',
    ''
  ].join('\n'));

  console.log(JSON.stringify({
    ok: true,
    artifact: path.relative(REPO_ROOT, jsonPath),
    txid,
    explorer: artifact.explorer,
    htlcAddress,
    paymentHash: artifact.htlc.paymentHash,
    expiryHeight
  }, null, 2));
}

if (require.main === module) {
  main();
}
