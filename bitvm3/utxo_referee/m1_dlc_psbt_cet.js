/**
 * Milestone 1 - Funding PSBT + CET Skeleton Generator
 *
 * Consumes a draft artifact from m1_dlc_bootstrap and produces:
 * 1) A real funding PSBT (walletcreatefundedpsbt) for the selected inputs
 * 2) CET skeleton raw transactions for each outcome bucket
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_dlc_psbt_cet.js
 *
 * Optional env:
 *   LTC_RPC_URL=http://127.0.0.1:19332
 *   LTC_RPC_USER=user
 *   LTC_RPC_PASS=pass
 *   LTC_WALLET=tl-wallet
 *   DLC_DRAFT_PATH=bitvm3/utxo_referee/artifacts/m1_dlc_draft_latest.json
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
const DRAFT_PATH = process.env.DLC_DRAFT_PATH ||
  path.join(__dirname, 'artifacts', 'm1_dlc_draft_latest.json');

function satsToLtcDecimalString(sats) {
  const n = BigInt(sats);
  const whole = n / 100000000n;
  const frac = n % 100000000n;
  return `${whole.toString()}.${frac.toString().padStart(8, '0')}`;
}

function ltcToSatsBigInt(amount) {
  const s = String(amount);
  const [w, f = ''] = s.split('.');
  const frac = (f + '00000000').slice(0, 8);
  return BigInt(w) * 100000000n + BigInt(frac);
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
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
      id: 'm1-dlc-psbt-cet',
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

function ensureFile(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`Draft artifact not found: ${p}`);
  }
}

function outputAddress(vout) {
  const addrs = (vout.scriptPubKey && vout.scriptPubKey.addresses) || [];
  return addrs[0] || null;
}

async function createFundingPsbt(rpc, draft) {
  const aliceAddr = draft.roleSet.addresses.alice;
  const bobAddr = draft.roleSet.addresses.bob;
  const residualAddr = draft.roleSet.addresses.residual;

  const aliceInfo = await rpc('getaddressinfo', [aliceAddr], WALLET);
  const bobInfo = await rpc('getaddressinfo', [bobAddr], WALLET);

  if (!aliceInfo.pubkey || !bobInfo.pubkey) {
    throw new Error('Missing pubkey for alice or bob address');
  }

  const fundingScript = await rpc('createmultisig', [2, [aliceInfo.pubkey, bobInfo.pubkey], 'bech32']);
  const fundingAddress = fundingScript.address;

  const inputs = draft.contract.fundingInputs.map(i => ({
    txid: i.txid,
    vout: i.vout
  }));

  // Check that selected inputs are still unspent before building PSBT.
  for (const i of inputs) {
    const out = await rpc('gettxout', [i.txid, i.vout, true]);
    if (!out) {
      throw new Error(`Input already spent: ${i.txid}:${i.vout}`);
    }
  }

  const collateralSats = BigInt(draft.contract.collateralSats);
  const collateralLtc = satsToLtcDecimalString(collateralSats);
  const outputs = { [fundingAddress]: collateralLtc };

  const options = {
    add_inputs: false,
    subtractFeeFromOutputs: [0],
    includeWatching: true,
    lockUnspents: false,
    changeAddress: residualAddr
  };

  const funded = await rpc(
    'walletcreatefundedpsbt',
    [inputs, outputs, 0, options, true],
    WALLET
  );

  const decodedPsbt = await rpc('decodepsbt', [funded.psbt], WALLET);
  const decodedUnsigned = decodedPsbt.tx;
  const fundingVout = decodedUnsigned.vout.findIndex(v => outputAddress(v) === fundingAddress);
  if (fundingVout < 0) {
    throw new Error('Could not find funding output in unsigned tx');
  }

  const fundingOutput = decodedUnsigned.vout[fundingVout];
  const effectiveCollateralSats = ltcToSatsBigInt(fundingOutput.value);

  return {
    rolePubkeys: {
      alice: aliceInfo.pubkey,
      bob: bobInfo.pubkey
    },
    fundingAddress,
    fundingRedeemScript: fundingScript.redeemScript,
    fundingWitnessScript: fundingScript.witnessScript || null,
    selectedInputs: inputs,
    requestedCollateralSats: collateralSats.toString(),
    effectiveCollateralSats: effectiveCollateralSats.toString(),
    feeLtc: String(funded.fee),
    feeSats: ltcToSatsBigInt(funded.fee).toString(),
    psbt: funded.psbt,
    psbtDecodedSummary: {
      txid: decodedUnsigned.txid,
      hash: decodedUnsigned.hash,
      vsize: decodedUnsigned.vsize,
      locktime: decodedUnsigned.locktime
    },
    fundingOutpoint: {
      txid: decodedUnsigned.txid,
      vout: fundingVout,
      valueLtc: String(fundingOutput.value),
      valueSats: effectiveCollateralSats.toString()
    }
  };
}

async function buildCetSkeletons(rpc, draft, funding) {
  const fundingTxid = funding.fundingOutpoint.txid;
  const fundingVout = funding.fundingOutpoint.vout;
  const collateralSats = BigInt(funding.effectiveCollateralSats);
  const maturityHeight = Number(draft.contract.maturityHeight);
  const refundLocktime = Number(draft.contract.refundLocktime);

  const aliceAddress = draft.roleSet.addresses.alice;
  const residualAddress = draft.roleSet.addresses.residual;
  const bobAddress = draft.roleSet.addresses.bob;

  const cets = [];
  for (let bucket = 0; bucket <= 100; bucket += 5) {
    const poolSats = (collateralSats * BigInt(bucket)) / 100n;
    const depositorSats = collateralSats - poolSats;

    const outputs = {};
    if (depositorSats > 0n) {
      outputs[aliceAddress] = satsToLtcDecimalString(depositorSats);
    }
    if (poolSats > 0n) {
      outputs[residualAddress] = satsToLtcDecimalString(poolSats);
    }

    const rawHex = await rpc(
      'createrawtransaction',
      [[{ txid: fundingTxid, vout: fundingVout, sequence: 0xfffffffe }], outputs, maturityHeight]
    );
    const decoded = await rpc('decoderawtransaction', [rawHex]);

    cets.push({
      bucketPct: bucket,
      locktime: maturityHeight,
      input: { txid: fundingTxid, vout: fundingVout },
      payouts: {
        depositorAddress: aliceAddress,
        depositorAmountSats: depositorSats.toString(),
        poolAddress: residualAddress,
        poolAmountSats: poolSats.toString()
      },
      rawTxHex: rawHex,
      txid: decoded.txid
    });
  }

  // Refund skeleton: split collateral equally to alice and bob at refund locktime.
  const half = collateralSats / 2n;
  const remainder = collateralSats - half;
  const refundOutputs = {};
  refundOutputs[aliceAddress] = satsToLtcDecimalString(half);
  refundOutputs[bobAddress] = satsToLtcDecimalString(remainder);

  const refundRaw = await rpc(
    'createrawtransaction',
    [[{ txid: fundingTxid, vout: fundingVout, sequence: 0xfffffffe }], refundOutputs, refundLocktime]
  );
  const refundDecoded = await rpc('decoderawtransaction', [refundRaw]);

  return {
    maturityHeight,
    refundLocktime,
    cets,
    refundSkeleton: {
      locktime: refundLocktime,
      input: { txid: fundingTxid, vout: fundingVout },
      payouts: {
        aliceAddress,
        aliceAmountSats: half.toString(),
        bobAddress,
        bobAmountSats: remainder.toString()
      },
      rawTxHex: refundRaw,
      txid: refundDecoded.txid
    }
  };
}

function writeArtifact(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

async function run() {
  ensureFile(DRAFT_PATH);
  const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
  const rpc = rpcFactory({
    rpcUrl: RPC_URL,
    rpcUser: RPC_USER,
    rpcPass: RPC_PASS
  });

  const chainInfo = await rpc('getblockchaininfo');
  const draftDigest = sha256Hex(JSON.stringify(draft));
  const funding = await createFundingPsbt(rpc, draft);
  const cets = await buildCetSkeletons(rpc, draft, funding);

  const artifactsDir = path.join(__dirname, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const fundingArtifact = {
    kind: 'm1_funding_psbt',
    createdAt: new Date().toISOString(),
    chain: {
      network: chainInfo.chain,
      rpcUrl: RPC_URL
    },
    wallet: WALLET,
    sourceDraftPath: DRAFT_PATH,
    sourceDraftHash: draftDigest,
    template: draft.template,
    roleSet: draft.roleSet,
    contract: {
      epochId: draft.canonical.epochId,
      eventId: draft.contract.eventId,
      maturityHeight: draft.contract.maturityHeight,
      refundLocktime: draft.contract.refundLocktime
    },
    funding
  };

  const cetArtifact = {
    kind: 'm1_cet_skeletons',
    createdAt: new Date().toISOString(),
    chain: {
      network: chainInfo.chain,
      rpcUrl: RPC_URL
    },
    wallet: WALLET,
    sourceDraftPath: DRAFT_PATH,
    sourceDraftHash: draftDigest,
    fundingOutpoint: funding.fundingOutpoint,
    cets
  };

  const fundingPath = path.join(artifactsDir, 'm1_funding_psbt_latest.json');
  const cetPath = path.join(artifactsDir, 'm1_cet_skeletons_latest.json');
  writeArtifact(fundingPath, fundingArtifact);
  writeArtifact(cetPath, cetArtifact);

  console.log('=== M1 Funding PSBT + CET Skeletons ===');
  console.log(`chain=${chainInfo.chain}`);
  console.log(`wallet=${WALLET}`);
  console.log(`draftHash=${draftDigest}`);
  console.log(`fundingTxid=${funding.fundingOutpoint.txid}`);
  console.log(`fundingVout=${funding.fundingOutpoint.vout}`);
  console.log(`effectiveCollateralSats=${funding.fundingOutpoint.valueSats}`);
  console.log(`feeSats=${funding.feeSats}`);
  console.log(`cetsGenerated=${cets.cets.length}`);
  console.log(`fundingArtifact=${fundingPath}`);
  console.log(`cetArtifact=${cetPath}`);
}

run().catch(err => {
  console.error('Generation failed:', err.message);
  process.exit(1);
});
