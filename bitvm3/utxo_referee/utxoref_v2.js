const crypto = require('crypto');
const { canonicalStringify } = require('./m1_spec');
const tr = require('./tradelayer_taproot');
const {
  addressToScriptPubKey
} = require('./tradelayer_pnl_route_adapter');
const {
  derivePnlRowsFromStateOracle,
  buildGrossPnlEdges,
  computeNetBalances
} = require('./tradelayer_pnl_state_netting');

const VERSION = 2;
const ZERO32 = '00'.repeat(32);
const DEFAULT_MAX_STATE_AGE_BLOCKS = 6;
const DEFAULT_CHALLENGE_CSV_BLOCKS = 144;
const DEFAULT_RECOVERY_CSV_BLOCKS = 2016;
const MIN_PAYOUT_SATS = 330n;

const TAGS = Object.freeze({
  state: Buffer.from('UTXOREF_STATE_CHECKPOINT_V2\0', 'ascii'),
  payoutLeaf: Buffer.from('UTXOREF_PAYOUT_LEAF_V2\0', 'ascii'),
  payoutNode: Buffer.from('UTXOREF_PAYOUT_NODE_V2\0', 'ascii'),
  payoutEmpty: Buffer.from('UTXOREF_PAYOUT_EMPTY_V2\0', 'ascii'),
  fundingLeaf: Buffer.from('UTXOREF_FUNDING_LEAF_V2\0', 'ascii'),
  fundingNode: Buffer.from('UTXOREF_FUNDING_NODE_V2\0', 'ascii'),
  fundingEmpty: Buffer.from('UTXOREF_FUNDING_EMPTY_V2\0', 'ascii'),
  outputs: Buffer.from('UTXOREF_OUTPUT_VECTOR_V2\0', 'ascii'),
  commitment: Buffer.from('UTXOREF_COMMITMENT_V2\0', 'ascii'),
  request: Buffer.from('UTXOREF_REQUEST_ID_V2\0', 'ascii')
});

const PAYOUT_ROLE_CODES = Object.freeze({
  'pnl-netted-winner': 1,
  withdrawal: 2,
  refund: 3,
  rollover: 4,
  reserve: 5
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function sha256Hex(value) {
  return sha256(value).toString('hex');
}

function assertHex(value, bytes, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new Error(`${fieldName} must be ${bytes} bytes of hex`);
  }
  return text;
}

function toU64(value, fieldName) {
  let result;
  try {
    result = BigInt(value);
  } catch (_err) {
    throw new Error(`${fieldName} must be an unsigned integer`);
  }
  if (result < 0n || result > 0xffffffffffffffffn) {
    throw new Error(`${fieldName} must fit u64`);
  }
  return result;
}

function toU32(value, fieldName) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 0xffffffff) {
    throw new Error(`${fieldName} must fit u32`);
  }
  return result;
}

function u16le(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 0xffff) {
    throw new Error('value must fit u16');
  }
  const out = Buffer.alloc(2);
  out.writeUInt16LE(result);
  return out;
}

function u32le(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(toU32(value, 'u32 value'));
  return out;
}

function u64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(toU64(value, 'u64 value'));
  return out;
}

function lengthPrefixed(value, fieldName, maxLength = 10000) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  if (buf.length > maxLength || buf.length > 0xffff) {
    throw new Error(`${fieldName} exceeds ${Math.min(maxLength, 0xffff)} bytes`);
  }
  return Buffer.concat([u16le(buf.length), buf]);
}

function normalizeNetwork(value) {
  const network = String(value || '').toLowerCase();
  if (!network) throw new Error('network is required');
  return network;
}

