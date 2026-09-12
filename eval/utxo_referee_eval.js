#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  CommitmentPackage,
  PayoutLeaf,
  SweepObject,
  buildTreeWithProofs,
  verifySweep
} = require(path.join(__dirname, '..', 'bitvm3', 'utxo_referee'));

const PROFILES = {
  lite: { mutationRuns: 32, scaleLeaves: 128, scaleProofs: 32 },
  full: { mutationRuns: 512, scaleLeaves: 4096, scaleProofs: 256 },
  scale: { mutationRuns: 10000, scaleLeaves: 32768, scaleProofs: 2048 }
};

function option(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(value => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

const profileName = option('profile', process.env.EVAL_PROFILE || 'full');
const profile = PROFILES[profileName];
if (!profile) {
  throw new Error(`Unknown profile ${profileName}; expected lite, full, or scale`);
}

const jsonOnly = process.argv.includes('--json');
const requirePerfect = process.argv.includes('--require-perfect');
const seed = Number(option('seed', process.env.EVAL_SEED || '12648430')) >>> 0;

function rngFromSeed(initialSeed) {
  let state = initialSeed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

const rng = rngFromSeed(seed);

function scriptFor(id) {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(id >>> 0, 0);
  return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), body, Buffer.from([0x88, 0xac])]);
}

function fixture({ count = 8, amount = 1000n, cap } = {}) {
  const leaves = Array.from({ length: count }, (_, index) => new PayoutLeaf({
    epochId: 41n,
    recipientScriptPubKey: scriptFor(index + 1),
    amountSats: amount + BigInt(index)
  }));
  const built = buildTreeWithProofs(leaves);
  const total = leaves.reduce((sum, leaf) => sum + leaf.amountSats, 0n);
  const commitment = new CommitmentPackage({
    epochId: 41n,
    withdrawalRoot: built.root,
    capSats: cap ?? total + 50000n,
    residualDest: scriptFor(0xf00d)
  });
  return { leaves, proofs: built.proofs, commitment };
}

function payout(leaf, proof) {
  return {
    recipientScriptPubKey: Buffer.from(leaf.recipientScriptPubKey),
    amountSats: leaf.amountSats,
    merkleProof: {
      index: proof.index,
      siblings: proof.siblings.map(value => Buffer.from(value))
    }
  };
}

function sweepFor(commitment, outputs) {
  const total = outputs.reduce((sum, output) => sum + BigInt(output.amountSats), 0n);
  return new SweepObject({
    epochIdCommitted: commitment.epochId,
    payoutOutputs: outputs,
    residualOutput: {
      recipientScriptPubKey: Buffer.from(commitment.residualDest),
      amountSats: commitment.capSats - total
    }
  });
}

function outcome(commitment, sweep) {
  try {
    return { threw: false, result: verifySweep(commitment, sweep) };
  } catch (error) {
    return { threw: true, error: error && error.message ? error.message : String(error) };
  }
}

function accepted(commitment, sweep) {
  const observed = outcome(commitment, sweep);
  return !observed.threw && observed.result && observed.result.ok === true;
}

function rejectedCleanly(commitment, sweep) {
  const observed = outcome(commitment, sweep);
  return !observed.threw && observed.result && observed.result.ok === false;
}

const cases = [];
function check(name, category, points, run) {
  const started = process.hrtime.bigint();
  try {
    const value = run();
    const passed = value === true;
    cases.push({
      name,
      category,
      points,
      passed,
      detail: passed ? undefined : (typeof value === 'string' ? value : 'unexpected verifier result'),
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6
    });
  } catch (error) {
    cases.push({
      name,
      category,
      points,
      passed: false,
      detail: error && error.message ? error.message : String(error),
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6
    });
  }
}

check('accepts a valid complete sweep', 'correctness', 5, () => {
  const f = fixture();
  return accepted(f.commitment, sweepFor(f.commitment, f.leaves.map((leaf, i) => payout(leaf, f.proofs[i]))));
});

