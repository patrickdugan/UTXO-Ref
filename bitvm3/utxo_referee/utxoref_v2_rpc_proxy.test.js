const {
  ALLOWED_METHODS,
  parseArgs,
  authorized,
  validateRpcRequest
} = require('./utxoref_v2_rpc_proxy');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK  ${name}`); passed++; }
  catch (err) { console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); failed++; }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

console.log('\n=== UTXORef V2 RPC Proxy Tests ===\n');

test('only watcher read and preflight methods are exposed', () => {
  assert(ALLOWED_METHODS.has('gettxout'));
  assert(ALLOWED_METHODS.has('testmempoolaccept'));
  assert(!ALLOWED_METHODS.has('sendrawtransaction'));
  assert(!ALLOWED_METHODS.has('stop'));
});

test('proxy basic authentication rejects malformed or wrong values', () => {
  const good = 'Basic ' + Buffer.from('watcher:correct').toString('base64');
  const wrong = 'Basic ' + Buffer.from('watcher:wrong').toString('base64');
  assert(authorized(good, 'watcher', 'correct'));
  assert(!authorized(wrong, 'watcher', 'correct'));
  assert(!authorized('', 'watcher', 'correct'));
});

test('CLI parser accepts a localhost-only binding configuration', () => {
  const args = parseArgs(['--datadir', 'D:\\BitcoinTestnet', '--host', '127.0.0.1', '--port', '48334']);
  assert(args.datadir === 'D:\\BitcoinTestnet');
  assert(args.host === '127.0.0.1');
  assert(args.port === '48334');
});

test('malformed authenticated payloads fail without dereferencing them', () => {
  for (const payload of [null, [], 'x', 7, { method: 'gettxout', params: 'wrong' }]) {
    const result = validateRpcRequest(payload);
    assert(!result.ok && result.code === -32600);
  }
  const forbidden = validateRpcRequest({ jsonrpc: '1.0', id: 1, method: 'sendrawtransaction', params: [] });
  assert(!forbidden.ok && forbidden.code === -32601);
  assert(!validateRpcRequest({ jsonrpc: '2.0', id: 1, method: 'gettxout', params: [] }).ok);
  assert(!validateRpcRequest({ jsonrpc: '2.0', id: 1, method: 'constructor', params: [] }).ok, 'prototype names are not methods');
});

test('the watcher calls its RPC client sends (JSON-RPC 1.0, getrawtransaction) are permitted', () => {
  const txid = '11'.repeat(32);
  assert(validateRpcRequest({ jsonrpc: '1.0', id: 'utxoref-v2-watchtower', method: 'gettxout', params: [txid, 0, true] }).ok);
  assert(validateRpcRequest({ jsonrpc: '1.0', id: 'utxoref-v2-watchtower', method: 'getrawtransaction', params: [txid, true] }).ok);
  assert(!validateRpcRequest({ jsonrpc: '1.0', id: 'utxoref-v2-watchtower', method: 'getrawtransaction', params: [txid, false] }).ok);
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
