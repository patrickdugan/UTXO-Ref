/**
 * TradeLayer PNL route adapter for the UTXO referee.
 *
 * TradeLayer publishes the large PNL route as a witness/oracle blob. BitVM should
 * not parse that JSON directly. This adapter turns the resolved route into the
 * compact commitment that the referee already knows how to verify:
 *
 *   TL route blob -> concrete payout outputs -> UTXORef PayoutLeaf Merkle root
 */

const crypto = require('crypto');
const {
  CommitmentPackage,
  PayoutLeaf,
  SweepObject
} = require('./types');
const { buildTreeWithProofs } = require('./merkle');
const { verifySweep } = require('./verify');

const COIN = 100000000n;
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

const NETWORK_HRPS = {
  'litecoin-testnet': 'tltc',
  ltctest: 'tltc',
  'bitcoin-testnet': 'tb',
  'bitcoin-testnet4': 'tb',
  btctest: 'tb',
  'btc-testnet4': 'tb',
  'bitcoin-regtest': 'bcrt',
  litecoin: 'ltc',
  bitcoin: 'bc'
};

function sha256Hex(value) {
  const input = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === 'string' ? value : stableStringify(value), 'utf8');
  return crypto.createHash('sha256').update(input).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return JSON.stringify(value.toString());
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function toSats(value, fieldName) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`${fieldName} must be a safe integer sat amount`);
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw new Error(`${fieldName} must be an integer sat amount`);
    return BigInt(value);
  }
  throw new Error(`${fieldName} must be an integer sat amount`);
}

function ltcToSats(value, fieldName) {
  const text = String(value);
  if (!/^\d+(\.\d{1,8})?$/.test(text)) throw new Error(`${fieldName} must be a decimal coin amount`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * COIN + BigInt((fraction + '00000000').slice(0, 8));
}

function validateBps(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) {
    throw new Error(`${fieldName} must be an integer in 0..10000`);
  }
  return n;
}

function bech32Polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= generators[i];
    }
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const expanded = [];
  for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) >> 5);
  expanded.push(0);
  for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) & 31);
  return expanded;
}

function decodeBech32(address) {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error('bech32 address uses mixed case');
  }

  const normalized = address.toLowerCase();
  const sep = normalized.lastIndexOf('1');
  if (sep < 1 || sep + 7 > normalized.length) throw new Error('invalid bech32 separator');

  const hrp = normalized.slice(0, sep);
  const data = [];
  for (const char of normalized.slice(sep + 1)) {
    const value = BECH32_CHARSET.indexOf(char);
    if (value === -1) throw new Error(`invalid bech32 character: ${char}`);
    data.push(value);
  }

  const check = bech32Polymod(bech32HrpExpand(hrp).concat(data));
  const encoding = check === BECH32_CONST ? 'bech32' : check === BECH32M_CONST ? 'bech32m' : null;
  if (!encoding) throw new Error('invalid bech32 checksum');

  return { hrp, data: data.slice(0, -6), encoding };
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << toBits) - 1;
  const result = [];

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) throw new Error('invalid bech32 data range');
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    throw new Error('invalid bech32 padding');
  }

  return result;
}

function expectedHrp(network) {
  return NETWORK_HRPS[network] || network;
}

function inferNetwork(routePlan, options = {}) {
  if (options.network) return options.network;
  if (routePlan?.network) return routePlan.network;

  const chain = String(routePlan?.envelope?.chain || routePlan?.payload?.chain || routePlan?.chain || '');
  if (/bitcoin|btc/i.test(chain)) return 'bitcoin-testnet4';
  if (/litecoin|ltc/i.test(chain)) return 'litecoin-testnet';

  const candidateAddress = routePlan?.outputPlan?.find((output) => output?.address)?.address
    || routePlan?.dlcInput?.address
    || routePlan?.envelope?.tokenPnl?.find((entry) => entry?.toAddress)?.toAddress
    || routePlan?.envelope?.tokenPnl?.find((entry) => entry?.fromAddress)?.fromAddress;

  const address = String(candidateAddress || '').toLowerCase();
  if (address.startsWith('tb1')) return 'bitcoin-testnet4';
  if (address.startsWith('bcrt1')) return 'bitcoin-regtest';
  if (address.startsWith('bc1')) return 'bitcoin';
  if (address.startsWith('tltc1')) return 'litecoin-testnet';
  if (address.startsWith('ltc1')) return 'litecoin';

  return 'litecoin-testnet';
}

