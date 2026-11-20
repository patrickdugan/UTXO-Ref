'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { canonicalize } = require('../../bitvm3/utxo_referee/dlc_canonical_json');
const { schnorrVerify } = require('../../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const { outpoint, serializeUnsignedTx } = require('../../bitvm3/utxo_referee/tradelayer_taproot');
const { verifyRecoveryPackage, completeSettlement } = require('./settlement');

// Byte ABI from zk-rusto-no-bitcoino at 992cdb1c51b5c7a630ea552b2648acbad4308a9b.
const DOMAIN = 'UTXORef/LNMarkets/bitcoin-regtest/lnmarkets/v1/';
const MAX_MONEY = 2_100_000_000_000_000n;
const MAX_ROWS = 32;
const DEPTH = 256;
const exportsByTrade = new WeakMap();
const proposals = new WeakMap();

const sha256 = (bytes) => createHash('sha256').update(bytes).digest();
const hex = (bytes) => bytes.toString('hex');
function tagged(label, bytes) {
  const tag = sha256(DOMAIN + label);
  return sha256(Buffer.concat([tag, tag, bytes]));
}
function fromHex(value, size, label = 'field') {
  if (typeof value !== 'string' || value.length !== size * 2 || /[^0-9a-f]/.test(value)) {
    throw new Error(label + ' must be canonical ' + size + '-byte hex');
  }
  return Buffer.from(value, 'hex');
}
const hash = (value, label) => fromHex(value, 32, label);
const signature = (value) => fromHex(value, 64, 'signature');

function unsigned(value, size) {
  const bytes = Buffer.alloc(size);
  bytes.writeUIntLE(value, 0, size);
  return bytes;
}
const u16 = (value) => unsigned(value, 2);
const u32 = (value) => unsigned(value, 4);
function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}
function pair(label, left, right) {
  return tagged(label, Buffer.concat([left, right]));
}

function encodeOutcome(outcome) {
  return Buffer.concat([u32(outcome.index), hash(outcome.message),
    ...[outcome.traderSats, outcome.makerSats, outcome.anchorSats, outcome.feeSats].map(u64)]);
}
function outcomeHash(summary, outcome) {
  return tagged('outcome-leaf', Buffer.concat([
    hash(summary.contractId), hash(summary.oracleEventId), u32(summary.outcomeCount), encodeOutcome(outcome)
  ]));
}
function oracleMessage(summary, outcome) {
  return tagged('oracle-attestation', Buffer.concat([
    hash(summary.oracleEventId), u32(summary.maturityHeight), u32(summary.outcomeCount),
    u32(outcome.index), hash(outcome.message)
  ]));
}
function merkleTree(leaves, family, index = 0) {
  const count = leaves.length;
  const siblings = [];
  let level = [...leaves];
  const width = 2 ** Math.ceil(Math.log2(count));
  for (let padding = count; padding < width; padding++) {
    level.push(tagged(family + '-padding', Buffer.concat([u32(padding), u32(count)])));
  }
  while (level.length > 1) {
    siblings.push(level[index ^ 1]);
    const parents = [];
    for (let i = 0; i < level.length; i += 2) parents.push(pair(family + '-node', level[i], level[i + 1]));
    level = parents;
    index >>= 1;
  }
  return { root: level[0], siblings };
}

function encodeSummary(s) {
  return Buffer.concat([
    ...[s.salt, s.contractId, s.planDigest, s.recoveryDigest, s.fundingTxid].map((value) => hash(value)),
    u32(s.fundingVout), u64(s.collateralSats), fromHex(s.fundingScript, 34), hash(s.traderKey), hash(s.makerKey),
    ...[s.traderScript, s.makerScript, s.anchorScript].map((value) => fromHex(value, 34)),
    ...s.oracleKeys.map((value) => hash(value)), hash(s.oracleEventId), hash(s.outcomeRoot),
    u32(s.outcomeCount), u32(s.maturityHeight), u32(s.refundHeight), u16(s.refundCsv)
  ]);
}
function encodeContext(context) {
  return Buffer.concat([
    u64(context.epoch), hash(context.batchId), u32(context.evaluationHeight), u32(context.validUntilHeight),
    ...[context.acceptedContractsRoot, context.oldNullifierRoot, context.newNullifierRoot, context.batchTxDigest]
      .map((value) => hash(value)), u32(context.rowCount)
  ]);
}

