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
 *   BITVM_CHAIN=litecoin-mainnet|litecoin-testnet|bitcoin-mainnet|bitcoin-testnet
 *   BITVM_RPC_URL=http://127.0.0.1:9332
 *   BITVM_RPC_USER=user
 *   BITVM_RPC_PASS=pass
 *   BITVM_WALLET=tl-wallet
 *   DLC_DRAFT_PATH=bitvm3/utxo_referee/artifacts/m1_dlc_draft_latest.json
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const { computeBoundedSettlementAmounts } = require('./m1_transition');
const { withCommittedRouting, assertCommittedRouting } = require('./m1_routing_commitments');
const { resolveChainEnv } = require('./m1_chain_env');
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
    paths: outcomes.map(outcome => withCommittedRouting({
      pathId: outcome.bucketPct === 0 ? 'flat' : (outcome.bucketPct === 100 ? 'pnl' : `bucket-${outcome.bucketPct}`),
      kind: 'settlement',
      recipientRole: outcome.bucketPct === 0 ? 'alice' : 'bob',
      winnerRole: outcome.bucketPct === 0 ? 'alice' : 'bob',
      winnerAddress: outcome.bucketPct === 0 ? draft.roleSet.addresses.alice : draft.roleSet.addresses.bob,
      refundRole: 'residual',
      refundAddress: draft.roleSet.addresses.residual,
      feeRole: 'operator',
      feeAddress: draft.roleSet.addresses.operator,
      dustRole: outcome.bucketPct === 0 ? 'alice' : 'bob',
      dustAddress: outcome.bucketPct === 0 ? draft.roleSet.addresses.alice : draft.roleSet.addresses.bob,
      payoutSats: outcome.depositorAmountSats || outcome.payoutSats || '0',
      residualSats: outcome.poolAmountSats || outcome.residualSats || '0',
      dustCarrySats: '0',
      defaultOnExpiry: false
    })),
    roll: withCommittedRouting({
      pathId: 'roll',
      kind: 'timeout',
      defaultOnExpiry: true,
      winnerRole: 'residual',
      winnerAddress: draft.roleSet.addresses.residual,
      refundRole: 'residual',
      refundAddress: draft.roleSet.addresses.residual,
      feeRole: 'operator',
      feeAddress: draft.roleSet.addresses.operator,
      dustRole: 'alice',
      dustAddress: draft.roleSet.addresses.alice,
      rollLocktime: Number(draft.contract.refundLocktime || 0),
      rolloverCollateralSats: draft.contract.collateralSats || '0',
      dustCarrySats: draft.contract.dustCarrySats || '0'
    }),
    dustCarrySats: draft.contract.dustCarrySats || '0'
  };
}

function normalizeBoundedSettlement(settlementDraft, collateralSats, rollLocktime, addresses = {}) {
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
  const timeoutRemainderSats = computed.collateralSats - computed.rolloverCollateralSats - computed.dustCarrySats;

  return {
    model: 'bounded-loss-carry-forward',
    bucketCapBps: computed.bucketCapBps,
    realizedPnlBps: computed.realizedPnlBps,
    effectivePnlBps: computed.effectivePnlBps,
    feeBps: computed.feeBps,
    paths: [
      withCommittedRouting({
        pathId: 'settle-gain',
        kind: 'settlement',
        recipientRole: 'alice',
        winnerRole: 'alice',
        winnerAddress: addresses.alice || null,
        refundRole: 'residual',
        refundAddress: addresses.residual || null,
        feeRole: 'operator',
        feeAddress: addresses.operator || null,
        dustRole: 'alice',
        dustAddress: addresses.alice || null,
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
      }),
      withCommittedRouting({
        pathId: 'settle-loss',
        kind: 'settlement',
        recipientRole: 'bob',
        winnerRole: 'bob',
        winnerAddress: addresses.bob || null,
        refundRole: 'residual',
        refundAddress: addresses.residual || null,
        feeRole: 'operator',
        feeAddress: addresses.operator || null,
        dustRole: 'bob',
        dustAddress: addresses.bob || null,
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
      })
    ],
    roll: withCommittedRouting({
      pathId: 'roll',
      kind: 'timeout',
      defaultOnExpiry: true,
      winnerRole: 'residual',
      winnerAddress: addresses.residual || null,
      refundRole: 'residual',
      refundAddress: addresses.residual || null,
      feeRole: 'operator',
      feeAddress: addresses.operator || null,
      dustRole: 'alice',
      dustAddress: addresses.alice || null,
      rollLocktime,
      timeoutRemainderSats: timeoutRemainderSats.toString(),
      rolloverCollateralSats: computed.rolloverCollateralSats.toString(),
      residualSats: computed.rolloverCollateralSats.toString(),
      dustCarrySats: computed.dustCarrySats.toString()
    }),
    dustCarrySats: computed.dustCarrySats.toString()
  };
}

