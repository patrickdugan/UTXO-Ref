const crypto = require('crypto');

function sha256HexUtf8(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function normalizeHex(hex) {
  return String(hex || '').trim().toLowerCase();
}

function leafHashFromTransitionHash(transitionHash) {
  const th = normalizeHex(transitionHash);
  if (!/^[0-9a-f]{64}$/.test(th)) {
    throw new Error('Invalid transition hash for binohash leaf');
  }
  return sha256HexUtf8(`binohash:leaf:${th}`);
}

function parentHash(leftHex, rightHex) {
  const left = normalizeHex(leftHex);
  const right = normalizeHex(rightHex);
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) {
    throw new Error('Invalid binohash parent operands');
  }
  return sha256HexUtf8(`binohash:node:${left}:${right}`);
}

function padIfOdd(level) {
  if (level.length % 2 === 0) return level.slice();
  return [...level, level[level.length - 1]];
}

function rootFromLeaves(leaves) {
  let level = (Array.isArray(leaves) ? leaves : []).map(normalizeHex);
  if (level.length === 0) return '';
  for (const h of level) {
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('Invalid leaf hash');
  }
  while (level.length > 1) {
    const padded = padIfOdd(level);
    const next = [];
    for (let i = 0; i < padded.length; i += 2) {
      next.push(parentHash(padded[i], padded[i + 1]));
    }
    level = next;
  }
  return level[0];
}

function buildProofFromTransitionHashes(transitionHashes, index) {
  const leaves = (Array.isArray(transitionHashes) ? transitionHashes : []).map(leafHashFromTransitionHash);
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error('Invalid transition index for binohash proof');
  }

  const proof = [];
  let idx = index;
  let level = leaves.slice();
  while (level.length > 1) {
    const padded = padIfOdd(level);
    const isRight = idx % 2 === 1;
    const siblingIndex = isRight ? idx - 1 : idx + 1;
    proof.push({
      side: isRight ? 'L' : 'R',
      hash: padded[siblingIndex]
    });

    const next = [];
    for (let i = 0; i < padded.length; i += 2) {
      next.push(parentHash(padded[i], padded[i + 1]));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }

  return {
    root: level[0],
    leaf: leaves[index],
    proof
  };
}

function verifyProof({ transitionHash, root, proof }) {
  const wantRoot = normalizeHex(root);
  if (!/^[0-9a-f]{64}$/.test(wantRoot)) {
    return { valid: false, reason: 'Invalid binohash root format' };
  }

  let acc;
  try {
    acc = leafHashFromTransitionHash(transitionHash);
  } catch (e) {
    return { valid: false, reason: String(e?.message || e || 'invalid leaf') };
  }

  const hops = Array.isArray(proof) ? proof : [];
  for (const hop of hops) {
    const side = String(hop?.side || '').toUpperCase();
    const sib = normalizeHex(hop?.hash || '');
    if (!/^[0-9a-f]{64}$/.test(sib) || (side !== 'L' && side !== 'R')) {
      return { valid: false, reason: 'Invalid binohash proof hop' };
    }
    acc = side === 'L' ? parentHash(sib, acc) : parentHash(acc, sib);
  }

  if (acc !== wantRoot) {
    return { valid: false, reason: 'Binohash proof root mismatch' };
  }
  return { valid: true, leaf: acc };
}

module.exports = {
  leafHashFromTransitionHash,
  parentHash,
  rootFromLeaves,
  buildProofFromTransitionHashes,
  verifyProof
};

