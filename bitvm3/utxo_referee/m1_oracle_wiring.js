/**
 * Milestone 1 - Oracle/Adaptor Wiring Placeholder Generator
 *
 * Produces challenge-path-ready placeholder artifacts that bind
 * oracle attestations and adaptor-signature slots to CET skeleton txids.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_oracle_wiring.js
 *
 * Optional env:
 *   ORACLE_EVENT_ID=<custom-id>
 *   ORACLE_KEY_ID=<oracle-key-id>
 *   ORACLE_QUORUM_ID=<quorum-id>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const CET_PATH = path.join(ARTIFACTS_DIR, 'm1_cet_skeletons_latest.json');
const FUNDING_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_oracle_wiring_latest.json');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function ensureFile(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`Required artifact missing: ${p}`);
  }
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeOutcomeMessage(eventId, fundingOutpoint, cet) {
  const payload = [
    'm1_oracle_attestation_v1',
    eventId,
    fundingOutpoint.txid,
    String(fundingOutpoint.vout),
    String(cet.bucketPct),
    cet.txid,
    String(cet.locktime)
  ].join('|');

  return {
    payload,
    digestHex: sha256Hex(payload)
  };
}

function buildPlaceholders({ funding, cets }) {
  const timestamp = Date.now();
  const eventId = process.env.ORACLE_EVENT_ID || `m1_oracle_event_${timestamp}`;
  const oracleKeyId = process.env.ORACLE_KEY_ID || 'oracle_key_tl_wallet_placeholder';
  const quorumId = process.env.ORACLE_QUORUM_ID || 'quorum_1of1_placeholder';

  const attestationTargets = cets.cets.cets.map(cet => {
    const msg = makeOutcomeMessage(eventId, cets.fundingOutpoint, cet);
    return {
      bucketPct: cet.bucketPct,
      cetTxid: cet.txid,
      locktime: cet.locktime,
      message: msg,
      oracleNonceCommitment: `nonce_commitment_for_${cet.bucketPct}`,
      oracleSignaturePlaceholder: `oracle_sig_for_${cet.bucketPct}`,
      adaptorPointPlaceholder: `adaptor_point_for_${cet.bucketPct}`,
      adaptorSignaturePlaceholder: `adaptor_sig_for_${cet.bucketPct}`
    };
  });

  return {
    kind: 'm1_oracle_wiring',
    createdAt: new Date().toISOString(),
    sourceArtifacts: {
      fundingPsbt: FUNDING_PATH,
      cetSkeletons: CET_PATH,
      fundingHash: sha256Hex(JSON.stringify(funding)),
      cetHash: sha256Hex(JSON.stringify(cets))
    },
    oracle: {
      eventId,
      oracleKeyId,
      quorumId,
      network: funding.chain.network,
      rpcUrl: funding.chain.rpcUrl
    },
    binding: {
      fundingOutpoint: funding.funding.fundingOutpoint,
      maturityHeight: cets.cets.maturityHeight,
      refundLocktime: cets.cets.refundLocktime
    },
    attestationTargets,
    challengePathPlaceholders: {
      honestSweepEvidence: {
        required: ['commitmentPackage', 'selectedBucket', 'oracleSignature', 'cetTxid'],
        notes: 'Assemble these fields into witness payload when challenge path is wired.'
      },
      challengedSweepEvidence: {
        required: ['conflictingSweep', 'attestationDigest', 'oracleSignature', 'merkleProofSet'],
        notes: 'Use this bundle to redirect to arbitration path.'
      }
    }
  };
}

function run() {
  ensureFile(FUNDING_PATH);
  ensureFile(CET_PATH);

  const funding = loadJson(FUNDING_PATH);
  const cets = loadJson(CET_PATH);
  const artifact = buildPlaceholders({ funding, cets });
  artifact.artifactHash = sha256Hex(JSON.stringify(artifact));

  fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));

  console.log('=== M1 Oracle Wiring Placeholders ===');
  console.log(`eventId=${artifact.oracle.eventId}`);
  console.log(`targets=${artifact.attestationTargets.length}`);
  console.log(`fundingOutpoint=${artifact.binding.fundingOutpoint.txid}:${artifact.binding.fundingOutpoint.vout}`);
  console.log(`artifactHash=${artifact.artifactHash}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

try {
  run();
} catch (err) {
  console.error('Oracle wiring generation failed:', err.message);
  process.exit(1);
}

