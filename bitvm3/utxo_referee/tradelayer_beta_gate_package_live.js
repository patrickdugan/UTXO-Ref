#!/usr/bin/env node

/**
 * Build the current real-money beta gate package from live/testnet evidence.
 *
 * This writes a conservative package. Without separated role keys, completed
 * drills, loss caps, and external review scope, the output remains NO-GO or
 * LIMITED_TESTNET_CONTINUE.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  publishRelayBundleToReplicas,
  retrieveRelayBundleFromReplicas,
  buildRelayRetrievalFault
} = require('./tradelayer_tx30_relay_retrieval');
const {
  buildKeySeparationCeremony,
  buildOperationalDrillChecklist,
  buildBetaGatePackage,
  renderBetaGateMarkdown
} = require('./tradelayer_beta_gate_package');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts', 'live');
const DEFAULT_OUT = path.join(ARTIFACTS_DIR, 'tradelayer_beta_gate_package_latest.json');
const DEFAULT_MD_OUT = path.join(ARTIFACTS_DIR, 'tradelayer_beta_gate_package_latest.md');
const DEFAULT_REPLICA_ROOT = path.join(ARTIFACTS_DIR, 'tx30_relay_replicas');
const DEFAULT_BITCOIN_DATADIR = 'D:\\BitcoinTestnet';

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

function loadJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readCookie(cookiePath) {
  const raw = fs.readFileSync(cookiePath, 'utf8').trim();
  const i = raw.indexOf(':');
  if (i === -1) throw new Error(`invalid cookie file: ${cookiePath}`);
  return { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

function rpcCall({ host, port, wallet, cookie }, method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'utxoref-beta-gate', method, params });
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
        } catch {
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

function rpcFromArgs(args) {
  const datadir = String(opt(args, 'bitcoin-datadir', 'BITCOIN_DATADIR', DEFAULT_BITCOIN_DATADIR));
  const cookiePath = String(opt(args, 'rpc-cookie-file', 'BITCOIN_COOKIE_FILE', path.join(datadir, 'testnet4', '.cookie')));
  const wallet = String(opt(args, 'wallet', 'BITCOIN_WALLET', 'utxoref-testnet'));
  const host = String(opt(args, 'rpc-host', 'BITCOIN_RPC_HOST', '127.0.0.1'));
  const port = Number(opt(args, 'rpc-port', 'BITCOIN_RPC_PORT', 48332));
  const cookie = readCookie(cookiePath);
  return {
    wallet,
    call: (method, params) => rpcCall({ host, port, wallet, cookie }, method, params)
  };
}

async function txEvidence(rpc, txid, vout = null) {
  if (!txid) return null;
  let walletTx = null;
  let mempoolEntry = null;
  let unspent = null;
  try { walletTx = await rpc.call('gettransaction', [txid]); } catch {}
  try { mempoolEntry = await rpc.call('getmempoolentry', [txid]); } catch {}
  if (vout !== null && vout !== undefined) {
    try { unspent = await rpc.call('gettxout', [txid, Number(vout), true]); } catch {}
  }
  return {
    txid,
    vout,
    confirmed: Number(walletTx?.confirmations || 0) > 0,
    confirmations: Number(walletTx?.confirmations || 0),
    blockheight: walletTx?.blockheight ?? null,
    blockhash: walletTx?.blockhash ?? null,
    inMempool: Boolean(mempoolEntry),
    unbroadcast: mempoolEntry?.unbroadcast ?? null,
    bip125: mempoolEntry?.['bip125-replaceable'] ?? null,
    unspent: vout === null || vout === undefined ? null : Boolean(unspent)
  };
}

function rolesFromEnv(args) {
  return {
    reserveOperator: {
      owner: opt(args, 'reserve-operator-owner', 'TL_RESERVE_OPERATOR_OWNER', ''),
      custody: opt(args, 'reserve-operator-custody', 'TL_RESERVE_OPERATOR_CUSTODY', ''),
      publicKey: opt(args, 'reserve-operator-pubkey', 'TL_RESERVE_OPERATOR_PUBKEY', '')
    },
    watchtowerGuardian: {
      owner: opt(args, 'watchtower-guardian-owner', 'TL_WATCHTOWER_GUARDIAN_OWNER', ''),
      custody: opt(args, 'watchtower-guardian-custody', 'TL_WATCHTOWER_GUARDIAN_CUSTODY', ''),
      publicKey: opt(args, 'watchtower-guardian-pubkey', 'TL_WATCHTOWER_GUARDIAN_PUBKEY', '')
    },
    stateOracle: {
      owner: opt(args, 'state-oracle-owner', 'TL_STATE_ORACLE_OWNER', ''),
      custody: opt(args, 'state-oracle-custody', 'TL_STATE_ORACLE_CUSTODY', ''),
      publicKey: opt(args, 'state-oracle-pubkey', 'TL_STATE_ORACLE_PUBKEY', '')
    },
    challenger: {
      owner: opt(args, 'challenger-owner', 'TL_CHALLENGER_OWNER', ''),
      custody: opt(args, 'challenger-custody', 'TL_CHALLENGER_CUSTODY', ''),
      publicKey: opt(args, 'challenger-pubkey', 'TL_CHALLENGER_PUBKEY', '')
    },
    emergencyRecovery: {
      owner: opt(args, 'emergency-recovery-owner', 'TL_EMERGENCY_RECOVERY_OWNER', ''),
      custody: opt(args, 'emergency-recovery-custody', 'TL_EMERGENCY_RECOVERY_CUSTODY', ''),
      publicKey: opt(args, 'emergency-recovery-pubkey', 'TL_EMERGENCY_RECOVERY_PUBKEY', '')
    }
  };
}

function capsFromArgs(args) {
  return {
    maxTotalLossSats: opt(args, 'max-total-loss-sats', 'TL_MAX_TOTAL_LOSS_SATS', ''),
    maxPerContractSats: opt(args, 'max-per-contract-sats', 'TL_MAX_PER_CONTRACT_SATS', ''),
    pausePolicy: opt(args, 'pause-policy', 'TL_PAUSE_POLICY', '')
  };
}

function externalReviewFromArgs(args) {
  return {
    scopeDefined: boolOpt(args, 'external-review-scope-defined', 'TL_EXTERNAL_REVIEW_SCOPE_DEFINED', false),
    reviewer: opt(args, 'external-reviewer', 'TL_EXTERNAL_REVIEWER', ''),
    reviewOwner: opt(args, 'external-review-owner', 'TL_EXTERNAL_REVIEW_OWNER', '')
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const createdAt = new Date().toISOString();
  const rpc = rpcFromArgs(args);
  const tipHeight = await rpc.call('getblockcount', []);

  const reserveArtifactPath = String(opt(
    args,
    'reserve-artifact',
    'TL_RESERVE_ARTIFACT',
    path.join(ARTIFACTS_DIR, 'btc_testnet4_reserve_vault_latest.json')
  ));
  const anchorArtifactPath = String(opt(
    args,
    'tx30-anchor-artifact',
    'TL_TX30_ANCHOR_ARTIFACT',
    path.join(ARTIFACTS_DIR, 'tradelayer_tx30_relay_anchor_broadcast_latest.json')
  ));

  const reserveArtifact = loadJsonIfExists(reserveArtifactPath);
  const anchorArtifact = loadJsonIfExists(anchorArtifactPath);
  const anchor = anchorArtifact?.anchor;
  if (!anchor) throw new Error(`tx30 relay anchor artifact missing anchor: ${anchorArtifactPath}`);

  const reserveTxid = reserveArtifact?.manifest?.core?.fundingOutpoint?.txid
    || reserveArtifact?.funding?.broadcast?.txid
    || '93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6';
  const reserveVout = reserveArtifact?.manifest?.core?.fundingOutpoint?.vout ?? 0;
  const reserveStatus = await txEvidence(rpc, reserveTxid, reserveVout);
  const anchorStatus = await txEvidence(rpc, anchor.chainTxid, null);

  const replicaRoot = String(opt(args, 'replica-root', 'TL_RELAY_REPLICA_ROOT', DEFAULT_REPLICA_ROOT));
  const replicaDirs = [
    path.join(replicaRoot, 'primary'),
    path.join(replicaRoot, 'secondary')
  ];
  const relayPublication = publishRelayBundleToReplicas(anchor, replicaDirs, {
    createdAt,
    replicaLabels: ['primary-local', 'secondary-local']
  });
  const relayRetrieval = retrieveRelayBundleFromReplicas({
    relayBlobHash: anchor.relayBlobHash,
    replicaDirs,
    expected: {
      envelopeHash: anchor.envelopeHash,
      referenceHash: anchor.referenceHash
    }
  });
  const relayFault = buildRelayRetrievalFault(anchor, relayRetrieval, { checkedAtHeight: tipHeight });

  const keyCeremony = buildKeySeparationCeremony({ roles: rolesFromEnv(args), createdAt });
  const drillChecklist = buildOperationalDrillChecklist({ drills: {}, createdAt });
  const evidence = {
    createdAt,
    chain: 'BTC_TESTNET4',
    tipHeight,
    reserve: {
      ...reserveStatus,
      artifact: reserveArtifactPath
    },
    tx30RelayAnchor: {
      ...anchorStatus,
      artifact: anchorArtifactPath,
      relayBlobHash: anchor.relayBlobHash
    },
    relayRetrieval: {
      ok: relayRetrieval.ok,
      relayBlobHash: anchor.relayBlobHash,
      replicaCount: relayPublication.replicaCount,
      publicationHash: relayPublication.publicationHash,
      retrievalHash: relayRetrieval.retrievalHash,
      recoveredFrom: relayRetrieval.recoveredFrom,
      fault: relayFault
    },
    tests: {
      fullSuitePassed: boolOpt(args, 'full-suite-passed', 'TL_FULL_SUITE_PASSED', false),
      command: 'node bitvm3\\utxo_referee\\run_utxoref_all.js',
      suites: opt(args, 'suite-count', 'TL_SUITE_COUNT', '')
    }
  };

  const pkg = buildBetaGatePackage({
    createdAt,
    evidence,
    keyCeremony,
    drillChecklist,
    caps: capsFromArgs(args),
    externalReview: externalReviewFromArgs(args)
  });

  const outPath = String(opt(args, 'out', 'TL_BETA_GATE_OUT', DEFAULT_OUT));
  const mdOutPath = String(opt(args, 'md-out', 'TL_BETA_GATE_MD_OUT', DEFAULT_MD_OUT));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(mdOutPath, renderBetaGateMarkdown(pkg));

  console.log('[beta-gate-package-live] result');
  console.log(JSON.stringify({
    status: pkg.status,
    realMoneyAllowed: pkg.realMoneyAllowed,
    tipHeight,
    reserveConfirmed: evidence.reserve.confirmed,
    relayRetrievalOk: evidence.relayRetrieval.ok,
    keyCeremonyOk: keyCeremony.ok,
    drillsOk: drillChecklist.ok,
    packageHash: pkg.packageHash,
    outPath,
    mdOutPath
  }, null, 2));
}

main().catch((err) => {
  console.error('[beta-gate-package-live] failed:', err.message || err);
  process.exit(1);
});