function outputAddress(vout) {
  const addrs = (vout.scriptPubKey && vout.scriptPubKey.addresses) || [];
  return addrs[0] || null;
}

function addOutputAmount(outputs, address, amountSats) {
  const amount = BigInt(amountSats);
  if (!address || amount <= 0n) {
    return;
  }

  const current = outputs[address] ? ltcToSatsBigInt(outputs[address]) : 0n;
  outputs[address] = satsToLtcDecimalString(current + amount);
}

async function createFundingPsbt(rpc, wallet, draft) {
  const aliceAddr = draft.roleSet.addresses.alice;
  const bobAddr = draft.roleSet.addresses.bob;
  const residualAddr = draft.roleSet.addresses.residual;

  const aliceInfo = await rpc('getaddressinfo', [aliceAddr], wallet);
  const bobInfo = await rpc('getaddressinfo', [bobAddr], wallet);

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
    wallet
  );

  const decodedPsbt = await rpc('decodepsbt', [funded.psbt], wallet);
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
    ? normalizeBoundedSettlement(settlementDraft, collateralSats, refundLocktime, draft.roleSet.addresses)
    : settlementDraft;

  const aliceAddress = draft.roleSet.addresses.alice;
  const residualAddress = draft.roleSet.addresses.residual;
  const bobAddress = draft.roleSet.addresses.bob;
  const operatorAddress = draft.roleSet.addresses.operator;

  const settlementPaths = [];
  for (const path of settlement.paths) {
    const committedRouting = assertCommittedRouting(path, `settlement path ${path.pathId}`);
    const outputs = {};
    const payoutSats = BigInt(path.payoutSats);
    const residualSats = BigInt(path.residualSats || '0');
    const feeSats = BigInt(path.feeSats || '0');
    const dustCarrySats = BigInt(path.dustCarrySats || '0');
    const recipientAddress = path.recipientRole === 'bob' ? bobAddress : aliceAddress;
    addOutputAmount(outputs, committedRouting.winnerAddress || recipientAddress, payoutSats);
    addOutputAmount(outputs, committedRouting.feeAddress || operatorAddress, feeSats);
    addOutputAmount(outputs, committedRouting.refundAddress || residualAddress, residualSats);
    addOutputAmount(outputs, committedRouting.dustAddress || recipientAddress, dustCarrySats);

    const rawHex = await rpc(
      'createrawtransaction',
      [[{ txid: fundingTxid, vout: fundingVout, sequence: 0xfffffffe }], outputs, maturityHeight]
    );
    const decoded = await rpc('decoderawtransaction', [rawHex]);

    settlementPaths.push(withCommittedRouting({
      pathId: path.pathId,
      kind: path.kind,
      recipientRole: path.recipientRole || null,
      winnerRole: committedRouting.winnerRole || path.recipientRole || null,
      winnerAddress: committedRouting.winnerAddress,
      refundRole: committedRouting.refundRole || 'residual',
      refundAddress: committedRouting.refundAddress,
      feeRole: committedRouting.feeRole || 'operator',
      feeAddress: committedRouting.feeAddress,
      dustRole: committedRouting.dustRole || path.recipientRole || null,
      dustAddress: committedRouting.dustAddress,
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
    }));
  }

  const rollLocktime = Number(settlement.roll && settlement.roll.rollLocktime ? settlement.roll.rollLocktime : refundLocktime);
  const rollDustCarrySats = BigInt(settlement.roll && settlement.roll.dustCarrySats ? settlement.roll.dustCarrySats : settlement.dustCarrySats || '0');
  const rolloverCollateralSats = BigInt(settlement.roll && settlement.roll.rolloverCollateralSats ? settlement.roll.rolloverCollateralSats : collateralSats - rollDustCarrySats);

  const timeoutRemainderSats = BigInt(
    settlement.roll && settlement.roll.timeoutRemainderSats ? settlement.roll.timeoutRemainderSats : '0'
  );
  const rollFeeSats = BigInt(settlement.roll && settlement.roll.feeSats ? settlement.roll.feeSats : '0');
  const rollOutputs = {};
  const rollCommittedRouting = assertCommittedRouting(settlement.roll, 'roll path');

  addOutputAmount(rollOutputs, rollCommittedRouting.winnerAddress || residualAddress, rolloverCollateralSats);
  addOutputAmount(rollOutputs, rollCommittedRouting.refundAddress || residualAddress, timeoutRemainderSats);
  addOutputAmount(rollOutputs, rollCommittedRouting.feeAddress || operatorAddress, rollFeeSats);
  addOutputAmount(rollOutputs, rollCommittedRouting.dustAddress || aliceAddress, rollDustCarrySats);

  const rollRaw = await rpc(
    'createrawtransaction',
    [[{ txid: fundingTxid, vout: fundingVout, sequence: 0xfffffffe }], rollOutputs, rollLocktime]
  );
  const rollDecoded = await rpc('decoderawtransaction', [rollRaw]);

  return {
    maturityHeight,
    refundLocktime,
    settlementPaths,
    rollSkeleton: withCommittedRouting({
      locktime: rollLocktime,
      input: { txid: fundingTxid, vout: fundingVout },
      payouts: {
        residualAddress,
        winnerAddress: rollCommittedRouting.winnerAddress,
        refundAddress: rollCommittedRouting.refundAddress,
        feeAddress: rollCommittedRouting.feeAddress,
        dustAddress: rollCommittedRouting.dustAddress,
        timeoutRemainderSats: settlement.roll && settlement.roll.timeoutRemainderSats ? settlement.roll.timeoutRemainderSats : '0',
        rolloverCollateralSats: rolloverCollateralSats.toString(),
        dustCarrySats: rollDustCarrySats.toString()
      },
      winnerRole: rollCommittedRouting.winnerRole || 'residual',
      winnerAddress: rollCommittedRouting.winnerAddress,
      refundRole: rollCommittedRouting.refundRole || 'residual',
      refundAddress: rollCommittedRouting.refundAddress,
      feeRole: rollCommittedRouting.feeRole || 'operator',
      feeAddress: rollCommittedRouting.feeAddress,
      dustRole: rollCommittedRouting.dustRole || 'alice',
      dustAddress: rollCommittedRouting.dustAddress,
      rawTxHex: rollRaw,
      txid: rollDecoded.txid
    }),
    settlement
  };
}

