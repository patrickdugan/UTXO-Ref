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
const { computeBoundedSettlementAmounts } = require('./m1_transition');

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

function readSettlementDraft(draft) {
  const settlement = draft.contract && draft.contract.settlement;
  if (settlement && Array.isArray(settlement.paths)) {
    return settlement;
  }

  const outcomes = draft.contract && Array.isArray(draft.contract.outcomes)
    ? draft.contract.outcomes
    : [];
  if (outcomes.length === 0) {
    throw new Error('Draft artifact does not include settlement paths');
  }

  return {
    model: 'legacy-bucket-fallback',
    paths: outcomes.map(outcome => ({
      pathId: outcome.bucketPct === 0 ? 'flat' : (outcome.bucketPct === 100 ? 'pnl' : `bucket-${outcome.bucketPct}`),
      kind: 'settlement',
      recipientRole: outcome.bucketPct === 0 ? 'alice' : 'bob',
      payoutSats: outcome.depositorAmountSats || outcome.payoutSats || '0',
      residualSats: outcome.poolAmountSats || outcome.residualSats || '0',
      dustCarrySats: '0',
      defaultOnExpiry: false
    })),
    roll: {
      pathId: 'roll',
      kind: 'timeout',
      defaultOnExpiry: true,
      rollLocktime: Number(draft.contract.refundLocktime || 0),
      rolloverCollateralSats: draft.contract.collateralSats || '0',
      dustCarrySats: draft.contract.dustCarrySats || '0'
    },
    dustCarrySats: draft.contract.dustCarrySats || '0'
  };
}

