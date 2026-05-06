/**
 * Shinigami virtual-CET proof corpus.
 *
 * This turns the Ark virtual-CET tokenizer bundle into a compact Cairo input
 * for the ark-shinigami virtual-CET prover. The Cairo claim proves the selected
 * virtual CET payout preserves collateral and materializes zero on-chain CETs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('../m1_spec');
const {
  buildShinigamiVirtualCetBundle,
  verifyShinigamiVirtualCetBundle
} = require('./shinigami_virtual_cet_ark');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts', 'virtual_cet_proofs');
const SUMMARY_PATH = path.join(ARTIFACTS_DIR, 'shinigami_virtual_cet_proof_summary_latest.json');
const RECEIPTS_PATH = path.join(ARTIFACTS_DIR, 'shinigami_virtual_cet_proof_receipts_latest.json');
const HEX_32_RE = /^[0-9a-f]{64}$/i;
const FELT_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

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

function mixHashLimbs(hex, fieldName) {
  const limbs = hex32ToU128Limbs(hex, fieldName);
  return mix(limbs.hi, limbs.lo);
}

function computeVirtualCetBinding(fields) {
  const contractCommitmentId = mixHashLimbs(fields.contractCommitmentId, 'contractCommitmentId');
  const virtualCetSetId = mixHashLimbs(fields.virtualCetSetId, 'virtualCetSetId');
  const arkLeafRoot = mixHashLimbs(fields.arkLeafRoot, 'arkLeafRoot');
  const selectedLeafHash = mixHashLimbs(fields.selectedLeafHash, 'selectedLeafHash');
  const oracleOutcomeHash = mixHashLimbs(fields.oracleOutcomeHash, 'oracleOutcomeHash');
  const payoutRoot = mixHashLimbs(fields.payoutRoot, 'payoutRoot');
  const selectedOutcomeIndex = BigInt(fields.selectedOutcomeIndex);
  const outcomeCount = BigInt(fields.outcomeCount);
  const offerPayoutSats = normalizeAmountSats(fields.offerPayoutSats, 'offerPayoutSats');
  const acceptPayoutSats = normalizeAmountSats(fields.acceptPayoutSats, 'acceptPayoutSats');
  const totalCollateralSats = normalizeAmountSats(fields.totalCollateralSats, 'totalCollateralSats');
  const materializedCetCount = BigInt(fields.materializedCetCount);

  const contractSet = mix(contractCommitmentId, virtualCetSetId);
  const leafPair = mix(arkLeafRoot, selectedLeafHash);
  const oraclePayout = mix(oracleOutcomeHash, payoutRoot);
  const indexPair = mix(selectedOutcomeIndex, outcomeCount);
  const payoutPair = mix(offerPayoutSats, acceptPayoutSats);
  const collateralPair = mix(totalCollateralSats, materializedCetCount);
  const membership = mix(contractSet, leafPair);
  const settlement = mix(oraclePayout, indexPair);
  const value = mix(payoutPair, collateralPair);
  return mix(mix(membership, settlement), value);
}

function buildShinigamiVirtualCetCairoClaim(options = {}) {
  const bundle = options.bundle || buildShinigamiVirtualCetBundle(options);
  const verification = verifyShinigamiVirtualCetBundle(bundle);
  if (!verification.ok) {
    throw new Error(`Shinigami virtual-CET bundle failed: ${verification.reason}`);
  }
  const selectedOutcomeIndex = bundle.contract.outcomes.findIndex(
    outcome => outcome.outcomeId === bundle.selectedOutcome.outcomeId
  );
  if (selectedOutcomeIndex < 0) throw new Error('selected outcome is missing from contract outcomes');

  const totalCollateralSats = normalizeAmountSats(bundle.contract.contractCore.totalCollateralSats, 'totalCollateralSats');
  const offerPayoutSats = normalizeAmountSats(bundle.selectedOutcome.offerPayoutSats, 'offerPayoutSats');
  const acceptPayoutSats = normalizeAmountSats(bundle.selectedOutcome.acceptPayoutSats, 'acceptPayoutSats');
  if (offerPayoutSats + acceptPayoutSats !== totalCollateralSats) {
    throw new Error('selected payout does not preserve collateral');
  }

  const fields = {
    contractCommitmentId: bundle.contract.contractCommitmentId,
    virtualCetSetId: bundle.virtualCetSet.virtualCetSetId,
    arkLeafRoot: bundle.arkLeafRoot,
    selectedLeafHash: bundle.selectedLeafHash,
    oracleOutcomeHash: bundle.zkClaim.claimCore.oracleOutcomeHash,
    payoutRoot: bundle.payoutRoot,
    selectedOutcomeIndex,
    outcomeCount: bundle.contract.outcomes.length,
    offerPayoutSats,
    acceptPayoutSats,
    totalCollateralSats,
    materializedCetCount: 0
  };
  const binding = computeVirtualCetBinding(fields);
  const limbs = {
    contractCommitmentId: hex32ToU128Limbs(fields.contractCommitmentId, 'contractCommitmentId'),
    virtualCetSetId: hex32ToU128Limbs(fields.virtualCetSetId, 'virtualCetSetId'),
    arkLeafRoot: hex32ToU128Limbs(fields.arkLeafRoot, 'arkLeafRoot'),
    selectedLeafHash: hex32ToU128Limbs(fields.selectedLeafHash, 'selectedLeafHash'),
    oracleOutcomeHash: hex32ToU128Limbs(fields.oracleOutcomeHash, 'oracleOutcomeHash'),
    payoutRoot: hex32ToU128Limbs(fields.payoutRoot, 'payoutRoot')
  };
  const cairoInput = [
    limbs.contractCommitmentId.hiHex,
    limbs.contractCommitmentId.loHex,
    limbs.virtualCetSetId.hiHex,
    limbs.virtualCetSetId.loHex,
    limbs.arkLeafRoot.hiHex,
    limbs.arkLeafRoot.loHex,
    limbs.selectedLeafHash.hiHex,
    limbs.selectedLeafHash.loHex,
    limbs.oracleOutcomeHash.hiHex,
    limbs.oracleOutcomeHash.loHex,
    limbs.payoutRoot.hiHex,
    limbs.payoutRoot.loHex,
    toCairoHex(fields.selectedOutcomeIndex),
    toCairoHex(fields.outcomeCount),
    toCairoHex(fields.offerPayoutSats),
    toCairoHex(fields.acceptPayoutSats),
    toCairoHex(fields.totalCollateralSats),
    toCairoHex(fields.materializedCetCount),
    toCairoHex(binding)
  ];
  const claimCore = {
    version: 1,
    protocol: 'shinigami_virtual_cet_cairo_claim',
    bundleId: bundle.bundleId,
    contractCommitmentId: fields.contractCommitmentId,
    virtualCetSetId: fields.virtualCetSetId,
    arkLeafRoot: fields.arkLeafRoot,
    selectedLeafHash: fields.selectedLeafHash,
    oracleOutcomeHash: fields.oracleOutcomeHash,
    payoutRoot: fields.payoutRoot,
    selectedOutcomeId: bundle.selectedOutcome.outcomeId,
    selectedVirtualCetId: bundle.selectedVirtualCetId,
    selectedOutcomeIndex,
    outcomeCount: fields.outcomeCount,
    offerPayoutSats: fields.offerPayoutSats.toString(),
    acceptPayoutSats: fields.acceptPayoutSats.toString(),
    totalCollateralSats: fields.totalCollateralSats.toString(),
    materializedCetCount: 0,
    bindingCommitment: toCairoHex(binding),
    cairoInput
  };
  return {
    kind: 'shinigami_virtual_cet_cairo_claim',
    claimId: hashCanonical(claimCore),
    claimCore,
    cairoInput,
    sourceBundle: bundle
  };
}

function buildShinigamiVirtualCetProofCorpus(options = {}) {
  const outcomeCounts = (options.outcomeCounts || [17]).map(value => Number(value));
  const claims = outcomeCounts.map(outcomeCount => buildShinigamiVirtualCetCairoClaim({ ...options, outcomeCount }));
  const corpusCore = {
    version: 1,
    protocol: 'shinigami_virtual_cet_proof_corpus',
    outcomeCounts,
    claimIds: claims.map(claim => claim.claimId),
    materializedCetCount: 0
  };
  return {
    kind: 'shinigami_virtual_cet_proof_corpus',
    corpusId: hashCanonical(corpusCore),
    corpusCore,
    claims
  };
}

function safeClaimName(claim) {
  return `shinigami_virtual_cet_${claim.claimCore.outcomeCount}_outcomes`;
}

function compactClaimForArtifact(claim) {
  return {
    kind: claim.kind,
    claimId: claim.claimId,
    claimCore: claim.claimCore,
    cairoInput: claim.cairoInput
  };
}

function writeShinigamiVirtualCetProofCorpus(options = {}) {
  const outDir = options.outDir || ARTIFACTS_DIR;
  const corpus = buildShinigamiVirtualCetProofCorpus(options);
  fs.mkdirSync(outDir, { recursive: true });
  const writtenClaims = corpus.claims.map(claim => {
    const base = safeClaimName(claim);
    const claimPath = path.join(outDir, `${base}.claim.json`);
    const inputPath = path.join(outDir, `${base}.input.json`);
    writeJson(claimPath, compactClaimForArtifact(claim));
    writeJson(inputPath, claim.cairoInput);
    return {
      outcomeCount: claim.claimCore.outcomeCount,
      claimId: claim.claimId,
      claimPath,
      inputPath,
      inputSha256: sha256FileHex(inputPath)
    };
  });
  const summary = {
    kind: 'shinigami_virtual_cet_proof_corpus_summary',
    corpusId: corpus.corpusId,
    createdAt: new Date().toISOString(),
    claims: writtenClaims,
    materializedCetCount: 0
  };
  summary.summaryId = hashCanonical({
    corpusId: summary.corpusId,
    claims: summary.claims.map(claim => ({
      outcomeCount: claim.outcomeCount,
      claimId: claim.claimId,
      inputSha256: claim.inputSha256
    }))
  });
  const summaryPath = options.summaryPath || SUMMARY_PATH;
  writeJson(summaryPath, summary);
  return { corpus, summary, summaryPath };
}

function readExitCode(statusPath) {
  if (!statusPath || !fs.existsSync(statusPath)) return null;
  const raw = fs.readFileSync(statusPath, 'utf8').trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function verifierLogAccepted(verifierLogPath) {
  if (!verifierLogPath || !fs.existsSync(verifierLogPath)) return false;
  const text = fs.readFileSync(verifierLogPath, 'utf8');
  return /Proof verified successfully|verify_exit=0|verified successfully/i.test(text);
}

function parseTimeLog(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return {};
  const text = fs.readFileSync(logPath, 'utf8');
  const elapsed = /Elapsed \(wall clock\) time .*: ([^\r\n]+)/.exec(text);
  const rss = /Maximum resident set size \(kbytes\): ([0-9]+)/.exec(text);
  const user = /User time \(seconds\): ([0-9.]+)/.exec(text);
  const system = /System time \(seconds\): ([0-9.]+)/.exec(text);
  const cpu = /Percent of CPU this job got: ([0-9]+)%/.exec(text);
  return {
    elapsedWallClock: elapsed ? elapsed[1].trim() : null,
    maxResidentSetKb: rss ? Number(rss[1]) : null,
    userSeconds: user ? Number(user[1]) : null,
    systemSeconds: system ? Number(system[1]) : null,
    cpuPercent: cpu ? Number(cpu[1]) : null
  };
}

function buildShinigamiVirtualCetProofReceipt(options = {}) {
  const claim = options.claim;
  if (!claim || claim.kind !== 'shinigami_virtual_cet_cairo_claim') {
    throw new Error('claim is required');
  }
  const proofPath = options.proofPath || null;
  const inputPath = options.inputPath || null;
  const proverLogPath = options.proverLogPath || null;
  const verifierLogPath = options.verifierLogPath || null;
  const proofExists = proofPath && fs.existsSync(proofPath);
  const proverExitCode = options.proverExitCode ?? readExitCode(options.proverStatusPath) ?? (proofExists ? 0 : null);
  const verifierExitCode =
    options.verifierExitCode ?? readExitCode(options.verifierStatusPath) ?? (verifierLogAccepted(verifierLogPath) ? 0 : null);
  const receiptCore = {
    version: 1,
    protocol: 'shinigami_virtual_cet_proof_receipt',
    proofSystem: 'shinigami-stwo',
    claimId: claim.claimId,
    outcomeCount: claim.claimCore.outcomeCount,
    materializedCetCount: claim.claimCore.materializedCetCount,
    bindingCommitment: claim.claimCore.bindingCommitment,
    paths: {
      inputPath,
      proofPath,
      proverLogPath,
      verifierLogPath
    },
    hashes: {
      inputSha256: inputPath && fs.existsSync(inputPath) ? sha256FileHex(inputPath) : null,
      proofSha256: proofExists ? sha256FileHex(proofPath) : null
    },
    sizes: {
      proofBytes: proofExists ? fs.statSync(proofPath).size : null
    },
    metrics: parseTimeLog(proverLogPath),
    proverExitCode,
    verifierExitCode,
    verified: proverExitCode === 0 && verifierExitCode === 0 && proofExists
  };
  return {
    kind: 'shinigami_virtual_cet_proof_receipt',
    receiptId: hashCanonical(receiptCore),
    receiptCore,
    verified: receiptCore.verified
  };
}

function verifyShinigamiVirtualCetProofReceipt(receipt, claim) {
  if (!receipt || receipt.kind !== 'shinigami_virtual_cet_proof_receipt') {
    return { ok: false, reason: 'wrong receipt kind' };
  }
  if (receipt.receiptId !== hashCanonical(receipt.receiptCore)) {
    return { ok: false, reason: 'receipt id mismatch' };
  }
  if (claim && receipt.receiptCore.claimId !== claim.claimId) {
    return { ok: false, reason: 'claim id mismatch' };
  }
  if (receipt.receiptCore.materializedCetCount !== 0) {
    return { ok: false, reason: 'receipt materialized a CET' };
  }
  if (!receipt.receiptCore.verified) {
    return { ok: false, reason: 'proof was not verified' };
  }
  return { ok: true };
}

function writeShinigamiVirtualCetProofReceipts(options = {}) {
  const outDir = options.outDir || ARTIFACTS_DIR;
  const summaryPath = options.summaryPath || SUMMARY_PATH;
  if (!fs.existsSync(summaryPath)) throw new Error(`missing proof summary: ${summaryPath}`);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const proofDir = options.proofDir || 'D:\\cargo-target\\ark-shinigami\\proofs';
  const logDir = options.logDir || 'D:\\cargo-target\\ark-shinigami\\logs';
  const receipts = summary.claims.map(entry => {
    const claim = JSON.parse(fs.readFileSync(entry.claimPath, 'utf8'));
    const proofBaseName = options.proofBaseName || `shinigami_virtual_cet_${entry.outcomeCount}_outcomes`;
    const proofPath = path.join(proofDir, `${proofBaseName}.proof.json`);
    const proverLogPath = path.join(logDir, `${proofBaseName}.proof.log`);
    const verifierLogPath = path.join(logDir, `${proofBaseName}.proof.verify.log`);
    const receipt = buildShinigamiVirtualCetProofReceipt({
      claim,
      inputPath: entry.inputPath,
      proofPath,
      proverLogPath,
      verifierLogPath
    });
    const receiptPath = path.join(outDir, `${proofBaseName}.receipt.json`);
    writeJson(receiptPath, receipt);
    return {
      outcomeCount: entry.outcomeCount,
      claimId: claim.claimId,
      receiptId: receipt.receiptId,
      receiptPath,
      proofPath,
      verified: receipt.verified,
      metrics: receipt.receiptCore.metrics,
      proofBytes: receipt.receiptCore.sizes.proofBytes
    };
  });
  const receiptSummary = {
    kind: 'shinigami_virtual_cet_proof_receipt_summary',
    sourceSummaryPath: summaryPath,
    sourceSummaryId: summary.summaryId,
    createdAt: new Date().toISOString(),
    receipts
  };
  receiptSummary.receiptSummaryId = hashCanonical({
    sourceSummaryId: summary.summaryId,
    receipts: receipts.map(receipt => ({
      outcomeCount: receipt.outcomeCount,
      claimId: receipt.claimId,
      receiptId: receipt.receiptId,
      verified: receipt.verified
    }))
  });
  const receiptSummaryPath = options.receiptSummaryPath || RECEIPTS_PATH;
  writeJson(receiptSummaryPath, receiptSummary);
  return { receiptSummary, receiptSummaryPath };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

if (require.main === module) {
  try {
    const args = parseArgs();
    const outDir = args['out-dir'] || ARTIFACTS_DIR;
    const outcomeCounts = args['outcome-counts']
      ? String(args['outcome-counts']).split(',').map(item => Number(item.trim())).filter(Boolean)
      : [17];
    const { summaryPath } = writeShinigamiVirtualCetProofCorpus({ outDir, outcomeCounts });
    const result = { summaryPath };
    if (args['write-receipts']) {
      const { receiptSummaryPath } = writeShinigamiVirtualCetProofReceipts({
        outDir,
        summaryPath,
        proofDir: args['proof-dir'],
        logDir: args['log-dir'],
        proofBaseName: args['proof-base-name']
      });
      result.receiptSummaryPath = receiptSummaryPath;
    }
    console.log(stringifyJson(result, true));
  } catch (err) {
    console.error(`shinigami_virtual_cet_proof_corpus failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  SUMMARY_PATH,
  RECEIPTS_PATH,
  computeVirtualCetBinding,
  buildShinigamiVirtualCetCairoClaim,
  buildShinigamiVirtualCetProofCorpus,
  writeShinigamiVirtualCetProofCorpus,
  buildShinigamiVirtualCetProofReceipt,
  verifyShinigamiVirtualCetProofReceipt,
  writeShinigamiVirtualCetProofReceipts
};