function addressToScriptPubKey(address, network = 'litecoin-testnet') {
  const decoded = decodeBech32(String(address));
  const hrp = expectedHrp(network);
  if (decoded.hrp !== hrp) {
    throw new Error(`address HRP mismatch: expected ${hrp}, got ${decoded.hrp}`);
  }

  if (!decoded.data.length) throw new Error('bech32 payload is empty');
  const version = decoded.data[0];
  const program = Buffer.from(convertBits(decoded.data.slice(1), 5, 8, false));

  if (version > 16) throw new Error(`invalid segwit version ${version}`);
  if (program.length < 2 || program.length > 40) throw new Error('invalid witness program length');
  if (version === 0) {
    if (decoded.encoding !== 'bech32') throw new Error('v0 witness program must use bech32');
    if (program.length !== 20 && program.length !== 32) throw new Error('v0 witness program must be 20 or 32 bytes');
  } else if (decoded.encoding !== 'bech32m') {
    throw new Error('v1+ witness program must use bech32m');
  }

  const versionOpcode = version === 0 ? 0x00 : 0x50 + version;
  return Buffer.concat([Buffer.from([versionOpcode, program.length]), program]);
}

function scriptPubKeyForOutput(output, network) {
  if (output.scriptPubKey) {
    const script = Buffer.isBuffer(output.scriptPubKey)
      ? output.scriptPubKey
      : Buffer.from(String(output.scriptPubKey), 'hex');
    if (!script.length) throw new Error('scriptPubKey cannot be empty');
    return script;
  }
  if (!output.address) throw new Error('output must include address or scriptPubKey');
  return addressToScriptPubKey(output.address, network);
}

function normalizeOutputPlan(outputPlan) {
  if (!Array.isArray(outputPlan) || !outputPlan.length) {
    throw new Error('route plan must include a non-empty outputPlan');
  }

  return outputPlan.map((output, index) => {
    const sats = output.sats !== undefined
      ? toSats(output.sats, `outputPlan[${index}].sats`)
      : ltcToSats(output.amount, `outputPlan[${index}].amount`);
    if (sats <= 0n) throw new Error(`outputPlan[${index}] must be positive`);
    return { ...output, sats };
  });
}

function deriveEpochId(routePlan) {
  if (routePlan.epochId !== undefined) return BigInt(routePlan.epochId);
  const seed = routePlan.envelope?.dlcRef || routePlan.payloadHash || routePlan.planHash || stableStringify(routePlan);
  return crypto.createHash('sha256').update(String(seed), 'utf8').digest().readBigUInt64LE(0);
}

function computeTradeLayerPlanHash(routePlan) {
  return sha256Hex({
    revealTxid: routePlan.revealTxid,
    payloadHash: routePlan.payloadHash,
    dlcRef: routePlan.envelope?.dlcRef,
    grantTxid: routePlan.dlcInput?.txid,
    grantVout: routePlan.dlcInput?.vout,
    outputPlan: routePlan.outputPlan
  });
}

function normalizeObjectList(value, fieldName) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => ({
      ...(item && typeof item === 'object' ? item : { value: item }),
      id: item?.id ?? item?.sendId ?? key
    }));
  }
  throw new Error(`${fieldName} must be an array or object map`);
}

