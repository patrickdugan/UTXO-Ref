/**
 * TradeLayer rBTC Hourly DLC Auto-Roll
 *
 * Models the short-cadence DLC policy the oracle should attest to:
 * if the vault funding address' rBTC balance has not decreased by expiry,
 * the valid CET is the roll path; otherwise the oracle must not authorize
 * auto-roll and selects a settlement path.
 */

const crypto = require('crypto');
const { stableStringify, sha256Hex } = require('./tradelayer_pnl_route_adapter');
const {
  buildDlcSettlementOutcomes,
  buildDlcOracleAttestation,
  selectCetForAttestation
} = require('./tradelayer_dlc_cet_oracle_selection');
const { buildFastRollHandoff } = require('./m1_oracle_delta_publication');

const DEFAULT_DURATION_SECONDS = 60 * 60;
const DEFAULT_RISK_MARGIN_SECONDS = 5 * 60;

function toBigInt(value, field) {
  try {
    const out = BigInt(value);
    if (out < 0n) throw new Error('negative');
    return out;
  } catch (err) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function toUnix(value, field) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return n;
}

function requireHex64(value, field) {
  const s = String(value || '');
  if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error(`${field} must be a 32-byte hex string`);
  return s.toLowerCase();
}

function normalizeContract(input = {}) {
  const startsAtUnix = toUnix(input.startsAtUnix ?? Math.floor(Date.now() / 1000), 'startsAtUnix');
  const durationSeconds = toUnix(input.durationSeconds ?? DEFAULT_DURATION_SECONDS, 'durationSeconds');
  if (durationSeconds <= 0) throw new Error('durationSeconds must be positive');
  const expiresAtUnix = toUnix(input.expiresAtUnix ?? (startsAtUnix + durationSeconds), 'expiresAtUnix');
  if (expiresAtUnix <= startsAtUnix) throw new Error('expiresAtUnix must be after startsAtUnix');

  const fundingOutpoint = input.fundingOutpoint || {};
  const fundingTxid = requireHex64(fundingOutpoint.txid, 'fundingOutpoint.txid');
  const fundingVout = Number(fundingOutpoint.vout);
  if (!Number.isSafeInteger(fundingVout) || fundingVout < 0) {
    throw new Error('fundingOutpoint.vout must be a non-negative safe integer');
  }

  const startingRbtcBalance = toBigInt(input.startingRbtcBalance, 'startingRbtcBalance');
  const contractId = String(
    input.contractId
    || `rbtc-hour-${sha256Hex({
      vaultAddress: input.vaultAddress,
      fundingAddress: input.fundingAddress,
      fundingTxid,
      fundingVout,
      startsAtUnix,
      expiresAtUnix
    }).slice(0, 16)}`
  );

  const core = {
    kind: 'tradelayer_rbtc_hourly_dlc_contract_v1',
    contractId,
    previousContractId: input.previousContractId ? String(input.previousContractId) : null,
    vaultAddress: String(input.vaultAddress || ''),
    fundingAddress: String(input.fundingAddress || ''),
    rbtcPropertyId: Number(input.rbtcPropertyId ?? 0),
    fundingOutpoint: { txid: fundingTxid, vout: fundingVout },
    reserveVaultId: input.reserveVaultId ? String(input.reserveVaultId) : null,
    startsAtUnix,
    durationSeconds,
    expiresAtUnix,
    riskMarginSeconds: toUnix(input.riskMarginSeconds ?? DEFAULT_RISK_MARGIN_SECONDS, 'riskMarginSeconds'),
    startingRbtcBalance: startingRbtcBalance.toString()
  };

  if (!core.vaultAddress) throw new Error('vaultAddress is required');
  if (!core.fundingAddress) throw new Error('fundingAddress is required');
  if (!Number.isSafeInteger(core.rbtcPropertyId) || core.rbtcPropertyId <= 0) {
    throw new Error('rbtcPropertyId must be a positive safe integer');
  }

  return core;
}