function exportTrade(input) {
  const { recoveryPackage, pins, outcomeId, attestations, salt = randomBytes(32).toString('hex') } = canonicalize(input);
  if (!hash(salt, 'salt').some(Boolean)) throw new Error('salt must be nonzero');
  const verified = verifyRecoveryPackage(recoveryPackage, pins);
  const { plan, fundingOutpoint, transactionSet } = verified.settlementPackage;
  if (pins.fundingOutpoint?.txid !== fundingOutpoint.txid || pins.fundingOutpoint?.vout !== fundingOutpoint.vout) {
    throw new Error('funding outpoint differs from original wallet pin');
  }
  const cet = completeSettlement({
    recoveryPackage: verified, expectedPlanId: pins.expectedPlanId,
    expectedRecoveryDigest: pins.expectedRecoveryDigest, outcomeId, attestations
  });
  const terms = plan.terms;
  if (BigInt(terms.settlementFeeSats) > 1_000_000n) throw new Error('miner fee exceeds batch v1 maximum');
  const summary = {
    salt,
    contractId: plan.contractId.slice('lnm-'.length),
    planDigest: plan.planDigest,
    recoveryDigest: verified.recoveryDigest,
    fundingTxid: fundingOutpoint.txid,
    fundingVout: fundingOutpoint.vout,
    collateralSats: plan.fundingValueSats,
    fundingScript: transactionSet.funding.scriptPubKeyHex,
    traderKey: terms.traderPubkeyX,
    makerKey: terms.makerPubkeyX,
    traderScript: terms.traderPayoutScript,
    makerScript: terms.makerPayoutScript,
    anchorScript: terms.anchorScript,
    oracleKeys: [...terms.oraclePubkeys].sort(),
    oracleEventId: hex(tagged('utxoref-oracle-event-id', Buffer.from(terms.oracleEventId, 'utf8'))),
    outcomeCount: plan.outcomes.length,
    maturityHeight: terms.maturityHeight,
    refundHeight: terms.refundHeight,
    refundCsv: terms.refundCsvBlocks
  };
  if (!hash(summary.fundingTxid).some(Boolean) || summary.fundingVout === 0xffffffff) {
    throw new Error('unsupported batch funding outpoint');
  }
  const outcomes = plan.outcomes.map((row, index) => ({
    index, message: row.outcomeMessage, traderSats: row.traderPayoutSats,
    makerSats: row.makerPayoutSats, anchorSats: terms.anchorSats, feeSats: terms.settlementFeeSats
  }));
  const selected = outcomes.find((row) => row.message === outcomeId);
  const tree = merkleTree(outcomes.map((row) => outcomeHash(summary, row)), 'outcome', selected.index);
  summary.outcomeRoot = hex(tree.root);
  const encodedSummary = encodeSummary(summary);
  const summaryDigest = tagged('dlc-summary', encodedSummary);
  const oracleDigest = oracleMessage(summary, selected);
  const nullifier = tagged('consumed-outpoint-authorization', Buffer.concat([
    hash(summary.fundingTxid), u32(summary.fundingVout)
  ]));
  const trade = canonicalize({
    summary, selected, outcomeSiblings: tree.siblings.map(hex), summaryDigest: hex(summaryDigest),
    oracleDigest: hex(oracleDigest), oracleIndices: cet.oraclePubkeys.map((key) => summary.oracleKeys.indexOf(key)),
    nullifier: hex(nullifier)
  });
  exportsByTrade.set(trade, { encodedSummary, summaryDigest, oracleDigest, nullifier });
  return trade;
}

const emptyLeaf = tagged('nullifier-empty-leaf', Buffer.alloc(0));
const branch = (left, right) => pair('nullifier-node', left, right);
function rootFromPath(key, leaf, siblings) {
  return siblings.reduce((node, sibling, level) => {
    const bit = DEPTH - level - 1;
    return key[bit >> 3] & (0x80 >> (bit & 7)) ? branch(sibling, node) : branch(node, sibling);
  }, leaf);
}