function pickSendRecord(stateOracleBlob, options = {}) {
  const sends = normalizeObjectList(
    stateOracleBlob.sends || stateOracleBlob.sendRecords || stateOracleBlob.tokenSends,
    'stateOracleBlob.sends'
  );
  if (!sends.length) throw new Error('state oracle blob must include at least one send record');

  const sendId = options.sendId ?? stateOracleBlob.selectedSendId;
  const sendTxid = options.sendTxid ?? stateOracleBlob.selectedSendTxid;
  const sendIndex = options.sendIndex ?? stateOracleBlob.selectedSendIndex;

  if (sendId !== undefined && sendId !== null) {
    const match = sends.find((send) => String(send.id ?? send.sendId) === String(sendId));
    if (!match) throw new Error(`state oracle sendId not found: ${sendId}`);
    return match;
  }

  if (sendTxid !== undefined && sendTxid !== null) {
    const match = sends.find((send) => String(send.txid || send.revealTxid || '') === String(sendTxid));
    if (!match) throw new Error(`state oracle sendTxid not found: ${sendTxid}`);
    return match;
  }

  if (sendIndex !== undefined && sendIndex !== null) {
    const index = Number(sendIndex);
    if (!Number.isInteger(index) || index < 0 || index >= sends.length) {
      throw new Error(`state oracle sendIndex out of range: ${sendIndex}`);
    }
    return sends[index];
  }

  return sends[0];
}

function pickDlcInput(stateOracleBlob, sendRecord, options = {}) {
  if (options.dlcInput) return options.dlcInput;
  if (sendRecord.dlcInput || sendRecord.depositInput) return sendRecord.dlcInput || sendRecord.depositInput;
  if (stateOracleBlob.dlcInput || stateOracleBlob.depositInput) return stateOracleBlob.dlcInput || stateOracleBlob.depositInput;

  const inputs = stateOracleBlob.dlcInputs || stateOracleBlob.depositInputs;
  if (inputs && typeof inputs === 'object') {
    const sendId = sendRecord.id ?? sendRecord.sendId;
    if (sendId !== undefined && inputs[sendId]) return inputs[sendId];
    const txid = sendRecord.txid || sendRecord.revealTxid;
    if (txid && inputs[txid]) return inputs[txid];
  }

  throw new Error('state oracle send route requires a DLC/deposit input');
}

function bpsFromRatio(numerator, denominator, fieldName) {
  const n = toSats(numerator, `${fieldName}.numerator`);
  const d = toSats(denominator, `${fieldName}.denominator`);
  if (d <= 0n) throw new Error(`${fieldName}.denominator must be positive`);
  const scaled = n * 10000n;
  if (scaled % d !== 0n) {
    throw new Error(`${fieldName} must divide exactly into basis points`);
  }
  return validateBps((scaled / d).toString(), fieldName);
}

function deriveSendBps(sendRecord, stateOracleBlob, options = {}) {
  const direct = options.sendBps
    ?? sendRecord.sendBps
    ?? sendRecord.depositBps
    ?? stateOracleBlob.sendBps
    ?? stateOracleBlob.depositBps;
  if (direct !== undefined && direct !== null) return validateBps(direct, 'sendBps');

  const amountUnits = sendRecord.amountUnits ?? sendRecord.tokenAmountUnits ?? sendRecord.amount;
  const depositUnits = sendRecord.depositUnits
    ?? sendRecord.depositTokenUnits
    ?? stateOracleBlob.depositUnits
    ?? stateOracleBlob.depositTokenUnits;
  if (amountUnits !== undefined && depositUnits !== undefined) {
    return bpsFromRatio(amountUnits, depositUnits, 'send token ratio');
  }

  throw new Error('state oracle send route requires sendBps/depositBps or an exact token amount/deposit ratio');
}

function buildTradeLayerSendOracleCommitment(stateOracleBlob, options = {}) {
  if (!stateOracleBlob || typeof stateOracleBlob !== 'object') {
    throw new Error('stateOracleBlob must be an object');
  }

  const sendRecord = pickSendRecord(stateOracleBlob, options);
  const registry = options.dlcFunderRegistry
    || stateOracleBlob.dlcFunderRegistry
    || stateOracleBlob.dlcRegistry
    || stateOracleBlob.funderRegistry
    || {};
  const core = {
    kind: stateOracleBlob.kind || 'tradelayer-send-state-oracle-v1',
    chain: stateOracleBlob.chain,
    epochId: stateOracleBlob.epochId,
    snapshotHeight: stateOracleBlob.snapshotHeight,
    snapshotTxid: stateOracleBlob.snapshotTxid,
    oracleAddress: stateOracleBlob.oracleAddress,
    selectedSend: sendRecord,
    dlcFunderRegistry: registry
  };

  return {
    oracleBlobHash: sha256Hex(core),
    sendRecordHash: sha256Hex(sendRecord),
    dlcFunderRegistryHash: sha256Hex(registry),
    selectedSendId: sendRecord.id ?? sendRecord.sendId ?? null,
    selectedSendTxid: sendRecord.txid || sendRecord.revealTxid || null,
    core
  };
}