function normalizeStateBody(body = {}) {
  const pnlRows = Array.isArray(body.pnlRows) ? body.pnlRows : [];
  if (!pnlRows.length) throw new Error('state body requires pnlRows');
  const settlementAddressMap = body.settlementAddressMap;
  if (!settlementAddressMap || typeof settlementAddressMap !== 'object' || Array.isArray(settlementAddressMap)) {
    throw new Error('state body requires settlementAddressMap');
  }
  return {
    kind: 'utxoref_state_checkpoint_v2',
    version: VERSION,
    network: normalizeNetwork(body.network || body.chain),
    chainGenesisHash: assertHex(body.chainGenesisHash, 32, 'chainGenesisHash'),
    contractId: assertHex(body.contractId, 32, 'contractId'),
    epochId: toU64(body.epochId, 'epochId').toString(),
    snapshotHeight: toU32(body.snapshotHeight, 'snapshotHeight'),
    snapshotBlockHash: assertHex(body.snapshotBlockHash, 32, 'snapshotBlockHash'),
    marks: body.marks || body.mark || {},
    pnlRows,
    settlementAddressMap
  };
}

function stateSigningBytes(body) {
  const normalized = normalizeStateBody(body);
  return Buffer.concat([TAGS.state, Buffer.from(canonicalStringify(normalized), 'utf8')]);
}

function publicKeyId(publicKey) {
  const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  return sha256Hex(key.export({ type: 'spki', format: 'der' }));
}

function buildSignedStateCheckpointV2(body, options = {}) {
  if (!options.privateKey) throw new Error('privateKey is required');
  const normalized = normalizeStateBody(body);
  const privateKey = options.privateKey.type === 'private'
    ? options.privateKey
    : crypto.createPrivateKey(options.privateKey);
  const publicKey = options.publicKey
    ? (options.publicKey.type === 'public' ? options.publicKey : crypto.createPublicKey(options.publicKey))
    : crypto.createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('state signer must be Ed25519');
  const keyId = options.keyId || publicKeyId(publicKey);
  const bytes = stateSigningBytes(normalized);
  const signature = crypto.sign(null, bytes, privateKey);
  return {
    kind: 'utxoref_signed_state_checkpoint_v2',
    version: VERSION,
    signer: { algorithm: 'ed25519', keyId },
    bodyHash: sha256Hex(bytes),
    signatureHex: signature.toString('hex'),
    body: normalized
  };
}

function trustedSignerMap(value) {
  if (!value) return new Map();
  if (value instanceof Map) return value;
  if (Array.isArray(value)) {
    return new Map(value.map((entry) => [entry.keyId || publicKeyId(entry.publicKey), entry.publicKey]));
  }
  return new Map(Object.entries(value));
}

