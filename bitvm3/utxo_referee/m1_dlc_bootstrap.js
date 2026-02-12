/**
 * Milestone 1 DLC Bootstrap (Litecoin testnet)
 *
 * Builds a concrete DLC draft artifact from live wallet state:
 * - discovers latest role-address set provisioned with m1_* tooling
 * - selects confirmed collateral UTXOs (alice + bob)
 * - computes deterministic outcome buckets and locktimes
 * - writes JSON artifact for inspection/review
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_dlc_bootstrap.js
 *
 * Env (optional):
 *   LTC_RPC_URL=http://127.0.0.1:19332
 *   LTC_RPC_USER=user
 *   LTC_RPC_PASS=pass
 *   LTC_WALLET=tl-wallet
 *   DLC_EPOCH_ID=1
 *   DLC_MATURITY_BLOCKS=1008
 *   DLC_REFUND_DELAY_BLOCKS=288
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const { templateHashHex, RECEIPT_DLC_TEMPLATE_V1 } = require('./m1_spec');

const DEFAULT_RPC_URL = process.env.LTC_RPC_URL || 'http://127.0.0.1:19332';
const DEFAULT_RPC_USER = process.env.LTC_RPC_USER || 'user';
const DEFAULT_RPC_PASS = process.env.LTC_RPC_PASS || 'pass';
const DEFAULT_WALLET = process.env.LTC_WALLET || 'tl-wallet';
const EPOCH_ID = BigInt(process.env.DLC_EPOCH_ID || '1');
const MATURITY_BLOCKS = Number(process.env.DLC_MATURITY_BLOCKS || '1008');
const REFUND_DELAY_BLOCKS = Number(process.env.DLC_REFUND_DELAY_BLOCKS || '288');
const ROLE_NAMES = ['operator', 'oracle', 'alice', 'bob', 'residual'];

function encodeBasicAuth(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function rpcFactory({ rpcUrl, rpcUser, rpcPass }) {
  const endpoint = new URL(rpcUrl);
  const transport = endpoint.protocol === 'https:' ? https : http;

  return async function rpc(method, params = [], wallet = null) {
    const walletPath = wallet ? `/wallet/${encodeURIComponent(wallet)}` : '';
    const targetPath = `${walletPath}${endpoint.pathname === '/' ? '' : endpoint.pathname || ''}`;

    const payload = JSON.stringify({
      jsonrpc: '1.0',
      id: 'm1-dlc-bootstrap',
      method,
      params
    });

    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: targetPath || '/',
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

function parseRoleLabel(label) {
  const m = /^((?:m1|m1-\d{8}-\d{6}))-(operator|oracle|alice|bob|residual)$/.exec(label);
  if (!m) return null;
  return { tag: m[1], role: m[2] };
}

async function findLatestRoleSet(rpc, wallet) {
  const labels = await rpc('listlabels', [], wallet);
  const grouped = new Map();

  for (const label of labels) {
    const parsed = parseRoleLabel(label);
    if (!parsed) continue;
    if (!grouped.has(parsed.tag)) grouped.set(parsed.tag, new Set());
    grouped.get(parsed.tag).add(parsed.role);
  }

  const completeTags = Array.from(grouped.entries())
    .filter(([, roles]) => ROLE_NAMES.every(r => roles.has(r)))
    .map(([tag]) => tag)
    .sort();

  if (completeTags.length === 0) {
    throw new Error('No complete m1 role set found in destination wallet');
  }

  const tag = completeTags[completeTags.length - 1];
  const addresses = {};

  for (const role of ROLE_NAMES) {
    const label = `${tag}-${role}`;
    const byLabel = await rpc('getaddressesbylabel', [label], wallet);
    const addr = Object.keys(byLabel)[0];
    if (!addr) {
      throw new Error(`Label ${label} found but no address attached`);
    }
    addresses[role] = addr;
  }

  return { tag, addresses, completeTags };
}

async function pickLatestFundedRoleSet(rpc, wallet) {
  const discovered = await findLatestRoleSet(rpc, wallet);
  const tagsDesc = discovered.completeTags.slice().sort().reverse();

  for (const tag of tagsDesc) {
    const addresses = {};
    for (const role of ROLE_NAMES) {
      const label = `${tag}-${role}`;
      const byLabel = await rpc('getaddressesbylabel', [label], wallet);
      const addr = Object.keys(byLabel)[0];
      if (!addr) {
        continue;
      }
      addresses[role] = addr;
    }

    if (!addresses.alice || !addresses.bob) {
      continue;
    }

    const aliceUtxos = await rpc('listunspent', [1, 9999999, [addresses.alice]], wallet);
    const bobUtxos = await rpc('listunspent', [1, 9999999, [addresses.bob]], wallet);
    if (aliceUtxos.length > 0 && bobUtxos.length > 0) {
      return { tag, addresses };
    }
  }

  throw new Error('No complete funded m1 role set found (alice and bob need confirmed UTXOs)');
}

function amountToSats(amount) {
  // amount is decimal LTC value from RPC (number)
  return BigInt(Math.round(Number(amount) * 1e8));
}

async function selectConfirmedUtxo(rpc, wallet, address) {
  const utxos = await rpc('listunspent', [1, 9999999, [address]], wallet);
  if (!utxos.length) {
    throw new Error(`No confirmed UTXO found for address ${address}`);
  }

  // Pick largest UTXO for stable draft collateral selection.
  utxos.sort((a, b) => Number(b.amount) - Number(a.amount));
  return utxos[0];
}

async function getAddressPubkey(rpc, wallet, address) {
  const info = await rpc('getaddressinfo', [address], wallet);
  return info.pubkey || null;
}

function buildOutcomeBuckets(collateralSats) {
  const rows = [];
  for (let bucket = 0; bucket <= 100; bucket += 5) {
    const poolAmountSats = (collateralSats * BigInt(bucket)) / 100n;
    const depositorAmountSats = collateralSats - poolAmountSats;
    rows.push({
      bucketPct: bucket,
      depositorAmountSats: depositorAmountSats.toString(),
      poolAmountSats: poolAmountSats.toString()
    });
  }
  return rows;
}

async function run() {
  const rpc = rpcFactory({
    rpcUrl: DEFAULT_RPC_URL,
    rpcUser: DEFAULT_RPC_USER,
    rpcPass: DEFAULT_RPC_PASS
  });

  const chainInfo = await rpc('getblockchaininfo');
  const currentHeight = await rpc('getblockcount');
  const roleSet = await pickLatestFundedRoleSet(rpc, DEFAULT_WALLET);

  const aliceUtxo = await selectConfirmedUtxo(rpc, DEFAULT_WALLET, roleSet.addresses.alice);
  const bobUtxo = await selectConfirmedUtxo(rpc, DEFAULT_WALLET, roleSet.addresses.bob);
  const collateralSats = amountToSats(aliceUtxo.amount) + amountToSats(bobUtxo.amount);

  const maturityHeight = currentHeight + MATURITY_BLOCKS;
  const refundLocktime = maturityHeight + REFUND_DELAY_BLOCKS;

  const operatorPubkey = await getAddressPubkey(rpc, DEFAULT_WALLET, roleSet.addresses.operator);
  const oraclePubkey = await getAddressPubkey(rpc, DEFAULT_WALLET, roleSet.addresses.oracle);

  const createdAt = new Date().toISOString();
  const eventId = `ltc-testnet-epoch-${EPOCH_ID.toString()}-${Date.now()}`;

  const draft = {
    kind: 'm1_dlc_draft',
    createdAt,
    chain: {
      network: chainInfo.chain,
      rpcUrl: DEFAULT_RPC_URL,
      blockHeight: currentHeight
    },
    template: {
      templateId: RECEIPT_DLC_TEMPLATE_V1.templateId,
      templateHash: templateHashHex(RECEIPT_DLC_TEMPLATE_V1)
    },
    roleSet: {
      tag: roleSet.tag,
      wallet: DEFAULT_WALLET,
      addresses: roleSet.addresses,
      pubkeys: {
        operator: operatorPubkey,
        oracle: oraclePubkey
      }
    },
    canonical: {
      epochId: EPOCH_ID.toString(),
      payoutLeafSchema: '(epochId, recipientScriptPubKey, amountSats)',
      commitmentPackageSchema: '(epochId, withdrawalRoot, capSats, residualDest)'
    },
    contract: {
      eventId,
      maturityHeight,
      refundLocktime,
      collateralSats: collateralSats.toString(),
      fundingInputs: [
        {
          role: 'alice',
          txid: aliceUtxo.txid,
          vout: aliceUtxo.vout,
          amountLtc: String(aliceUtxo.amount),
          amountSats: amountToSats(aliceUtxo.amount).toString()
        },
        {
          role: 'bob',
          txid: bobUtxo.txid,
          vout: bobUtxo.vout,
          amountLtc: String(bobUtxo.amount),
          amountSats: amountToSats(bobUtxo.amount).toString()
        }
      ],
      outputs: {
        operatorAddress: roleSet.addresses.operator,
        oracleAddress: roleSet.addresses.oracle,
        residualAddress: roleSet.addresses.residual
      },
      outcomes: buildOutcomeBuckets(collateralSats)
    }
  };

  const artifactJson = JSON.stringify(draft, null, 2);
  const digest = crypto.createHash('sha256').update(artifactJson).digest('hex');
  draft.artifactHash = digest;

  const dir = path.join(__dirname, 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `m1_dlc_draft_${roleSet.tag}_${Date.now()}.json`;
  const outPath = path.join(dir, filename);
  const rendered = JSON.stringify(draft, null, 2);
  fs.writeFileSync(outPath, rendered);
  const latestPath = path.join(dir, 'm1_dlc_draft_latest.json');
  fs.writeFileSync(latestPath, rendered);

  console.log('=== M1 DLC Bootstrap ===');
  console.log(`wallet=${DEFAULT_WALLET}`);
  console.log(`roleSetTag=${roleSet.tag}`);
  console.log(`chain=${chainInfo.chain} height=${currentHeight}`);
  console.log(`epochId=${EPOCH_ID.toString()}`);
  console.log(`collateralSats=${collateralSats.toString()}`);
  console.log(`maturityHeight=${maturityHeight}`);
  console.log(`refundLocktime=${refundLocktime}`);
  console.log(`artifactHash=${digest}`);
  console.log(`artifactPath=${outPath}`);
  console.log(`latestPath=${latestPath}`);
}

run().catch(err => {
  console.error('Bootstrap failed:', err.message);
  process.exit(1);
});
