const crypto = require('crypto');
const bitcoin = require('../../node-dlc/packages/messaging/node_modules/bitcoinjs-lib/src');
const BigInteger = require('../../node-dlc/packages/messaging/node_modules/bigi');
const ecurve = require('../../node-dlc/packages/messaging/node_modules/ecurve');
const schnorrConvert = require('../../node-dlc/packages/messaging/node_modules/bip-schnorr/src/convert');
const schnorrMath = require('../../node-dlc/packages/messaging/node_modules/bip-schnorr/src/math');
const { buildEscrowSettlement } = require('./projector');
const { buildEscrowBitvmChallengeBundle, normalizeSignerSet } = require('./bitvm_transition');

const curve = ecurve.getCurveByName('secp256k1');
const two = BigInteger.valueOf(2);

const taprootEccAdapter = {
  isXOnlyPoint(pubkey) {
    try {
      schnorrMath.liftX(pubkey);
      return true;
    } catch (error) {
      return false;
    }
  },
  xOnlyPointAddTweak(pubkey, tweak) {
    try {
      const point = schnorrMath.liftX(pubkey);
      const tweakInt = schnorrConvert.bufferToInt(tweak);
      if (tweakInt.compareTo(curve.n) >= 0) {
        return null;
      }

      const result = point.add(curve.G.multiply(tweakInt));
      if (curve.isInfinity(result)) {
        return null;
      }

      return {
        parity: result.affineY.mod(two).equals(BigInteger.ZERO) ? 0 : 1,
        xOnlyPubkey: schnorrConvert.intToBuffer(result.affineX)
      };
    } catch (error) {
      return null;
    }
  }
};

bitcoin.initEccLib(taprootEccAdapter);

const DEFAULT_SCRIPT_ONLY_INTERNAL_KEY = Buffer.from(
  '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  'hex'
);
const TAPLEAF_VERSION = 0xc0;
const ROUTE_TO_AUTHORIZATION_PATH = Object.freeze({
  release: 'release_approval',
  refund: 'refund_approval',
  split: 'dispute_resolution'
});
const AUTHORIZATION_MODES = Object.freeze({
  routeSpecific: 'route_specific',
  threshold2of3: 'threshold_2_of_3'
});
const COMMITMENT_TYPES = Object.freeze({
  settlement: 'settlement',
  transition: 'transition'
});
const CUSTOM_NETWORKS = Object.freeze({
  litecoin: Object.freeze({
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: {
      public: 0x0488b2e4,
      private: 0x0488ade4
    },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
  }),
  'litecoin-testnet': Object.freeze({
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'tltc',
    bip32: {
      public: 0x043587cf,
      private: 0x04358394
    },
    pubKeyHash: 0x6f,
    scriptHash: 0x3a,
    wif: 0xef
  })
});

function normalizeNetwork(network) {
  if (typeof network === 'object' && network != null) {
    return network;
  }

  switch (String(network || 'regtest').toLowerCase()) {
    case 'bitcoin':
    case 'mainnet':
      return bitcoin.networks.bitcoin;
    case 'testnet':
      return bitcoin.networks.testnet;
    case 'regtest':
      return bitcoin.networks.regtest;
    case 'litecoin':
    case 'ltc':
      return CUSTOM_NETWORKS.litecoin;
    case 'litecoin-testnet':
    case 'ltc-testnet':
    case 'litecoin_testnet':
    case 'ltctestnet':
    case 'tltc':
      return CUSTOM_NETWORKS['litecoin-testnet'];
    default:
      throw new Error(`Unsupported bitcoin network: ${network}`);
  }
}

function asBuffer(value, label) {
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error(`${label} must be a Buffer or hex string`);
    }
    return Buffer.from(hex, 'hex');
  }
  throw new Error(`${label} must be a Buffer or hex string`);
}

function toXOnlyPubkey(value, label) {
  const pubkey = asBuffer(value, label);
  if (pubkey.length === 32) {
    return pubkey;
  }
  if (pubkey.length === 33) {
    return pubkey.slice(1, 33);
  }
  throw new Error(`${label} must be a 32-byte x-only or 33-byte compressed pubkey`);
}

function maybeXOnlyPubkey(value, fallback, label) {
  if (value == null) {
    return fallback == null ? null : toXOnlyPubkey(fallback, label);
  }
  return toXOnlyPubkey(value, label);
}