function verifySignedStateCheckpointV2(envelope, options = {}) {
  try {
    if (!envelope || envelope.kind !== 'utxoref_signed_state_checkpoint_v2' || envelope.version !== VERSION) {
      return { ok: false, reason: 'wrong signed state checkpoint kind or version' };
    }
    if (envelope.signer?.algorithm !== 'ed25519') {
      return { ok: false, reason: 'unsupported state signature algorithm' };
    }
    const body = normalizeStateBody(envelope.body);
    if (options.expectedNetwork && body.network !== normalizeNetwork(options.expectedNetwork)) {
      return { ok: false, reason: 'state checkpoint network mismatch' };
    }
    if (options.expectedGenesisHash && body.chainGenesisHash !== assertHex(options.expectedGenesisHash, 32, 'expectedGenesisHash')) {
      return { ok: false, reason: 'state checkpoint genesis mismatch' };
    }
    const signers = trustedSignerMap(options.trustedSigners);
    const publicKey = signers.get(envelope.signer.keyId);
    if (!publicKey) return { ok: false, reason: 'state signer is not allowlisted' };
    if (publicKeyId(publicKey) !== envelope.signer.keyId) {
      return { ok: false, reason: 'state signer key id mismatch' };
    }
    const bytes = stateSigningBytes(body);
    const bodyHash = sha256Hex(bytes);
    if (bodyHash !== envelope.bodyHash) return { ok: false, reason: 'state body hash mismatch', bodyHash };
    const signature = Buffer.from(assertHex(envelope.signatureHex, 64, 'signatureHex'), 'hex');
    if (!crypto.verify(null, bytes, publicKey, signature)) {
      return { ok: false, reason: 'invalid state checkpoint signature' };
    }
    let ageBlocks = null;
    if (options.currentHeight !== undefined && options.currentHeight !== null) {
      const currentHeight = toU32(options.currentHeight, 'currentHeight');
      ageBlocks = currentHeight - body.snapshotHeight;
      if (ageBlocks < 0) return { ok: false, reason: 'current height precedes state checkpoint' };
      const maxAgeBlocks = toU32(options.maxAgeBlocks ?? DEFAULT_MAX_STATE_AGE_BLOCKS, 'maxAgeBlocks');
      if (ageBlocks > maxAgeBlocks) return { ok: false, reason: 'state checkpoint is stale', ageBlocks, maxAgeBlocks };
    }
    return { ok: true, body, bodyHash, keyId: envelope.signer.keyId, ageBlocks };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function requestIdHash(value) {
  const text = String(value || '');
  if (!text) throw new Error('requestId is required');
  return sha256(Buffer.concat([TAGS.request, Buffer.from(text, 'utf8')])).toString('hex');
}

function normalizePayout(payout, expectedIndex, context = {}) {
  if (!payout || typeof payout !== 'object') throw new Error(`payout[${expectedIndex}] must be an object`);
  const index = toU32(payout.index, `payout[${expectedIndex}].index`);
  if (index !== expectedIndex) throw new Error(`payout index mismatch: expected ${expectedIndex}, got ${index}`);
  const role = String(payout.role || '');
  const roleCode = PAYOUT_ROLE_CODES[role];
  if (!roleCode) throw new Error(`unsupported payout role: ${role}`);
  const amountSats = toU64(payout.amountSats ?? payout.sats, `payout[${index}].amountSats`);
  if (amountSats < MIN_PAYOUT_SATS) throw new Error(`payout[${index}].amountSats is below the V2 dust floor`);
  const scriptPubKey = Buffer.isBuffer(payout.scriptPubKey)
    ? Buffer.from(payout.scriptPubKey)
    : Buffer.from(assertHex(payout.scriptPubKeyHex || payout.scriptPubKey, undefined, `payout[${index}].scriptPubKey`), 'hex');
  if (!scriptPubKey.length || scriptPubKey.length > 10000) throw new Error(`payout[${index}].scriptPubKey length invalid`);
  const normalizedRequestId = String(payout.requestId || '');
  const derivedRequestIdHash = requestIdHash(normalizedRequestId);
  if (payout.requestIdHash && assertHex(payout.requestIdHash, 32, `payout[${index}].requestIdHash`) !== derivedRequestIdHash) {
    throw new Error(`payout[${index}].requestIdHash does not match requestId`);
  }
  return {
    index,
    contractId: assertHex(payout.contractId || context.contractId, 32, `payout[${index}].contractId`),
    epochId: toU64(payout.epochId ?? context.epochId, `payout[${index}].epochId`).toString(),
    requestId: normalizedRequestId,
    requestIdHash: derivedRequestIdHash,
    role,
    roleCode,
    accountAddress: payout.accountAddress ? String(payout.accountAddress) : null,
    destinationAddress: payout.destinationAddress ? String(payout.destinationAddress) : null,
    amountSats: amountSats.toString(),
    scriptPubKeyHex: scriptPubKey.toString('hex')
  };
}

function assertHexAny(value, fieldName) {
  const text = String(value || '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(text) || text.length % 2 !== 0) throw new Error(`${fieldName} must be even-length hex`);
  return text;
}

// Override the fixed-byte helper for script values without weakening fixed fields.
function scriptBuffer(value, fieldName) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  return Buffer.from(assertHexAny(value, fieldName), 'hex');
}

function normalizePayoutStrict(payout, expectedIndex, context = {}) {
  const copy = { ...payout };
  const source = payout?.scriptPubKeyHex ?? payout?.scriptPubKey;
  const script = scriptBuffer(source, `payout[${expectedIndex}].scriptPubKey`);
  copy.scriptPubKey = script;
  return normalizePayout(copy, expectedIndex, context);
}

function serializePayoutLeafV2(payout) {
  const p = normalizePayoutStrict(payout, toU32(payout.index, 'payout.index'), payout);
  return Buffer.concat([
    u16le(VERSION),
    Buffer.from(p.contractId, 'hex'),
    u64le(p.epochId),
    u32le(p.index),
    Buffer.from(p.requestIdHash, 'hex'),
    Buffer.from([p.roleCode]),
    u64le(p.amountSats),
    lengthPrefixed(Buffer.from(p.scriptPubKeyHex, 'hex'), 'scriptPubKey')
  ]);
}

function payoutLeafHashV2(payout) {
  return sha256(Buffer.concat([TAGS.payoutLeaf, serializePayoutLeafV2(payout)]));
}

function emptyHash(tag, level) {
  return sha256(Buffer.concat([tag, u32le(level)]));
}

function merkleRootV2(hashes, nodeTag, emptyTag) {
  if (!Array.isArray(hashes) || !hashes.length) throw new Error('Merkle tree requires at least one leaf');
  let level = hashes.map((hash, index) => Buffer.from(assertHex(hash, 32, `leafHash[${index}]`), 'hex'));
  let depth = 0;
  while (level.length > 1) {
    if (level.length % 2) level.push(emptyHash(emptyTag, depth));
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(Buffer.concat([nodeTag, level[i], level[i + 1]])));
    }
    level = next;
    depth++;
  }
  return level[0];
}

