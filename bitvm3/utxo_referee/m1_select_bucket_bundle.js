/**
 * Milestone 1 - CET Bucket Selection + Challenge Bundle
 *
 * Reads CET and oracle wiring artifacts and emits a challenge-ready bundle
 * for one selected outcome bucket.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_select_bucket_bundle.js
 *
 * Optional env:
 *   BUCKET_PCT=10
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const CET_PATH = path.join(ARTIFACTS_DIR, 'm1_cet_skeletons_latest.json');
const ORACLE_PATH = path.join(ARTIFACTS_DIR, 'm1_oracle_wiring_latest.json');
const FUNDING_FINAL_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json');
const BUCKET = Number(process.env.BUCKET_PCT || '10');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function loadJson(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing artifact: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function run() {
  if (!Number.isInteger(BUCKET) || BUCKET < 0 || BUCKET > 100 || BUCKET % 5 !== 0) {
    throw new Error('BUCKET_PCT must be one of: 0,5,10,...,100');
  }

  const cet = loadJson(CET_PATH);
  const oracle = loadJson(ORACLE_PATH);
  const fundingFinal = fs.existsSync(FUNDING_FINAL_PATH) ? loadJson(FUNDING_FINAL_PATH) : null;

  const selectedCet = cet.cets.cets.find(r => r.bucketPct === BUCKET);
  if (!selectedCet) throw new Error(`No CET found for bucket ${BUCKET}`);

  const selectedTarget = oracle.attestationTargets.find(t => t.bucketPct === BUCKET);
  if (!selectedTarget) throw new Error(`No oracle target found for bucket ${BUCKET}`);

  const bundle = {
    kind: 'm1_challenge_bundle',
    createdAt: new Date().toISOString(),
    selectedBucketPct: BUCKET,
    sourceHashes: {
      cet: sha256Hex(JSON.stringify(cet)),
      oracle: sha256Hex(JSON.stringify(oracle)),
      fundingFinal: fundingFinal ? sha256Hex(JSON.stringify(fundingFinal)) : null
    },
    binding: {
      fundingOutpoint: cet.fundingOutpoint,
      fundingTxidFinalized: fundingFinal ? fundingFinal.txid : null,
      maturityHeight: cet.cets.maturityHeight,
      refundLocktime: cet.cets.refundLocktime
    },
    selectedCet: {
      txid: selectedCet.txid,
      locktime: selectedCet.locktime,
      rawTxHex: selectedCet.rawTxHex,
      payouts: selectedCet.payouts
    },
    oracleBinding: {
      eventId: oracle.oracle.eventId,
      quorumId: oracle.oracle.quorumId,
      keyId: oracle.oracle.oracleKeyId,
      messagePayload: selectedTarget.message.payload,
      messageDigestHex: selectedTarget.message.digestHex,
      nonceCommitment: selectedTarget.oracleNonceCommitment,
      oracleSignaturePlaceholder: selectedTarget.oracleSignaturePlaceholder,
      adaptorPointPlaceholder: selectedTarget.adaptorPointPlaceholder,
      adaptorSignaturePlaceholder: selectedTarget.adaptorSignaturePlaceholder
    },
    witnessBundlePlaceholders: {
      honestPath: {
        required: [
          'commitmentPackage',
          'withdrawalProofSet',
          'selectedBucketPct',
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
  console.log(`bucket=${BUCKET}`);
  console.log(`cetTxid=${bundle.selectedCet.txid}`);
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

