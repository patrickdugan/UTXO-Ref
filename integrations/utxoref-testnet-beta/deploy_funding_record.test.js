const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { deploy } = require('./deployGuardianQuorumReserve');
const adaptor = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');

const GRAPH_HASH = '34dfe4a3d05264fa54cd6d99e9a07ac784c22f3011b7704847337a0543d02eee';
const FUNDING_TXID = 'ab'.repeat(32);

// Loopback Bitcoin Core stand-in. The wallet funds the reserve, but the funding transaction it then returns has no
// quorum output, so the deployment fails after the funds are already spent.
function fakeCore(calls) {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const { id, method } = JSON.parse(raw);
      calls.push(method);
      const answers = {
        decodescript: { address: `tb1p${'q'.repeat(58)}` },
        sendtoaddress: FUNDING_TXID,
        getrawtransaction: { vout: [] }
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(method in answers
        ? { result: answers[method], error: null, id }
        : { result: null, error: { code: -32601, message: `unexpected ${method}` }, id }));
    });
  });
}

function registryFixture() {
  return {
    kind: 'utxoref_beta_guardian_registry',
    version: 1,
    graphHash: GRAPH_HASH,
    quorum: 2,
    guardians: [1, 2, 3].map((index) => ({
      guardianId: `${String(index).repeat(24)}`,
      label: `guardian-${index}`,
      guardianXonly: adaptor.xOnlyPubkey(BigInt(index)).toString('hex'),
      heartbeatPublicKeyPem: ''
    }))
  };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-funding-record-'));
  const calls = [];
  const core = fakeCore(calls);
  await new Promise((resolve) => core.listen(0, '127.0.0.1', resolve));
  try {
    const registryPath = path.join(root, 'registry.json');
    fs.writeFileSync(registryPath, JSON.stringify(registryFixture()));
    const options = {
      registryPath,
      outputPath: path.join(root, 'reserve.json'),
      secretDir: path.join(root, 'secrets'),
      amountSats: 10000,
      broadcast: true
    };
    const env = {
      BTC_RPC_URL: `http://127.0.0.1:${core.address().port}`,
      BTC_RPC_USER: 'utxoref-test',
      BTC_RPC_PASS: 'utxoref-test'
    };

    await assert.rejects(deploy(options, env), (err) =>
      err.message.includes('does not contain the guardian quorum script') &&
      err.message.includes(FUNDING_TXID) &&
      err.message.includes('is recorded in'));
    assert.deepStrictEqual(calls.filter((method) => method === 'sendtoaddress'), ['sendtoaddress']);
    const pending = JSON.parse(fs.readFileSync(`${options.outputPath}.funding-pending.json`, 'utf8'));
    assert.strictEqual(pending.txid, FUNDING_TXID);
    assert.strictEqual(pending.amountSats, '10000');
    assert.ok(!fs.existsSync(options.outputPath), 'no reserve artifact may exist for a failed funding');

    // A retry must not fund again while the funding is unresolved.
    await assert.rejects(deploy(options, env), /pending funding record already exists/);
    assert.deepStrictEqual(calls.filter((method) => method === 'sendtoaddress'), ['sendtoaddress'],
      'a retry funded the reserve a second time');
  } finally {
    await new Promise((resolve) => core.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('deploy funding record tests ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
