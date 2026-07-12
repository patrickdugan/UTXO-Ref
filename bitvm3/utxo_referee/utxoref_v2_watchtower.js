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
const { txidFromUnsignedHex } = require('./recover_btc_testnet4_reserve_vault');

const DEFAULT_ARTIFACT = path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_utxoref_v2_latest.json');
const DEFAULT_STATE_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_state.json');
const DEFAULT_ALERT_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_alerts.jsonl');
const DEFAULT_POLL_INTERVAL_MS = 30000;

function parseArgs(argv) {
  const args = { once: false, broadcast: false, replaceChallenge: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--once') { args.once = true; continue; }
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (arg === '--replace-challenge') { args.replaceChallenge = true; continue; }
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
    '    --challenge-address <tb1...> --fee-sats 1000 \\',
    '    --fee-step-sats 500 --max-fee-sats 5000 --broadcast',
    '',
    'Replace a tracked unconfirmed challenge at the next bounded fee:',
    '  node utxoref_v2_watchtower.js --once --replace-challenge --broadcast \\',
    '    --challenger-secret-file <path> --artifact <public-artifact.json> \\',
    '    --fee-sats 1000 --fee-step-sats 500 --max-fee-sats 5000',
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

function deterministicChallengeAux(graphHash, evidence) {
  const normalizedGraphHash = String(graphHash || '').toLowerCase();
  const scriptHex = String(evidence?.scriptHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedGraphHash)) throw new Error('graphHash must be 32 bytes of hex');
  if (!/^[0-9a-f]+$/.test(scriptHex) || scriptHex.length % 2) throw new Error('fraud evidence script must be even-length hex');
  return crypto.createHash('sha256')
    .update('UTXOREF_V2_WATCHTOWER_CHALLENGE_AUX\0', 'ascii')
    .update(Buffer.from(normalizedGraphHash, 'hex'))
    .update(Buffer.from(scriptHex, 'hex'))
    .digest();
}

function safePositiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${fieldName} must be a positive safe integer`);
  return parsed;
}

function feeCandidates(args, assertionAmountSats) {
  const start = safePositiveInteger(args.feeSats || 1000, 'feeSats');
  const step = safePositiveInteger(args.feeStepSats || 500, 'feeStepSats');
  const maximum = safePositiveInteger(args.maxFeeSats || start, 'maxFeeSats');
  const amount = BigInt(assertionAmountSats);
  if (maximum < start) throw new Error('maxFeeSats must be at least feeSats');
  if (BigInt(maximum) > amount - 330n) throw new Error('maxFeeSats would reduce the challenge output below the dust floor');
  const count = Math.floor((maximum - start) / step) + 1;
  if (count > 32) throw new Error('fee policy may contain at most 32 attempts');
  const candidates = [];
  for (let fee = start; fee <= maximum; fee += step) candidates.push(String(fee));
  if (candidates[candidates.length - 1] !== String(maximum)) candidates.push(String(maximum));
  return candidates;
}

function mempoolRejectReason(result) {
  return String(result?.['reject-reason'] || result?.reject_reason || result?.rejectReason || '');
}

function isFeePolicyReject(result) {
  return /fee|feerate|min relay|mempool min/i.test(mempoolRejectReason(result));
}

function isFeePolicyError(err) {
  return /fee|feerate|min relay|mempool min|does not pay for its bandwidth/i.test(String(err?.message || err || ''));
}

function replacementFeeCandidates(args, assertionAmountSats, currentFeeSats) {
  const current = safePositiveInteger(currentFeeSats, 'currentFeeSats');
  return feeCandidates(args, assertionAmountSats).filter((candidate) => Number(candidate) > current);
}

function deriveChallengeLifecycle(input = {}) {
  const txout = input.txout || null;
  const prior = input.priorConfirmation || null;
  if (txout) {
    const confirmations = Number(txout.confirmations || 0);
    if (confirmations <= 0) {
      return { action: 'challenge_in_mempool', confirmations: 0, confirmation: null, reorgDetected: Boolean(prior) };
    }
    const height = Number(input.currentHeight) - confirmations + 1;
    const blockHash = String(input.inclusionBlockHash || '');
    if (!Number.isSafeInteger(height) || height < 0 || !/^[0-9a-f]{64}$/.test(blockHash)) {
      throw new Error('confirmed challenge requires a valid inclusion height and block hash');
    }
    const confirmation = { height, blockHash, confirmations };
    const reorgDetected = Boolean(prior) && (prior.height !== height || prior.blockHash !== blockHash);
    return {
      action: reorgDetected ? 'challenge_reconfirmed' : 'challenge_confirmed',
      confirmations,
      confirmation,
      reorgDetected
    };
  }
  if (prior) {
    const active = String(input.activeHashAtPriorHeight || '');
    const reorgDetected = active !== prior.blockHash;
    return {
      action: reorgDetected ? 'challenge_reorged' : 'challenge_output_spent_or_missing',
      confirmations: 0,
      confirmation: prior,
      reorgDetected
    };
  }
  return { action: 'challenge_missing', confirmations: 0, confirmation: null, reorgDetected: false };
}

async function monitorChallenge(rpc, state, currentHeight) {
  const challenge = state.challenge;
  const tracked = challenge?.cpfp?.txid ? challenge.cpfp : challenge;
  if (!tracked?.txid) return null;
  const role = tracked === challenge ? 'challenge' : 'cpfp';
  const txout = await rpc('gettxout', [tracked.txid, Number(tracked.vout || 0), true]);
  let inclusionBlockHash = null;
  let activeHashAtPriorHeight = null;
  if (txout && Number(txout.confirmations || 0) > 0) {
    const inclusionHeight = currentHeight - Number(txout.confirmations) + 1;
    inclusionBlockHash = await rpc('getblockhash', [inclusionHeight]);
  } else if (!txout && tracked.confirmation) {
    activeHashAtPriorHeight = await rpc('getblockhash', [tracked.confirmation.height]).catch(() => null);
  }
  const lifecycle = deriveChallengeLifecycle({
    currentHeight,
    txout,
    priorConfirmation: tracked.confirmation || null,
    inclusionBlockHash,
    activeHashAtPriorHeight
  });
  if (lifecycle.confirmation && lifecycle.action !== 'challenge_reorged') {
    tracked.confirmation = lifecycle.confirmation;
  } else if (lifecycle.action === 'challenge_in_mempool' && tracked.confirmation) {
    tracked.confirmationHistory = [
      ...(tracked.confirmationHistory || []),
      { ...tracked.confirmation, removedAt: new Date().toISOString(), reason: 'reorged-to-mempool' }
    ];
    tracked.confirmation = null;
  }
  tracked.lastObservedAt = new Date().toISOString();
  tracked.lastAction = lifecycle.action;
  return { txid: tracked.txid, vout: Number(tracked.vout || 0), role, ...lifecycle };
}

async function prepareChallenge(artifact, inspected, args, rpc) {
  const attempts = [];
  let selected = null;
  for (const feeSats of feeCandidates(args, inspected.assertionOutpoint.amountSats)) {
    const disprove = buildBitvmDisproveV2(artifact.graph, {
      stateVerification: verificationOptions(artifact),
      challengerSecret: parseSecretFile(args.challengerSecretFile),
      challengerAux: deterministicChallengeAux(inspected.graphHash, inspected.evidence),
      feeSats,
      challengeScriptPubKeyHex: challengeScript(args)
    });
    const [mempoolAccept] = await rpc('testmempoolaccept', [[disprove.witnessTxHex]]);
    const attempt = {
      feeSats,
      txid: txidFromUnsignedHex(disprove.unsignedTxHex),
      wtxid: mempoolAccept?.wtxid || null,
      allowed: mempoolAccept?.allowed === true,
      rejectReason: mempoolRejectReason(mempoolAccept) || null,
      vsize: mempoolAccept?.vsize || null
    };
    attempts.push(attempt);
    selected = { disprove, mempoolAccept, feeSats, attempt };
    if (attempt.allowed || !isFeePolicyReject(mempoolAccept)) break;
  }
  return { ...selected, attempts };
}

function buildChallengeAtFee(artifact, inspected, args, feeSats, scriptPubKeyHex) {
  return buildBitvmDisproveV2(artifact.graph, {
    stateVerification: verificationOptions(artifact),
    challengerSecret: parseSecretFile(args.challengerSecretFile),
    challengerAux: deterministicChallengeAux(inspected.graphHash, inspected.evidence),
    feeSats,
    challengeScriptPubKeyHex: scriptPubKeyHex
  });
}

async function replaceTrackedChallenge(artifact, inspected, args, rpc, state) {
  const tracked = state.challenge;
  if (!tracked || tracked.graphHash !== inspected.graphHash) throw new Error('no challenge for this graph is tracked');
  if (tracked.cpfp?.txid) throw new Error('the challenge has a tracked CPFP child and can no longer be replaced directly');
  if (tracked.confirmation) throw new Error('a confirmed challenge cannot be fee-replaced');
  const scriptPubKeyHex = tracked.challengeScriptPubKeyHex || challengeScript(args);
  if (args.challengeAddress || args.challengeScriptPubKeyHex) {
    const requestedScript = challengeScript(args);
    if (requestedScript !== scriptPubKeyHex) throw new Error('replacement challenge destination must match the tracked transaction');
  }
  const candidates = replacementFeeCandidates(args, inspected.assertionOutpoint.amountSats, tracked.feeSats);
  if (!candidates.length) {
    return { action: 'challenge_replacement_exhausted', attempts: [], challenge: tracked };
  }

  const attempts = [];
  for (const feeSats of candidates) {
    const disprove = buildChallengeAtFee(artifact, inspected, args, feeSats, scriptPubKeyHex);
    const txid = txidFromUnsignedHex(disprove.unsignedTxHex);
    try {
      const broadcastTxid = await rpc('sendrawtransaction', [disprove.witnessTxHex]);
      if (broadcastTxid !== txid) throw new Error(`replacement txid mismatch: expected ${txid}, got ${broadcastTxid}`);
      const replaced = {
        txid: tracked.txid,
        wtxid: tracked.wtxid || null,
        feeSats: String(tracked.feeSats),
        outputSats: String(tracked.outputSats),
        replacedAt: new Date().toISOString(),
        replacementTxid: txid
      };
      tracked.replacements = [...(tracked.replacements || []), replaced];
      tracked.txid = txid;
      tracked.wtxid = null;
      tracked.feeSats = feeSats;
      tracked.outputSats = (BigInt(inspected.assertionOutpoint.amountSats) - BigInt(feeSats)).toString();
      tracked.broadcastAt = replaced.replacedAt;
      tracked.lastObservedAt = replaced.replacedAt;
      tracked.lastAction = 'challenge_replaced';
      tracked.confirmation = null;
      attempts.push({ feeSats, txid, allowed: true, rejectReason: null });
      return { action: 'challenge_replaced', attempts, challenge: tracked };
    } catch (err) {
      attempts.push({ feeSats, txid, allowed: false, rejectReason: err.message });
      if (!isFeePolicyError(err)) {
        return { action: 'challenge_replacement_rejected', attempts, challenge: tracked };
      }
    }
  }
  return { action: 'challenge_replacement_exhausted', attempts, challenge: tracked };
}

function alertFingerprint(result) {
  return crypto.createHash('sha256').update(JSON.stringify({
    graphHash: result.graphHash,
    fraudType: result.fraudType,
    assertionUnspent: result.assertionUnspent,
    action: result.action,
    challengeTxid: result.challenge?.txid || result.disprove?.broadcastTxid || null
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

  if (!txout && state.challenge?.graphHash === inspected.graphHash) {
    result.challenge = await monitorChallenge(rpc, state, currentHeight);
    result.action = result.challenge.action;
    if (args.replaceChallenge) {
      if (result.action !== 'challenge_in_mempool') {
        throw new Error(`challenge replacement requires an unconfirmed tracked challenge, got ${result.action}`);
      }
      const replacement = await replaceTrackedChallenge(artifact, inspected, args, rpc, state);
      result.action = replacement.action;
      result.challenge = replacement.challenge;
      result.replacementAttempts = replacement.attempts;
    }
  }

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
      const prepared = await prepareChallenge(artifact, inspected, args, rpc);
      const { disprove, mempoolAccept, feeSats, attempts } = prepared;
      result.disprove = {
        txid: txidFromUnsignedHex(disprove.unsignedTxHex),
        leafId: disprove.leafId,
        fraudType: disprove.fraudType,
        feeSats,
        feeAttempts: attempts,
        mempoolAccept
      };
      if (!mempoolAccept.allowed) {
        result.action = 'challenge_preflight_rejected';
      } else if (args.broadcast) {
        result.disprove.broadcastTxid = await rpc('sendrawtransaction', [disprove.witnessTxHex]);
        result.action = 'challenge_broadcast';
        state.challenge = {
          graphHash: inspected.graphHash,
          txid: result.disprove.broadcastTxid,
          wtxid: mempoolAccept.wtxid || null,
          vout: 0,
          outputSats: (BigInt(inspected.assertionOutpoint.amountSats) - BigInt(feeSats)).toString(),
          feeSats,
          challengeAddress: args.challengeAddress || null,
          challengeScriptPubKeyHex: disprove.challengeScriptPubKeyHex,
          broadcastAt: result.at,
          confirmation: null,
          replacements: []
        };
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
  if (args.replaceChallenge && !args.broadcast) {
    throw new Error('--replace-challenge requires --broadcast');
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
  deterministicChallengeAux,
  feeCandidates,
  isFeePolicyReject,
  isFeePolicyError,
  replacementFeeCandidates,
  deriveChallengeLifecycle,
  monitorChallenge,
  prepareChallenge,
  buildChallengeAtFee,
  replaceTrackedChallenge,
  runTick,
  saveJsonAtomic,
  loadState
};
