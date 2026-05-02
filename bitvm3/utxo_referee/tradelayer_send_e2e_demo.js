#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { resolveChainEnv } = require('./m1_chain_env');
const {
  stableStringify,
  sha256Hex,
  addressToScriptPubKey,
  buildTradeLayerSendOracleCommitment,
  verifyTradeLayerSendOracleSignature,
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan,
  buildTradeLayerPnlCommitment,
  verifyTradeLayerSendStateOracleRoute
} = require('./tradelayer_pnl_route_adapter');
const {
  buildTradeLayerSendStateOracleFromConsensus
} = require('./tradelayer_send_oracle_extractor');
const {
  buildTradeLayerSendSweepPlan,
  verifyObservedSweepOutputs
} = require('./tradelayer_send_sweep_psbt');
const {
  buildTradeLayerSendFraudChallengeBundle,
  verifyTradeLayerSendFraudChallengeBundle
} = require('./tradelayer_send_fraud_challenges');
const {
  buildTradeLayerSendWalletFlow,
  verifyTradeLayerSendWalletFlow
} = require('./tradelayer_send_flow_model');
const {
  buildTradeLayerSendProductionPolicy,
  verifyTradeLayerSendProductionPolicy
} = require('./tradelayer_send_policy');
const {
  executeTradeLayerSendRpcSweep,
  attachRpcSweepToSweepPlan
} = require('./tradelayer_send_rpc_sweep');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DEFAULT_OUT = path.join(ARTIFACTS_DIR, 'tradelayer_send_e2e_latest.json');

const SAMPLE_STATE_ORACLE = {
  kind: 'tradelayer-send-state-oracle-v1',
  chain: 'litecoin-testnet',
  epochId: '42',
  snapshotHeight: 4695498,
  snapshotTxid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  oracleAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
  sends: [
    {
      id: 'send-1',
      txid: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      fromAddress: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
      toAddress: 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22',
      propertyId: 380,
      amountUnits: '2500',
      depositUnits: '10000'
    }
  ],
  dlcInputs: {
    'send-1': {
      txid: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      vout: 2,
      address: 'tltc1qn06nctkv2sm8wdjx5fe2x0zluxlyxynq3vud87hxsfv3u8kwdcaq0xvhqa',
      sats: 100000
    }
  },
  feeSats: 1000,
  dlcFunderRegistry: {
    tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22: {
      dlcRef: 'dlc-next-epoch-42',
      dlcAddress: 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz'
    }
  }
};

function usage() {
  return [
    'Usage: node bitvm3/utxo_referee/tradelayer_send_e2e_demo.js [options]',
    '',
    'Options:',
    '  --input <path>       State-oracle JSON blob. Uses built-in sample if omitted.',
    '  --tl-consensus-input <path>  TradeLayer consensus/history JSON to extract state oracle from.',
    '  --out <path>         Artifact output path.',
    '  --send-id <id>       Select send record by id.',
    '  --send-txid <txid>   Select send record by txid.',
    '  --send-index <n>     Select send record by array index.',
    '  --txid <txid>        Attach live sweep transaction id.',
    '  --psbt <base64>      Attach signed/final sweep PSBT.',
    '  --rpc-sweep          Use Core RPC to create/sign/finalize/test the sweep PSBT; does not broadcast.',
    '  --broadcast-sweep    Use Core RPC and broadcast the finalized sweep transaction.',
    '  --skip-sweep-preflight  Skip RPC gettxout/getaddressinfo checks before signing.',
    '  --external-sweep-signer  Do not require the configured wallet to sign the sweep input.',
    '  --rpc-url <url>      Override BITVM/LTC/BTC RPC URL for --rpc-sweep.',
    '  --rpc-user <user>    Override BITVM/LTC/BTC RPC user for --rpc-sweep.',
    '  --rpc-pass <pass>    Override BITVM/LTC/BTC RPC password for --rpc-sweep.',
    '  --rpc-wallet <name>  Override BITVM/LTC/BTC wallet for --rpc-sweep.',
    '  --require-oracle-signature  Require a valid Ed25519 oracle signature.',
    '  --help              Show this help.'
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--require-oracle-signature') {
      args.requireOracleSignature = true;
      continue;
    }
    if (arg === '--rpc-sweep') {
      args.rpcSweep = true;
      continue;
    }
    if (arg === '--broadcast-sweep') {
      args.rpcSweep = true;
      args.broadcastSweep = true;
      continue;
    }
    if (arg === '--skip-sweep-preflight') {
      args.skipSweepPreflight = true;
      continue;
    }
    if (arg === '--external-sweep-signer') {
      args.externalSweepSigner = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    args[key] = value;
    i++;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stringifyJson(value) {
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === 'bigint') return current.toString();
    if (Buffer.isBuffer(current)) return current.toString('hex');
    if (current && current.type === 'Buffer' && Array.isArray(current.data)) {
      return Buffer.from(current.data).toString('hex');
    }
    return current;
  }, 2);
}