function buildHourlyRbtcDlcContract(input = {}) {
  const core = normalizeContract(input);
  return {
    kind: 'tradelayer_rbtc_hourly_dlc_contract',
    contractHash: sha256Hex(core),
    core
  };
}

function buildBalanceOracleObservation(contract, input = {}) {
  const core = contract?.core || contract;
  if (!core || core.kind !== 'tradelayer_rbtc_hourly_dlc_contract_v1') {
    throw new Error('hourly rBTC DLC contract is required');
  }
  const observedAtUnix = toUnix(input.observedAtUnix ?? core.expiresAtUnix, 'observedAtUnix');
  const currentRbtcBalance = toBigInt(input.currentRbtcBalance, 'currentRbtcBalance');
  const startingRbtcBalance = toBigInt(core.startingRbtcBalance, 'startingRbtcBalance');
  const delta = currentRbtcBalance - startingRbtcBalance;
  const balanceReduced = currentRbtcBalance < startingRbtcBalance;
  const matured = observedAtUnix >= core.expiresAtUnix;
  const insideRiskWindow = observedAtUnix >= (core.expiresAtUnix - core.riskMarginSeconds);

  const observationCore = {
    kind: 'tradelayer_rbtc_balance_oracle_observation_v1',
    contractId: core.contractId,
    vaultAddress: core.vaultAddress,
    fundingAddress: core.fundingAddress,
    rbtcPropertyId: core.rbtcPropertyId,
    fundingOutpoint: core.fundingOutpoint,
    startsAtUnix: core.startsAtUnix,
    expiresAtUnix: core.expiresAtUnix,
    observedAtUnix,
    startingRbtcBalance: startingRbtcBalance.toString(),
    currentRbtcBalance: currentRbtcBalance.toString(),
    deltaRbtcBalance: delta.toString(),
    balanceReduced,
    matured,
    insideRiskWindow
  };

  return {
    kind: 'tradelayer_rbtc_balance_oracle_observation',
    observationHash: sha256Hex(observationCore),
    core: observationCore
  };
}

function chooseOutcomeFromBalanceObservation(observation) {
  const core = observation?.core || observation;
  if (!core || core.kind !== 'tradelayer_rbtc_balance_oracle_observation_v1') {
    throw new Error('rBTC balance oracle observation is required');
  }
  if (!core.matured) {
    return {
      outcomeId: 'wait',
      canAutoRoll: false,
      reason: 'contract_not_mature'
    };
  }
  if (core.balanceReduced) {
    return {
      outcomeId: 'settle-loss',
      canAutoRoll: false,
      reason: 'rbtc_balance_reduced'
    };
  }
  return {
    outcomeId: 'roll',
    canAutoRoll: true,
    reason: 'rbtc_balance_unchanged'
  };
}

function defaultAddresses(contract) {
  const core = contract.core || contract;
  return {
    alice: core.fundingAddress,
    bob: core.vaultAddress,
    residual: core.vaultAddress,
    operator: core.vaultAddress
  };
}

