/**
 * Milestone 1 Challenge Witness Summary
 *
 * Loads the latest challenge bundle artifact and prints a compact witness
 * summary for the selected route.
 *
 * Run:
 *   node bitvm3/utxo_referee/m1_challenge_witness_summary.js
 */

const fs = require('fs');
const path = require('path');
const referee = require('./index');

const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const BUNDLE_PATH = path.join(ARTIFACTS_DIR, 'm1_challenge_bundle_latest.json');

function ensureFile(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing artifact: ${p}`);
  }
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function pickRouteLabel(bundle) {
  return bundle.selectedPathId || bundle.selectedPath?.pathId || 'roll';
}

function run() {
  ensureFile(BUNDLE_PATH);
  const bundle = loadJson(BUNDLE_PATH);
  const route = pickRouteLabel(bundle);
  const built = referee.buildChallengeWitnessBundle({
    challengeBundle: bundle,
    transitionState: {
      epochId: 1n,
      challengeWindowStart: 1n,
      challengeWindowLength: 6n,
      challengeWindowEnd: 7n
    }
  });

  const summary = {
    route,
    requiresOracle: built.requiresOracle,
    collateralSats: built.transitionState.collateralSats.toString(),
    actualPayoutSats: built.transitionState.actualPayoutSats.toString(),
    feeSats: built.transitionState.feeSats.toString(),
    refundSats: built.transitionState.refundSats.toString(),
    rolloverCollateralSats: built.transitionState.rolloverCollateralSats.toString(),
    bucketCapBps: built.transitionState.bucketCapBps.toString(),
    realizedPnlBps: built.transitionState.realizedPnlBps.toString(),
    effectivePnlBps: built.transitionState.effectivePnlBps.toString(),
    feeBps: built.transitionState.feeBps.toString(),
    oracleMessageDigestHex: built.honestPath.oracleMessageDigestHex,
    oracleSignature: built.honestPath.oracleSignature,
    cetPreimageOrSig: built.honestPath.cetPreimageOrSig,
    routeBits: {
      flat: built.transitionWitness.routeFlat,
      pnl: built.transitionWitness.routePnl,
      settleLoss: built.transitionWitness.routeSettleLoss,
      settleGain: built.transitionWitness.routeSettleGain,
      roll: built.transitionWitness.routeRoll
    }
  };

  console.log(JSON.stringify(summary, null, 2));
}

try {
  run();
} catch (err) {
  console.error('Witness summary failed:', err.message);
  process.exit(1);
}
