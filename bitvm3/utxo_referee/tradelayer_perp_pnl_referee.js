const {
  CommitmentPackage,
  PayoutLeaf
} = require('./types');
const {
  buildTreeWithProofs
} = require('./merkle');
const {
  stableStringify,
  sha256Hex,
  addressToScriptPubKey
} = require('./tradelayer_pnl_route_adapter');
const { toInt } = require('./money');
const { verifyChallengeVerdict } = require('./challenge_verdict');

function boundedAbs(value, cap) {
  const abs = value < 0n ? -value : value;
  return abs > cap ? cap : abs;
}

function buildPayoutCommitment(outputs, options = {}) {
  const network = options.network || 'litecoin-testnet';
  const epochId = BigInt(options.epochId ?? 0);
  const leaves = outputs.map((output) => new PayoutLeaf({
    epochId,
    recipientScriptPubKey: addressToScriptPubKey(output.address, network),
    amountSats: BigInt(output.sats)
  }));
  const { root, proofs } = buildTreeWithProofs(leaves);
  const totalSats = outputs.reduce((sum, output) => sum + BigInt(output.sats), 0n);
  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats: totalSats,
    residualDest: Buffer.from('6a', 'hex')
  });
  return {
    withdrawalRootHex: root.toString('hex'),
    commitmentHashHex: commitment.hash().toString('hex'),
    totalSats: totalSats.toString(),
    proofs
  };
}

// The only place that turns position terms into outputs. Build and verify both use it,
// so a settlement is valid only if its outputs are the function of its committed terms.
function derivePerpSettlement(terms) {
  const side = String(terms.side || '').toLowerCase();
  if (side !== 'long' && side !== 'short') throw new Error('position.side must be long or short');
  if (terms.quantityUnits <= 0n) throw new Error('position.quantityUnits must be positive');
  if (terms.priceScale <= 0n) throw new Error('priceScale must be positive');
  if (terms.collateralSats <= 0n) throw new Error('position.collateralSats must be positive');
  if (!terms.traderAddress || !terms.counterpartyAddress) throw new Error('position requires traderAddress and counterpartyAddress');

  const direction = side === 'long' ? 1n : -1n;
  const rawPnlSats = ((terms.closePrice - terms.entryPrice) * terms.quantityUnits * direction) / terms.priceScale;
  const transferSats = boundedAbs(rawPnlSats, terms.collateralSats);
  const winnerAddress = rawPnlSats >= 0n ? terms.traderAddress : terms.counterpartyAddress;
  const loserAddress = rawPnlSats >= 0n ? terms.counterpartyAddress : terms.traderAddress;
  const refundSats = terms.collateralSats - transferSats;
  const outputs = [
    {
      role: 'pnl-winner',
      address: winnerAddress,
      sats: transferSats.toString()
    }
  ];
  if (refundSats > 0n) {
    outputs.push({
      role: 'loss-side-refund',
      address: loserAddress,
      sats: refundSats.toString()
    });
  }
  const payout = buildPayoutCommitment(outputs, {
    network: terms.network,
    epochId: terms.epochId
  });
  return {
    rawPnlSats,
    transferSats,
    winnerAddress,
    loserAddress,
    outputs,
    payout
  };
}

function buildTradeLayerPerpPnlSettlement(input = {}) {
  const position = input.position || {};
  const close = input.close || {};
  const network = input.network || 'litecoin-testnet';
  const epochId = String(input.epochId ?? 0);
  const side = String(position.side || 'long').toLowerCase();
  const entryPrice = toInt(position.entryPrice, 'position.entryPrice', { signed: true });
  const closePrice = toInt(close.price ?? close.closePrice, 'close.price', { signed: true });
  const quantityUnits = toInt(position.quantityUnits ?? 1, 'position.quantityUnits', { signed: true });
  const priceScale = toInt(input.priceScale ?? position.priceScale ?? 1, 'priceScale', { signed: true });
  const collateralSats = toInt(position.collateralSats ?? input.collateralSats, 'position.collateralSats', { signed: true });
  const traderAddress = position.traderAddress || input.traderAddress;
  const counterpartyAddress = position.counterpartyAddress || input.counterpartyAddress;
  const derived = derivePerpSettlement({
    network,
    epochId,
    side,
    entryPrice,
    closePrice,
    quantityUnits,
    priceScale,
    collateralSats,
    traderAddress,
    counterpartyAddress
  });
  const settlementCore = {
    kind: 'tradelayer_perp_pnl_settlement_v1',
    network,
    epochId,
    contractId: String(position.contractId || 'perp-demo'),
    positionHash: sha256Hex(position),
    closeHash: sha256Hex(close),
    markSourceHash: sha256Hex(close.mark || close.vwap || close.oracle || {}),
    side,
    entryPrice: entryPrice.toString(),
    closePrice: closePrice.toString(),
    quantityUnits: quantityUnits.toString(),
    priceScale: priceScale.toString(),
    collateralSats: collateralSats.toString(),
    traderAddress,
    counterpartyAddress,
    rawPnlSats: derived.rawPnlSats.toString(),
    transferSats: derived.transferSats.toString(),
    tokenDelta: {
      winnerAddress: derived.winnerAddress,
      loserAddress: derived.loserAddress,
      quoteUnits: derived.transferSats.toString(),
      traderDeltaSats: derived.rawPnlSats.toString()
    },
    outputs: derived.outputs,
    withdrawalRootHex: derived.payout.withdrawalRootHex,
    commitmentHashHex: derived.payout.commitmentHashHex
  };

  return {
    kind: 'tradelayer_perp_pnl_settlement',
    settlementHash: sha256Hex(settlementCore),
    settlementCore,
    payout: derived.payout
  };
}

