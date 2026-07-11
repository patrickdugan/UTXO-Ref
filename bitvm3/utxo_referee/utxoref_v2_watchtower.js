#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { addressToScriptPubKey } = require('./tradelayer_pnl_route_adapter');
const {
  findGateDisproveV2,
  findInputBindingDisproveV2
} = require('./bitvm_trace_v2');
const {
  buildBitvmDisproveV2,
  verifyBitvmAssertionGraphV2
} = require('./bitvm_assertion_graph_v2');

const DEFAULT_ARTIFACT = path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_utxoref_v2_latest.json');
const DEFAULT_STATE_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_state.json');
const DEFAULT_ALERT_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_alerts.jsonl');
const DEFAULT_POLL_INTERVAL_MS = 30000;

function parseArgs(argv) {
  const args = { once: false, broadcast: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--once') { args.once = true; continue; }
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    args[key] = value;
  }
  return args;
}

function usage() {
  return [
    'UTXORef V2 public-graph watchtower.',
    '',
    'Monitor only:',
    '  node utxoref_v2_watchtower.js --once --artifact <public-artifact.json>',
    '',
    'Testnet fraud seizure, only with an explicitly supplied challenger key:',
    '  node utxoref_v2_watchtower.js --once --challenger-secret-file <path> \\',
    '    --challenge-address <tb1...> --broadcast',
    '',
    'RPC credentials are read from BTC_RPC_URL, BTC_RPC_USER, and BTC_RPC_PASS,',
    'or passed as --rpc-url, --rpc-user, and --rpc-pass.'
  ].join('\n');
}

