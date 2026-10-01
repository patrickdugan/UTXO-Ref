/**
 * BetweenBits UTXORef adapter prototype.
 *
 * This module turns UTXORef live artifacts into the kind of conservative,
 * policy-engine friendly API payloads an institutional BetweenBits deployment
 * could consume for BitCert/PoR, custody policy, and watchtower approval.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const { stableStringify, sha256Hex } = require('../../bitvm3/utxo_referee/tradelayer_pnl_route_adapter');

const BETA_GATE_KIND = 'tradelayer_real_money_beta_gate_package_v1';
const BETWEENBITS_STATUS_KIND = 'betweenbits_utxoref_beta_status_v1';
const BETWEENBITS_ATTESTATION_KIND = 'betweenbits_utxoref_asset_attestation_v1';
const BETWEENBITS_SPEND_EVALUATION_KIND = 'betweenbits_utxoref_spend_policy_evaluation_v1';
const BETWEENBITS_TAPROOT_USD_ASSET_KIND = 'betweenbits_taproot_usd_wallet_asset_v1';
const BETWEENBITS_TAPROOT_USD_CROSSREF_KIND = 'betweenbits_taproot_usd_cross_reference_v1';

function defaultArtifactsDir(repoRoot = path.resolve(__dirname, '..', '..')) {
  return path.join(repoRoot, 'bitvm3', 'utxo_referee', 'artifacts', 'live');
}

function liveArtifactPaths(artifactsDir = defaultArtifactsDir()) {
  return {
    betaGatePackage: path.join(artifactsDir, 'tradelayer_beta_gate_package_latest.json'),
    tx30RelayAnchor: path.join(artifactsDir, 'tradelayer_tx30_relay_anchor_broadcast_latest.json'),
    reserveVault: path.join(artifactsDir, 'btc_testnet4_reserve_vault_latest.json'),
    autoRollState: path.join(artifactsDir, 'rbtc_hourly_autoroll_listener_wallclock_apply.json')
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadLiveArtifacts(options = {}) {
  const artifactsDir = options.artifactsDir || defaultArtifactsDir(options.repoRoot);
  const paths = liveArtifactPaths(artifactsDir);
  const artifacts = {};
  for (const [name, filePath] of Object.entries(paths)) {
    artifacts[name] = fs.existsSync(filePath) ? readJson(filePath) : null;
  }
  return { artifactsDir, paths, artifacts };
}

function packageCore(betaGatePackage) {
  const core = { ...(betaGatePackage || {}) };
  delete core.packageHash;
  return core;
}

function verifyBetaGatePackage(betaGatePackage) {
  const errors = [];
  if (!betaGatePackage || betaGatePackage.kind !== BETA_GATE_KIND) {
    errors.push('beta gate package kind mismatch');
  }
  if (!betaGatePackage?.packageHash) {
    errors.push('beta gate package missing packageHash');
  } else {
    const rebuilt = sha256Hex(packageCore(betaGatePackage));
    if (rebuilt !== betaGatePackage.packageHash) {
      errors.push('beta gate package hash mismatch');
    }
  }
  if (betaGatePackage?.realMoneyAllowed === true && betaGatePackage?.status !== 'BETA_CANDIDATE') {
    errors.push('realMoneyAllowed true without BETA_CANDIDATE status');
  }
  if (!Array.isArray(betaGatePackage?.gates)) {
    errors.push('beta gate package gates must be an array');
  }
  return { ok: errors.length === 0, errors };
}

function gateMap(betaGatePackage) {
  const out = {};
  for (const gate of betaGatePackage?.gates || []) out[gate.name] = gate;
  return out;
}

function hardNoReason(betaGatePackage, verification) {
  if (!verification.ok) return 'invalid_beta_gate_package';
  if (betaGatePackage.realMoneyAllowed !== true) return 'real_money_gate_closed';
  return null;
}

function summarizeBetaGate(betaGatePackage, options = {}) {
  const verification = verifyBetaGatePackage(betaGatePackage);
  const gates = gateMap(betaGatePackage || {});
  const failingGates = (betaGatePackage?.gates || []).filter((gate) => !gate.ok).map((gate) => gate.name);
  const reserve = betaGatePackage?.evidence?.reserve || {};
  const relay = betaGatePackage?.evidence?.tx30RelayAnchor || {};
  const retrieval = betaGatePackage?.evidence?.relayRetrieval || {};
  const chain = betaGatePackage?.evidence?.chain || null;
  const hardNo = hardNoReason(betaGatePackage || {}, verification);

  const status = {
    kind: BETWEENBITS_STATUS_KIND,
    checkedAt: options.checkedAt || new Date().toISOString(),
    sourcePackageHash: betaGatePackage?.packageHash || null,
    sourceValid: verification.ok,
    sourceErrors: verification.errors,
    chain,
    betweenBitsIntegrationMode: 'institutional_api_adapter',
    status: betaGatePackage?.status || 'UNKNOWN',
    realMoneyAllowed: betaGatePackage?.realMoneyAllowed === true,
    policyDecision: hardNo ? 'BLOCK_PRODUCTION_VALUE' : 'ALLOW_PRODUCTION_CANDIDATE',
    policyReason: hardNo,
    testnetContinueAllowed: (
      gates.confirmed_live_reserve?.ok === true
      && gates.full_signed_relay_retrieval?.ok === true
      && gates.regression_green?.ok === true
    ),
    failingGates,
    nextRequiredActions: betaGatePackage?.nextRequiredActions || failingGates,
    reserve: {
      txid: reserve.txid || null,
      vout: reserve.vout ?? null,
      confirmed: reserve.confirmed === true,
      confirmations: reserve.confirmations ?? null,
      unspent: reserve.unspent === true,
      artifact: reserve.artifact || null
    },
    tx30RelayAnchor: {
      txid: relay.txid || null,
      confirmed: relay.confirmed === true,
      confirmations: relay.confirmations ?? null,
      inMempool: relay.inMempool === true,
      relayBlobHash: relay.relayBlobHash || retrieval.relayBlobHash || null
    },
    relayRetrieval: {
      ok: retrieval.ok === true,
      replicaCount: retrieval.replicaCount || 0,
      recoveredFrom: retrieval.recoveredFrom || null
    }
  };
  status.statusHash = sha256Hex(status);
  return status;
}

function buildAssetAttestation(input = {}) {
  const betaGatePackage = input.betaGatePackage;
  const status = input.status || summarizeBetaGate(betaGatePackage, { checkedAt: input.checkedAt });
  const reserve = betaGatePackage?.evidence?.reserve || {};
  const assetCode = input.assetCode || 'BTC_TESTNET4';
  const amountSats = input.amountSats ?? input.reserveVault?.amountSats ?? null;
  const productionEligible = status.realMoneyAllowed === true && status.policyDecision === 'ALLOW_PRODUCTION_CANDIDATE';

  const attestation = {
    kind: BETWEENBITS_ATTESTATION_KIND,
    createdAt: input.createdAt || new Date().toISOString(),
    institutionId: input.institutionId || 'betweenbits-demo-institution',
    bitcertProfileId: input.bitcertProfileId || 'utxoref_reserve_vault_v1',
    assetCode,
    network: status.chain || assetCode,
    reserveSourceKind: 'taproot-reserve-vault-set',
    productionEligible,
    testnetEligible: status.testnetContinueAllowed === true,
    realMoneyAllowed: status.realMoneyAllowed === true,
    sourcePackageHash: status.sourcePackageHash,
    statusHash: status.statusHash,
    reserveInput: {
      outpoint: reserve.txid ? `${reserve.txid}:${reserve.vout ?? 0}` : null,
      amountSats,
      confirmed: reserve.confirmed === true,
      confirmations: reserve.confirmations ?? null,
      unspent: reserve.unspent === true,
      encumbrance: 'taproot_operator_guardian_csv_recovery',
      includeInProductionPoR: productionEligible,
      includeInTestnetPoR: status.testnetContinueAllowed === true
    },
    blockingGates: status.nextRequiredActions,
    responsibilityBoundary: {
      clientInstitution: ['liability_snapshot', 'customer_relationships', 'licensing_and_compliance_execution'],
      betweenBits: ['api_gateway', 'policy_engine', 'wallet_mpc_layer', 'transaction_engine'],
      utxoref: ['reserve_vault_manifest', 'relay_anchor_verification', 'watchtower_policy_evidence']
    }
  };
  attestation.attestationHash = sha256Hex(attestation);
  return attestation;
}

function buildPrototypeCrossReferences(input = {}) {
  const repoRoot = input.repoRoot || path.resolve(__dirname, '..', '..');
  const rel = (filePath) => path.relative(repoRoot, path.join(repoRoot, filePath)).replace(/\\/g, '/');
  const reserveOutpoint = input.reserveOutpoint || null;
  const assetTicker = input.assetTicker || 'tUSD';
  const crossRef = {
    kind: BETWEENBITS_TAPROOT_USD_CROSSREF_KIND,
    createdAt: input.createdAt || new Date().toISOString(),
    walletProduct: 'taproot_usd',
    thesis:
      'Taproot USD is surfaced as a wallet asset whose BTC reserve is funded/verified through UTXORef and whose USD/rBTC state transitions are governed by TradeLayer derivative and Taproot-asset evidence.',
    lnToVaultFunding: {
      label: 'LN submarine swap to UTXORef vault funding',
      purpose:
        'Let an LN wallet fund the BTC leg by paying an invoice while UTXORef claims the HTLC into a reserve-vault or DLC funding output.',
      prototypeModules: [
        rel('bitvm3/utxo_referee/utxoref_dlc_subswap_funding.js'),
        rel('bitvm3/utxo_referee/stage_submarine_swap_testnet4.js'),
        rel('bitvm3/utxo_referee/lightning_subswap_dlc_demo.js')
      ],
      artifactKinds: [
        'utxoref_dlc_subswap_funding_request',
        'utxoref_subswap_execution_proof',
        'staged_submarine_swap_htlc'
      ],
      walletFlow: [
        'quote_submarine_swap',
        'pay_ln_invoice',
        'verify_payment_hash_and_preimage',
        'watch_htlc_claim_to_vault_or_dlc_output',
        'include_claimed_outpoint_in_reserve_reconciliation'
      ],
      reserveBinding: {
        reserveOutpoint,
        target: 'UTXORef Taproot reserve vault or DLC funding output',
        safetyCheck: 'claim transaction must pay the committed vault/funding script and amount'
      }
    },
    tradeLayerTaprootMinting: {
      label: 'TradeLayer derivative state to Taproot USD asset mint',
      purpose:
        'Use TradeLayer rBTC/USD derivative and oracle state as the mint/roll eligibility input for a wallet-visible Taproot USD asset.',
      prototypeModules: [
        rel('bitvm3/utxo_referee/lightning_taproot_assets_stablecoin.js'),
        rel('bitvm3/utxo_referee/tradelayer_rbtc_hourly_autoroll.js'),
        rel('bitvm3/utxo_referee/tradelayer_tx30_relay_anchor.js'),
        rel('bitvm3/utxo_referee/tradelayer_taproot.js')
      ],
      artifactKinds: [
        'taproot_asset_stablecoin_descriptor',
        'taproot_asset_proof_commitment',
        'tradelayer_rbtc_hourly_dlc_contract',
        'tradelayer_tx30_relay_anchor_v1'
      ],
      mintFlow: [
        'verify_utxoref_vault_reserve',
        'observe_tradelayer_rbtc_balance_and_derivative_state',
        'select_valid_cet_or_auto_roll_outcome',
        'anchor_signed_tx30_relay_or_retrieve_full_bundle',
        'emit_wallet_asset_descriptor_for_taproot_usd'
      ],
      assetBinding: {
        ticker: assetTicker,
        issuerModel: 'TradeLayer-governed prototype; production must verify Taproot Assets proofs directly',
        mintCondition:
          'mint or continue display only when reserve evidence, tx30 relay, and TradeLayer oracle outcome all verify'
      }
    }
  };
  crossRef.crossReferenceHash = sha256Hex(crossRef);
  return crossRef;
}

function extractAutoRollSummary(autoRollState) {
  if (!autoRollState || typeof autoRollState !== 'object') {
    return {
      available: false,
      contractId: null,
      state: null,
      expiry: null,
      tx30Id: null
    };
  }
  const applied = autoRollState.applied || autoRollState.result || autoRollState;
  const contractCore = applied.contract?.core || applied.decision?.contract?.core || {};
  const observationCore = applied.decision?.observation?.core || {};
  const selectedCet = applied.decision?.selectedCet?.selection || {};
  const tx30Intent = applied.tx30Intent || {};
  const contracts = applied.contracts || autoRollState.contracts || [];
  const latestContract = Array.isArray(contracts) && contracts.length ? contracts[contracts.length - 1] : null;
  return {
    available: true,
    contractId: applied.contractId || contractCore.contractId || latestContract?.id || latestContract?.contractId || null,
    nextContractId: tx30Intent.nextDlcRef || applied.decision?.rollHandoff?.nextContract?.contractId || null,
    state: applied.state || applied.status || tx30Intent.settlementState || latestContract?.state || latestContract?.status || null,
    selectedOutcomeId: applied.decision?.decisionCore?.selectedOutcomeId || selectedCet.outcomeId || null,
    canAutoRoll: applied.decision?.policy?.canAutoRoll ?? tx30Intent.autoRoll ?? null,
    balanceReduced: observationCore.balanceReduced ?? null,
    expiry: applied.expiry || applied.expiryTime || contractCore.expiresAtUnix || latestContract?.expiry || latestContract?.expiryTime || null,
    tx30Id: applied.tx30Id || applied.txid || tx30Intent.dlcRef || latestContract?.tx30Id || null,
    relayBlobHash: tx30Intent.relayBlobHash || null
  };
}

function buildTaprootUsdWalletAsset(input = {}) {
  const betaGatePackage = input.betaGatePackage;
  const status = input.status || summarizeBetaGate(betaGatePackage, { checkedAt: input.checkedAt });
  const reserve = betaGatePackage?.evidence?.reserve || {};
  const relay = status.tx30RelayAnchor || {};
  const autoRoll = extractAutoRollSummary(input.autoRollState);
  const reserveOutpoint = reserve.txid ? `${reserve.txid}:${reserve.vout ?? 0}` : null;
  const crossReferences = buildPrototypeCrossReferences({
    createdAt: input.createdAt,
    repoRoot: input.repoRoot,
    reserveOutpoint,
    assetTicker: input.ticker || 'tUSD'
  });
  const asset = {
    kind: BETWEENBITS_TAPROOT_USD_ASSET_KIND,
    createdAt: input.createdAt || new Date().toISOString(),
    walletProduct: 'taproot_usd',
    displayName: input.displayName || 'Taproot USD',
    ticker: input.ticker || 'tUSD',
    environment: status.chain === 'BTC_TESTNET4' ? 'testnet' : 'unknown',
    backingModel: {
      reserveAsset: 'BTC',
      reserveEvidence: 'UTXORef Taproot reserve vault',
      derivativeState: 'TradeLayer rBTC/USD derivative and tx30 relay',
      settlementControl: 'watchtower policy approval before guardian signature'
    },
    walletAvailability: {
      showInWallet: status.testnetContinueAllowed === true,
      allowDeposits: false,
      allowWithdrawals: false,
      allowProductionValue: status.realMoneyAllowed === true,
      reason: status.realMoneyAllowed === true ? null : status.policyReason
    },
    reserveBinding: {
      sourcePackageHash: status.sourcePackageHash,
      statusHash: status.statusHash,
      reserveOutpoint,
      reserveConfirmed: reserve.confirmed === true,
      reserveUnspent: reserve.unspent === true,
      relayBlobHash: relay.relayBlobHash || null,
      relayTxid: relay.txid || null
    },
    tradeLayerBinding: {
      autoRoll,
      oracleDependency: 'TradeLayer state oracle determines valid CET/roll outcome',
      reductionCondition: 'auto-roll path if no reduction in the vault funding address rBTC token balance'
    },
    crossReferences,
    blockingGates: status.nextRequiredActions
  };
  asset.walletAssetHash = sha256Hex(asset);
  return asset;
}

function hashOutputs(outputs) {
  return createHash('sha256').update(stableStringify(outputs || [])).digest('hex');
}

function bigintOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function evaluateSpendProposal(input = {}) {
  const betaGatePackage = input.betaGatePackage;
  const status = input.status || summarizeBetaGate(betaGatePackage, { checkedAt: input.checkedAt });
  const proposal = input.proposal || {};
  const policy = input.policy || {};
  const errors = [];
  const warnings = [];

  if (!status.sourceValid) errors.push('source beta gate package is invalid');
  if (policy.allowTestnet !== true && status.realMoneyAllowed !== true) {
    errors.push('real-money gate is closed');
  }
  if (policy.requireConfirmedReserve !== false && status.reserve.confirmed !== true) {
    errors.push('reserve is not confirmed');
  }
  if (policy.requireUnspentReserve !== false && status.reserve.unspent !== true) {
    errors.push('reserve is not unspent');
  }

  const feeSats = bigintOrNull(proposal.feeSats);
  const maxFeeSats = bigintOrNull(policy.maxFeeSats);
  if (maxFeeSats !== null && (feeSats === null || feeSats > maxFeeSats)) {
    errors.push('proposal fee exceeds policy');
  }

  const amountSats = bigintOrNull(proposal.amountSats);
  const maxPerContractSats = bigintOrNull(policy.maxPerContractSats);
  if (maxPerContractSats !== null && (amountSats === null || amountSats > maxPerContractSats)) {
    errors.push('proposal amount exceeds per-contract cap');
  }

  const proposalOutputHash = proposal.outputHash || hashOutputs(proposal.outputs || []);
  if (policy.requiredOutputHash && proposalOutputHash !== policy.requiredOutputHash) {
    errors.push('proposal outputs do not match required output hash');
  }
  if (Array.isArray(policy.allowedAddresses) && policy.allowedAddresses.length > 0) {
    for (const output of proposal.outputs || []) {
      if (!policy.allowedAddresses.includes(output.address)) {
        errors.push(`output address not allowed: ${output.address || '<missing>'}`);
      }
    }
  }
  if (!proposal.unsignedTxHash && !proposal.psbtHash) {
    warnings.push('proposal has no unsignedTxHash or psbtHash; prototype cannot bind a guardian signature');
  }

  const evaluation = {
    kind: BETWEENBITS_SPEND_EVALUATION_KIND,
    evaluatedAt: input.evaluatedAt || new Date().toISOString(),
    sourcePackageHash: status.sourcePackageHash,
    vaultId: proposal.vaultId || null,
    proposalHash: sha256Hex(proposal),
    approvedTxOutputHash: errors.length === 0 ? proposalOutputHash : null,
    guardianAction: errors.length === 0 ? 'SIGN_EXACT_SIGHASH' : 'REFUSE',
    ok: errors.length === 0,
    errors,
    warnings,
    policyResult: {
      allowTestnet: policy.allowTestnet === true,
      realMoneyAllowed: status.realMoneyAllowed === true,
      maxFeeSats: policy.maxFeeSats ?? null,
      maxPerContractSats: policy.maxPerContractSats ?? null,
      requiredOutputHash: policy.requiredOutputHash || null
    }
  };
  evaluation.evaluationHash = sha256Hex(evaluation);
  return evaluation;
}

module.exports = {
  BETA_GATE_KIND,
  BETWEENBITS_STATUS_KIND,
  BETWEENBITS_ATTESTATION_KIND,
  BETWEENBITS_SPEND_EVALUATION_KIND,
  BETWEENBITS_TAPROOT_USD_ASSET_KIND,
  BETWEENBITS_TAPROOT_USD_CROSSREF_KIND,
  defaultArtifactsDir,
  liveArtifactPaths,
  readJson,
  loadLiveArtifacts,
  verifyBetaGatePackage,
  summarizeBetaGate,
  buildAssetAttestation,
  buildPrototypeCrossReferences,
  buildTaprootUsdWalletAsset,
  extractAutoRollSummary,
  evaluateSpendProposal,
  hashOutputs
};