function verifyTradeLayerPerpPnlSettlement(settlement) {
  if (!settlement || settlement.kind !== 'tradelayer_perp_pnl_settlement') {
    return { ok: false, reason: 'wrong settlement kind' };
  }
  if (!settlement.settlementCore || typeof settlement.settlementCore !== 'object') {
    return { ok: false, reason: 'settlement core missing' };
  }
  const core = settlement.settlementCore;
  const settlementHash = sha256Hex(core);
  if (settlement.settlementHash !== settlementHash) return { ok: false, reason: 'settlement hash mismatch', settlementHash };

  let derived;
  try {
    derived = derivePerpSettlement({
      network: core.network,
      epochId: core.epochId,
      side: core.side,
      entryPrice: toInt(core.entryPrice, 'settlementCore.entryPrice', { signed: true }),
      closePrice: toInt(core.closePrice, 'settlementCore.closePrice', { signed: true }),
      quantityUnits: toInt(core.quantityUnits, 'settlementCore.quantityUnits', { signed: true }),
      priceScale: toInt(core.priceScale, 'settlementCore.priceScale', { signed: true }),
      collateralSats: toInt(core.collateralSats, 'settlementCore.collateralSats', { signed: true }),
      traderAddress: core.traderAddress,
      counterpartyAddress: core.counterpartyAddress
    });
  } catch (err) {
    return { ok: false, reason: `settlement terms do not derive: ${err.message}` };
  }
  const expected = {
    rawPnlSats: derived.rawPnlSats.toString(),
    transferSats: derived.transferSats.toString(),
    tokenDelta: {
      winnerAddress: derived.winnerAddress,
      loserAddress: derived.loserAddress,
      quoteUnits: derived.transferSats.toString(),
      traderDeltaSats: derived.rawPnlSats.toString()
    },
    outputs: derived.outputs,
    withdrawalRootHex: derived.payout.withdrawalRootHex,
    commitmentHashHex: derived.payout.commitmentHashHex
  };
  const mismatch = Object.keys(expected).find((field) => stableStringify(core[field]) !== stableStringify(expected[field]));
  if (mismatch) return { ok: false, reason: `${mismatch} does not follow from the settlement terms` };
  if (settlement.payout?.totalSats !== derived.payout.totalSats) return { ok: false, reason: 'payout total mismatch' };
  if (settlement.payout?.withdrawalRootHex !== derived.payout.withdrawalRootHex) {
    return { ok: false, reason: 'withdrawal root mismatch' };
  }
  return {
    ok: true,
    settlementHash,
    transferSats: core.transferSats,
    winnerAddress: core.tokenDelta.winnerAddress
  };
}

// The terms a claim is compared against, as the settlement states them.
function perpExpected(settlement) {
  return {
    transferSats: settlement.settlementCore.transferSats,
    winnerAddress: settlement.settlementCore.tokenDelta.winnerAddress,
    withdrawalRootHex: settlement.settlementCore.withdrawalRootHex
  };
}

// The claim is challengeable when it differs from what the settlement terms derive.
function perpChallengeable(core) {
  const claimed = core.claimed || {};
  const expected = core.expected || {};
  return core.challengeType === 'wrong_destination'
    ? claimed.winnerAddress !== expected.winnerAddress
    : claimed.transferSats !== expected.transferSats;
}

function buildTradeLayerPerpPnlChallenge(settlement, options = {}) {
  const result = verifyTradeLayerPerpPnlSettlement(settlement);
  if (!result.ok) throw new Error(`invalid settlement: ${result.reason}`);
  const challengeType = options.challengeType || 'wrong_pnl_transfer';
  const claimed = challengeType === 'wrong_destination'
    ? {
      winnerAddress: options.claimedWinnerAddress || `${settlement.settlementCore.tokenDelta.winnerAddress}:wrong`
    }
    : {
      transferSats: (BigInt(settlement.settlementCore.transferSats) + 1n).toString()
    };
  const core = {
    kind: 'tradelayer_perp_pnl_challenge_v1',
    challengeType,
    settlementHash: settlement.settlementHash,
    expected: perpExpected(settlement),
    claimed
  };
  return {
    kind: 'tradelayer_perp_pnl_challenge',
    challengeType,
    challengeHash: sha256Hex(core),
    challengeable: perpChallengeable(core),
    core
  };
}

function verifyTradeLayerPerpPnlChallenge(challenge, settlement) {
  if (!settlement) return { ok: false, reason: 'settlement required to judge a perp challenge' };
  const settled = verifyTradeLayerPerpPnlSettlement(settlement);
  if (!settled.ok) return { ok: false, reason: `invalid settlement: ${settled.reason}` };
  if (challenge?.core?.settlementHash !== settlement.settlementHash) {
    return { ok: false, reason: 'settlement hash mismatch' };
  }
  if (stableStringify(challenge.core.expected) !== stableStringify(perpExpected(settlement))) {
    return { ok: false, reason: 'expected terms do not follow from the settlement' };
  }
  return verifyChallengeVerdict(challenge, {
    kind: 'tradelayer_perp_pnl_challenge',
    coreKind: 'tradelayer_perp_pnl_challenge_v1',
    labelField: 'challengeType',
    verdict: perpChallengeable
  });
}

module.exports = {
  buildTradeLayerPerpPnlSettlement,
  verifyTradeLayerPerpPnlSettlement,
  buildTradeLayerPerpPnlChallenge,
  verifyTradeLayerPerpPnlChallenge
};