function buildPayoutSetV2(payouts, context = {}) {
  if (!Array.isArray(payouts) || !payouts.length) throw new Error('payouts must be a non-empty array');
  const normalized = payouts.map((payout, index) => normalizePayoutStrict(payout, index, context));
  const seenRequestIds = new Set();
  for (const payout of normalized) {
    if (seenRequestIds.has(payout.requestIdHash)) throw new Error(`duplicate payout request: ${payout.requestId}`);
    seenRequestIds.add(payout.requestIdHash);
  }
  const leafHashes = normalized.map((payout) => payoutLeafHashV2(payout).toString('hex'));
  const root = merkleRootV2(leafHashes, TAGS.payoutNode, TAGS.payoutEmpty);
  const totalSats = normalized.reduce((sum, payout) => sum + BigInt(payout.amountSats), 0n);
  return {
    payouts: normalized,
    leafHashes,
    payoutRoot: root.toString('hex'),
    payoutCount: normalized.length,
    payoutTotalSats: totalSats.toString()
  };
}

function normalizeFundingOutpoint(funding, index) {
  if (!funding || typeof funding !== 'object') throw new Error(`funding[${index}] must be an object`);
  const amountSats = toU64(funding.amountSats ?? funding.sats, `funding[${index}].amountSats`);
  if (amountSats === 0n) throw new Error(`funding[${index}].amountSats must be positive`);
  const script = scriptBuffer(funding.scriptPubKeyHex || funding.scriptPubKey, `funding[${index}].scriptPubKey`);
  if (!script.length) throw new Error(`funding[${index}].scriptPubKey is required`);
  return {
    index,
    txid: assertHex(funding.txid, 32, `funding[${index}].txid`),
    vout: toU32(funding.vout, `funding[${index}].vout`),
    amountSats: amountSats.toString(),
    scriptPubKeyHex: script.toString('hex')
  };
}

function fundingLeafHash(funding) {
  return sha256(Buffer.concat([
    TAGS.fundingLeaf,
    u32le(funding.index),
    Buffer.from(funding.txid, 'hex'),
    u32le(funding.vout),
    u64le(funding.amountSats),
    lengthPrefixed(Buffer.from(funding.scriptPubKeyHex, 'hex'), 'funding scriptPubKey')
  ]));
}

function buildFundingSetV2(fundingOutpoints) {
  if (!Array.isArray(fundingOutpoints) || !fundingOutpoints.length) throw new Error('fundingOutpoints must be non-empty');
  const funding = fundingOutpoints.map(normalizeFundingOutpoint);
  const seen = new Set();
  for (const item of funding) {
    const key = `${item.txid}:${item.vout}`;
    if (seen.has(key)) throw new Error(`duplicate funding outpoint: ${key}`);
    seen.add(key);
  }
  const leafHashes = funding.map((item) => fundingLeafHash(item).toString('hex'));
  return {
    funding,
    fundingRoot: merkleRootV2(leafHashes, TAGS.fundingNode, TAGS.fundingEmpty).toString('hex'),
    fundingCount: funding.length,
    fundingTotalSats: funding.reduce((sum, item) => sum + BigInt(item.amountSats), 0n).toString()
  };
}