function readJson(filePath, fieldName) {
  if (!fs.existsSync(filePath)) throw new Error(`${fieldName} does not exist: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, filePath);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(value) + '\n');
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      kind: 'utxoref_v2_watchtower_state',
      startedAt: new Date().toISOString(),
      tickCount: 0,
      alertCount: 0,
      lastAlertFingerprint: null,
      lastStatus: null
    };
  }
  const existing = readJson(filePath, 'watchtower state');
  return { ...existing, resumedAt: new Date().toISOString(), restarts: Number(existing.restarts || 0) + 1 };
}

function parseSecretFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new Error('challenger secret must be exactly 32 bytes of hex');
  return text.toLowerCase();
}

function authorizationReference(artifact) {
  const authorization = artifact.verificationAtBroadcast || {
    height: artifact.chain?.snapshotHeight,
    blockHash: artifact.chain?.snapshotBlockHash,
    source: 'staged-snapshot'
  };
  if (!Number.isSafeInteger(authorization.height) || !authorization.blockHash) {
    throw new Error('artifact lacks a valid authorization or staging snapshot height');
  }
  return authorization;
}

function verificationOptions(artifact) {
  const publicKey = crypto.createPublicKey(artifact.keyCeremony?.stateSignerPublicKeyPem);
  const authorization = authorizationReference(artifact);
  return {
    trustedSigners: { [artifact.keyCeremony.stateSignerKeyId]: publicKey },
    expectedNetwork: 'bitcoin-testnet4',
    expectedGenesisHash: artifact.chain.genesisHash,
    currentHeight: authorization.height,
    maxAgeBlocks: 6
  };
}

function inspectArtifact(artifact) {
  if (artifact?.kind !== 'btc_testnet4_utxoref_v2_live_ceremony' || artifact.version !== 2) {
    throw new Error('wrong UTXORef V2 public artifact kind or version');
  }
  const options = verificationOptions(artifact);
  const authorization = authorizationReference(artifact);
  const verification = verifyBitvmAssertionGraphV2(artifact.graph, options);
  if (!verification.ok) throw new Error(`public assertion graph failed verification: ${verification.reason}`);
  const gateEvidence = findGateDisproveV2(artifact.graph.publicTrace, artifact.graph.template.challengerXonly);
  const inputEvidence = findInputBindingDisproveV2(
    artifact.graph.publicTrace,
    artifact.graph.template.expectedInputs,
    artifact.graph.template.challengerXonly
  );
  const evidence = gateEvidence || inputEvidence;
  return {
    graphHash: artifact.graph.graphHash,
    authorizationHeight: options.currentHeight,
    authorizationBlockHash: authorization.blockHash,
    authorizationSource: authorization.source || 'broadcast',
    assertionOutpoint: artifact.graph.assertionOutpoint,
    challengeCsvBlocks: artifact.graph.template.challengeCsvBlocks,
    recoveryCsvBlocks: artifact.graph.template.recoveryCsvBlocks,
    verification,
    fraudDetected: Boolean(evidence),
    fraudType: gateEvidence ? 'gate' : inputEvidence ? 'input' : null,
    evidence
  };
}

function resolveRpc(args) {
  const rpcUrl = args.rpcUrl || process.env.BTC_RPC_URL;
  const rpcUser = args.rpcUser || process.env.BTC_RPC_USER;
  const rpcPass = args.rpcPass || process.env.BTC_RPC_PASS;
  if (!rpcUrl || !rpcUser || !rpcPass) {
    throw new Error('watchtower requires BTC_RPC_URL, BTC_RPC_USER, and BTC_RPC_PASS');
  }
  return rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId: 'utxoref-v2-watchtower' });
}

function challengeScript(args) {
  if (args.challengeScriptPubKeyHex) {
    const text = String(args.challengeScriptPubKeyHex).toLowerCase();
    if (!/^[0-9a-f]+$/.test(text) || text.length % 2) throw new Error('challenge scriptPubKey must be even-length hex');
    return text;
  }
  if (!args.challengeAddress) throw new Error('a challenge address or scriptPubKey is required to prepare a disprove transaction');
  return addressToScriptPubKey(args.challengeAddress, 'bitcoin-testnet4').toString('hex');
}

function alertFingerprint(result) {
  return crypto.createHash('sha256').update(JSON.stringify({
    graphHash: result.graphHash,
    fraudType: result.fraudType,
    assertionUnspent: result.assertionUnspent,
    action: result.action
  })).digest('hex');
}

async function runTick(args, rpc, state) {
  const artifactPath = path.resolve(args.artifact || DEFAULT_ARTIFACT);
  const artifact = readJson(artifactPath, 'public artifact');
  const inspected = inspectArtifact(artifact);
  const chain = await rpc('getblockchaininfo');
  if (chain.chain !== 'testnet4') throw new Error(`wrong chain: ${chain.chain}`);
  const authorizationBlock = await rpc('getblockhash', [inspected.authorizationHeight]);
  if (authorizationBlock !== inspected.authorizationBlockHash) {
    throw new Error('artifact authorization block is not in the active chain');
  }
  const assertion = inspected.assertionOutpoint;
  const txout = await rpc('gettxout', [assertion.txid, assertion.vout, true]);
  const currentHeight = Number(chain.blocks);
  const confirmationCount = Number(txout?.confirmations || 0);
  const result = {
    kind: 'utxoref_v2_watchtower_tick',
    at: new Date().toISOString(),
    graphHash: inspected.graphHash,
    height: currentHeight,
    assertionOutpoint: `${assertion.txid}:${assertion.vout}`,
    assertionUnspent: Boolean(txout),
    assertionConfirmations: confirmationCount,
    fraudDetected: inspected.fraudDetected,
    fraudType: inspected.fraudType,
    action: inspected.fraudDetected && txout
      ? 'challenge_required'
      : txout
      ? 'monitoring'
      : artifact.status === 'staged'
      ? 'awaiting_funding_broadcast'
      : 'assertion_spent',
    disprove: null
  };

  if (inspected.fraudDetected && txout) {
    if (!args.challengerSecretFile) {
      result.action = 'challenge_signature_required';
      result.challengeRequest = {
        kind: 'utxoref_v2_challenge_sign_request',
        graphHash: inspected.graphHash,
        fraudType: inspected.fraudType,
        assertionOutpoint: result.assertionOutpoint,
        evidence: inspected.evidence,
        requiredAction: 'run a separately administered challenger signer'
      };
    } else {
      const disprove = buildBitvmDisproveV2(artifact.graph, {
        stateVerification: verificationOptions(artifact),
        challengerSecret: parseSecretFile(args.challengerSecretFile),
        feeSats: args.feeSats || '1000',
        challengeScriptPubKeyHex: challengeScript(args)
      });
      const [mempoolAccept] = await rpc('testmempoolaccept', [[disprove.witnessTxHex]]);
      result.disprove = {
        txid: require('./recover_btc_testnet4_reserve_vault').txidFromUnsignedHex(disprove.unsignedTxHex),
        leafId: disprove.leafId,
        fraudType: disprove.fraudType,
        mempoolAccept
      };
      if (!mempoolAccept.allowed) {
        result.action = 'challenge_preflight_rejected';
      } else if (args.broadcast) {
        result.disprove.broadcastTxid = await rpc('sendrawtransaction', [disprove.witnessTxHex]);
        result.action = 'challenge_broadcast';
      } else {
        result.action = 'challenge_ready_for_broadcast';
      }
    }
  }

  state.tickCount = Number(state.tickCount || 0) + 1;
  state.lastTickAt = result.at;
  state.lastStatus = result.action;
  state.lastHeight = currentHeight;
  const fingerprint = alertFingerprint(result);
  if (result.action !== 'monitoring' && result.action !== 'assertion_spent' && state.lastAlertFingerprint !== fingerprint) {
    state.alertCount = Number(state.alertCount || 0) + 1;
    state.lastAlertFingerprint = fingerprint;
    appendJsonLine(args.alertPath || DEFAULT_ALERT_PATH, result);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.broadcast && !args.challengerSecretFile) {
    throw new Error('--broadcast requires --challenger-secret-file');
  }
  const rpc = resolveRpc(args);
  const statePath = path.resolve(args.statePath || DEFAULT_STATE_PATH);
  const intervalMs = Number(args.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('poll interval must be at least 1000 ms');
  const state = loadState(statePath);
  do {
    try {
      const result = await runTick(args, rpc, state);
      delete state.lastError;
      console.log(JSON.stringify(result));
    } catch (err) {
      state.lastError = { at: new Date().toISOString(), message: err.message };
      console.error(`[utxoref-v2-watchtower] tick failed: ${err.message}`);
    }
    saveJsonAtomic(statePath, state);
    if (args.once) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef V2 watchtower failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  authorizationReference,
  verificationOptions,
  inspectArtifact,
  runTick,
  saveJsonAtomic,
  loadState
};
