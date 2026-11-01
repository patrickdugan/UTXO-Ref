'use strict';

// Off-chain V2 referee adapter for a single funded BitVM assertion UTXO.
// This is a pre-proving inspection, not a proof verifier or spend authority.
const { createHash } = require('node:crypto');
const v2 = require('../bitvm3/utxo_referee/utxoref_v2.js');
const codec = require('./statement.cjs');
const tr = require('../bitvm3/utxo_referee/tradelayer_taproot.js');

const HASH32 = /^[0-9a-f]{64}$/;
const P2TR = /^5120[0-9a-f]{64}$/;
const MAX_U64 = (1n << 64n) - 1n;

function hex32(value, name) {
  if (typeof value !== 'string' || !HASH32.test(value)) {
    throw new TypeError(name + ' must be lowercase 32-byte hex');
  }
  return value;
}

function canonicalAmount(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)
      || BigInt(value) > MAX_U64) {
    throw new TypeError('assertionAmountSats must be a canonical positive u64 string');
  }
  return value;
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('externally pinned policy required');
  }
  for (const name of ['programHash', 'verifyingKeyHash', 'policyHash', 'assertionTxid']) {
    hex32(policy[name], name);
  }
  if (!Number.isInteger(policy.assertionVout) || Object.is(policy.assertionVout, -0)
      || policy.assertionVout < 0 || policy.assertionVout > 0xffffffff) {
    throw new TypeError('invalid assertionVout');
  }
  canonicalAmount(policy.assertionAmountSats);
  if (typeof policy.assertionScriptPubKeyHex !== 'string'
      || !P2TR.test(policy.assertionScriptPubKeyHex)) {
    throw new TypeError('assertionScriptPubKeyHex must be a canonical P2TR script');
  }
  const trust = policy.stateVerification;
  if (!trust || typeof trust !== 'object' || !trust.trustedSigners
      || !trust.expectedGenesisHash || !trust.expectedNetwork
      || trust.currentHeight === undefined || trust.currentHeight === null) {
    throw new TypeError('checkpoint trust pins, network, genesis and currentHeight required');
  }
  if (!Number.isSafeInteger(trust.currentHeight) || trust.currentHeight < 0
      || trust.currentHeight > 0xffffffff) {
    throw new TypeError('currentHeight must be an unsigned u32');
  }
  hex32(trust.expectedGenesisHash, 'expectedGenesisHash');
  if (!['bitcoin-testnet4', 'bitcoin-regtest'].includes(trust.expectedNetwork)) {
    throw new TypeError('unsupported expectedNetwork');
  }
  return policy;
}

function bitcoinTxid(unsignedTxHex) {
  // V2 strictUnsignedTx() canonicalizes the non-witness serialized transaction.
  const bytes = Buffer.from(unsignedTxHex, 'hex');
  const first = createHash('sha256').update(bytes).digest();
  return Buffer.from(createHash('sha256').update(first).digest()).reverse().toString('hex');
}

function inspectV2Settlement(settlement, suppliedPolicy) {
  const policy = validatePolicy(suppliedPolicy);
  const result = v2.verifyUtxoRefSettlementV2(settlement, {
    stateVerification: policy.stateVerification
  });
  if (!result.ok) {
    throw new Error('V2 referee rejected settlement: ' + result.reason);
  }

  // V2's fundingOutpoints are the settlement's actual inputs. Stage 1 uses
  // precisely one funded assertion output as that input. The upstream
  // deposit-to-assertion graph is a different verification obligation.
  if (!Array.isArray(settlement.fundingOutpoints) || settlement.fundingOutpoints.length !== 1) {
    throw new Error('single assertion funding input required');
  }
  const funding = v2.normalizeFundingOutpoint(settlement.fundingOutpoints[0], 0);
  if (funding.txid !== policy.assertionTxid || funding.vout !== policy.assertionVout) {
    throw new Error('assertion outpoint does not match V2 funding input');
  }
  if (funding.amountSats !== policy.assertionAmountSats
      || funding.scriptPubKeyHex !== policy.assertionScriptPubKeyHex) {
    throw new Error('assertion value or Taproot script differs from pinned funding');
  }

  const core = settlement.commitment.core;
  if (core.fundingCount !== 1 || core.fundingTotalSats !== policy.assertionAmountSats) {
    throw new Error('commitment funding does not match pinned assertion');
  }
  if (core.network !== policy.stateVerification.expectedNetwork
      || core.chainGenesisHash !== policy.stateVerification.expectedGenesisHash) {
    throw new Error('pinned chain does not match commitment');
  }
  const tx = v2.strictUnsignedTx(settlement.unsignedTxHex);
  const outpointBytes = tr.outpoint(policy.assertionTxid, policy.assertionVout);
  if (tx.vin.length !== 1 || tx.vin[0].outpoint.toString('hex') !== outpointBytes) {
    throw new Error('settlement must spend exactly the assertion outpoint');
  }
  const statement = {
    kind: 'utxoref_l2_settlement_groth16_v0',
    version: 0,
    network: core.network,
    chainGenesisHash: core.chainGenesisHash,
    contractId: core.contractId,
    commitmentHash: result.commitmentHash,
    assertionTxid: policy.assertionTxid,
    settlementTxid: bitcoinTxid(settlement.unsignedTxHex),
    programHash: policy.programHash,
    verifyingKeyHash: policy.verifyingKeyHash,
    policyHash: policy.policyHash,
    epochId: core.epochId,
    assertionVout: policy.assertionVout
  };
  const inspection = codec.inspectStatementV0(statement);
  return Object.freeze({
    ...inspection,
    status: 'V2_OFFCHAIN_CHECKED_ONLY',
    v2RefereeChecked: true,
    proofVerified: false,
    settlementAuthorized: false
  });
}

module.exports = Object.freeze({ inspectV2Settlement });
