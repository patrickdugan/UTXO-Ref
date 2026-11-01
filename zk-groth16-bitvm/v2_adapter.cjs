'use strict';
// Off-chain V2 referee adapter. No proof verification or spend authority.
const { createHash } = require('node:crypto');
const v2 = require('../bitvm3/utxo_referee/utxoref_v2.js');
const codec = require('./statement.cjs');
const tr = require('../bitvm3/utxo_referee/tradelayer_taproot.js');
const HASH = /^[0-9a-f]{64}$/;
const REQUIRED = ['programHash', 'verifyingKeyHash', 'policyHash'];
function hex32(x, name) {
  if (typeof x !== 'string' || !HASH.test(x)) throw new TypeError(`${name} must be lowercase 32-byte hex`);
  return x;
}
function txid(rawHex) {
  const raw = Buffer.from(rawHex, 'hex');
  const first = createHash('sha256').update(raw).digest();
  return Buffer.from(createHash('sha256').update(first).digest()).reverse().toString('hex');
}
function inspectV2Settlement(settlement, policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new TypeError('externally pinned policy required');
  for (const key of REQUIRED) hex32(policy[key], key);
  const assertionTxid = hex32(policy.assertionTxid, 'assertionTxid');
  if (!Number.isInteger(policy.assertionVout) || Object.is(policy.assertionVout, -0) || policy.assertionVout < 0 || policy.assertionVout > 0xffffffff) throw new TypeError('invalid assertionVout');
  if (!policy.stateVerification || !policy.stateVerification.trustedSigners || !policy.stateVerification.expectedGenesisHash || !policy.stateVerification.expectedNetwork || policy.stateVerification.currentHeight === undefined) {
    throw new TypeError('checkpoint trust pins, network, genesis and currentHeight required');
  }
  const verified = v2.verifyUtxoRefSettlementV2(settlement, { stateVerification: policy.stateVerification });
  if (!verified.ok) throw new Error(`V2 referee rejected settlement: ${verified.reason}`);
  const core = settlement.commitment.core;
  if (core.network !== policy.stateVerification.expectedNetwork || core.chainGenesisHash !== policy.stateVerification.expectedGenesisHash) throw new Error('pinned chain does not match commitment');
  const raw = settlement.unsignedTxHex;
  const tx = v2.strictUnsignedTx(raw);
  const expectedOutpoint = tr.outpoint(assertionTxid, policy.assertionVout);
  const matches = tx.vin.filter(input => input.outpoint.toString('hex') === expectedOutpoint);
  if (matches.length !== 1) throw new Error('exact assertion outpoint must be spent once');
  const statement = {
    kind: 'utxoref_l2_settlement_groth16_v0', version: 0,
    network: core.network, chainGenesisHash: core.chainGenesisHash,
    contractId: core.contractId, commitmentHash: verified.commitmentHash,
    assertionTxid, settlementTxid: txid(raw),
    programHash: policy.programHash, verifyingKeyHash: policy.verifyingKeyHash,
    policyHash: policy.policyHash, epochId: core.epochId,
    assertionVout: policy.assertionVout
  };
  const inspection = codec.inspectStatementV0(statement);
  return Object.freeze({ ...inspection, status: 'V2_OFFCHAIN_CHECKED_ONLY',
    proofVerified: false, settlementAuthorized: false,
    v2RefereeChecked: true });
}
module.exports = Object.freeze({ inspectV2Settlement });