check('accepts a valid partial sweep', 'correctness', 3, () => {
  const f = fixture();
  return accepted(f.commitment, sweepFor(f.commitment, [payout(f.leaves[1], f.proofs[1]), payout(f.leaves[6], f.proofs[6])]));
});

check('accepts identical leaves at distinct committed positions', 'correctness', 3, () => {
  const shared = { epochId: 41n, recipientScriptPubKey: scriptFor(7), amountSats: 777n };
  const leaves = [new PayoutLeaf(shared), new PayoutLeaf(shared)];
  const built = buildTreeWithProofs(leaves);
  const commitment = new CommitmentPackage({
    epochId: 41n,
    withdrawalRoot: built.root,
    capSats: 2000n,
    residualDest: scriptFor(99)
  });
  return accepted(commitment, sweepFor(commitment, [payout(leaves[0], built.proofs[0]), payout(leaves[1], built.proofs[1])]));
});

check('rejects an epoch substitution', 'binding', 4, () => {
  const f = fixture();
  const sweep = sweepFor(f.commitment, [payout(f.leaves[0], f.proofs[0])]);
  sweep.epochIdCommitted += 1n;
  return rejectedCleanly(f.commitment, sweep);
});

check('rejects a payout amount mutation', 'membership', 5, () => {
  const f = fixture();
  const output = payout(f.leaves[0], f.proofs[0]);
  output.amountSats += 1n;
  return rejectedCleanly(f.commitment, sweepFor(f.commitment, [output]));
});

check('rejects a recipient mutation', 'membership', 5, () => {
  const f = fixture();
  const output = payout(f.leaves[0], f.proofs[0]);
  output.recipientScriptPubKey[5] ^= 1;
  return rejectedCleanly(f.commitment, sweepFor(f.commitment, [output]));
});

check('rejects a sibling mutation', 'membership', 5, () => {
  const f = fixture();
  const output = payout(f.leaves[0], f.proofs[0]);
  output.merkleProof.siblings[0][0] ^= 1;
  return rejectedCleanly(f.commitment, sweepFor(f.commitment, [output]));
});

check('rejects cap overflow', 'conservation', 5, () => {
  const f = fixture({ cap: 10n });
  const output = payout(f.leaves[0], f.proofs[0]);
  const sweep = new SweepObject({
    epochIdCommitted: f.commitment.epochId,
    payoutOutputs: [output],
    residualOutput: { recipientScriptPubKey: f.commitment.residualDest, amountSats: 0n }
  });
  return rejectedCleanly(f.commitment, sweep);
});

check('rejects a residual amount mutation', 'conservation', 4, () => {
  const f = fixture();
  const sweep = sweepFor(f.commitment, [payout(f.leaves[0], f.proofs[0])]);
  sweep.residualOutput.amountSats += 1n;
  return rejectedCleanly(f.commitment, sweep);
});

check('rejects a residual destination mutation', 'conservation', 4, () => {
  const f = fixture();
  const sweep = sweepFor(f.commitment, [payout(f.leaves[0], f.proofs[0])]);
  sweep.residualOutput.recipientScriptPubKey[0] ^= 1;
  return rejectedCleanly(f.commitment, sweep);
});

check('rejects a repeated Merkle position', 'replay', 12, () => {
  const f = fixture({ count: 2, amount: 100n, cap: 1000n });
  const same = payout(f.leaves[0], f.proofs[0]);
  return rejectedCleanly(f.commitment, sweepFor(f.commitment, [same, payout(f.leaves[0], f.proofs[0])]));
});

check('rejects many replays of one authorized payout', 'replay', 10, () => {
  const f = fixture({ count: 1, amount: 1n, cap: 100n });
  const outputs = Array.from({ length: 100 }, () => payout(f.leaves[0], f.proofs[0]));
  return rejectedCleanly(f.commitment, sweepFor(f.commitment, outputs));
});

check('rejects an index with ignored high bits', 'proof-shape', 8, () => {
  const f = fixture();
  const output = payout(f.leaves[0], f.proofs[0]);
  output.merkleProof.index += 2 ** output.merkleProof.siblings.length;
  return rejectedCleanly(f.commitment, sweepFor(f.commitment, [output]));
});