function buildHourlyRbtcCetDecision(input = {}) {
  const contract = input.contract?.core ? input.contract : buildHourlyRbtcDlcContract(input.contract || input);
  const observation = input.observation?.core
    ? input.observation
    : buildBalanceOracleObservation(contract, input.observation || input);
  const policy = chooseOutcomeFromBalanceObservation(observation);
  if (policy.outcomeId === 'wait') {
    return {
      kind: 'tradelayer_rbtc_hourly_cet_decision',
      decisionHash: sha256Hex({ contractHash: contract.contractHash, observationHash: observation.observationHash, policy }),
      contract,
      observation,
      policy,
      settlementOutcomes: null,
      attestation: null,
      selectedCet: null,
      rollHandoff: null
    };
  }

  const settlementOutcomes = buildDlcSettlementOutcomes({
    collateralSats: input.collateralSats ?? input.vaultAmountSats ?? 20000,
    minerFeeSats: input.minerFeeSats ?? 1000,
    bucketCapBps: input.bucketCapBps ?? 500,
    realizedPnlBps: input.realizedPnlBps ?? (policy.outcomeId === 'roll' ? 0 : 500),
    feeBps: input.feeBps ?? 0,
    addresses: input.addresses || defaultAddresses(contract)
  });

  const attestation = buildDlcOracleAttestation({
    contractId: contract.core.contractId,
    fundingTxid: contract.core.fundingOutpoint.txid,
    fundingVout: contract.core.fundingOutpoint.vout,
    outcomeId: policy.outcomeId
  }, input.privateKey);

  const selectedCet = selectCetForAttestation(settlementOutcomes, attestation, {
    publicKey: input.publicKey,
    contractId: contract.core.contractId,
    fundingTxid: contract.core.fundingOutpoint.txid,
    fundingVout: contract.core.fundingOutpoint.vout
  });

  const rollHandoff = policy.canAutoRoll
    ? buildFastRollHandoff({
        challengeBundle: {
          bundleHash: contract.contractHash,
          binding: {
            fundingOutpoint: {
              ...contract.core.fundingOutpoint,
              valueSats: String(input.collateralSats ?? input.vaultAmountSats ?? 20000)
            }
          },
          selectedPathId: 'roll',
          selectedPath: {
            pathId: 'roll',
            kind: 'roll',
            txid: contract.core.fundingOutpoint.txid,
            residualSats: String(input.collateralSats ?? input.vaultAmountSats ?? 20000),
            rolloverCollateralSats: String(input.collateralSats ?? input.vaultAmountSats ?? 20000),
            adaptorSignaturePlaceholder: 'adaptor_sig_for_hourly_rbtc_roll',
            adaptorPointPlaceholder: 'adaptor_point_for_hourly_rbtc_roll'
          },
          oracleBinding: {
            eventId: `${contract.core.contractId}:rbtc-balance`,
            quorumId: input.quorumId || 'rbtc-balance-oracle-1of1',
            keyId: input.keyId || 'rbtc-balance-key-1',
            oracleMapId: sha256Hex({
              contractId: contract.core.contractId,
              observationHash: observation.observationHash
            }).slice(0, 16),
            messageDigestHex: observation.observationHash,
            messagePayload: stableStringify(observation.core),
            adaptorSignaturePlaceholder: 'adaptor_sig_for_hourly_rbtc_roll',
            adaptorPointPlaceholder: 'adaptor_point_for_hourly_rbtc_roll'
          }
        },
        oracleWiring: {
          binding: { fundingOutpoint: contract.core.fundingOutpoint },
          oracle: {
            eventId: `${contract.core.contractId}:rbtc-balance`,
            quorumId: input.quorumId || 'rbtc-balance-oracle-1of1',
            keyId: input.keyId || 'rbtc-balance-key-1'
          }
        },
        deltaSats: input.collateralSats ?? input.vaultAmountSats ?? 20000
      })
    : null;

  const decisionCore = {
    kind: 'tradelayer_rbtc_hourly_cet_decision_v1',
    contractHash: contract.contractHash,
    observationHash: observation.observationHash,
    policy,
    selectedOutcomeId: selectedCet.selection.outcomeId,
    selectedCetHash: selectedCet.selectionHash,
    rollPublicationId: rollHandoff?.publication?.publicationId || null
  };

  return {
    kind: 'tradelayer_rbtc_hourly_cet_decision',
    decisionHash: sha256Hex(decisionCore),
    decisionCore,
    contract,
    observation,
    policy,
    settlementOutcomes,
    attestation,
    selectedCet,
    rollHandoff
  };
}

module.exports = {
  DEFAULT_DURATION_SECONDS,
  DEFAULT_RISK_MARGIN_SECONDS,
  buildHourlyRbtcDlcContract,
  buildBalanceOracleObservation,
  chooseOutcomeFromBalanceObservation,
  buildHourlyRbtcCetDecision
};
