const assert = require('assert');

const { sha256Hex } = require('../../bitvm3/utxo_referee/tradelayer_pnl_route_adapter');
const {
  verifyBetaGatePackage,
  summarizeBetaGate,
  buildAssetAttestation,
  buildTaprootUsdWalletAsset,
  buildPrototypeCrossReferences,
  evaluateSpendProposal,
  hashOutputs
} = require('./index');

function withHash(core) {
  return { ...core, packageHash: sha256Hex(core) };
}

function samplePackage(overrides = {}) {
  return withHash({
    kind: 'tradelayer_real_money_beta_gate_package_v1',
    createdAt: '2026-07-07T00:00:00.000Z',
    status: 'LIMITED_TESTNET_CONTINUE',
    realMoneyAllowed: false,
    gates: [
      { name: 'confirmed_live_reserve', ok: true, txid: 'a'.repeat(64), confirmations: 12 },
      { name: 'full_signed_relay_retrieval', ok: true, relayBlobHash: 'b'.repeat(64), replicaCount: 2 },
      { name: 'separated_keys', ok: false, errors: ['reserveOperator.publicKey is required'] },
      { name: 'regression_green', ok: true, command: 'node bitvm3\\utxo_referee\\run_utxoref_all.js', suites: '76/76' }
    ],
    evidence: {
      chain: 'BTC_TESTNET4',
      reserve: {
        txid: 'a'.repeat(64),
        vout: 0,
        confirmed: true,
        confirmations: 12,
        unspent: true
      },
      tx30RelayAnchor: {
        txid: 'c'.repeat(64),
        confirmed: false,
        inMempool: true,
        relayBlobHash: 'b'.repeat(64)
      },
      relayRetrieval: {
        ok: true,
        relayBlobHash: 'b'.repeat(64),
        replicaCount: 2,
        recoveredFrom: '/replica/primary'
      }
    },
    nextRequiredActions: ['separated_keys'],
    ...overrides
  });
}

function testBetaGateSummaryBlocksRealMoney() {
  const pkg = samplePackage();
  assert.deepStrictEqual(verifyBetaGatePackage(pkg), { ok: true, errors: [] });
  const status = summarizeBetaGate(pkg, { checkedAt: '2026-07-07T00:00:01.000Z' });
  assert.strictEqual(status.policyDecision, 'BLOCK_PRODUCTION_VALUE');
  assert.strictEqual(status.policyReason, 'real_money_gate_closed');
  assert.strictEqual(status.testnetContinueAllowed, true);
  assert.deepStrictEqual(status.failingGates, ['separated_keys']);
}

function testPackageTamperFailsHash() {
  const pkg = samplePackage();
  pkg.realMoneyAllowed = true;
  const verification = verifyBetaGatePackage(pkg);
  assert.strictEqual(verification.ok, false);
  assert(verification.errors.includes('beta gate package hash mismatch'));
}

function testAssetAttestationKeepsProductionOut() {
  const pkg = samplePackage();
  const attestation = buildAssetAttestation({
    betaGatePackage: pkg,
    amountSats: '20000',
    createdAt: '2026-07-07T00:00:02.000Z'
  });
  assert.strictEqual(attestation.productionEligible, false);
  assert.strictEqual(attestation.testnetEligible, true);
  assert.strictEqual(attestation.reserveInput.includeInProductionPoR, false);
  assert.strictEqual(attestation.reserveInput.includeInTestnetPoR, true);
}

function testSpendEvaluationRefusesClosedRealMoneyGate() {
  const pkg = samplePackage();
  const evaluation = evaluateSpendProposal({
    betaGatePackage: pkg,
    proposal: {
      vaultId: 'vault-1',
      amountSats: '1000',
      feeSats: '100',
      outputs: [{ address: 'tb1qallowed', sats: 1000 }],
      unsignedTxHash: 'd'.repeat(64)
    },
    policy: {
      allowTestnet: false,
      maxFeeSats: '200',
      maxPerContractSats: '5000'
    },
    evaluatedAt: '2026-07-07T00:00:03.000Z'
  });
  assert.strictEqual(evaluation.ok, false);
  assert(evaluation.errors.includes('real-money gate is closed'));
  assert.strictEqual(evaluation.guardianAction, 'REFUSE');
}

