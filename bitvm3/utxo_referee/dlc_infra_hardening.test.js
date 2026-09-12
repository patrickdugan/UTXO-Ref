'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dlc = require('./tradelayer_dlc_adaptor_sig');
const {
  ALL_EVIDENCE_KINDS,
  REQUIRED_EVIDENCE,
  createDlcContract,
  signValidationReceipt,
  validateDlcContract,
  transitionDlcContract
} = require('./dlc_contract_state');
const { DlcStateStore } = require('./dlc_state_store');
const {
  validateOracleSet,
  buildThresholdOutcomeSets,
  combineThresholdAttestations
} = require('./dlc_threshold_oracle');
const { validateFundingAuthorization } = require('./m1_dlc_sign_finalize');
const { createDlcCryptoProvider, requireDlcSigningProvider } = require('./dlc_crypto_provider');
const { DlcOracleEventStore } = require('./dlc_oracle_event_store');
const { serializeUnsignedTx, outpoint, bip341SighashDefault } = require('./tradelayer_taproot');
const { parseCanonicalUnsignedTransaction, validateDlcTransactionSet } = require('./dlc_transaction_validator');
const {
  toBip341Transaction,
  cetIdentity,
  validateCetAdaptorSignatures,
  validateRefundSignature
} = require('./dlc_signature_validator');
const { evaluateDlcChainSnapshot } = require('./dlc_chain_guard');
const { captureDlcAnchorRecoverySnapshot, observeAndEvaluateDlcChain } = require('./dlc_bitcoin_core_observer');
const {
  TESTNET4_CHAIN_HASH,
  TYPES: PEER_MESSAGE_TYPES,
  computeDlcContractId,
  computeOraclePolicyDigest,
  signDlcPeerMessage,
  validateDlcPeerTranscript
} = require('./dlc_peer_transcript');
const { DlcPeerSessionStore } = require('./dlc_peer_session_store');
const { DlcWatchtowerJournal, contractKey: watchtowerContractKey } = require('./dlc_watchtower_journal');
const { settlementAnchor, evaluateDlcAnchorRecovery } = require('./dlc_anchor_recovery_guard');