function outputWithScript(output, network) {
  return {
    role: output.role || null,
    address: output.address || null,
    scriptPubKey: output.scriptPubKey || addressToScriptPubKey(output.address, network).toString('hex'),
    sats: String(output.sats),
    amountBps: output.amountBps ?? null,
    oracleAddress: output.oracleAddress || null,
    matchedDlcRef: output.matchedDlcRef || null
  };
}

function selectOptionsFromCli(cliArgs) {
  const options = {
    sendId: cliArgs.sendId,
    sendTxid: cliArgs.sendTxid,
    sendIndex: cliArgs.sendIndex,
    requireOracleSignature: cliArgs.requireOracleSignature
  };
  Object.keys(options).forEach((key) => options[key] === undefined && delete options[key]);
  return options;
}

function artifactHashInput(artifact) {
  return {
    kind: artifact.kind,
    network: artifact.network,
    selectedSend: artifact.selectedSend,
    oracle: artifact.oracle,
    routePlan: artifact.routePlan,
    commitment: artifact.commitment,
    expectedSweepOutputs: artifact.expectedSweepOutputs,
    sweepTx: artifact.sweepTx,
    observedSweep: artifact.observedSweep,
    rpcSweep: artifact.rpcSweep
      ? {
        status: artifact.rpcSweep.status,
        ok: artifact.rpcSweep.ok,
        broadcast: artifact.rpcSweep.broadcast,
        decodedTx: artifact.rpcSweep.decodedTx,
        mempoolAccept: artifact.rpcSweep.mempoolAccept,
        preflight: artifact.rpcSweep.preflight
          ? {
            ok: artifact.rpcSweep.preflight.ok,
            failedChecks: artifact.rpcSweep.preflight.failedChecks
          }
          : null
      }
      : null,
    fraudChallenges: {
      binding: artifact.fraudChallenges.binding,
      challengeRoot: artifact.fraudChallenges.challengeRoot,
      bundleHash: artifact.fraudChallenges.bundleHash
    },
    fraudChallengeVerification: artifact.fraudChallengeVerification,
    walletFlow: {
      flowHash: artifact.walletFlow.flowHash,
      destination: artifact.walletFlow.destination,
      live: artifact.walletFlow.live,
      verifier: artifact.walletFlow.verifier
    },
    walletFlowVerification: artifact.walletFlowVerification,
    productionPolicy: {
      policyHash: artifact.productionPolicy.policyHash,
      ok: artifact.productionPolicy.ok,
      walletAction: artifact.productionPolicy.walletAction,
      failedChecks: artifact.productionPolicy.failedChecks
    },
    productionPolicyVerification: artifact.productionPolicyVerification,
    verification: artifact.verification
  };
}

