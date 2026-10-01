#!/usr/bin/env node

const {
  SUMMARY_PATH,
  writeAspBitvmReserveBundle
} = require('./asp_bitvm_reserve_bond');

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

try {
  const outPath = argValue('--out', SUMMARY_PATH);
  const { proof } = writeAspBitvmReserveBundle({ outPath });
  console.log(JSON.stringify({
    outPath,
    bundleId: proof.bundleId,
    reserveId: proof.reserveId,
    claimId: proof.claimId,
    challengeId: proof.challengeId,
    selectedViolation: proof.projection.summary.selectedViolation,
    claimedSlashSats: proof.projection.summary.claimedSlashSats,
    verification: proof.verification
  }, null, 2));
} catch (err) {
  console.error(`asp_bitvm_reserve_bond_demo failed: ${err.message}`);
  process.exit(1);
}
