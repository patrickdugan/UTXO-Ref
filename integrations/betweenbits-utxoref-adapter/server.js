const fs = require('fs');
const http = require('http');
const url = require('url');

const { HttpError, sendJson, readJsonBody } = require('../shared/service');
const {
  loadLiveArtifacts,
  summarizeBetaGate,
  buildAssetAttestation,
  buildTaprootUsdWalletAsset,
  buildPrototypeCrossReferences,
  evaluateSpendProposal
} = require('./index');

// Spend policy is server configuration. A missing file leaves the default empty policy, which refuses every spend
// while the real-money gate is closed.
function loadSpendPolicy(env = process.env) {
  if (!env.UTXOREF_SPEND_POLICY_PATH) return {};
  return JSON.parse(fs.readFileSync(env.UTXOREF_SPEND_POLICY_PATH, 'utf8'));
}

function createServer(options = {}) {
  const artifactsDir = options.artifactsDir;
  const spendPolicy = options.spendPolicy || loadSpendPolicy();

  return http.createServer(async (req, res) => {
    try {
      const parsed = url.parse(req.url, true);
      const { artifacts, paths } = loadLiveArtifacts({ artifactsDir });
      const betaGatePackage = artifacts.betaGatePackage;

      if (req.method === 'GET' && parsed.pathname === '/health') {
        return sendJson(res, 200, { ok: true, service: 'betweenbits-utxoref-adapter' });
      }

      if (req.method === 'GET' && parsed.pathname === '/v1/beta-gate') {
        return sendJson(res, 200, summarizeBetaGate(betaGatePackage));
      }

      if (req.method === 'GET' && parsed.pathname === '/v1/reserve-vaults/latest') {
        return sendJson(res, 200, {
          status: summarizeBetaGate(betaGatePackage),
          reserveVault: artifacts.reserveVault,
          source: paths.reserveVault
        });
      }

      if (req.method === 'GET' && parsed.pathname === '/v1/wallet-assets/taproot-usd') {
        return sendJson(res, 200, buildTaprootUsdWalletAsset({
          betaGatePackage,
          reserveVault: artifacts.reserveVault,
          autoRollState: artifacts.autoRollState
        }));
      }

      if (req.method === 'GET' && parsed.pathname === '/v1/wallet-assets/taproot-usd/cross-references') {
        const reserve = betaGatePackage?.evidence?.reserve || {};
        return sendJson(res, 200, buildPrototypeCrossReferences({
          reserveOutpoint: reserve.txid ? `${reserve.txid}:${reserve.vout ?? 0}` : null
        }));
      }

      if (req.method === 'POST' && parsed.pathname === '/v1/bitcert/asset-attestations') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, buildAssetAttestation({
          betaGatePackage,
          reserveVault: artifacts.reserveVault,
          institutionId: body.institutionId,
          bitcertProfileId: body.bitcertProfileId,
          assetCode: body.assetCode
        }));
      }

      if (req.method === 'POST' && parsed.pathname === '/v1/watchtower/spend-proposals/evaluate') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, evaluateSpendProposal({
          betaGatePackage,
          proposal: body.proposal,
          policy: spendPolicy
        }));
      }

      return sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.statusCode, { ok: false, error: err.message });
      return sendJson(res, 500, { ok: false, error: 'internal server error' });
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

module.exports = { createServer, loadSpendPolicy };
