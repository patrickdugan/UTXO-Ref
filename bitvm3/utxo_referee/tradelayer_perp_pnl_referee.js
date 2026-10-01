const {
  CommitmentPackage,
  PayoutLeaf
} = require('./types');
const {
  buildTreeWithProofs
} = require('./merkle');
const {
  sha256Hex,
  addressToScriptPubKey
} = require('./tradelayer_pnl_route_adapter');

function toInt(value, fieldName) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${fieldName} must be an integer`);
}

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

function buildTradeLayerPerpPnlSettlement(input = {}) {
  const position = input.position || {};
  const close = input.close || {};
  const side = String(position.side || 'long').toLowerCase();
  if (side !== 'long' && side !== 'short') throw new Error('position.side must be long or short');

  const entryPrice = toInt(position.entryPrice, 'position.entryPrice');
  const closePrice = toInt(close.price ?? close.closePrice, 'close.price');
  const quantityUnits = toInt(position.quantityUnits || 1, 'position.quantityUnits');
  const priceScale = toInt(input.priceScale || position.priceScale || 1, 'priceScale');
  if (priceScale <= 0n) throw new Error('priceScale must be positive');
  const collateralSats = toInt(position.collateralSats || input.collateralSats, 'position.collateralSats');
  if (collateralSats <= 0n) throw new Error('position.collateralSats must be positive');

  const direction = side === 'long' ? 1n : -1n;
  const rawPnlSats = ((closePrice - entryPrice) * quantityUnits * direction) / priceScale;
  const transferSats = boundedAbs(rawPnlSats, collateralSats);
  const traderAddress = position.traderAddress || input.traderAddress;
  const counterpartyAddress = position.counterpartyAddress || input.counterpartyAddress;
  if (!traderAddress || !counterpartyAddress) throw new Error('position requires traderAddress and counterpartyAddress');
  const winnerAddress = rawPnlSats >= 0n ? traderAddress : counterpartyAddress;
  const loserAddress = rawPnlSats >= 0n ? counterpartyAddress : traderAddress;
  const refundSats = collateralSats - transferSats;
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
    network: input.network || 'litecoin-testnet',
    epochId: input.epochId
  });
  const settlementCore = {
    kind: 'tradelayer_perp_pnl_settlement_v1',
    network: input.network || 'litecoin-testnet',
    epochId: String(input.epochId ?? 0),
    contractId: String(position.contractId || 'perp-demo'),
    positionHash: sha256Hex(position),
    closeHash: sha256Hex(close),
    markSourceHash: sha256Hex(close.mark || close.vwap || close.oracle || {}),
    side,
    entryPrice: entryPrice.toString(),
    closePrice: closePrice.toString(),
    quantityUnits: quantityUnits.toString(),
    priceScale: priceScale.toString(),
    rawPnlSats: rawPnlSats.toString(),
    transferSats: transferSats.toString(),
    tokenDelta: {
      winnerAddress,
      loserAddress,
      quoteUnits: transferSats.toString(),
      traderDeltaSats: rawPnlSats.toString()
    },
    outputs,
    withdrawalRootHex: payout.withdrawalRootHex,
    commitmentHashHex: payout.commitmentHashHex
  };

  return {
    kind: 'tradelayer_perp_pnl_settlement',
    settlementHash: sha256Hex(settlementCore),
    settlementCore,
    payout
  };
}

function verifyTradeLayerPerpPnlSettlement(settlement) {
  if (!settlement || settlement.kind !== 'tradelayer_perp_pnl_settlement') {
    return { ok: false, reason: 'wrong settlement kind' };
  }
  if (!settlement.settlementCore || typeof settlement.settlementCore !== 'object') {
    return { ok: false, reason: 'settlement core missing' };
  }
  const settlementHash = sha256Hex(settlement.settlementCore);
  if (settlement.settlementHash !== settlementHash) return { ok: false, reason: 'settlement hash mismatch', settlementHash };
  const outputTotal = (settlement.settlementCore.outputs || []).reduce((sum, output) => sum + BigInt(output.sats), 0n);
  const transferSats = BigInt(settlement.settlementCore.transferSats);
  if (transferSats < 0n) return { ok: false, reason: 'transfer sats cannot be negative' };
  if (outputTotal.toString() !== settlement.payout.totalSats) return { ok: false, reason: 'payout total mismatch' };
  if (settlement.payout.withdrawalRootHex !== settlement.settlementCore.withdrawalRootHex) {
    return { ok: false, reason: 'withdrawal root mismatch' };
  }
  return {
    ok: true,
    settlementHash,
    transferSats: settlement.settlementCore.transferSats,
    winnerAddress: settlement.settlementCore.tokenDelta.winnerAddress
  };
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
    expected: {
      transferSats: settlement.settlementCore.transferSats,
      winnerAddress: settlement.settlementCore.tokenDelta.winnerAddress,
      withdrawalRootHex: settlement.settlementCore.withdrawalRootHex
    },
    claimed
  };
  return {
    kind: 'tradelayer_perp_pnl_challenge',
    challengeType,
    challengeHash: sha256Hex(core),
    challengeable: true,
    core
  };
}

function verifyTradeLayerPerpPnlChallenge(challenge, settlement) {
  if (!challenge || challenge.kind !== 'tradelayer_perp_pnl_challenge') {
    return { ok: false, reason: 'wrong challenge kind' };
  }
  if (settlement && challenge.core?.settlementHash !== settlement.settlementHash) {
    return { ok: false, reason: 'settlement hash mismatch' };
  }
  const challengeHash = sha256Hex(challenge.core);
  if (challenge.challengeHash !== challengeHash) return { ok: false, reason: 'challenge hash mismatch', challengeHash };
  return { ok: true, challengeHash, challengeable: challenge.challengeable };
}

module.exports = {
  buildTradeLayerPerpPnlSettlement,
  verifyTradeLayerPerpPnlSettlement,
  buildTradeLayerPerpPnlChallenge,
  verifyTradeLayerPerpPnlChallenge
};
