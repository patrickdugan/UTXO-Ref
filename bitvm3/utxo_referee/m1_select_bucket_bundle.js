/**
 * Milestone 1 - CET Bucket Selection + Challenge Bundle
 *
 * Reads CET and oracle wiring artifacts and emits a challenge-ready bundle
 * for one selected settlement path.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_select_bucket_bundle.js
 *
 * Optional env:
 *   PATH_NAME=settle-gain|settle-loss|roll
 *   BUCKET_PCT=10  (legacy fallback)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const CET_PATH = path.join(ARTIFACTS_DIR, 'm1_cet_skeletons_latest.json');
const ORACLE_PATH = path.join(ARTIFACTS_DIR, 'm1_oracle_wiring_latest.json');
const FUNDING_FINAL_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json');
const PATH_NAME = process.env.PATH_NAME || null;
const BUCKET = process.env.BUCKET_PCT !== undefined ? Number(process.env.BUCKET_PCT) : null;

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function loadJson(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing artifact: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function run() {
  const cet = loadJson(CET_PATH);
  const oracle = loadJson(ORACLE_PATH);
  const fundingFinal = fs.existsSync(FUNDING_FINAL_PATH) ? loadJson(FUNDING_FINAL_PATH) : null;
  const settlement = cet.settlement || {};
  const paths = Array.isArray(settlement.paths) ? settlement.paths : [];
  const legacyBuckets = cet.cets && Array.isArray(cet.cets.cets) ? cet.cets.cets : [];

  const selectingByPath = !!PATH_NAME;
  const selectedPath = selectingByPath
    ? (paths.find(r => r.pathId === PATH_NAME) || (settlement.roll && PATH_NAME === 'roll' ? settlement.roll : null))
    : null;

  let selectedCet = null;
  let selectedTarget = null;
  let selectorLabel = '';

  if (selectingByPath) {
    if (!selectedPath) {
      throw new Error(`No settlement path found for ${PATH_NAME}`);
    }
    selectorLabel = PATH_NAME;
    if (PATH_NAME !== 'roll') {
      selectedCet = paths.find(r => r.pathId === PATH_NAME);
      selectedTarget = oracle.attestationTargets.find(t => t.pathId === PATH_NAME);
      if (!selectedTarget) {
        throw new Error(`No oracle target found for path ${PATH_NAME}`);
      }
    }
  } else {
    if (!Number.isInteger(BUCKET) || BUCKET < 0 || BUCKET > 100 || BUCKET % 5 !== 0) {
      throw new Error('BUCKET_PCT must be one of: 0,5,10,...,100');
    }
    selectorLabel = String(BUCKET);
    selectedCet = legacyBuckets.find(r => r.bucketPct === BUCKET);
    if (!selectedCet) throw new Error(`No CET found for bucket ${BUCKET}`);
    selectedTarget = oracle.attestationTargets.find(t => t.bucketPct === BUCKET);
    if (!selectedTarget) throw new Error(`No oracle target found for bucket ${BUCKET}`);
  }

  const bundle = {
    kind: 'm1_challenge_bundle',
    createdAt: new Date().toISOString(),
    selectedPathId: selectingByPath ? PATH_NAME : null,
    selectedBucketPct: selectingByPath ? null : BUCKET,
    sourceHashes: {
      cet: sha256Hex(JSON.stringify(cet)),
      oracle: sha256Hex(JSON.stringify(oracle)),
      fundingFinal: fundingFinal ? sha256Hex(JSON.stringify(fundingFinal)) : null
    },
    binding: {
      fundingOutpoint: cet.fundingOutpoint,
      fundingTxidFinalized: fundingFinal ? fundingFinal.txid : null,
      maturityHeight: cet.maturityHeight || (cet.cets && cet.cets.maturityHeight) || null,
      refundLocktime: cet.refundLocktime || (cet.cets && cet.cets.refundLocktime) || null,
      dustCarrySats: settlement.dustCarrySats || null
    },
    selectedPath: selectingByPath
      ? {
          pathId: selectedPath.pathId || PATH_NAME,
          kind: selectedPath.kind,
          locktime: selectedPath.locktime || settlement.roll.rollLocktime || null,
          rawTxHex: selectedPath.rawTxHex || null,
          txid: selectedPath.txid || null,
          payoutSats: selectedPath.payoutSats || null,
          residualSats: selectedPath.residualSats || (selectedPath.payouts ? selectedPath.payouts.rolloverCollateralSats || null : null),
          dustCarrySats: selectedPath.dustCarrySats || (selectedPath.payouts ? selectedPath.payouts.dustCarrySats || null : null),
          rolloverCollateralSats: selectedPath.rolloverCollateralSats || (selectedPath.payouts ? selectedPath.payouts.rolloverCollateralSats || null : null),
          defaultOnExpiry: PATH_NAME === 'roll' ? true : !!selectedPath.defaultOnExpiry
        }
      : {
          pathId: selectedCet.pathId || `bucket-${BUCKET}`,
          kind: selectedCet.kind || 'settlement',
          locktime: selectedCet.locktime,
          rawTxHex: selectedCet.rawTxHex,
          txid: selectedCet.txid,
          payouts: selectedCet.payouts,
          payoutSats: selectedCet.payoutSats || null,
          residualSats: selectedCet.residualSats || null,
          dustCarrySats: selectedCet.dustCarrySats || null
        },
    oracleBinding: {
      eventId: oracle.oracle.eventId,
      quorumId: oracle.oracle.quorumId,
      keyId: oracle.oracle.oracleKeyId,
      messagePayload: selectedTarget ? selectedTarget.message.payload : null,
      messageDigestHex: selectedTarget ? selectedTarget.message.digestHex : null,
      nonceCommitment: selectedTarget ? selectedTarget.oracleNonceCommitment : null,
      oracleSignaturePlaceholder: selectedTarget ? selectedTarget.oracleSignaturePlaceholder : null,
      adaptorPointPlaceholder: selectedTarget ? selectedTarget.adaptorPointPlaceholder : null,
      adaptorSignaturePlaceholder: selectedTarget ? selectedTarget.adaptorSignaturePlaceholder : null
    },
    witnessBundlePlaceholders: {
      honestPath: {
        required: [
          'commitmentPackage',
          'selectedPathId',
          'oracleSignature',
          'cetPreimageOrSig'
        ],
        note: 'Populate these fields when challenge protocol witness format is finalized.'
      },
      challengedPath: {
        required: [
          'conflictingSweepData',
          'attestationDigest',
          'oracleSignature',
          'merkleMembershipProofs',
          'capResidualChecks'
        ],
        note: 'Use this shape for arbitration redirect payload.'
      }
    }
  };

  bundle.bundleHash = sha256Hex(JSON.stringify(bundle));
  fs.writeFileSync(OUT_PATH, JSON.stringify(bundle, null, 2));

  console.log('=== M1 CET Bundle Selection ===');
  console.log(`path=${selectorLabel}`);
  console.log(`cetTxid=${bundle.selectedPath.txid}`);
  console.log(`messageDigest=${bundle.oracleBinding.messageDigestHex}`);
  console.log(`bundleHash=${bundle.bundleHash}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

try {
  run();
} catch (err) {
  console.error('Bundle generation failed:', err.message);
  process.exit(1);
}
