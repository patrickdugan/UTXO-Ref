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
  LEGACY_PREDICATE_POLICY,
  buildBitvmDisproveV2,
  findOutputBindingDisproveV2,
  verifyBitvmAssertionGraphV2
} = require('./bitvm_assertion_graph_v2');
const { txidFromUnsignedHex } = require('./recover_btc_testnet4_reserve_vault');
const { readJsonStrict } = require('./strict_artifact_ingress');
const { readJsonStrictProfile } = require('./strict_artifact_profiles');
const { statementFromWatchtowerTick, buildWatcherReceipt } = require('./utxoref_v2_watcher_quorum');
const { verifyUtxorefV2FeeReserve } = require('./utxoref_v2_fee_reserve');
const { BROADCAST_ALLOWLIST_KIND } = require('./btc_testnet4_readonly_rpc_proxy');
const {
  notifierConfigFromEnv,
  createAlertNotifier,
  acknowledgeAlert,
  pingHeartbeat
} = require('./utxoref_v2_alert_notifier');

const DEFAULT_ARTIFACT = path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_utxoref_v2_latest.json');
const DEFAULT_TRUST_POLICY = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_trust_policy.json');
const DEFAULT_STATE_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_state.json');
const DEFAULT_ALERT_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_alerts.jsonl');
const DEFAULT_POLL_INTERVAL_MS = 30000;
// BVM-6: escalate when the operator's recovery leaf is about a day from
// maturing over an unsettled assertion output.
const RECOVERY_WARNING_BLOCKS = 144;

function parseArgs(argv) {
  const args = { once: false, broadcast: false, replaceChallenge: false, broadcastSettlement: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--once') { args.once = true; continue; }
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (arg === '--broadcast-settlement') { args.broadcastSettlement = true; continue; }
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
    'Broadcast the fully pre-signed settlement once its challenge window has',
    'passed (no key needed; refused for fraudulent, reorged or monitor-only graphs):',
    '  node utxoref_v2_watchtower.js --once --broadcast-settlement --artifact <public-artifact.json>',
    '',
    'RPC credentials are read from BTC_RPC_URL, BTC_RPC_USER, and BTC_RPC_PASS,',
    'or passed as --rpc-url, --rpc-user, and --rpc-pass.',
    '',
    'Optional signed observation receipt:',
    '  --watcher-id <id> --watcher-fault-domain <domain> \\',
    '    --watcher-round-id <coordinator-round-id> \\',
    '    --watcher-private-key-file <ed25519-private-key.pem>',
    '',
    'Pin this graph\'s settlement in the RPC proxy broadcast allowlist (verified,',
    'honest, predicate-bound graphs only; merges into an existing file):',
    '  node utxoref_v2_watchtower.js --artifact <public-artifact.json> \\',
    '    --trust-policy <policy.json> --write-settlement-allowlist <allowlist.json>',
    '',
    'Alerts (from the environment): UTXOREF_ALERT_EMAIL_PROVIDER (postmark|resend|',
    '  sendgrid|mailgun), UTXOREF_ALERT_EMAIL_API_KEY[_FILE], UTXOREF_ALERT_EMAIL_FROM,',
    '  UTXOREF_ALERT_EMAIL_TO, UTXOREF_ALERT_WEBHOOK_URL, UTXOREF_ALERT_WEBHOOK_FORMAT',
    '  (generic|slack|discord|ntfy). Dead-man heartbeat: UTXOREF_WATCHTOWER_HEARTBEAT_URL',
    '  or --heartbeat-url, fetched after every healthy tick.',
    '',
    'Stop a critical alert repeating:',
    '  node utxoref_v2_watchtower.js --state-path <state.json> --ack-alert <fingerprint>',
    '',
    'A graph policy with feeReserve requires:',
    '  --fee-reserve <externally-pinned-fee-reserve.json>'
  ].join('\n');
}

function readJson(filePath, fieldName, profileName = null) {
  return profileName
    ? readJsonStrictProfile(filePath, profileName, fieldName)
    : readJsonStrict(filePath, fieldName);
}

function saveJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, filePath);
}