let passed = 0;
let failed = 0;
function test(name, run) {
  try {
    run();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
    failed++;
  }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
function expectThrow(run, pattern) {
  try { run(); } catch (error) { if (pattern.test(error.message)) return; throw error; }
  throw new Error(`expected error matching ${pattern}`);
}
function hash(label) { return crypto.createHash('sha256').update(label).digest(); }
function digest(label) { return hash(label).toString('hex'); }
const validatorKeys = crypto.generateKeyPairSync('ed25519');
const validatorPublicKeySpki = validatorKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const validatorKeyId = crypto.createHash('sha256').update(Buffer.from(validatorPublicKeySpki, 'base64')).digest('hex');
const validatorPolicy = Object.fromEntries(ALL_EVIDENCE_KINDS.map((kind) => [kind, {
  keyId: validatorKeyId,
  publicKeySpki: validatorPublicKeySpki
}]));

function requestFor(contract, to, suffix = to, overrides = {}) {
  const idempotencyKey = `transition:${suffix}`;
  return {
    to,
    idempotencyKey,
    evidence: REQUIRED_EVIDENCE[to].map((kind) => signValidationReceipt({
      privateKey: validatorKeys.privateKey,
      contractId: contract.contractId,
      contractDigest: contract.contractDigest,
      from: contract.stage,
      to,
      idempotencyKey,
      kind,
      digest: overrides[kind] || digest(`${to}:${kind}`)
    }))
  };
}

const oracleSecrets = [101n, 202n, 303n];
const nonceSeeds = [1001n, 2002n, 3003n];
const outcome = hash('threshold-event:yes');
const otherOutcome = hash('threshold-event:no');
const announcements = oracleSecrets.map((secret, index) => dlc.buildDlcOracle(secret, nonceSeeds[index], {
  eventId: 'threshold-event',
  outcomeMessages: [outcome, otherOutcome]
}));
const pinnedPubkeys = announcements.map((announcement) => announcement.px);

console.log('\n=== DLC Infrastructure Hardening Tests ===\n');

test('2-of-3 oracle set produces three canonical adaptor combinations', () => {
  const policy = validateOracleSet(announcements, 2, pinnedPubkeys);
  const sets = buildThresholdOutcomeSets({ announcements, threshold: 2, pinnedPubkeys, outcomeMsg32: outcome });
  assert(policy.threshold === 2 && policy.total === 3, 'wrong threshold policy');
  assert(sets.length === 3, '2-of-3 must produce three oracle subsets');
  assert(new Set(sets.map((set) => set.oraclePubkeys.join(':'))).size === 3, 'subsets must be unique');
});

test('any valid two-oracle subset completes its matching adaptor signature', () => {
  const signerSecret = 909n;
  const publicKey = dlc.xOnlyPubkey(signerSecret);
  const cetMessage = hash('threshold-cet');
  const sets = buildThresholdOutcomeSets({ announcements, threshold: 2, pinnedPubkeys, outcomeMsg32: outcome });
  const byKey = new Map(announcements.map((announcement, index) => [announcement.px, { announcement, index }]));
  for (const set of sets) {
    const presignature = dlc.adaptorSign(signerSecret, cetMessage, set.outcomePoint, hash(`aux:${set.oraclePubkeys.join(':')}`));
    const subset = set.oraclePubkeys.map((key) => byKey.get(key));
    const attestations = subset.map(({ announcement }) => dlc.dlcAttest(announcement, outcome));
    const combined = combineThresholdAttestations({
      announcements,
      threshold: 2,
      pinnedPubkeys,
      outcomeMsg32: outcome,
      attestations,
      oraclePubkeys: set.oraclePubkeys
    });
    const signature = dlc.adaptorComplete(presignature, combined.scalar);
    assert(dlc.schnorrVerify(publicKey, cetMessage, signature), 'threshold-completed CET signature failed');
  }
});

test('threshold policy rejects one attestation, duplicates, and unpinned sets', () => {
  const attestation = dlc.dlcAttest(announcements[0], outcome);
  expectThrow(() => combineThresholdAttestations({
    announcements,
    threshold: 2,
    pinnedPubkeys,
    outcomeMsg32: outcome,
    attestations: [attestation],
    oraclePubkeys: [announcements[0].px]
  }), /exactly 2/);
  expectThrow(() => combineThresholdAttestations({
    announcements,
    threshold: 2,
    pinnedPubkeys,
    outcomeMsg32: outcome,
    attestations: [attestation, attestation],
    oraclePubkeys: [announcements[0].px, announcements[0].px]
  }), /duplicate/);
  expectThrow(() => validateOracleSet(announcements, 2, [pinnedPubkeys[0], pinnedPubkeys[1], '11'.repeat(32)]), /pinned/);
});

function initialContract(contractId = 'contract-1') {
  return createDlcContract({
    contractId,
    network: 'bitcoin-testnet4',
    contractDigest: digest(`contract:${contractId}`),
    oraclePolicy: { threshold: 2, total: 3, pinnedPubkeys },
    validatorPolicy
  });
}

test('state machine rejects skipped stages and missing validation receipts', () => {
  const contract = initialContract();
  expectThrow(() => transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND')), /invalid DLC transition/);
  const incomplete = requestFor(contract, 'AUTHENTICATED_ORACLES');
  expectThrow(() => transitionDlcContract(contract, {
    ...incomplete,
    evidence: []
  }), /evidence must contain|requires oracle_policy/);
});

test('state machine reaches funding approval only through every required gate', () => {
  let contract = initialContract('ordered-contract');
  const stages = [
    'AUTHENTICATED_ORACLES',
    'CANONICAL_CETS_AND_REFUND',
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED',
    'FUNDING_PSBT_APPROVED'
  ];
  let oracleRequest;
  for (const stage of stages) {
    const stageRequest = requestFor(contract, stage);
    if (stage === 'AUTHENTICATED_ORACLES') oracleRequest = stageRequest;
    contract = transitionDlcContract(contract, stageRequest);
  }
  assert(contract.stage === 'FUNDING_PSBT_APPROVED' && contract.revision === 5, 'funding approval ordering failed');
  assert(validateDlcContract(contract), 'ordered contract did not validate');
  const repeated = transitionDlcContract(contract, oracleRequest);
  assert(repeated === contract, 'identical transition retry must be idempotent');
  const altered = JSON.parse(JSON.stringify(oracleRequest));
  altered.evidence[0].digest = digest('different-policy');
  expectThrow(() => transitionDlcContract(contract, altered), /signature is invalid|idempotency key/);
});

test('state hash detects transition evidence tampering', () => {
  const initial = initialContract('tamper-contract');
  const advanced = transitionDlcContract(initial, requestFor(initial, 'AUTHENTICATED_ORACLES'));
  const tampered = JSON.parse(JSON.stringify(advanced));
  tampered.history[0].evidence[0].digest = '00'.repeat(32);
  expectThrow(() => validateDlcContract(tampered), /hash mismatch|request or prior transcript/);
});

test('append-only store survives reload and rejects stale revisions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-dlc-state-'));
  try {
    const store = new DlcStateStore(directory);
    const initial = initialContract('stored-contract');
    store.create(initial);
    const oracleRequest = requestFor(initial, 'AUTHENTICATED_ORACLES');
    const advanced = store.transition(initial.contractId, 0, oracleRequest);
    assert(advanced.revision === 1, 'store did not advance');
    const reloaded = new DlcStateStore(directory).read(initial.contractId);
    assert(reloaded.recordHash === advanced.recordHash, 'reloaded state differs');
    expectThrow(() => store.transition(initial.contractId, 0, requestFor(advanced, 'CANONICAL_CETS_AND_REFUND')), /stale DLC state revision/);
    const replay = store.transition(initial.contractId, 0, oracleRequest);
    assert(replay.recordHash === advanced.recordHash, 'idempotent stale retry should return committed state');
    const chain = store.verifyChain(initial.contractId);
    assert(chain.ok && chain.revisions === 2, 'append-only revision chain failed');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('wallet funding signing is bound to an approved PSBT digest and network', () => {
  const psbtBytes = Buffer.from('70736274ff01020304', 'hex');
  const psbt = psbtBytes.toString('base64');
  let contract = initialContract('funding-gate-contract');
  const stages = [
    'AUTHENTICATED_ORACLES',
    'CANONICAL_CETS_AND_REFUND',
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED'
  ];
  for (const stage of stages) contract = transitionDlcContract(contract, requestFor(contract, stage, `funding:${stage}`));
  contract = transitionDlcContract(contract, requestFor(
    contract,
    'FUNDING_PSBT_APPROVED',
    'funding-approved',
    { funding_psbt_validation: crypto.createHash('sha256').update(psbtBytes).digest('hex') }
  ));
  const funding = { chain: { network: 'testnet4' }, funding: { psbt } };
  const authorization = validateFundingAuthorization(contract, funding);
  assert(authorization.psbt === psbt && authorization.stateRecordHash === contract.recordHash, 'funding authorization failed');
  expectThrow(() => validateFundingAuthorization(contract, {
    ...funding,
    funding: { psbt: Buffer.from('70736274ff09090909', 'hex').toString('base64') }
  }), /does not match/);
  expectThrow(() => validateFundingAuthorization(contract, {
    ...funding,
    chain: { network: 'main' }
  }), /network must be testnet4/);
});

test('crypto provider defaults closed and confines JavaScript secrets to explicit test mode', () => {
  const disabled = createDlcCryptoProvider({ network: 'bitcoin-testnet4' });
  assert(disabled.mode === 'disabled' && Object.keys(disabled.operations).length === 0, 'default provider must be disabled');
  expectThrow(() => createDlcCryptoProvider({ network: 'bitcoin-testnet4', mode: 'experimental-js' }), /allowExperimental/);
  expectThrow(() => createDlcCryptoProvider({
    network: 'bitcoin-mainnet',
    mode: 'experimental-js',
    allowExperimental: true
  }), /mainnet/);
  const research = createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'experimental-js',
    allowExperimental: true
  });
  assert(requireDlcSigningProvider(research) === research, 'explicit research provider was rejected');
  assert(research.productionReady === false && research.capabilities.nativeSecretArithmetic === false, 'research provider overstated security');
});

test('native provider rejects incomplete security capability claims', () => {
  expectThrow(() => createDlcCryptoProvider({
    network: 'bitcoin-testnet4',
    mode: 'native-isolated',
    implementation: { capabilities: { apiVersion: 1 } }
  }), /capability manifest/);
});

