/**
 * Ark Taproot / Miniscript proof manifest.
 *
 * This is the deterministic contract between Ark VTXO evidence, UTXORef
 * challenge bundles, and a future Shinigami/STARK prover. It commits policy
 * shape, selected Taproot leaf, and public proof inputs without pretending that
 * this module compiles Miniscript or verifies a STARK proof.
 */

const crypto = require('crypto');
const { canonicalStringify, normalizeAmountSats } = require('./m1_spec');

const HEX_32_RE = /^[0-9a-f]{64}$/i;
const TAPROOT_PATH_ALGORITHM = 'ark_tapbranch_v1_structural_sha256';
const MAX_TAPROOT_PATH_DEPTH = 3;

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

function normalizeOptionalHex32(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeHex32(value, fieldName);
}

function normalizeOutpoint(value, fieldName) {
  const normalized = normalizeString(value, fieldName);
  const parts = normalized.split(':');
  if (parts.length !== 2 || !HEX_32_RE.test(parts[0]) || !/^[0-9]+$/.test(parts[1])) {
    throw new Error(`${fieldName} must be txid:vout`);
  }
  return `${parts[0].toLowerCase()}:${Number(parts[1])}`;
}

function extractTemplateCore(options) {
  return (options.template && options.template.templateCore) || options.templateCore || {};
}

function extractVtxoCore(options) {
  return (options.vtxo && options.vtxo.vtxoCore) || options.vtxoCore || {};
}

function deriveLeafHash(leafCore) {
  return sha256Hex(`ark-tapleaf-v1:${canonicalStringify(leafCore)}`);
}

function deriveBranchHash(leftHash, rightHash) {
  const left = normalizeHex32(leftHash, 'leftHash');
  const right = normalizeHex32(rightHash, 'rightHash');
  return sha256Hex(`ark-tapbranch-v1:${left}:${right}`);
}

function deriveTaprootPathProof(taprootLeaves, selectedLeafRole) {
  if (!Array.isArray(taprootLeaves) || taprootLeaves.length === 0) {
    throw new Error('taprootLeaves must be a non-empty array');
  }
  let selectedIndex = taprootLeaves.findIndex(leaf => leaf.role === selectedLeafRole);
  if (selectedIndex < 0) {
    throw new Error(`unknown selectedLeafRole ${selectedLeafRole}`);
  }

  let level = taprootLeaves.map((leaf, index) => ({
    nodeKind: 'leaf',
    role: leaf.role,
    index,
    hash: normalizeHex32(leaf.tapLeafHash, `taprootLeaves[${index}].tapLeafHash`)
  }));
  const path = [];
  let levelIndex = 0;

  while (level.length > 1) {
    if (selectedIndex % 2 === 0) {
      if (selectedIndex + 1 < level.length) {
        const sibling = level[selectedIndex + 1];
        path.push({
          level: levelIndex,
          siblingSide: 'right',
          siblingNodeKind: sibling.nodeKind,
          siblingRole: sibling.role || null,
          siblingHash: sibling.hash
        });
      }
    } else {
      const sibling = level[selectedIndex - 1];
      path.push({
        level: levelIndex,
        siblingSide: 'left',
        siblingNodeKind: sibling.nodeKind,
        siblingRole: sibling.role || null,
        siblingHash: sibling.hash
      });
    }

    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      if (index + 1 < level.length) {
        next.push({
          nodeKind: 'branch',
          role: null,
          index: next.length,
          hash: deriveBranchHash(level[index].hash, level[index + 1].hash)
        });
      } else {
        next.push({ ...level[index], index: next.length });
      }
    }

    selectedIndex = Math.floor(selectedIndex / 2);
    level = next;
    levelIndex += 1;
  }

  if (path.length > MAX_TAPROOT_PATH_DEPTH) {
    throw new Error(`selected Taproot path exceeds max depth ${MAX_TAPROOT_PATH_DEPTH}`);
  }

  const selectedLeaf = taprootLeaves.find(leaf => leaf.role === selectedLeafRole);
  const proofCore = {
    algorithm: TAPROOT_PATH_ALGORITHM,
    maxDepth: MAX_TAPROOT_PATH_DEPTH,
    selectedLeafRole,
    selectedTapLeafHash: selectedLeaf.tapLeafHash,
    taprootLeafRoot: level[0].hash,
    pathDepth: path.length,
    path
  };

  return {
    ...proofCore,
    pathCommitment: hashCanonical(proofCore)
  };
}

