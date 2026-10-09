/**
 * Ark ZK miniscript proof artifacts.
 *
 * This is the bridge from existing UTXORef Ark/Taproot evidence manifests to
 * the small Cairo/STWO public claim proved by ark-shinigami.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  MAX_TAPROOT_PATH_DEPTH,
  buildArkTaprootMiniscriptProofManifest,
  verifyArkTaprootMiniscriptProofManifest
} = require('./ark_taproot_miniscript_proof_manifest');
const { buildArkDlcSettlementBundle } = require('./ark_dlc_settlement');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts', 'ark_zk_miniscript');
const SUMMARY_PATH = path.join(ARTIFACTS_DIR, 'ark_zk_miniscript_summary_latest.json');
const HEX_32_RE = /^[0-9a-f]{64}$/i;
const FELT_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

const ROLE_CODES = Object.freeze({
  cooperative_round: 1,
  owner_csv_exit: 2,
  asp_forfeit_guard: 3,
  dlc_virtual_cet_settlement: 4,
  utxoref_challenge_publication: 5
});

const ROLE_ORDER = Object.freeze(Object.keys(ROLE_CODES));

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256FileHex(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function stringifyJson(value, pretty = true) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v), pretty ? 2 : 0);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${stringifyJson(value, true)}\n`, 'utf8');
}

function normalizeHex32(value, fieldName) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!HEX_32_RE.test(normalized)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return normalized;
}

function normalizeRole(role) {
  const normalized = String(role || '').trim();
  if (!Object.prototype.hasOwnProperty.call(ROLE_CODES, normalized)) {
    throw new Error(`unsupported Ark miniscript role: ${role}`);
  }
  return normalized;
}

function toCairoHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function feltMod(value) {
  const v = BigInt(value) % FELT_PRIME;
  return v >= 0n ? v : v + FELT_PRIME;
}

function mix(left, right) {
  return feltMod(BigInt(left) * 31n + BigInt(right) * 17n + 7n);
}

function hex32ToU128Limbs(hex, fieldName = 'hex32') {
  const normalized = normalizeHex32(hex, fieldName);
  return {
    hi: BigInt(`0x${normalized.slice(0, 32)}`),
    lo: BigInt(`0x${normalized.slice(32)}`),
    hiHex: `0x${normalized.slice(0, 32).replace(/^0+/, '') || '0'}`,
    loHex: `0x${normalized.slice(32).replace(/^0+/, '') || '0'}`
  };
}

function mixHashLimbs(limbs) {
  return mix(limbs.hi, limbs.lo);
}

function mixPathBranch(current, sibling, siblingSide) {
  if (siblingSide === 'left') return mix(sibling, current);
  if (siblingSide === 'right') return mix(current, sibling);
  throw new Error(`unsupported Taproot path sibling side: ${siblingSide}`);
}

function emptyPathSibling() {
  return {
    siblingHash: '0'.repeat(64),
    siblingSide: 'right',
    siblingSideCode: 0,
    siblingHashLimbs: hex32ToU128Limbs('0'.repeat(64), 'emptyPathSibling')
  };
}

function buildTaprootPathWitness(manifest) {
  const proof = manifest.selectedTaprootPath;
  if (!proof || !Array.isArray(proof.path)) {
    throw new Error('manifest selected Taproot path is missing');
  }
  if (proof.path.length > MAX_TAPROOT_PATH_DEPTH) {
    throw new Error(`selected Taproot path exceeds max depth ${MAX_TAPROOT_PATH_DEPTH}`);
  }

  let pathFold = mixHashLimbs(hex32ToU128Limbs(proof.selectedTapLeafHash, 'selectedTapLeafHash'));
  const usedSiblings = proof.path.map(step => {
    const siblingHash = normalizeHex32(step.siblingHash, 'path sibling hash');
    const siblingHashLimbs = hex32ToU128Limbs(siblingHash, 'path sibling hash');
    const sibling = mixHashLimbs(siblingHashLimbs);
    pathFold = mixPathBranch(pathFold, sibling, step.siblingSide);
    return {
      siblingHash,
      siblingSide: step.siblingSide,
      siblingSideCode: step.siblingSide === 'left' ? 1 : 0,
      siblingHashLimbs
    };
  });

  const pathSiblings = [...usedSiblings];
  while (pathSiblings.length < MAX_TAPROOT_PATH_DEPTH) {
    pathSiblings.push(emptyPathSibling());
  }

  return {
    pathCommitment: normalizeHex32(proof.pathCommitment, 'taprootPathCommitment'),
    pathCommitmentLimbs: hex32ToU128Limbs(proof.pathCommitment, 'taprootPathCommitment'),
    pathDepth: proof.path.length,
    pathFold,
    pathFoldHex: toCairoHex(pathFold),
    pathSiblings
  };
}

function resolveExitDelay(manifest, selectedLeaf, override) {
  const raw =
    override ??
    selectedLeaf.leafCore.relativeTimelockBlocks ??
    manifest.manifestCore.challengeWindowBlocks ??
    1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('exitDelay must be a non-negative number');
  }
  return value > 0 ? value : Number(manifest.manifestCore.challengeWindowBlocks || 1);
}

function computeArkZkMiniscriptBinding(fields) {
  const manifestId = mixHashLimbs(hex32ToU128Limbs(fields.manifestId, 'manifestId'));
  const taprootRoot = mixHashLimbs(hex32ToU128Limbs(fields.taprootRoot, 'taprootRoot'));
  const selectedLeafHash = mixHashLimbs(hex32ToU128Limbs(fields.selectedLeafHash, 'selectedLeafHash'));
  const taprootPathCommitment = mixHashLimbs(
    hex32ToU128Limbs(fields.taprootPathCommitment, 'taprootPathCommitment')
  );
  const taprootPathFold = BigInt(fields.taprootPathFold);
  const settlementHash = mixHashLimbs(hex32ToU128Limbs(fields.settlementHash, 'settlementHash'));
  const roleCode = BigInt(fields.selectedLeafRoleCode);
  const amount = normalizeAmountSats(fields.amountSats, 'amountSats');
  const delay = BigInt(fields.exitDelay);

  const policyPair = mix(manifestId, taprootRoot);
  const pathPair = mix(taprootPathCommitment, taprootPathFold);
  const leafPair = mix(selectedLeafHash, roleCode);
  const policyPath = mix(policyPair, pathPair);
  const policyLeaf = mix(policyPath, leafPair);
  const settlementAmount = mix(settlementHash, amount);
  const settlementDelay = mix(settlementAmount, delay);
  return mix(policyLeaf, settlementDelay);
}

function buildArkZkMiniscriptClaim(manifest, options = {}) {
  const verification = verifyArkTaprootMiniscriptProofManifest(manifest);
  if (!verification.ok) {
    throw new Error(`manifest failed verification: ${verification.reason}`);
  }

  const selectedLeafRole = normalizeRole(manifest.manifestCore.selectedLeafRole);
  const selectedLeaf = manifest.taprootLeaves.find(leaf => leaf.role === selectedLeafRole);
  const settlementHash = normalizeHex32(
    options.settlementHash || manifest.manifestCore.settlementRoot || manifest.manifestCore.publicInputDigest,
    'settlementHash'
  );
  const amountSats = normalizeAmountSats(manifest.manifestCore.amountSats, 'amountSats');
  const exitDelay = resolveExitDelay(manifest, selectedLeaf, options.exitDelay);
  const roleCode = ROLE_CODES[selectedLeafRole];
  const pathWitness = buildTaprootPathWitness(manifest);

  const hashes = {
    manifestId: normalizeHex32(manifest.manifestId, 'manifestId'),
    taprootRoot: normalizeHex32(manifest.manifestCore.taprootLeafRoot, 'taprootRoot'),
    selectedLeafHash: normalizeHex32(manifest.manifestCore.selectedTapLeafHash, 'selectedLeafHash'),
    taprootPathCommitment: pathWitness.pathCommitment,
    settlementHash
  };
  const limbs = {
    manifestId: hex32ToU128Limbs(hashes.manifestId, 'manifestId'),
    taprootRoot: hex32ToU128Limbs(hashes.taprootRoot, 'taprootRoot'),
    selectedLeafHash: hex32ToU128Limbs(hashes.selectedLeafHash, 'selectedLeafHash'),
    taprootPathCommitment: pathWitness.pathCommitmentLimbs,
    settlementHash: hex32ToU128Limbs(hashes.settlementHash, 'settlementHash')
  };
  const binding = computeArkZkMiniscriptBinding({
    ...hashes,
    selectedLeafRoleCode: roleCode,
    taprootPathFold: pathWitness.pathFold,
    amountSats,
    exitDelay
  });

  const siblingInput = pathWitness.pathSiblings.flatMap(sibling => [
    sibling.siblingHashLimbs.hiHex,
    sibling.siblingHashLimbs.loHex,
    toCairoHex(sibling.siblingSideCode)
  ]);

  const cairoInput = [
    limbs.manifestId.hiHex,
    limbs.manifestId.loHex,
    limbs.taprootRoot.hiHex,
    limbs.taprootRoot.loHex,
    limbs.selectedLeafHash.hiHex,
    limbs.selectedLeafHash.loHex,
    toCairoHex(roleCode),
    limbs.taprootPathCommitment.hiHex,
    limbs.taprootPathCommitment.loHex,
    pathWitness.pathFoldHex,
    toCairoHex(pathWitness.pathDepth),
    ...siblingInput,
    limbs.settlementHash.hiHex,
    limbs.settlementHash.loHex,
    toCairoHex(amountSats),
    toCairoHex(exitDelay),
    toCairoHex(binding)
  ];

  const claimCore = {
    version: 1,
    protocol: 'ark_zk_miniscript_manifest_binding_claim',
    manifestId: hashes.manifestId,
    taprootRoot: hashes.taprootRoot,
    selectedLeafHash: hashes.selectedLeafHash,
    selectedLeafRole,
    selectedLeafRoleCode: roleCode,
    taprootPathCommitment: hashes.taprootPathCommitment,
    taprootPathDepth: pathWitness.pathDepth,
    taprootPathFold: pathWitness.pathFoldHex,
    taprootPathSiblings: pathWitness.pathSiblings.map(sibling => ({
      siblingHash: sibling.siblingHash,
      siblingSide: sibling.siblingSide,
      siblingSideCode: sibling.siblingSideCode
    })),
    settlementHash,
    amountSats: amountSats.toString(),
    exitDelay,
    bindingCommitment: toCairoHex(binding),
    cairoInput
  };

  return {
    kind: 'ark_zk_miniscript_claim',
    claimId: hashCanonical(claimCore),
    claimCore,
    cairoInput,
    sourceManifest: manifest
  };
}

function buildRoleManifestFromBundle(bundle, role, options = {}) {
  const base = bundle.taprootProofManifest.manifestCore;
  return buildArkTaprootMiniscriptProofManifest({
    ...options,
    aspId: bundle.contract.contractCore.aspId,
    templateId: bundle.contract.contractCore.templateId,
    arkRoundId: bundle.contract.contractCore.arkRoundId,
    connectorOutpoint: base.connectorOutpoint,
    vtxoCommitmentId: base.vtxoCommitmentId,
    internalKeyHex: base.internalKeyHex,
    taprootOutputKey: base.taprootOutputKey,
    selectedLeafRole: role,
    virtualCetSetId: bundle.virtualCetSet.virtualCetSetId,
    selectedVirtualCetId: bundle.settlementEvidence.settlementCore.selectedVirtualCetId,
    oracleOutcomeHash: base.oracleOutcomeHash,
    utxorefPolicyId: bundle.challengeEvidence.challengeId,
    settlementRoot: bundle.settlementEvidence.settlementId,
    amountSats: bundle.contract.contractCore.totalCollateralSats,
    challengeWindowBlocks: base.challengeWindowBlocks
  });
}

function buildArkZkMiniscriptClaimCorpus(options = {}) {
  const bundle = options.bundle || buildArkDlcSettlementBundle(options);
  const roles = (options.roles || ROLE_ORDER).map(normalizeRole);
  const claims = roles.map(role => {
    const manifest = buildRoleManifestFromBundle(bundle, role, options);
    return buildArkZkMiniscriptClaim(manifest, {
      settlementHash: bundle.settlementEvidence.settlementId,
      exitDelay: options.exitDelayByRole && options.exitDelayByRole[role]
    });
  });
  const corpusCore = {
    version: 1,
    protocol: 'ark_zk_miniscript_claim_corpus',
    sourceBundleId: bundle.bundleId,
    roles,
    claimIds: claims.map(claim => claim.claimId)
  };
  return {
    kind: 'ark_zk_miniscript_claim_corpus',
    corpusId: hashCanonical(corpusCore),
    corpusCore,
    bundle,
    claims
  };
}

function safeRoleName(role) {
  return role.replace(/[^a-z0-9_]/gi, '_');
}

function writeArkZkMiniscriptClaimCorpus(options = {}) {
  const outDir = options.outDir || ARTIFACTS_DIR;
  const corpus = buildArkZkMiniscriptClaimCorpus(options);
  fs.mkdirSync(outDir, { recursive: true });

  const writtenClaims = corpus.claims.map(claim => {
    const role = claim.claimCore.selectedLeafRole;
    const base = `ark_zk_miniscript_${safeRoleName(role)}`;
    const claimPath = path.join(outDir, `${base}.claim.json`);
    const manifestPath = path.join(outDir, `${base}.manifest.json`);
    const inputPath = path.join(outDir, `${base}.input.json`);
    writeJson(claimPath, claim);
    writeJson(manifestPath, claim.sourceManifest);
    writeJson(inputPath, claim.cairoInput);
    return {
      role,
      claimId: claim.claimId,
      manifestId: claim.claimCore.manifestId,
      claimPath,
      manifestPath,
      inputPath,
      inputSha256: sha256FileHex(inputPath)
    };
  });

  const summary = {
    kind: 'ark_zk_miniscript_claim_corpus_summary',
    corpusId: corpus.corpusId,
    sourceBundleId: corpus.bundle.bundleId,
    createdAt: new Date().toISOString(),
    roles: corpus.corpusCore.roles,
    claims: writtenClaims
  };
  summary.summaryId = hashCanonical({
    corpusId: summary.corpusId,
    sourceBundleId: summary.sourceBundleId,
    claims: writtenClaims.map(claim => ({
      role: claim.role,
      claimId: claim.claimId,
      inputSha256: claim.inputSha256
    }))
  });
  const summaryPath = options.summaryPath || SUMMARY_PATH;
  writeJson(summaryPath, summary);
  return { corpus, summary, summaryPath };
}

function buildArkZkMiniscriptProofReceipt(options = {}) {
  const claim = options.claim;
  if (!claim || claim.kind !== 'ark_zk_miniscript_claim') {
    throw new Error('claim is required');
  }
  const proofPath = options.proofPath || null;
  const inputPath = options.inputPath || null;
  const proverLogPath = options.proverLogPath || null;
  const verifierLogPath = options.verifierLogPath || null;
  const receiptCore = {
    version: 1,
    protocol: 'ark_zk_miniscript_proof_receipt',
    claimId: claim.claimId,
    manifestId: claim.claimCore.manifestId,
    selectedLeafRole: claim.claimCore.selectedLeafRole,
    selectedLeafRoleCode: claim.claimCore.selectedLeafRoleCode,
    bindingCommitment: claim.claimCore.bindingCommitment,
    paths: {
      claimPath: options.claimPath || null,
      inputPath,
      proofPath,
      proverLogPath,
      verifierLogPath
    },
    hashes: {
      inputSha256: inputPath && fs.existsSync(inputPath) ? sha256FileHex(inputPath) : options.inputSha256 || null,
      proofSha256: proofPath && fs.existsSync(proofPath) ? sha256FileHex(proofPath) : options.proofSha256 || null,
      proverLogSha256:
        proverLogPath && fs.existsSync(proverLogPath) ? sha256FileHex(proverLogPath) : options.proverLogSha256 || null,
      verifierLogSha256:
        verifierLogPath && fs.existsSync(verifierLogPath)
          ? sha256FileHex(verifierLogPath)
          : options.verifierLogSha256 || null
    },
    status: {
      proverExitCode: Number(options.proverExitCode ?? 0),
      verifierExitCode: Number(options.verifierExitCode ?? 0)
    },
    remote: {
      host: options.remoteHost || 'snacksack',
      rayonThreads: Number(options.rayonThreads || 2),
      minRemoteAvailableGb: Number(options.minRemoteAvailableGb || 24)
    }
  };

  return {
    kind: 'ark_zk_miniscript_proof_receipt',
    receiptId: hashCanonical(receiptCore),
    receiptCore
  };
}

function verifyFileHash(filePath, expectedHash, label) {
  if (!filePath || !expectedHash) return { ok: false, reason: `missing ${label} path or hash` };
  if (!fs.existsSync(filePath)) return { ok: false, reason: `missing ${label} file` };
  const actual = sha256FileHex(filePath);
  if (actual !== expectedHash) return { ok: false, reason: `${label} hash mismatch` };
  return { ok: true };
}

function verifyArkZkMiniscriptProofReceipt(receipt) {
  if (!receipt || receipt.kind !== 'ark_zk_miniscript_proof_receipt') {
    return { ok: false, reason: 'wrong receipt kind' };
  }
  if (receipt.receiptId !== hashCanonical(receipt.receiptCore)) {
    return { ok: false, reason: 'receipt id mismatch' };
  }
  if (receipt.receiptCore.status.proverExitCode !== 0) {
    return { ok: false, reason: 'prover did not exit cleanly' };
  }
  if (receipt.receiptCore.status.verifierExitCode !== 0) {
    return { ok: false, reason: 'verifier did not exit cleanly' };
  }
  const proofHash = verifyFileHash(
    receipt.receiptCore.paths.proofPath,
    receipt.receiptCore.hashes.proofSha256,
    'proof'
  );
  if (!proofHash.ok) return proofHash;
  const inputHash = verifyFileHash(
    receipt.receiptCore.paths.inputPath,
    receipt.receiptCore.hashes.inputSha256,
    'input'
  );
  if (!inputHash.ok) return inputHash;
  if (receipt.receiptCore.paths.claimPath) {
    if (!fs.existsSync(receipt.receiptCore.paths.claimPath)) {
      return { ok: false, reason: 'missing claim file' };
    }
    const claim = JSON.parse(fs.readFileSync(receipt.receiptCore.paths.claimPath, 'utf8'));
    if (claim.claimId !== receipt.receiptCore.claimId) return { ok: false, reason: 'claim id mismatch' };
    if (claim.claimCore.manifestId !== receipt.receiptCore.manifestId) {
      return { ok: false, reason: 'manifest id mismatch' };
    }
  }
  return { ok: true };
}

function writeArkZkMiniscriptProofReceipt(receipt, outPath) {
  writeJson(outPath, receipt);
  return outPath;
}

function writeArkZkMiniscriptProofReceiptsFromSummary(options = {}) {
  const summaryPath = options.summaryPath || SUMMARY_PATH;
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const proofDir = options.proofDir || 'D:\\cargo-target\\ark-shinigami\\proofs';
  const logDir = options.logDir || 'D:\\cargo-target\\ark-shinigami\\logs';
  const outDir = options.outDir || path.dirname(summaryPath);
  fs.mkdirSync(outDir, { recursive: true });

  const receipts = summary.claims.map(entry => {
    const claim = JSON.parse(fs.readFileSync(entry.claimPath, 'utf8'));
    const base = `ark_zk_miniscript_${safeRoleName(entry.role)}.proof`;
    const proofPath = path.join(proofDir, `${base}.json`);
    const proverLogPath = path.join(logDir, `${base}.log`);
    const verifierLogPath = path.join(logDir, `${base}.verify.log`);
    const receipt = buildArkZkMiniscriptProofReceipt({
      claim,
      claimPath: entry.claimPath,
      inputPath: entry.inputPath,
      proofPath,
      proverLogPath,
      verifierLogPath,
      proverExitCode: options.proverExitCode ?? 0,
      verifierExitCode: options.verifierExitCode ?? 0,
      remoteHost: options.remoteHost || 'snacksack',
      rayonThreads: options.rayonThreads || 2,
      minRemoteAvailableGb: options.minRemoteAvailableGb || 24
    });
    const receiptPath = path.join(outDir, `ark_zk_miniscript_${safeRoleName(entry.role)}.receipt.json`);
    writeArkZkMiniscriptProofReceipt(receipt, receiptPath);
    const verification = verifyArkZkMiniscriptProofReceipt(receipt);
    return {
      role: entry.role,
      claimId: claim.claimId,
      receiptId: receipt.receiptId,
      receiptPath,
      verified: verification.ok,
      verificationReason: verification.reason || null
    };
  });

  const receiptSummary = {
    kind: 'ark_zk_miniscript_proof_receipt_summary',
    sourceSummaryPath: summaryPath,
    sourceSummaryId: summary.summaryId,
    createdAt: new Date().toISOString(),
    receipts
  };
  receiptSummary.receiptSummaryId = hashCanonical({
    sourceSummaryId: receiptSummary.sourceSummaryId,
    receipts: receipts.map(receipt => ({
      role: receipt.role,
      receiptId: receipt.receiptId,
      verified: receipt.verified
    }))
  });
  const receiptSummaryPath = options.receiptSummaryPath || path.join(outDir, 'ark_zk_miniscript_receipts_latest.json');
  writeJson(receiptSummaryPath, receiptSummary);
  return { receiptSummary, receiptSummaryPath };
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function runCli() {
  if (process.argv.includes('--write-receipts')) {
    const { receiptSummary, receiptSummaryPath } = writeArkZkMiniscriptProofReceiptsFromSummary({
      summaryPath: argValue('--summary', SUMMARY_PATH),
      proofDir: argValue('--proof-dir', undefined),
      logDir: argValue('--log-dir', undefined),
      outDir: argValue('--out-dir', undefined),
      remoteHost: argValue('--remote-host', 'snacksack'),
      rayonThreads: Number(argValue('--rayon-threads', '2')),
      minRemoteAvailableGb: Number(argValue('--min-remote-available-gb', '24'))
    });
    console.log(JSON.stringify({
      receiptSummaryPath,
      receiptSummaryId: receiptSummary.receiptSummaryId,
      receiptCount: receiptSummary.receipts.length,
      verifiedCount: receiptSummary.receipts.filter(receipt => receipt.verified).length
    }, null, 2));
    return;
  }

  const outDir = argValue('--out-dir', ARTIFACTS_DIR);
  const { summary, summaryPath } = writeArkZkMiniscriptClaimCorpus({ outDir });
  console.log(JSON.stringify({
    summaryPath,
    corpusId: summary.corpusId,
    roles: summary.roles,
    claimCount: summary.claims.length
  }, null, 2));
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    console.error(`ark_zk_miniscript_proof failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  SUMMARY_PATH,
  ROLE_CODES,
  ROLE_ORDER,
  FELT_PRIME,
  buildTaprootPathWitness,
  hex32ToU128Limbs,
  computeArkZkMiniscriptBinding,
  buildArkZkMiniscriptClaim,
  buildArkZkMiniscriptClaimCorpus,
  writeArkZkMiniscriptClaimCorpus,
  buildArkZkMiniscriptProofReceipt,
  verifyArkZkMiniscriptProofReceipt,
  writeArkZkMiniscriptProofReceipt,
  writeArkZkMiniscriptProofReceiptsFromSummary,
  sha256FileHex
};
