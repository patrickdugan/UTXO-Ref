const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// The lease quote echoes the terms a client asked for. Each one is read by the strict parser of its kind: an honest value
// is echoed, and a value that is not a whole number, or is above 2^53, is refused with 400 rather than rounded or sent as NaN.
const TOKEN = 'test-sidecar-token-lease-quote';
const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-lease-quote-'));
const tokenFile = path.join(tokenDir, 'token');
fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
process.env.SIDECAR_API_TOKEN_FILE = tokenFile;
process.env.SIDECAR_REQUEST_STORE_PATH = path.join(tokenDir, 'requests.json');
const sidecar = require('./server');
const terms = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'bitvm3', 'utxo_referee', 'artifacts', 'lightning_liquidity_lease_latest.json'), 'utf8')).offer.terms;

const echoed = (overrides = {}) => ({
  requestedInboundSats: terms.promisedInboundSats,
  leaseBlocks: terms.leaseBlocks,
  maxFeePpm: terms.maxFeePpm,
  maxCltvDelta: terms.maxCltvDelta,
  ...overrides
});

const honest = [
  ['the artifact terms are echoed when the client sends none', {}, echoed()],
  ['a zero lease length is the client\'s zero, not the default', { leaseBlocks: 0 }, echoed({ leaseBlocks: 0 })],
  ['numeric strings are read as whole numbers', { requestedInboundSats: '12345', leaseBlocks: '200', maxFeePpm: '1500', maxCltvDelta: '48' },
    { requestedInboundSats: '12345', leaseBlocks: 200, maxFeePpm: 1500, maxCltvDelta: 48 }]
];
const refused = [
  ['an exponent form is not a whole number', { maxFeePpm: '1e3' }, 'maxFeePpm'],
  ['text is not a number', { leaseBlocks: 'abc' }, 'leaseBlocks'],
  ['a fraction is not a sat amount', { requestedInboundSats: 1.5 }, 'requestedInboundSats'],
  ['a value above 2^53 is refused, not rounded', { maxFeePpm: '9007199254740993' }, 'maxFeePpm'],
  ['a negative CLTV delta is refused', { maxCltvDelta: -1 }, 'maxCltvDelta']
];

async function run() {
  const server = http.createServer((req, res) => sidecar.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const quote = async (body) => {
    const response = await fetch(`${base}/v1/liquidity-lease/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json() };
  };
  try {
    for (const [name, body, expected] of honest) {
      const result = await quote(body);
      assert.strictEqual(result.status, 200, `${name}: refused with ${JSON.stringify(result.json)}`);
      assert.strictEqual(result.json.kind, 'liquidity_lease_quote');
      assert.deepStrictEqual({
        requestedInboundSats: result.json.requestedInboundSats,
        leaseBlocks: result.json.leaseBlocks,
        maxFeePpm: result.json.maxFeePpm,
        maxCltvDelta: result.json.maxCltvDelta
      }, expected, name);
    }
    for (const [name, body, field] of refused) {
      const result = await quote(body);
      assert.strictEqual(result.status, 400, `${name}: answered ${result.status}`);
      assert.match(result.json.error, new RegExp(field), `${name}: the error does not name ${field}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tokenDir, { recursive: true, force: true });
  }
}

run().then(
  () => console.log('liquidityLeaseQuote tests ok'),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
