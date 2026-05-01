#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
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

function buildSweepTxSkeleton(routePlan) {
  return {
    status: 'planned',
    inputs: [
      {
        txid: routePlan.dlcInput.txid,
        vout: routePlan.dlcInput.vout,
        address: routePlan.dlcInput.address || null,
        sats: String(routePlan.dlcInput.sats)
      }
    ],
    outputs: routePlan.outputPlan.map(output => ({
      address: output.address,
      sats: String(output.sats),
      role: output.role || null
    })),
    feeSats: String(routePlan.feeSats || 0)
  };
}

function buildArtifact(stateOracleBlob, cliArgs) {
  const options = {
    sendId: cliArgs.sendId,
    sendTxid: cliArgs.sendTxid,
    sendIndex: cliArgs.sendIndex,
    requireOracleSignature: cliArgs.requireOracleSignature
  };
  Object.keys(options).forEach((key) => options[key] === undefined && delete options[key]);

  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, options);
  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, options);
  const routePlan = buildTradeLayerSendRoutePlan(sendIntent, options);
  const commitmentBundle = buildTradeLayerPnlCommitment(routePlan);
  const verification = verifyTradeLayerSendStateOracleRoute(stateOracleBlob, options);
  const oracleSignature = verifyTradeLayerSendOracleSignature(stateOracleBlob, options);
  const expectedSweepOutputs = routePlan.outputPlan.map(output => outputWithScript(output, routePlan.network));

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
    sweepTx: {
      ...buildSweepTxSkeleton(routePlan),
      liveTxid: cliArgs.txid || null,
      signedPsbt: cliArgs.psbt || null
    },
    verification
  };

  artifact.artifactHash = sha256Hex(stableStringify({
    kind: artifact.kind,
    network: artifact.network,
    selectedSend: artifact.selectedSend,
    oracle: artifact.oracle,
    routePlan: artifact.routePlan,
    commitment: artifact.commitment,
    expectedSweepOutputs: artifact.expectedSweepOutputs,
    sweepTx: artifact.sweepTx,
    verification: artifact.verification
  }));

  return artifact;
}

function main() {
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
  const artifact = buildArtifact(stateOracleBlob, cliArgs);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${stringifyJson(artifact)}\n`);

  console.log('TradeLayer send BitVM e2e artifact written:');
  console.log(`  ${outPath}`);
  console.log(`verification=${artifact.verification.ok ? 'ok' : artifact.verification.reason}`);
  console.log(`stateOracleHash=${artifact.oracle.stateOracleHash}`);
  console.log(`selectedSendHash=${artifact.selectedSend.sendRecordHash}`);
  console.log(`registryHash=${artifact.oracle.dlcFunderRegistryHash}`);
  console.log(`commitmentHash=${artifact.commitment.commitmentHashHex}`);
  console.log(`artifactHash=${artifact.artifactHash}`);

  if (!artifact.verification.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`TradeLayer send BitVM e2e failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  SAMPLE_STATE_ORACLE,
  buildArtifact
};
