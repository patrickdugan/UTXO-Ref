/**
 * Milestone 1 - Funding PSBT Sign/Finalize/Broadcast
 *
 * Consumes m1_funding_psbt_latest.json and performs:
 * 1) walletprocesspsbt
 * 2) finalizepsbt
 * 3) write a local finalized transaction artifact
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_dlc_sign_finalize.js
 *
 * Optional env:
 *   LTC_RPC_URL=http://127.0.0.1:19332
 *   LTC_RPC_USER=user
 *   LTC_RPC_PASS=pass
 *   LTC_WALLET=tl-wallet
 *
 * Funding broadcast is intentionally disabled. This milestone path does not
 * yet exchange and verify every CET adaptor signature plus both refund
 * signatures, so broadcasting could strand the funding output.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const { validateDlcContract } = require('./dlc_contract_state');

const RPC_URL = process.env.LTC_RPC_URL || 'http://127.0.0.1:19332';
const RPC_USER = process.env.LTC_RPC_USER || 'user';
const RPC_PASS = process.env.LTC_RPC_PASS || 'pass';
const WALLET = process.env.LTC_WALLET || 'tl-wallet';
const BROADCAST_REQUESTED = process.env.BROADCAST_FUNDING === '1';
const DLC_STATE_PATH = process.env.DLC_STATE_PATH || '';

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const FUNDING_PSBT_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function ensureFile(p) {
  if (!fs.existsSync(p)) throw new Error(`Artifact missing: ${p}`);
}

function decodeCanonicalPsbt(psbt) {
  if (typeof psbt !== 'string' || psbt.length < 8 || psbt.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(psbt)) {
    throw new Error('Funding artifact PSBT must be canonical base64');
  }
  const bytes = Buffer.from(psbt, 'base64');
  if (bytes.toString('base64') !== psbt || bytes.length < 5 || bytes.subarray(0, 5).toString('hex') !== '70736274ff') {
    throw new Error('Funding artifact does not contain a canonical PSBT');
  }
  return bytes;
}

function validateFundingAuthorization(state, funding) {
  validateDlcContract(state);
  if (state.stage !== 'FUNDING_PSBT_APPROVED') {
    throw new Error(`DLC state must be FUNDING_PSBT_APPROVED before wallet signing; current stage is ${state.stage}`);
  }
  const expectedChain = state.network === 'bitcoin-testnet4' ? 'testnet4' : 'regtest';
  if (!funding || !funding.chain || funding.chain.network !== expectedChain) {
    throw new Error(`Funding artifact network must be ${expectedChain}`);
  }
  const psbt = funding.funding && funding.funding.psbt;
  const psbtDigest = sha256Hex(decodeCanonicalPsbt(psbt));
  const approval = state.history[state.history.length - 1];
  const receipt = approval && approval.evidence.find((item) => item.kind === 'funding_psbt_validation');
  if (!receipt || receipt.digest !== psbtDigest) {
    throw new Error('Funding PSBT does not match the approved validation receipt');
  }
  return { psbt, psbtDigest, stateRecordHash: state.recordHash };
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
  if (BROADCAST_REQUESTED) {
    throw new Error(
      'funding broadcast disabled: verified CET adaptor signatures and a fully signed refund transaction are required first'
    );
  }
  if (!DLC_STATE_PATH) {
    throw new Error('DLC_STATE_PATH is required before wallet funding signing');
  }
  ensureFile(DLC_STATE_PATH);
  ensureFile(FUNDING_PSBT_PATH);
  const state = JSON.parse(fs.readFileSync(DLC_STATE_PATH, 'utf8'));
  const funding = JSON.parse(fs.readFileSync(FUNDING_PSBT_PATH, 'utf8'));
  const authorization = validateFundingAuthorization(state, funding);
  const rpc = rpcFactory({
    rpcUrl: RPC_URL,
    rpcUser: RPC_USER,
    rpcPass: RPC_PASS
  });

  const psbt = authorization.psbt;

  const processed = await rpc('walletprocesspsbt', [psbt, true, 'ALL', true], WALLET);
  const finalized = await rpc('finalizepsbt', [processed.psbt, true], WALLET);

  if (!finalized.complete || !finalized.hex) {
    throw new Error('PSBT finalization incomplete');
  }

  const decoded = await rpc('decoderawtransaction', [finalized.hex]);
  const txid = decoded.txid;
  const wtxid = decoded.hash;

  const broadcast = {
    attempted: false,
    sent: false,
    error: 'disabled_pending_verified_cet_and_refund_signatures',
    txid: txid
  };

  const out = {
    kind: 'm1_funding_finalized',
    createdAt: new Date().toISOString(),
    sourceFundingArtifact: FUNDING_PSBT_PATH,
    sourceHash: sha256Hex(JSON.stringify(funding)),
    fundingPsbtDigest: authorization.psbtDigest,
    dlcStateRecordHash: authorization.stateRecordHash,
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

if (require.main === module) {
  run().catch(err => {
    console.error('Finalize failed:', err.message);
    process.exit(1);
  });
}

module.exports = { decodeCanonicalPsbt, validateFundingAuthorization, run };

