const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createServer } = require('./server');
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

const CAPS = { maxFeeSats: '200', maxPerContractSats: '5000' };

function openPolicy(outputs, overrides = {}) {
  return {
    betaGatePackage: samplePackage(),
    proposal: { vaultId: 'vault-1', amountSats: '1000', feeSats: '100', outputs, unsignedTxHash: 'd'.repeat(64) },
    policy: { allowTestnet: true, ...CAPS, allowedAddresses: ['tb1qallowed'], ...overrides },
    evaluatedAt: '2026-07-07T00:00:03.500Z'
  };
}

// The approved output hash is computed from the outputs the guardian signs. A proposal cannot name a hash for
// outputs that differ from the ones it carries.
function testSpendEvaluationBindsOutputs() {
  const honest = [{ address: 'tb1qallowed', sats: 1000 }];
  const attacker = [{ address: 'tb1qattacker', sats: 1000 }];
  const forgedHash = evaluateSpendProposal({
    ...openPolicy(attacker),
    proposal: { ...openPolicy(attacker).proposal, outputHash: hashOutputs(honest) }
  });
  assert.strictEqual(forgedHash.ok, false);
  assert.ok(forgedHash.errors.includes('proposal outputHash does not match its outputs'));
  assert.ok(forgedHash.errors.includes('output address not allowed: tb1qattacker'));
  assert.strictEqual(forgedHash.approvedTxOutputHash, null);

  const emptyOutputs = evaluateSpendProposal(openPolicy([], {
    requiredOutputHash: hashOutputs(honest)
  }));
  assert.strictEqual(emptyOutputs.ok, false, 'a proposal with no outputs must not pass an output pin');
  assert.ok(emptyOutputs.errors.includes('proposal needs at least one output with a whole-satoshi amount'));

  const approved = evaluateSpendProposal(openPolicy(honest));
  assert.strictEqual(approved.ok, true);
  assert.strictEqual(approved.approvedTxOutputHash, hashOutputs(honest));
}

// The cap applies to what leaves the vault: the outputs count even when the proposal states a small amount.
function testSpendEvaluationCapsCoverOutputsAndSignedAmounts() {
  const oversized = evaluateSpendProposal(openPolicy([{ address: 'tb1qallowed', sats: 999999 }]));
  assert.ok(oversized.errors.includes('proposal amount exceeds per-contract cap'));
  for (const feeSats of ['-5', '1e3', '0x10', 100.5]) {
    const evaluation = evaluateSpendProposal({
      ...openPolicy([{ address: 'tb1qallowed', sats: 1000 }]),
      proposal: { ...openPolicy([]).proposal, outputs: [{ address: 'tb1qallowed', sats: 1000 }], feeSats }
    });
    assert.ok(evaluation.errors.includes('proposal fee exceeds policy'), `fee ${JSON.stringify(feeSats)} was accepted`);
  }
  const negativeOutput = evaluateSpendProposal(openPolicy([{ address: 'tb1qallowed', sats: '-1' }]));
  assert.ok(negativeOutput.errors.includes('proposal needs at least one output with a whole-satoshi amount'));
}

// A policy without caps or an output pin is incomplete, and an incomplete policy approves nothing.
function testSpendEvaluationRequiresCapsAndPins() {
  const outputs = [{ address: 'tb1qallowed', sats: 1000 }];
  const bare = evaluateSpendProposal({
    betaGatePackage: samplePackage(),
    proposal: { vaultId: 'vault-1', amountSats: '1000', feeSats: '100', outputs },
    policy: { allowTestnet: true }
  });
  assert.strictEqual(bare.ok, false);
  assert.ok(bare.errors.includes('policy must set maxFeeSats'));
  assert.ok(bare.errors.includes('policy must set maxPerContractSats'));
  assert.ok(bare.errors.includes('policy must pin outputs with requiredOutputHash or allowedAddresses'));
}

async function testSpendEndpointRejectsMalformedBodies() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const post = (route, body) => fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body
    });
    const malformed = await post('/v1/watchtower/spend-proposals/evaluate', '{"proposal":');
    assert.strictEqual(malformed.status, 400);
    const notObject = await post('/v1/watchtower/spend-proposals/evaluate', '[1]');
    assert.strictEqual(notObject.status, 400);
  } finally {
    server.close();
  }
}

// The attestation's reserve amount comes from the reserve artifact, never from the request body.
async function testAttestationAmountComesFromReserveArtifact() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betweenbits-artifacts-'));
  try {
    fs.writeFileSync(path.join(dir, 'tradelayer_beta_gate_package_latest.json'), JSON.stringify(samplePackage()));
    fs.writeFileSync(path.join(dir, 'btc_testnet4_reserve_vault_latest.json'), JSON.stringify({ amountSats: '20000' }));
    const server = createServer({ artifactsDir: dir, spendPolicy: {} });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/bitcert/asset-attestations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ institutionId: 'demo-bank', amountSats: '1' })
      });
      const attestation = await response.json();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(attestation.reserveInput.amountSats, '20000');
      assert.strictEqual(attestation.institutionId, 'demo-bank');
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

async function testSpendEvaluationIgnoresRequestPolicy() {
  const pkg = samplePackage();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/v1/watchtower/spend-proposals/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then((response) => response.json());
    const proposal = {
      vaultId: 'vault-1',
      amountSats: '999999999',
      feeSats: '100',
      outputs: [{ address: 'tb1qattacker', sats: 999999999 }],
      unsignedTxHash: 'd'.repeat(64)
    };
    const evaluation = await post({
      proposal,
      policy: { allowTestnet: true, requireConfirmedReserve: false, requireUnspentReserve: false }
    });
    assert.strictEqual(evaluation.ok, false);
    assert.strictEqual(evaluation.guardianAction, 'REFUSE');
    assert(evaluation.errors.includes('real-money gate is closed'));
    const oversize = await fetch(`http://127.0.0.1:${server.address().port}/v1/watchtower/spend-proposals/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: { memo: 'x'.repeat(1024 * 1024) } })
    });
    assert.strictEqual(oversize.status, 413);
  } finally {
    server.close();
  }
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
const asyncTests = [
  testSpendEvaluationIgnoresRequestPolicy,
  testSpendEndpointRejectsMalformedBodies,
  testAttestationAmountComesFromReserveArtifact
];
for (const test of [testSpendEvaluationBindsOutputs, testSpendEvaluationCapsCoverOutputsAndSignedAmounts, testSpendEvaluationRequiresCapsAndPins]) test();
(async () => {
  for (const test of asyncTests) await test();
  const count = tests.length + 3 + asyncTests.length;
  console.log(`betweenbits-utxoref-adapter tests passed (${count}/${count})`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