// WT-2: the RPC proxy relays only allowlisted txids. This adds the committed
// settlement of one graph, after the same verification a tick performs, and
// refuses graphs whose settlement the watchtower would not broadcast.
function settlementAllowlist(artifact, trustPolicy, existing = null) {
  const inspected = inspectArtifact(artifact, trustPolicy, { requireFreshState: false });
  if (inspected.fraudDetected) throw new Error('refusing to allowlist the settlement of a graph whose trace contains fraud');
  if (inspected.predicateBound !== true) throw new Error('refusing to allowlist the settlement of a monitor-only graph');
  if (!inspected.stateFreshAtAuthorization) throw new Error('refusing to allowlist a graph whose state was stale at authorization');
  const txids = new Set();
  if (existing !== null) {
    if (existing?.kind !== BROADCAST_ALLOWLIST_KIND || !Array.isArray(existing.txids) ||
        !existing.txids.every((txid) => typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid))) {
      throw new Error('existing broadcast allowlist is malformed');
    }
    for (const txid of existing.txids) txids.add(txid);
  }
  txids.add(txidFromUnsignedHex(artifact.graph.settlement.unsignedTxHex));
  return { kind: BROADCAST_ALLOWLIST_KIND, txids: [...txids].sort() };
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
  const existing = readJson(filePath, 'watchtower state', 'utxoref-v2-watchtower-state');
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
  let feeReservePolicy = null;
  if (graphPolicy.feeReserve !== undefined) {
    const reserveHash = String(graphPolicy.feeReserve?.reserveHash || '').toLowerCase();
    const minimumFeeReserveSats = String(graphPolicy.feeReserve?.minimumFeeReserveSats || '');
    if (!/^[0-9a-f]{64}$/.test(reserveHash) || !/^[1-9][0-9]*$/.test(minimumFeeReserveSats)) {
      throw new Error('graph fee reserve policy is invalid');
    }
    feeReservePolicy = { reserveHash, minimumFeeReserveSats };
  }
  // BVM-1: a graph funded before the bound-predicate policy is monitored only
  // when its pinned entry says so explicitly; it is reported as unbound.
  if (graphPolicy.predicatePolicy !== undefined && graphPolicy.predicatePolicy !== LEGACY_PREDICATE_POLICY) {
    throw new Error('graph predicate policy is invalid');
  }
  return {
    network,
    genesisHash,
    graphHash,
    signerKeyId,
    publicKey,
    policyId: trustPolicy.policyId || null,
    feeReservePolicy,
    legacyUnboundPredicate: graphPolicy.predicatePolicy === LEGACY_PREDICATE_POLICY
  };
}

const MAX_STATE_AGE_AT_AUTHORIZATION_BLOCKS = 6;