function toUInt32(value, label) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 0xffffffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer`);
  }
  return normalized;
}

function toSafeSats(value, label) {
  const normalized = BigInt(value);
  if (normalized < 0n || normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is out of range for bitcoinjs-lib number encoding`);
  }
  return Number(normalized);
}

function buildLeaf(name, output, metadata = {}) {
  return {
    name,
    leafVersion: TAPLEAF_VERSION,
    output,
    outputHex: output.toString('hex'),
    asm: bitcoin.script.toASM(output),
    ...metadata
  };
}

function buildBinaryTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new Error('At least one tapleaf is required');
  }
  if (leaves.length === 1) {
    return leaves[0];
  }

  const nextLevel = [];
  for (let i = 0; i < leaves.length; i += 2) {
    if (i + 1 < leaves.length) {
      nextLevel.push([leaves[i], leaves[i + 1]]);
    } else {
      nextLevel.push(leaves[i]);
    }
  }
  return buildBinaryTree(nextLevel);
}

function deriveEscrowCommitmentHash(settlement) {
  return crypto.createHash('sha256')
    .update(settlement.orderHash)
    .update(settlement.decisionHash)
    .update(settlement.commitment.hash())
    .digest();
}

function normalizeCommitmentType(value) {
  const normalized = String(value || COMMITMENT_TYPES.settlement).trim().toLowerCase();
  if (
    normalized !== COMMITMENT_TYPES.settlement &&
    normalized !== COMMITMENT_TYPES.transition
  ) {
    throw new Error(`Unsupported commitmentType: ${value}`);
  }
  return normalized;
}

function normalizeAuthorizationMode(value) {
  const normalized = String(value || AUTHORIZATION_MODES.routeSpecific).trim().toLowerCase();
  if (
    normalized !== AUTHORIZATION_MODES.routeSpecific &&
    normalized !== AUTHORIZATION_MODES.threshold2of3
  ) {
    throw new Error(`Unsupported authorizationMode: ${value}`);
  }
  return normalized;
}

function resolveAuthorizationPathForRoute(route, authorizationMode, hasExpiry) {
  const mode = normalizeAuthorizationMode(authorizationMode);
  const normalizedRoute = String(route || '').trim().toLowerCase();
  if (mode === AUTHORIZATION_MODES.threshold2of3) {
    if (normalizedRoute === 'timeout' || normalizedRoute === 'refund_timeout') {
      if (!hasExpiry) {
        throw new Error('refund_timeout authorization requires expiryBlock');
      }
      return 'refund_timeout';
    }
    return 'quorum_2_of_3';
  }

  return ROUTE_TO_AUTHORIZATION_PATH[normalizedRoute] || normalizedRoute;
}

