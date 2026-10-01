const crypto = require('crypto');

const HASH_BITS = 256;
const WORD_BITS = 32;
const BLOCK_BITS = 512;

const INITIAL_STATE = [
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19
];

const ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

const PAIR_PADDING_BLOCK = (() => {
  const block = Buffer.alloc(BLOCK_BITS / 8);
  block[0] = 0x80;
  block[62] = 0x02;
  block[63] = 0x00;
  return block;
})();

function sha256Pair(left, right) {
  return crypto.createHash('sha256').update(Buffer.concat([left, right])).digest();
}

function bufferToBits(buf, width = buf.length * 8) {
  const bits = [];
  for (let i = 0; i < buf.length && bits.length < width; i++) {
    for (let j = 0; j < 8 && bits.length < width; j++) {
      bits.push((buf[i] >> j) & 1);
    }
  }
  while (bits.length < width) bits.push(0);
  return bits;
}

function bitsToBuffer(bits) {
  const buf = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      buf[Math.floor(i / 8)] |= 1 << (i % 8);
    }
  }
  return buf;
}

function toWordBits(chunkBits) {
  if (chunkBits.length !== WORD_BITS) {
    throw new Error(`Expected ${WORD_BITS} chunk bits, got ${chunkBits.length}`);
  }

  return [
    ...chunkBits.slice(24, 32),
    ...chunkBits.slice(16, 24),
    ...chunkBits.slice(8, 16),
    ...chunkBits.slice(0, 8)
  ];
}

function fromWordBits(wordBits) {
  if (wordBits.length !== WORD_BITS) {
    throw new Error(`Expected ${WORD_BITS} word bits, got ${wordBits.length}`);
  }

  return [
    ...wordBits.slice(24, 32),
    ...wordBits.slice(16, 24),
    ...wordBits.slice(8, 16),
    ...wordBits.slice(0, 8)
  ];
}

function blockBitsToWords(blockBits) {
  if (blockBits.length !== BLOCK_BITS) {
    throw new Error(`Expected ${BLOCK_BITS} block bits, got ${blockBits.length}`);
  }

  const words = [];
  for (let offset = 0; offset < BLOCK_BITS; offset += WORD_BITS) {
    words.push(toWordBits(blockBits.slice(offset, offset + WORD_BITS)));
  }
  return words;
}

function wordsToDigestBits(words) {
  return words.flatMap(fromWordBits);
}

function rotr(wordBits, shift) {
  return wordBits.map((_, i) => wordBits[(i + shift) % WORD_BITS]);
}

function shr(circuit, wordBits, shift) {
  return wordBits.map((_, i) => (i + shift < WORD_BITS ? wordBits[i + shift] : circuit.zero()));
}

function xorWords(circuit, ...words) {
  return words.reduce((acc, word) => circuit.xorN(acc, word));
}

function addWords(circuit, ...words) {
  let sum = words[0];
  for (let i = 1; i < words.length; i++) {
    sum = circuit.addN(sum, words[i]).sum;
  }
  return sum;
}

function choose(circuit, x, y, z) {
  return x.map((bit, i) => {
    const xy = circuit.and(bit, y[i]);
    const notXz = circuit.and(circuit.inv(bit), z[i]);
    return circuit.xor(xy, notXz);
  });
}

function majority(circuit, x, y, z) {
  return x.map((_, i) => {
    const xy = circuit.and(x[i], y[i]);
    const xz = circuit.and(x[i], z[i]);
    const yz = circuit.and(y[i], z[i]);
    return circuit.xor(circuit.xor(xy, xz), yz);
  });
}

function bigSigma0(circuit, wordBits) {
  return xorWords(circuit, rotr(wordBits, 2), rotr(wordBits, 13), rotr(wordBits, 22));
}

function bigSigma1(circuit, wordBits) {
  return xorWords(circuit, rotr(wordBits, 6), rotr(wordBits, 11), rotr(wordBits, 25));
}

function smallSigma0(circuit, wordBits) {
  return xorWords(circuit, rotr(wordBits, 7), rotr(wordBits, 18), shr(circuit, wordBits, 3));
}

function smallSigma1(circuit, wordBits) {
  return xorWords(circuit, rotr(wordBits, 17), rotr(wordBits, 19), shr(circuit, wordBits, 10));
}

function constantWordBits(circuit, value) {
  return circuit.constantBits(value >>> 0, WORD_BITS);
}

function sha256CompressCircuit(circuit, stateWords, blockBits) {
  const schedule = blockBitsToWords(blockBits);

  for (let i = 16; i < 64; i++) {
    schedule.push(addWords(
      circuit,
      smallSigma1(circuit, schedule[i - 2]),
      schedule[i - 7],
      smallSigma0(circuit, schedule[i - 15]),
      schedule[i - 16]
    ));
  }

  let [a, b, c, d, e, f, g, h] = stateWords.map(word => word.slice());

  for (let i = 0; i < 64; i++) {
    const t1 = addWords(
      circuit,
      h,
      bigSigma1(circuit, e),
      choose(circuit, e, f, g),
      constantWordBits(circuit, ROUND_CONSTANTS[i]),
      schedule[i]
    );
    const t2 = addWords(circuit, bigSigma0(circuit, a), majority(circuit, a, b, c));

    h = g;
    g = f;
    f = e;
    e = addWords(circuit, d, t1);
    d = c;
    c = b;
    b = a;
    a = addWords(circuit, t1, t2);
  }

  return [
    addWords(circuit, stateWords[0], a),
    addWords(circuit, stateWords[1], b),
    addWords(circuit, stateWords[2], c),
    addWords(circuit, stateWords[3], d),
    addWords(circuit, stateWords[4], e),
    addWords(circuit, stateWords[5], f),
    addWords(circuit, stateWords[6], g),
    addWords(circuit, stateWords[7], h)
  ];
}

function sha256PairCircuit(circuit, leftBits, rightBits) {
  if (leftBits.length !== HASH_BITS || rightBits.length !== HASH_BITS) {
    throw new Error('sha256PairCircuit expects two 256-bit inputs');
  }

  const initialState = INITIAL_STATE.map(value => constantWordBits(circuit, value));
  const firstBlock = leftBits.concat(rightBits);
  const secondBlock = bufferToBits(PAIR_PADDING_BLOCK, BLOCK_BITS).map(bit => (bit ? circuit.one() : circuit.zero()));
  const midState = sha256CompressCircuit(circuit, initialState, firstBlock);
  const finalState = sha256CompressCircuit(circuit, midState, secondBlock);
  return wordsToDigestBits(finalState);
}

module.exports = {
  HASH_BITS,
  WORD_BITS,
  sha256Pair,
  bufferToBits,
  bitsToBuffer,
  sha256PairCircuit
};