// State freshness limits what a checkpoint may newly AUTHORIZE (a payout). It
// must never limit a challenge: a disprove only punishes fraud that is provable
// from the committed trace, so it is safe at any state age. The challenge path
// therefore verifies the graph with `enforceStateAge: false`.
function verificationOptions(artifact, trustPolicy, options = {}) {
  const trust = trustBindingForArtifact(artifact, trustPolicy);
  const authorization = authorizationReference(artifact);
  const base = {
    trustedSigners: { [trust.signerKeyId]: trust.publicKey },
    expectedNetwork: trust.network,
    expectedGenesisHash: trust.genesisHash,
    legacyUnboundPredicateGraphHashes: trust.legacyUnboundPredicate ? [trust.graphHash] : []
  };
  if (options.enforceStateAge === false) return base;
  return {
    ...base,
    currentHeight: authorization.height,
    maxAgeBlocks: MAX_STATE_AGE_AT_AUTHORIZATION_BLOCKS
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

// `reorged` and `stale` describe the checkpoint that authorized funding. They
// gate `settlementAuthorityFresh` (anything that would grant new payout
// authority) and are reported and alerted on. They do not gate challenges:
// challenge authority comes from the pinned trust policy plus fraud evidence in
// the committed trace, and holds for as long as the assertion output is unspent.
function authorizationPolicy(inspected, activeBlockHash, state, currentHeight, artifact) {
  const reorged = activeBlockHash !== inspected.authorizationBlockHash;
  const snapshotHeight = Number(inspected.stateSnapshotHeight);
  const ageBlocks = Number(currentHeight) - snapshotHeight;
  const stale = !Number.isSafeInteger(ageBlocks) || ageBlocks < 0 ||
    ageBlocks > MAX_STATE_AGE_AT_AUTHORIZATION_BLOCKS;
  const tracked = challengeStateBindsArtifact(artifact, state);
  return {
    reorged,
    stale,
    ageBlocks,
    tracked,
    settlementAuthorityFresh: !reorged && !stale,
    authorizedForNewChallenge: true
  };
}

// `requireFreshState: false` is the watchtower's challenge-path view: the graph
// must still verify structurally and against the pinned trust policy, but a
// checkpoint that was (or has become) stale does not make the artifact
// uninspectable. Freshness at authorization is returned as data instead.
function inspectArtifact(artifact, trustPolicy, inspectOptions = {}) {
  if (artifact?.kind !== 'btc_testnet4_utxoref_v2_live_ceremony' || artifact.version !== 2) {
    throw new Error('wrong UTXORef V2 public artifact kind or version');
  }
  const requireFreshState = inspectOptions.requireFreshState !== false;
  const options = verificationOptions(artifact, trustPolicy, { enforceStateAge: requireFreshState });
  const trust = trustBindingForArtifact(artifact, trustPolicy);
  const authorization = authorizationReference(artifact);
  const verification = verifyBitvmAssertionGraphV2(artifact.graph, options);
  if (!verification.ok) throw new Error(`public assertion graph failed verification: ${verification.reason}`);
  const stateSnapshotHeight = Number(artifact.graph.settlement?.stateEnvelope?.body?.snapshotHeight);
  const ageAtAuthorization = authorization.height - stateSnapshotHeight;
  const stateFreshAtAuthorization = Number.isSafeInteger(ageAtAuthorization) && ageAtAuthorization >= 0 &&
    ageAtAuthorization <= MAX_STATE_AGE_AT_AUTHORIZATION_BLOCKS;
  const gateEvidence = findGateDisproveV2(artifact.graph.publicTrace, artifact.graph.template.challengerXonly);
  const inputEvidence = findInputBindingDisproveV2(
    artifact.graph.publicTrace,
    artifact.graph.template.expectedInputs,
    artifact.graph.template.challengerXonly
  );
  const outputEvidence = findOutputBindingDisproveV2(artifact.graph);
  const evidence = gateEvidence || inputEvidence || outputEvidence;
  return {
    graphHash: artifact.graph.graphHash,
    predicateBound: verification.predicateBound,
    authorizationHeight: authorization.height,
    authorizationBlockHash: authorization.blockHash,
    authorizationSource: authorization.source || 'broadcast',
    stateSnapshotHeight,
    stateFreshAtAuthorization,
    trustPolicyId: trust.policyId,
    feeReservePolicy: trust.feeReservePolicy,
    trustPolicy,
    assertionOutpoint: artifact.graph.assertionOutpoint,
    challengeCsvBlocks: artifact.graph.template.challengeCsvBlocks,
    recoveryCsvBlocks: artifact.graph.template.recoveryCsvBlocks,
    verification,
    fraudDetected: Boolean(evidence),
    fraudType: gateEvidence ? 'gate' : inputEvidence ? 'input' : outputEvidence ? 'output' : null,
    evidence
  };
}

async function verifyConfiguredFeeReserve(args, inspected, rpc, chain, assertionUnspent) {
  const policy = inspected.feeReservePolicy;
  if (!policy) {
    if (args.feeReserve) throw new Error('fee reserve is not pinned by the graph trust policy');
    return null;
  }
  if (!assertionUnspent) return {
    required: true,
    reserveHash: policy.reserveHash,
    status: 'not_rechecked_after_assertion_spend'
  };
  if (!args.feeReserve) throw new Error('graph trust policy requires --fee-reserve');
  const reserve = readJsonStrictProfile(
    path.resolve(args.feeReserve),
    'utxoref-v2-fee-reserve',
    'graph fee reserve'
  );
  if (reserve.reserveHash !== policy.reserveHash) throw new Error('fee reserve hash differs from graph trust policy');
  const funding = reserve.core?.vaultManifest?.core?.fundingOutpoint;
  if (!funding || !/^[0-9a-f]{64}$/.test(String(funding.txid || '')) ||
      !Number.isSafeInteger(Number(funding.vout)) || Number(funding.vout) < 0) {
    throw new Error('fee reserve funding outpoint is invalid');
  }
  const txout = await rpc('gettxout', [funding.txid, Number(funding.vout), true]);
  assertRpcSnapshotTip(txout, chain.bestblockhash, 'fee reserve output');
  const verification = verifyUtxorefV2FeeReserve(reserve, {
    graphHash: inspected.graphHash,
    currentHeight: Number(chain.blocks),
    minimumFeeReserveSats: policy.minimumFeeReserveSats,
    txout
  });
  if (!verification.ok || !verification.counted) throw new Error(`graph fee reserve failed verification: ${verification.reason}`);
  return {
    required: true,
    status: 'counted',
    reserveHash: reserve.reserveHash,
    outpoint: verification.outpoint,
    amountSats: verification.amountSats,
    maxFeeSats: verification.maxFeeSats,
    guardianThreshold: verification.guardianThreshold || 1,
    guardianCount: verification.guardianCount || 1,
    remainingBlocks: verification.remainingBlocks
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
        mode: tracked.mode || null,
        txid: prior.txid,
        vout: Number(prior.vout || 0),
        parentTxid: tracked.parentTxid,
        feeSats: String(prior.feeSats),
        outputSats: String(prior.outputSats),
        scriptPubKeyHex: tracked.scriptPubKeyHex || challenge.challengeScriptPubKeyHex,
        reserveHash: prior.reserveHash || tracked.reserveHash || null,
        reserveOutpoint: prior.reserveOutpoint || tracked.reserveOutpoint || null,
        reserveAmountSats: tracked.reserveAmountSats || null,
        guardianApprovalHash: prior.guardianApprovalHash || tracked.guardianApprovalHash || null,
        guardianApprovalHashes: prior.guardianApprovalHashes || tracked.guardianApprovalHashes || [],
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
  if (tracked.mode === 'reserve-backed' && challenge.feeReserveLifecycle) {
    const reserveLifecycle = challenge.feeReserveLifecycle;
    reserveLifecycle.activeCpfpTxid = tracked.txid;
    reserveLifecycle.updatedAt = tracked.lastObservedAt;
    if (lifecycle.confirmation && ['challenge_confirmed', 'challenge_reconfirmed'].includes(lifecycle.action)) {
      reserveLifecycle.status = 'consumed_confirmed';
      reserveLifecycle.confirmation = lifecycle.confirmation;
    } else if (lifecycle.action === 'challenge_in_mempool') {
      reserveLifecycle.status = (tracked.replacements || []).length
        ? 'committed_to_replacement'
        : 'committed_to_cpfp';
      reserveLifecycle.confirmation = null;
    } else if (lifecycle.action === 'challenge_reorged') {
      reserveLifecycle.status = 'reorged_unresolved';
    } else if (['challenge_missing', 'challenge_output_spent_or_missing'].includes(lifecycle.action)) {
      reserveLifecycle.status = 'spent_or_missing_unresolved';
    }
  }
  return { txid: tracked.txid, vout: Number(tracked.vout || 0), role, ...lifecycle, action, conflictResolution };
}

async function prepareChallenge(artifact, inspected, args, rpc) {
  const attempts = [];
  let selected = null;
  for (const feeSats of feeCandidates(args, inspected.assertionOutpoint.amountSats)) {
    const disprove = buildBitvmDisproveV2(artifact.graph, {
      stateVerification: verificationOptions(artifact, inspected.trustPolicy, { enforceStateAge: false }),
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
    stateVerification: verificationOptions(artifact, inspected.trustPolicy, { enforceStateAge: false }),
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
    settlementTxid: result.settlement?.broadcastTxid || null,
    authorizationActiveBlockHash: result.authorization?.activeBlockHash || null,
    authorizationReorged: result.authorization?.reorged || false,
    authorizationStale: result.authorization?.stale || false
  })).digest('hex');
}

async function runTick(args, rpc, state) {
  const artifactPath = path.resolve(args.artifact || DEFAULT_ARTIFACT);
  const artifact = readJson(artifactPath, 'public artifact', 'utxoref-v2-public-artifact');
  const trustPolicyPath = path.resolve(args.trustPolicy || DEFAULT_TRUST_POLICY);
  const trustPolicy = readJson(trustPolicyPath, 'watchtower trust policy', 'utxoref-v2-trust-policy');
  // Challenge-path inspection: state age and the authorization block are
  // reported below but never stop the watchtower from watching or challenging.
  const inspected = inspectArtifact(artifact, trustPolicy, { requireFreshState: false });
  const chain = await rpc('getblockchaininfo');
  if (chain.chain !== 'testnet4') throw new Error(`wrong chain: ${chain.chain}`);
  const authorizationBlock = await rpc('getblockhash', [inspected.authorizationHeight]).catch(() => null);
  const authorization = authorizationPolicy(inspected, authorizationBlock, state, Number(chain.blocks), artifact);
  const assertion = inspected.assertionOutpoint;
  const txout = await rpc('gettxout', [assertion.txid, assertion.vout, true]);
  assertRpcSnapshotTip(txout, chain.bestblockhash, 'assertion output');
  const currentHeight = Number(chain.blocks);
  const feeReserve = await verifyConfiguredFeeReserve(args, inspected, rpc, chain, Boolean(txout));
  const confirmationCount = Number(txout?.confirmations || 0);
  const result = {
    kind: 'utxoref_v2_watchtower_tick',
    at: new Date().toISOString(),
    graphHash: inspected.graphHash,
    trustPolicyId: inspected.trustPolicyId,
    network: 'bitcoin-testnet4',
    height: currentHeight,
    chainBestBlockHash: chain.bestblockhash,
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
      staleAtAuthorization: !inspected.stateFreshAtAuthorization,
      ageBlocks: authorization.ageBlocks,
      settlementAuthorityFresh: authorization.settlementAuthorityFresh
    },
    action: inspected.fraudDetected && txout
      ? 'challenge_required'
      : txout && authorization.reorged
      ? 'authorization_block_reorged'
      : txout && !inspected.stateFreshAtAuthorization
      ? 'state_stale_at_authorization'
      : txout
      ? 'monitoring'
      : artifact.status === 'staged'
      ? 'awaiting_funding_broadcast'
      : 'assertion_spent_unresolved',
    disprove: null
  };
  if (feeReserve) result.feeReserve = feeReserve;

  // BVM-6 / WT-2: a fraudulent trace is refused before funding (the challenger
  // will not pre-sign it), so after funding the watchtower's job on an honest
  // graph is to see the pre-signed settlement broadcast before the operator's
  // recovery leaf matures. Settlement is fully signed: broadcasting it needs
  // no key. It is never broadcast for a fraudulent, reorged, stale-at-
  // authorization or monitor-only (predicate-unbound) graph.
  if (txout && !inspected.fraudDetected) {
    const recoveryInBlocks = Number(inspected.recoveryCsvBlocks) - confirmationCount;
    result.settlement = {
      txid: txidFromUnsignedHex(artifact.graph.settlement.unsignedTxHex),
      mature: confirmationCount >= Number(inspected.challengeCsvBlocks),
      recoveryInBlocks,
      broadcastEligible: inspected.predicateBound === true && !authorization.reorged &&
        inspected.stateFreshAtAuthorization,
      broadcastTxid: null
    };
    if (result.settlement.mature && result.action === 'monitoring') result.action = 'settlement_due';
    if (recoveryInBlocks <= RECOVERY_WARNING_BLOCKS) result.action = 'recovery_imminent';
    if (args.broadcastSettlement && result.settlement.mature && result.settlement.broadcastEligible) {
      // A failed attempt is reported (and alerted) as its own action and
      // retried next tick; it does not fail the tick.
      try {
        const witnessTxHex = artifact.graph.settlementPath.witnessTxHex;
        const [accept] = await rpc('testmempoolaccept', [[witnessTxHex]]);
        result.settlement.mempoolAccept = accept;
        if (accept?.txid !== result.settlement.txid) {
          throw new Error('settlement preflight names a different transaction than the committed settlement');
        }
        if (accept.allowed) {
          const broadcastTxid = await rpc('sendrawtransaction', [witnessTxHex]);
          if (broadcastTxid !== result.settlement.txid) {
            throw new Error(`settlement broadcast txid mismatch: expected ${result.settlement.txid}, got ${broadcastTxid}`);
          }
          result.settlement.broadcastTxid = broadcastTxid;
          result.action = 'settlement_broadcast';
        } else if (/already|known/i.test(String(accept['reject-reason'] || ''))) {
          result.action = 'settlement_in_mempool';
        } else {
          result.action = 'settlement_preflight_rejected';
        }
      } catch (err) {
        result.settlement.broadcastError = String(err?.message || err).slice(0, 300);
        result.action = 'settlement_broadcast_failed';
      }
    }
  }

  if (!txout && state.challenge?.graphHash === inspected.graphHash) {
    result.challenge = await monitorChallenge(rpc, state, currentHeight, chain.bestblockhash);
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
        if (feeReserve?.status === 'counted') {
          state.challenge.feeReserveHash = feeReserve.reserveHash;
          state.challenge.feeReserveOutpoint = feeReserve.outpoint;
        }
      } else {
        result.action = 'challenge_ready_for_broadcast';
      }
    }
  }

  const receiptArgs = [args.watcherId, args.watcherFaultDomain, args.watcherRoundId, args.watcherPrivateKeyFile];
  if (receiptArgs.some(Boolean) && !receiptArgs.every(Boolean)) {
    throw new Error('signed watcher receipts require watcher id, fault domain, and private key file');
  }
  if (receiptArgs.every(Boolean)) {
    const privateKeyPath = path.resolve(args.watcherPrivateKeyFile);
    const privateKeyStats = fs.statSync(privateKeyPath);
    if (!privateKeyStats.isFile() || privateKeyStats.size > 16384) {
      throw new Error('watcher private key must be a regular PEM file no larger than 16 KiB');
    }
    const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
    result.watcherRoundId = args.watcherRoundId;
    result.watcherReceipt = buildWatcherReceipt(statementFromWatchtowerTick(result), {
      watcherId: args.watcherId,
      faultDomain: args.watcherFaultDomain
    }, privateKeyPem);
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

// A tick that throws is itself an event someone must see: the watchtower is
// not watching while it fails. Record it in state and append one alert line
// per distinct failure (repeats of the same failure are counted, not re-logged).
function recordTickFailure(args, state, err, at = new Date().toISOString()) {
  const message = String(err?.message || err);
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ kind: 'utxoref_v2_watchtower_tick_failure', message }))
    .digest('hex');
  const repeated = state.lastFailureFingerprint === fingerprint;
  state.lastError = { at, message };
  state.failureCount = Number(state.failureCount || 0) + 1;
  state.consecutiveFailures = Number(state.consecutiveFailures || 0) + 1;
  state.lastFailureFingerprint = fingerprint;
  const alert = {
    kind: 'utxoref_v2_watchtower_tick_failure',
    at,
    action: 'watchtower_tick_failed',
    message,
    artifact: path.resolve(args.artifact || DEFAULT_ARTIFACT),
    consecutiveFailures: state.consecutiveFailures
  };
  if (!repeated) {
    state.alertCount = Number(state.alertCount || 0) + 1;
    appendJsonLine(args.alertPath || DEFAULT_ALERT_PATH, alert);
  }
  return { alert, logged: !repeated };
}