function refreshArtifactHash(artifact) {
  artifact.artifactHash = sha256Hex(stableStringify(artifactHashInput(artifact)));
  return artifact;
}

function buildArtifact(stateOracleBlob, cliArgs) {
  const options = selectOptionsFromCli(cliArgs);

  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, options);
  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, options);
  const routePlan = buildTradeLayerSendRoutePlan(sendIntent, options);
  const commitmentBundle = buildTradeLayerPnlCommitment(routePlan);
  const verification = verifyTradeLayerSendStateOracleRoute(stateOracleBlob, options);
  const oracleSignature = verifyTradeLayerSendOracleSignature(stateOracleBlob, options);
  const expectedSweepOutputs = routePlan.outputPlan.map(output => outputWithScript(output, routePlan.network));
  const sweepTx = buildTradeLayerSendSweepPlan(routePlan, {
    liveTxid: cliArgs.txid,
    signedPsbt: cliArgs.psbt
  });
  const observedSweep = verifyObservedSweepOutputs(routePlan, routePlan.outputPlan);
  const fraudChallenges = buildTradeLayerSendFraudChallengeBundle(stateOracleBlob, options);
  const fraudChallengeVerification = verifyTradeLayerSendFraudChallengeBundle(fraudChallenges);
  const walletFlow = buildTradeLayerSendWalletFlow(stateOracleBlob, {
    ...options,
    liveTxid: cliArgs.txid,
    signedPsbt: cliArgs.psbt,
    fraudChallengeBundle: fraudChallenges,
    sweepPlan: sweepTx,
    observedSweep
  });
  const walletFlowVerification = verifyTradeLayerSendWalletFlow(walletFlow);
  const productionPolicy = buildTradeLayerSendProductionPolicy(stateOracleBlob, {
    ...options,
    routePlan,
    observedOutputs: routePlan.outputPlan,
    requireOracleSignature: cliArgs.requireOracleSignature
  });
  const productionPolicyVerification = verifyTradeLayerSendProductionPolicy(productionPolicy);

  const artifact = {
    kind: 'tradelayer_send_bitvm_e2e',
    createdAt: new Date().toISOString(),
    network: routePlan.network,
    selectedSend: {
      id: oracleCommitment.selectedSendId,
      txid: oracleCommitment.selectedSendTxid,
      sendRecordHash: oracleCommitment.sendRecordHash
    },
    oracle: {
      stateOracleHash: oracleCommitment.oracleBlobHash,
      dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash,
      designatedOracleAddress: stateOracleBlob.oracleAddress || null,
      signature: {
        required: !!cliArgs.requireOracleSignature,
        ok: oracleSignature.ok,
        reason: oracleSignature.reason,
        algorithm: oracleSignature.algorithm || null,
        keyId: oracleSignature.keyId || null,
        payloadHash: oracleSignature.payloadHash || null
      }
    },
    routePlan,
    commitment: {
      epochId: commitmentBundle.epochId.toString(),
      withdrawalRootHex: commitmentBundle.withdrawalRootHex,
      commitmentHashHex: commitmentBundle.commitmentHashHex,
      payoutTotalSats: commitmentBundle.payoutTotalSats.toString()
    },
    expectedSweepOutputs,
    sweepTx,
    observedSweep,
    rpcSweep: null,
    fraudChallenges,
    fraudChallengeVerification,
    walletFlow,
    walletFlowVerification,
    productionPolicy,
    productionPolicyVerification,
    verification
  };

  return refreshArtifactHash(artifact);
}

function rpcSweepOptionsFromCli(cliArgs) {
  const chainEnv = resolveChainEnv();
  return {
    rpcUrl: cliArgs.rpcUrl || chainEnv.rpcUrl,
    rpcUser: cliArgs.rpcUser || chainEnv.rpcUser,
    rpcPass: cliArgs.rpcPass || chainEnv.rpcPass,
    wallet: cliArgs.rpcWallet || chainEnv.wallet,
    broadcast: !!cliArgs.broadcastSweep,
    preflight: !cliArgs.skipSweepPreflight,
    requireWalletSigner: !cliArgs.externalSweepSigner
  };
}

