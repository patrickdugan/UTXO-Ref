/**
 * Shinigami-style proof publication scaffold.
 *
 * This models a proof-carrying execution surface for BitVM experiments: one
 * semantic program state, multiple proof packages, rotating verifier handles,
 * and ordinary settlement-style publication cover.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');
const { buildJurassicMechanismRefs } = require('./jurassic_bitvm_mechanisms');
const {
  buildArkTaprootMiniscriptProofManifest,
  verifyArkTaprootMiniscriptProofManifest
} = require('./ark_taproot_miniscript_proof_manifest');

const HEX_32_RE = /^[0-9a-f]{64}$/i;

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

function buildShinigamiProgramState(options = {}) {
  const programId = normalizeString(options.programId || 'shinigami-demo-program', 'programId');
  const claimAmountSats = normalizeAmountSats(options.claimAmountSats || 250000n, 'claimAmountSats');
  const inputStateRoot = normalizeHex32(options.inputStateRoot || sha256Hex(`input:${programId}`), 'inputStateRoot');
  const outputStateRoot = normalizeHex32(options.outputStateRoot || sha256Hex(`output:${programId}`), 'outputStateRoot');
  const verifierSetRoot = normalizeHex32(
    options.verifierSetRoot || sha256Hex(`verifiers:${programId}`),
    'verifierSetRoot'
  );
  const taprootProofManifest =
    options.taprootProofManifest ||
    buildArkTaprootMiniscriptProofManifest({
      ...options,
      selectedLeafRole: options.selectedLeafRole || 'cooperative_round',
      amountSats: claimAmountSats,
      vtxoCommitmentId: options.vtxoCommitmentId || sha256Hex(`shinigami-vtxo:${programId}`)
    });

  const stateCore = {
    version: 1,
    protocol: 'shinigami_style_proof_publication',
    programId,
    vmProfile: normalizeString(options.vmProfile || 'bitvm-script-verifier-scaffold', 'vmProfile'),
    inputStateRoot,
    outputStateRoot,
    verifierSetRoot,
    taprootProofManifestId: taprootProofManifest.manifestId,
    taprootSelectedLeafHash: taprootProofManifest.manifestCore.selectedTapLeafHash,
    miniscriptPolicyHash: taprootProofManifest.manifestCore.miniscriptPolicyHash,
    claimAmountSats: claimAmountSats.toString(),
    challengeWindowBlocks: Number(options.challengeWindowBlocks ?? 144)
  };

  return {
    kind: 'shinigami_program_state',
    stateId: hashCanonical(stateCore),
    stateCore,
    taprootProofManifest
  };
}

function buildShinigamiProofPublication(options = {}) {
  const programState = options.programState || buildShinigamiProgramState(options);
  const taprootProofManifest =
    options.taprootProofManifest || programState.taprootProofManifest || buildArkTaprootMiniscriptProofManifest(options);
  const proofRoot = normalizeHex32(options.proofRoot || sha256Hex(`proof:${programState.stateId}`), 'proofRoot');
  const executionTraceRoot = normalizeHex32(
    options.executionTraceRoot || sha256Hex(`trace:${programState.stateId}`),
    'executionTraceRoot'
  );
  const jurassicMechanisms = buildJurassicMechanismRefs('shinigami', {
    contractId: programState.stateId,
    applicationIntent: 'proof-carrying execution publication and verifier routing',
    route: 'execution_proof_accept_or_challenge',
    amountSats: programState.stateCore.claimAmountSats,
    settlementEpoch: `shinigami:${programState.stateCore.programId}`,
    challengeWindowBlocks: programState.stateCore.challengeWindowBlocks
  });

  const publicationCore = {
    version: 1,
    programStateId: programState.stateId,
    taprootProofManifestId: taprootProofManifest.manifestId,
    taprootProofPackageId: taprootProofManifest.proofPackage.proofPackageId,
    miniscriptPolicyHash: taprootProofManifest.manifestCore.miniscriptPolicyHash,
    taprootSelectedLeafHash: taprootProofManifest.manifestCore.selectedTapLeafHash,
    proofRoot,
    executionTraceRoot,
    proofPackageRole: normalizeString(options.proofPackageRole || 'execution-trace-attestation', 'proofPackageRole'),
    jurassicMechanismRefId: jurassicMechanisms.refId,
    transcriptSwitchboardId: jurassicMechanisms.transcriptSwitchboardId,
    proofTranscriptDigest: jurassicMechanisms.primaryTranscriptDigest,
    verifierHandleId: jurassicMechanisms.primaryPublicHandleId,
    carrierCommitmentId: jurassicMechanisms.primaryCarrierCommitmentId,
    publicationCover: 'ordinary settlement batch proof sidecar',
    status: jurassicMechanisms.status
  };

  return {
    kind: 'shinigami_proof_publication',
    publicationId: hashCanonical(publicationCore),
    publicationCore,
    taprootProofManifest,
    jurassicMechanisms
  };
}

function buildShinigamiVerifierReceipt(options = {}) {
  const programState = options.programState || buildShinigamiProgramState(options);
  const publication = options.publication || buildShinigamiProofPublication({ ...options, programState });
  const accepted = options.accepted !== undefined ? Boolean(options.accepted) : true;
  const receiptCore = {
    version: 1,
    programStateId: programState.stateId,
    publicationId: publication.publicationId,
    taprootProofManifestId: publication.publicationCore.taprootProofManifestId,
    verifierId: normalizeString(options.verifierId || 'shinigami-verifier-demo', 'verifierId'),
    verifierHandleId: publication.publicationCore.verifierHandleId,
    observedProofRoot: normalizeHex32(options.observedProofRoot || publication.publicationCore.proofRoot, 'observedProofRoot'),
    observedExecutionTraceRoot: normalizeHex32(
      options.observedExecutionTraceRoot || publication.publicationCore.executionTraceRoot,
      'observedExecutionTraceRoot'
    ),
    accepted
  };

  return {
    kind: 'shinigami_verifier_receipt',
    receiptId: hashCanonical(receiptCore),
    receiptCore,
    checks: {
      proofRootMatched: receiptCore.observedProofRoot === publication.publicationCore.proofRoot,
      executionTraceRootMatched:
        receiptCore.observedExecutionTraceRoot === publication.publicationCore.executionTraceRoot,
      verifierHandleMatched: receiptCore.verifierHandleId === publication.publicationCore.verifierHandleId,
      taprootProofManifestMatched:
        receiptCore.taprootProofManifestId === publication.publicationCore.taprootProofManifestId,
      accepted
    }
  };
}

function buildShinigamiProofChallenge(options = {}) {
  const programState = options.programState || buildShinigamiProgramState(options);
  const publication = options.publication || buildShinigamiProofPublication({ ...options, programState });
  const observedProofRoot = normalizeHex32(
    options.observedProofRoot || sha256Hex(`bad-proof:${publication.publicationId}`),
    'observedProofRoot'
  );
  const observedExecutionTraceRoot = normalizeHex32(
    options.observedExecutionTraceRoot || publication.publicationCore.executionTraceRoot,
    'observedExecutionTraceRoot'
  );

  const violations = [];
  if (observedProofRoot !== publication.publicationCore.proofRoot) violations.push('proof_root_mismatch');
  if (observedExecutionTraceRoot !== publication.publicationCore.executionTraceRoot) {
    violations.push('execution_trace_root_mismatch');
  }

  const challengeCore = {
    version: 1,
    programStateId: programState.stateId,
    publicationId: publication.publicationId,
    taprootProofManifestId: publication.publicationCore.taprootProofManifestId,
    verifierHandleId: publication.publicationCore.verifierHandleId,
    observedProofRoot,
    observedExecutionTraceRoot,
    violations
  };

  return {
    kind: 'shinigami_proof_challenge',
    challengeId: hashCanonical(challengeCore),
    challengeCore,
    slashable: violations.length > 0
  };
}

function buildShinigamiProofPublicationBundle(options = {}) {
  const programState = buildShinigamiProgramState(options);
  const publication = buildShinigamiProofPublication({ ...options, programState });
  const taprootProofManifest = publication.taprootProofManifest || programState.taprootProofManifest;
  const verifierReceipt = buildShinigamiVerifierReceipt({ ...options, programState, publication });
  const challenge = buildShinigamiProofChallenge({
    ...options,
    programState,
    publication,
    observedProofRoot: options.challengeObservedProofRoot
  });

  const bundleCore = {
    programStateId: programState.stateId,
    publicationId: publication.publicationId,
    taprootProofManifestId: taprootProofManifest.manifestId,
    jurassicMechanismRefId: publication.publicationCore.jurassicMechanismRefId,
    verifierHandleId: publication.publicationCore.verifierHandleId,
    receiptId: verifierReceipt.receiptId,
    challengeId: challenge.challengeId
  };

  return {
    kind: 'shinigami_bitvm_proof_publication_bundle',
    bundleId: hashCanonical(bundleCore),
    bundleCore,
    programState,
    taprootProofManifest,
    publication,
    verifierReceipt,
    challenge,
    thesis:
      'Use Jurassic transcript and namespace mechanics to make proof-carrying execution publications searchable, retryable, and challengeable without binding the repo to a production verifier yet.',
    caveats: [
      'This is a local proof-publication scaffold, not a production Shinigami verifier.',
      'Production needs the real script verifier, proof format, verifier set, and on-chain publication rules.',
      'The Jurassic mechanism refs are search and routing handles; they are not consensus assumptions.'
    ]
  };
}

function verifyShinigamiProofPublicationBundle(bundle) {
  if (!bundle || bundle.kind !== 'shinigami_bitvm_proof_publication_bundle') {
    return { ok: false, reason: 'wrong bundle kind' };
  }
  if (bundle.bundleId !== hashCanonical(bundle.bundleCore)) {
    return { ok: false, reason: 'bundle id mismatch' };
  }
  if (!bundle.taprootProofManifest) {
    return { ok: false, reason: 'missing taproot proof manifest' };
  }
  const taprootVerification = verifyArkTaprootMiniscriptProofManifest(bundle.taprootProofManifest);
  if (!taprootVerification.ok) {
    return { ok: false, reason: `taproot proof manifest failed: ${taprootVerification.reason}` };
  }
  if (bundle.bundleCore.taprootProofManifestId !== bundle.taprootProofManifest.manifestId) {
    return { ok: false, reason: 'taproot proof manifest id mismatch' };
  }
  if (bundle.publication.publicationCore.taprootProofManifestId !== bundle.taprootProofManifest.manifestId) {
    return { ok: false, reason: 'publication does not bind taproot proof manifest' };
  }
  for (const [name, passed] of Object.entries(bundle.verifierReceipt.checks || {})) {
    if (!passed) return { ok: false, reason: `verifier receipt failed: ${name}` };
  }
  if (!bundle.challenge.slashable) {
    return { ok: false, reason: 'challenge should be slashable in demo bundle' };
  }
  if (!bundle.publication.publicationCore.verifierHandleId) {
    return { ok: false, reason: 'missing verifier handle' };
  }
  return { ok: true };
}

module.exports = {
  buildShinigamiProgramState,
  buildShinigamiProofPublication,
  buildShinigamiVerifierReceipt,
  buildShinigamiProofChallenge,
  buildShinigamiProofPublicationBundle,
  verifyShinigamiProofPublicationBundle
};