test('sealed oracle event survives restart and persists before attestation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-oracle-state-'));
  const wrappingKey = hash('oracle-wrapping-key');
  try {
    const firstStore = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey,
      network: 'bitcoin-testnet4'
    });
    const eventOutcome = hash('persistent-oracle:yes');
    const conflictingOutcome = hash('persistent-oracle:no');
    const announcement = firstStore.createEvent({
      oracleSecret: 707n,
      nonceSeed: 808n,
      eventId: 'persistent-oracle-event',
      outcomeMessages: [eventOutcome, conflictingOutcome]
    });
    firstStore.close();

    const restartedStore = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey,
      network: 'bitcoin-testnet4'
    });
    const restoredAnnouncement = restartedStore.getAnnouncement({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId
    });
    assert(restoredAnnouncement.signature === announcement.signature, 'announcement changed after restart');
    const attestation = restartedStore.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: eventOutcome
    });
    assert(dlc.verifyDlcAttestation(restoredAnnouncement, eventOutcome, attestation), 'restored attestation failed');
    const retry = restartedStore.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: eventOutcome
    });
    assert(retry === attestation, 'restored identical retry was not idempotent');
    expectThrow(() => restartedStore.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: conflictingOutcome
    }), /conflicting outcome/);
    const chain = restartedStore.verifyChain({ oraclePubkey: announcement.px, eventId: announcement.eventId });
    assert(chain.ok && chain.revisions === 2, 'oracle event state was not append-only');
    restartedStore.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sealed oracle state rejects the wrong wrapping key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-oracle-wrong-key-'));
  try {
    const outcomeMessage = hash('wrong-key:outcome');
    const creator = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey: hash('correct-wrapping-key'),
      network: 'bitcoin-testnet4'
    });
    const announcement = creator.createEvent({
      oracleSecret: 919n,
      nonceSeed: 929n,
      eventId: 'wrong-key-event',
      outcomeMessages: [outcomeMessage]
    });
    creator.close();
    const wrong = new DlcOracleEventStore({
      baseDirectory: directory,
      wrappingKey: hash('wrong-wrapping-key'),
      network: 'bitcoin-testnet4'
    });
    expectThrow(() => wrong.attest({
      oraclePubkey: announcement.px,
      eventId: announcement.eventId,
      outcomeMsg32: outcomeMessage
    }), /authentication failed/);
    wrong.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function transactionFixture() {
  const funding = {
    txid: 'aa'.repeat(32),
    vout: 1,
    valueSats: 100000n,
    scriptPubKeyHex: `5120${'44'.repeat(32)}`
  };
  const leftScript = `0014${'55'.repeat(20)}`;
  const rightScript = `0014${'66'.repeat(20)}`;
  const refundScript = `5120${'77'.repeat(32)}`;
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: feePolicy.anchorAmountSats, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  const spend = (outputs, locktime, sequence = 0xfffffffe, fundingTxid = funding.txid) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(fundingTxid, funding.vout), sequence }],
    outputs.map((output) => ({ valueSats: output.valueSats, script: output.scriptPubKeyHex })),
    locktime
  );
  const firstOutputs = [
    { valueSats: 59000n, scriptPubKeyHex: leftScript },
    { valueSats: 40000n, scriptPubKeyHex: rightScript },
    anchor
  ];
  const secondOutputs = [
    { valueSats: 39000n, scriptPubKeyHex: leftScript },
    { valueSats: 60000n, scriptPubKeyHex: rightScript },
    anchor
  ];
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: refundScript }, anchor];
  return {
    funding,
    cets: [
      {
        outcomeMessage: digest('transaction-outcome:left'),
        oraclePubkeys: ['11'.repeat(32), '22'.repeat(32)],
        rawTxHex: spend(firstOutputs, 100),
        expectedOutputs: firstOutputs,
        locktime: 100
      },
      {
        outcomeMessage: digest('transaction-outcome:right'),
        oraclePubkeys: ['11'.repeat(32), '33'.repeat(32)],
        rawTxHex: spend(secondOutputs, 100),
        expectedOutputs: secondOutputs,
        locktime: 100
      }
    ],
    refund: {
      rawTxHex: spend(refundOutputs, 200),
      expectedOutputs: refundOutputs,
      locktime: 200
    },
    feePolicy,
    spend,
    firstOutputs
  };
}

test('transaction validator binds every CET and refund to the funding outpoint', () => {
  const fixture = transactionFixture();
  const result = validateDlcTransactionSet({
    funding: fixture.funding,
    cets: fixture.cets,
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  });
  assert(result.cets.length === 2 && result.refund.feeSats === '670', 'valid transaction set failed');
  assert(/^[0-9a-f]{64}$/.test(result.validationDigest), 'transaction validation digest is not canonical');
  let contract = initialContract('validated-transaction-contract');
  contract = transitionDlcContract(contract, requestFor(contract, 'AUTHENTICATED_ORACLES'));
  contract = transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND', 'validated-transactions', {
    cet_set: result.cetSetDigest,
    fee_policy: result.feePolicyDigest,
    funding_template: result.fundingTemplateDigest,
    refund_transaction: result.refundTransactionDigest
  }));
  assert(contract.stage === 'CANONICAL_CETS_AND_REFUND', 'validated transaction receipts did not advance state');
  const feeReceipt = contract.history.at(-1).evidence.find((receipt) => receipt.kind === 'fee_policy');
  assert(feeReceipt && feeReceipt.digest === result.feePolicyDigest, 'signed state did not bind the recovery fee policy');
  const wrongOutpoint = {
    ...fixture.cets[0],
    rawTxHex: fixture.spend(fixture.firstOutputs, 100, 0xfffffffe, 'bb'.repeat(32))
  };
  expectThrow(() => validateDlcTransactionSet({
    funding: fixture.funding,
    cets: [wrongOutpoint, fixture.cets[1]],
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  }), /committed funding outpoint/);
  expectThrow(() => validateDlcTransactionSet({
    funding: fixture.funding,
    cets: [fixture.cets[0], { ...fixture.cets[0], outcomeMessage: digest('duplicate-cet-txid') }],
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  }), /unique transaction id/);
  const outputsWithoutAnchor = fixture.firstOutputs.slice(0, -1);
  const missingAnchor = {
    ...fixture.cets[0],
    rawTxHex: fixture.spend(outputsWithoutAnchor, 100),
    expectedOutputs: outputsWithoutAnchor
  };
  expectThrow(() => validateDlcTransactionSet({
    funding: fixture.funding,
    cets: [missingAnchor, fixture.cets[1]],
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  }), /CPFP anchor/);
  expectThrow(() => validateDlcTransactionSet({
    funding: fixture.funding,
    cets: fixture.cets,
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: { ...fixture.feePolicy, anchorScriptPubKeyHex: '6a01ff' }
  }), /P2WPKH or P2TR/);
});