function writeArtifact(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

async function run() {
  ensureFile(DRAFT_PATH);
  const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
  const chainEnv = resolveChainEnv();
  const rpc = rpcFactory({
    rpcUrl: chainEnv.rpcUrl,
    rpcUser: chainEnv.rpcUser,
    rpcPass: chainEnv.rpcPass
  });

  const chainInfo = await rpc('getblockchaininfo');
  const draftDigest = sha256Hex(JSON.stringify(draft));
  const funding = await createFundingPsbt(rpc, chainEnv.wallet, draft);
  const cets = await buildCetSkeletons(rpc, draft, funding);

  const artifactsDir = path.join(__dirname, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const fundingArtifact = {
    kind: 'm1_funding_psbt',
    createdAt: new Date().toISOString(),
    chain: {
      chainId: chainEnv.chainId,
      network: chainInfo.chain,
      rpcUrl: chainEnv.rpcUrl
    },
    wallet: chainEnv.wallet,
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
      chainId: chainEnv.chainId,
      network: chainInfo.chain,
      rpcUrl: chainEnv.rpcUrl
    },
    wallet: chainEnv.wallet,
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
  console.log(`chainId=${chainEnv.chainId}`);
  console.log(`rpcNetwork=${chainInfo.chain}`);
  console.log(`wallet=${chainEnv.wallet}`);
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