function buildTradeLayerSendOracleSigningPayload(stateOracleBlob, options = {}) {
  const commitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, options);
  const payload = stableStringify({
    kind: 'tradelayer-send-state-oracle-signature-v1',
    oracleBlobHash: commitment.oracleBlobHash,
    selectedSendHash: commitment.sendRecordHash,
    dlcFunderRegistryHash: commitment.dlcFunderRegistryHash,
    core: commitment.core
  });

  return {
    algorithm: 'ed25519',
    payload,
    payloadHash: sha256Hex(payload),
    oracleBlobHash: commitment.oracleBlobHash,
    sendRecordHash: commitment.sendRecordHash,
    dlcFunderRegistryHash: commitment.dlcFunderRegistryHash
  };
}

function readOracleSignatureEnvelope(stateOracleBlob, options = {}) {
  const source = options.oracleSignature
    || stateOracleBlob.oracleSignature
    || stateOracleBlob.signature
    || null;
  if (!source) return null;

  if (typeof source === 'string') {
    return {
      algorithm: options.oracleSignatureAlgorithm || 'ed25519',
      signatureHex: source,
      publicKeyPem: options.oraclePublicKeyPem || stateOracleBlob.oraclePublicKeyPem,
      keyId: options.oracleKeyId || stateOracleBlob.oracleKeyId || null
    };
  }

  return {
    algorithm: source.algorithm || options.oracleSignatureAlgorithm || 'ed25519',
    signatureHex: source.signatureHex || source.signature || source.hex,
    publicKeyPem: source.publicKeyPem || options.oraclePublicKeyPem || stateOracleBlob.oraclePublicKeyPem,
    keyId: source.keyId || options.oracleKeyId || stateOracleBlob.oracleKeyId || null,
    payloadHash: source.payloadHash || null
  };
}

function verifyTradeLayerSendOracleSignature(stateOracleBlob, options = {}) {
  const envelope = readOracleSignatureEnvelope(stateOracleBlob, options);
  const signing = buildTradeLayerSendOracleSigningPayload(stateOracleBlob, options);

  if (!envelope) {
    return {
      ok: false,
      reason: 'missing oracle signature',
      required: !!options.requireOracleSignature,
      ...signing
    };
  }

  if (String(envelope.algorithm).toLowerCase() !== 'ed25519') {
    return {
      ok: false,
      reason: `unsupported oracle signature algorithm: ${envelope.algorithm}`,
      required: !!options.requireOracleSignature,
      ...signing
    };
  }
  if (!envelope.signatureHex || !/^[0-9a-fA-F]+$/.test(String(envelope.signatureHex))) {
    return {
      ok: false,
      reason: 'oracle signature must be hex',
      required: !!options.requireOracleSignature,
      ...signing
    };
  }
  if (!envelope.publicKeyPem) {
    return {
      ok: false,
      reason: 'missing oracle public key PEM',
      required: !!options.requireOracleSignature,
      ...signing
    };
  }
  if (envelope.payloadHash && envelope.payloadHash !== signing.payloadHash) {
    return {
      ok: false,
      reason: `oracle signature payload hash mismatch: expected ${envelope.payloadHash}, recomputed ${signing.payloadHash}`,
      required: !!options.requireOracleSignature,
      ...signing,
      keyId: envelope.keyId
    };
  }

  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(signing.payload, 'utf8'),
      envelope.publicKeyPem,
      Buffer.from(envelope.signatureHex, 'hex')
    );
  } catch (err) {
    return {
      ok: false,
      reason: `oracle signature verification failed: ${err.message}`,
      required: !!options.requireOracleSignature,
      ...signing,
      keyId: envelope.keyId
    };
  }

  return {
    ok: verified,
    reason: verified ? null : 'invalid oracle signature',
    required: !!options.requireOracleSignature,
    algorithm: 'ed25519',
    keyId: envelope.keyId,
    payloadHash: signing.payloadHash,
    oracleBlobHash: signing.oracleBlobHash,
    sendRecordHash: signing.sendRecordHash,
    dlcFunderRegistryHash: signing.dlcFunderRegistryHash
  };
}