function canonicalOutputBytes(outputs) {
  if (!Array.isArray(outputs) || !outputs.length) throw new Error('outputs must be non-empty');
  const normalized = outputs.map((output, index) => {
    const valueSats = toU64(output.valueSats ?? output.amountSats ?? output.sats, `outputs[${index}].valueSats`);
    if (valueSats === 0n) throw new Error(`outputs[${index}].valueSats must be positive`);
    const script = scriptBuffer(output.scriptPubKeyHex || output.scriptPubKey || output.script, `outputs[${index}].scriptPubKey`);
    if (!script.length) throw new Error(`outputs[${index}].scriptPubKey is required`);
    return { index, valueSats: valueSats.toString(), scriptPubKeyHex: script.toString('hex') };
  });
  const bytes = Buffer.concat([
    tr.varint(normalized.length),
    ...normalized.map((output) => Buffer.concat([
      u64le(output.valueSats),
      tr.varint(Buffer.from(output.scriptPubKeyHex, 'hex').length),
      Buffer.from(output.scriptPubKeyHex, 'hex')
    ]))
  ]);
  return { normalized, bytes };
}

function outputVectorHashV2(outputs) {
  const built = canonicalOutputBytes(outputs);
  return sha256(Buffer.concat([TAGS.outputs, built.bytes])).toString('hex');
}

function serializeCommitmentV2(core) {
  return Buffer.concat([
    TAGS.commitment,
    u16le(VERSION),
    lengthPrefixed(Buffer.from(core.network, 'utf8'), 'network', 64),
    Buffer.from(core.chainGenesisHash, 'hex'),
    Buffer.from(core.contractId, 'hex'),
    u64le(core.epochId),
    Buffer.from(core.fundingRoot, 'hex'),
    u32le(core.fundingCount),
    u64le(core.fundingTotalSats),
    Buffer.from(core.stateCheckpointHash, 'hex'),
    Buffer.from(core.payoutRoot, 'hex'),
    u32le(core.payoutCount),
    u64le(core.payoutTotalSats),
    Buffer.from(core.outputsHash, 'hex'),
    u64le(core.feeSats),
    Buffer.from(core.traceRoot, 'hex'),
    Buffer.from(core.assertionTreeRoot, 'hex'),
    u32le(core.challengeCsvBlocks),
    u32le(core.recoveryCsvBlocks),
    Buffer.from(core.operatorXonly, 'hex'),
    Buffer.from(core.challengerXonly, 'hex')
  ]);
}

