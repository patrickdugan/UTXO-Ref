/**
 * Milestone 1 Latest Settlement Validator
 *
 * Validates the latest draft, challenge witness, expiry artifact, and timeout
 * proof against the satoshi-precise routing verifier.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_validate_latest_settlement.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  verifySettlementRouting
} = require('./index');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DRAFT_PATH = path.join(ARTIFACTS_DIR, 'm1_dlc_draft_latest.json');
const WITNESS_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_witness_latest.json');
const EXPIRY_PATH = path.join(ARTIFACTS_DIR, 'm1_expiry_redemption_latest.json');
const TIMEOUT_PROOF_PATH = path.join(ARTIFACTS_DIR, 'm1_expiry_timeout_testnet_proof.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_settlement_validation_latest.json');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing artifact: ${filePath}`);
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertOk(result, label) {
  if (!result.ok) {
    throw new Error(`${label}: ${result.reason || 'verification failed'}`);
  }
  return {
    ok: true,
    expected: {
      settlementKind: result.expected.settlementKind,
      winnerSweepSats: result.expected.winnerSweepSats.toString(),
      refundRemainderSats: result.expected.refundRemainderSats.toString(),
      feeSats: result.expected.feeSats.toString(),
      collateralSats: result.expected.collateralSats.toString()
    }
  };
}

function validateDraftPaths(draft) {
  const collateralSats = draft?.contract?.collateralSats;
  const settlementPaths = Array.isArray(draft?.contract?.settlement?.paths)
    ? draft.contract.settlement.paths
    : [];

  return settlementPaths.map((pathRecord) => {
    const result = verifySettlementRouting({
      route: pathRecord.pathId,
      collateralSats,
      actualPayoutSats: pathRecord.actualPayoutSats ?? pathRecord.payoutSats ?? 0,
      feeSats: pathRecord.feeSats ?? 0,
      refundSats: pathRecord.refundSats ?? pathRecord.residualSats ?? 0,
      dustCarrySats: pathRecord.dustCarrySats ?? 0
    }, {
      outputs: [
        {
          role: 'winner-sweep',
          address: pathRecord.winnerAddress || null,
          amountSats: pathRecord.actualPayoutSats ?? pathRecord.payoutSats ?? 0
        },
        {
          role: 'refund-remainder',
          address: pathRecord.refundAddress || null,
          amountSats: pathRecord.refundSats ?? pathRecord.residualSats ?? 0
        },
        {
          role: 'fee',
          address: pathRecord.feeAddress || null,
          amountSats: pathRecord.feeSats ?? 0
        },
        {
          role: 'dust-carry',
          address: pathRecord.dustAddress || null,
          amountSats: pathRecord.dustCarrySats ?? 0
        }
      ]
    }, {
      winnerAddress: pathRecord.winnerAddress || null,
      refundAddress: pathRecord.refundAddress || null,
      feeAddress: pathRecord.feeAddress || null,
      dustAddress: pathRecord.dustAddress || null
    });

    return {
      pathId: pathRecord.pathId,
      ...assertOk(result, `draft path ${pathRecord.pathId}`)
    };
  });
}

function validateExpiryArtifact(witnessArtifact, expiryArtifact) {
  const state = {
    route: witnessArtifact?.route || witnessArtifact?.witness?.route || 'roll',
    ...(witnessArtifact?.witness?.transitionState || {})
  };
  const settlement = expiryArtifact?.settlementBreakdown
    || expiryArtifact?.deltas?.settlementBreakdown
    || {};

  const result = verifySettlementRouting(state, {
    outputs: [
      {
        role: 'winner-sweep',
        address: expiryArtifact?.routingCommitments?.winnerAddress || null,
        amountSats: settlement.winnerSweepSats ?? expiryArtifact?.redemption?.amountSats ?? 0
      },
      {
        role: 'refund-remainder',
        address: expiryArtifact?.routingCommitments?.refundAddress || null,
        amountSats: settlement.refundSats ?? settlement.residualSats ?? expiryArtifact?.redemption?.remainingBalanceSats ?? 0
      },
      {
        role: 'fee',
        address: expiryArtifact?.routingCommitments?.feeAddress || null,
        amountSats: settlement.feeSats ?? 0
      },
      {
        role: 'dust-carry',
        address: expiryArtifact?.routingCommitments?.dustAddress || null,
        amountSats: settlement.dustCarrySats ?? 0
      }
    ]
  });

  const validated = assertOk(result, 'expiry artifact');
  if ((settlement.settlementKind || null) !== validated.expected.settlementKind) {
    throw new Error(`expiry artifact: settlementKind mismatch, expected ${validated.expected.settlementKind}, got ${settlement.settlementKind}`);
  }

  return validated;
}

function validateTimeoutProof(witnessArtifact, timeoutProof) {
  const state = {
    route: witnessArtifact?.route || witnessArtifact?.witness?.route || 'roll',
    ...(witnessArtifact?.witness?.transitionState || {})
  };
  const result = verifySettlementRouting(state, {
    outputs: [
      {
        role: 'winner-sweep',
        address: timeoutProof?.committedRouting?.winnerAddress || timeoutProof?.recipient?.address || null,
        amountSats: timeoutProof?.timeoutSpend?.recipientSats ?? 0
      },
      {
        role: 'refund-remainder',
        address: timeoutProof?.committedRouting?.refundAddress || timeoutProof?.residual?.address || null,
        amountSats: timeoutProof?.timeoutSpend?.residualSats ?? 0
      },
      {
        role: 'dust-carry',
        address: timeoutProof?.committedRouting?.dustAddress || null,
        amountSats: timeoutProof?.timeoutSpend?.dustCarrySats ?? 0
      }
    ]
  }, {
    winnerAddress: timeoutProof?.committedRouting?.winnerAddress || timeoutProof?.recipient?.address || null,
    refundAddress: timeoutProof?.committedRouting?.refundAddress || timeoutProof?.residual?.address || null,
    feeAddress: timeoutProof?.committedRouting?.feeAddress || null,
    dustAddress: timeoutProof?.committedRouting?.dustAddress || null
  });

  return assertOk(result, 'timeout proof');
}

function run() {
  ensureFile(DRAFT_PATH);
  ensureFile(WITNESS_PATH);
  ensureFile(EXPIRY_PATH);
  ensureFile(TIMEOUT_PROOF_PATH);

  const draft = loadJson(DRAFT_PATH);
  const witnessArtifact = loadJson(WITNESS_PATH);
  const expiryArtifact = loadJson(EXPIRY_PATH);
  const timeoutProof = loadJson(TIMEOUT_PROOF_PATH);

  const validation = {
    kind: 'm1_settlement_validation',
    createdAt: new Date().toISOString(),
    sourceArtifacts: {
      draftPath: DRAFT_PATH,
      witnessPath: WITNESS_PATH,
      expiryPath: EXPIRY_PATH,
      timeoutProofPath: TIMEOUT_PROOF_PATH
    },
    checks: {
      draftPaths: validateDraftPaths(draft),
      expiryArtifact: validateExpiryArtifact(witnessArtifact, expiryArtifact),
      timeoutProof: validateTimeoutProof(witnessArtifact, timeoutProof)
    },
    gaps: []
  };

  validation.validationHash = sha256Hex(JSON.stringify(validation));
  fs.writeFileSync(OUT_PATH, JSON.stringify(validation, null, 2));

  console.log('=== M1 Settlement Validation ===');
  console.log(`draftPaths=${validation.checks.draftPaths.length}`);
  console.log(`expiryArtifact=${validation.checks.expiryArtifact.expected.settlementKind}`);
  console.log(`timeoutProof=${validation.checks.timeoutProof.expected.settlementKind}`);
  console.log(`validationHash=${validation.validationHash}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

try {
  run();
} catch (err) {
  console.error('Settlement validation failed:', err.message);
  process.exit(1);
}