function compareTrades(left, right) {
  const leftTxid = left.summary.fundingTxid;
  const rightTxid = right.summary.fundingTxid;
  if (leftTxid !== rightTxid) return leftTxid < rightTxid ? -1 : 1;
  return left.summary.fundingVout - right.summary.fundingVout;
}
function addMoney(left, right) {
  const sum = left + BigInt(right);
  if (sum > MAX_MONEY) throw new Error('batch amount exceeds Bitcoin money range');
  return sum;
}

function prepareBatch({ trades, epoch, batchId, evaluationHeight, validUntilHeight, oldNullifierRoot, paths }) {
  if (!Array.isArray(trades) || trades.length < 1 || trades.length > MAX_ROWS ||
      trades.some((trade) => !exportsByTrade.has(trade))) {
    throw new Error('batch requires 1..32 verified trade exports');
  }
  if (typeof epoch !== 'string' || !/^[1-9][0-9]{0,19}$/.test(epoch) ||
      !hash(batchId, 'batch ID').some(Boolean) ||
      !Number.isSafeInteger(evaluationHeight) || !Number.isSafeInteger(validUntilHeight) ||
      evaluationHeight < 1 || evaluationHeight > validUntilHeight || validUntilHeight >= 500_000_000) {
    throw new Error('invalid batch epoch, ID or height window');
  }
  const rows = [...trades].sort(compareTrades);
  if (new Set(rows.map((row) => row.summary.contractId)).size !== rows.length ||
      new Set(rows.map((row) => row.nullifier)).size !== rows.length) {
    throw new Error('duplicate contract or funding outpoint in batch');
  }
  if (rows.some((row) => row.summary.maturityHeight > evaluationHeight)) throw new Error('batch contains an immature trade');
  const acceptedLeaves = rows.map((row, index) => tagged('accepted-contract-leaf',
    Buffer.concat([u32(index), u32(rows.length), hash(row.summaryDigest)])));
  const acceptedContractsRoot = hex(merkleTree(acceptedLeaves, 'accepted-contract').root);

  const supplied = canonicalize(paths);
  if (!Array.isArray(supplied) || supplied.length !== rows.length) throw new Error('one sequential nullifier path is required per trade');
  let root = hash(oldNullifierRoot, 'old nullifier root');
  const checkedPaths = rows.map((row, index) => {
    const { nullifier, siblings } = supplied[index];
    if (nullifier !== row.nullifier || !Array.isArray(siblings) || siblings.length !== DEPTH) {
      throw new Error('nullifier paths must follow canonical outpoint order with 256 siblings each');
    }
    const key = hash(nullifier);
    const nodes = siblings.map((value) => hash(value));
    if (!rootFromPath(key, emptyLeaf, nodes).equals(root)) throw new Error('nullifier is consumed or path is inconsistent with prior root');
    root = rootFromPath(key, tagged('nullifier-used-leaf', key), nodes);
    return nodes;
  });

  const outputValues = new Map();
  let totalCollateralSats = 0n, totalFeeSats = 0n;
  for (const { summary, selected } of rows) {
    for (const [script, amount] of [[summary.traderScript, selected.traderSats],
      [summary.makerScript, selected.makerSats], [summary.anchorScript, selected.anchorSats]]) {
      outputValues.set(script, addMoney(outputValues.get(script) ?? 0n, amount));
    }
    totalCollateralSats = addMoney(totalCollateralSats, summary.collateralSats);
    totalFeeSats = addMoney(totalFeeSats, selected.feeSats);
  }
  const outputs = [...outputValues.keys()].sort().map((script) => ({ script, valueSats: outputValues.get(script) }));
  const totalPayoutSats = outputs.reduce((sum, output) => addMoney(sum, output.valueSats), 0n);
  if (totalPayoutSats + totalFeeSats !== totalCollateralSats) throw new Error('batch amounts do not conserve collateral');
  const tx = Buffer.from(serializeUnsignedTx(2, rows.map(({ summary }) => ({
    outpoint: outpoint(summary.fundingTxid, summary.fundingVout), sequence: 0xfffffffd
  })), outputs, Math.max(...rows.map(({ summary }) => summary.maturityHeight))), 'hex');
  const txHash = sha256(tx);
  const txid = sha256(txHash).reverse();
  const context = {
    epoch, batchId, evaluationHeight, validUntilHeight, acceptedContractsRoot, oldNullifierRoot,
    newNullifierRoot: hex(root), batchTxDigest: hex(txHash), rowCount: rows.length
  };
  const contextBytes = encodeContext(context);
  const consentDigests = rows.map((row) => hex(tagged('batch-consent', Buffer.concat([
    contextBytes, hash(row.summaryDigest)
  ]))));
  const statementDomain = tagged('statement-domain', Buffer.from('co-signed-batch-proposal-certificate'));
  const journal = Buffer.concat([
    Buffer.from('LNMJNL01'), statementDomain, contextBytes.subarray(0, 48), u32(context.rowCount),
    contextBytes.subarray(48, 176), txid, ...[totalCollateralSats, totalPayoutSats, totalFeeSats].map(u64)
  ]);
  const proposal = canonicalize({
    context, txid: hex(txid), unsignedTxHex: hex(tx), expectedJournalHex: hex(journal),
    expectedJournalSha256: hex(sha256(journal)), consentDigests, nullifiers: rows.map((row) => row.nullifier)
  });
  proposals.set(proposal, { rows, contextBytes, checkedPaths });
  return proposal;
}

