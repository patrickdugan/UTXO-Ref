/**
 * Milestone 1 Witness Delta Helpers
 *
 * Builds non-canonical delta annotations that can be appended to the
 * witness blob without changing the committed tally hash.
 */

const crypto = require('crypto');

function toBigInt(value, fieldName) {
  try {
    return BigInt(value);
  } catch (err) {
    throw new Error(`${fieldName} must be convertible to BigInt`);
  }
}

function stringify(value) {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    2
  );
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function buildSettlementBreakdown({
  epochId,
  route,
  collateralSats,
  redeemedSats,
  pnlReferenceSats,
  realizedPnlSats,
  feeSats = 0n,
  refundSats = null,
  rolloverCollateralSats = null,
  dustCarrySats = 0n,
  winnerRecipient = null,
  refundRecipient = 'residual',
  note = null
}) {
  const collateral = toBigInt(collateralSats, 'collateralSats');
  const redeemed = toBigInt(redeemedSats, 'redeemedSats');
  const pnlReference = pnlReferenceSats !== undefined && pnlReferenceSats !== null
    ? toBigInt(pnlReferenceSats, 'pnlReferenceSats')
    : collateral;
  const realized = realizedPnlSats !== undefined && realizedPnlSats !== null
    ? toBigInt(realizedPnlSats, 'realizedPnlSats')
    : redeemed - pnlReference;
  const fee = toBigInt(feeSats, 'feeSats');
  const refund = refundSats !== null && refundSats !== undefined
    ? toBigInt(refundSats, 'refundSats')
    : collateral - redeemed - fee;
  const rollover = rolloverCollateralSats !== null && rolloverCollateralSats !== undefined
    ? toBigInt(rolloverCollateralSats, 'rolloverCollateralSats')
    : refund;
  const dust = toBigInt(dustCarrySats, 'dustCarrySats');
  const winnerPnlSats = realized > 0n ? realized : 0n;
  const loserPnlSats = realized < 0n ? -realized : 0n;
  const netSettlementSats = collateral - redeemed - refund - fee - dust;
  const settlementKind = route === 'roll' ? 'timeout-refund' : 'pnl-sweep';

  return {
    kind: 'settlement-breakdown',
    version: 1,
    epochId: epochId !== undefined && epochId !== null ? String(epochId) : null,
    route: route || 'roll',
    settlementKind,
    collateralSats: collateral.toString(),
    redeemedSats: redeemed.toString(),
    winnerSweepSats: redeemed.toString(),
    pnlReferenceSats: pnlReference.toString(),
    realizedPnlSats: realized.toString(),
    winnerPnlSats: winnerPnlSats.toString(),
    loserPnlSats: loserPnlSats.toString(),
    feeSats: fee.toString(),
    refundSats: refund.toString(),
    residualSats: refund.toString(),
    rolloverCollateralSats: rollover.toString(),
    dustCarrySats: dust.toString(),
    refundRecipient,
    winnerRecipient,
    netSettlementSats: netSettlementSats.toString(),
    note
  };
}

function buildSettlementDeltaAnnotation({
  epochId,
  route,
  depositedSats,
  redeemedSats,
  pnlReferenceSats,
  realizedPnlSats,
  feeSats = 0n,
  maturityHeight = null,
  expiryHeight = null,
  oracleEventId = null,
  oracleDigestHex = null,
  note = null
}) {
  const breakdown = buildSettlementBreakdown({
    epochId,
    route,
    collateralSats: depositedSats,
    redeemedSats,
    pnlReferenceSats,
    realizedPnlSats,
    feeSats,
    note
  });
  const deposited = toBigInt(depositedSats, 'depositedSats');
  const redeemed = toBigInt(redeemedSats, 'redeemedSats');
  const pnlReference = pnlReferenceSats !== undefined && pnlReferenceSats !== null
    ? toBigInt(pnlReferenceSats, 'pnlReferenceSats')
    : deposited;
  const realized = realizedPnlSats !== undefined && realizedPnlSats !== null
    ? toBigInt(realizedPnlSats, 'realizedPnlSats')
    : redeemed - deposited;
  const fee = toBigInt(feeSats, 'feeSats');
  const netDelta = redeemed - deposited;
  const pnlGainSats = netDelta > 0n ? netDelta : 0n;
  const pnlLossSats = netDelta < 0n ? -netDelta : 0n;

  return {
    kind: 'witness-settlement-delta',
    version: 1,
    epochId: epochId !== undefined && epochId !== null ? String(epochId) : null,
    route: route || 'roll',
    depositedSats: deposited.toString(),
    redeemedSats: redeemed.toString(),
    pnlReferenceSats: pnlReference.toString(),
    realizedPnlSats: realized.toString(),
    pnlGainSats: pnlGainSats.toString(),
    pnlLossSats: pnlLossSats.toString(),
    feeSats: fee.toString(),
    netDeltaSats: netDelta.toString(),
    settlementBreakdown: breakdown,
    maturityHeight: maturityHeight !== null && maturityHeight !== undefined ? String(maturityHeight) : null,
    expiryHeight: expiryHeight !== null && expiryHeight !== undefined ? String(expiryHeight) : null,
    oracleEventId,
    oracleDigestHex,
    note,
    annotationHash: sha256Hex(
      stringify({
        epochId: epochId !== undefined && epochId !== null ? String(epochId) : null,
        route: route || 'roll',
        depositedSats: deposited.toString(),
        redeemedSats: redeemed.toString(),
        pnlReferenceSats: pnlReference.toString(),
        realizedPnlSats: realized.toString(),
        pnlGainSats: pnlGainSats.toString(),
        pnlLossSats: pnlLossSats.toString(),
        feeSats: fee.toString(),
        netDeltaSats: netDelta.toString(),
        settlementBreakdown: breakdown,
        maturityHeight: maturityHeight !== null && maturityHeight !== undefined ? String(maturityHeight) : null,
        expiryHeight: expiryHeight !== null && expiryHeight !== undefined ? String(expiryHeight) : null,
        oracleEventId,
        oracleDigestHex,
        note
      })
    )
  };
}

function buildWitnessBlobWithDelta(tallyMap, deltaAnnotation) {
  if (!tallyMap || typeof tallyMap.getCommittedSnapshot !== 'function') {
    throw new Error('tallyMap must expose getCommittedSnapshot()');
  }

  const committed = tallyMap.getCommittedSnapshot();
  return {
    committed,
    deltaAnnotation,
    witnessBlobHash: sha256Hex(
      stringify({
        committed,
        deltaAnnotation
      })
    )
  };
}

module.exports = {
  buildSettlementBreakdown,
  buildSettlementDeltaAnnotation,
  buildWitnessBlobWithDelta
};
