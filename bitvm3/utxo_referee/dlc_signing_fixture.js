'use strict';

/**
 * TEST SUPPORT ONLY - builds a signable DLC fixture for tests, evals and the
 * native signer's cross-implementation vectors.
 *
 * Returns a validated two-party transaction set whose CETs use a threshold
 * subset of the given oracle announcements, a signing context naming one
 * CET, and the receipt digests a contract must carry for that context to be
 * signable (see dlc_signing_target.js). Contract construction stays with the
 * caller, because each suite signs its receipts differently.
 */

const { serializeUnsignedTx, outpoint } = require('./tradelayer_taproot');
const { xOnlyPubkey } = require('./tradelayer_dlc_adaptor_sig');
const { buildDlcFundingOutput, dlcFundingFields } = require('./dlc_funding_output');
const { validateDlcTransactionSet } = require('./dlc_transaction_validator');
const { buildThresholdOutcomeSets } = require('./dlc_threshold_oracle');
const { normalizeOracleAnnouncements, oracleAnnouncementSetDigest } = require('./dlc_signing_target');

const REFUND_CSV_BLOCKS = 144;

// Each party is given by its secret or, when only the public key is known
// (a provisioned native signer), by signerPubkeyX / counterpartyPubkeyX.
function buildDlcSigningFixture({
  signerSecret,
  signerPubkeyX,
  counterpartySecret,
  counterpartyPubkeyX,
  announcements,
  threshold = 2,
  fundingTxid = 'a1'.repeat(32),
  fundingVout = 0
}) {
  const normalizedAnnouncements = normalizeOracleAnnouncements(announcements);
  const pinnedPubkeys = normalizedAnnouncements.map((announcement) => announcement.px);
  const keyOf = (secret, pubkeyX) => pubkeyX || xOnlyPubkey(secret).toString('hex');
  const partyPubkeyXs = [keyOf(signerSecret, signerPubkeyX), keyOf(counterpartySecret, counterpartyPubkeyX)].sort();
  const output = buildDlcFundingOutput({ partyPubkeyXs, refundCsvBlocks: REFUND_CSV_BLOCKS });
  const funding = { txid: fundingTxid, vout: fundingVout, valueSats: 100000n, ...dlcFundingFields(output) };
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: 330n, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  const raw = (outputs, locktime, sequence) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence }],
    outputs.map((item) => ({ valueSats: item.valueSats, script: item.scriptPubKeyHex })),
    locktime
  );
  const outcomes = normalizedAnnouncements[0].outcomeMessages;
  const cets = outcomes.map((outcomeMessage, index) => {
    const subset = buildThresholdOutcomeSets({
      announcements: normalizedAnnouncements,
      threshold,
      pinnedPubkeys,
      outcomeMsg32: Buffer.from(outcomeMessage, 'hex')
    })[0];
    const outputs = [
      { valueSats: 59000n - BigInt(index) * 1000n, scriptPubKeyHex: `0014${'55'.repeat(20)}` },
      { valueSats: 40000n + BigInt(index) * 1000n, scriptPubKeyHex: `0014${'66'.repeat(20)}` },
      anchor
    ];
    return {
      outcomeMessage,
      oraclePubkeys: [...subset.oraclePubkeys],
      rawTxHex: raw(outputs, 100, 0xfffffffe),
      expectedOutputs: outputs,
      locktime: 100
    };
  });
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'77'.repeat(32)}` }, anchor];
  const transactionSet = validateDlcTransactionSet({
    funding,
    cets,
    refund: { rawTxHex: raw(refundOutputs, 200, REFUND_CSV_BLOCKS), expectedOutputs: refundOutputs, locktime: 200 },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  const cetTxid = transactionSet.cets.find((cet) => cet.outcomeMessage === outcomes[0]).txid;
  return Object.freeze({
    transactionSet,
    oracleAnnouncements: normalizedAnnouncements,
    signingContext: Object.freeze({ transactionSet, cetTxid, oracleAnnouncements: normalizedAnnouncements }),
    cetTxid,
    partyPubkeyXs,
    // Pass as receipt digests when advancing the contract.
    receiptDigests: Object.freeze({
      oracle_policy: oracleAnnouncementSetDigest(normalizedAnnouncements),
      cet_set: transactionSet.cetSetDigest,
      funding_template: transactionSet.fundingTemplateDigest,
      refund_transaction: transactionSet.refundTransactionDigest,
      fee_policy: transactionSet.feePolicyDigest
    })
  });
}

module.exports = { REFUND_CSV_BLOCKS, buildDlcSigningFixture };
