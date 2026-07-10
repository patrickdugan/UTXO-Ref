#!/usr/bin/env node

/**
 * Live/dry harness for the hourly rBTC DLC auto-roll rule.
 *
 * Default mode is non-broadcasting. It reads a TradeLayer balance from either:
 * - a running walletListener (`--source=listener`, default), or
 * - the local tradelayer.js NeDB state (`--source=db`).
 *
 * It then evaluates the hourly DLC policy:
 * - unchanged rBTC balance at expiry => roll CET + tx30 autoRoll intent
 * - reduced rBTC balance at expiry => settlement CET, no autoRoll
 *
 * Broadcast is intentionally explicit and requires:
 *   --broadcast --tradelayer-repo=... --oracle-address=... --oracle-id=...
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
  buildHourlyRbtcDlcContract,
  buildHourlyRbtcCetDecision
} = require('./tradelayer_rbtc_hourly_autoroll');
const { sha256Hex, stableStringify } = require('./tradelayer_pnl_route_adapter');

const DEFAULT_TL_REPO = 'C:\\projects\\tradelayer.js';
const DEFAULT_OUT = path.join(__dirname, 'artifacts', 'live', 'rbtc_hourly_autoroll_latest.json');

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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body || {});
    const req = http.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch (err) {
          reject(new Error(`Invalid JSON from ${url}: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout posting ${url}`)));
    req.write(payload);
    req.end();
  });
}

function decimalToUnits(value, field) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${field} is required`);
  if (!/^\d+(\.\d{1,8})?$/.test(s)) {
    if (/^\d+$/.test(s)) return BigInt(s);
    throw new Error(`${field} must be a non-negative decimal with <=8 places or integer units`);
  }
  const [whole, frac = ''] = s.split('.');
  return (BigInt(whole) * 100000000n + BigInt((frac + '00000000').slice(0, 8))).toString();
}

function balanceObjectToAvailable(balance) {
  const b = balance?.balance || balance;
  return b?.available ?? b?.amount ?? 0;
}

async function readBalanceFromListener({ baseUrl, fundingAddress, propertyId }) {
  const balances = await postJson(`${baseUrl.replace(/\/$/, '')}/tl_getAllBalancesForAddress`, {
    params: fundingAddress
  });
  if (!Array.isArray(balances)) {
    throw new Error('listener returned non-array balance payload');
  }
  const found = balances.find((row) => String(row.propertyId) === String(propertyId));
  return {
    source: 'listener',
    rawBalances: balances,
    available: balanceObjectToAvailable(found || { balance: { available: 0 } })
  };
}

async function readBalanceFromDb({ tradelayerRepo, chain, fundingAddress, propertyId }) {
  process.env.TL_SKIP_RPC_BOOT = '1';
  process.env.TL_FORCE_TEST = '1';
  process.env.CHAIN = String(chain || 'BTC').toUpperCase();
  const tallyPath = path.join(tradelayerRepo, 'src', 'tally.js');
  const TallyMap = require(tallyPath);
  const tally = await TallyMap.getTally(fundingAddress, propertyId);
  return {
    source: 'db',
    dbChain: process.env.CHAIN,
    available: balanceObjectToAvailable(tally || { available: 0 }),
    tally
  };
}

function loadVaultArtifact(vaultArtifactPath) {
  if (!vaultArtifactPath || !fs.existsSync(vaultArtifactPath)) return {};
  return JSON.parse(fs.readFileSync(vaultArtifactPath, 'utf8'));
}

function buildTx30Intent({ decision, oracleId, dlcRef, nextDlcRef, oracleAddress, propertyId }) {
  const autoRoll = Boolean(decision.policy.canAutoRoll);
  const stateHash = decision.observation.observationHash;
  const relayBlobCore = {
    kind: 'rbtc_hourly_autoroll_relay_v1',
    contractId: decision.contract.core.contractId,
    observationHash: decision.observation.observationHash,
    policy: decision.policy,
    selectedCetHash: decision.selectedCet?.selectionHash || null,
    settlement: {
      mode: autoRoll ? 'rollover' : 'none',
      propertyId: Number(propertyId),
      amount: 0,
      fromAddress: decision.contract.core.fundingAddress,
      toAddress: decision.contract.core.fundingAddress,
      nextPropertyId: Number(propertyId)
    }
  };
  return {
    action: 2,
    oracleId: Number(oracleId || 0),
    relayType: 1,
    stateHash,
    dlcRef,
    settlementState: autoRoll ? 'ROLLED' : 'SETTLED',
    relayBlob: JSON.stringify(relayBlobCore),
    autoRoll,
    nextDlcRef: autoRoll ? nextDlcRef : '',
    oracleAddress: oracleAddress || null,
    relayBlobHash: sha256Hex(relayBlobCore)
  };
}

function maybeBroadcast({ args, tradelayerRepo, tx30Intent }) {
  if (!boolOpt(args, 'broadcast', 'TL_BROADCAST', false)) {
    return { attempted: false, reason: 'broadcast flag not set' };
  }
  if (!tx30Intent.oracleAddress || !tx30Intent.oracleId || !tx30Intent.dlcRef) {
    throw new Error('broadcast requires oracle-address, oracle-id, and dlc-ref');
  }
  const oraclePrivkeyHex = opt(args, 'oracle-privkey-hex', 'TL_ORACLE_PRIVKEY_HEX', '');
  const oraclePubkeyHex = opt(args, 'oracle-pubkey-hex', 'TL_ORACLE_PUBKEY_HEX', '');
  const cmdArgs = [
    path.join('utils', 'canonicalStateOracle.js'),
    `--oracleId=${tx30Intent.oracleId}`,
    `--oracleAddress=${tx30Intent.oracleAddress}`,
    `--propertyId=${numOpt(args, 'rbtc-property-id', 'TL_RBTC_PROPERTY_ID', 1)}`,
    `--dlcRef=${tx30Intent.dlcRef}`,
    `--settlementState=${tx30Intent.settlementState}`,
    '--relayType=1',
    `--autoRoll=${tx30Intent.autoRoll ? '1' : '0'}`,
    `--nextDlcRef=${tx30Intent.nextDlcRef || ''}`,
    '--settleAction=none',
    '--amount=0',
    '--dryRun=0'
  ];
  const childEnv = {
    ...process.env,
    TL_SKIP_RPC_BOOT: '1',
    TL_FORCE_TEST: '1',
    AUTODETECT: '0',
    CHAIN: String(opt(args, 'broadcast-chain', 'TL_BROADCAST_CHAIN', 'BTC')).toUpperCase()
  };
  if (oraclePrivkeyHex) childEnv.TL_ORACLE_PRIVKEY_HEX = oraclePrivkeyHex;
  if (oraclePubkeyHex) childEnv.TL_ORACLE_PUBKEY_HEX = oraclePubkeyHex;
  const run = spawnSync(process.execPath, cmdArgs, {
    cwd: tradelayerRepo,
    env: childEnv,
    encoding: 'utf8'
  });
  return {
    attempted: true,
    command: `node ${cmdArgs.join(' ')}`,
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    ok: run.status === 0
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = String(opt(args, 'source', 'TL_BALANCE_SOURCE', 'listener')).toLowerCase();
  const tradelayerRepo = String(opt(args, 'tradelayer-repo', 'TRADELAYER_REPO', DEFAULT_TL_REPO));
  const baseUrl = String(opt(args, 'base-url', 'TL_BASE_URL', 'http://127.0.0.1:3000'));
  const chain = String(opt(args, 'chain', 'TL_CHAIN', 'BTC')).toUpperCase();
  const vaultArtifactPath = String(opt(
    args,
    'vault-artifact',
    'TL_VAULT_ARTIFACT',
    path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_reserve_vault_latest.json')
  ));
  const vaultArtifact = loadVaultArtifact(vaultArtifactPath);
  const vaultManifest = vaultArtifact?.manifest?.core || {};
  const fundingOutpoint = {
    txid: String(opt(
      args,
      'funding-txid',
      'TL_FUNDING_TXID',
      vaultManifest?.fundingOutpoint?.txid || '93f953df2c89faf386d14217fb4d3de62d91d3789fee83cc53acfd653882f6a6'
    )),
    vout: numOpt(args, 'funding-vout', 'TL_FUNDING_VOUT', vaultManifest?.fundingOutpoint?.vout ?? 0)
  };
  const vaultAddress = String(opt(
    args,
    'vault-address',
    'TL_VAULT_ADDRESS',
    vaultArtifact?.reserveSet?.core?.vaults?.[0]?.chainTxout?.address || 'tb1p8l6fdqqyyfp09xda0xv59xgltas6eecem47rvuq2walz0t5zrcgq06pcf9'
  ));
  const fundingAddress = String(opt(args, 'funding-address', 'TL_FUNDING_ADDRESS', ''));
  if (!fundingAddress) throw new Error('Missing --funding-address / TL_FUNDING_ADDRESS');
  const propertyId = numOpt(args, 'rbtc-property-id', 'TL_RBTC_PROPERTY_ID', 1);
  const now = Math.floor(Date.now() / 1000);
  const startsAtUnix = numOpt(args, 'starts-at-unix', 'TL_STARTS_AT_UNIX', now);
  const durationSeconds = numOpt(args, 'duration-seconds', 'TL_DURATION_SECONDS', 3600);
  const forceExpired = boolOpt(args, 'force-expired', 'TL_FORCE_EXPIRED', false);
  const observedAtUnix = numOpt(
    args,
    'observed-at-unix',
    'TL_OBSERVED_AT_UNIX',
    forceExpired ? startsAtUnix + durationSeconds : now
  );
  const oracleId = numOpt(args, 'oracle-id', 'TL_ORACLE_ID', 0);
  const oracleAddress = String(opt(args, 'oracle-address', 'TL_ORACLE_ADMIN_ADDRESS', ''));
  const dlcRef = String(opt(args, 'dlc-ref', 'TL_DLC_CONTRACT_ID', `rbtc-hour-${fundingOutpoint.txid.slice(0, 8)}`));
  const nextDlcRef = String(opt(args, 'next-dlc-ref', 'TL_DLC_NEXT_CONTRACT_ID', `${dlcRef}-next`));

  const balance = source === 'db'
    ? await readBalanceFromDb({ tradelayerRepo, chain, fundingAddress, propertyId })
    : await readBalanceFromListener({ baseUrl, fundingAddress, propertyId });
  const currentUnits = decimalToUnits(balance.available, 'current rBTC balance');
  const startingUnits = opt(args, 'starting-rbtc-units', 'TL_STARTING_RBTC_UNITS')
    || (opt(args, 'starting-rbtc-balance', 'TL_STARTING_RBTC_BALANCE')
      ? decimalToUnits(opt(args, 'starting-rbtc-balance', 'TL_STARTING_RBTC_BALANCE'), 'starting rBTC balance')
      : currentUnits);

  const contract = buildHourlyRbtcDlcContract({
    contractId: dlcRef,
    previousContractId: opt(args, 'previous-dlc-ref', 'TL_PREVIOUS_DLC_CONTRACT_ID', null),
    vaultAddress,
    fundingAddress,
    rbtcPropertyId: propertyId,
    fundingOutpoint,
    reserveVaultId: vaultManifest?.vaultId || null,
    startsAtUnix,
    durationSeconds,
    startingRbtcBalance: startingUnits
  });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const decision = buildHourlyRbtcCetDecision({
    contract,
    observation: {
      observedAtUnix,
      currentRbtcBalance: currentUnits
    },
    collateralSats: vaultManifest?.amountSats || opt(args, 'collateral-sats', 'TL_COLLATERAL_SATS', 20000),
    privateKey,
    publicKey
  });
  const tx30Intent = buildTx30Intent({
    decision,
    oracleId,
    dlcRef,
    nextDlcRef,
    oracleAddress,
    propertyId
  });
  const broadcast = maybeBroadcast({ args, tradelayerRepo, tx30Intent });
  const artifact = {
    kind: 'tradelayer_rbtc_hourly_autoroll_live_run',
    createdAt: new Date().toISOString(),
    source,
    tradelayerRepo,
    baseUrl: source === 'listener' ? baseUrl : null,
    chain: source === 'db' ? chain : null,
    vaultArtifactPath: fs.existsSync(vaultArtifactPath) ? vaultArtifactPath : null,
    balance,
    currentUnits,
    startingUnits,
    contract,
    decision,
    tx30Intent,
    broadcast
  };
  artifact.artifactHash = sha256Hex(stableStringify({
    kind: artifact.kind,
    contractHash: contract.contractHash,
    observationHash: decision.observation.observationHash,
    decisionHash: decision.decisionHash,
    tx30IntentHash: tx30Intent.relayBlobHash,
    broadcast: broadcast.ok || false
  }));

  const outPath = String(opt(args, 'out', 'TL_AUTOROLL_OUT', DEFAULT_OUT));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));

  console.log('[rbtc-hourly-autoroll-live] result');
  console.log(JSON.stringify({
    source,
    fundingAddress,
    propertyId,
    currentUnits,
    startingUnits,
    outcomeId: decision.policy.outcomeId,
    canAutoRoll: decision.policy.canAutoRoll,
    reason: decision.policy.reason,
    selectedCet: decision.selectedCet?.selection?.outcomeId || null,
    tx30AutoRoll: tx30Intent.autoRoll,
    nextDlcRef: tx30Intent.nextDlcRef || null,
    broadcastAttempted: broadcast.attempted,
    broadcastOk: broadcast.ok || false,
    artifactPath: outPath,
    artifactHash: artifact.artifactHash
  }, null, 2));
  if (broadcast.attempted && !broadcast.ok) process.exit(1);
}

main().catch((err) => {
  console.error('[rbtc-hourly-autoroll-live] failed:', err.message || err);
  process.exit(1);
});