function buildUtxoRefCommitmentV2(input = {}) {
  const network = normalizeNetwork(input.network);
  const chainGenesisHash = assertHex(input.chainGenesisHash, 32, 'chainGenesisHash');
  const contractId = assertHex(input.contractId, 32, 'contractId');
  const epochId = toU64(input.epochId, 'epochId').toString();
  const fundingSet = buildFundingSetV2(input.fundingOutpoints);
  const payoutSet = buildPayoutSetV2(input.payouts, { contractId, epochId });
  const outputs = input.outputs || payoutSet.payouts.map((payout) => ({
    valueSats: payout.amountSats,
    scriptPubKeyHex: payout.scriptPubKeyHex
  }));
  const outputSet = canonicalOutputBytes(outputs);
  const feeSats = toU64(input.feeSats, 'feeSats');
  if (BigInt(payoutSet.payoutTotalSats) + feeSats !== BigInt(fundingSet.fundingTotalSats)) {
    throw new Error('payout total plus fee must equal funding total');
  }
  if (outputSet.normalized.length !== payoutSet.payoutCount) throw new Error('output count must equal payout count');
  for (let i = 0; i < payoutSet.payoutCount; i++) {
    const payout = payoutSet.payouts[i];
    const output = outputSet.normalized[i];
    if (payout.amountSats !== output.valueSats || payout.scriptPubKeyHex !== output.scriptPubKeyHex) {
      throw new Error(`output ${i} does not exactly match payout ${i}`);
    }
  }
  const core = {
    kind: 'utxoref_commitment_v2',
    version: VERSION,
    network,
    chainGenesisHash,
    contractId,
    epochId,
    fundingRoot: fundingSet.fundingRoot,
    fundingCount: fundingSet.fundingCount,
    fundingTotalSats: fundingSet.fundingTotalSats,
    stateCheckpointHash: assertHex(input.stateCheckpointHash, 32, 'stateCheckpointHash'),
    payoutRoot: payoutSet.payoutRoot,
    payoutCount: payoutSet.payoutCount,
    payoutTotalSats: payoutSet.payoutTotalSats,
    outputsHash: sha256(Buffer.concat([TAGS.outputs, outputSet.bytes])).toString('hex'),
    feeSats: feeSats.toString(),
    traceRoot: assertHex(input.traceRoot || ZERO32, 32, 'traceRoot'),
    assertionTreeRoot: assertHex(input.assertionTreeRoot || ZERO32, 32, 'assertionTreeRoot'),
    challengeCsvBlocks: toU32(input.challengeCsvBlocks ?? DEFAULT_CHALLENGE_CSV_BLOCKS, 'challengeCsvBlocks'),
    recoveryCsvBlocks: toU32(input.recoveryCsvBlocks ?? DEFAULT_RECOVERY_CSV_BLOCKS, 'recoveryCsvBlocks'),
    operatorXonly: assertHex(input.operatorXonly, 32, 'operatorXonly'),
    challengerXonly: assertHex(input.challengerXonly, 32, 'challengerXonly')
  };
  if (core.recoveryCsvBlocks <= core.challengeCsvBlocks) {
    throw new Error('recoveryCsvBlocks must exceed challengeCsvBlocks');
  }
  const commitmentBytes = serializeCommitmentV2(core);
  return {
    kind: 'utxoref_commitment_v2',
    version: VERSION,
    commitmentHash: sha256Hex(commitmentBytes),
    commitmentHex: commitmentBytes.toString('hex'),
    core,
    funding: fundingSet.funding,
    payouts: payoutSet.payouts,
    outputs: outputSet.normalized
  };
}

function settlementMapEntry(stateBody, accountAddress) {
  const entry = stateBody.settlementAddressMap?.[accountAddress];
  if (!entry) throw new Error(`missing signed settlement destination for ${accountAddress}`);
  if (typeof entry === 'string') return { address: entry };
  if (typeof entry !== 'object') throw new Error(`invalid settlement destination for ${accountAddress}`);
  return entry;
}

function payoutScriptForEntry(entry, network) {
  if (entry.scriptPubKeyHex || entry.scriptPubKey) {
    return scriptBuffer(entry.scriptPubKeyHex || entry.scriptPubKey, 'settlement scriptPubKey').toString('hex');
  }
  const address = entry.address || entry.payoutAddress;
  if (!address) throw new Error('settlement destination requires address or scriptPubKeyHex');
  return addressToScriptPubKey(String(address), network).toString('hex');
}

function derivePnlPayoutsV2(stateBody) {
  const rows = derivePnlRowsFromStateOracle(stateBody);
  const rowIds = new Set();
  for (const row of rows) {
    if (rowIds.has(row.rowId)) throw new Error(`duplicate signed PNL row: ${row.rowId}`);
    rowIds.add(row.rowId);
  }
  const grossEdges = buildGrossPnlEdges(rows);
  const netBalances = computeNetBalances(grossEdges);
  const positive = netBalances
    .filter((row) => BigInt(row.netSats) > 0n)
    .sort((a, b) => a.address.localeCompare(b.address));
  if (!positive.length) throw new Error('signed state produces no positive PNL payouts');
  const payouts = positive.map((row, index) => {
    const entry = settlementMapEntry(stateBody, row.address);
    const destinationAddress = entry.address || entry.payoutAddress || null;
    return {
      index,
      contractId: stateBody.contractId,
      epochId: stateBody.epochId,
      requestId: `pnl:${stateBody.contractId}:${stateBody.epochId}:${row.address}`,
      role: 'pnl-netted-winner',
      accountAddress: row.address,
      destinationAddress,
      amountSats: row.netSats,
      scriptPubKeyHex: payoutScriptForEntry(entry, stateBody.network)
    };
  });
  return { rows, grossEdges, netBalances, payouts };
}

