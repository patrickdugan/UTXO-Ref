/**
 * Milestone 1 Demo: deposit -> receipt minted -> epoch root created
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_ltc_testnet_demo.js
 *
 * Optional Litecoin RPC env vars:
 *   LTC_RPC_URL=http://127.0.0.1:19332
 *   LTC_RPC_USER=rpcuser
 *   LTC_RPC_PASS=rpcpass
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const {
  buildTreeWithProofs,
  CommitmentPackage,
  templateHashHex,
  RECEIPT_DLC_TEMPLATE_V1,
  ReceiptLedger
} = require('./index');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function makeP2WPKH(label) {
  const hash = Buffer.alloc(20);
  Buffer.from(label).copy(hash);
  return Buffer.concat([Buffer.from([0x00, 0x14]), hash]);
}

function buildMockTxRef(depositId) {
  return {
    txid: sha256Hex(`mock:${depositId}`),
    vout: 0,
    source: 'mock'
  };
}

function rpcConfigured() {
  return !!(process.env.LTC_RPC_URL && process.env.LTC_RPC_USER && process.env.LTC_RPC_PASS);
}

function rpcRequest(method, params = []) {
  return new Promise((resolve, reject) => {
    if (!rpcConfigured()) {
      reject(new Error('LTC RPC env vars are missing'));
      return;
    }

    const endpoint = new URL(process.env.LTC_RPC_URL);
    const isHttps = endpoint.protocol === 'https:';
    const transport = isHttps ? https : http;

    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: `m1-${Date.now()}`,
      method,
      params
    });

    const options = {
      hostname: endpoint.hostname,
      port: endpoint.port || (isHttps ? 443 : 80),
      path: endpoint.pathname || '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Basic ${Buffer.from(
          `${process.env.LTC_RPC_USER}:${process.env.LTC_RPC_PASS}`
        ).toString('base64')}`
      }
    };

    const req = transport.request(options, res => {
      const chunks = [];

      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;

        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          reject(new Error(`Invalid RPC response: ${raw.slice(0, 200)}`));
          return;
        }

        if (parsed.error) {
          reject(new Error(`RPC error (${method}): ${parsed.error.message}`));
          return;
        }

        resolve(parsed.result);
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function maybeProbeLitecoinTestnet() {
  if (!rpcConfigured()) {
    return {
      mode: 'mock',
      detail: 'No LTC RPC configured; using mocked deposit txrefs'
    };
  }

  const chainInfo = await rpcRequest('getblockchaininfo');
  return {
    mode: 'rpc',
    chain: chainInfo.chain,
    blocks: chainInfo.blocks
  };
}

async function run() {
  console.log('=== Milestone 1 Demo (Litecoin Testnet Friendly) ===\n');

  const templateHash = templateHashHex(RECEIPT_DLC_TEMPLATE_V1);
  console.log('1) DLC template locked');
  console.log(`   templateId: ${RECEIPT_DLC_TEMPLATE_V1.templateId}`);
  console.log(`   templateHash: ${templateHash.slice(0, 24)}...`);
  console.log('');

  const chainProbe = await maybeProbeLitecoinTestnet();
  console.log('2) Chain mode');
  if (chainProbe.mode === 'rpc') {
    console.log(`   rpc: connected`);
    console.log(`   chain: ${chainProbe.chain}`);
    console.log(`   height: ${chainProbe.blocks}`);
  } else {
    console.log(`   rpc: not configured`);
    console.log(`   fallback: ${chainProbe.detail}`);
  }
  console.log('');

  const ledger = new ReceiptLedger();
  const deposits = [
    { depositId: 'dep-0001', accountId: 'alice', amountSats: 150000n },
    { depositId: 'dep-0002', accountId: 'bob', amountSats: 90000n }
  ];

  console.log('3) Deposits -> receipt minting');
  for (const dep of deposits) {
    const txRef = chainProbe.mode === 'rpc'
      ? { source: 'rpc-observed', note: 'wire your funding tx ref here' }
      : buildMockTxRef(dep.depositId);

    const out = ledger.applyDeposit({
      ...dep,
      chainTxRef: txRef
    });

    console.log(
      `   ${dep.depositId}: minted=${out.mintedSats} account=${out.accountId} balance=${out.balanceSats}`
    );
  }
  console.log(`   totalSupplySats=${ledger.totalSupplySats()}`);
  console.log(`   ledgerSnapshotHash=${ledger.snapshotHashHex().slice(0, 24)}...`);
  console.log('');

  const epochId = 1n;
  const leaves = ledger.createEpochPayoutLeaves(epochId, {
    alice: makeP2WPKH('alice'),
    bob: makeP2WPKH('bob'),
    treasury: makeP2WPKH('treasury')
  });

  const { root, proofs } = buildTreeWithProofs(leaves);
  const capSats = ledger.totalSupplySats();
  const residualDest = makeP2WPKH('treasury');

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats,
    residualDest
  });

  console.log('4) Epoch commitment generated');
  console.log(`   epochId=${epochId}`);
  console.log(`   leaves=${leaves.length}`);
  console.log(`   withdrawalRoot=${root.toString('hex')}`);
  console.log(`   proofs=${proofs.length}`);
  console.log(`   commitmentHash=${commitment.hash().toString('hex')}`);
  console.log('');

  console.log('Result: deposit -> receipt minted -> epoch root created');
  console.log('\n=== Demo Complete ===');
}

run().catch(err => {
  console.error('Demo failed:', err.message);
  process.exit(1);
});