test('transaction parser rejects noncanonical counts and ineffective locktimes', () => {
  const fixture = transactionFixture();
  const valid = fixture.cets[0].rawTxHex;
  const nonCanonicalInputCount = `${valid.slice(0, 8)}fd0100${valid.slice(10)}`;
  expectThrow(() => parseCanonicalUnsignedTransaction(nonCanonicalInputCount), /non-canonical CompactSize/);
  const finalSequence = fixture.spend(fixture.firstOutputs, 100, 0xffffffff);
  expectThrow(() => parseCanonicalUnsignedTransaction(finalSequence), /locktime is disabled/);
  const truncated = valid.slice(0, -2);
  expectThrow(() => parseCanonicalUnsignedTransaction(truncated), /truncated/);
});

test('CET adaptor and refund signatures bind to validated BIP341 sighashes', () => {
  const signerSecret = 123456789n;
  const signerPubkey = dlc.xOnlyPubkey(signerSecret).toString('hex');
  const funding = {
    txid: '99'.repeat(32),
    vout: 0,
    valueSats: 100000n,
    scriptPubKeyHex: `5120${signerPubkey}`
  };
  const thresholdSets = buildThresholdOutcomeSets({ announcements, threshold: 2, pinnedPubkeys, outcomeMsg32: outcome });
  const selected = thresholdSets[0];
  const cetOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `0014${'88'.repeat(20)}` }];
  const feePolicy = {
    strategy: 'cpfp-anchor-v1',
    anchorAmountSats: 330n,
    anchorScriptPubKeyHex: `0014${'aa'.repeat(20)}`,
    maxRecoveryFeeSats: 150000n,
    maxRecoveryFeerateSatPerVb: 500,
    minRelayPeers: 2
  };
  const anchor = { valueSats: feePolicy.anchorAmountSats, scriptPubKeyHex: feePolicy.anchorScriptPubKeyHex };
  cetOutputs.push(anchor);
  const refundOutputs = [{ valueSats: 99000n, scriptPubKeyHex: `5120${'77'.repeat(32)}` }, anchor];
  const raw = (outputs, locktime) => serializeUnsignedTx(
    2,
    [{ outpoint: outpoint(funding.txid, funding.vout), sequence: 0xfffffffe }],
    outputs.map((item) => ({ valueSats: item.valueSats, script: item.scriptPubKeyHex })),
    locktime
  );
  const validated = validateDlcTransactionSet({
    funding,
    cets: [{
      outcomeMessage: outcome.toString('hex'),
      oraclePubkeys: selected.oraclePubkeys,
      rawTxHex: raw(cetOutputs, 100),
      expectedOutputs: cetOutputs,
      locktime: 100
    }],
    refund: { rawTxHex: raw(refundOutputs, 200), expectedOutputs: refundOutputs, locktime: 200 },
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy
  });
  const cet = validated.cets[0];
  const cetSighash = bip341SighashDefault(
    toBip341Transaction(parseCanonicalUnsignedTransaction(cet.rawTxHex)),
    [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
    0
  );
  const presignature = dlc.adaptorSign(signerSecret, cetSighash, selected.outcomePoint, hash('signature-validator:aux'));
  const validatedSignatures = validateCetAdaptorSignatures({
    transactionSet: validated,
    funding,
    signerPubkeyX: signerPubkey,
    signatures: [{ identity: cetIdentity(cet), signerPubkeyX: signerPubkey, presignature }],
    thresholdOutcomeSets: [{
      outcomeMessage: outcome.toString('hex'),
      oraclePubkeys: selected.oraclePubkeys,
      outcomePoint: selected.outcomePoint
    }]
  });
  assert(/^[0-9a-f]{64}$/.test(validatedSignatures.digest), 'CET signature digest missing');
  const refundSighash = bip341SighashDefault(
    toBip341Transaction(parseCanonicalUnsignedTransaction(validated.refund.rawTxHex)),
    [{ amountSats: funding.valueSats, scriptPubKey: funding.scriptPubKeyHex }],
    0
  );
  const refundSignature = dlc.schnorrSign(signerSecret, refundSighash, hash('refund-signature:aux'));
  const validatedRefund = validateRefundSignature({
    transactionSet: validated,
    funding,
    signerPubkeyX: signerPubkey,
    signature: refundSignature
  });
  assert(/^[0-9a-f]{64}$/.test(validatedRefund.digest), 'refund signature digest missing');
  const forged = {
    ...presignature,
    s0: `${presignature.s0.slice(0, -1)}${presignature.s0.endsWith('0') ? '1' : '0'}`
  };
  expectThrow(() => validateCetAdaptorSignatures({
    transactionSet: validated,
    funding,
    signerPubkeyX: signerPubkey,
    signatures: [{ identity: cetIdentity(cet), signerPubkeyX: signerPubkey, presignature: forged }],
    thresholdOutcomeSets: [{
      outcomeMessage: outcome.toString('hex'),
      oraclePubkeys: selected.oraclePubkeys,
      outcomePoint: selected.outcomePoint
    }]
  }), /invalid/);
});

function validatedChainFixture(contractId, targetStage) {
  const fixture = transactionFixture();
  const transactionSet = validateDlcTransactionSet({
    funding: fixture.funding,
    cets: fixture.cets,
    refund: fixture.refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: fixture.feePolicy
  });
  let contract = initialContract(contractId);
  contract = transitionDlcContract(contract, requestFor(contract, 'AUTHENTICATED_ORACLES', `${contractId}:oracles`));
  contract = transitionDlcContract(contract, requestFor(contract, 'CANONICAL_CETS_AND_REFUND', `${contractId}:transactions`, {
    cet_set: transactionSet.cetSetDigest,
    fee_policy: transactionSet.feePolicyDigest,
    funding_template: transactionSet.fundingTemplateDigest,
    refund_transaction: transactionSet.refundTransactionDigest
  }));
  const remaining = [
    'COUNTERPARTY_SIGNATURES_VERIFIED',
    'LOCAL_SIGNATURES_PERSISTED',
    'FUNDING_PSBT_APPROVED',
    'FUNDING_BROADCAST',
    'CONFIRMED'
  ];
  for (const stage of remaining) {
    if (contract.stage === targetStage) break;
    contract = transitionDlcContract(contract, requestFor(contract, stage, `${contractId}:${stage}`));
  }
  return { contract, transactionSet };
}

function chainSnapshot(transactionSet, overrides = {}) {
  return {
    height: 205,
    bestBlockHash: digest('chain:block:205'),
    fundingOutpoint: `${transactionSet.funding.txid}:${transactionSet.funding.vout}`,
    fundingPresent: true,
    fundingConfirmations: 6,
    observedSpend: null,
    ...overrides
  };
}