function strictUnsignedTx(hex) {
  const text = assertHexAny(hex, 'unsignedTxHex');
  const parsed = tr.parseTx(text);
  if (parsed.vin.some((vin) => vin.scriptSig.length !== 0)) throw new Error('unsigned transaction scriptSigs must be empty');
  const rebuilt = tr.serializeUnsignedTx(
    parsed.version,
    parsed.vin.map((vin) => ({ outpoint: vin.outpoint.toString('hex'), sequence: vin.sequence })),
    parsed.vout.map((vout) => ({ valueSats: vout.value, script: vout.script.toString('hex') })),
    parsed.locktime
  );
  if (rebuilt !== text) throw new Error('transaction is non-canonical, truncated, or has trailing bytes');
  return parsed;
}

function compareCommitment(expected, actual) {
  if (actual?.kind !== 'utxoref_commitment_v2' || actual.version !== VERSION) {
    return { ok: false, reason: 'wrong commitment kind or version' };
  }
  if (expected.commitmentHash !== actual.commitmentHash) return { ok: false, reason: 'commitment hash mismatch' };
  if (expected.commitmentHex !== actual.commitmentHex) return { ok: false, reason: 'commitment bytes mismatch' };
  if (canonicalStringify(expected.core) !== canonicalStringify(actual.core)) return { ok: false, reason: 'commitment core mismatch' };
  return { ok: true };
}

function buildUtxoRefPnlSettlementV2(input = {}) {
  const stateCheck = verifySignedStateCheckpointV2(input.stateEnvelope, input.stateVerification || {});
  if (!stateCheck.ok) throw new Error(`invalid signed state: ${stateCheck.reason}`);
  const derived = derivePnlPayoutsV2(stateCheck.body);
  const commitment = buildUtxoRefCommitmentV2({
    network: stateCheck.body.network,
    chainGenesisHash: stateCheck.body.chainGenesisHash,
    contractId: stateCheck.body.contractId,
    epochId: stateCheck.body.epochId,
    fundingOutpoints: input.fundingOutpoints,
    payouts: derived.payouts,
    feeSats: input.feeSats,
    stateCheckpointHash: stateCheck.bodyHash,
    traceRoot: input.traceRoot,
    assertionTreeRoot: input.assertionTreeRoot,
    challengeCsvBlocks: input.challengeCsvBlocks,
    recoveryCsvBlocks: input.recoveryCsvBlocks,
    operatorXonly: input.operatorXonly,
    challengerXonly: input.challengerXonly
  });
  return {
    kind: 'utxoref_pnl_settlement_v2',
    version: VERSION,
    stateEnvelope: input.stateEnvelope,
    commitment,
    fundingOutpoints: commitment.funding,
    payouts: commitment.payouts,
    outputs: commitment.outputs,
    rows: derived.rows,
    grossEdges: derived.grossEdges,
    netBalances: derived.netBalances,
    unsignedTxHex: input.unsignedTxHex || null
  };
}

