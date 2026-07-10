#!/usr/bin/env node

/**
 * Build and optionally broadcast a BTC testnet4 OP_RETURN reference to a full
 * signed TradeLayer tx30 relay bundle.
 *
 * Default mode is dry-run. Broadcast is explicit:
 *   node tradelayer_tx30_relay_anchor_live.js --dlc-ref=... --oracle-id=1 --broadcast
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  buildTx30RelayBlobEnvelope,
  buildTx30RelayReference,
  buildTx30RelayAnchor,
  verifyTx30RelayAnchor,
  readLatestRelayRecordFromNeDb,
  artifactHashForTx30RelayAnchorArtifact
} = require('./tradelayer_tx30_relay_anchor');

const DEFAULT_TL_REPO = 'C:\\projects\\tradelayer.js';
const DEFAULT_BITCOIN_DATADIR = 'D:\\BitcoinTestnet';
const DEFAULT_OUT = path.join(__dirname, 'artifacts', 'live', 'tradelayer_tx30_relay_anchor_latest.json');
const EXPLORER_BASE = 'https://mempool.space/testnet4/tx/';

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

function opt(args, key, envName, fallback = undefined) {
  const value = args[key] ?? process.env[envName];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function boolOpt(args, key, envName, fallback = false) {
  const value = opt(args, key, envName, fallback ? '1' : '0');
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function numOpt(args, key, envName, fallback) {
  const raw = opt(args, key, envName, fallback);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid --${key}=${raw}`);
  return n;
}

function readCookie(cookiePath) {
  const raw = fs.readFileSync(cookiePath, 'utf8').trim();
  const i = raw.indexOf(':');
  if (i === -1) throw new Error(`invalid cookie file: ${cookiePath}`);
  return {
    user: raw.slice(0, i),
    pass: raw.slice(i + 1)
  };
}

function rpcCall({ host, port, wallet, cookie }, method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'utxoref-tx30-anchor', method, params });
    const req = http.request({
      host,
      port,
      path: `/wallet/${encodeURIComponent(wallet)}`,
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${cookie.user}:${cookie.pass}`).toString('base64')}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          reject(new Error(`Bitcoin RPC ${method} returned non-JSON: ${text}`));
          return;
        }
        if (parsed.error) {
          reject(new Error(`Bitcoin RPC ${method} error ${parsed.error.code}: ${parsed.error.message}`));
          return;
        }
        resolve(parsed.result);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Bitcoin RPC ${method} timed out`)));
    req.write(body);
    req.end();
  });
}

async function fundRawTransaction(rpc, rawHex, feeRateSatVb) {
  const common = { replaceable: true, changePosition: 1 };
  try {
    return await rpc('fundrawtransaction', [rawHex, { ...common, fee_rate: feeRateSatVb }]);
  } catch (err) {
    if (!/Unknown named parameter|Invalid parameter|Unexpected key|fee_rate|Invalid amount/i.test(err.message)) throw err;
    const btcPerKvb = feeRateSatVb * 1000 / 100000000;
    return await rpc('fundrawtransaction', [rawHex, { ...common, feeRate: btcPerKvb }]);
  }
}

async function broadcastReference({ args, reference }) {
  if (!boolOpt(args, 'broadcast', 'TL_TX30_ANCHOR_BROADCAST', false)) {
    return { attempted: false, reason: 'broadcast flag not set' };
  }

  const datadir = String(opt(args, 'bitcoin-datadir', 'BITCOIN_DATADIR', DEFAULT_BITCOIN_DATADIR));
  const cookiePath = String(opt(args, 'rpc-cookie-file', 'BITCOIN_COOKIE_FILE', path.join(datadir, 'testnet4', '.cookie')));
  const wallet = String(opt(args, 'wallet', 'BITCOIN_WALLET', 'utxoref-testnet'));
  const host = String(opt(args, 'rpc-host', 'BITCOIN_RPC_HOST', '127.0.0.1'));
  const port = numOpt(args, 'rpc-port', 'BITCOIN_RPC_PORT', 48332);
  const feeRateSatVb = Number(opt(args, 'fee-rate-sat-vb', 'BITCOIN_FEE_RATE_SAT_VB', '1'));
  const cookie = readCookie(cookiePath);
  const rpc = (method, params) => rpcCall({ host, port, wallet, cookie }, method, params);

  const raw = await rpc('createrawtransaction', [[], [{ data: reference.payloadHex }], 0, true]);
  const funded = await fundRawTransaction(rpc, raw, feeRateSatVb);
  const signed = await rpc('signrawtransactionwithwallet', [funded.hex]);
  if (!signed.complete) throw new Error('wallet did not fully sign tx30 relay anchor transaction');
  const mempoolAccept = await rpc('testmempoolaccept', [[signed.hex]]);
  if (!mempoolAccept?.[0]?.allowed) {
    throw new Error(`testmempoolaccept rejected tx: ${JSON.stringify(mempoolAccept?.[0] || mempoolAccept)}`);
  }
  const txid = await rpc('sendrawtransaction', [signed.hex]);
  const decoded = await rpc('decoderawtransaction', [signed.hex]);
  let mempoolEntry = null;
  try {
    mempoolEntry = await rpc('getmempoolentry', [txid]);
  } catch {}
  const height = await rpc('getblockcount', []);
  return {
    attempted: true,
    ok: true,
    txid,
    explorer: EXPLORER_BASE + txid,
    feeBtc: Number(funded.fee),
    changePosition: funded.changepos,
    mempoolAccept: mempoolAccept[0],
    decodedVout: decoded.vout,
    mempoolEntry,
    height
  };
}

function relayDbPath(args) {
  const explicit = opt(args, 'relay-db', 'TL_RELAY_DB', '');
  if (explicit) return String(explicit);
  const tradelayerRepo = String(opt(args, 'tradelayer-repo', 'TRADELAYER_REPO', DEFAULT_TL_REPO));
  const dbProfile = String(opt(args, 'tradelayer-db-profile', 'TL_DB_PROFILE', 'btc-test'));
  return path.join(tradelayerRepo, 'nedb-data', dbProfile, 'oracleData.db');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dlcRef = String(opt(args, 'dlc-ref', 'TL_DLC_CONTRACT_ID', ''));
  const oracleId = numOpt(args, 'oracle-id', 'TL_ORACLE_ID', 1);
  const relayType = numOpt(args, 'relay-type', 'TL_RELAY_TYPE', 1);
  const chain = String(opt(args, 'chain', 'TL_CHAIN', 'BTC_TESTNET4'));
  if (!dlcRef) throw new Error('Missing --dlc-ref');

  const dbPath = relayDbPath(args);
  const relayRecord = readLatestRelayRecordFromNeDb(dbPath, { dlcRef, oracleId, relayType });
  const envelope = buildTx30RelayBlobEnvelope({
    relayBlob: relayRecord.relayBlob,
    relayRecord,
    chain,
    oracleId,
    relayType,
    dlcRef,
    blockHeight: relayRecord.blockHeight,
    relayStoreKey: relayRecord._id
  });
  const reference = buildTx30RelayReference({ envelope });
  let anchor = buildTx30RelayAnchor({ envelope, reference });
  const verification = verifyTx30RelayAnchor(anchor);
  if (!verification.ok) {
    throw new Error(`anchor verification failed: ${verification.errors.join('; ')}`);
  }

  const broadcast = await broadcastReference({ args, reference });
  if (broadcast.ok && broadcast.txid) {
    anchor = buildTx30RelayAnchor({
      envelope,
      reference,
      chainTxid: broadcast.txid,
      explorer: broadcast.explorer
    });
  }

  const artifact = {
    kind: 'tradelayer_tx30_relay_anchor_live_run',
    createdAt: new Date().toISOString(),
    relayDbPath: dbPath,
    relayRecordKey: relayRecord._id,
    relayRecord,
    anchor,
    verification: verifyTx30RelayAnchor(anchor),
    broadcast
  };
  artifact.artifactHash = artifactHashForTx30RelayAnchorArtifact(artifact);

  const outPath = String(opt(args, 'out', 'TL_TX30_ANCHOR_OUT', DEFAULT_OUT));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));

  console.log('[tx30-relay-anchor-live] result');
  console.log(JSON.stringify({
    dlcRef,
    oracleId,
    relayType,
    relayBlobHash: anchor.relayBlobHash,
    payloadText: anchor.payloadText,
    payloadBytes: anchor.reference.payloadBytes,
    broadcastAttempted: broadcast.attempted,
    broadcastOk: broadcast.ok || false,
    txid: broadcast.txid || null,
    explorer: broadcast.explorer || null,
    artifactPath: outPath,
    artifactHash: artifact.artifactHash
  }, null, 2));
}

main().catch((err) => {
  console.error('[tx30-relay-anchor-live] failed:', err.message || err);
  process.exit(1);
});
