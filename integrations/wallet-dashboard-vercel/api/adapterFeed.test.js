const assert = require('assert/strict');
const { buildAdapterFeed } = require('./adapterFeed');

const feed = buildAdapterFeed();

assert.equal(feed.kind, 'utxoref_layer_adapter_feed');
assert.equal(feed.verification.ok, true);
assert.equal(feed.verification.adaptersCovered, 4);
assert.ok(feed.events.length >= 12);

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

console.log('adapter feed fixtures ok');
