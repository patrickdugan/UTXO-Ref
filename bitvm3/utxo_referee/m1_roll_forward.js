/**
 * Milestone 1 - Roll Forward Artifact
 *
 * Consumes the latest funded settlement artifact and emits a deterministic
 * next-epoch handoff object that carries forward the dust remainder.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_roll_forward.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DRAFT_PATH = path.join(ARTIFACTS_DIR, 'm1_dlc_draft_latest.json');
const FUNDED_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_psbt_latest.json');
const FINAL_PATH = path.join(ARTIFACTS_DIR, 'm1_funding_finalized_latest.json');
const OUT_PATH = path.join(ARTIFACTS_DIR, 'm1_roll_forward_latest.json');

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function ensureFile(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing artifact: ${p}`);
  }
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function pickLatestSettlement() {
  ensureFile(DRAFT_PATH);
  ensureFile(FUNDED_PATH);
  const draft = loadJson(DRAFT_PATH);
  const funded = loadJson(FUNDED_PATH);
  const finalized = fs.existsSync(FINAL_PATH) ? loadJson(FINAL_PATH) : null;
  const settlement = funded.settlement || draft.contract?.settlement;
  const fundingOutpoint = funded.funding?.fundingOutpoint || funded.fundingOutpoint || null;

  if (!settlement || !settlement.roll) {
    throw new Error('No settlement roll path available to forward');
  }
  if (!fundingOutpoint) {
    throw new Error('Funded artifact missing funding outpoint');
  }

  const epochId = BigInt(draft.canonical.epochId || '1');
  const nextEpochId = epochId + 1n;
  const rollLocktime = Number(settlement.roll.rollLocktime || draft.contract.refundLocktime || 0);
  const rollPayouts = settlement.roll.payouts || {};
  const dustCarrySats = BigInt(settlement.dustCarrySats || rollPayouts.dustCarrySats || '0');
  const rolloverCollateralSats = BigInt(rollPayouts.rolloverCollateralSats || '0');
  const settlePaths = Array.isArray(settlement.paths)
    ? settlement.paths
        .filter(pathEntry => pathEntry && pathEntry.kind === 'settlement' && typeof pathEntry.pathId === 'string')
        .map(pathEntry => pathEntry.pathId)
    : [];
  const timeoutPath = settlement.roll.pathId || 'roll';

  return {
    kind: 'm1_roll_forward',
    createdAt: new Date().toISOString(),
    sourceArtifacts: {
      draftPath: DRAFT_PATH,
      fundedPath: FUNDED_PATH,
      finalizedPath: FINAL_PATH,
      draftHash: sha256Hex(JSON.stringify(draft)),
      fundedHash: sha256Hex(JSON.stringify(funded)),
      finalizedHash: finalized ? sha256Hex(JSON.stringify(finalized)) : null
    },
    currentEpoch: {
      epochId: epochId.toString(),
      fundingTxid: fundingOutpoint.txid,
      fundingVout: fundingOutpoint.vout,
      rollLocktime,
      dustCarrySats: dustCarrySats.toString(),
      rolloverCollateralSats: rolloverCollateralSats.toString()
    },
    nextEpoch: {
      epochId: nextEpochId.toString(),
      inheritedCollateralSats: rolloverCollateralSats.toString(),
      inheritedDustCarrySats: dustCarrySats.toString(),
      defaultAction: 'roll'
    },
    routing: {
      timeoutPath,
      settlePaths,
      routerSemantics: 'non-interactive expiry defaults to roll-forward'
    }
  };
}

function run() {
  const artifact = pickLatestSettlement();
  artifact.artifactHash = sha256Hex(JSON.stringify(artifact));
  fs.writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 2));

  console.log('=== M1 Roll Forward ===');
  console.log(`epochId=${artifact.currentEpoch.epochId}`);
  console.log(`nextEpochId=${artifact.nextEpoch.epochId}`);
  console.log(`dustCarrySats=${artifact.currentEpoch.dustCarrySats}`);
  console.log(`rolloverCollateralSats=${artifact.currentEpoch.rolloverCollateralSats}`);
  console.log(`artifactHash=${artifact.artifactHash}`);
  console.log(`artifactPath=${OUT_PATH}`);
}

try {
  run();
} catch (err) {
  console.error('Roll forward generation failed:', err.message);
  process.exit(1);
}