async function attachRpcSweepIfRequested(artifact, stateOracleBlob, cliArgs) {
  if (!cliArgs.rpcSweep) return artifact;

  const rpcOptions = rpcSweepOptionsFromCli(cliArgs);
  const rpcSweep = await executeTradeLayerSendRpcSweep(artifact.sweepTx, rpcOptions);
  artifact.rpcSweep = {
    ...rpcSweep,
    chain: {
      rpcUrl: rpcOptions.rpcUrl
    },
    wallet: rpcOptions.wallet
  };
  artifact.sweepTx = attachRpcSweepToSweepPlan(artifact.sweepTx, rpcSweep);

  const options = selectOptionsFromCli(cliArgs);
  artifact.walletFlow = buildTradeLayerSendWalletFlow(stateOracleBlob, {
    ...options,
    liveTxid: artifact.sweepTx.liveTxid,
    signedPsbt: artifact.sweepTx.signedPsbt,
    fraudChallengeBundle: artifact.fraudChallenges,
    sweepPlan: artifact.sweepTx,
    observedSweep: artifact.observedSweep
  });
  artifact.walletFlowVerification = verifyTradeLayerSendWalletFlow(artifact.walletFlow);

  return refreshArtifactHash(artifact);
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  if (cliArgs.help) {
    console.log(usage());
    return;
  }

  if (cliArgs.input && cliArgs.tlConsensusInput) {
    throw new Error('Use either --input or --tl-consensus-input, not both');
  }
  const inputPath = cliArgs.input ? path.resolve(cliArgs.input) : null;
  const consensusInputPath = cliArgs.tlConsensusInput ? path.resolve(cliArgs.tlConsensusInput) : null;
  const outPath = path.resolve(cliArgs.out || DEFAULT_OUT);
  const stateOracleBlob = consensusInputPath
    ? buildTradeLayerSendStateOracleFromConsensus(readJson(consensusInputPath), {
      selectedSendId: cliArgs.sendId,
      selectedSendTxid: cliArgs.sendTxid,
      feeSats: cliArgs.feeSats
    })
    : inputPath ? readJson(inputPath) : SAMPLE_STATE_ORACLE;
  const artifact = await attachRpcSweepIfRequested(
    buildArtifact(stateOracleBlob, cliArgs),
    stateOracleBlob,
    cliArgs
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${stringifyJson(artifact)}\n`);

  console.log('TradeLayer send BitVM e2e artifact written:');
  console.log(`  ${outPath}`);
  console.log(`verification=${artifact.verification.ok ? 'ok' : artifact.verification.reason}`);
  console.log(`stateOracleHash=${artifact.oracle.stateOracleHash}`);
  console.log(`selectedSendHash=${artifact.selectedSend.sendRecordHash}`);
  console.log(`registryHash=${artifact.oracle.dlcFunderRegistryHash}`);
  console.log(`commitmentHash=${artifact.commitment.commitmentHashHex}`);
  if (artifact.rpcSweep) {
    console.log(`rpcSweep=${artifact.rpcSweep.status} ok=${artifact.rpcSweep.ok}`);
    if (artifact.rpcSweep.broadcast?.txid) console.log(`sweepTxid=${artifact.rpcSweep.broadcast.txid}`);
    if (artifact.rpcSweep.error) console.log(`rpcSweepError=${artifact.rpcSweep.error}`);
  }
  console.log(`artifactHash=${artifact.artifactHash}`);

  if (!artifact.verification.ok || (artifact.rpcSweep && !artifact.rpcSweep.ok)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`TradeLayer send BitVM e2e failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  SAMPLE_STATE_ORACLE,
  buildArtifact,
  attachRpcSweepIfRequested
};