function verifySignature(key, digest, supplied) {
  const sig = signature(supplied);
  if (!schnorrVerify(hash(key), digest, sig)) throw new Error('invalid batch application signature');
  return sig;
}
function assembleWitness(proposal, signedRows) {
  const prepared = proposals.get(proposal);
  const rows = canonicalize(signedRows);
  if (!prepared || !Array.isArray(rows) || rows.length !== prepared.rows.length) {
    throw new Error('expected prepared proposal and signatures for every row');
  }
  const bytes = [Buffer.from('LNMBAT01'), prepared.contextBytes];
  prepared.rows.forEach((row, index) => {
    const { nullifier, summarySignatures, oracleSignatures, batchSignatures } = rows[index];
    const { summary, selected, oracleIndices } = row;
    if (nullifier !== row.nullifier ||
        [summarySignatures, oracleSignatures, batchSignatures].some((signatures) =>
          !Array.isArray(signatures) || signatures.length !== 2)) {
      throw new Error('expected two signatures per role in canonical row order');
    }
    const own = exportsByTrade.get(row);
    const parties = [summary.traderKey, summary.makerKey];
    bytes.push(own.encodedSummary,
      ...parties.map((key, i) => verifySignature(key, own.summaryDigest, summarySignatures[i])),
      encodeOutcome(selected), u16(row.outcomeSiblings.length),
      ...row.outcomeSiblings.map((value) => hash(value)));
    oracleIndices.forEach((oracleIndex, i) => {
      bytes.push(Buffer.from([oracleIndex]), verifySignature(summary.oracleKeys[oracleIndex], own.oracleDigest, oracleSignatures[i]));
    });
    bytes.push(...parties.map((key, i) => verifySignature(key, hash(proposal.consentDigests[index]), batchSignatures[i])),
      ...prepared.checkedPaths[index]);
  });
  return Buffer.concat(bytes);
}

// Reference path builder for a venue whose retained authorization leaves are
// already authenticated. The proposal builder independently checks every path.
function buildNullifierPaths(previousKeys, orderedKeys) {
  const defaults = [emptyLeaf];
  for (let i = 0; i < DEPTH; i++) defaults.push(branch(defaults[i], defaults[i]));
  const layers = Array.from({ length: DEPTH + 1 }, () => new Map());
  const get = (depth, key) => layers[depth].get(key) ?? defaults[DEPTH - depth];
  function insert(value) {
    const key = hash(value);
    let position = BigInt('0x' + value);
    if (layers[DEPTH].has(position)) throw new Error('nullifier already consumed');
    layers[DEPTH].set(position, tagged('nullifier-used-leaf', key));
    const siblings = [];
    for (let depth = DEPTH; depth > 0; depth--) {
      siblings.push(hex(get(depth, position ^ 1n)));
      position >>= 1n;
      layers[depth - 1].set(position, branch(get(depth, position << 1n), get(depth, (position << 1n) | 1n)));
    }
    return { nullifier: value, siblings };
  }
  previousKeys.forEach(insert);
  const oldNullifierRoot = hex(get(0, 0n));
  return { oldNullifierRoot, paths: orderedKeys.map(insert) };
}

module.exports = { exportTrade, prepareBatch, assembleWitness, buildNullifierPaths };