function buildPolicyLeaf(role, policyExpression, options = {}) {
  const leafCore = {
    version: 1,
    role,
    scriptFamily: 'taproot_miniscript_policy_shape',
    policyExpression,
    requiredSigners: options.requiredSigners || [],
    relativeTimelockBlocks: Number(options.relativeTimelockBlocks || 0),
    stateBindingFields: options.stateBindingFields || [],
    notes: options.notes || ''
  };

  return {
    role,
    tapLeafHash: deriveLeafHash(leafCore),
    leafCore
  };
}

function buildArkTaprootLeafSet(options = {}) {
  const templateCore = extractTemplateCore(options);
  const exitDelayBlocks = Number(options.exitDelayBlocks ?? templateCore.exitDelayBlocks ?? 144);
  const aspForfeitCsv = Number(options.aspForfeitCsv ?? templateCore.aspForfeitCsv ?? 2000);
  const aspPubkeyHex = normalizeHex32(
    options.aspPubkeyHex || sha256Hex(`asp-key:${templateCore.aspId || options.aspId || 'ark-asp-regtest'}`),
    'aspPubkeyHex'
  );
  const ownerPubkeyHex = normalizeHex32(
    options.ownerPubkeyHex || sha256Hex(`owner-key:${options.ownerNodeId || 'ark-owner-regtest'}`),
    'ownerPubkeyHex'
  );
  const oraclePubkeyHex = normalizeHex32(
    options.oraclePubkeyHex || sha256Hex(`oracle-key:${options.oracleEventId || 'ark-proof-oracle-regtest'}`),
    'oraclePubkeyHex'
  );
  const challengePubkeyHex = normalizeHex32(
    options.challengePubkeyHex || sha256Hex(`challenge-key:${options.utxorefPolicyId || 'utxoref-policy-regtest'}`),
    'challengePubkeyHex'
  );
  const selectedVirtualCetId = normalizeOptionalHex32(options.selectedVirtualCetId, 'selectedVirtualCetId');
  const settlementRoot = normalizeOptionalHex32(options.settlementRoot, 'settlementRoot');
  const vtxoCommitmentId = normalizeHex32(
    options.vtxoCommitmentId || (options.vtxo && options.vtxo.vtxoCommitmentId) || sha256Hex('ark-vtxo-proof-default'),
    'vtxoCommitmentId'
  );
  const virtualCetHash = selectedVirtualCetId || sha256Hex(`virtual-cet-placeholder:${vtxoCommitmentId}`);
  const settlementHash = settlementRoot || sha256Hex(`settlement-root:${vtxoCommitmentId}`);

  return [
    buildPolicyLeaf(
      'cooperative_round',
      `and_v(v:pk(${aspPubkeyHex}),pk(${ownerPubkeyHex}))`,
      {
        requiredSigners: ['asp', 'owner'],
        stateBindingFields: ['vtxoCommitmentId', 'arkRoundId', 'connectorOutpoint'],
        notes: 'Cooperative Ark round refresh or spend path.'
      }
    ),
    buildPolicyLeaf(
      'owner_csv_exit',
      `and_v(v:older(${exitDelayBlocks}),pk(${ownerPubkeyHex}))`,
      {
        requiredSigners: ['owner'],
        relativeTimelockBlocks: exitDelayBlocks,
        stateBindingFields: ['vtxoCommitmentId', 'arkRoundId'],
        notes: 'Owner unilateral exit after the Ark exit delay.'
      }
    ),
    buildPolicyLeaf(
      'asp_forfeit_guard',
      `and_v(v:older(${aspForfeitCsv}),pk(${aspPubkeyHex}))`,
      {
        requiredSigners: ['asp'],
        relativeTimelockBlocks: aspForfeitCsv,
        stateBindingFields: ['vtxoCommitmentId', 'utxorefPolicyId'],
        notes: 'ASP forfeit or slash guard committed for UTXORef challenge routing.'
      }
    ),
    buildPolicyLeaf(
      'dlc_virtual_cet_settlement',
      `and_v(v:pk(${aspPubkeyHex}),and_v(pk(${oraclePubkeyHex}),sha256(${virtualCetHash})))`,
      {
        requiredSigners: ['asp', 'oracle'],
        stateBindingFields: ['virtualCetSetId', 'selectedVirtualCetId', 'oracleOutcomeHash'],
        notes: 'Virtual CET settlement path; the hashlock binds the oracle-selected Ark transition.'
      }
    ),
    buildPolicyLeaf(
      'utxoref_challenge_publication',
      `and_v(v:pk(${challengePubkeyHex}),sha256(${settlementHash}))`,
      {
        requiredSigners: ['utxoref_challenger'],
        stateBindingFields: ['utxorefPolicyId', 'settlementRoot', 'challengeWindowBlocks'],
        notes: 'Challenge publication path for UTXORef/BitVM governor evidence.'
      }
    )
  ];
}

