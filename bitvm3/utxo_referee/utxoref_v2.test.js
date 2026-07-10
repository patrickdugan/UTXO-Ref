const crypto = require('crypto');
const tr = require('./tradelayer_taproot');
const {
  buildSignedStateCheckpointV2,
  verifySignedStateCheckpointV2,
  publicKeyId,
  buildUtxoRefPnlSettlementV2,
  verifyUtxoRefSettlementV2,
  buildUtxoRefCommitmentV2
} = require('./utxoref_v2');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const KEY_ID = publicKeyId(publicKey);
const TRUST = { [KEY_ID]: publicKey };
const CONTRACT_ID = '42'.repeat(32);
const GENESIS = '11'.repeat(32);
const FUNDING_TXID = 'aa'.repeat(32);
const FUNDING_SPK = '5120' + '33'.repeat(32);
const A_SPK = '0014' + '01'.repeat(20);
const C_SPK = '0014' + '03'.repeat(20);

const BODY = {
  network: 'bitcoin-testnet4',
  chainGenesisHash: GENESIS,
  contractId: CONTRACT_ID,
  epochId: '91',
  snapshotHeight: 1000,
  snapshotBlockHash: '22'.repeat(32),
  settlementAddressMap: {
    A: { address: 'winner-a', scriptPubKeyHex: A_SPK },
    C: { address: 'winner-c', scriptPubKeyHex: C_SPK }
  },
  pnlRows: [
    {
      id: 'a-wins-from-b', contractId: CONTRACT_ID, side: 'long',
      entryPrice: 2100, closePrice: 2200, quantityUnits: 30,
      collateralSats: 50000, traderAddress: 'A', counterpartyAddress: 'B'
    },
    {
      id: 'c-wins-from-b', contractId: CONTRACT_ID, side: 'long',
      entryPrice: 2100, closePrice: 2200, quantityUnits: 20,
      collateralSats: 50000, traderAddress: 'C', counterpartyAddress: 'B'
    }
  ]
};

function buildFixture(overrides = {}) {
  const envelope = buildSignedStateCheckpointV2(BODY, { privateKey, publicKey });
  const base = buildUtxoRefPnlSettlementV2({
    stateEnvelope: envelope,
    stateVerification: {
      trustedSigners: TRUST,
      expectedNetwork: 'bitcoin-testnet4',
      expectedGenesisHash: GENESIS,
      currentHeight: 1002
    },
    fundingOutpoints: [{
      txid: FUNDING_TXID,
      vout: 0,
      amountSats: '6000',
      scriptPubKeyHex: FUNDING_SPK
    }],
    feeSats: '1000',
    operatorXonly: '44'.repeat(32),
    challengerXonly: '55'.repeat(32),
    challengeCsvBlocks: 6,
    recoveryCsvBlocks: 144,
    ...overrides
  });
  base.unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(FUNDING_TXID, 0),
    sequence: 6
  }], base.outputs.map((output) => ({
    valueSats: output.valueSats,
    script: output.scriptPubKeyHex
  })), 0);
  return base;
}

const VERIFY_OPTIONS = {
  trustedSigners: TRUST,
  expectedNetwork: 'bitcoin-testnet4',
  expectedGenesisHash: GENESIS,
  currentHeight: 1002
};

console.log('\n=== UTXORef V2 Tests ===\n');

test('required Ed25519 state checkpoint verifies against an allowlist', () => {
  const envelope = buildSignedStateCheckpointV2(BODY, { privateKey, publicKey });
  const result = verifySignedStateCheckpointV2(envelope, VERIFY_OPTIONS);
  assert(result.ok, result.reason);
});

test('missing signer and state mutation fail closed', () => {
  const envelope = buildSignedStateCheckpointV2(BODY, { privateKey, publicKey });
  assert(!verifySignedStateCheckpointV2(envelope, { ...VERIFY_OPTIONS, trustedSigners: {} }).ok);
  const tampered = clone(envelope);
  tampered.body.pnlRows[0].closePrice = 9999;
  assert(!verifySignedStateCheckpointV2(tampered, VERIFY_OPTIONS).ok);
});