test('chain guard binds snapshots to signed transactions and halts on reorgs or unknown spends', () => {
  const { contract, transactionSet } = validatedChainFixture('chain-guard-confirmed', 'CONFIRMED');
  const confirmed = evaluateDlcChainSnapshot({ contractState: contract, transactionSet, current: chainSnapshot(transactionSet) });
  assert(confirmed.ok && confirmed.status === 'FUNDING_CONFIRMED', 'confirmed funding was not accepted');

  const previous = chainSnapshot(transactionSet);
  const disconnected = chainSnapshot(transactionSet, {
    height: 206,
    bestBlockHash: digest('chain:block:206-reorg'),
    ancestorHashAtPreviousHeight: digest('chain:foreign-ancestor'),
    fundingConfirmations: 7
  });
  const reorg = evaluateDlcChainSnapshot({ contractState: contract, transactionSet, current: disconnected, previous });
  assert(!reorg.ok && reorg.status === 'REORG_HALT', 'disconnected chain ancestry did not halt');

  const unknown = chainSnapshot(transactionSet, {
    fundingPresent: false,
    fundingConfirmations: 0,
    observedSpend: { txid: 'ff'.repeat(32), height: 205 }
  });
  const unknownResult = evaluateDlcChainSnapshot({ contractState: contract, transactionSet, current: unknown });
  assert(!unknownResult.ok && unknownResult.status === 'UNKNOWN_SPEND_HALT', 'unknown funding spend did not halt');
  const alternateSet = validateDlcTransactionSet({
    funding: transactionFixture().funding,
    cets: transactionFixture().cets.map((cet, index) => index === 0
      ? { ...cet, outcomeMessage: digest('alternate-chain-outcome') }
      : cet),
    refund: transactionFixture().refund,
    minFeeSats: 500n,
    maxFeeSats: 2000n,
    feePolicy: transactionFixture().feePolicy
  });
  expectThrow(() => evaluateDlcChainSnapshot({
    contractState: contract,
    transactionSet: alternateSet,
    current: chainSnapshot(alternateSet)
  }), /signed contract validation receipts/);
  expectThrow(() => evaluateDlcChainSnapshot({
    contractState: contract,
    transactionSet: { ...transactionSet, funding: { ...transactionSet.funding, vout: 3 } },
    current: chainSnapshot(transactionSet)
  }), /commitment mismatch/);
});

test('chain guard accepts only stage-consistent CETs and mature refunds', () => {
  const confirmedFixture = validatedChainFixture('chain-spend-confirmed', 'CONFIRMED');
  const cetSpend = chainSnapshot(confirmedFixture.transactionSet, {
    fundingPresent: false,
    fundingConfirmations: 0,
    observedSpend: { txid: confirmedFixture.transactionSet.cets[0].txid, height: 205 }
  });
  const cet = evaluateDlcChainSnapshot({
    contractState: confirmedFixture.contract,
    transactionSet: confirmedFixture.transactionSet,
    current: cetSpend
  });
  assert(cet.ok && cet.status === 'CET_OBSERVED', 'confirmed CET was not recognized');

  const earlyFixture = validatedChainFixture('chain-spend-early', 'CANONICAL_CETS_AND_REFUND');
  const earlyCet = evaluateDlcChainSnapshot({
    contractState: earlyFixture.contract,
    transactionSet: earlyFixture.transactionSet,
    current: chainSnapshot(earlyFixture.transactionSet, {
      fundingPresent: false,
      fundingConfirmations: 0,
      observedSpend: { txid: earlyFixture.transactionSet.cets[0].txid, height: 205 }
    })
  });
  assert(!earlyCet.ok && earlyCet.status === 'PREMATURE_CET_HALT', 'early CET did not halt');

  const earlyRefund = evaluateDlcChainSnapshot({
    contractState: confirmedFixture.contract,
    transactionSet: confirmedFixture.transactionSet,
    current: chainSnapshot(confirmedFixture.transactionSet, {
      height: 199,
      bestBlockHash: digest('chain:block:199'),
      fundingPresent: false,
      fundingConfirmations: 0,
      observedSpend: { txid: confirmedFixture.transactionSet.refund.txid, height: 199 }
    })
  });
  assert(!earlyRefund.ok && earlyRefund.status === 'PREMATURE_REFUND_HALT', 'immature refund did not halt');
  const matureRefund = evaluateDlcChainSnapshot({
    contractState: confirmedFixture.contract,
    transactionSet: confirmedFixture.transactionSet,
    current: chainSnapshot(confirmedFixture.transactionSet, {
      fundingPresent: false,
      fundingConfirmations: 0,
      observedSpend: { txid: confirmedFixture.transactionSet.refund.txid, height: 205 }
    })
  });
  assert(matureRefund.ok && matureRefund.status === 'REFUND_OBSERVED', 'mature refund was not recognized');
});

test('Bitcoin Core observer captures a stable testnet4 tip and scans committed spends', () => {
  const { contract, transactionSet } = validatedChainFixture('core-observer-confirmed', 'CONFIRMED');
  const bestBlockHash = digest('core-observer:block:205');
  const confirmedRpc = (method) => {
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
    if (method === 'getrawmempool') return { mempool_sequence: 9 };
    if (method === 'gettxout') return { bestblock: bestBlockHash, confirmations: 6 };
    throw new Error(`unexpected RPC ${method}`);
  };
  const confirmed = observeAndEvaluateDlcChain({ contractState: contract, transactionSet, rpc: confirmedRpc });
  assert(confirmed.evaluation.status === 'FUNDING_CONFIRMED', 'Core observer lost confirmed funding');
  assert(confirmed.snapshot.fundingOutpoint === `${transactionSet.funding.txid}:${transactionSet.funding.vout}`,
    'Core observer monitored the wrong funding outpoint');

  const cetRpc = (method, params) => {
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
    if (method === 'getrawmempool') return { mempool_sequence: 9 };
    if (method === 'gettxout') return null;
    if (method === 'gettxspendingprevout') return [{}];
    if (method === 'getblockhash') return bestBlockHash;
    if (method === 'getblock') return {
      tx: [{
        txid: transactionSet.cets[0].txid,
        vin: [{ txid: transactionSet.funding.txid, vout: transactionSet.funding.vout }]
      }]
    };
    throw new Error(`unexpected RPC ${method} ${JSON.stringify(params)}`);
  };
  const cet = observeAndEvaluateDlcChain({
    contractState: contract,
    transactionSet,
    rpc: cetRpc,
    scanDepth: 1
  });
  assert(cet.evaluation.status === 'CET_OBSERVED', 'Core block scan did not recognize the committed CET');

  const wrongChainRpc = (method) => {
    if (method === 'getblockchaininfo') return { chain: 'main', blocks: 205, bestblockhash: bestBlockHash };
    throw new Error(`unexpected RPC ${method}`);
  };
  expectThrow(() => observeAndEvaluateDlcChain({
    contractState: contract,
    transactionSet,
    rpc: wrongChainRpc
  }), /must report testnet4/);
});

