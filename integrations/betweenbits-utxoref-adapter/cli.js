#!/usr/bin/env node

const {
  loadLiveArtifacts,
  summarizeBetaGate,
  buildAssetAttestation,
  buildTaprootUsdWalletAsset,
  evaluateSpendProposal
} = require('./index');

function argValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function main() {
  const command = process.argv[2] || 'status';
  const artifactsDir = argValue('artifacts-dir') || process.env.UTXOREF_ARTIFACTS_DIR;
  const { artifacts } = loadLiveArtifacts({ artifactsDir });
  const betaGatePackage = artifacts.betaGatePackage;

  if (command === 'status') {
    print(summarizeBetaGate(betaGatePackage));
    return;
  }
  if (command === 'attest') {
    print(buildAssetAttestation({
      betaGatePackage,
      reserveVault: artifacts.reserveVault,
      institutionId: argValue('institution-id') || undefined,
      assetCode: argValue('asset-code') || undefined,
      amountSats: argValue('amount-sats') || undefined
    }));
    return;
  }
  if (command === 'wallet-asset') {
    print(buildTaprootUsdWalletAsset({
      betaGatePackage,
      reserveVault: artifacts.reserveVault,
      autoRollState: artifacts.autoRollState,
      ticker: argValue('ticker') || undefined,
      displayName: argValue('display-name') || undefined
    }));
    return;
  }
  if (command === 'evaluate-spend') {
    const proposal = {
      vaultId: argValue('vault-id') || 'demo-vault',
      amountSats: argValue('amount-sats') || '1000',
      feeSats: argValue('fee-sats') || '150',
      outputs: [{ address: argValue('to') || 'tb1qdestination', sats: Number(argValue('amount-sats') || 1000) }],
      unsignedTxHash: argValue('unsigned-tx-hash') || null
    };
    const policy = {
      allowTestnet: process.argv.includes('--allow-testnet'),
      maxFeeSats: argValue('max-fee-sats') || '500',
      maxPerContractSats: argValue('max-per-contract-sats') || '20000'
    };
    print(evaluateSpendProposal({ betaGatePackage, proposal, policy }));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