function testSpendEvaluationAllowsExactTestnetPolicy() {
  const pkg = samplePackage();
  const outputs = [{ address: 'tb1qallowed', sats: 1000 }];
  const evaluation = evaluateSpendProposal({
    betaGatePackage: pkg,
    proposal: {
      vaultId: 'vault-1',
      amountSats: '1000',
      feeSats: '100',
      outputs,
      unsignedTxHash: 'd'.repeat(64)
    },
    policy: {
      allowTestnet: true,
      maxFeeSats: '200',
      maxPerContractSats: '5000',
      requiredOutputHash: hashOutputs(outputs),
      allowedAddresses: ['tb1qallowed']
    },
    evaluatedAt: '2026-07-07T00:00:04.000Z'
  });
  assert.strictEqual(evaluation.ok, true);
  assert.strictEqual(evaluation.guardianAction, 'SIGN_EXACT_SIGHASH');
  assert.strictEqual(evaluation.approvedTxOutputHash, hashOutputs(outputs));
}

function testTaprootUsdWalletAssetIsTestnetOnly() {
  const pkg = samplePackage();
  const asset = buildTaprootUsdWalletAsset({
    betaGatePackage: pkg,
    autoRollState: {
      contract: {
        core: {
          contractId: 'rbtc-hour-listener-wallclock-001',
          expiresAtUnix: 1783380977
        }
      },
      decision: {
        policy: { canAutoRoll: true },
        observation: { core: { balanceReduced: false } },
        selectedCet: { selection: { outcomeId: 'roll' } }
      },
      tx30Intent: {
        dlcRef: 'rbtc-hour-listener-wallclock-001',
        nextDlcRef: 'rbtc-hour-listener-wallclock-002',
        settlementState: 'ROLLED',
        relayBlobHash: 'e'.repeat(64)
      }
    },
    createdAt: '2026-07-07T00:00:05.000Z'
  });
  assert.strictEqual(asset.walletProduct, 'taproot_usd');
  assert.strictEqual(asset.walletAvailability.showInWallet, true);
  assert.strictEqual(asset.walletAvailability.allowProductionValue, false);
  assert.strictEqual(asset.tradeLayerBinding.autoRoll.contractId, 'rbtc-hour-listener-wallclock-001');
  assert.strictEqual(asset.tradeLayerBinding.autoRoll.nextContractId, 'rbtc-hour-listener-wallclock-002');
  assert.strictEqual(asset.tradeLayerBinding.autoRoll.selectedOutcomeId, 'roll');
  assert.strictEqual(asset.backingModel.reserveEvidence, 'UTXORef Taproot reserve vault');
  assert(asset.crossReferences.lnToVaultFunding.prototypeModules.includes('bitvm3/utxo_referee/utxoref_dlc_subswap_funding.js'));
  assert(asset.crossReferences.tradeLayerTaprootMinting.prototypeModules.includes('bitvm3/utxo_referee/lightning_taproot_assets_stablecoin.js'));
}

function testPrototypeCrossReferencesBindSubswapAndMinting() {
  const crossRef = buildPrototypeCrossReferences({
    createdAt: '2026-07-07T00:00:06.000Z',
    reserveOutpoint: `${'a'.repeat(64)}:0`,
    assetTicker: 'tUSD'
  });
  assert.strictEqual(crossRef.kind, 'betweenbits_taproot_usd_cross_reference_v1');
  assert(crossRef.lnToVaultFunding.artifactKinds.includes('utxoref_dlc_subswap_funding_request'));
  assert(crossRef.lnToVaultFunding.walletFlow.includes('pay_ln_invoice'));
  assert(crossRef.tradeLayerTaprootMinting.artifactKinds.includes('taproot_asset_proof_commitment'));
  assert(crossRef.tradeLayerTaprootMinting.mintFlow.includes('observe_tradelayer_rbtc_balance_and_derivative_state'));
  assert.strictEqual(crossRef.tradeLayerTaprootMinting.assetBinding.ticker, 'tUSD');
}

const tests = [
  testBetaGateSummaryBlocksRealMoney,
  testPackageTamperFailsHash,
  testAssetAttestationKeepsProductionOut,
  testSpendEvaluationRefusesClosedRealMoneyGate,
  testSpendEvaluationAllowsExactTestnetPolicy,
  testTaprootUsdWalletAssetIsTestnetOnly,
  testPrototypeCrossReferencesBindSubswapAndMinting
];

for (const test of tests) test();
console.log(`betweenbits-utxoref-adapter tests passed (${tests.length}/${tests.length})`);
