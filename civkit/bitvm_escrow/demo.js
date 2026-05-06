const escrow = require('./index');
const tinysecp = require('../../node-dlc/packages/messaging/node_modules/tiny-secp256k1');

function makeSpk(byte) {
  return Buffer.concat([Buffer.from([0x00, 0x14]), Buffer.alloc(20, byte)]);
}

function makeXOnlyPubkey(byte) {
  const scalar = Buffer.alloc(32, 0);
  scalar[31] = byte;
  const point = tinysecp.pointFromScalar(scalar, true);
  return point.slice(1, 33);
}

function describePayouts(settlement) {
  return settlement.payouts
    .map((payout) => `${payout.role}:${payout.amountSats}`)
    .join(', ');
}

console.log('=== CivKit BitVM Escrow Demo ===\n');

const order = new escrow.EscrowOrder({
  orderId: 'nostr-order-0001',
  epochId: 7001n,
  escrowAmountSats: 210000n,
  sellerPayoutScriptPubKey: makeSpk(0x11),
  buyerRefundScriptPubKey: makeSpk(0x22),
  serviceFeeScriptPubKey: makeSpk(0x33),
  serviceFeeSats: 2000n,
  resolverFeeScriptPubKey: makeSpk(0x44),
  expiryBlock: 900000n,
  residualDest: makeSpk(0x55)
});

console.log(`Order hash: ${order.hash().toString('hex')}`);
console.log(`Escrow amount: ${order.escrowAmountSats} sats`);
console.log('');

const release = escrow.verifyEscrowSettlement(order, {
  route: 'release',
  decisionId: 'release-after-cash-confirmation'
});

if (!release.ok) {
  throw new Error(release.reason);
}

console.log('Release route:');
console.log(`  decision hash: ${release.settlement.decisionHash.toString('hex')}`);
console.log(`  payouts: ${describePayouts(release.settlement)}`);
console.log(`  withdrawal root: ${release.settlement.root.toString('hex')}`);
console.log('');

const split = escrow.verifyEscrowSettlement(order, {
  route: 'split',
  sellerAmountSats: 140000n,
  buyerAmountSats: 66000n,
  resolverFeeSats: 2000n,
  decisionId: 'dispute-split-1'
}, {
  currentBlock: 900010n
});

if (!split.ok) {
  throw new Error(split.reason);
}

console.log('Split route:');
console.log(`  decision hash: ${split.settlement.decisionHash.toString('hex')}`);
console.log(`  payouts: ${describePayouts(split.settlement)}`);
console.log(`  sweep valid: ${split.settlement.verification.ok}`);
console.log('');

const earlyRefund = escrow.verifyEscrowSettlement(order, {
  route: 'refund',
  decisionId: 'timeout-refund'
}, {
  currentBlock: 899999n
});

console.log('Refund before expiry:');
console.log(`  ok: ${earlyRefund.ok}`);
console.log(`  reason: ${earlyRefund.reason}`);
console.log('');

const refund = escrow.verifyEscrowSettlement(order, {
  route: 'refund',
  decisionId: 'timeout-refund'
}, {
  currentBlock: 900100n
});

if (!refund.ok) {
  throw new Error(refund.reason);
}

console.log('Refund after expiry:');
console.log(`  payouts: ${describePayouts(refund.settlement)}`);
console.log('');

const onchain = escrow.buildEscrowSpendPackage({
  orderLike: order,
  decisionLike: {
    route: 'split',
    sellerAmountSats: 201000n,
    buyerAmountSats: 0n,
    resolverFeeSats: 7000n,
    decisionId: 'dispute-split-onchain'
  },
  keyset: {
    releasePubkey: makeXOnlyPubkey(1),
    refundPubkey: makeXOnlyPubkey(2),
    notaryPubkey: makeXOnlyPubkey(3)
  },
  fundingOutpoint: {
    txid: '33'.repeat(32),
    vout: 0,
    valueSats: order.escrowAmountSats
  },
  authorizationMode: escrow.AUTHORIZATION_MODES.threshold2of3,
  signerSet: {
    buyerSigned: true,
    sellerSigned: false,
    notarySigned: true
  },
  commitmentType: escrow.COMMITMENT_TYPES.transition,
  network: 'regtest'
});

console.log('On-chain package:');
console.log(`  taproot address: ${onchain.taproot.address}`);
console.log(`  selected leaf: ${onchain.psbt.selectedLeaf.name}`);
console.log(`  commitment type: ${onchain.commitmentType}`);
console.log(`  txid: ${onchain.txTemplate.txId}`);
console.log(`  commitment anchor: ${onchain.txTemplate.commitmentAnchor.hashHex}`);
console.log(`  witness stack: ${onchain.authorization.witnessPlan.witnessStack.join(', ')}`);
console.log(`  psbt bytes: ${Buffer.from(onchain.psbt.base64, 'base64').length}`);
console.log('');

const bitvmBundle = escrow.buildEscrowBitvmChallengeBundle(
  order,
  {
    route: 'release',
    decisionId: 'release-bitvm-transition'
  },
  {
    signerSet: {
      buyerSigned: true,
      sellerSigned: true,
      notarySigned: false
    }
  }
);

console.log('BitVM transition bundle:');
console.log(`  route: ${bitvmBundle.route}`);
console.log(`  verification: ${bitvmBundle.verification.ok}`);
console.log(`  transition commitment: ${bitvmBundle.binding.transitionCommitmentHashHex}`);
console.log('');

const circuit = escrow.generateEscrowCircuit({
  maxPayouts: 4,
  merkleDepth: 4
});

console.log('Circuit stats:');
console.log(`  total gates: ${circuit.stats.totalGates}`);
console.log(`  input bits: ${circuit.stats.inputBits}`);
console.log(`  output bits: ${circuit.stats.outputBits}`);
console.log('');
console.log('Note: the inherited BitVM circuit still uses a placeholder in-circuit hash.');

const transitionCircuit = escrow.generateEscrowBitvmCircuit({
  splitRequiresNotary: true
});

console.log('');
console.log('Escrow transition circuit stats:');
console.log(`  total gates: ${transitionCircuit.stats.totalGates}`);
console.log(`  input bits: ${transitionCircuit.stats.inputBits}`);
console.log(`  output bits: ${transitionCircuit.stats.outputBits}`);
