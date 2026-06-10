/**
 * TradeLayer DLC CET Oracle Selection
 *
 * Turns the cooperative "spend the 2-of-2 to whoever" CET into an
 * oracle-conditioned, route-derived settlement:
 *
 *  1. The bounded settlement model (computeBoundedSettlementAmounts) produces
 *     concrete per-outcome CET output maps for settle-gain / settle-loss / roll.
 *  2. An oracle attestation (Ed25519 signature over contractId + funding
 *     outpoint + outcomeId) selects which outcome's CET is the valid one.
 *  3. selectCetForAttestation verifies the attestation and returns the matching
 *     CET output map, bound to the attested message.
 *
 * Scope note: the attestation here *selects* a pre-built CET. It is not yet a
 * secp256k1 adaptor signature that cryptographically enforces the outcome at
 * the script level - that (and BitVM challenge enforcement) remains the open
 * trust-minimization work.
 */

const crypto = require('crypto');
const { computeBoundedSettlementAmounts } = require('./m1_transition');
const { sha256Hex, stableStringify } = require('./tradelayer_pnl_route_adapter');

const DUST_LIMIT_SATS = 546n;
const OUTCOME_IDS = Object.freeze(['settle-gain', 'settle-loss', 'roll']);

function toSats(value, field) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${field} must be an integer sat amount`);
}

function addOutput(map, address, sats) {
  if (!address || sats <= 0n) return;
  map[address] = (BigInt(map[address] || 0n) + sats);
}

function sumOutputs(map) {
  return Object.values(map).reduce((s, v) => s + BigInt(v), 0n);
}

/**
 * Build the per-outcome CET output maps (sats) from the bounded settlement
 * model. The miner fee is taken off the residual/winner so on-chain outputs
 * sum to collateral - minerFeeSats.
 */
function buildDlcSettlementOutcomes(input = {}) {
  const collateralSats = toSats(input.collateralSats, 'collateralSats');
  const minerFeeSats = toSats(input.minerFeeSats ?? 1000, 'minerFeeSats');
  const bucketCapBps = Number(input.bucketCapBps ?? 500);
  const realizedPnlBps = Number(input.realizedPnlBps ?? bucketCapBps);
  const feeBps = Number(input.feeBps ?? 0);
  const a = input.addresses || {};
  for (const role of ['alice', 'bob', 'residual']) {
    if (!a[role]) throw new Error(`addresses.${role} is required`);
  }
  const operatorAddr = a.operator || a.residual;

  const c = computeBoundedSettlementAmounts(collateralSats, bucketCapBps, realizedPnlBps, feeBps);

  function settlementOutputs(winnerAddress) {
    const map = {};
    addOutput(map, winnerAddress, c.actualPayoutSats);
    addOutput(map, operatorAddr, c.feeSats);
    const residual = c.refundSats - minerFeeSats;
    if (residual < DUST_LIMIT_SATS) throw new Error('residual below dust after miner fee');
    addOutput(map, a.residual, residual);
    return map;
  }

  function rollOutputs() {
    const map = {};
    const rollover = c.rolloverCollateralSats - minerFeeSats;
    if (rollover < DUST_LIMIT_SATS) throw new Error('rollover below dust after miner fee');
    addOutput(map, a.residual, rollover);
    addOutput(map, operatorAddr, c.feeSats);
    addOutput(map, a.alice, c.actualPayoutSats); // carried payout leg
    return map;
  }

  const byId = {
    'settle-gain': { outcomeId: 'settle-gain', winnerRole: 'alice', outputs: settlementOutputs(a.alice) },
    'settle-loss': { outcomeId: 'settle-loss', winnerRole: 'bob', outputs: settlementOutputs(a.bob) },
    'roll': { outcomeId: 'roll', winnerRole: 'residual', outputs: rollOutputs() }
  };

  const outcomes = OUTCOME_IDS.map((id) => {
    const o = byId[id];
    const outputsSats = Object.fromEntries(Object.entries(o.outputs).map(([k, v]) => [k, v.toString()]));
    return {
      outcomeId: id,
      winnerRole: o.winnerRole,
      outputsSats,
      totalOutSats: sumOutputs(o.outputs).toString(),
      minerFeeSats: minerFeeSats.toString()
    };
  });

  return {
    kind: 'tradelayer_dlc_settlement_outcomes_v1',
    collateralSats: collateralSats.toString(),
    bucketCapBps: c.bucketCapBps,
    realizedPnlBps: c.realizedPnlBps,
    effectivePnlBps: c.effectivePnlBps,
    feeBps: c.feeBps,
    minerFeeSats: minerFeeSats.toString(),
    outcomes,
    outcomesHash: sha256Hex(stableStringify(outcomes))
  };
}

function attestationMessage(params) {
  return stableStringify({
    kind: 'tradelayer_dlc_oracle_attestation_v1',
    contractId: String(params.contractId),
    fundingTxid: String(params.fundingTxid),
    fundingVout: Number(params.fundingVout),
    outcomeId: String(params.outcomeId)
  });
}

/**
 * Oracle signs the chosen outcome. privateKey is an Ed25519 KeyObject or PEM.
 */
function buildDlcOracleAttestation(params, privateKey) {
  if (!OUTCOME_IDS.includes(params.outcomeId)) throw new Error(`unknown outcomeId: ${params.outcomeId}`);
  const message = attestationMessage(params);
  const signature = crypto.sign(null, Buffer.from(message), privateKey).toString('hex');
  return {
    kind: 'tradelayer_dlc_oracle_attestation',
    contractId: String(params.contractId),
    fundingTxid: String(params.fundingTxid),
    fundingVout: Number(params.fundingVout),
    outcomeId: String(params.outcomeId),
    message,
    signature
  };
}

function verifyDlcOracleAttestation(attestation, publicKey) {
  if (!attestation || attestation.kind !== 'tradelayer_dlc_oracle_attestation') {
    return { ok: false, reason: 'wrong attestation kind' };
  }
  if (!OUTCOME_IDS.includes(attestation.outcomeId)) return { ok: false, reason: 'unknown outcomeId' };
  const message = attestationMessage(attestation);
  if (message !== attestation.message) return { ok: false, reason: 'attestation message mismatch' };
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(message), publicKey, Buffer.from(attestation.signature, 'hex'));
  } catch (err) {
    return { ok: false, reason: `signature verify error: ${err.message}` };
  }
  return ok ? { ok: true } : { ok: false, reason: 'bad oracle signature' };
}

/**
 * Verify the oracle attestation, confirm it binds this contract/funding output,
 * and return the selected outcome's CET output map.
 */
function selectCetForAttestation(settlementOutcomes, attestation, options = {}) {
  if (!settlementOutcomes || settlementOutcomes.kind !== 'tradelayer_dlc_settlement_outcomes_v1') {
    throw new Error('settlementOutcomes is invalid');
  }
  const sig = verifyDlcOracleAttestation(attestation, options.publicKey);
  if (!sig.ok) throw new Error(`oracle attestation rejected: ${sig.reason}`);
  if (options.contractId !== undefined && String(options.contractId) !== attestation.contractId) {
    throw new Error('attestation contractId mismatch');
  }
  if (options.fundingTxid !== undefined && String(options.fundingTxid) !== attestation.fundingTxid) {
    throw new Error('attestation funding txid mismatch');
  }
  if (options.fundingVout !== undefined && Number(options.fundingVout) !== attestation.fundingVout) {
    throw new Error('attestation funding vout mismatch');
  }
  const outcome = settlementOutcomes.outcomes.find((o) => o.outcomeId === attestation.outcomeId);
  if (!outcome) throw new Error(`no CET for attested outcome: ${attestation.outcomeId}`);

  const selection = {
    kind: 'tradelayer_dlc_cet_selection_v1',
    outcomeId: outcome.outcomeId,
    winnerRole: outcome.winnerRole,
    fundingTxid: attestation.fundingTxid,
    fundingVout: attestation.fundingVout,
    outputsSats: outcome.outputsSats,
    totalOutSats: outcome.totalOutSats,
    outcomesHash: settlementOutcomes.outcomesHash,
    attestationMessage: attestation.message
  };
  return {
    kind: 'tradelayer_dlc_cet_selection',
    selectionHash: sha256Hex(stableStringify(selection)),
    selection
  };
}

module.exports = {
  OUTCOME_IDS,
  buildDlcSettlementOutcomes,
  buildDlcOracleAttestation,
  verifyDlcOracleAttestation,
  selectCetForAttestation
};