function resolveDlcFunderMapping(address, registry) {
  if (!address || !registry) return null;
  const target = String(address);

  if (Array.isArray(registry)) {
    return registry.find((entry) => String(entry?.funderAddress || entry?.address || '') === target) || null;
  }

  const mapped = registry[target];
  if (!mapped) return null;
  if (typeof mapped === 'string') {
    return { funderAddress: target, dlcAddress: mapped };
  }
  return { funderAddress: target, ...mapped };
}

function buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, options = {}) {
  const sendRecord = pickSendRecord(stateOracleBlob, options);
  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, options);
  const dlcInput = pickDlcInput(stateOracleBlob, sendRecord, options);
  const registry = options.dlcFunderRegistry
    || stateOracleBlob.dlcFunderRegistry
    || stateOracleBlob.dlcRegistry
    || stateOracleBlob.funderRegistry
    || {};
  const sendBps = deriveSendBps(sendRecord, stateOracleBlob, options);

  return {
    network: options.network || stateOracleBlob.network || stateOracleBlob.chain,
    revealTxid: sendRecord.revealTxid || sendRecord.txid || stateOracleBlob.revealTxid,
    payloadHash: oracleCommitment.oracleBlobHash,
    dlcInput,
    oracleAddress: sendRecord.toAddress || sendRecord.destinationAddress || sendRecord.oracleAddress,
    refundAddress: options.refundAddress
      || sendRecord.refundAddress
      || stateOracleBlob.refundAddress
      || dlcInput.refundAddress
      || dlcInput.address,
    sendBps,
    feeSats: options.feeSats ?? sendRecord.feeSats ?? stateOracleBlob.feeSats ?? 0,
    dlcFunderRegistry: registry,
    envelope: {
      ...(stateOracleBlob.envelope || {}),
      routeType: 'send',
      stateOracleHash: oracleCommitment.oracleBlobHash,
      selectedSendHash: oracleCommitment.sendRecordHash,
      dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash,
      selectedSendId: oracleCommitment.selectedSendId,
      selectedSendTxid: oracleCommitment.selectedSendTxid,
      designatedOracleAddress: stateOracleBlob.oracleAddress || null
    }
  };
}

function resolveSendRouteDestination(sendIntent, options = {}) {
  const oracleAddress = sendIntent.oracleAddress
    || sendIntent.sentAddress
    || sendIntent.toAddress
    || sendIntent.destinationAddress;
  if (!oracleAddress) {
    throw new Error('send route requires oracleAddress, sentAddress, toAddress, or destinationAddress');
  }

  const mapping = resolveDlcFunderMapping(
    oracleAddress,
    options.dlcFunderRegistry || sendIntent.dlcFunderRegistry
  );
  const outputAddress = mapping
    ? (mapping.dlcAddress || mapping.outputAddress || mapping.address)
    : oracleAddress;
  if (!outputAddress) {
    throw new Error('DLC funder mapping must include dlcAddress or outputAddress');
  }

  return {
    oracleAddress: String(oracleAddress),
    outputAddress: String(outputAddress),
    matchedDlcRef: mapping ? String(mapping.dlcRef || mapping.contractId || '') || null : null,
    role: mapping ? 'send-to-dlc-funding-output' : 'send-destination'
  };
}

