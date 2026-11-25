'use strict';

const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync } = require('node:crypto');
const path = require('node:path');
const { canonicalJson } = require('../../bitvm3/utxo_referee/dlc_canonical_json');
const { createDlcContract, ALL_EVIDENCE_KINDS, signValidationReceipt } = require('../../bitvm3/utxo_referee/dlc_contract_state');
const { DlcStateStore } = require('../../bitvm3/utxo_referee/dlc_state_store');
const { DlcBroadcastAuthorizationStore } = require('../../bitvm3/utxo_referee/dlc_broadcast_authorization_store');
const { DlcWatchtowerJournal } = require('../../bitvm3/utxo_referee/dlc_watchtower_journal');
const { captureDlcChainSnapshot } = require('../../bitvm3/utxo_referee/dlc_bitcoin_core_observer');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => sha256(canonicalJson(value));
const evidence = (value) => ({ digest: digest(value) });

function createRegtestState(directory, plan) {
  assert.equal(plan.terms.network, 'bitcoin-regtest');
  const store = new DlcStateStore(path.join(directory, 'state'));
  const authorizations = new DlcBroadcastAuthorizationStore(path.join(directory, 'broadcast-authorizations'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const keyPin = { keyId: sha256(spki), publicKeySpki: spki.toString('base64') };
  const validatorPolicy = Object.fromEntries(ALL_EVIDENCE_KINDS.map((kind) => [kind, keyPin]));
  const initial = createDlcContract({
    contractId: plan.contractId, contractDigest: plan.planDigest, network: plan.terms.network, validatorPolicy,
    oraclePolicy: {
      threshold: plan.terms.oracleThreshold, total: plan.terms.oraclePubkeys.length,
      pinnedPubkeys: plan.terms.oraclePubkeys, eventId: plan.terms.oracleEventId,
      outcomeMessages: plan.outcomes.map(({ outcomeMessage }) => outcomeMessage)
    }
  });
  store.create(initial);
  let current = store.read(plan.contractId);

  function request(to, receipts) {
    const idempotencyKey = 'regtest-' + to.toLowerCase();
    return {
      to, idempotencyKey,
      evidence: Object.entries(receipts).map(([kind, receipt]) => signValidationReceipt({
        privateKey, from: current.stage, to, idempotencyKey, contractId: current.contractId,
        contractDigest: current.contractDigest, kind, ...receipt
      }))
    };
  }

  return {
    get current() { return current; },
    advance(to, receipts) {
      current = store.transition(plan.contractId, current.revision, request(to, receipts));
    },
    broadcast({ rpc, to, rawTxHex, expectedTxid, receipts }) {
      assert.equal(rpc('getblockchaininfo').chain, 'regtest');
      const transitionRequest = request(to, receipts);
      const { consumption, nextContractState } = authorizations.consume({ contractState: current, transitionRequest, rawTxHex });
      assert.equal(consumption.txid, expectedTxid);
      // The guards already verified the exact bytes and the stable state.
      // This disposable node has no peers or other writers.
      assert.equal(rpc('sendrawtransaction', [rawTxHex]), expectedTxid);
      current = store.transition(plan.contractId, current.revision, transitionRequest);
      assert.equal(current.recordHash, nextContractState.recordHash);
      return consumption;
    },
    verify() {
      return { state: store.checkpoint(plan.contractId), authorizations: authorizations.verifyAll().records };
    }
  };
}

function createWatchtower(directory, transactionSet, rpc) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const options = { watchtowerId: 'lnmarkets-regtest', publicKey };
  const journalDirectory = path.join(directory, 'watchtower');
  const journal = new DlcWatchtowerJournal(journalDirectory, { ...options, privateKey });
  let previous = null;
  return {
    publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    observe(contractState) {
      const snapshot = captureDlcChainSnapshot({ contractState, transactionSet, rpc, previous });
      const record = journal.appendObservation({ contractState, transactionSet, snapshot, minConfirmations: 1 });
      previous = snapshot;
      return record;
    },
    observeAnchor(contractState, settlementTxid, options) {
      return journal.appendBitcoinCoreAnchorObservation({ contractState, transactionSet, rpc, settlementTxid, ...options });
    },
    verify(contractId) {
      const reopened = new DlcWatchtowerJournal(journalDirectory, options);
      return { checkpoint: reopened.checkpoint(contractId), alerts: reopened.alerts(contractId) };
    }
  };
}

module.exports = { digest, evidence, createRegtestState, createWatchtower };
