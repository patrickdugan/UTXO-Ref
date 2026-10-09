#!/usr/bin/env node

const {
  SUMMARY_PATH,
  writeShinigamiVirtualCetBundle
} = require('./shinigami_virtual_cet_ark');

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

try {
  const outPath = argValue('--out', SUMMARY_PATH);
  const outcomeCount = Number(argValue('--outcomes', '17'));
  const { proof } = writeShinigamiVirtualCetBundle({
    outPath,
    outcomeCount
  });

  console.log(JSON.stringify({
    outPath,
    bundleId: proof.bundleId,
    claimId: proof.claimId,
    receiptId: proof.receiptId,
    virtualCetCount: proof.projection.summary.virtualCetCount,
    materializedCetCount: proof.projection.summary.materializedCetCount,
    verification: proof.verification
  }, null, 2));
} catch (err) {
  console.error(`shinigami_virtual_cet_ark_demo failed: ${err.message}`);
  process.exit(1);
}
