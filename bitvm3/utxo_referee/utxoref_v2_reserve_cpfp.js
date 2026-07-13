#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { readJsonStrictProfile } = require('./strict_artifact_profiles');
const { rpcFactory } = require('./tradelayer_send_rpc_sweep');
const { sha256Hex, stableStringify } = require('./tradelayer_pnl_route_adapter');
const tr = require('./tradelayer_taproot');
const ts = require('./tradelayer_taproot_script');
const a = require('./tradelayer_dlc_adaptor_sig');
const {
  outpointKey,
  verifyTaprootReserveVaultManifest
} = require('./taproot_reserve_vault');
const {
  MAX_GUARDIANS,
  isGuardianQuorumFeeReserve,
  verifyGuardianQuorumVaultManifest
} = require('./utxoref_v2_guardian_quorum_reserve');
const { verifyUtxorefV2FeeReserve } = require('./utxoref_v2_fee_reserve');
const {
  btcToSats,
  verifyChallengeStateBinding
} = require('./utxoref_v2_challenge_cpfp');
const { txidFromUnsignedHex } = require('./recover_btc_testnet4_reserve_vault');
const {
  loadState,
  saveJsonAtomic,
  inspectArtifact,
  assertRpcSnapshotTip
} = require('./utxoref_v2_watchtower');

const DEFAULT_STATE_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_state.json');
const DEFAULT_ARTIFACT_PATH = path.join(__dirname, 'artifacts', 'live', 'btc_testnet4_utxoref_v2_latest.json');
const DEFAULT_TRUST_POLICY_PATH = path.join(__dirname, 'artifacts', 'live', 'utxoref_v2_watchtower_trust_policy.json');
const DEFAULT_MAX_APPROVAL_AGE_BLOCKS = 6;
const MIN_OUTPUT_SATS = 330n;
const RBF_SEQUENCE = 0xfffffffd;

function parseArgs(argv) {
  const args = { broadcast: false, replaceChild: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--guardian-approval') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      args.guardianApprovals = [...(args.guardianApprovals || []), value];
      if (args.guardianApprovals.length > MAX_GUARDIANS) {
        throw new Error(`at most ${MAX_GUARDIANS} guardian approvals are allowed`);
      }
      args.guardianApproval = args.guardianApproval || value;
      continue;
    }
    if (arg === '--broadcast') { args.broadcast = true; continue; }
    if (arg === '--replace-child') { args.replaceChild = true; continue; }
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
    'Finalize an exact guardian-approved, reserve-backed UTXORef V2 CPFP child.',
    '',
    'First create the approval on the guardian host:',
    '  node utxoref_v2_fee_reserve_guardian.js --artifact <artifact.json> \\',
    '    --state-path <state.json> --fee-reserve <reserve.json> \\',
    '    --fee-sats 2000 --guardian-secret-file <secret.hex> --output <approval.json>',
    '',
    'Then finalize with the challenge wallet and challenger key:',
    '  node utxoref_v2_reserve_cpfp.js --artifact <artifact.json> \\',
    '    --state-path <state.json> --fee-reserve <reserve.json> \\',
    '    --guardian-approval <approval.json> --challenger-secret-file <secret.hex> \\',
    '    --wallet <wallet-name> --fee-sats 2000 --broadcast',
    '',
    'Repeat --guardian-approval for a threshold guardian reserve.',
    'Use --replace-child on both commands to replace the tracked unconfirmed child.',
    'RPC credentials are read from BTC_RPC_URL, BTC_RPC_USER, and BTC_RPC_PASS,',
    'or passed as --rpc-url, --rpc-user, and --rpc-pass.'
  ].join('\n');
}