function buildArkTaprootMiniscriptProofManifest(options = {}) {
  const templateCore = extractTemplateCore(options);
  const vtxoCore = extractVtxoCore(options);
  const aspId = normalizeString(options.aspId || templateCore.aspId || vtxoCore.aspId || 'ark-asp-regtest', 'aspId');
  const templateId = normalizeString(
    options.templateId || templateCore.templateId || vtxoCore.templateId || `ark-template-${aspId}`,
    'templateId'
  );
  const arkRoundId = normalizeString(options.arkRoundId || vtxoCore.aspRoundId || 'ark-round-proof-regtest', 'arkRoundId');
  const connectorOutpoint = normalizeOutpoint(
    options.connectorOutpoint || vtxoCore.connectorOutpoint || `${sha256Hex(`ark-proof-connector:${arkRoundId}`)}:0`,
    'connectorOutpoint'
  );
  const vtxoCommitmentId = normalizeHex32(
    options.vtxoCommitmentId || (options.vtxo && options.vtxo.vtxoCommitmentId) || sha256Hex(`vtxo:${connectorOutpoint}`),
    'vtxoCommitmentId'
  );
  const internalKeyHex = normalizeHex32(
    options.internalKeyHex || templateCore.internalKeyHex || sha256Hex(`ark-internal:${templateId}`),
    'internalKeyHex'
  );
  const taprootOutputKey = normalizeHex32(
    options.taprootOutputKey || templateCore.taprootOutputKey || sha256Hex(`ark-output-key:${templateId}:${aspId}`),
    'taprootOutputKey'
  );
  const virtualCetSetId = normalizeOptionalHex32(options.virtualCetSetId, 'virtualCetSetId');
  const selectedVirtualCetId = normalizeOptionalHex32(options.selectedVirtualCetId, 'selectedVirtualCetId');
  const oracleOutcomeHash = normalizeOptionalHex32(options.oracleOutcomeHash, 'oracleOutcomeHash');
  const utxorefPolicyId = normalizeOptionalHex32(options.utxorefPolicyId, 'utxorefPolicyId');
  const settlementRoot = normalizeOptionalHex32(options.settlementRoot, 'settlementRoot');
  const selectedLeafRole = normalizeString(options.selectedLeafRole || 'cooperative_round', 'selectedLeafRole');
  const amountSats = normalizeAmountSats(options.amountSats || vtxoCore.vtxoAmountSats || 0n, 'amountSats');
  const challengeWindowBlocks = Number(options.challengeWindowBlocks ?? 144);
  const taprootLeaves = buildArkTaprootLeafSet({
    ...options,
    templateCore,
    vtxoCommitmentId,
    selectedVirtualCetId,
    settlementRoot
  });
  const selectedLeaf = taprootLeaves.find(leaf => leaf.role === selectedLeafRole);
  if (!selectedLeaf) {
    throw new Error(`unknown selectedLeafRole ${selectedLeafRole}`);
  }

  const miniscriptPolicyHash = hashCanonical(
    taprootLeaves.map(leaf => ({
      role: leaf.role,
      policyExpression: leaf.leafCore.policyExpression,
      tapLeafHash: leaf.tapLeafHash
    }))
  );
  const selectedTaprootPath = deriveTaprootPathProof(taprootLeaves, selectedLeafRole);
  const taprootLeafRoot = selectedTaprootPath.taprootLeafRoot;
  const publicInputs = {
    taprootOutputKey,
    taprootLeafRoot,
    selectedTapLeafHash: selectedLeaf.tapLeafHash,
    selectedTaprootPathCommitment: selectedTaprootPath.pathCommitment,
    miniscriptPolicyHash,
    arkRoundId,
    vtxoCommitmentId,
    virtualCetSetId,
    selectedVirtualCetId,
    oracleOutcomeHash,
    utxorefPolicyId,
    settlementRoot,
    amountSats: amountSats.toString()
  };
  const publicInputDigest = hashCanonical(publicInputs);
  const proofPackageCore = {
    version: 1,
    proofSystem: normalizeString(options.proofSystem || 'shinigami_cairo_stark_manifest', 'proofSystem'),
    proverStatus: normalizeString(options.proverStatus || 'manifest_only', 'proverStatus'),
    programId: normalizeString(options.programId || 'ark-shinigami-miniscript-v1', 'programId'),
    programHash: normalizeHex32(options.programHash || sha256Hex('ark-shinigami-miniscript-v1'), 'programHash'),
    executionTraceRoot: normalizeHex32(
      options.executionTraceRoot || sha256Hex(`trace:${publicInputDigest}`),
      'executionTraceRoot'
    ),
    proofRoot: normalizeHex32(options.proofRoot || sha256Hex(`proof:${publicInputDigest}`), 'proofRoot'),
    publicInputDigest
  };
  const proofPackage = {
    kind: 'ark_taproot_miniscript_proof_package',
    proofPackageId: hashCanonical(proofPackageCore),
    proofPackageCore
  };
  const manifestCore = {
    version: 1,
    protocol: 'ark_taproot_miniscript_proof_manifest',
    networkPolicy: 'bitcoin_taproot_policy_commitment',
    proofBoundary: 'offchain_shinigami_stark_or_utxoref_governor',
    aspId,
    templateId,
    arkRoundId,
    connectorOutpoint,
    vtxoCommitmentId,
    internalKeyHex,
    taprootOutputKey,
    selectedLeafRole,
    selectedTapLeafHash: selectedLeaf.tapLeafHash,
    selectedTaprootPathCommitment: selectedTaprootPath.pathCommitment,
    selectedTaprootPathDepth: selectedTaprootPath.pathDepth,
    taprootPathAlgorithm: TAPROOT_PATH_ALGORITHM,
    miniscriptPolicyHash,
    taprootLeafRoot,
    virtualCetSetId,
    selectedVirtualCetId,
    oracleOutcomeHash,
    utxorefPolicyId,
    settlementRoot,
    amountSats: amountSats.toString(),
    challengeWindowBlocks,
    proofPackageId: proofPackage.proofPackageId,
    publicInputDigest
  };

  const manifestId = hashCanonical({
    manifestCore,
    taprootLeaves,
    proofPackage
  });

  return {
    kind: 'ark_taproot_miniscript_proof_manifest',
    manifestId,
    manifestCore,
    taprootLeaves,
    selectedTaprootPath,
    publicInputs,
    proofPackage,
    checks: {
      selectedLeafPresent: true,
      taprootLeafRootMatched: taprootLeafRoot === selectedTaprootPath.taprootLeafRoot,
      selectedTaprootPathCommitmentMatched:
        selectedTaprootPath.pathCommitment ===
        hashCanonical({
          algorithm: selectedTaprootPath.algorithm,
          maxDepth: selectedTaprootPath.maxDepth,
          selectedLeafRole: selectedTaprootPath.selectedLeafRole,
          selectedTapLeafHash: selectedTaprootPath.selectedTapLeafHash,
          taprootLeafRoot: selectedTaprootPath.taprootLeafRoot,
          pathDepth: selectedTaprootPath.pathDepth,
          path: selectedTaprootPath.path
        }),
      selectedTaprootPathDepthWithinBounds: selectedTaprootPath.pathDepth <= MAX_TAPROOT_PATH_DEPTH,
      miniscriptPolicyHashMatched:
        miniscriptPolicyHash ===
        hashCanonical(taprootLeaves.map(leaf => ({
          role: leaf.role,
          policyExpression: leaf.leafCore.policyExpression,
          tapLeafHash: leaf.tapLeafHash
        }))),
      publicInputDigestMatched: publicInputDigest === hashCanonical(publicInputs),
      proofPackageBindsPublicInputs: proofPackage.proofPackageCore.publicInputDigest === publicInputDigest,
      selectedDlcLeafHasVirtualCet:
        selectedLeafRole !== 'dlc_virtual_cet_settlement' || Boolean(virtualCetSetId && selectedVirtualCetId)
    },
    caveats: [
      'This commits Taproot/Miniscript policy shape and a deterministic selected-leaf branch path; it does not compile descriptors or verify Bitcoin consensus scripts.',
      'The proof package is manifest-only until the Shinigami/Stwo prover replaces proofRoot and executionTraceRoot with real outputs.',
      'Bitcoin enforces the Taproot spend path; UTXORef/BitVM/governor logic consumes this proof manifest off-chain or in its challenge rail.'
    ]
  };
}