function buildEscrowTapLeaves({
  releasePubkey,
  refundPubkey,
  notaryPubkey,
  expiryBlock,
  commitmentHash = null,
  commitmentSignerPubkey = null,
  authorizationMode = AUTHORIZATION_MODES.routeSpecific
}) {
  const mode = normalizeAuthorizationMode(authorizationMode);
  const releaseXOnly = toXOnlyPubkey(releasePubkey, 'releasePubkey');
  const refundXOnly = toXOnlyPubkey(refundPubkey, 'refundPubkey');
  const notaryXOnly = toXOnlyPubkey(notaryPubkey, 'notaryPubkey');
  const signerForCommitment = maybeXOnlyPubkey(
    commitmentSignerPubkey,
    notaryXOnly,
    'commitmentSignerPubkey'
  );

  const leaves = mode === AUTHORIZATION_MODES.threshold2of3
    ? [
      buildLeaf(
        'quorum_2_of_3',
        bitcoin.script.compile([
          releaseXOnly,
          bitcoin.opcodes.OP_CHECKSIG,
          refundXOnly,
          bitcoin.opcodes.OP_CHECKSIGADD,
          notaryXOnly,
          bitcoin.opcodes.OP_CHECKSIGADD,
          bitcoin.script.number.encode(2),
          bitcoin.opcodes.OP_GREATERTHANOREQUAL
        ]),
        {
          signers: ['buyer', 'seller', 'notary'],
          threshold: 2,
          witnessTemplate: ['notary_signature_or_empty', 'buyer_signature_or_empty', 'seller_signature_or_empty']
        }
      )
    ]
    : [
      buildLeaf(
        'release_approval',
        bitcoin.script.compile([
          releaseXOnly,
          bitcoin.opcodes.OP_CHECKSIGVERIFY,
          notaryXOnly,
          bitcoin.opcodes.OP_CHECKSIG
        ]),
        {
          signers: ['release', 'notary'],
          witnessTemplate: ['notary_signature', 'release_signature']
        }
      ),
      buildLeaf(
        'refund_approval',
        bitcoin.script.compile([
          refundXOnly,
          bitcoin.opcodes.OP_CHECKSIGVERIFY,
          notaryXOnly,
          bitcoin.opcodes.OP_CHECKSIG
        ]),
        {
          signers: ['refund', 'notary'],
          witnessTemplate: ['notary_signature', 'refund_signature']
        }
      ),
      buildLeaf(
        'dispute_resolution',
        bitcoin.script.compile([
          notaryXOnly,
          bitcoin.opcodes.OP_CHECKSIG
        ]),
        {
          signers: ['notary'],
          witnessTemplate: ['notary_signature']
        }
      )
    ];

  if (expiryBlock != null) {
    leaves.push(
      buildLeaf(
        'refund_timeout',
        bitcoin.script.compile([
          bitcoin.script.number.encode(toUInt32(expiryBlock, 'expiryBlock')),
          bitcoin.opcodes.OP_CHECKLOCKTIMEVERIFY,
          bitcoin.opcodes.OP_DROP,
          refundXOnly,
          bitcoin.opcodes.OP_CHECKSIG
        ]),
        {
          signers: ['refund'],
          witnessTemplate: ['refund_signature'],
          locktime: BigInt(expiryBlock)
        }
      )
    );
  }

  if (commitmentHash != null) {
    const commitmentBuffer = asBuffer(commitmentHash, 'commitmentHash');
    if (commitmentBuffer.length !== 32) {
      throw new Error('commitmentHash must be 32 bytes');
    }

    leaves.push(
      buildLeaf(
        'commitment_reveal',
        bitcoin.script.compile([
          bitcoin.opcodes.OP_SHA256,
          commitmentBuffer,
          bitcoin.opcodes.OP_EQUALVERIFY,
          signerForCommitment,
          bitcoin.opcodes.OP_CHECKSIG
        ]),
        {
          signers: ['commitment_signer'],
          witnessTemplate: ['commitment_signature', 'commitment_preimage'],
          commitmentHash: commitmentBuffer
        }
      )
    );
  }

  return leaves;
}

function buildEscrowTaprootContract({
  internalPubkey = DEFAULT_SCRIPT_ONLY_INTERNAL_KEY,
  network = 'regtest',
  leaves
}) {
  const normalizedNetwork = normalizeNetwork(network);
  const internalXOnly = toXOnlyPubkey(internalPubkey, 'internalPubkey');
  const tapLeaves = leaves.map((leaf) => ({
    name: leaf.name,
    leafVersion: leaf.leafVersion || TAPLEAF_VERSION,
    output: leaf.output
  }));
  const scriptTree = buildBinaryTree(
    tapLeaves.map((leaf) => ({
      output: leaf.output,
      version: leaf.leafVersion
    }))
  );

  const payment = bitcoin.payments.p2tr({
    internalPubkey: internalXOnly,
    scriptTree,
    network: normalizedNetwork
  });

  const resolvedLeaves = leaves.map((leaf) => {
    const redeemPayment = bitcoin.payments.p2tr({
      internalPubkey: internalXOnly,
      scriptTree,
      redeem: {
        output: leaf.output,
        redeemVersion: leaf.leafVersion || TAPLEAF_VERSION
      },
      network: normalizedNetwork
    });
    const witness = redeemPayment.witness || [];

    return {
      ...leaf,
      controlBlock: witness[1],
      controlBlockHex: witness[1].toString('hex')
    };
  });

  return {
    network: normalizedNetwork,
    address: payment.address,
    output: payment.output,
    outputHex: payment.output.toString('hex'),
    internalPubkey: internalXOnly,
    merkleRoot: payment.hash,
    merkleRootHex: payment.hash ? payment.hash.toString('hex') : null,
    leaves: resolvedLeaves
  };
}