function positiveSats(value, fieldName) {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${fieldName} must be a positive integer`);
  return BigInt(text);
}

function assertHex(value, bytes, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  }
  return text;
}

function assertHexBytes(value, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(text)) throw new Error(`${fieldName} must be non-empty, even-length hex`);
  return text;
}

function secretFromHex(value, fieldName) {
  const secretHex = assertHex(String(value || '').replace(/^0x/, ''), 32, fieldName);
  const secret = a.bufToBig(Buffer.from(secretHex, 'hex'));
  if (secret <= 0n || secret >= a.N) throw new Error(`${fieldName} is outside the secp256k1 scalar range`);
  return secret;
}

function readSecretFile(filePath, fieldName) {
  if (!filePath) throw new Error(`${fieldName} file is required`);
  return secretFromHex(fs.readFileSync(path.resolve(filePath), 'utf8').trim(), fieldName);
}

function expectedCoreChain(network) {
  const normalized = String(network || '').toLowerCase();
  if (normalized === 'bitcoin-testnet4') return 'testnet4';
  if (normalized === 'bitcoin-testnet') return 'test';
  if (normalized === 'bitcoin-regtest') return 'regtest';
  if (normalized === 'bitcoin') return 'main';
  throw new Error(`unsupported fee reserve network ${network}`);
}

function planHash(plan) {
  const copy = { ...plan };
  delete copy.planHash;
  return sha256Hex(copy);
}

function assertPlanHash(plan) {
  if (plan?.planHash !== planHash(plan)) throw new Error('reserve CPFP plan hash mismatch');
  return true;
}

function reserveGuardianPolicy(reserve) {
  const manifest = reserve?.core?.vaultManifest;
  if (isGuardianQuorumFeeReserve(reserve)) {
    const manifestCheck = verifyGuardianQuorumVaultManifest(manifest);
    if (!manifestCheck.ok) throw new Error(`fee reserve quorum vault manifest is invalid: ${manifestCheck.reason}`);
    const guardianXonlys = manifest.core.guardianXonlys;
    return {
      kind: 'guardian-quorum',
      manifest,
      manifestCheck,
      guardianXonlys,
      guardianThreshold: Number(manifest.core.guardianThreshold),
      guardianSetHash: manifest.core.guardianSetHash,
      immediateLeaf: manifest.core.leaves['immediate-operator-guardian-quorum']
    };
  }
  if (reserve?.core?.kind !== 'utxoref_v2_fee_reserve_v1') {
    throw new Error('fee reserve core is invalid');
  }
  const manifestCheck = verifyTaprootReserveVaultManifest(manifest);
  if (!manifestCheck.ok) throw new Error(`fee reserve vault manifest is invalid: ${manifestCheck.reason}`);
  const guardianXonlys = [manifest.core.guardianXonly];
  return {
    kind: 'single-guardian',
    manifest,
    manifestCheck,
    guardianXonlys,
    guardianThreshold: 1,
    guardianSetHash: sha256Hex({ guardianXonlys, guardianThreshold: 1 }),
    immediateLeaf: manifest.core.leaves['immediate-operator-guardian']
  };
}

function reserveBinding(reserve, state, artifact) {
  verifyChallengeStateBinding(artifact, state);
  if (!reserve || reserve.kind !== 'utxoref_v2_fee_reserve' || reserve.version !== 1) {
    throw new Error('wrong fee reserve kind or version');
  }
  const core = reserve.core;
  if (!core) throw new Error('fee reserve core is invalid');
  if (reserve.reserveHash !== sha256Hex(core)) throw new Error('fee reserve hash mismatch');
  const graphHash = assertHex(state.challenge.graphHash, 32, 'challenge graphHash');
  if (core.graphHash !== graphHash || artifact.graph.graphHash !== graphHash) {
    throw new Error('fee reserve graph hash does not match the tracked challenge');
  }
  if (state.challenge.feeReserveHash !== reserve.reserveHash) {
    throw new Error('tracked challenge fee reserve hash does not match the supplied reserve');
  }
  const guardianPolicy = reserveGuardianPolicy(reserve);
  const manifest = guardianPolicy.manifest;
  if (manifest.core.bindingHash !== graphHash) throw new Error('fee reserve tapscript is not graph-bound');
  if (manifest.core.reserveEpochId !== core.disputeId) throw new Error('fee reserve dispute id mismatch');
  const outpoint = outpointKey(manifest.core.fundingOutpoint);
  if (state.challenge.feeReserveOutpoint !== outpoint) {
    throw new Error('tracked challenge fee reserve outpoint does not match the supplied reserve');
  }
  const amountSats = positiveSats(core.amountSats, 'fee reserve amountSats');
  const maxFeeSats = positiveSats(core.maxFeeSats, 'fee reserve maxFeeSats');
  if (manifest.core.amountSats !== amountSats.toString()) throw new Error('fee reserve vault amount mismatch');
  if (amountSats < maxFeeSats) throw new Error('fee reserve amount does not cover its maximum fee');
  return {
    graphHash,
    manifest,
    outpoint,
    amountSats,
    maxFeeSats,
    fundingTxid: manifest.core.fundingOutpoint.txid,
    fundingVout: Number(manifest.core.fundingOutpoint.vout),
    scriptPubKeyHex: manifest.core.p2trScriptPubKey,
    immediateLeaf: guardianPolicy.immediateLeaf,
    guardianXonlys: guardianPolicy.guardianXonlys,
    guardianThreshold: guardianPolicy.guardianThreshold,
    guardianSetHash: guardianPolicy.guardianSetHash,
    guardianPolicyKind: guardianPolicy.kind
  };
}

function assertTrustPolicyReserve(inspected, reserve) {
  const policy = inspected?.feeReservePolicy;
  if (!policy) throw new Error('artifact graph trust policy does not authorize a fee reserve');
  if (policy.reserveHash !== reserve.reserveHash) throw new Error('fee reserve differs from the graph trust policy');
  if (positiveSats(reserve.core.amountSats, 'fee reserve amountSats') <
      positiveSats(policy.minimumFeeReserveSats, 'minimumFeeReserveSats')) {
    throw new Error('fee reserve is below the graph trust policy minimum');
  }
  return true;
}

function buildReserveCpfpPlan(state, args, artifact, reserve) {
  const binding = reserveBinding(reserve, state, artifact);
  const tracked = state.challenge;
  const feeSats = positiveSats(args.feeSats, 'feeSats');
  if (feeSats > binding.maxFeeSats) throw new Error('reserve CPFP fee exceeds maxFeeSats');
  if (feeSats > binding.amountSats) throw new Error('reserve CPFP fee exceeds the reserve amount');
  const challengeAmountSats = positiveSats(tracked.outputSats, 'tracked challenge outputSats');
  const totalInputSats = challengeAmountSats + binding.amountSats;
  const outputSats = totalInputSats - feeSats;
  if (outputSats < challengeAmountSats) throw new Error('reserve CPFP would consume challenge principal');
  if (outputSats < MIN_OUTPUT_SATS) throw new Error('reserve CPFP output would be dust');
  const existingChild = tracked.cpfp || null;
  if (existingChild && !args.replaceChild) {
    throw new Error('state already tracks a CPFP child; use --replace-child to fee-bump it');
  }
  if (args.replaceChild) {
    if (!existingChild?.txid || !/^[0-9a-f]{64}$/.test(existingChild.txid)) {
      throw new Error('state has no valid CPFP child to replace');
    }
    if (existingChild.mode !== 'reserve-backed') throw new Error('tracked CPFP is not reserve-backed');
    if (existingChild.reserveHash !== reserve.reserveHash || existingChild.reserveOutpoint !== binding.outpoint) {
      throw new Error('tracked CPFP is bound to a different fee reserve');
    }
    if (feeSats <= positiveSats(existingChild.feeSats, 'tracked CPFP feeSats')) {
      throw new Error('replacement reserve CPFP fee must exceed the tracked child fee');
    }
  }
  const challengeVout = Number(tracked.vout || 0);
  const challengeScriptPubKeyHex = String(tracked.challengeScriptPubKeyHex || '').toLowerCase();
  const unsignedTxHex = tr.serializeUnsignedTx(2, [
    {
      outpoint: tr.outpoint(tracked.txid, challengeVout),
      sequence: RBF_SEQUENCE
    },
    {
      outpoint: tr.outpoint(binding.fundingTxid, binding.fundingVout),
      sequence: RBF_SEQUENCE
    }
  ], [{ valueSats: outputSats, script: challengeScriptPubKeyHex }], 0);
  const plan = {
    kind: 'utxoref_v2_reserve_cpfp_plan',
    version: 1,
    graphHash: binding.graphHash,
    reserveHash: reserve.reserveHash,
    replacementOf: args.replaceChild ? existingChild.txid : null,
    replacementOutputSats: args.replaceChild ? String(existingChild.outputSats) : null,
    challenge: {
      txid: tracked.txid,
      vout: challengeVout,
      amountSats: challengeAmountSats.toString(),
      scriptPubKeyHex: challengeScriptPubKeyHex
    },
    reserve: {
      txid: binding.fundingTxid,
      vout: binding.fundingVout,
      outpoint: binding.outpoint,
      amountSats: binding.amountSats.toString(),
      maxFeeSats: binding.maxFeeSats.toString(),
      scriptPubKeyHex: binding.scriptPubKeyHex,
      vaultId: binding.manifest.core.vaultId,
      immediateLeafHash: binding.immediateLeaf.leafHash,
      guardianPolicyKind: binding.guardianPolicyKind,
      guardianSetHash: binding.guardianSetHash,
      guardianThreshold: binding.guardianThreshold,
      guardianCount: binding.guardianXonlys.length
    },
    feeSats: feeSats.toString(),
    totalInputSats: totalInputSats.toString(),
    outputSats: outputSats.toString(),
    outputScriptPubKeyHex: challengeScriptPubKeyHex,
    unsignedTxHex,
    txid: txidFromUnsignedHex(unsignedTxHex)
  };
  plan.planHash = planHash(plan);
  return plan;
}

function reserveSpendSighash(plan, reserve) {
  assertPlanHash(plan);
  const binding = reserveBindingForPlan(reserve, plan);
  const parsed = tr.parseTx(plan.unsignedTxHex);
  if (parsed.vin.length !== 2 || parsed.vout.length !== 1) throw new Error('reserve CPFP transaction shape is invalid');
  return ts.scriptPathSighash(parsed, [
    { scriptPubKey: plan.challenge.scriptPubKeyHex, amountSats: plan.challenge.amountSats },
    { scriptPubKey: binding.scriptPubKeyHex, amountSats: binding.amountSats.toString() }
  ], 1, Buffer.from(binding.immediateLeaf.leafHash, 'hex'));
}

function reserveBindingForPlan(reserve, plan) {
  if (!reserve || reserve.reserveHash !== plan.reserveHash) throw new Error('plan fee reserve hash mismatch');
  if (reserve.reserveHash !== sha256Hex(reserve.core)) throw new Error('fee reserve hash mismatch');
  const guardianPolicy = reserveGuardianPolicy(reserve);
  const manifest = guardianPolicy.manifest;
  const binding = {
    amountSats: positiveSats(reserve.core.amountSats, 'fee reserve amountSats'),
    scriptPubKeyHex: manifest.core.p2trScriptPubKey,
    immediateLeaf: guardianPolicy.immediateLeaf,
    guardianXonlys: guardianPolicy.guardianXonlys,
    guardianThreshold: guardianPolicy.guardianThreshold,
    guardianSetHash: guardianPolicy.guardianSetHash,
    guardianPolicyKind: guardianPolicy.kind
  };
  if (manifest.core.bindingHash !== plan.graphHash || plan.reserve.outpoint !== outpointKey(manifest.core.fundingOutpoint)) {
    throw new Error('plan does not bind the supplied fee reserve');
  }
  if (plan.reserve.amountSats !== binding.amountSats.toString() ||
      plan.reserve.scriptPubKeyHex !== binding.scriptPubKeyHex ||
      plan.reserve.immediateLeafHash !== binding.immediateLeaf.leafHash ||
      plan.reserve.guardianPolicyKind !== binding.guardianPolicyKind ||
      plan.reserve.guardianSetHash !== binding.guardianSetHash ||
      Number(plan.reserve.guardianThreshold) !== binding.guardianThreshold ||
      Number(plan.reserve.guardianCount) !== binding.guardianXonlys.length) {
    throw new Error('plan fee reserve fields differ from the vault manifest');
  }
  return binding;
}

function normalizeChainEvidence(evidence = {}) {
  const height = Number(evidence.height);
  const reserveConfirmations = Number(evidence.reserveConfirmations);
  const challengeConfirmations = Number(evidence.challengeConfirmations || 0);
  if (!Number.isSafeInteger(height) || height < 0) throw new Error('guardian chain evidence height is invalid');
  if (!Number.isSafeInteger(reserveConfirmations) || reserveConfirmations < 1) {
    throw new Error('guardian chain evidence requires a confirmed reserve');
  }
  if (challengeConfirmations !== 0) throw new Error('guardian chain evidence requires an unconfirmed challenge');
  return {
    chain: String(evidence.chain || ''),
    height,
    bestBlockHash: assertHex(evidence.bestBlockHash, 32, 'guardian bestBlockHash'),
    challengeConfirmations,
    reserveConfirmations,
    reserveStatus: String(evidence.reserveStatus || '')
  };
}

function approvalCore(plan, reserve, chainEvidence, authorizedAt, guardianXonlyInput = null) {
  const binding = reserveBindingForPlan(reserve, plan);
  const sighash = reserveSpendSighash(plan, reserve).toString('hex');
  const guardianXonly = String(guardianXonlyInput || binding.guardianXonlys[0]).toLowerCase();
  if (!binding.guardianXonlys.includes(guardianXonly)) throw new Error('guardian is not in the fee reserve policy');
  const core = {
    kind: 'utxoref_v2_reserve_cpfp_guardian_approval_v1',
    planHash: plan.planHash,
    graphHash: plan.graphHash,
    reserveHash: plan.reserveHash,
    reserveOutpoint: plan.reserve.outpoint,
    reserveInputIndex: 1,
    transactionTxid: plan.txid,
    unsignedTransactionHash: sha256Hex(Buffer.from(plan.unsignedTxHex, 'hex')),
    outputSats: plan.outputSats,
    outputScriptPubKeyHex: plan.outputScriptPubKeyHex,
    feeSats: plan.feeSats,
    transactionSighash: sighash,
    guardianXonly,
    vaultId: reserve.core.vaultManifest.core.vaultId,
    immediateLeafHash: binding.immediateLeaf.leafHash,
    chainEvidence: normalizeChainEvidence(chainEvidence),
    authorizedAt: String(authorizedAt || new Date().toISOString())
  };
  if (binding.guardianPolicyKind === 'guardian-quorum') {
    core.guardianSetHash = binding.guardianSetHash;
    core.guardianThreshold = binding.guardianThreshold;
    core.guardianCount = binding.guardianXonlys.length;
  }
  return core;
}

function buildReserveGuardianApproval(plan, reserve, chainEvidence, guardianSecretInput, options = {}) {
  const guardianSecret = typeof guardianSecretInput === 'bigint'
    ? guardianSecretInput
    : secretFromHex(guardianSecretInput, 'guardianSecret');
  const binding = reserveBindingForPlan(reserve, plan);
  const guardianXonly = a.xOnlyPubkey(guardianSecret).toString('hex');
  if (!binding.guardianXonlys.includes(guardianXonly)) throw new Error('guardian secret does not match the fee reserve');
  const core = approvalCore(plan, reserve, chainEvidence, options.authorizedAt, guardianXonly);
  const authorizationDigest = Buffer.from(sha256Hex(core), 'hex');
  const signed = {
    kind: 'utxoref_v2_reserve_cpfp_guardian_approval',
    version: 1,
    approved: true,
    core,
    transactionSignature: a.schnorrSign(
      guardianSecret,
      Buffer.from(core.transactionSighash, 'hex')
    ).toString('hex'),
    authorizationSignature: a.schnorrSign(guardianSecret, authorizationDigest).toString('hex')
  };
  signed.approvalHash = sha256Hex(signed);
  return signed;
}

function verifyReserveGuardianApproval(approval, plan, reserve) {
  try {
    if (!approval || approval.kind !== 'utxoref_v2_reserve_cpfp_guardian_approval' || approval.version !== 1 ||
        approval.approved !== true) {
      return { ok: false, reason: 'wrong guardian approval kind, version, or disposition' };
    }
    const approvalCopy = { ...approval };
    delete approvalCopy.approvalHash;
    if (approval.approvalHash !== sha256Hex(approvalCopy)) return { ok: false, reason: 'guardian approval hash mismatch' };
    const expectedCore = approvalCore(
      plan,
      reserve,
      approval.core?.chainEvidence,
      approval.core?.authorizedAt,
      approval.core?.guardianXonly
    );
    if (stableStringify(approval.core) !== stableStringify(expectedCore)) {
      return { ok: false, reason: 'guardian approval does not bind the exact reserve CPFP plan' };
    }
    const guardian = Buffer.from(expectedCore.guardianXonly, 'hex');
    const transactionSignature = Buffer.from(assertHex(approval.transactionSignature, 64, 'transactionSignature'), 'hex');
    const authorizationSignature = Buffer.from(assertHex(approval.authorizationSignature, 64, 'authorizationSignature'), 'hex');
    if (!a.schnorrVerify(guardian, Buffer.from(expectedCore.transactionSighash, 'hex'), transactionSignature)) {
      return { ok: false, reason: 'guardian transaction signature is invalid' };
    }
    const authorizationDigest = Buffer.from(sha256Hex(expectedCore), 'hex');
    if (!a.schnorrVerify(guardian, authorizationDigest, authorizationSignature)) {
      return { ok: false, reason: 'guardian authorization signature is invalid' };
    }
    return {
      ok: true,
      reason: null,
      approvalHash: approval.approvalHash,
      transactionSignature: approval.transactionSignature,
      chainEvidence: expectedCore.chainEvidence
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function normalizeGuardianApprovals(approvals) {
  if (Array.isArray(approvals)) return approvals;
  return approvals ? [approvals] : [];
}

function verifyReserveGuardianApprovalSet(approvalsInput, plan, reserve) {
  const approvals = normalizeGuardianApprovals(approvalsInput);
  const binding = reserveBindingForPlan(reserve, plan);
  if (approvals.length > binding.guardianXonlys.length) {
    return { ok: false, reason: 'guardian approval count exceeds the committed guardian set', checks: [] };
  }
  const byGuardian = {};
  const checks = [];
  for (const approval of approvals) {
    const check = verifyReserveGuardianApproval(approval, plan, reserve);
    if (!check.ok) return { ok: false, reason: check.reason, checks };
    const guardianXonly = approval.core.guardianXonly;
    if (byGuardian[guardianXonly]) return { ok: false, reason: 'duplicate guardian approval', checks };
    byGuardian[guardianXonly] = {
      approval,
      transactionSignature: check.transactionSignature
    };
    checks.push({ guardianXonly, approvalHash: check.approvalHash, chainEvidence: check.chainEvidence });
  }
  const approvedGuardianCount = Object.keys(byGuardian).length;
  if (approvedGuardianCount < binding.guardianThreshold) {
    return {
      ok: false,
      reason: `guardian approval threshold not met: ${approvedGuardianCount}/${binding.guardianThreshold}`,
      checks
    };
  }
  const approvalHashes = checks.map((check) => check.approvalHash).sort();
  return {
    ok: true,
    reason: null,
    guardianThreshold: binding.guardianThreshold,
    guardianCount: binding.guardianXonlys.length,
    approvedGuardianCount,
    guardianXonlys: binding.guardianXonlys,
    byGuardian,
    checks,
    approvalHashes,
    approvalSetHash: sha256Hex({
      kind: 'utxoref_v2_reserve_cpfp_guardian_approval_set_v1',
      planHash: plan.planHash,
      guardianSetHash: binding.guardianSetHash,
      approvalHashes
    })
  };
}

function assertDecodedPlanBinding(plan, decoded, options = {}) {
  if (decoded?.txid !== plan.txid) throw new Error('decoded reserve CPFP txid does not match the exact plan');
  if (!Array.isArray(decoded.vin) || decoded.vin.length !== 2) throw new Error('reserve CPFP must have exactly two inputs');
  const expectedInputs = [plan.challenge, plan.reserve];
  for (let index = 0; index < expectedInputs.length; index++) {
    const input = decoded.vin[index];
    const expected = expectedInputs[index];
    if (input.txid !== expected.txid || Number(input.vout) !== Number(expected.vout)) {
      throw new Error(`reserve CPFP input ${index} outpoint mismatch`);
    }
    if (Number(input.sequence) !== RBF_SEQUENCE) throw new Error(`reserve CPFP input ${index} sequence mismatch`);
    if (String(input.scriptSig?.hex || '') !== '') throw new Error(`reserve CPFP input ${index} scriptSig must be empty`);
  }
  if (!Array.isArray(decoded.vout) || decoded.vout.length !== 1) throw new Error('reserve CPFP must have exactly one output');
  if (btcToSats(decoded.vout[0].value) !== BigInt(plan.outputSats)) throw new Error('reserve CPFP output amount mismatch');
  if (String(decoded.vout[0].scriptPubKey?.hex || '').toLowerCase() !== plan.outputScriptPubKeyHex) {
    throw new Error('reserve CPFP output script mismatch');
  }
  if (options.requireWalletWitness) {
    if (!Array.isArray(decoded.vin[0].txinwitness) || decoded.vin[0].txinwitness.length === 0) {
      throw new Error('wallet did not sign the challenge input');
    }
    if (Array.isArray(decoded.vin[1].txinwitness) && decoded.vin[1].txinwitness.length !== 0) {
      throw new Error('wallet unexpectedly supplied the reserve witness');
    }
  }
  return true;
}

function assertExistingReserveCpfpBinding(plan, decoded) {
  if (decoded?.txid !== plan.replacementOf) throw new Error('tracked reserve CPFP decoded txid mismatch');
  if (!Array.isArray(decoded.vin) || decoded.vin.length !== 2) throw new Error('tracked reserve CPFP must have two inputs');
  const expectedInputs = [plan.challenge, plan.reserve];
  for (let index = 0; index < expectedInputs.length; index++) {
    if (decoded.vin[index].txid !== expectedInputs[index].txid ||
        Number(decoded.vin[index].vout) !== Number(expectedInputs[index].vout)) {
      throw new Error(`tracked reserve CPFP input ${index} mismatch`);
    }
    if (Number(decoded.vin[index].sequence) !== RBF_SEQUENCE) {
      throw new Error(`tracked reserve CPFP input ${index} is not replaceable`);
    }
  }
  if (!Array.isArray(decoded.vout) || decoded.vout.length !== 1) throw new Error('tracked reserve CPFP must have one output');
  if (btcToSats(decoded.vout[0].value) !== BigInt(plan.replacementOutputSats)) {
    throw new Error('tracked reserve CPFP output amount mismatch');
  }
  if (String(decoded.vout[0].scriptPubKey?.hex || '').toLowerCase() !== plan.outputScriptPubKeyHex) {
    throw new Error('tracked reserve CPFP output script mismatch');
  }
  return true;
}

function coreOutput(decoded, vout, fieldName) {
  const output = decoded?.vout?.find((candidate) => Number(candidate.n) === Number(vout));
  if (!output) throw new Error(`${fieldName} output is unavailable`);
  return output;
}

function assertCoreOutput(output, amountSats, scriptPubKeyHex, fieldName) {
  if (btcToSats(output.value) !== BigInt(amountSats)) throw new Error(`${fieldName} amount does not match Core`);
  if (String(output.scriptPubKey?.hex || '').toLowerCase() !== String(scriptPubKeyHex).toLowerCase()) {
    throw new Error(`${fieldName} script does not match Core`);
  }
}

async function preflightReserveCpfpInputs(plan, reserve, rpc) {
  assertPlanHash(plan);
  const chain = await rpc('getblockchaininfo');
  const expectedChain = expectedCoreChain(reserve.core.network);
  if (chain.chain !== expectedChain) throw new Error(`wrong chain: expected ${expectedChain}, got ${chain.chain}`);
  const currentHeight = Number(chain.blocks);
  if (!Number.isSafeInteger(currentHeight) || currentHeight < 0) throw new Error('Core returned an invalid chain height');
  let challengeConfirmations = 0;
  let reserveConfirmations;
  let reserveTxout;
  let reserveStatus;
  if (plan.replacementOf) {
    const mempoolEntry = await rpc('getmempoolentry', [plan.replacementOf]);
    if (mempoolEntry?.['bip125-replaceable'] !== true) throw new Error('tracked reserve CPFP is not BIP125-replaceable');
    const existing = await rpc('getrawtransaction', [plan.replacementOf, true]);
    assertExistingReserveCpfpBinding(plan, existing);
    const challengeParent = await rpc('getrawtransaction', [plan.challenge.txid, true]);
    assertCoreOutput(
      coreOutput(challengeParent, plan.challenge.vout, 'challenge parent'),
      plan.challenge.amountSats,
      plan.challenge.scriptPubKeyHex,
      'challenge parent'
    );
    challengeConfirmations = Number(challengeParent.confirmations || 0);
    if (challengeConfirmations !== 0) throw new Error('reserve CPFP replacement requires an unconfirmed challenge parent');
    const reserveFunding = await rpc('getrawtransaction', [plan.reserve.txid, true]);
    const reserveOutput = coreOutput(reserveFunding, plan.reserve.vout, 'fee reserve funding');
    assertCoreOutput(reserveOutput, plan.reserve.amountSats, plan.reserve.scriptPubKeyHex, 'fee reserve funding');
    reserveConfirmations = Number(reserveFunding.confirmations || 0);
    reserveTxout = {
      value: reserveOutput.value,
      confirmations: reserveConfirmations,
      bestblock: chain.bestblockhash,
      scriptPubKey: { hex: reserveOutput.scriptPubKey.hex }
    };
    reserveStatus = 'committed_to_replacement';
  } else {
    const challengeTxout = await rpc('gettxout', [plan.challenge.txid, plan.challenge.vout, true]);
    if (!challengeTxout) throw new Error('tracked challenge output is spent or missing');
    assertRpcSnapshotTip(challengeTxout, chain.bestblockhash, 'challenge output');
    challengeConfirmations = Number(challengeTxout.confirmations || 0);
    if (challengeConfirmations !== 0) throw new Error('reserve CPFP is restricted to an unconfirmed challenge output');
    assertCoreOutput({ value: challengeTxout.value, scriptPubKey: challengeTxout.scriptPubKey },
      plan.challenge.amountSats, plan.challenge.scriptPubKeyHex, 'challenge output');
    reserveTxout = await rpc('gettxout', [plan.reserve.txid, plan.reserve.vout, true]);
    if (!reserveTxout) throw new Error('fee reserve output is spent or missing');
    assertRpcSnapshotTip(reserveTxout, chain.bestblockhash, 'fee reserve output');
    reserveConfirmations = Number(reserveTxout.confirmations || 0);
    reserveStatus = 'available';
  }
  const reserveVerification = verifyUtxorefV2FeeReserve(reserve, {
    graphHash: plan.graphHash,
    currentHeight,
    minimumFeeReserveSats: plan.reserve.maxFeeSats,
    txout: reserveTxout
  });
  if (!reserveVerification.ok || !reserveVerification.counted) {
    throw new Error(`fee reserve failed live verification: ${reserveVerification.reason}`);
  }
  return {
    chain,
    reserveVerification,
    chainEvidence: {
      chain: chain.chain,
      height: currentHeight,
      bestBlockHash: chain.bestblockhash,
      challengeConfirmations,
      reserveConfirmations,
      reserveStatus
    }
  };
}

async function verifyApprovalChainFreshness(approval, rpc, chain, options = {}) {
  const evidence = normalizeChainEvidence(approval.core?.chainEvidence);
  if (evidence.chain !== chain.chain) throw new Error('guardian approval was issued for a different chain');
  const currentHeight = Number(chain.blocks);
  const maxAge = Number(options.maxApprovalAgeBlocks ?? DEFAULT_MAX_APPROVAL_AGE_BLOCKS);
  if (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > 144) throw new Error('maxApprovalAgeBlocks is invalid');
  if (currentHeight < evidence.height) throw new Error('guardian approval height is ahead of the current chain');
  if (currentHeight - evidence.height > maxAge) throw new Error('guardian approval is stale');
  const activeHash = await rpc('getblockhash', [evidence.height]);
  if (activeHash !== evidence.bestBlockHash) throw new Error('guardian approval chain tip was reorged');
  return { ageBlocks: currentHeight - evidence.height, activeHash };
}

async function walletSignChallengeInput(plan, args, rpc) {
  if (!args.wallet) throw new Error('--wallet is required for challenge-input signing');
  const prevouts = [plan.challenge, plan.reserve].map((input) => ({
    txid: input.txid,
    vout: Number(input.vout),
    scriptPubKey: input.scriptPubKeyHex,
    amount: Number(input.amountSats) / 100000000
  }));
  if (prevouts.some((input) => !Number.isSafeInteger(Math.round(input.amount * 100000000)))) {
    throw new Error('reserve CPFP prevout amount exceeds exact RPC numeric range');
  }
  const signed = await rpc('signrawtransactionwithwallet', [plan.unsignedTxHex, prevouts], args.wallet);
  if (!signed?.hex) throw new Error('wallet did not return a partially signed reserve CPFP');
  const decoded = await rpc('decoderawtransaction', [signed.hex]);
  assertDecodedPlanBinding(plan, decoded, { requireWalletWitness: true });
  return {
    partialHex: signed.hex,
    complete: signed.complete === true,
    walletWitness: decoded.vin[0].txinwitness.map((item) => String(item).toLowerCase()),
    decoded
  };
}

function finalizeReserveCpfp(plan, reserve, approvals, challengerSecretInput, walletWitness) {
  const approvalCheck = verifyReserveGuardianApprovalSet(approvals, plan, reserve);
  if (!approvalCheck.ok) throw new Error(`guardian approval rejected: ${approvalCheck.reason}`);
  if (!Array.isArray(walletWitness) || walletWitness.length === 0) throw new Error('challenge wallet witness is required');
  const normalizedWalletWitness = walletWitness.map((item, index) => assertHexBytes(item, `walletWitness[${index}]`));
  const challengerSecret = typeof challengerSecretInput === 'bigint'
    ? challengerSecretInput
    : secretFromHex(challengerSecretInput, 'challengerSecret');
  const binding = reserveBindingForPlan(reserve, plan);
  const manifest = reserve.core.vaultManifest;
  const challengerXonly = a.xOnlyPubkey(challengerSecret).toString('hex');
  if (challengerXonly !== manifest.core.operatorXonly) {
    throw new Error('challenger secret does not match the fee reserve operator key');
  }
  const sighash = reserveSpendSighash(plan, reserve);
  const challengerSignature = a.schnorrSign(challengerSecret, sighash).toString('hex');
  if (!a.schnorrVerify(Buffer.from(challengerXonly, 'hex'), sighash, Buffer.from(challengerSignature, 'hex'))) {
    throw new Error('challenger transaction signature failed self-verification');
  }
  const leaf = binding.immediateLeaf;
  const guardianSignatureSlots = [...binding.guardianXonlys]
    .reverse()
    .map((guardianXonly) => approvalCheck.byGuardian[guardianXonly]?.transactionSignature || '');
  const witnessTxHex = tr.serializeWitnessTx(2, [
    {
      outpoint: tr.outpoint(plan.challenge.txid, plan.challenge.vout),
      sequence: RBF_SEQUENCE,
      witness: normalizedWalletWitness
    },
    {
      outpoint: tr.outpoint(plan.reserve.txid, plan.reserve.vout),
      sequence: RBF_SEQUENCE,
      witness: [...guardianSignatureSlots, challengerSignature, leaf.scriptHex, leaf.controlBlock]
    }
  ], [{ valueSats: BigInt(plan.outputSats), script: plan.outputScriptPubKeyHex }], 0);
  return {
    witnessTxHex,
    txid: plan.txid,
    reserveSighash: sighash.toString('hex'),
    challengerSignature,
    guardianTransactionSignatures: guardianSignatureSlots,
    guardianTransactionSignature: guardianSignatureSlots.find((signature) => signature) || null,
    guardianApprovalHashes: approvalCheck.approvalHashes,
    guardianApprovalSetHash: approvalCheck.approvalSetHash,
    guardianApprovalHash: approvalCheck.approvalSetHash
  };
}

function mempoolRejectReason(result) {
  return result?.['reject-reason'] || result?.['reject-details'] || null;
}

async function preflightFinalTransaction(plan, reserve, approvalsInput, challengerSecret, args, rpc, inputPreflight = null) {
  const inputs = inputPreflight || await preflightReserveCpfpInputs(plan, reserve, rpc);
  const approvals = normalizeGuardianApprovals(approvalsInput);
  const approvalCheck = verifyReserveGuardianApprovalSet(approvals, plan, reserve);
  if (!approvalCheck.ok) throw new Error(`guardian approval rejected: ${approvalCheck.reason}`);
  const approvalFreshnesses = [];
  for (const approval of approvals) {
    approvalFreshnesses.push(await verifyApprovalChainFreshness(approval, rpc, inputs.chain, args));
  }
  const approvalFreshness = {
    ageBlocks: Math.max(...approvalFreshnesses.map((freshness) => freshness.ageBlocks)),
    approvals: approvalFreshnesses
  };
  const walletSigning = await walletSignChallengeInput(plan, args, rpc);
  const finalized = finalizeReserveCpfp(plan, reserve, approvals, challengerSecret, walletSigning.walletWitness);
  const decodedFinal = await rpc('decoderawtransaction', [finalized.witnessTxHex]);
  assertDecodedPlanBinding(plan, decodedFinal);
  const reserveWitness = decodedFinal.vin[1].txinwitness || [];
  const binding = reserveBindingForPlan(reserve, plan);
  const expectedReserveWitness = [
    ...finalized.guardianTransactionSignatures,
    finalized.challengerSignature,
    binding.immediateLeaf.scriptHex,
    binding.immediateLeaf.controlBlock
  ];
  if (stableStringify(reserveWitness.map((item) => String(item).toLowerCase())) !== stableStringify(expectedReserveWitness)) {
    throw new Error('final reserve witness differs from the approved tapscript path');
  }
  const [mempoolAccept] = plan.replacementOf
    ? [{ allowed: null, replacementPreflight: 'sendrawtransaction-required-for-conflict' }]
    : await rpc('testmempoolaccept', [[finalized.witnessTxHex]]);
  if (mempoolAccept?.txid && mempoolAccept.txid !== plan.txid) throw new Error('reserve CPFP preflight txid mismatch');
  return { inputs, approvalCheck, approvalFreshness, walletSigning, finalized, decodedFinal, mempoolAccept };
}

function updateReserveCpfpState(state, plan, preflight, broadcastTxid) {
  const at = new Date().toISOString();
  const priorChild = state.challenge.cpfp || null;
  const replacementRecord = priorChild ? {
    txid: priorChild.txid,
    wtxid: priorChild.wtxid || null,
    feeSats: String(priorChild.feeSats),
    outputSats: String(priorChild.outputSats),
    reserveHash: priorChild.reserveHash,
    reserveOutpoint: priorChild.reserveOutpoint,
    guardianApprovalHash: priorChild.guardianApprovalHash || null,
    guardianApprovalHashes: priorChild.guardianApprovalHashes || [],
    broadcastAt: priorChild.broadcastAt || null,
    replacedAt: at,
    replacementTxid: broadcastTxid
  } : null;
  state.challenge.cpfp = {
    mode: 'reserve-backed',
    txid: broadcastTxid,
    wtxid: preflight.decodedFinal?.hash || preflight.mempoolAccept?.wtxid || null,
    vout: 0,
    parentTxid: plan.challenge.txid,
    feeSats: plan.feeSats,
    outputSats: plan.outputSats,
    scriptPubKeyHex: plan.outputScriptPubKeyHex,
    reserveHash: plan.reserveHash,
    reserveOutpoint: plan.reserve.outpoint,
    reserveAmountSats: plan.reserve.amountSats,
    guardianApprovalHash: preflight.approvalCheck.approvalSetHash,
    guardianApprovalHashes: preflight.approvalCheck.approvalHashes,
    broadcastAt: at,
    confirmation: null,
    replacements: replacementRecord
      ? [...(priorChild.replacements || []), replacementRecord]
      : []
  };
  const priorLifecycle = state.challenge.feeReserveLifecycle || null;
  state.challenge.feeReserveLifecycle = {
    reserveHash: plan.reserveHash,
    outpoint: plan.reserve.outpoint,
    amountSats: plan.reserve.amountSats,
    status: plan.replacementOf ? 'committed_to_replacement' : 'committed_to_cpfp',
    activeCpfpTxid: broadcastTxid,
    guardianApprovalHash: preflight.approvalCheck.approvalSetHash,
    guardianApprovalHashes: preflight.approvalCheck.approvalHashes,
    committedAt: priorLifecycle?.committedAt || at,
    updatedAt: at,
    confirmation: null,
    replacements: replacementRecord
      ? [...(priorLifecycle?.replacements || []), replacementRecord]
      : (priorLifecycle?.replacements || [])
  };
}

async function runReserveCpfp(state, args, rpc, artifact, reserve, approvals, challengerSecret) {
  const plan = buildReserveCpfpPlan(state, args, artifact, reserve);
  const preflight = await preflightFinalTransaction(plan, reserve, approvals, challengerSecret, args, rpc);
  const result = {
    ...plan,
    guardianApprovalHash: preflight.approvalCheck.approvalSetHash,
    guardianApprovalSetHash: preflight.approvalCheck.approvalSetHash,
    guardianApprovalHashes: preflight.approvalCheck.approvalHashes,
    approvedGuardianCount: preflight.approvalCheck.approvedGuardianCount,
    approvalAgeBlocks: preflight.approvalFreshness.ageBlocks,
    mempoolAccept: preflight.mempoolAccept,
    broadcast: false
  };
  if (!plan.replacementOf && !preflight.mempoolAccept?.allowed) {
    result.rejectReason = mempoolRejectReason(preflight.mempoolAccept);
    return { action: 'reserve_cpfp_preflight_rejected', result };
  }
  if (!args.broadcast) {
    return {
      action: plan.replacementOf ? 'reserve_cpfp_replacement_ready_for_broadcast' : 'reserve_cpfp_ready_for_broadcast',
      result
    };
  }
  const broadcastTxid = await rpc('sendrawtransaction', [preflight.finalized.witnessTxHex]);
  if (broadcastTxid !== plan.txid) {
    throw new Error(`reserve CPFP txid mismatch: expected ${plan.txid}, got ${broadcastTxid}`);
  }
  updateReserveCpfpState(state, plan, preflight, broadcastTxid);
  result.broadcast = true;
  result.broadcastTxid = broadcastTxid;
  return { action: plan.replacementOf ? 'reserve_cpfp_replaced' : 'reserve_cpfp_broadcast', result };
}

function resolveRpc(args, requestId = 'utxoref-v2-reserve-cpfp') {
  const rpcUrl = args.rpcUrl || process.env.BTC_RPC_URL;
  const rpcUser = args.rpcUser || process.env.BTC_RPC_USER;
  const rpcPass = args.rpcPass || process.env.BTC_RPC_PASS;
  if (!rpcUrl || !rpcUser || !rpcPass) {
    throw new Error('reserve CPFP requires BTC_RPC_URL, BTC_RPC_USER, and BTC_RPC_PASS');
  }
  return rpcFactory({ rpcUrl, rpcUser, rpcPass, requestId });
}

function loadInputs(args) {
  const statePath = path.resolve(args.statePath || DEFAULT_STATE_PATH);
  const artifactPath = path.resolve(args.artifact || DEFAULT_ARTIFACT_PATH);
  const trustPolicyPath = path.resolve(args.trustPolicy || DEFAULT_TRUST_POLICY_PATH);
  if (!args.feeReserve) throw new Error('--fee-reserve is required');
  const state = loadState(statePath);
  const artifact = readJsonStrictProfile(artifactPath, 'utxoref-v2-public-artifact', 'public artifact');
  const trustPolicy = readJsonStrictProfile(trustPolicyPath, 'utxoref-v2-trust-policy', 'trust policy');
  const reserve = readJsonStrictProfile(path.resolve(args.feeReserve), 'utxoref-v2-fee-reserve', 'fee reserve');
  const inspected = inspectArtifact(artifact, trustPolicy);
  assertTrustPolicyReserve(inspected, reserve);
  return { statePath, state, artifact, trustPolicy, reserve, inspected };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  if (!args.guardianApproval) throw new Error('--guardian-approval is required');
  if (!args.challengerSecretFile) throw new Error('--challenger-secret-file is required');
  const inputs = loadInputs(args);
  const approvals = (args.guardianApprovals || [args.guardianApproval]).map((approvalPath, index) =>
    readJsonStrictProfile(
      path.resolve(approvalPath),
      'utxoref-v2-reserve-cpfp-approval',
      `guardian approval ${index + 1}`
    )
  );
  const challengerSecret = readSecretFile(args.challengerSecretFile, 'challengerSecret');
  const outcome = await runReserveCpfp(
    inputs.state,
    args,
    resolveRpc(args),
    inputs.artifact,
    inputs.reserve,
    approvals,
    challengerSecret
  );
  if (outcome.action === 'reserve_cpfp_broadcast' || outcome.action === 'reserve_cpfp_replaced') {
    saveJsonAtomic(inputs.statePath, inputs.state);
  }
  console.log(JSON.stringify(outcome));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef V2 reserve CPFP failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_MAX_APPROVAL_AGE_BLOCKS,
  MIN_OUTPUT_SATS,
  RBF_SEQUENCE,
  parseArgs,
  positiveSats,
  assertHexBytes,
  expectedCoreChain,
  planHash,
  assertPlanHash,
  reserveBinding,
  reserveGuardianPolicy,
  reserveBindingForPlan,
  assertTrustPolicyReserve,
  buildReserveCpfpPlan,
  reserveSpendSighash,
  normalizeChainEvidence,
  approvalCore,
  buildReserveGuardianApproval,
  verifyReserveGuardianApproval,
  normalizeGuardianApprovals,
  verifyReserveGuardianApprovalSet,
  assertDecodedPlanBinding,
  assertExistingReserveCpfpBinding,
  preflightReserveCpfpInputs,
  verifyApprovalChainFreshness,
  walletSignChallengeInput,
  finalizeReserveCpfp,
  preflightFinalTransaction,
  updateReserveCpfpState,
  runReserveCpfp,
  readSecretFile,
  resolveRpc,
  loadInputs
};
