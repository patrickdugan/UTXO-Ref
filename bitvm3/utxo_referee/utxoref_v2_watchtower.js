#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { addressToScriptPubKey } = require('./tradelayer_pnl_route_adapter');
const tr = require('./tradelayer_taproot');
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
const DEFAULT_TRUST_POLICY = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_trust_policy.json');
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
    '  node utxoref_v2_watchtower.js --once --artifact <public-artifact.json> \\',
    '    --trust-policy <externally-pinned-policy.json>',
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

function trustBindingForArtifact(artifact, trustPolicy) {
  if (trustPolicy?.kind !== 'utxoref_v2_watchtower_trust_policy' || trustPolicy.version !== 1) {
    throw new Error('wrong UTXORef V2 trust policy kind or version');
  }
  const network = String(trustPolicy.network || '');
  const genesisHash = String(trustPolicy.genesisHash || '').toLowerCase();
  if (network !== 'bitcoin-testnet4' || !/^[0-9a-f]{64}$/.test(genesisHash)) {
    throw new Error('trust policy network or genesis hash is invalid');
  }
  if (artifact.chain?.genesisHash !== genesisHash) throw new Error('artifact genesis hash is not externally trusted');
  const graphHash = String(artifact.graph?.graphHash || '').toLowerCase();
  const graphPolicy = trustPolicy.allowedGraphs?.[graphHash];
  if (!graphPolicy) throw new Error('artifact graph hash is not externally allowlisted');
  const signerKeyId = String(graphPolicy.signerKeyId || '');
  if (artifact.keyCeremony?.stateSignerKeyId !== signerKeyId) throw new Error('artifact signer is not trusted for this graph');
  const publicKeyPem = trustPolicy.trustedSigners?.[signerKeyId];
  if (!publicKeyPem) throw new Error('trust policy lacks the graph signer public key');
  const publicKey = crypto.createPublicKey(publicKeyPem);
  const canonicalPem = publicKey.export({ type: 'spki', format: 'pem' });
  if (artifact.keyCeremony?.stateSignerPublicKeyPem !== canonicalPem) {
    throw new Error('artifact signer public key differs from the external trust policy');
  }
  return { network, genesisHash, graphHash, signerKeyId, publicKey, policyId: trustPolicy.policyId || null };
}

function verificationOptions(artifact, trustPolicy) {
  const trust = trustBindingForArtifact(artifact, trustPolicy);
  const authorization = authorizationReference(artifact);
  return {
    trustedSigners: { [trust.signerKeyId]: trust.publicKey },
    expectedNetwork: trust.network,
    expectedGenesisHash: trust.genesisHash,
    currentHeight: authorization.height,
    maxAgeBlocks: 6
  };
}