function buildEscrowAuthorizationWitnessPlan({
  authorizationPath,
  signerSet = null
}) {
  const path = String(authorizationPath || '').trim();

  if (path === 'quorum_2_of_3') {
    const normalizedSignerSet = normalizeSignerSet(signerSet || {});
    const signatureSlots = [
      {
        stackIndex: 0,
        keyField: 'notaryPubkey',
        signerRole: 'notary',
        signed: normalizedSignerSet.notarySigned,
        witnessPlaceholder: normalizedSignerSet.notarySigned ? 'notary_signature' : 'OP_0'
      },
      {
        stackIndex: 1,
        keyField: 'refundPubkey',
        signerRole: 'buyer',
        signed: normalizedSignerSet.buyerSigned,
        witnessPlaceholder: normalizedSignerSet.buyerSigned ? 'buyer_signature' : 'OP_0'
      },
      {
        stackIndex: 2,
        keyField: 'releasePubkey',
        signerRole: 'seller',
        signed: normalizedSignerSet.sellerSigned,
        witnessPlaceholder: normalizedSignerSet.sellerSigned ? 'seller_signature' : 'OP_0'
      }
    ];
    const signatureCount = signatureSlots.filter((slot) => slot.signed).length;

    return {
      authorizationPath: path,
      threshold: 2,
      signerSet: normalizedSignerSet,
      signatureCount,
      scriptSatisfiable: signatureCount >= 2,
      signatureSlots,
      witnessStack: signatureSlots.map((slot) => slot.witnessPlaceholder)
    };
  }

  const routeSpecificPlans = {
    release_approval: [
      { stackIndex: 0, keyField: 'notaryPubkey', signerRole: 'notary', witnessPlaceholder: 'notary_signature' },
      { stackIndex: 1, keyField: 'releasePubkey', signerRole: 'release', witnessPlaceholder: 'release_signature' }
    ],
    refund_approval: [
      { stackIndex: 0, keyField: 'notaryPubkey', signerRole: 'notary', witnessPlaceholder: 'notary_signature' },
      { stackIndex: 1, keyField: 'refundPubkey', signerRole: 'refund', witnessPlaceholder: 'refund_signature' }
    ],
    dispute_resolution: [
      { stackIndex: 0, keyField: 'notaryPubkey', signerRole: 'notary', witnessPlaceholder: 'notary_signature' }
    ],
    refund_timeout: [
      { stackIndex: 0, keyField: 'refundPubkey', signerRole: 'refund', witnessPlaceholder: 'refund_signature' }
    ],
    commitment_reveal: [
      { stackIndex: 0, keyField: 'commitmentSignerPubkey', signerRole: 'commitment_signer', witnessPlaceholder: 'commitment_signature' },
      { stackIndex: 1, keyField: null, signerRole: 'commitment_preimage', witnessPlaceholder: 'commitment_preimage' }
    ]
  };

  const signatureSlots = routeSpecificPlans[path];
  if (signatureSlots == null) {
    return {
      authorizationPath: path,
      threshold: null,
      signerSet: signerSet == null ? null : normalizeSignerSet(signerSet),
      scriptSatisfiable: null,
      signatureSlots: [],
      witnessStack: []
    };
  }

  return {
    authorizationPath: path,
    threshold: signatureSlots.length,
    signerSet: signerSet == null ? null : normalizeSignerSet(signerSet),
    scriptSatisfiable: true,
    signatureSlots,
    witnessStack: signatureSlots.map((slot) => slot.witnessPlaceholder)
  };
}

