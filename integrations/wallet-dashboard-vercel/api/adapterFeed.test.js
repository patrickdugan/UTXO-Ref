const assert = require('assert/strict');
const { buildAdapterFeed } = require('./adapterFeed');

const feed = buildAdapterFeed();

assert.equal(feed.kind, 'utxoref_layer_adapter_feed');
assert.equal(feed.verification.ok, true);
assert.equal(feed.verification.adaptersCovered, 4);
assert.equal(feed.verification.bitcoinTestnetTxids, 14);
assert.ok(feed.events.length >= 12);
assert.equal(feed.testnetProof.network, 'testnet4');
assert.equal(feed.testnetProof.summary.txCount, 14);

for (const key of ['ldk', 'ark', 'taprootAssets', 'tradeLayer']) {
  assert.ok(feed.adapters[key], `missing ${key}`);
  assert.ok(feed.adapters[key].eventCount > 0, `${key} has no events`);
}

for (const event of feed.events) {
  assert.ok(event.id);
  assert.ok(event.adapter);
  assert.ok(event.sourceType);
  assert.ok(event.normalizedType);
  assert.ok(event.correlationId);
}

for (const event of feed.events.filter(item => item.evidenceUrl)) {
  assert.match(event.evidenceUrl, /^https:\/\/mempool\.space\/testnet4\/tx\/[0-9a-f]{64}$/);
}

console.log('adapter feed fixtures ok');