function challengeStateBindsArtifact(artifact, state) {
  try {
    const tracked = state?.challenge;
    const assertion = artifact.graph.assertionOutpoint;
    if (!tracked || tracked.graphHash !== artifact.graph.graphHash || Number(tracked.vout || 0) !== 0) return false;
    const outputSats = BigInt(tracked.outputSats);
    const feeSats = BigInt(tracked.feeSats);
    if (outputSats <= 0n || feeSats <= 0n || outputSats + feeSats !== BigInt(assertion.amountSats)) return false;
    const script = String(tracked.challengeScriptPubKeyHex || '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(script) || script.length % 2) return false;
    const unsigned = tr.serializeUnsignedTx(2, [{
      outpoint: tr.outpoint(assertion.txid, assertion.vout),
      sequence: 0xfffffffd
    }], [{ valueSats: outputSats, script }], 0);
    return txidFromUnsignedHex(unsigned) === tracked.txid;
  } catch (_err) {
    return false;
  }
}

function authorizationPolicy(inspected, activeBlockHash, state, currentHeight, artifact) {
  const reorged = activeBlockHash !== inspected.authorizationBlockHash;
  const snapshotHeight = Number(inspected.stateSnapshotHeight);
  const ageBlocks = Number(currentHeight) - snapshotHeight;
  const stale = !Number.isSafeInteger(ageBlocks) || ageBlocks < 0 || ageBlocks > 6;
  const tracked = challengeStateBindsArtifact(artifact, state);
  return {
    reorged,
    stale,
    ageBlocks,
    tracked,
    monitoringOnly: (reorged || stale) && tracked,
    authorizedForNewChallenge: !reorged && !stale
  };
}

function inspectArtifact(artifact, trustPolicy) {
  if (artifact?.kind !== 'btc_testnet4_utxoref_v2_live_ceremony' || artifact.version !== 2) {
    throw new Error('wrong UTXORef V2 public artifact kind or version');
  }
  const options = verificationOptions(artifact, trustPolicy);
  const trust = trustBindingForArtifact(artifact, trustPolicy);
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
    stateSnapshotHeight: Number(artifact.graph.settlement?.stateEnvelope?.body?.snapshotHeight),
    trustPolicyId: trust.policyId,
    trustPolicy,
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
  let script;
  if (args.challengeScriptPubKeyHex) {
    const text = String(args.challengeScriptPubKeyHex).toLowerCase();
    if (!/^[0-9a-f]+$/.test(text) || text.length % 2) throw new Error('challenge scriptPubKey must be even-length hex');
    script = text;
  } else {
    if (!args.challengeAddress) throw new Error('a challenge address or scriptPubKey is required to prepare a disprove transaction');
    script = addressToScriptPubKey(args.challengeAddress, 'bitcoin-testnet4').toString('hex');
  }
  if (!/^(0014[0-9a-f]{40}|5120[0-9a-f]{64})$/.test(script)) {
    throw new Error('challenge destination must be native P2WPKH or P2TR');
  }
  return script;
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

function coreValueToSats(value) {
  const text = Number(value).toFixed(8);
  if (!/^[0-9]+\.[0-9]{8}$/.test(text)) throw new Error('Core returned an invalid BTC amount');
  const [whole, fraction] = text.split('.');
  return BigInt(whole) * 100000000n + BigInt(fraction);
}

function assertTrackedOutputBinding(challenge, tracked, txout) {
  const expectedScript = String(tracked.scriptPubKeyHex || challenge.challengeScriptPubKeyHex || '').toLowerCase();
  if (!expectedScript) throw new Error('tracked challenge output has no bound scriptPubKey');
  if (coreValueToSats(txout.value) !== BigInt(tracked.outputSats)) {
    throw new Error('tracked challenge output amount does not match Core');
  }
  if (String(txout.scriptPubKey?.hex || '').toLowerCase() !== expectedScript) {
    throw new Error('tracked challenge output script does not match Core');
  }
}

function assertChallengeTransactionBinding(artifact, tracked, decoded) {
  const assertion = artifact.graph.assertionOutpoint;
  if (decoded?.txid !== tracked.txid) throw new Error('tracked challenge decoded txid mismatch');
  if (!Array.isArray(decoded.vin) || decoded.vin.length !== 1) throw new Error('tracked challenge must have exactly one input');
  const input = decoded.vin[0];
  if (input.txid !== assertion.txid || Number(input.vout) !== Number(assertion.vout)) {
    throw new Error('tracked challenge does not spend the assertion outpoint');
  }
  if (Number(input.sequence) !== 0xfffffffd) throw new Error('tracked challenge sequence is not BIP125 replaceable');
  if (!Array.isArray(decoded.vout) || decoded.vout.length !== 1) throw new Error('tracked challenge must have exactly one output');
  const output = decoded.vout[0];
  if (coreValueToSats(output.value) !== BigInt(tracked.outputSats)) throw new Error('tracked challenge decoded amount mismatch');
  if (String(output.scriptPubKey?.hex || '').toLowerCase() !== String(tracked.challengeScriptPubKeyHex || '').toLowerCase()) {
    throw new Error('tracked challenge decoded script mismatch');
  }
  return true;
}

function assertRpcSnapshotTip(txout, expectedTipHash, fieldName) {
  if (txout?.bestblock && expectedTipHash && txout.bestblock !== expectedTipHash) {
    throw new Error(`${fieldName} RPC snapshot does not match the tick chain tip`);
  }
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
    const reorgDetected = Boolean(input.reorgPending) || (Boolean(prior) && (prior.height !== height || prior.blockHash !== blockHash));
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

async function monitorChallenge(rpc, state, currentHeight, expectedTipHash = null) {
  const challenge = state.challenge;
  let tracked = challenge?.cpfp?.txid ? challenge.cpfp : challenge;
  if (!tracked?.txid) return null;
  let role = tracked === challenge ? 'challenge' : 'cpfp';
  let conflictResolution = null;
  let txout = await rpc('gettxout', [tracked.txid, Number(tracked.vout || 0), true]);
  if (!txout && role === 'cpfp') {
    const priorCandidates = [...(tracked.replacements || [])].reverse();
    for (const prior of priorCandidates) {
      const candidate = await rpc('gettxout', [prior.txid, Number(prior.vout || 0), true]);
      if (!candidate) continue;
      const restored = {
        txid: prior.txid,
        vout: Number(prior.vout || 0),
        parentTxid: tracked.parentTxid,
        feeSats: String(prior.feeSats),
        outputSats: String(prior.outputSats),
        scriptPubKeyHex: tracked.scriptPubKeyHex || challenge.challengeScriptPubKeyHex,
        broadcastAt: prior.broadcastAt || null,
        confirmation: null,
        replacements: [],
        conflicts: [
          ...(tracked.conflicts || []),
          {
            txid: tracked.txid,
            feeSats: String(tracked.feeSats),
            outputSats: String(tracked.outputSats),
            lostAt: new Date().toISOString(),
            reason: 'superseded-cpfp-won-confirmation'
          }
        ]
      };
      assertTrackedOutputBinding(challenge, restored, candidate);
      conflictResolution = { winnerTxid: restored.txid, loserTxid: tracked.txid };
      challenge.cpfp = restored;
      tracked = restored;
      role = 'cpfp-conflict-winner';
      txout = candidate;
      break;
    }
  }
  if (txout) assertTrackedOutputBinding(challenge, tracked, txout);
  assertRpcSnapshotTip(txout, expectedTipHash, 'challenge output');
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
    reorgPending: tracked.reorgPending === true,
    inclusionBlockHash,
    activeHashAtPriorHeight
  });
  if (lifecycle.confirmation && lifecycle.action !== 'challenge_reorged') {
    tracked.confirmation = lifecycle.confirmation;
    tracked.reorgPending = false;
  } else if (lifecycle.action === 'challenge_in_mempool' && tracked.confirmation) {
    tracked.confirmationHistory = [
      ...(tracked.confirmationHistory || []),
      { ...tracked.confirmation, removedAt: new Date().toISOString(), reason: 'reorged-to-mempool' }
    ];
    tracked.confirmation = null;
    tracked.reorgPending = true;
  } else if (lifecycle.action === 'challenge_reorged') {
    tracked.reorgPending = true;
  }
  tracked.lastObservedAt = new Date().toISOString();
  const action = conflictResolution && lifecycle.action === 'challenge_confirmed'
    ? 'challenge_conflict_winner_confirmed'
    : lifecycle.action;
  tracked.lastAction = action;
  return { txid: tracked.txid, vout: Number(tracked.vout || 0), role, ...lifecycle, action, conflictResolution };
}

async function prepareChallenge(artifact, inspected, args, rpc) {
  const attempts = [];
  let selected = null;
  for (const feeSats of feeCandidates(args, inspected.assertionOutpoint.amountSats)) {
    const disprove = buildBitvmDisproveV2(artifact.graph, {
      stateVerification: verificationOptions(artifact, inspected.trustPolicy),
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
    stateVerification: verificationOptions(artifact, inspected.trustPolicy),
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
  const decoded = await rpc('getrawtransaction', [tracked.txid, true]);
  assertChallengeTransactionBinding(artifact, tracked, decoded);
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
    challengeTxid: result.challenge?.txid || result.disprove?.broadcastTxid || null,
    authorizationActiveBlockHash: result.authorization?.activeBlockHash || null,
    authorizationReorged: result.authorization?.reorged || false,
    authorizationStale: result.authorization?.stale || false
  })).digest('hex');
}

async function runTick(args, rpc, state) {
  const artifactPath = path.resolve(args.artifact || DEFAULT_ARTIFACT);
  const artifact = readJson(artifactPath, 'public artifact');
  const trustPolicyPath = path.resolve(args.trustPolicy || DEFAULT_TRUST_POLICY);
  const trustPolicy = readJson(trustPolicyPath, 'watchtower trust policy');
  const inspected = inspectArtifact(artifact, trustPolicy);
  const chain = await rpc('getblockchaininfo');
  if (chain.chain !== 'testnet4') throw new Error(`wrong chain: ${chain.chain}`);
  const authorizationBlock = await rpc('getblockhash', [inspected.authorizationHeight]);
  const authorization = authorizationPolicy(inspected, authorizationBlock, state, Number(chain.blocks), artifact);
  if (!authorization.authorizedForNewChallenge && !authorization.tracked) {
    throw new Error(authorization.reorged
      ? 'artifact authorization block is not in the active chain'
      : 'artifact state checkpoint is stale at the current chain tip');
  }
  const assertion = inspected.assertionOutpoint;
  const txout = await rpc('gettxout', [assertion.txid, assertion.vout, true]);
  assertRpcSnapshotTip(txout, chain.bestblockhash, 'assertion output');
  const currentHeight = Number(chain.blocks);
  const confirmationCount = Number(txout?.confirmations || 0);
  const result = {
    kind: 'utxoref_v2_watchtower_tick',
    at: new Date().toISOString(),
    graphHash: inspected.graphHash,
    trustPolicyId: inspected.trustPolicyId,
    height: currentHeight,
    assertionOutpoint: `${assertion.txid}:${assertion.vout}`,
    assertionUnspent: Boolean(txout),
    assertionConfirmations: confirmationCount,
    fraudDetected: inspected.fraudDetected,
    fraudType: inspected.fraudType,
    authorization: {
      height: inspected.authorizationHeight,
      recordedBlockHash: inspected.authorizationBlockHash,
      activeBlockHash: authorizationBlock,
      reorged: authorization.reorged,
      stale: authorization.stale,
      ageBlocks: authorization.ageBlocks,
      monitoringOnly: authorization.monitoringOnly
    },
    action: inspected.fraudDetected && txout
      ? 'challenge_required'
      : txout
      ? 'monitoring'
      : artifact.status === 'staged'
      ? 'awaiting_funding_broadcast'
      : 'assertion_spent_unresolved',
    disprove: null
  };

  if (!txout && state.challenge?.graphHash === inspected.graphHash) {
    result.challenge = await monitorChallenge(rpc, state, currentHeight, chain.bestblockhash);
    result.action = result.challenge.action;
    if (args.replaceChallenge) {
      if (!authorization.authorizedForNewChallenge) {
        throw new Error('challenge replacement is disabled after authorization-block reorg');
      }
      if (result.action !== 'challenge_in_mempool') {
        throw new Error(`challenge replacement requires an unconfirmed tracked challenge, got ${result.action}`);
      }
      const replacement = await replaceTrackedChallenge(artifact, inspected, args, rpc, state);
      result.action = replacement.action;
      result.challenge = replacement.challenge;
      result.replacementAttempts = replacement.attempts;
    }
  }

  if (inspected.fraudDetected && txout && authorization.authorizedForNewChallenge) {
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
        if (result.disprove.broadcastTxid !== result.disprove.txid) {
          throw new Error(`challenge broadcast txid mismatch: expected ${result.disprove.txid}, got ${result.disprove.broadcastTxid}`);
        }
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
  } else if (inspected.fraudDetected && txout && authorization.monitoringOnly) {
    result.action = 'authorization_reorged_monitoring_only';
  }

  state.tickCount = Number(state.tickCount || 0) + 1;
  state.lastTickAt = result.at;
  state.lastStatus = result.action;
  state.lastHeight = currentHeight;
  const fingerprint = alertFingerprint(result);
  if (result.action !== 'monitoring' && state.lastAlertFingerprint !== fingerprint) {
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
  trustBindingForArtifact,
  challengeStateBindsArtifact,
  verificationOptions,
  authorizationPolicy,
  inspectArtifact,
  deterministicChallengeAux,
  feeCandidates,
  isFeePolicyReject,
  isFeePolicyError,
  replacementFeeCandidates,
  coreValueToSats,
  assertTrackedOutputBinding,
  assertChallengeTransactionBinding,
  assertRpcSnapshotTip,
  deriveChallengeLifecycle,
  monitorChallenge,
  prepareChallenge,
  buildChallengeAtFee,
  replaceTrackedChallenge,
  runTick,
  saveJsonAtomic,
  loadState
};
