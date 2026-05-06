const http = require('http');
const https = require('https');
const { URL } = require('url');

function createNodeRpcClient({
  rpcUrl,
  rpcUser,
  rpcPass,
  wallet = null,
  requestIdPrefix = 'civkit-control'
}) {
  if (typeof rpcUrl !== 'string' || rpcUrl.length === 0) {
    throw new Error('rpcUrl is required');
  }

  const endpoint = new URL(rpcUrl);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return async function rpc(method, params = [], walletOverride = wallet) {
    const walletPath = walletOverride ? `/wallet/${encodeURIComponent(walletOverride)}` : '';
    const pathname = endpoint.pathname && endpoint.pathname !== '/' ? endpoint.pathname : '';
    const targetPath = `${walletPath}${pathname || ''}` || '/';
    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: `${requestIdPrefix}-${method}`,
      method,
      params
    });

    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: targetPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Basic ${Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64')}`
      }
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (error) {
            reject(new Error(`Invalid RPC response for ${method}`));
            return;
          }

          if (parsed.error) {
            reject(new Error(`RPC ${method} failed: ${parsed.error.message}`));
            return;
          }

          resolve(parsed.result);
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  };
}

function extractRejectReason(entry) {
  if (entry == null || typeof entry !== 'object') {
    return 'unknown_rejection';
  }
  return entry['reject-reason'] || entry.rejectReason || entry.packageError || 'unknown_rejection';
}

function createRpcBroadcaster({ rpc }) {
  if (typeof rpc !== 'function') {
    throw new Error('rpc function is required');
  }

  return {
    async broadcastSignedSettlement({ txHex }) {
      if (typeof txHex !== 'string' || txHex.length === 0) {
        throw new Error('txHex is required');
      }

      const mempoolAccept = await rpc('testmempoolaccept', [[txHex]], null);
      const firstEntry = Array.isArray(mempoolAccept) ? mempoolAccept[0] : null;
      if (firstEntry == null || firstEntry.allowed !== true) {
        throw new Error(`Settlement tx rejected by testmempoolaccept: ${extractRejectReason(firstEntry)}`);
      }

      const txId = await rpc('sendrawtransaction', [txHex], null);
      return {
        mode: 'rpc',
        txId,
        mempoolAccept: firstEntry
      };
    }
  };
}

module.exports = {
  createNodeRpcClient,
  createRpcBroadcaster
};