test('signed watchtower journal preserves halt alerts and detects tampering after restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-watchtower-'));
  try {
    const { contract, transactionSet } = validatedChainFixture('watchtower-journal-contract', 'CONFIRMED');
    const keys = crypto.generateKeyPairSync('ed25519');
    const journal = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'independent-watchtower-1',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const firstSnapshot = chainSnapshot(transactionSet);
    const first = journal.appendObservation({ contractState: contract, transactionSet, snapshot: firstSnapshot });
    const retry = journal.appendObservation({ contractState: contract, transactionSet, snapshot: firstSnapshot });
    assert(retry.recordHash === first.recordHash, 'identical watchtower observation was not idempotent');
    const reorg = journal.appendObservation({
      contractState: contract,
      transactionSet,
      snapshot: chainSnapshot(transactionSet, {
        height: 206,
        bestBlockHash: digest('watchtower:block:206'),
        ancestorHashAtPreviousHeight: digest('watchtower:foreign-ancestor'),
        fundingConfirmations: 7
      })
    });
    assert(reorg.evaluation.status === 'REORG_HALT' && reorg.alert.code === 'REORG_HALT',
      'watchtower did not persist its reorg alert');

    const restarted = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'independent-watchtower-1',
      publicKey: keys.publicKey
    });
    const verified = restarted.verifyChain(contract.contractId);
    assert(verified.observations === 2 && restarted.alerts(contract.contractId).length === 1,
      'restart lost the watchtower observation or alert chain');
    expectThrow(() => restarted.appendObservation({
      contractState: contract,
      transactionSet,
      snapshot: firstSnapshot
    }), /verification-only/);

    const secondPath = path.join(
      directory,
      watchtowerContractKey(contract.contractId),
      'observation-000000000001.json'
    );
    const forged = JSON.parse(fs.readFileSync(secondPath, 'utf8'));
    forged.evaluation.reason = 'tampered after restart';
    fs.writeFileSync(secondPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
    expectThrow(() => restarted.verifyChain(contract.contractId), /commitment mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('watchtower signs direct Bitcoin Core anchor, replacement-policy, and peer relay observations', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-anchor-watchtower-'));
  try {
    const { contract, transactionSet } = validatedChainFixture('anchor-watchtower-contract', 'CONFIRMED');
    const settlementTxid = transactionSet.cets[0].txid;
    const anchor = settlementAnchor(transactionSet, settlementTxid);
    const pinTxid = digest('anchor-watchtower:pin');
    const bestBlockHash = digest('anchor-watchtower:block:205');
    const walletTxid = digest('anchor-watchtower:wallet-input');
    const walletValue = 200000n;
    const recoveryRaw = (feeSats) => serializeUnsignedTx(
      2,
      [
        { outpoint: outpoint(anchor.txid, anchor.vout), sequence: 0xfffffffd },
        { outpoint: outpoint(walletTxid, 0), sequence: 0xfffffffd }
      ],
      [{ valueSats: 330n + walletValue - feeSats, script: `0014${'98'.repeat(20)}` }],
      0
    );
    const cheapRecoveryRaw = recoveryRaw(9098n);
    const rescueRaw = recoveryRaw(100000n);
    const decodedRecovery = (rawTxHex) => {
      const parsed = parseCanonicalUnsignedTransaction(rawTxHex);
      return {
        txid: parsed.txid,
        hash: parsed.txid,
        vsize: 300,
        vin: parsed.inputs,
        vout: parsed.outputs.map((output) => ({ value: Number(output.valueSats) / 100000000 }))
      };
    };
    const primaryRpc = (method, params) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool') return { mempool_sequence: 17 };
      if (method === 'getmempoolinfo') return { fullrbf: true, incrementalrelayfee: 0.00001 };
      if (method === 'gettxout' && params[0] === walletTxid) {
        return { bestblock: bestBlockHash, confirmations: 6, value: 0.002, scriptPubKey: { hex: `0014${'97'.repeat(20)}` } };
      }
      if (method === 'gettxout') return null;
      if (method === 'gettxspendingprevout') return [{ spendingtxid: pinTxid }];
      if (method === 'getmempoolentry') {
        return { vsize: 467, fees: { base: 0.00093338 }, 'bip125-replaceable': false };
      }
      if (method === 'decoderawtransaction') return decodedRecovery(params[0]);
      throw new Error(`unexpected primary anchor RPC ${method}`);
    };
    const peerRpc = (method, params) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool' && params[1] === true) return { mempool_sequence: 9 };
      if (method === 'getrawmempool') return [pinTxid];
      throw new Error(`unexpected peer anchor RPC ${method}`);
    };
    const captured = captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw
    });
    assert(captured.observedSpend.txid === pinTxid && captured.observedSpend.relayPeers === 2,
      'Core observer did not count the primary and peer mempools');
    assert(captured.fullRbf && captured.incrementalRelayFeeSatPerVb === 1,
      'Core observer did not bind replacement policy');
    expectThrow(() => captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      primaryNodeId: 'peer-1',
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw
    }), /node IDs must be unique/);
    expectThrow(() => captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{
        nodeId: 'wrong-chain',
        rpc(method) {
          if (method === 'getblockchaininfo') return { chain: 'main', blocks: 205, bestblockhash: bestBlockHash };
          throw new Error(`unexpected wrong-chain RPC ${method}`);
        }
      }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw,
      maxAttempts: 1
    }), /must report testnet4/);

    const confirmedRecoveryTxid = digest('anchor-watchtower:confirmed-recovery');
    const confirmedRpc = (method) => {
      if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 205, bestblockhash: bestBlockHash };
      if (method === 'getrawmempool') return { mempool_sequence: 18 };
      if (method === 'getmempoolinfo') return { fullrbf: true, incrementalrelayfee: 0.00001 };
      if (method === 'gettxout') return null;
      if (method === 'gettxspendingprevout') return [{}];
      if (method === 'getblockhash') return bestBlockHash;
      if (method === 'getblock') return {
        tx: [{
          txid: confirmedRecoveryTxid,
          fee: 0.00001,
          vsize: 200,
          vin: [{ txid: anchor.txid, vout: anchor.vout, sequence: 0xfffffffe }]
        }]
      };
      throw new Error(`unexpected confirmed anchor RPC ${method}`);
    };
    const confirmedSnapshot = captureDlcAnchorRecoverySnapshot({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: confirmedRpc,
      expectedRecoveryTxids: [confirmedRecoveryTxid],
      scanDepth: 1
    });
    const confirmedEvaluation = evaluateDlcAnchorRecovery({
      contractState: contract,
      transactionSet,
      settlementTxid,
      snapshot: confirmedSnapshot,
      expectedRecoveryTxids: confirmedSnapshot.expectedRecoveryTxids,
      incrementalRelayFeeSatPerVb: confirmedSnapshot.incrementalRelayFeeSatPerVb
    });
    assert(confirmedEvaluation.status === 'RECOVERY_CONFIRMED',
      'Core block scan did not accept the confirmed expected recovery');

    const keys = crypto.generateKeyPairSync('ed25519');
    const journal = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'anchor-watchtower-1',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const pinned = journal.appendBitcoinCoreAnchorObservation({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: cheapRecoveryRaw
    });
    assert(pinned.observationType === 'anchor-recovery' && pinned.evaluation.status === 'FEE_PIN_HALT' &&
      pinned.alert.code === 'FEE_PIN_HALT', 'watchtower did not persist the directly observed fee pin');
    const rescued = journal.appendBitcoinCoreAnchorObservation({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: rescueRaw
    });
    assert(rescued.evaluation.status === 'FEE_PIN_RESCUE_READY' && rescued.alert === null,
      'watchtower did not authorize the in-budget replacement from direct Core evidence');
    const chainRecord = journal.appendObservation({
      contractState: contract,
      transactionSet,
      snapshot: chainSnapshot(transactionSet)
    });
    const rescueRetry = journal.appendBitcoinCoreAnchorObservation({
      contractState: contract,
      transactionSet,
      settlementTxid,
      rpc: primaryRpc,
      peerNodes: [{ nodeId: 'peer-1', rpc: peerRpc }],
      proposedRecoveryRawTxHex: rescueRaw
    });
    assert(chainRecord.observationType === 'chain' && rescueRetry.recordHash === rescued.recordHash,
      'mixed observation types broke anchor idempotency');

    const restarted = new DlcWatchtowerJournal(directory, {
      watchtowerId: 'anchor-watchtower-1',
      publicKey: keys.publicKey
    });
    const verified = restarted.verifyChain(contract.contractId);
    assert(verified.observations === 3 && restarted.alerts(contract.contractId).length === 1,
      'direct Core anchor observations did not survive journal restart');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('anchor recovery guard enforces signed budgets, relay quorum, and full-RBF fee-pin deltas', () => {
  const { contract, transactionSet } = validatedChainFixture('anchor-recovery-contract', 'CANONICAL_CETS_AND_REFUND');
  const settlementTxid = transactionSet.cets[0].txid;
  const anchor = settlementAnchor(transactionSet, settlementTxid);
  assert(anchor.vout === transactionSet.cets[0].outputs.length - 1, 'guard selected the wrong settlement anchor');
  const pin = {
    txid: digest('anchor-guard:pin'),
    feeSats: '93338',
    vsize: 467,
    relayPeers: 2,
    signalsRbf: false,
    confirmed: false
  };
  const cheapRecovery = {
    txid: digest('anchor-guard:cheap-recovery'),
    feeSats: '9098',
    vsize: 467,
    relayPeers: 0,
    signalsRbf: true,
    confirmed: false
  };
  const rescue = {
    txid: digest('anchor-guard:rescue'),
    feeSats: '140138',
    vsize: 467,
    relayPeers: 0,
    signalsRbf: true,
    confirmed: false
  };
  const pinned = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: { anchorOutpoint: anchor.outpoint, anchorPresent: false, fullRbf: true, observedSpend: pin, proposedRecovery: cheapRecovery }
  });
  assert(!pinned.ok && pinned.status === 'FEE_PIN_HALT', 'cheaper recovery bypassed the economic fee pin');
  const rescued = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: { anchorOutpoint: anchor.outpoint, anchorPresent: false, fullRbf: true, observedSpend: pin, proposedRecovery: rescue }
  });
  assert(rescued.ok && rescued.status === 'FEE_PIN_RESCUE_READY', 'higher-fee recovery was not authorized inside budget');
  const noFullRbf = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: { anchorOutpoint: anchor.outpoint, anchorPresent: false, fullRbf: false, observedSpend: pin, proposedRecovery: rescue }
  });
  assert(!noFullRbf.ok && noFullRbf.status === 'FEE_PIN_HALT', 'non-RBF pin bypassed the observed replacement policy');
  const confirmedConflict = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: {
      anchorOutpoint: anchor.outpoint,
      anchorPresent: false,
      fullRbf: true,
      observedSpend: { ...pin, confirmed: true, relayPeers: 0 },
      proposedRecovery: rescue
    }
  });
  assert(!confirmedConflict.ok && confirmedConflict.status === 'ANCHOR_SPENT_HALT',
    'confirmed conflicting anchor spend was treated as replaceable');
  const overBudget = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    snapshot: {
      anchorOutpoint: anchor.outpoint,
      anchorPresent: true,
      fullRbf: true,
      observedSpend: null,
      proposedRecovery: { ...rescue, txid: digest('anchor-guard:over-budget'), feeSats: '150001' }
    }
  });
  assert(!overBudget.ok && overBudget.status === 'RECOVERY_BUDGET_HALT', 'recovery exceeded the signed absolute fee budget');
  const underReplicated = evaluateDlcAnchorRecovery({
    contractState: contract,
    transactionSet,
    settlementTxid,
    expectedRecoveryTxids: [rescue.txid],
    snapshot: {
      anchorOutpoint: anchor.outpoint,
      anchorPresent: false,
      fullRbf: true,
      observedSpend: { ...rescue, relayPeers: 1 },
      proposedRecovery: null
    }
  });
  assert(!underReplicated.ok && underReplicated.status === 'RECOVERY_PROPAGATION_HALT',
    'recovery without the signed relay quorum was accepted');
});

