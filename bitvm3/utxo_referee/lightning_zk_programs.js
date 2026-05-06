/**
 * Programmable Lightning watchtower and ASP policies.
 *
 * These artifacts bind an opaque Lightning payment condition to Ark/UTXORef ZK
 * miniscript receipts. They are deterministic evidence-shape prototypes: useful
 * for sidecars, LSPs, ASPs, and watchtowers, but not a replacement for LN
 * commitment transaction enforcement.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const {
  derivePreimageHex,
  derivePaymentHashHex,
  makePrototypeInvoice
} = require('./lightning_integration');
const {
  verifyArkZkMiniscriptProofReceipt
} = require('./ark_zk_miniscript_proof');

const HEX_32_RE = /^[0-9a-f]{64}$/i;
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts', 'lightning_zk_programs');
const DEFAULT_ZK_RECEIPT_SUMMARY_PATH = path.join(
  __dirname,
  'artifacts',
  'ark_zk_miniscript',
  'ark_zk_miniscript_receipts_latest.json'
);

function sha256Hex(value) {
  const input = Buffer.isBuffer(value) || typeof value === 'string' ? value : canonicalStringify(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalStringify(value));
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeHex32(value, fieldName) {
  const normalized = normalizeString(value, fieldName).toLowerCase();
  if (!HEX_32_RE.test(normalized)) {
    throw new Error(`${fieldName} must be a 32-byte hex string`);
  }
  return normalized;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function publicInvoiceHash(invoice) {
  return sha256Hex(normalizeString(invoice, 'invoice'));
}

function buildLightningPaymentConditionProof(options = {}) {
  const routeId = normalizeString(options.routeId || 'ln-zk-route-001', 'routeId');
  const amountSats = normalizeAmountSats(options.amountSats || 50000n, 'amountSats');
  const preimageHex = normalizeHex32(
    options.preimageHex || derivePreimageHex(`zk-ln-payment:${routeId}:${amountSats}`),
    'preimageHex'
  );
  const paymentHashHex = normalizeHex32(
    options.paymentHashHex || derivePaymentHashHex(preimageHex),
    'paymentHashHex'
  );
  const invoice =
    options.invoice ||
    makePrototypeInvoice({
      amountSats,
      paymentHashHex,
      description: `zk receipt for ${routeId}`
    });
  const contextBindingHash = normalizeHex32(
    options.contextBindingHash || hashCanonical({
      routeId,
      amountSats: amountSats.toString(),
      invoiceHash: publicInvoiceHash(invoice),
      purpose: options.purpose || 'ln_payment_condition_for_utxoref_program'
    }),
    'contextBindingHash'
  );
  const preimageWitnessCommitment = hashCanonical({
    protocol: 'ln_preimage_witness_commitment_v1',
    paymentHashHex,
    preimageHex,
    contextBindingHash
  });

  const proofCore = {
    version: 1,
    protocol: 'lightning_payment_condition_zk_receipt',
    routeId,
    amountSats: amountSats.toString(),
    paymentHashHex,
    invoiceHash: publicInvoiceHash(invoice),
    contextBindingHash,
    preimageWitnessCommitment,
    publicClaim: 'payment_preimage_known_without_route_disclosure',
    disclosureMode: 'payment_route_and_preimage_withheld',
    proofSystem: normalizeString(options.proofSystem || 'zk_preimage_receipt_placeholder', 'proofSystem')
  };
  const proofId = hashCanonical(proofCore);
  const includePrivateWitness = options.includePrivateWitness !== false;

  return {
    kind: 'lightning_payment_condition_proof',
    proofId,
    proofCore,
    publicReceipt: {
      kind: 'lightning_payment_public_receipt',
      proofId,
      routeId,
      amountSats: amountSats.toString(),
      paymentHashHex,
      invoiceHash: proofCore.invoiceHash,
      contextBindingHash,
      preimageWitnessCommitment
    },
    privateWitness: includePrivateWitness
      ? {
          preimageHex,
          invoice
        }
      : null
  };
}

function verifyLightningPaymentConditionProof(proof, options = {}) {
  if (!proof || proof.kind !== 'lightning_payment_condition_proof') {
    return { ok: false, reason: 'wrong payment proof kind' };
  }
  if (proof.proofId !== hashCanonical(proof.proofCore)) {
    return { ok: false, reason: 'payment proof id mismatch' };
  }
  if (!HEX_32_RE.test(proof.proofCore.paymentHashHex)) {
    return { ok: false, reason: 'payment hash must be 32-byte hex' };
  }
  if (!HEX_32_RE.test(proof.proofCore.contextBindingHash)) {
    return { ok: false, reason: 'context binding hash must be 32-byte hex' };
  }
  if (options.expectedPaymentHashHex && options.expectedPaymentHashHex !== proof.proofCore.paymentHashHex) {
    return { ok: false, reason: 'payment hash mismatch' };
  }
  if (options.expectedAmountSats && BigInt(options.expectedAmountSats) !== BigInt(proof.proofCore.amountSats)) {
    return { ok: false, reason: 'payment amount mismatch' };
  }
  if (proof.privateWitness) {
    const preimageHex = normalizeHex32(proof.privateWitness.preimageHex, 'privateWitness.preimageHex');
    if (derivePaymentHashHex(preimageHex) !== proof.proofCore.paymentHashHex) {
      return { ok: false, reason: 'preimage does not match payment hash' };
    }
    const witnessCommitment = hashCanonical({
      protocol: 'ln_preimage_witness_commitment_v1',
      paymentHashHex: proof.proofCore.paymentHashHex,
      preimageHex,
      contextBindingHash: proof.proofCore.contextBindingHash
    });
    if (witnessCommitment !== proof.proofCore.preimageWitnessCommitment) {
      return { ok: false, reason: 'preimage witness commitment mismatch' };
    }
  } else if (options.requirePrivateWitness) {
    return { ok: false, reason: 'private witness required' };
  }
  return { ok: true, proofId: proof.proofId };
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildSyntheticZkReceiptRef(role) {
  const normalizedRole = normalizeString(role, 'role');
  return {
    role: normalizedRole,
    receiptId: sha256Hex(`synthetic-zk-receipt:${normalizedRole}`),
    claimId: sha256Hex(`synthetic-zk-claim:${normalizedRole}`),
    manifestId: sha256Hex(`synthetic-zk-manifest:${normalizedRole}`),
    bindingCommitment: `0x${sha256Hex(`synthetic-binding:${normalizedRole}`).slice(0, 16)}`,
    verified: true,
    verificationReason: null,
    receiptPath: null,
    source: 'synthetic_test_fixture'
  };
}

function buildArkZkReceiptRef(options = {}) {
  if (options.zkReceiptRef) {
    const ref = options.zkReceiptRef;
    return {
      role: normalizeString(ref.role || options.role || 'cooperative_round', 'zkReceiptRef.role'),
      receiptId: normalizeHex32(ref.receiptId, 'zkReceiptRef.receiptId'),
      claimId: normalizeHex32(ref.claimId, 'zkReceiptRef.claimId'),
      manifestId: normalizeHex32(ref.manifestId, 'zkReceiptRef.manifestId'),
      bindingCommitment: normalizeString(ref.bindingCommitment || '0x0', 'zkReceiptRef.bindingCommitment'),
      verified: ref.verified !== false,
      verificationReason: ref.verificationReason || null,
      receiptPath: ref.receiptPath || null,
      source: ref.source || 'provided'
    };
  }

  const role = normalizeString(options.role || 'cooperative_round', 'role');
  const summaryPath = options.summaryPath || DEFAULT_ZK_RECEIPT_SUMMARY_PATH;
  const summary = loadJson(summaryPath);
  const entry = (summary.receipts || []).find(receipt => receipt.role === role);
  if (!entry) throw new Error(`missing Ark ZK receipt for role ${role}`);
  const receipt = loadJson(entry.receiptPath);
  const verification = options.skipProofFileVerification
    ? { ok: Boolean(entry.verified), reason: entry.verificationReason || null }
    : verifyArkZkMiniscriptProofReceipt(receipt);

  return {
    role,
    receiptId: normalizeHex32(receipt.receiptId, 'receiptId'),
    claimId: normalizeHex32(receipt.receiptCore.claimId, 'receiptCore.claimId'),
    manifestId: normalizeHex32(receipt.receiptCore.manifestId, 'receiptCore.manifestId'),
    bindingCommitment: normalizeString(receipt.receiptCore.bindingCommitment, 'bindingCommitment'),
    verified: verification.ok,
    verificationReason: verification.reason || null,
    receiptPath: entry.receiptPath,
    sourceSummaryPath: summaryPath,
    sourceSummaryId: summary.receiptSummaryId
  };
}

function collectViolations(checks) {
  return Object.entries(checks)
    .filter(([_name, ok]) => !ok)
    .map(([name]) => name);
}

function buildProgrammableWatchtower(options = {}) {
  const watcherId = normalizeString(options.watcherId || 'zk-watchtower-001', 'watcherId');
  const paymentProof = options.paymentProof || buildLightningPaymentConditionProof({
    ...options,
    routeId: options.routeId || 'watchtower-observed-ln-payment',
    purpose: 'programmable_watchtower'
  });
  const paymentVerification = verifyLightningPaymentConditionProof(paymentProof, {
    expectedPaymentHashHex: options.expectedPaymentHashHex,
    expectedAmountSats: options.expectedAmountSats
  });
  const zkReceiptRef = buildArkZkReceiptRef({
    role: options.zkRole || 'utxoref_challenge_publication',
    summaryPath: options.zkReceiptSummaryPath,
    zkReceiptRef: options.zkReceiptRef,
    skipProofFileVerification: options.skipProofFileVerification
  });
  const expectedStateTransitionHash = normalizeHex32(
    options.expectedStateTransitionHash || hashCanonical({
      watcherId,
      paymentProofId: paymentProof.proofId,
      zkReceiptId: zkReceiptRef.receiptId,
      route: 'ln_payment_to_utxoref_challenge_publication'
    }),
    'expectedStateTransitionHash'
  );
  const observedStateTransitionHash = normalizeHex32(
    options.observedStateTransitionHash || expectedStateTransitionHash,
    'observedStateTransitionHash'
  );
  const currentHeight = Number(options.currentHeight || 0);
  const challengeDeadlineHeight = Number(options.challengeDeadlineHeight || currentHeight + 144);
  const checks = {
    paymentProofAccepted: paymentVerification.ok,
    zkReceiptVerified: zkReceiptRef.verified,
    transitionMatchesProgram: observedStateTransitionHash === expectedStateTransitionHash,
    withinChallengeWindow: currentHeight <= challengeDeadlineHeight
  };
  const violations = collectViolations(checks);
  const challengeCore = {
    version: 1,
    protocol: 'programmable_watchtower_challenge',
    watcherId,
    paymentProofId: paymentProof.proofId,
    zkReceiptId: zkReceiptRef.receiptId,
    expectedStateTransitionHash,
    observedStateTransitionHash,
    currentHeight,
    challengeDeadlineHeight,
    violations
  };
  const programCore = {
    version: 1,
    protocol: 'programmable_lightning_watchtower_zk_receipt',
    watcherId,
    paymentProofId: paymentProof.proofId,
    paymentHashHex: paymentProof.proofCore.paymentHashHex,
    zkReceiptId: zkReceiptRef.receiptId,
    zkReceiptRole: zkReceiptRef.role,
    expectedStateTransitionHash,
    observedStateTransitionHash,
    action: violations.length ? 'publish_utxoref_challenge' : 'accept_and_monitor',
    privacyBoundary: 'watchtower learns payment hash and proof receipt ids, not LN route or sender balance'
  };

  return {
    kind: 'programmable_lightning_watchtower_zk_receipt',
    programId: hashCanonical(programCore),
    programCore,
    paymentProof: paymentProof.publicReceipt,
    zkReceiptRef,
    checks,
    challenge: {
      kind: 'programmable_watchtower_challenge',
      challengeId: hashCanonical(challengeCore),
      challengeCore,
      challengeable: violations.length > 0,
      remedy: violations.length ? 'publish UTXORef/BitVM challenge or notify wallet to pause settlement' : 'none'
    },
    caveats: [
      'The watchtower consumes selective receipts; it does not see the full Lightning route.',
      'Production needs authenticated watchtower subscriptions, penalty transaction construction, and node-specific policy.'
    ]
  };
}

function verifyProgrammableWatchtower(program) {
  if (!program || program.kind !== 'programmable_lightning_watchtower_zk_receipt') {
    return { ok: false, reason: 'wrong watchtower program kind' };
  }
  if (program.programId !== hashCanonical(program.programCore)) {
    return { ok: false, reason: 'watchtower program id mismatch' };
  }
  const expectedViolations = collectViolations(program.checks || {});
  if (program.challenge.challengeable !== (expectedViolations.length > 0)) {
    return { ok: false, reason: 'watchtower challenge flag mismatch' };
  }
  if (program.challenge.challengeId !== hashCanonical(program.challenge.challengeCore)) {
    return { ok: false, reason: 'watchtower challenge id mismatch' };
  }
  return { ok: true, action: program.programCore.action };
}

function buildProgrammableAspPolicy(options = {}) {
  const aspId = normalizeString(options.aspId || 'programmable-ark-asp-001', 'aspId');
  const routeId = normalizeString(options.routeId || 'asp-ln-route-001', 'routeId');
  const promisedInboundSats = normalizeAmountSats(options.promisedInboundSats || 75000n, 'promisedInboundSats');
  const deliveredInboundSats = normalizeAmountSats(
    options.deliveredInboundSats === undefined ? promisedInboundSats : options.deliveredInboundSats,
    'deliveredInboundSats'
  );
  const maxFeePpm = Number(options.maxFeePpm ?? 1000);
  const observedFeePpm = Number(options.observedFeePpm ?? maxFeePpm);
  const maxCltvDelta = Number(options.maxCltvDelta ?? 40);
  const observedCltvDelta = Number(options.observedCltvDelta ?? maxCltvDelta);
  const paymentProof = options.paymentProof || buildLightningPaymentConditionProof({
    ...options,
    routeId,
    amountSats: options.amountSats || promisedInboundSats,
    purpose: 'programmable_asp_policy'
  });
  const paymentVerification = verifyLightningPaymentConditionProof(paymentProof, {
    expectedAmountSats: options.expectedPaymentAmountSats || paymentProof.proofCore.amountSats
  });
  const settlementReceiptRef = buildArkZkReceiptRef({
    role: options.settlementRole || 'cooperative_round',
    summaryPath: options.zkReceiptSummaryPath,
    zkReceiptRef: options.settlementZkReceiptRef,
    skipProofFileVerification: options.skipProofFileVerification
  });
  const forfeitReceiptRef = buildArkZkReceiptRef({
    role: options.forfeitRole || 'asp_forfeit_guard',
    summaryPath: options.zkReceiptSummaryPath,
    zkReceiptRef: options.forfeitZkReceiptRef,
    skipProofFileVerification: options.skipProofFileVerification
  });
  const checks = {
    paymentProofAccepted: paymentVerification.ok,
    settlementReceiptVerified: settlementReceiptRef.verified,
    forfeitReceiptVerified: forfeitReceiptRef.verified,
    deliveredInboundMet: deliveredInboundSats >= promisedInboundSats,
    feeCeilingMet: observedFeePpm <= maxFeePpm,
    cltvCeilingMet: observedCltvDelta <= maxCltvDelta,
    exitPathAvailable: options.missingExitPath !== true,
    forfeitPathAvailable: options.missingForfeitPath !== true
  };
  const violations = collectViolations(checks);
  const policyCore = {
    version: 1,
    protocol: 'programmable_ark_asp_lightning_policy',
    aspId,
    routeId,
    paymentProofId: paymentProof.proofId,
    paymentHashHex: paymentProof.proofCore.paymentHashHex,
    settlementZkReceiptId: settlementReceiptRef.receiptId,
    forfeitZkReceiptId: forfeitReceiptRef.receiptId,
    promisedInboundSats: promisedInboundSats.toString(),
    deliveredInboundSats: deliveredInboundSats.toString(),
    maxFeePpm,
    observedFeePpm,
    maxCltvDelta,
    observedCltvDelta,
    action: violations.length ? 'slash_or_force_exit' : 'settle_and_release_asp_fee',
    privacyBoundary: 'ASP policy proves payment-conditioned obligation without exposing LN route'
  };
  const challengeCore = {
    version: 1,
    protocol: 'programmable_ark_asp_challenge',
    aspId,
    routeId,
    paymentProofId: paymentProof.proofId,
    settlementZkReceiptId: settlementReceiptRef.receiptId,
    forfeitZkReceiptId: forfeitReceiptRef.receiptId,
    violations
  };

  return {
    kind: 'programmable_ark_asp_lightning_policy',
    policyId: hashCanonical(policyCore),
    policyCore,
    paymentProof: paymentProof.publicReceipt,
    settlementReceiptRef,
    forfeitReceiptRef,
    checks,
    challenge: {
      kind: 'programmable_ark_asp_challenge',
      challengeId: hashCanonical(challengeCore),
      challengeCore,
      slashable: violations.length > 0,
      remedy: violations.length ? 'slash ASP bond, force exit, or reroute liquidity demand' : 'none'
    },
    caveats: [
      'This is an ASP/LSP sidecar policy, not an Ark consensus implementation.',
      'Production needs real route observations, ASP signatures, VTXO membership proofs, and challenge transaction construction.'
    ]
  };
}

function verifyProgrammableAspPolicy(policy) {
  if (!policy || policy.kind !== 'programmable_ark_asp_lightning_policy') {
    return { ok: false, reason: 'wrong ASP policy kind' };
  }
  if (policy.policyId !== hashCanonical(policy.policyCore)) {
    return { ok: false, reason: 'ASP policy id mismatch' };
  }
  const expectedViolations = collectViolations(policy.checks || {});
  if (policy.challenge.slashable !== (expectedViolations.length > 0)) {
    return { ok: false, reason: 'ASP challenge flag mismatch' };
  }
  if (policy.challenge.challengeId !== hashCanonical(policy.challenge.challengeCore)) {
    return { ok: false, reason: 'ASP challenge id mismatch' };
  }
  return { ok: true, action: policy.policyCore.action };
}

function buildProgrammableLightningZkBundle(options = {}) {
  const sharedPaymentProof = options.paymentProof || buildLightningPaymentConditionProof(options.payment || options);
  const watchtower = buildProgrammableWatchtower({
    ...options.watchtower,
    paymentProof: sharedPaymentProof,
    zkReceiptSummaryPath: options.zkReceiptSummaryPath,
    zkReceiptRef: options.watchtower?.zkReceiptRef,
    skipProofFileVerification: options.skipProofFileVerification
  });
  const aspPolicy = buildProgrammableAspPolicy({
    ...options.aspPolicy,
    paymentProof: sharedPaymentProof,
    zkReceiptSummaryPath: options.zkReceiptSummaryPath,
    settlementZkReceiptRef: options.aspPolicy?.settlementZkReceiptRef,
    forfeitZkReceiptRef: options.aspPolicy?.forfeitZkReceiptRef,
    skipProofFileVerification: options.skipProofFileVerification
  });
  const bundleCore = {
    version: 1,
    protocol: 'programmable_lightning_zk_watchtower_asp_bundle',
    paymentProofId: sharedPaymentProof.proofId,
    watchtowerProgramId: watchtower.programId,
    aspPolicyId: aspPolicy.policyId,
    watchtowerAction: watchtower.programCore.action,
    aspAction: aspPolicy.policyCore.action
  };
  return {
    kind: 'programmable_lightning_zk_watchtower_asp_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    paymentProof: sharedPaymentProof.publicReceipt,
    watchtower,
    aspPolicy,
    thesis:
      'Opaque Lightning payment facts can drive programmable watchtower and ASP sidecars by binding a hash/preimage receipt to Ark ZK miniscript proof receipts.',
    caveats: [
      'This is a deterministic local artifact, not a BOLT extension.',
      'The ZK Ark receipt proves the committed Ark path witness; LN still provides only local payment observations unless a sidecar or counterparty exposes a receipt.'
    ]
  };
}

function verifyProgrammableLightningZkBundle(bundle) {
  if (!bundle || bundle.kind !== 'programmable_lightning_zk_watchtower_asp_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  const watchtower = verifyProgrammableWatchtower(bundle.watchtower);
  if (!watchtower.ok) return watchtower;
  const asp = verifyProgrammableAspPolicy(bundle.aspPolicy);
  if (!asp.ok) return asp;
  return { ok: true, watchtowerAction: watchtower.action, aspAction: asp.action };
}

function renderMarkdown(bundle) {
  return [
    '# Programmable Lightning ZK Watchtower / ASP Bundle',
    '',
    `- Bundle id: \`${bundle.bundleId}\``,
    `- Payment proof id: \`${bundle.bundleCore.paymentProofId}\``,
    `- Watchtower action: \`${bundle.bundleCore.watchtowerAction}\``,
    `- ASP action: \`${bundle.bundleCore.aspAction}\``,
    '',
    '## Watchtower',
    '',
    `- Program id: \`${bundle.watchtower.programId}\``,
    `- ZK receipt role: \`${bundle.watchtower.zkReceiptRef.role}\``,
    `- ZK receipt id: \`${bundle.watchtower.zkReceiptRef.receiptId}\``,
    `- Challengeable: \`${bundle.watchtower.challenge.challengeable}\``,
    `- Violations: ${bundle.watchtower.challenge.challengeCore.violations.join(', ') || 'none'}`,
    '',
    '## ASP Policy',
    '',
    `- Policy id: \`${bundle.aspPolicy.policyId}\``,
    `- Settlement receipt id: \`${bundle.aspPolicy.settlementReceiptRef.receiptId}\``,
    `- Forfeit receipt id: \`${bundle.aspPolicy.forfeitReceiptRef.receiptId}\``,
    `- Slashable: \`${bundle.aspPolicy.challenge.slashable}\``,
    `- Violations: ${bundle.aspPolicy.challenge.challengeCore.violations.join(', ') || 'none'}`,
    '',
    '## Boundary',
    '',
    'The bundle proves a payment-conditioned sidecar state transition. It does not reveal the LN route, and it does not change LN commitment transaction enforcement.',
    ''
  ].join('\n');
}

function writeProgrammableLightningZkBundle(options = {}) {
  const outDir = options.outDir || ARTIFACTS_DIR;
  const bundle = buildProgrammableLightningZkBundle(options);
  const verification = verifyProgrammableLightningZkBundle(bundle);
  const artifact = {
    ...bundle,
    verification
  };
  const jsonPath = path.join(outDir, 'programmable_lightning_zk_latest.json');
  const mdPath = path.join(outDir, 'programmable_lightning_zk_latest.md');
  writeJson(jsonPath, artifact);
  fs.writeFileSync(mdPath, renderMarkdown(artifact), 'utf8');
  return { bundle: artifact, jsonPath, mdPath };
}

function runCli() {
  const { bundle, jsonPath, mdPath } = writeProgrammableLightningZkBundle();
  console.log(JSON.stringify({
    jsonPath,
    mdPath,
    bundleId: bundle.bundleId,
    watchtowerAction: bundle.bundleCore.watchtowerAction,
    aspAction: bundle.bundleCore.aspAction,
    verified: bundle.verification.ok
  }, null, 2));
}

if (require.main === module) {
  try {
    runCli();
  } catch (err) {
    console.error(`lightning_zk_programs failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  ARTIFACTS_DIR,
  DEFAULT_ZK_RECEIPT_SUMMARY_PATH,
  buildSyntheticZkReceiptRef,
  buildLightningPaymentConditionProof,
  verifyLightningPaymentConditionProof,
  buildArkZkReceiptRef,
  buildProgrammableWatchtower,
  verifyProgrammableWatchtower,
  buildProgrammableAspPolicy,
  verifyProgrammableAspPolicy,
  buildProgrammableLightningZkBundle,
  verifyProgrammableLightningZkBundle,
  writeProgrammableLightningZkBundle
};