function buildTradeLayerSendRoutePlan(sendIntent, options = {}) {
  if (!sendIntent || typeof sendIntent !== 'object') throw new Error('sendIntent must be an object');

  const dlcInput = sendIntent.dlcInput || sendIntent.depositInput || {};
  const depositSats = sendIntent.depositSats !== undefined
    ? toSats(sendIntent.depositSats, 'sendIntent.depositSats')
    : dlcInput.sats !== undefined
      ? toSats(dlcInput.sats, 'sendIntent.dlcInput.sats')
      : toSats(dlcInput.amountSats, 'sendIntent.dlcInput.amountSats');
  if (depositSats <= 0n) throw new Error('send route deposit must be positive');

  const sendBps = validateBps(sendIntent.sendBps ?? sendIntent.depositBps, 'sendIntent.sendBps');
  const derivedSendSats = (depositSats * BigInt(sendBps)) / 10000n;
  const explicitSendSats = sendIntent.sendSats !== undefined || sendIntent.amountSats !== undefined
    ? toSats(sendIntent.sendSats ?? sendIntent.amountSats, 'sendIntent.sendSats')
    : derivedSendSats;
  if (explicitSendSats !== derivedSendSats) {
    throw new Error(`send amount mismatch: ${explicitSendSats} sats does not equal ${sendBps} bps of ${depositSats} sats (${derivedSendSats})`);
  }

  const feeSats = sendIntent.feeSats !== undefined ? toSats(sendIntent.feeSats, 'sendIntent.feeSats') : 0n;
  const residualSats = depositSats - derivedSendSats - feeSats;
  if (residualSats < 0n) throw new Error('send route spends more than the deposit');

  const network = inferNetwork(sendIntent, options);
  const resolved = resolveSendRouteDestination(sendIntent, options);
  const refundAddress = sendIntent.refundAddress
    || sendIntent.residualAddress
    || sendIntent.changeAddress
    || dlcInput.refundAddress
    || dlcInput.address;
  if (residualSats > 0n && !refundAddress) {
    throw new Error('send route with residual sats requires refundAddress, residualAddress, changeAddress, or dlcInput.address');
  }

  const outputPlan = [
    {
      role: resolved.role,
      address: resolved.outputAddress,
      sats: derivedSendSats.toString(),
      amountBps: sendBps,
      oracleAddress: resolved.oracleAddress,
      matchedDlcRef: resolved.matchedDlcRef
    }
  ];
  if (residualSats > 0n) {
    outputPlan.push({
      role: 'refund-remainder',
      address: refundAddress,
      sats: residualSats.toString()
    });
  }

  const routePlan = {
    route: 'send',
    network,
    revealTxid: sendIntent.revealTxid,
    payloadHash: sendIntent.payloadHash || sha256Hex({
      kind: 'tradelayer-send-route',
      oracleAddress: resolved.oracleAddress,
      outputAddress: resolved.outputAddress,
      depositSats: depositSats.toString(),
      sendBps,
      feeSats: feeSats.toString()
    }),
    dlcInput: {
      ...dlcInput,
      sats: depositSats.toString()
    },
    sendBps,
    sendSats: derivedSendSats.toString(),
    feeSats: feeSats.toString(),
    residualSats: residualSats.toString(),
    oracleAddress: resolved.oracleAddress,
    resolvedDestinationAddress: resolved.outputAddress,
    matchedDlcRef: resolved.matchedDlcRef,
    outputPlan,
    envelope: {
      ...(sendIntent.envelope || {}),
      routeType: 'send',
      oracleAddress: resolved.oracleAddress,
      resolvedDestinationAddress: resolved.outputAddress,
      matchedDlcRef: resolved.matchedDlcRef
    }
  };

  routePlan.planHash = sendIntent.planHash || computeTradeLayerPlanHash(routePlan);
  return routePlan;
}

function buildLeaves(outputPlan, epochId, network) {
  return normalizeOutputPlan(outputPlan).map((output) => new PayoutLeaf({
    epochId,
    recipientScriptPubKey: scriptPubKeyForOutput(output, network),
    amountSats: output.sats
  }));
}

function outputPlanHasAddress(outputPlan, address) {
  return outputPlan.some((output) => output.address === address);
}

function leafKey(leaf) {
  return `${leaf.recipientScriptPubKey.toString('hex')}:${leaf.amountSats.toString()}`;
}

