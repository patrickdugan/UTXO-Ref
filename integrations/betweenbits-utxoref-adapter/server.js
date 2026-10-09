const http = require('http');
const url = require('url');

const {
  loadLiveArtifacts,
  summarizeBetaGate,
  buildAssetAttestation,
  buildTaprootUsdWalletAsset,
  buildPrototypeCrossReferences,
  evaluateSpendProposal
} = require('./index');

function send(res, statusCode, body) {
  const text = JSON.stringify(body, null, 2) + '\n';
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function createServer(options = {}) {
  const artifactsDir = options.artifactsDir;

  return http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url, true);
      const { artifacts, paths } = loadLiveArtifacts({ artifactsDir });
      const betaGatePackage = artifacts.betaGatePackage;

      if (req.method === 'GET' && parsed.pathname === '/health') {
        return send(res, 200, { ok: true, service: 'betweenbits-utxoref-adapter' });
      }

      if (req.method === 'GET' && parsed.pathname === '/v1/beta-gate') {
        return send(res, 200, summarizeBetaGate(betaGatePackage));
      }

      if (req.method === 'GET' && parsed.pathname === '/v1/reserve-vaults/latest') {
        return send(res, 200, {
          status: summarizeBetaGate(betaGatePackage),
          reserveVault: artifacts.reserveVault,
          source: paths.reserveVault
        });
      }

      if (req.method === 'GET' && parsed.pathname === '/v1/wallet-assets/taproot-usd') {
        return send(res, 200, buildTaprootUsdWalletAsset({
          betaGatePackage,
          reserveVault: artifacts.reserveVault,
          autoRollState: artifacts.autoRollState
        }));
      }

      if (req.method === 'GET' && parsed.pathname === '/v1/wallet-assets/taproot-usd/cross-references') {
        const reserve = betaGatePackage?.evidence?.reserve || {};
        return send(res, 200, buildPrototypeCrossReferences({
          reserveOutpoint: reserve.txid ? `${reserve.txid}:${reserve.vout ?? 0}` : null
        }));
      }

      if (req.method === 'POST' && parsed.pathname === '/v1/bitcert/asset-attestations') {
        const body = await readBody(req);
        return send(res, 200, buildAssetAttestation({
          betaGatePackage,
          reserveVault: artifacts.reserveVault,
          institutionId: body.institutionId,
          bitcertProfileId: body.bitcertProfileId,
          assetCode: body.assetCode,
          amountSats: body.amountSats
        }));
      }

      if (req.method === 'POST' && parsed.pathname === '/v1/watchtower/spend-proposals/evaluate') {
        const body = await readBody(req);
        return send(res, 200, evaluateSpendProposal({
          betaGatePackage,
          proposal: body.proposal,
          policy: body.policy
        }));
      }

      return send(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  });
}

if (require.main === module) {
  const portArg = process.argv.find((arg) => arg.startsWith('--port='));
  const dirArg = process.argv.find((arg) => arg.startsWith('--artifacts-dir='));
  const port = Number(portArg ? portArg.split('=')[1] : process.env.PORT || 8787);
  const artifactsDir = dirArg ? dirArg.slice('--artifacts-dir='.length) : process.env.UTXOREF_ARTIFACTS_DIR;
  const server = createServer({ artifactsDir });
  server.listen(port, '127.0.0.1', () => {
    console.log(`betweenbits-utxoref-adapter listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