function peerTranscriptFixture(overrides = {}) {
  const { contract, transactionSet } = validatedChainFixture('peer-transcript-contract', 'CANONICAL_CETS_AND_REFUND');
  const offerer = crypto.generateKeyPairSync('ed25519');
  const accepter = crypto.generateKeyPairSync('ed25519');
  const temporaryContractId = digest('peer-transcript:temporary-contract');
  const signatureDigests = {
    accepterCet: digest('peer-transcript:accepter-cets'),
    accepterRefund: digest('peer-transcript:accepter-refund'),
    offererCet: digest('peer-transcript:offerer-cets'),
    offererRefund: digest('peer-transcript:offerer-refund'),
    fundingWitnesses: digest('peer-transcript:funding-witnesses')
  };
  const terms = {
    contractDigest: contract.contractDigest,
    oraclePolicyDigest: computeOraclePolicyDigest(contract.oraclePolicy)
  };
  const offer = signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.OFFER,
    peerId: 'offerer-peer',
    body: {
      protocolVersion: 1,
      chainHash: TESTNET4_CHAIN_HASH,
      temporaryContractId,
      fundingOutputSerialId: '30',
      payoutSerialId: '5',
      changeSerialId: '20',
      fundingInputSerialIds: ['2', '10'],
      ...terms,
      transactionValidationDigest: transactionSet.validationDigest
    },
    privateKey: offerer.privateKey
  });
  const acceptBody = {
    protocolVersion: 1,
    temporaryContractId,
    payoutSerialId: '6',
    changeSerialId: '21',
    fundingInputSerialIds: ['3', '11'],
    ...terms,
    transactionValidationDigest: transactionSet.validationDigest,
    cetSignaturesDigest: signatureDigests.accepterCet,
    refundSignatureDigest: signatureDigests.accepterRefund,
    ...overrides.acceptBody
  };
  const accept = signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.ACCEPT,
    peerId: 'accepter-peer',
    previousMessageDigest: offer.messageDigest,
    body: acceptBody,
    privateKey: accepter.privateKey
  });
  const contractId = computeDlcContractId(
    transactionSet.funding.txid,
    transactionSet.funding.vout,
    temporaryContractId
  );
  const sign = signDlcPeerMessage({
    messageType: PEER_MESSAGE_TYPES.SIGN,
    peerId: 'offerer-peer',
    previousMessageDigest: accept.messageDigest,
    body: {
      protocolVersion: 1,
      contractId,
      fundingWitnessInputSerialIds: ['2', '10'],
      fundingWitnessesDigest: signatureDigests.fundingWitnesses,
      ...terms,
      transactionValidationDigest: transactionSet.validationDigest,
      cetSignaturesDigest: signatureDigests.offererCet,
      refundSignatureDigest: signatureDigests.offererRefund
    },
    privateKey: offerer.privateKey
  });
  return {
    contract, transactionSet, offerer, accepter, offer, accept, sign, contractId,
    temporaryContractId, signatureDigests
  };
}