function buildSettlementTxTemplate({
  settlement,
  fundingTxId,
  fundingVout,
  fundingValueSats,
  authorizationPath = null,
  network = 'regtest',
  includeCommitmentAnchor = true,
  commitmentHash = null,
  commitmentType = COMMITMENT_TYPES.settlement
}) {
  const normalizedNetwork = normalizeNetwork(network);
  const route = settlement.decision.route;
  const tx = new bitcoin.Transaction();
  const txid = String(fundingTxId);
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
    throw new Error('fundingTxId must be a 32-byte hex string');
  }

  const locktime = authorizationPath === 'refund_timeout' && settlement.order.expiryBlock != null
    ? toUInt32(settlement.order.expiryBlock, 'expiryBlock')
    : 0;
  const sequence = locktime > 0 ? 0xfffffffe : 0xffffffff;
  tx.version = 2;
  tx.locktime = locktime;
  tx.addInput(Buffer.from(txid, 'hex').reverse(), toUInt32(fundingVout, 'fundingVout'), sequence);

  const outputs = [];
  settlement.payouts.forEach((payout) => {
    const value = toSafeSats(payout.amountSats, `payout amount for ${payout.role}`);
    tx.addOutput(payout.recipientScriptPubKey, value);
    outputs.push({
      role: payout.role,
      amountSats: BigInt(payout.amountSats),
      scriptPubKey: payout.recipientScriptPubKey,
      scriptPubKeyHex: payout.recipientScriptPubKey.toString('hex')
    });
  });

  if (settlement.residualAmountSats > 0n) {
    const value = toSafeSats(settlement.residualAmountSats, 'residualAmountSats');
    tx.addOutput(settlement.order.residualDest, value);
    outputs.push({
      role: 'residual',
      amountSats: settlement.residualAmountSats,
      scriptPubKey: settlement.order.residualDest,
      scriptPubKeyHex: settlement.order.residualDest.toString('hex')
    });
  }

  let commitmentAnchor = null;
  if (includeCommitmentAnchor) {
    const anchorHash = commitmentHash == null
      ? deriveEscrowCommitmentHash(settlement)
      : asBuffer(commitmentHash, 'commitmentHash');
    if (anchorHash.length !== 32) {
      throw new Error('commitmentHash must be 32 bytes');
    }
    const embed = bitcoin.payments.embed({
      data: [anchorHash],
      network: normalizedNetwork
    });
    tx.addOutput(embed.output, 0);
    commitmentAnchor = {
      hash: anchorHash,
      hashHex: anchorHash.toString('hex'),
      type: normalizeCommitmentType(commitmentType),
      scriptPubKey: embed.output,
      scriptPubKeyHex: embed.output.toString('hex')
    };
  }

  const outputsValueSats = outputs.reduce((sum, output) => sum + output.amountSats, 0n);
  if (outputsValueSats > BigInt(fundingValueSats)) {
    throw new Error(
      `Settlement outputs exceed funding value: ${outputsValueSats} > ${fundingValueSats}`
    );
  }

  return {
    route,
    authorizationPath: authorizationPath || ROUTE_TO_AUTHORIZATION_PATH[route],
    tx,
    txHex: tx.toHex(),
    txId: tx.getId(),
    version: tx.version,
    locktime,
    sequence,
    outputs,
    outputsValueSats,
    fundingValueSats: BigInt(fundingValueSats),
    commitmentAnchor,
    virtualSize: tx.virtualSize(),
    weight: tx.weight()
  };
}

function buildTaprootPsbt({
  taproot,
  selectedLeafName,
  fundingTxId,
  fundingVout,
  fundingValueSats,
  txTemplate,
  network = 'regtest'
}) {
  const normalizedNetwork = normalizeNetwork(network);
  const selectedLeaf = taproot.leaves.find((leaf) => leaf.name === selectedLeafName);
  if (selectedLeaf == null) {
    throw new Error(`Unknown tapleaf: ${selectedLeafName}`);
  }

  const psbt = new bitcoin.Psbt({ network: normalizedNetwork });
  psbt.setVersion(txTemplate.version);
  psbt.setLocktime(txTemplate.locktime);
  psbt.addInput({
    hash: fundingTxId,
    index: toUInt32(fundingVout, 'fundingVout'),
    sequence: txTemplate.sequence,
    witnessUtxo: {
      script: taproot.output,
      value: toSafeSats(fundingValueSats, 'fundingValueSats')
    },
    tapInternalKey: taproot.internalPubkey,
    tapLeafScript: [
      {
        leafVersion: selectedLeaf.leafVersion,
        script: selectedLeaf.output,
        controlBlock: selectedLeaf.controlBlock
      }
    ]
  });

  txTemplate.outputs.forEach((output) => {
    psbt.addOutput({
      script: output.scriptPubKey,
      value: toSafeSats(output.amountSats, `output amount for ${output.role}`)
    });
  });

  if (txTemplate.commitmentAnchor != null) {
    psbt.addOutput({
      script: txTemplate.commitmentAnchor.scriptPubKey,
      value: 0
    });
  }

  return {
    selectedLeaf,
    base64: psbt.toBase64(),
    hex: psbt.toHex(),
    psbt
  };
}

