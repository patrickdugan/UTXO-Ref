#!/usr/bin/env node

const {
  MAX_STANDARD_OP_RETURN_PAYLOAD_BYTES,
  RELAY_REFERENCE_PREFIX,
  buildTx30RelayBlobEnvelope,
  buildTx30RelayReference,
  buildTx30RelayAnchor,
  verifyTx30RelayAnchor
} = require('./tradelayer_tx30_relay_anchor');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    failed += 1;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function sampleRelayBundle() {
  return {
    eventId: 'proc-rbtc-hour-listener-wallclock-001',
    outcome: 'ROLLED',
    outcomeIndex: 0,
    stateHash: 'dba58b2857d25e7d4753df92396684adc2181c2ec9e56e57e8cf261f17efc939',
    timestamp: 1783381106608,
    payloadHash: 'dba58b2857d25e7d4753df92396684adc2181c2ec9e56e57e8cf261f17efc939',
    balancePayloadB64: Buffer.from(JSON.stringify({
      propertyId: 1,
      holderCount: 1,
      balances: [{ address: 'tb1qfunding', available: 0.00001 }]
    }), 'utf8').toString('base64'),
    oraclePubkeyHex: '03'.padEnd(66, '1'),
    signatureHex: 'ab'.repeat(64),
    settlement: {
      mode: 'none',
      propertyId: 1,
      amount: 0,
      fromAddress: 'tb1qfunding',
      toAddress: 'tb1qfunding',
      nextPropertyId: 0
    }
  };
}

function sampleInput() {
  return {
    relayBlob: JSON.stringify(sampleRelayBundle()),
    chain: 'BTC_TESTNET4',
    oracleId: 1,
    relayType: 1,
    dlcRef: 'rbtc-hour-listener-wallclock-001',
    blockHeight: 0,
    relayStoreKey: 'oracle-relay-1-1-0'
  };
}

console.log('\n=== TradeLayer tx30 Relay Anchor Tests ===\n');

test('builds deterministic relay envelope and compact OP_RETURN reference', () => {
  const a = buildTx30RelayAnchor(sampleInput());
  const b = buildTx30RelayAnchor(sampleInput());

  assertEq(a.anchorHash, b.anchorHash);
  assertEq(a.envelope.relayBlobHash, b.envelope.relayBlobHash);
  assert(a.reference.payloadText.startsWith(RELAY_REFERENCE_PREFIX), 'missing reference prefix');
  assertEq(a.reference.payloadBytes, 69);
  assert(a.reference.payloadBytes <= MAX_STANDARD_OP_RETURN_PAYLOAD_BYTES, 'payload should be standard');
  assert(a.reference.opReturnScriptHex.startsWith('6a45'), 'expected one-byte push for 69-byte payload');
});

test('accepts b64 relay blobs and preserves the same relay hash', () => {
  const jsonAnchor = buildTx30RelayAnchor(sampleInput());
  const b64Anchor = buildTx30RelayAnchor({
    ...sampleInput(),
    relayBlob: `b64:${Buffer.from(JSON.stringify(sampleRelayBundle()), 'utf8').toString('base64')}`
  });

  assertEq(b64Anchor.envelope.relayBlobHash, jsonAnchor.envelope.relayBlobHash);
  assertEq(b64Anchor.reference.payloadText, jsonAnchor.reference.payloadText);
});

test('verifies a signed relay reference and rejects tampered payloads', () => {
  const anchor = buildTx30RelayAnchor(sampleInput());
  const ok = verifyTx30RelayAnchor(anchor);
  assertEq(ok.ok, true, ok.errors.join('; '));

  const tampered = JSON.parse(JSON.stringify(anchor));
  tampered.envelope.relayBundle.outcome = 'SETTLED';
  const bad = verifyTx30RelayAnchor(tampered);
  assertEq(bad.ok, false);
  assert(bad.errors.some((e) => /hash mismatch/.test(e)), 'should report hash mismatch');
});

test('rejects unsigned relay bundles for beta-grade anchors', () => {
  const bundle = sampleRelayBundle();
  delete bundle.signatureHex;
  const anchor = buildTx30RelayAnchor({
    ...sampleInput(),
    relayBlob: JSON.stringify(bundle)
  });
  const result = verifyTx30RelayAnchor(anchor);
  assertEq(result.ok, false);
  assert(result.errors.includes('relay bundle missing signatureHex'), 'missing signature error absent');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