function verifyUtxoRefSettlementV2(settlement, options = {}) {
  try {
    if (!settlement || settlement.kind !== 'utxoref_pnl_settlement_v2' || settlement.version !== VERSION) {
      return { ok: false, reason: 'wrong settlement kind or version' };
    }
    const stateCheck = verifySignedStateCheckpointV2(settlement.stateEnvelope, options.stateVerification || options);
    if (!stateCheck.ok) return { ok: false, reason: `state verification failed: ${stateCheck.reason}` };
    const derived = derivePnlPayoutsV2(stateCheck.body);
    if (canonicalStringify(settlement.rows) !== canonicalStringify(derived.rows)) {
      return { ok: false, reason: 'settlement PNL rows do not match signed state' };
    }
    if (canonicalStringify(settlement.grossEdges) !== canonicalStringify(derived.grossEdges)) {
      return { ok: false, reason: 'settlement gross edges do not derive from signed PNL rows' };
    }
    if (canonicalStringify(settlement.netBalances) !== canonicalStringify(derived.netBalances)) {
      return { ok: false, reason: 'settlement net balances do not derive from gross edges' };
    }
    const expected = buildUtxoRefCommitmentV2({
      network: stateCheck.body.network,
      chainGenesisHash: stateCheck.body.chainGenesisHash,
      contractId: stateCheck.body.contractId,
      epochId: stateCheck.body.epochId,
      fundingOutpoints: settlement.fundingOutpoints,
      payouts: derived.payouts,
      feeSats: settlement.commitment?.core?.feeSats,
      stateCheckpointHash: stateCheck.bodyHash,
      traceRoot: settlement.commitment?.core?.traceRoot,
      assertionTreeRoot: settlement.commitment?.core?.assertionTreeRoot,
      challengeCsvBlocks: settlement.commitment?.core?.challengeCsvBlocks,
      recoveryCsvBlocks: settlement.commitment?.core?.recoveryCsvBlocks,
      operatorXonly: settlement.commitment?.core?.operatorXonly,
      challengerXonly: settlement.commitment?.core?.challengerXonly
    });
    const commitmentCheck = compareCommitment(expected, settlement.commitment);
    if (!commitmentCheck.ok) return commitmentCheck;
    if (!settlement.unsignedTxHex) return { ok: false, reason: 'unsignedTxHex is required' };
    const tx = strictUnsignedTx(settlement.unsignedTxHex);
    if (tx.version !== 2 || tx.locktime !== 0) return { ok: false, reason: 'settlement transaction must use version 2 and locktime 0' };
    if (tx.vin.length !== expected.funding.length) return { ok: false, reason: 'settlement input count mismatch' };
    for (let i = 0; i < expected.funding.length; i++) {
      const funding = expected.funding[i];
      const expectedOutpoint = tr.outpoint(funding.txid, funding.vout);
      if (tx.vin[i].outpoint.toString('hex') !== expectedOutpoint) return { ok: false, reason: `settlement input ${i} outpoint mismatch` };
      if (tx.vin[i].sequence !== expected.core.challengeCsvBlocks) return { ok: false, reason: `settlement input ${i} sequence mismatch` };
    }
    const observedOutputs = tx.vout.map((output) => ({ valueSats: output.value.toString(), scriptPubKeyHex: output.script.toString('hex') }));
    if (canonicalStringify(observedOutputs) !== canonicalStringify(expected.outputs.map((output) => ({
      valueSats: output.valueSats,
      scriptPubKeyHex: output.scriptPubKeyHex
    })))) {
      return { ok: false, reason: 'settlement outputs do not exactly match the signed payout batch' };
    }
    if (outputVectorHashV2(observedOutputs) !== expected.core.outputsHash) return { ok: false, reason: 'settlement output hash mismatch' };
    return {
      ok: true,
      commitmentHash: expected.commitmentHash,
      stateCheckpointHash: stateCheck.bodyHash,
      payoutRoot: expected.core.payoutRoot,
      outputsHash: expected.core.outputsHash,
      payoutCount: expected.core.payoutCount,
      payoutTotalSats: expected.core.payoutTotalSats,
      feeSats: expected.core.feeSats
    };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  VERSION,
  ZERO32,
  TAGS,
  PAYOUT_ROLE_CODES,
  DEFAULT_MAX_STATE_AGE_BLOCKS,
  DEFAULT_CHALLENGE_CSV_BLOCKS,
  DEFAULT_RECOVERY_CSV_BLOCKS,
  MIN_PAYOUT_SATS,
  normalizeStateBody,
  stateSigningBytes,
  publicKeyId,
  buildSignedStateCheckpointV2,
  verifySignedStateCheckpointV2,
  requestIdHash,
  normalizePayout: normalizePayoutStrict,
  serializePayoutLeafV2,
  payoutLeafHashV2,
  merkleRootV2,
  buildPayoutSetV2,
  buildFundingSetV2,
  canonicalOutputBytes,
  outputVectorHashV2,
  serializeCommitmentV2,
  buildUtxoRefCommitmentV2,
  derivePnlPayoutsV2,
  strictUnsignedTx,
  buildUtxoRefPnlSettlementV2,
  verifyUtxoRefSettlementV2
};
