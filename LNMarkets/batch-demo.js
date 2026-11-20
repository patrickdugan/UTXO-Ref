#!/usr/bin/env node
'use strict';

// Only deterministic public fixture keys and synthetic outpoints enter this demo.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { xOnlyPubkey, buildDlcOracle, dlcAttest, bytes32, schnorrSign } =
  require('../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig');
const { buildContractPlan } = require('./src/contract');
const { buildDemoScenario } = require('./fixtures/demo-scenario');
const { buildSettlementPackage, createResearchPartySignatures, finalizeRecoveryPackage } = require('./src/settlement');
const { exportTrade, prepareBatch, assembleWitness, buildNullifierPaths } = require('./src/batch');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sign = (key, digest) => schnorrSign(key, Buffer.from(digest, 'hex'), Buffer.alloc(32)).toString('hex');

function createFixtureTrades() {
  const { plan: base, partySecrets } = buildDemoScenario();
  const oracleSecrets = [31n, 32n, 33n];
  return [2, 0].map((outcomeIndex, i) => {
    const plan = buildContractPlan({
      ...base.terms, quoteId: 'batch-demo-' + i, oracleEventId: 'lnm/batch-demo/event-' + i,
      maturityHeight: base.terms.maturityHeight + i
    });
    const fundingOutpoint = { txid: sha256('synthetic lnmarkets batch funding ' + i), vout: i + 1 };
    const oracleAnnouncements = oracleSecrets.map((secret, j) => buildDlcOracle(secret, BigInt(201 + i * 3 + j), {
      eventId: plan.terms.oracleEventId,
      outcomeMessages: plan.outcomes.map(({ outcomeMessage }) => Buffer.from(outcomeMessage, 'hex'))
    }));
    const settlementPackage = buildSettlementPackage({ plan, fundingOutpoint, oracleAnnouncements });
    const partySignatures = partySecrets.map((partySecret) => createResearchPartySignatures({
      settlementPackage, partySecret, acknowledgeResearchCrypto: true
    }));
    const recoveryPackage = finalizeRecoveryPackage({ settlementPackage, partySignatures });
    const outcomeId = plan.outcomes[outcomeIndex].outcomeMessage;
    const attestations = oracleAnnouncements.slice(0, 2).map((oracle) => ({
      oraclePubkeyX: oracle.px, scalarHex: bytes32(dlcAttest(oracle, Buffer.from(outcomeId, 'hex'))).toString('hex')
    }));
    const pins = { expectedPlanId: plan.planDigest, expectedRecoveryDigest: recoveryPackage.recoveryDigest, fundingOutpoint };
    const exportInput = { recoveryPackage, pins, outcomeId, attestations, salt: sha256('public fixture salt ' + i) };
    return { exportInput, trade: exportTrade(exportInput), partySecrets, oracleSecrets };
  });
}

function buildDemoBatch(fixtures) {
  const byNullifier = new Map(fixtures.map((fixture) => [fixture.trade.nullifier, fixture]));
  const orderedKeys = [...fixtures].sort((a, b) => a.trade.summary.fundingTxid < b.trade.summary.fundingTxid ? -1 : 1)
    .map(({ trade }) => trade.nullifier);
  const previousKey = sha256('previously accepted synthetic authorization');
  const { oldNullifierRoot, paths } = buildNullifierPaths([previousKey], orderedKeys);
  const inputs = {
    epoch: '2', batchId: sha256('lnmarkets-local-batch-demo-v1'), evaluationHeight: 1001,
    validUntilHeight: 1010, oldNullifierRoot, paths, trades: fixtures.map(({ trade }) => trade)
  };
  const proposal = prepareBatch(inputs);
  const signedRows = proposal.nullifiers.map((nullifier, index) => {
    const { trade, partySecrets, oracleSecrets } = byNullifier.get(nullifier);
    const oracleKeys = new Map(oracleSecrets.map((key) => [xOnlyPubkey(key).toString('hex'), key]));
    return {
      nullifier,
      summarySignatures: partySecrets.map((key) => sign(key, trade.summaryDigest)),
      oracleSignatures: trade.oracleIndices.map((i) => sign(oracleKeys.get(trade.summary.oracleKeys[i]), trade.oracleDigest)),
      batchSignatures: partySecrets.map((key) => sign(key, proposal.consentDigests[index]))
    };
  });
  return { inputs, proposal, signedRows, witness: assembleWitness(proposal, signedRows), previousKey };
}

function runDemo(output) {
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.mkdirSync(output, { mode: 0o700 });
  const { proposal, witness } = buildDemoBatch(createFixtureTrades());
  const write = (file, bytes) => fs.writeFileSync(path.join(output, file), bytes, { mode: 0o600, flag: 'wx' });
  write('witness.bin', witness);
  write('expected-journal.bin', Buffer.from(proposal.expectedJournalHex, 'hex'));
  write('unsigned-batch.bin', Buffer.from(proposal.unsignedTxHex, 'hex'));
  const summary = {
    status: 'prepared_unproved', network: 'bitcoin-regtest', ...proposal,
    witnessBytes: witness.length, witnessSha256: sha256(witness), journalBytes: proposal.expectedJournalHex.length / 2
  };
  write('proposal.json', JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (require.main === module) {
  const [, , flag, output, ...extra] = process.argv;
  try {
    if (flag !== '--out' || !output || extra.length) throw new Error('Usage: node LNMarkets/batch-demo.js --out NEW_DIRECTORY');
    console.log(JSON.stringify(runDemo(path.resolve(output)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createFixtureTrades, buildDemoBatch };