function buildEscrowSpendPackage({
  orderLike,
  decisionLike,
  keyset,
  fundingOutpoint,
  network = 'regtest',
  internalPubkey = DEFAULT_SCRIPT_ONLY_INTERNAL_KEY,
  authorizationPath = null,
  includeCommitmentAnchor = true,
  currentBlock = null,
  authorizationMode = AUTHORIZATION_MODES.routeSpecific,
  signerSet = null,
  timeoutRoute = null,
  splitRequiresNotary = false,
  commitmentType = COMMITMENT_TYPES.settlement
}) {
  const settlement = buildEscrowSettlement(orderLike, decisionLike, { currentBlock });
  const normalizedCommitmentType = normalizeCommitmentType(commitmentType);
  const selectedAuthorizationPath = authorizationPath ||
    resolveAuthorizationPathForRoute(
      settlement.decision.route,
      authorizationMode,
      settlement.order.expiryBlock != null
    );
  const resolvedTimeoutRoute = timeoutRoute == null
    ? selectedAuthorizationPath === 'refund_timeout'
    : !!timeoutRoute;
  const normalizedSignerSet = signerSet == null ? null : normalizeSignerSet(signerSet);

  if (keyset == null || typeof keyset !== 'object') {
    throw new Error('keyset is required');
  }
  if (fundingOutpoint == null || typeof fundingOutpoint !== 'object') {
    throw new Error('fundingOutpoint is required');
  }

  const settlementCommitmentHash = deriveEscrowCommitmentHash(settlement);
  const bitvm = normalizedSignerSet == null
    ? null
    : buildEscrowBitvmChallengeBundle(orderLike, decisionLike, {
      signerSet: normalizedSignerSet,
      currentBlock,
      timeoutRoute: resolvedTimeoutRoute,
      splitRequiresNotary
    });
  if (normalizedCommitmentType === COMMITMENT_TYPES.transition && bitvm == null) {
    throw new Error('signerSet is required when commitmentType is transition');
  }
  const commitmentHash = normalizedCommitmentType === COMMITMENT_TYPES.transition
    ? Buffer.from(bitvm.binding.transitionCommitmentHashHex, 'hex')
    : settlementCommitmentHash;
  const leaves = buildEscrowTapLeaves({
    releasePubkey: keyset.releasePubkey,
    refundPubkey: keyset.refundPubkey,
    notaryPubkey: keyset.notaryPubkey,
    expiryBlock: settlement.order.expiryBlock,
    commitmentHash,
    commitmentSignerPubkey: keyset.commitmentSignerPubkey || keyset.notaryPubkey,
    authorizationMode
  });
  const taproot = buildEscrowTaprootContract({
    internalPubkey,
    network,
    leaves
  });
  const txTemplate = buildSettlementTxTemplate({
    settlement,
    fundingTxId: fundingOutpoint.txid,
    fundingVout: fundingOutpoint.vout,
    fundingValueSats: fundingOutpoint.valueSats,
    authorizationPath: selectedAuthorizationPath,
    network,
    includeCommitmentAnchor,
    commitmentHash,
    commitmentType: normalizedCommitmentType
  });
  const psbt = buildTaprootPsbt({
    taproot,
    selectedLeafName: txTemplate.authorizationPath,
    fundingTxId: fundingOutpoint.txid,
    fundingVout: fundingOutpoint.vout,
    fundingValueSats: fundingOutpoint.valueSats,
    txTemplate,
    network
  });
  const authorization = {
    mode: normalizeAuthorizationMode(authorizationMode),
    path: selectedAuthorizationPath,
    witnessPlan: buildEscrowAuthorizationWitnessPlan({
      authorizationPath: selectedAuthorizationPath,
      signerSet: normalizedSignerSet
    })
  };

  return {
    settlement,
    commitmentHash,
    commitmentHashHex: commitmentHash.toString('hex'),
    commitmentType: normalizedCommitmentType,
    binding: {
      settlementCommitmentHashHex: settlementCommitmentHash.toString('hex'),
      transitionCommitmentHashHex: bitvm == null
        ? null
        : bitvm.binding.transitionCommitmentHashHex,
      selectedCommitmentHashHex: commitmentHash.toString('hex')
    },
    authorization,
    bitvm,
    taproot,
    txTemplate,
    psbt
  };
}

module.exports = {
  DEFAULT_SCRIPT_ONLY_INTERNAL_KEY,
  ROUTE_TO_AUTHORIZATION_PATH,
  AUTHORIZATION_MODES,
  COMMITMENT_TYPES,
  normalizeNetwork,
  normalizeAuthorizationMode,
  normalizeCommitmentType,
  resolveAuthorizationPathForRoute,
  toXOnlyPubkey,
  deriveEscrowCommitmentHash,
  buildEscrowTapLeaves,
  buildEscrowTaprootContract,
  buildEscrowAuthorizationWitnessPlan,
  buildSettlementTxTemplate,
  buildTaprootPsbt,
  buildEscrowSpendPackage
};
