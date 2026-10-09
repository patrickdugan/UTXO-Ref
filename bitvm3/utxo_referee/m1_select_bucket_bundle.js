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
const { buildOracleDeltaPublication } = require('./m1_oracle_delta_publication');
const { withCommittedRouting, assertCommittedRouting } = require('./m1_routing_commitments');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const CET_PATH = path.join(ARTIFACTS_DIR, 'm1_cet_skeletons_latest.json');
const ORACLE_PATH = path.join(ARTIFACTS_DIR, 'm1_oracle_wiring_latest.json');
const FUNDING_FINAL_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json');
const WITNESS_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_witness_latest.json');
const PATH_NAME = process.env.PATH_NAME || null;
const BUCKET = process.env.BUCKET_PCT !== undefined ? Number(process.env.BUCKET_PCT) : null;
const { buildChallengeWitnessBundle } = require('./m1_challenge_witness');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function stringifyJson(value, pretty = false) {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    pretty ? 2 : 0
  );
}

function bundleHashSnapshot(bundle) {
  return JSON.parse(
    stringifyJson({
      ...bundle,
      bundleHash: null,
      deltaPublication: bundle.deltaPublication
        ? { ...bundle.deltaPublication, bundleHash: null }
        : null
    })
  );
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
      ? withCommittedRouting({
          pathId: selectedPath.pathId || PATH_NAME,
          kind: selectedPath.kind,
          winnerRole: selectedPath.winnerRole || null,
          winnerAddress: selectedPath.winnerAddress || (selectedPath.payouts ? selectedPath.payouts.winnerAddress || null : null),
          refundRole: selectedPath.refundRole || null,
          refundAddress: selectedPath.refundAddress || (selectedPath.payouts ? selectedPath.payouts.refundAddress || null : null),
          feeRole: selectedPath.feeRole || null,
          feeAddress: selectedPath.feeAddress || (selectedPath.payouts ? selectedPath.payouts.feeAddress || null : null),
          dustRole: selectedPath.dustRole || null,
          dustAddress: selectedPath.dustAddress || (selectedPath.payouts ? selectedPath.payouts.dustAddress || null : null),
          locktime: selectedPath.locktime || settlement.roll.rollLocktime || null,
          rawTxHex: selectedPath.rawTxHex || null,
          txid: selectedPath.txid || null,
          bucketCapBps: selectedPath.bucketCapBps ?? null,
          realizedPnlBps: selectedPath.realizedPnlBps ?? null,
          effectivePnlBps: selectedPath.effectivePnlBps ?? null,
          feeBps: selectedPath.feeBps ?? null,
          actualPayoutSats: selectedPath.actualPayoutSats || selectedPath.payoutSats || null,
          payoutSats: selectedPath.payoutSats || null,
          feeSats: selectedPath.feeSats || null,
          residualSats: selectedPath.residualSats || (selectedPath.payouts ? selectedPath.payouts.rolloverCollateralSats || null : null),
          timeoutRemainderSats: selectedPath.timeoutRemainderSats || (selectedPath.payouts ? selectedPath.payouts.timeoutRemainderSats || null : null),
          dustCarrySats: selectedPath.dustCarrySats || (selectedPath.payouts ? selectedPath.payouts.dustCarrySats || null : null),
          rolloverCollateralSats: selectedPath.rolloverCollateralSats || (selectedPath.payouts ? selectedPath.payouts.rolloverCollateralSats || null : null),
          defaultOnExpiry: PATH_NAME === 'roll' ? true : !!selectedPath.defaultOnExpiry
        })
      : withCommittedRouting({
          pathId: selectedCet.pathId || `bucket-${BUCKET}`,
          kind: selectedCet.kind || 'settlement',
          winnerRole: selectedCet.winnerRole || selectedCet.recipientRole || null,
          winnerAddress: selectedCet.winnerAddress || null,
          refundRole: selectedCet.refundRole || null,
          refundAddress: selectedCet.refundAddress || null,
          feeRole: selectedCet.feeRole || null,
          feeAddress: selectedCet.feeAddress || null,
          dustRole: selectedCet.dustRole || null,
          dustAddress: selectedCet.dustAddress || null,
          locktime: selectedCet.locktime,
          rawTxHex: selectedCet.rawTxHex,
          txid: selectedCet.txid,
          payouts: selectedCet.payouts,
          payoutSats: selectedCet.payoutSats || null,
          residualSats: selectedCet.residualSats || null,
          dustCarrySats: selectedCet.dustCarrySats || null
        }),
    oracleBinding: {
      eventId: oracle.oracle.eventId,
      quorumId: oracle.oracle.quorumId,
      keyId: oracle.oracle.oracleKeyId,
      oracleMapId: oracle.oracle.oracleMapId || null,
      fundingOutpoint: oracle.binding?.fundingOutpoint || cet.fundingOutpoint || null,
      messagePayload: selectedTarget ? selectedTarget.message.payload : null,
      messageDigestHex: selectedTarget ? selectedTarget.message.digestHex : null,
      nonceCommitment: selectedTarget ? selectedTarget.oracleNonceCommitment : null,
      oracleSignaturePlaceholder: selectedTarget ? selectedTarget.oracleSignaturePlaceholder : null,
      adaptorPointPlaceholder: selectedTarget ? selectedTarget.adaptorPointPlaceholder : null,
      adaptorSignaturePlaceholder: selectedTarget ? selectedTarget.adaptorSignaturePlaceholder : null
    },
    deltaPublication: null,
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

  bundle.selectedPath.committedRouting = assertCommittedRouting(bundle.selectedPath, `selected path ${bundle.selectedPath.pathId}`);

  bundle.deltaPublication = buildOracleDeltaPublication({
    oracleBinding: bundle.oracleBinding,
    selectedPath: bundle.selectedPath,
    bundleHash: null,
    deltaSats: bundle.selectedPath.residualSats || bundle.selectedPath.rolloverCollateralSats || bundle.selectedPath.payoutSats || 0n
  });

  bundle.bundleHash = sha256Hex(stringifyJson(bundleHashSnapshot(bundle)));
  bundle.deltaPublication = {
    ...bundle.deltaPublication,
    bundleHash: bundle.bundleHash
  };
  fs.writeFileSync(OUT_PATH, stringifyJson(bundle, true));

  let witness = null;
  if (selectingByPath) {
    const witnessBundle = buildChallengeWitnessBundle({
      challengeBundle: bundle,
      transitionState: {
        epochId: 1n,
        challengeWindowStart: BigInt(bundle.binding?.maturityHeight || 0),
        challengeWindowLength: 6n,
        challengeWindowEnd: BigInt(bundle.binding?.maturityHeight || 0) + 6n
      }
    });
    witness = {
      kind: 'm1_challenge_witness',
      createdAt: new Date().toISOString(),
      sourceChallengeBundlePath: OUT_PATH,
      sourceChallengeBundleHash: bundle.bundleHash,
      route: witnessBundle.route,
      witness: witnessBundle
    };
    witness.artifactHash = sha256Hex(stringifyJson(witness));
    fs.writeFileSync(WITNESS_PATH, stringifyJson(witness, true));
  }

  console.log('=== M1 CET Bundle Selection ===');
  console.log(`path=${selectorLabel}`);
  console.log(`cetTxid=${bundle.selectedPath.txid}`);
  console.log(`messageDigest=${bundle.oracleBinding.messageDigestHex}`);
  console.log(`bundleHash=${bundle.bundleHash}`);
  console.log(`artifactPath=${OUT_PATH}`);
  if (witness) {
    console.log(`witnessRoute=${witness.route}`);
    console.log(`witnessArtifactPath=${WITNESS_PATH}`);
  }
}

try {
  run();
} catch (err) {
  console.error('Bundle generation failed:', err.message);
  process.exit(1);
}