function buildSweepOutputs(observedOutputs, committed, network) {
  const remaining = new Map();
  committed.leaves.forEach((leaf, index) => {
    const key = leafKey(leaf);
    const indexes = remaining.get(key) || [];
    indexes.push(index);
    remaining.set(key, indexes);
  });

  return normalizeOutputPlan(observedOutputs).map((output, index) => {
    const recipientScriptPubKey = scriptPubKeyForOutput(output, network);
    const key = `${recipientScriptPubKey.toString('hex')}:${output.sats.toString()}`;
    const indexes = remaining.get(key) || [];
    const leafIndex = indexes.length ? indexes.shift() : Math.min(index, committed.proofs.length - 1);
    if (indexes.length) remaining.set(key, indexes);
    else remaining.delete(key);

    return {
      recipientScriptPubKey,
      amountSats: output.sats,
      merkleProof: committed.proofs[leafIndex]
    };
  });
}

function buildTradeLayerPnlCommitment(routePlan, options = {}) {
  const network = inferNetwork(routePlan, options);
  const epochId = options.epochId !== undefined ? BigInt(options.epochId) : deriveEpochId(routePlan);
  const leaves = buildLeaves(routePlan.outputPlan, epochId, network);
  const { root, proofs } = buildTreeWithProofs(leaves);
  const payoutTotalSats = leaves.reduce((sum, leaf) => sum + leaf.amountSats, 0n);
  const capSats = options.capSats !== undefined ? toSats(options.capSats, 'options.capSats') : payoutTotalSats;
  const residualDest = options.residualDestScriptPubKey
    ? Buffer.from(options.residualDestScriptPubKey, 'hex')
    : options.residualAddress
      ? addressToScriptPubKey(options.residualAddress, network)
      : Buffer.from('6a', 'hex');

  const commitment = new CommitmentPackage({
    epochId,
    withdrawalRoot: root,
    capSats,
    residualDest
  });

  const committed = { leaves, proofs };
  const payoutOutputs = buildSweepOutputs(options.observedOutputs || routePlan.outputPlan, committed, network);
  const observedPayoutTotalSats = payoutOutputs.reduce((sum, output) => sum + BigInt(output.amountSats), 0n);
  const residualSats = capSats - observedPayoutTotalSats;
  const sweep = new SweepObject({
    epochIdCommitted: epochId,
    payoutOutputs,
    residualOutput: {
      recipientScriptPubKey: residualDest,
      amountSats: residualSats >= 0n ? residualSats : 0n
    }
  });

  return {
    network,
    epochId,
    leaves,
    proofs,
    payoutTotalSats,
    commitment,
    sweep,
    withdrawalRootHex: root.toString('hex'),
    commitmentHashHex: commitment.hash().toString('hex')
  };
}

function verifyTradeLayerPnlRoutePlan(routePlan, options = {}) {
  if (!routePlan || typeof routePlan !== 'object') throw new Error('routePlan must be an object');

  const recomputedPlanHash = computeTradeLayerPlanHash(routePlan);
  if (!options.skipPlanHash && routePlan.planHash && recomputedPlanHash !== String(routePlan.planHash).toLowerCase()) {
    return {
      ok: false,
      reason: `planHash mismatch: expected ${routePlan.planHash}, recomputed ${recomputedPlanHash}`,
      recomputedPlanHash
    };
  }

  const bundle = buildTradeLayerPnlCommitment(routePlan, options);
  const sweepResult = verifySweep(bundle.commitment, bundle.sweep);
  if (!sweepResult.ok) {
    return {
      ok: false,
      reason: sweepResult.reason,
      recomputedPlanHash,
      withdrawalRootHex: bundle.withdrawalRootHex,
      commitmentHashHex: bundle.commitmentHashHex
    };
  }

  const observedPayoutTotalSats = bundle.sweep.totalPayoutSats();
  const inputSats = routePlan.dlcInput?.sats !== undefined
    ? toSats(routePlan.dlcInput.sats, 'routePlan.dlcInput.sats')
    : null;
  const feeSats = routePlan.feeSats !== undefined ? toSats(routePlan.feeSats, 'routePlan.feeSats') : 0n;
  if (inputSats !== null && observedPayoutTotalSats + feeSats !== inputSats) {
    return {
      ok: false,
      reason: `route accounting mismatch: payouts ${observedPayoutTotalSats} + fee ${feeSats} != input ${inputSats}`,
      recomputedPlanHash,
      withdrawalRootHex: bundle.withdrawalRootHex,
      commitmentHashHex: bundle.commitmentHashHex
    };
  }

  return {
    ok: true,
    recomputedPlanHash,
    withdrawalRootHex: bundle.withdrawalRootHex,
    commitmentHashHex: bundle.commitmentHashHex,
    epochId: bundle.epochId.toString(),
    payoutTotalSats: observedPayoutTotalSats.toString(),
    feeSats: feeSats.toString()
  };
}