function recordTickSuccess(state) {
  delete state.lastError;
  delete state.lastFailureFingerprint;
  state.consecutiveFailures = 0;
}

function ackPathFor(statePath) {
  return statePath.endsWith('.json') ? `${statePath.slice(0, -5)}.acks.json` : `${statePath}.acks.json`;
}

// One watchtower iteration: tick, record, notify, and ping the dead-man
// heartbeat only when the tick was healthy.
async function runWatchtowerIteration(args, rpc, state, deps = {}) {
  const { notifier = null, heartbeatUrl = null, fetchImpl, now } = deps;
  let result;
  try {
    result = await runTick(args, rpc, state);
    recordTickSuccess(state);
  } catch (err) {
    const failure = recordTickFailure(args, state, err);
    if (notifier) await notifier.handle({ kind: 'failure', alert: failure.alert }, state);
    return { ok: false, error: err, failure };
  }
  if (notifier) await notifier.handle({ kind: 'tick', result }, state);
  if (heartbeatUrl) state.heartbeat = await pingHeartbeat(heartbeatUrl, { fetchImpl, now });
  return { ok: true, result };
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
  if (args.ackAlert) {
    const statePath = path.resolve(args.statePath || DEFAULT_STATE_PATH);
    const ackPath = path.resolve(args.ackPath || ackPathFor(statePath));
    console.log(JSON.stringify({ acknowledged: acknowledgeAlert(ackPath, args.ackAlert), ackPath }));
    return;
  }
  if (args.writeSettlementAllowlist) {
    const allowlistPath = path.resolve(args.writeSettlementAllowlist);
    const artifact = readJson(path.resolve(args.artifact || DEFAULT_ARTIFACT), 'public artifact', 'utxoref-v2-public-artifact');
    const trustPolicy = readJson(path.resolve(args.trustPolicy || DEFAULT_TRUST_POLICY), 'watchtower trust policy', 'utxoref-v2-trust-policy');
    const existing = fs.existsSync(allowlistPath) ? JSON.parse(fs.readFileSync(allowlistPath, 'utf8')) : null;
    const allowlist = settlementAllowlist(artifact, trustPolicy, existing);
    saveJsonAtomic(allowlistPath, allowlist);
    console.log(JSON.stringify({ allowlist: allowlistPath, txids: allowlist.txids }));
    return;
  }
  if (args.broadcastSettlement && args.challengerSecretFile) {
    throw new Error('--broadcast-settlement needs no key: run it without --challenger-secret-file');
  }
  const rpc = resolveRpc(args);
  const statePath = path.resolve(args.statePath || DEFAULT_STATE_PATH);
  const intervalMs = Number(args.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw new Error('poll interval must be at least 1000 ms');
  const state = loadState(statePath);
  const notifierConfig = notifierConfigFromEnv(process.env);
  const notifier = createAlertNotifier(notifierConfig, {
    ackPath: path.resolve(args.ackPath || ackPathFor(statePath)),
    ackCommand: `node ${process.argv[1]} --state-path ${statePath} --ack-alert {fingerprint}`
  });
  const heartbeatUrl = args.heartbeatUrl || notifierConfig.heartbeatUrl;
  console.error(`[utxoref-v2-watchtower] alerts: ${notifier.enabled ? notifier.channels.join(', ') : 'alert file only'}; ` +
    `heartbeat: ${heartbeatUrl ? 'on' : 'off'}; settlement broadcast: ${args.broadcastSettlement ? 'on' : 'off'}`);
  do {
    const iteration = await runWatchtowerIteration(args, rpc, state, { notifier, heartbeatUrl });
    if (iteration.ok) console.log(JSON.stringify(iteration.result));
    else console.error(`[utxoref-v2-watchtower] tick failed: ${iteration.error.message}`);
    if (state.notifier?.lastError) console.error(`[utxoref-v2-watchtower] alert delivery: ${state.notifier.lastError.message}`);
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
  RECOVERY_WARNING_BLOCKS,
  parseArgs,
  authorizationReference,
  trustBindingForArtifact,
  challengeStateBindsArtifact,
  verificationOptions,
  authorizationPolicy,
  inspectArtifact,
  settlementAllowlist,
  verifyConfiguredFeeReserve,
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
  runWatchtowerIteration,
  ackPathFor,
  recordTickFailure,
  recordTickSuccess,
  saveJsonAtomic,
  loadState
};