function normalizeBoundedSettlement(settlementDraft, collateralSats, rollLocktime) {
  const bucketCapBps = Number(settlementDraft.bucketCapBps || settlementDraft.payoutRatioBps || 500);
  const realizedPnlBps = Number(settlementDraft.realizedPnlBps || bucketCapBps);
  const feeBps = Number(settlementDraft.feeBps || 0);
  if (!Number.isInteger(bucketCapBps) || bucketCapBps < 0 || bucketCapBps > 10000) {
    throw new Error('Invalid settlement bucketCapBps');
  }
  if (!Number.isInteger(realizedPnlBps) || realizedPnlBps < 0 || realizedPnlBps > 10000) {
    throw new Error('Invalid settlement realizedPnlBps');
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw new Error('Invalid settlement feeBps');
  }

  const computed = computeBoundedSettlementAmounts(collateralSats, bucketCapBps, realizedPnlBps, feeBps);

  return {
    model: 'bounded-loss-carry-forward',
    bucketCapBps: computed.bucketCapBps,
    realizedPnlBps: computed.realizedPnlBps,
    effectivePnlBps: computed.effectivePnlBps,
    feeBps: computed.feeBps,
    paths: [
      {
        pathId: 'settle-gain',
        kind: 'settlement',
        recipientRole: 'alice',
        bucketCapBps: computed.bucketCapBps,
        realizedPnlBps: computed.realizedPnlBps,
        effectivePnlBps: computed.effectivePnlBps,
        feeBps: computed.feeBps,
        actualPayoutSats: computed.actualPayoutSats.toString(),
        payoutSats: computed.actualPayoutSats.toString(),
        feeSats: computed.feeSats.toString(),
        refundSats: computed.refundSats.toString(),
        rolloverCollateralSats: computed.rolloverCollateralSats.toString(),
        residualSats: computed.refundSats.toString(),
        dustCarrySats: computed.dustCarrySats.toString(),
        defaultOnExpiry: false
      },
      {
        pathId: 'settle-loss',
        kind: 'settlement',
        recipientRole: 'bob',
        bucketCapBps: computed.bucketCapBps,
        realizedPnlBps: computed.realizedPnlBps,
        effectivePnlBps: computed.effectivePnlBps,
        feeBps: computed.feeBps,
        actualPayoutSats: computed.actualPayoutSats.toString(),
        payoutSats: computed.actualPayoutSats.toString(),
        feeSats: computed.feeSats.toString(),
        refundSats: computed.refundSats.toString(),
        rolloverCollateralSats: computed.rolloverCollateralSats.toString(),
        residualSats: computed.refundSats.toString(),
        dustCarrySats: computed.dustCarrySats.toString(),
        defaultOnExpiry: false
      }
    ],
    roll: {
      pathId: 'roll',
      kind: 'timeout',
      defaultOnExpiry: true,
      rollLocktime,
      rolloverCollateralSats: computed.rolloverCollateralSats.toString(),
      residualSats: computed.rolloverCollateralSats.toString(),
      dustCarrySats: computed.dustCarrySats.toString()
    },
    dustCarrySats: computed.dustCarrySats.toString()
  };
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
  const settlementDraft = readSettlementDraft(draft);
  const settlement = settlementDraft.model === 'bounded-loss-carry-forward' || settlementDraft.model === 'binary-settlement'
    ? normalizeBoundedSettlement(settlementDraft, collateralSats, refundLocktime)
    : settlementDraft;

  const aliceAddress = draft.roleSet.addresses.alice;
  const residualAddress = draft.roleSet.addresses.residual;
  const bobAddress = draft.roleSet.addresses.bob;
  const operatorAddress = draft.roleSet.addresses.operator;

  const settlementPaths = [];
  for (const path of settlement.paths) {
    const outputs = {};
    const payoutSats = BigInt(path.payoutSats);
    const residualSats = BigInt(path.residualSats || '0');
    const feeSats = BigInt(path.feeSats || '0');
    const dustCarrySats = BigInt(path.dustCarrySats || '0');
    const recipientAddress = path.recipientRole === 'bob' ? bobAddress : aliceAddress;
    outputs[recipientAddress] = satsToLtcDecimalString(payoutSats);
    if (feeSats > 0n) {
      outputs[operatorAddress] = satsToLtcDecimalString(feeSats);
    }
    if (residualSats > 0n) {
      outputs[residualAddress] = satsToLtcDecimalString(residualSats);
    }

    const rawHex = await rpc(
      'createrawtransaction',
      [[{ txid: fundingTxid, vout: fundingVout, sequence: 0xfffffffe }], outputs, maturityHeight]
    );
    const decoded = await rpc('decoderawtransaction', [rawHex]);

    settlementPaths.push({
      pathId: path.pathId,
      kind: path.kind,
      recipientRole: path.recipientRole || null,
      locktime: maturityHeight,
      input: { txid: fundingTxid, vout: fundingVout },
      bucketCapBps: path.bucketCapBps ?? null,
      realizedPnlBps: path.realizedPnlBps ?? null,
      effectivePnlBps: path.effectivePnlBps ?? null,
      feeBps: path.feeBps ?? null,
      actualPayoutSats: path.actualPayoutSats || payoutSats.toString(),
      payoutSats: payoutSats.toString(),
      feeSats: feeSats.toString(),
      refundSats: path.refundSats || residualSats.toString(),
      rolloverCollateralSats: path.rolloverCollateralSats || residualSats.toString(),
      residualSats: residualSats.toString(),
      dustCarrySats: dustCarrySats.toString(),
      defaultOnExpiry: !!path.defaultOnExpiry,
      rawTxHex: rawHex,
      txid: decoded.txid
    });
  }

  const rollLocktime = Number(settlement.roll && settlement.roll.rollLocktime ? settlement.roll.rollLocktime : refundLocktime);
  const rollDustCarrySats = BigInt(settlement.roll && settlement.roll.dustCarrySats ? settlement.roll.dustCarrySats : settlement.dustCarrySats || '0');
  const rolloverCollateralSats = BigInt(settlement.roll && settlement.roll.rolloverCollateralSats ? settlement.roll.rolloverCollateralSats : collateralSats - rollDustCarrySats);

  const rollOutputs = {};
  if (rolloverCollateralSats > 0n) {
    rollOutputs[residualAddress] = satsToLtcDecimalString(rolloverCollateralSats);
  }
  if (rollDustCarrySats > 0n) {
    rollOutputs[aliceAddress] = satsToLtcDecimalString(rollDustCarrySats);
  }

  const rollRaw = await rpc(
    'createrawtransaction',
    [[{ txid: fundingTxid, vout: fundingVout, sequence: 0xfffffffe }], rollOutputs, rollLocktime]
  );
  const rollDecoded = await rpc('decoderawtransaction', [rollRaw]);

  return {
    maturityHeight,
    refundLocktime,
    settlementPaths,
    rollSkeleton: {
      locktime: rollLocktime,
      input: { txid: fundingTxid, vout: fundingVout },
      payouts: {
        residualAddress,
        rolloverCollateralSats: rolloverCollateralSats.toString(),
        dustCarrySats: rollDustCarrySats.toString()
      },
      rawTxHex: rollRaw,
      txid: rollDecoded.txid
    },
    settlement
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
      refundLocktime: draft.contract.refundLocktime,
      dustCarrySats: draft.contract.dustCarrySats
    },
    settlement: {
      model: cets.settlement.model,
      paths: cets.settlementPaths,
      roll: cets.rollSkeleton,
      dustCarrySats: cets.settlement.dustCarrySats
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
    maturityHeight: cets.maturityHeight,
    refundLocktime: cets.refundLocktime,
    fundingOutpoint: funding.fundingOutpoint,
    settlement: {
      model: cets.settlement.model,
      paths: cets.settlementPaths,
      roll: cets.rollSkeleton,
      dustCarrySats: cets.settlement.dustCarrySats
    }
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
  console.log(`settlementPaths=${cets.settlementPaths.length}`);
  console.log(`dustCarrySats=${cets.settlement.dustCarrySats}`);
  console.log(`fundingArtifact=${fundingPath}`);
  console.log(`cetArtifact=${cetPath}`);
}

run().catch(err => {
  console.error('Generation failed:', err.message);
  process.exit(1);
});