function verifyTradeLayerSendRoutePlan(sendIntent, options = {}) {
  const routePlan = buildTradeLayerSendRoutePlan(sendIntent, options);
  if (!outputPlanHasAddress(routePlan.outputPlan, routePlan.resolvedDestinationAddress)) {
    return {
      ok: false,
      reason: 'send route output plan does not include the resolved destination address'
    };
  }

  const result = verifyTradeLayerPnlRoutePlan(routePlan, options);
  if (!result.ok) return result;

  return {
    ...result,
    route: 'send',
    sendBps: routePlan.sendBps,
    sendSats: routePlan.sendSats,
    residualSats: routePlan.residualSats,
    oracleAddress: routePlan.oracleAddress,
    resolvedDestinationAddress: routePlan.resolvedDestinationAddress,
    matchedDlcRef: routePlan.matchedDlcRef
  };
}

function verifyTradeLayerSendStateOracleRoute(stateOracleBlob, options = {}) {
  const oracleCommitment = buildTradeLayerSendOracleCommitment(stateOracleBlob, options);
  const oracleSignature = verifyTradeLayerSendOracleSignature(stateOracleBlob, options);
  if ((options.requireOracleSignature || stateOracleBlob.oracleSignature || stateOracleBlob.signature) && !oracleSignature.ok) {
    return {
      ok: false,
      reason: oracleSignature.reason,
      oracleSignature,
      oracleBlobHash: oracleCommitment.oracleBlobHash,
      sendRecordHash: oracleCommitment.sendRecordHash,
      dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash,
      selectedSendId: oracleCommitment.selectedSendId,
      selectedSendTxid: oracleCommitment.selectedSendTxid
    };
  }

  const sendIntent = buildTradeLayerSendIntentFromStateOracle(stateOracleBlob, options);
  const routePlan = buildTradeLayerSendRoutePlan(sendIntent, options);
  const result = verifyTradeLayerPnlRoutePlan(routePlan, options);

  return {
    ...result,
    route: 'send',
    sendBps: routePlan.sendBps,
    sendSats: routePlan.sendSats,
    residualSats: routePlan.residualSats,
    oracleAddress: routePlan.oracleAddress,
    resolvedDestinationAddress: routePlan.resolvedDestinationAddress,
    matchedDlcRef: routePlan.matchedDlcRef,
    oracleBlobHash: oracleCommitment.oracleBlobHash,
    sendRecordHash: oracleCommitment.sendRecordHash,
    dlcFunderRegistryHash: oracleCommitment.dlcFunderRegistryHash,
    selectedSendId: oracleCommitment.selectedSendId,
    selectedSendTxid: oracleCommitment.selectedSendTxid,
    planHash: routePlan.planHash,
    oracleSignature
  };
}

module.exports = {
  NETWORK_HRPS,
  stableStringify,
  sha256Hex,
  addressToScriptPubKey,
  computeTradeLayerPlanHash,
  buildTradeLayerSendOracleCommitment,
  buildTradeLayerSendOracleSigningPayload,
  verifyTradeLayerSendOracleSignature,
  buildTradeLayerSendIntentFromStateOracle,
  buildTradeLayerSendRoutePlan,
  buildTradeLayerPnlCommitment,
  verifyTradeLayerPnlRoutePlan,
  verifyTradeLayerSendRoutePlan,
  verifyTradeLayerSendStateOracleRoute
};