test('peer transcript authenticates offer/accept/sign and binds serial ordering to validated transactions', () => {
  const fixture = peerTranscriptFixture();
  assert(computeDlcContractId('00'.repeat(32), 513, '00'.repeat(32)).endsWith('0201'),
    'contract ID did not XOR the big-endian funding output index');
  const validated = validateDlcPeerTranscript({
    offer: fixture.offer,
    accept: fixture.accept,
    sign: fixture.sign,
    offererPublicKey: fixture.offerer.publicKey,
    accepterPublicKey: fixture.accepter.publicKey,
    transactionSet: fixture.transactionSet,
    contractState: fixture.contract,
    fundingTxid: fixture.transactionSet.funding.txid,
    fundingOutputIndex: fixture.transactionSet.funding.vout,
    expectedSignatures: fixture.signatureDigests,
    verifyFundingWitnesses: ({ fundingWitnessesDigest }) =>
      fundingWitnessesDigest === fixture.signatureDigests.fundingWitnesses
  });
  assert(validated.ok && validated.contractId === fixture.contractId, 'valid peer transcript failed');
  assert(/^[0-9a-f]{64}$/.test(validated.transcriptDigest), 'peer transcript digest is invalid');

  const duplicate = peerTranscriptFixture({ acceptBody: { fundingInputSerialIds: ['2', '11'] } });
  expectThrow(() => validateDlcPeerTranscript({
    offer: duplicate.offer,
    accept: duplicate.accept,
    sign: duplicate.sign,
    offererPublicKey: duplicate.offerer.publicKey,
    accepterPublicKey: duplicate.accepter.publicKey,
    transactionSet: duplicate.transactionSet,
    contractState: duplicate.contract,
    fundingTxid: duplicate.transactionSet.funding.txid,
    fundingOutputIndex: duplicate.transactionSet.funding.vout,
    expectedSignatures: duplicate.signatureDigests,
    verifyFundingWitnesses: () => true
  }), /globally unique/);

  expectThrow(() => validateDlcPeerTranscript({
    offer: fixture.offer,
    accept: fixture.accept,
    sign: fixture.sign,
    offererPublicKey: fixture.offerer.publicKey,
    accepterPublicKey: fixture.accepter.publicKey,
    transactionSet: fixture.transactionSet,
    contractState: fixture.contract,
    fundingTxid: fixture.transactionSet.funding.txid,
    fundingOutputIndex: fixture.transactionSet.funding.vout,
    expectedSignatures: fixture.signatureDigests,
    verifyFundingWitnesses: () => true,
    knownTemporaryContractIds: [fixture.temporaryContractId]
  }), /already used/);
});

test('peer session store preserves temporary-ID replay protection across restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-peer-session-'));
  try {
    const fixture = peerTranscriptFixture();
    const transcript = validateDlcPeerTranscript({
      offer: fixture.offer,
      accept: fixture.accept,
      sign: fixture.sign,
      offererPublicKey: fixture.offerer.publicKey,
      accepterPublicKey: fixture.accepter.publicKey,
      transactionSet: fixture.transactionSet,
      contractState: fixture.contract,
      fundingTxid: fixture.transactionSet.funding.txid,
      fundingOutputIndex: fixture.transactionSet.funding.vout,
      expectedSignatures: fixture.signatureDigests,
      verifyFundingWitnesses: () => true
    });
    const first = new DlcPeerSessionStore(directory);
    const claim = first.claimOffer({ offer: fixture.offer, offererPublicKey: fixture.offerer.publicKey });
    const retry = first.claimOffer({ offer: fixture.offer, offererPublicKey: fixture.offerer.publicKey });
    assert(retry.recordHash === claim.recordHash, 'identical offer claim was not idempotent');
    const committed = first.commitTranscript(transcript);
    assert(first.commitTranscript(transcript).recordHash === committed.recordHash, 'transcript commit was not idempotent');

    const restarted = new DlcPeerSessionStore(directory);
    assert(restarted.knownTemporaryContractIds('offerer-peer').includes(fixture.temporaryContractId),
      'restart lost temporary contract replay protection');
    const conflictingOffer = signDlcPeerMessage({
      messageType: PEER_MESSAGE_TYPES.OFFER,
      peerId: fixture.offer.peerId,
      body: { ...fixture.offer.body, payoutSerialId: '7' },
      privateKey: fixture.offerer.privateKey
    });
    expectThrow(() => restarted.claimOffer({
      offer: conflictingOffer,
      offererPublicKey: fixture.offerer.publicKey
    }), /already claimed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}
console.log(`\nPASS: ${passed} tests\n`);