check('rejects a fractional proof index', 'proof-shape', 4, () => {
  const f = fixture();
  const output = payout(f.leaves[0], f.proofs[0]);
  output.merkleProof.index += 0.5;
  return rejectedCleanly(f.commitment, sweepFor(f.commitment, [output]));
});

check('rejects a string proof index', 'proof-shape', 4, () => {
  const f = fixture();
  const output = payout(f.leaves[0], f.proofs[0]);
  output.merkleProof.index = String(output.merkleProof.index);
  return rejectedCleanly(f.commitment, sweepFor(f.commitment, [output]));
});

check('rejects malformed siblings without throwing', 'robustness', 5, () => {
  const f = fixture();
  const sweep = sweepFor(f.commitment, [payout(f.leaves[0], f.proofs[0])]);
  sweep.payoutOutputs[0].merkleProof.siblings = Buffer.alloc(32);
  return rejectedCleanly(f.commitment, sweep);
});

check('rejects a negative payout without throwing', 'robustness', 4, () => {
  const f = fixture();
  const sweep = sweepFor(f.commitment, [payout(f.leaves[0], f.proofs[0])]);
  sweep.payoutOutputs[0].amountSats = -1n;
  return rejectedCleanly(f.commitment, sweep);
});

check(`rejects ${profile.mutationRuns} seeded proof and leaf mutations`, 'fuzz', 5, () => {
  const f = fixture({ count: 64 });
  for (let i = 0; i < profile.mutationRuns; i++) {
    const index = Math.floor(rng() * f.leaves.length);
    const output = payout(f.leaves[index], f.proofs[index]);
    switch (i % 3) {
      case 0:
        output.amountSats += BigInt(1 + Math.floor(rng() * 1000));
        break;
      case 1:
        output.recipientScriptPubKey[Math.floor(rng() * output.recipientScriptPubKey.length)] ^= 1 << Math.floor(rng() * 8);
        break;
      default: {
        const sibling = output.merkleProof.siblings[Math.floor(rng() * output.merkleProof.siblings.length)];
        sibling[Math.floor(rng() * sibling.length)] ^= 1 << Math.floor(rng() * 8);
      }
    }
    if (!rejectedCleanly(f.commitment, sweepFor(f.commitment, [output]))) {
      return `mutation ${i} was accepted or crashed`;
    }
  }
  return true;
});

check(`verifies ${profile.scaleProofs} proofs from a ${profile.scaleLeaves}-leaf tree`, 'scale', 5, () => {
  const f = fixture({ count: profile.scaleLeaves, amount: 1n });
  for (let i = 0; i < profile.scaleProofs; i++) {
    const index = Math.floor((i * f.leaves.length) / profile.scaleProofs);
    if (!accepted(f.commitment, sweepFor(f.commitment, [payout(f.leaves[index], f.proofs[index])]))) {
      return `valid scale proof ${index} failed`;
    }
  }
  return true;
});

const earned = cases.filter(test => test.passed).reduce((sum, test) => sum + test.points, 0);
const possible = cases.reduce((sum, test) => sum + test.points, 0);
const score = earned / possible;
const report = {
  benchmark: 'utxo-referee-adversarial',
  version: 1,
  profile: profileName,
  seed,
  score,
  points: { earned, possible },
  passed: cases.filter(test => test.passed).length,
  failed: cases.filter(test => !test.passed).length,
  cases
};

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  console.log(`UTXO Referee adversarial eval (${profileName}, seed ${seed})`);
  for (const test of cases) {
    const mark = test.passed ? 'PASS' : 'FAIL';
    console.log(`${mark.padEnd(4)} ${String(test.points).padStart(2)}  [${test.category}] ${test.name}`);
    if (!test.passed && test.detail) console.log(`         ${test.detail}`);
  }
  console.log(`\nscore: ${score.toFixed(6)}`);
  console.log(`passed: ${report.passed}`);
  console.log(`failed: ${report.failed}`);
  console.log(`points: ${earned}/${possible}`);
}

if (requirePerfect && report.failed !== 0) process.exitCode = 1;
