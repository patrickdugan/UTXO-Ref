/**
 * Milestone 1 - Funding PSBT Sign/Finalize/Broadcast
 *
 * Consumes m1_funding_psbt_latest.json and performs:
 * 1) walletprocesspsbt
 * 2) finalizepsbt
 * 3) optional sendrawtransaction (broadcast enabled by default)
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_dlc_sign_finalize.js
 *
 * Optional env:
 *   LTC_RPC_URL=http://127.0.0.1:19332
 *   LTC_RPC_USER=user
 *   LTC_RPC_PASS=pass
 *   LTC_WALLET=tl-wallet
 *   BROADCAST_FUNDING=1
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const RPC_URL = process.env.LTC_RPC_URL || 'http://127.0.0.1:19332';
const RPC_USER = process.env.LTC_RPC_USER || 'user';
const RPC_PASS = process.env.LTC_RPC_PASS || 'pass';
const WALLET = process.env.LTC_WALLET || 'tl-wallet';
const BROADCAST = (process.env.BROADCAST_FUNDING || '1') !== '0';

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const FUNDING_PSBT_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function ensureFile(p) {
  if (!fs.existsSync(p)) throw new Error(`Artifact missing: ${p}`);
}

function encodeBasicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function rpcFactory({ rpcUrl, rpcUser, rpcPass }) {
  const endpoint = new URL(rpcUrl);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return async function rpc(method, params = [], wallet = null) {
    const walletPath = wallet ? `/wallet/${encodeURIComponent(wallet)}` : '';
    const pathname = endpoint.pathname && endpoint.pathname !== '/' ? endpoint.pathname : '';
    const targetPath = `${walletPath}${pathname || ''}` || '/';

    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: 'm1-dlc-finalize',
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
        Authorization: encodeBasicAuth(rpcUser, rpcPass)
      }
    };

    return new Promise((resolve, reject) => {
      const req = transport.request(options, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch (e) {
            reject(new Error(`Invalid RPC response for ${method}`));
            return;
          }
          if (json.error) {
            reject(new Error(`RPC ${method} failed: ${json.error.message}`));
            return;
          }
          resolve(json.result);
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  };
}

async function run() {
  ensureFile(FUNDING_PSBT_PATH);
  const funding = JSON.parse(fs.readFileSync(FUNDING_PSBT_PATH, 'utf8'));
  const rpc = rpcFactory({
    rpcUrl: RPC_URL,
    rpcUser: RPC_USER,
    rpcPass: RPC_PASS
  });

  const psbt = funding.funding.psbt;
  if (!psbt) throw new Error('Funding artifact has no PSBT');

  const processed = await rpc('walletprocesspsbt', [psbt, true, 'ALL', true], WALLET);
  const finalized = await rpc('finalizepsbt', [processed.psbt, true], WALLET);

  if (!finalized.complete || !finalized.hex) {
    throw new Error('PSBT finalization incomplete');
  }

  const decoded = await rpc('decoderawtransaction', [finalized.hex]);
  const txid = decoded.txid;
  const wtxid = decoded.hash;

  let broadcast = {
    attempted: BROADCAST,
    sent: false,
    error: null,
    txid: txid
  };

  if (BROADCAST) {
    try {
      const sentTxid = await rpc('sendrawtransaction', [finalized.hex], WALLET);
      broadcast.sent = true;
      broadcast.txid = sentTxid;
    } catch (e) {
      // Accept already-in-chain / already-in-mempool as non-fatal for id reporting.
      const msg = String(e.message || e);
      broadcast.error = msg;
      if (msg.includes('already in block chain') || msg.includes('txn-already-known')) {
        broadcast.sent = true;
      } else {
        throw e;
      }
    }
  }

  const out = {
    kind: 'm1_funding_finalized',
    createdAt: new Date().toISOString(),
    sourceFundingArtifact: FUNDING_PSBT_PATH,
    sourceHash: sha256Hex(JSON.stringify(funding)),
    wallet: WALLET,
    txid,
    wtxid,
    vsize: decoded.vsize,
    locktime: decoded.locktime,
    hex: finalized.hex,
    broadcast
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

  console.log('=== M1 Funding Finalize ===');
  console.log(`wallet=${WALLET}`);
  console.log(`txid=${txid}`);
  console.log(`wtxid=${wtxid}`);
  console.log(`broadcasted=${broadcast.sent}`);
  if (broadcast.error) {
    console.log(`broadcastNote=${broadcast.error}`);
  }
  console.log(`artifactPath=${OUT_PATH}`);
}

run().catch(err => {
  console.error('Finalize failed:', err.message);
  process.exit(1);
});