test('stale and wrong-network checkpoints fail closed', () => {
  const envelope = buildSignedStateCheckpointV2(BODY, { privateKey, publicKey });
  assert(!verifySignedStateCheckpointV2(envelope, { ...VERIFY_OPTIONS, currentHeight: 1010 }).ok);
  assert(!verifySignedStateCheckpointV2(envelope, { ...VERIFY_OPTIONS, expectedNetwork: 'bitcoin-regtest' }).ok);
});

test('builds and verifies an exact atomic PNL batch', () => {
  const settlement = buildFixture();
  const result = verifyUtxoRefSettlementV2(settlement, VERIFY_OPTIONS);
  assert(result.ok, result.reason);
  assert(result.payoutCount === 2, 'expected two winners');
  assert(result.payoutTotalSats === '5000', 'expected 5000 payout sats');
  assert(result.feeSats === '1000', 'expected exact fee');
});

test('duplicate payout request ids are rejected', () => {
  const settlement = buildFixture();
  const duplicate = clone(settlement.payouts[0]);
  duplicate.index = 1;
  duplicate.amountSats = settlement.payouts[1].amountSats;
  duplicate.scriptPubKeyHex = settlement.payouts[1].scriptPubKeyHex;
  let threw = false;
  try {
    buildUtxoRefCommitmentV2({
      ...settlement.commitment.core,
      fundingOutpoints: settlement.fundingOutpoints,
      payouts: [settlement.payouts[0], duplicate],
      stateCheckpointHash: settlement.commitment.core.stateCheckpointHash
    });
  } catch (err) {
    threw = /duplicate payout request/.test(err.message);
  }
  assert(threw, 'duplicate payout request must fail');
});

test('redirected, reordered, or extra outputs are rejected', () => {
  const redirected = buildFixture();
  redirected.unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(FUNDING_TXID, 0), sequence: 6
  }], [
    { valueSats: redirected.outputs[0].valueSats, script: C_SPK },
    { valueSats: redirected.outputs[1].valueSats, script: redirected.outputs[1].scriptPubKeyHex }
  ], 0);
  assert(!verifyUtxoRefSettlementV2(redirected, VERIFY_OPTIONS).ok, 'redirected output must fail');

  const extra = buildFixture();
  extra.unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(FUNDING_TXID, 0), sequence: 6
  }], [
    ...extra.outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })),
    { valueSats: 1, script: A_SPK }
  ], 0);
  assert(!verifyUtxoRefSettlementV2(extra, VERIFY_OPTIONS).ok, 'extra output must fail');
});

test('wrong funding outpoint and sequence are rejected', () => {
  const wrongInput = buildFixture();
  wrongInput.unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint('bb'.repeat(32), 0), sequence: 6
  }], wrongInput.outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })), 0);
  assert(!verifyUtxoRefSettlementV2(wrongInput, VERIFY_OPTIONS).ok);

  const wrongSequence = buildFixture();
  wrongSequence.unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(FUNDING_TXID, 0), sequence: 5
  }], wrongSequence.outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })), 0);
  assert(!verifyUtxoRefSettlementV2(wrongSequence, VERIFY_OPTIONS).ok);
});

test('forged commitment roots cannot be self-authorized', () => {
  const settlement = buildFixture();
  settlement.commitment.core.payoutRoot = 'ff'.repeat(32);
  assert(!verifyUtxoRefSettlementV2(settlement, VERIFY_OPTIONS).ok);
});

test('PNL rows, edges, and net balances cannot be disconnected', () => {
  const settlement = buildFixture();
  settlement.rows[0].winnerAddress = 'B';
  settlement.rows[0].transferSats = '49999';
  assert(!verifyUtxoRefSettlementV2(settlement, VERIFY_OPTIONS).ok);
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