function verifyArkTaprootMiniscriptProofManifest(manifest) {
  if (!manifest || manifest.kind !== 'ark_taproot_miniscript_proof_manifest') {
    return { ok: false, reason: 'wrong manifest kind' };
  }
  const recomputedManifestId = hashCanonical({
    manifestCore: manifest.manifestCore,
    taprootLeaves: manifest.taprootLeaves,
    proofPackage: manifest.proofPackage
  });
  if (manifest.manifestId !== recomputedManifestId) {
    return { ok: false, reason: 'manifest id mismatch' };
  }
  const selectedLeaf = (manifest.taprootLeaves || []).find(leaf => leaf.role === manifest.manifestCore.selectedLeafRole);
  if (!selectedLeaf) return { ok: false, reason: 'selected leaf missing' };
  if (selectedLeaf.tapLeafHash !== manifest.manifestCore.selectedTapLeafHash) {
    return { ok: false, reason: 'selected leaf hash mismatch' };
  }
  const leafRoles = new Set();
  for (const leaf of manifest.taprootLeaves || []) {
    if (leafRoles.has(leaf.role)) return { ok: false, reason: `duplicate leaf role: ${leaf.role}` };
    leafRoles.add(leaf.role);
    if (deriveLeafHash(leaf.leafCore) !== leaf.tapLeafHash) {
      return { ok: false, reason: `leaf hash mismatch: ${leaf.role}` };
    }
  }
  const selectedTaprootPath = deriveTaprootPathProof(manifest.taprootLeaves, manifest.manifestCore.selectedLeafRole);
  const taprootLeafRoot = selectedTaprootPath.taprootLeafRoot;
  if (taprootLeafRoot !== manifest.manifestCore.taprootLeafRoot) {
    return { ok: false, reason: 'taproot leaf root mismatch' };
  }
  if (!manifest.selectedTaprootPath) {
    return { ok: false, reason: 'selected Taproot path missing' };
  }
  const suppliedPathCommitment = hashCanonical({
    algorithm: manifest.selectedTaprootPath.algorithm,
    maxDepth: manifest.selectedTaprootPath.maxDepth,
    selectedLeafRole: manifest.selectedTaprootPath.selectedLeafRole,
    selectedTapLeafHash: manifest.selectedTaprootPath.selectedTapLeafHash,
    taprootLeafRoot: manifest.selectedTaprootPath.taprootLeafRoot,
    pathDepth: manifest.selectedTaprootPath.pathDepth,
    path: manifest.selectedTaprootPath.path
  });
  if (suppliedPathCommitment !== manifest.selectedTaprootPath.pathCommitment) {
    return { ok: false, reason: 'selected Taproot path object mismatch' };
  }
  if (selectedTaprootPath.pathCommitment !== manifest.manifestCore.selectedTaprootPathCommitment) {
    return { ok: false, reason: 'selected Taproot path commitment mismatch' };
  }
  if (selectedTaprootPath.pathCommitment !== manifest.selectedTaprootPath.pathCommitment) {
    return { ok: false, reason: 'selected Taproot path object mismatch' };
  }
  if (selectedTaprootPath.pathDepth !== manifest.manifestCore.selectedTaprootPathDepth) {
    return { ok: false, reason: 'selected Taproot path depth mismatch' };
  }
  if (selectedTaprootPath.pathDepth > MAX_TAPROOT_PATH_DEPTH) {
    return { ok: false, reason: 'selected Taproot path too deep' };
  }
  const miniscriptPolicyHash = hashCanonical(
    manifest.taprootLeaves.map(leaf => ({
      role: leaf.role,
      policyExpression: leaf.leafCore.policyExpression,
      tapLeafHash: leaf.tapLeafHash
    }))
  );
  if (miniscriptPolicyHash !== manifest.manifestCore.miniscriptPolicyHash) {
    return { ok: false, reason: 'miniscript policy hash mismatch' };
  }
  if (hashCanonical(manifest.publicInputs) !== manifest.manifestCore.publicInputDigest) {
    return { ok: false, reason: 'public input digest mismatch' };
  }
  if (
    !manifest.proofPackage ||
    manifest.proofPackage.proofPackageCore.publicInputDigest !== manifest.manifestCore.publicInputDigest
  ) {
    return { ok: false, reason: 'proof package public input mismatch' };
  }
  if (manifest.manifestCore.selectedLeafRole === 'dlc_virtual_cet_settlement') {
    if (!manifest.manifestCore.virtualCetSetId || !manifest.manifestCore.selectedVirtualCetId) {
      return { ok: false, reason: 'DLC settlement leaf requires virtual CET ids' };
    }
  }
  return { ok: true };
}

module.exports = {
  MAX_TAPROOT_PATH_DEPTH,
  TAPROOT_PATH_ALGORITHM,
  buildArkTaprootLeafSet,
  buildArkTaprootMiniscriptProofManifest,
  verifyArkTaprootMiniscriptProofManifest,
  deriveLeafHash,
  deriveBranchHash,
  deriveTaprootPathProof
};
