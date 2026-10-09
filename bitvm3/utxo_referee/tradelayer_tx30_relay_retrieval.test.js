#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  buildTx30RelayAnchor
} = require('./tradelayer_tx30_relay_anchor');
const {
  publishRelayBundleToReplicas,
  retrieveRelayBundleFromReplicas,
  verifyRelayBundleDocument,
  buildRelayRetrievalFault,
  relayBundlePath
} = require('./tradelayer_tx30_relay_retrieval');

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

const TMP_DIR = path.join(__dirname, 'artifacts', 'tmp', 'tx30_relay_retrieval_tests');

function resetTmp(name) {
  const dir = path.join(TMP_DIR, `${name}_${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sampleRelayBundle() {
  return {
    eventId: 'proc-rbtc-hour-listener-wallclock-001',
    outcome: 'ROLLED',
    outcomeIndex: 0,
    stateHash: 'dba58b2857d25e7d4753df92396684adc2181c2ec9e56e57e8cf261f17efc939',
    timestamp: 1783381106608,
    payloadHash: 'dba58b2857d25e7d4753df92396684adc2181c2ec9e56e57e8cf261f17efc939',
    balancePayloadB64: Buffer.from(JSON.stringify({ propertyId: 1, holderCount: 1 }), 'utf8').toString('base64'),
    oraclePubkeyHex: '02'.padEnd(66, '2'),
    signatureHex: 'cd'.repeat(64),
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

function sampleAnchor() {
  return buildTx30RelayAnchor({
    relayBlob: JSON.stringify(sampleRelayBundle()),
    chain: 'BTC_TESTNET4',
    oracleId: 1,
    relayType: 1,
    dlcRef: 'rbtc-hour-listener-wallclock-001',
    blockHeight: 0,
    relayStoreKey: 'oracle-relay-1-1-0',
    chainTxid: '88cd8bf0f9d3d7a79607ad65da81c7d8b3b28c48c75ef8aedbecbdf02b8e486c'
  });
}

console.log('\n=== TradeLayer tx30 Relay Retrieval Tests ===\n');

test('publishes a signed relay bundle to two replicas', () => {
  const dir = resetTmp('publish');
  const replicas = [path.join(dir, 'primary'), path.join(dir, 'secondary')];
  const anchor = sampleAnchor();
  const publication = publishRelayBundleToReplicas(anchor, replicas, { createdAt: '2026-07-06T00:00:00.000Z' });

  assertEq(publication.replicaCount, 2);
  assert(fs.existsSync(relayBundlePath(replicas[0], anchor.relayBlobHash)), 'primary replica missing');
  assert(fs.existsSync(relayBundlePath(replicas[1], anchor.relayBlobHash)), 'secondary replica missing');
});

test('recovers from secondary replica after primary deletion', () => {
  const dir = resetTmp('recover');
  const replicas = [path.join(dir, 'primary'), path.join(dir, 'secondary')];
  const anchor = sampleAnchor();
  publishRelayBundleToReplicas(anchor, replicas, { createdAt: '2026-07-06T00:00:00.000Z' });
  fs.rmSync(replicas[0], { recursive: true, force: true });

  const result = retrieveRelayBundleFromReplicas({
    relayBlobHash: anchor.relayBlobHash,
    replicaDirs: replicas,
    expected: {
      envelopeHash: anchor.envelopeHash,
      referenceHash: anchor.referenceHash
    }
  });

  assertEq(result.ok, true);
  assertEq(result.recoveredFrom, replicas[1]);
  assertEq(result.document.relayBlobHash, anchor.relayBlobHash);
});

test('rejects tampered relay documents and emits retrieval fault', () => {
  const dir = resetTmp('tamper');
  const replicas = [path.join(dir, 'primary'), path.join(dir, 'secondary')];
  const anchor = sampleAnchor();
  publishRelayBundleToReplicas(anchor, replicas, { createdAt: '2026-07-06T00:00:00.000Z' });

  for (const replica of replicas) {
    const p = relayBundlePath(replica, anchor.relayBlobHash);
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    doc.relayBundle.outcome = 'SETTLED';
    fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  }

  const result = retrieveRelayBundleFromReplicas({
    relayBlobHash: anchor.relayBlobHash,
    replicaDirs: replicas,
    expected: { envelopeHash: anchor.envelopeHash, referenceHash: anchor.referenceHash }
  });
  assertEq(result.ok, false);
  const fault = buildRelayRetrievalFault(anchor, result, { checkedAtHeight: 143222 });
  assertEq(fault.fault, true);
  assertEq(fault.severity, 'block');
});

test('rejects documents that contain private key material', () => {
  const anchor = sampleAnchor();
  const dir = resetTmp('private-key');
  const replicas = [path.join(dir, 'primary'), path.join(dir, 'secondary')];
  publishRelayBundleToReplicas(anchor, replicas, { createdAt: '2026-07-06T00:00:00.000Z' });
  const p = relayBundlePath(replicas[0], anchor.relayBlobHash);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  doc.oraclePrivateKeyHex = '11'.repeat(32);
  const verification = verifyRelayBundleDocument(doc, { relayBlobHash: anchor.relayBlobHash });

  assertEq(verification.ok, false);
  assert(verification.errors.some((e) => /private key/.test(e)), 'private key error missing');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
