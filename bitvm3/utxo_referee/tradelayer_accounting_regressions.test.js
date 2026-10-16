/**
 * Run: node bitvm3/utxo_referee/tradelayer_accounting_regressions.test.js
 *
 * One regression per accounting finding in the TradeLayer referees. Each block
 * names the invariant it pins. Every block is expected to fail on the commit
 * before its fix and pass after it.
 */

const crypto = require('crypto');
const pa = require('./tradelayer_pnl_route_adapter');
const wq = require('./tradelayer_withdrawal_queue_referee');
const rr = require('./tradelayer_reserve_reconciliation_referee');
const pp = require('./tradelayer_perp_pnl_referee');
const ps = require('./tradelayer_pnl_state_netting');
const cp = require('./tradelayer_state_checkpoint_referee');
const pol = require('./tradelayer_send_policy');
const tv = require('./taproot_reserve_vault');
const dlcSig = require('./tradelayer_dlc_adaptor_sig');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertEq(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `expected ${expected}, got ${actual}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function throwsWith(fn, pattern) {
  try {
    fn();
  } catch (err) {
    return pattern.test(String(err.message));
  }
  return false;
}

const NET = 'bitcoin-testnet4';
const PAYOUT = 'tb1qn75cnly6zn4540k7824rmw02eeylaygcpj49rs';
const PAYOUT_2 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const LTC = 'tltc1qkz0vft2fc4nk0u9fx4k9yk4th7zherna3zxh22';
const LTC_2 = 'tltc1qldtqy3y0rasay8dqz6kc2nxx6zfs9e9j4veqcz';

function queue(requests = [{ id: 'wd-1', txid: '11'.repeat(32), address: PAYOUT, sats: 97000, propertyId: 0, status: 'approved' }]) {
  return wq.buildTradeLayerWithdrawalQueue({ network: NET, epochId: 77, requests });
}

console.log('\n=== TradeLayer Accounting Regression Tests ===\n');

// ---- send route: a negative fee must not mint sats into the residual output ----
test('route plan refuses a negative fee and verification never accepts payouts above the input', () => {
  const intent = {
    network: 'litecoin-testnet',
    revealTxid: 'cc'.repeat(32),
    payloadHash: 'dd'.repeat(32),
    dlcInput: { txid: 'ee'.repeat(32), vout: 0, address: LTC_2, sats: '100000' },
    oracleAddress: LTC,
    refundAddress: LTC_2,
    sendBps: 2500,
    feeSats: -1000,
    dlcFunderRegistry: {},
    envelope: {}
  };
  assert(throwsWith(() => pa.buildTradeLayerSendRoutePlan(intent), /feeSats/), 'negative fee must be refused');
  assert(throwsWith(() => pa.verifyTradeLayerSendRoutePlan({ ...intent, feeSats: '-1000' }), /feeSats/), 'a route with a negative fee must not verify');
});

// ---- reserve: the source kind decides how the reserve is read ----
test('a deposit-indexer snapshot cannot carry an explicit reservedSats that replaces the deposit sum', () => {
  const forged = { kind: 'receipt-deposit-indexer', deposits: [], reservedSats: '1000000' };
  assert(throwsWith(() => rr.resolveReserve(forged), /receipt-deposit-indexer.*reservedSats|reservedSats.*receipt-deposit-indexer/), 'stray reservedSats must be refused');
  assert(throwsWith(() => rr.buildTradeLayerReserveReconciliation({ network: NET, queue: queue(), reserve: forged }), /reservedSats/), 'build must refuse it');
});

test('a deposit outpoint is counted once whatever the case of its txid', () => {
  const txid = 'AB'.repeat(32);
  const snapshot = {
    kind: 'receipt-deposit-indexer',
    deposits: [
      { depositId: 'd1', status: 'credited', txid, vout: 0, amountSats: '5000' },
      { depositId: 'd2', status: 'credited', txid: txid.toLowerCase(), vout: 0, amountSats: '5000' }
    ]
  };
  assert(throwsWith(() => rr.reservedSatsFromDepositSnapshot(snapshot), /duplicate credited deposit/), 'same outpoint in two cases must be a duplicate');
});

// ---- reserve: a verdict of solvent needs the cap bound to a queue ----
test('verification without the withdrawal queue never reports solvent on a self-declared cap', () => {
  const reserve = { reservedSats: '100000' };
  const built = rr.buildTradeLayerReserveReconciliation({ network: NET, queue: queue(), reserve });
  assertEq(built.solvent, true, 'the honest reconciliation is solvent');
  const forgedCore = { ...built.core, capSats: '1', marginSats: '99999' };
  const forged = { ...built, core: forgedCore, reconciliationHash: pa.sha256Hex(forgedCore) };
  const verdict = rr.verifyTradeLayerReserveReconciliation(forged, undefined, { reserve });
  assertEq(verdict.solvent, false, 'no queue means the cap is unbound and the verdict is not solvent');
  const withQueue = rr.verifyTradeLayerReserveReconciliation(built, queue(), { reserve });
  assertEq(withQueue.solvent, true, 'the honest reconciliation still verifies as solvent with its queue');
});

test('maxReserveAgeBlocks must be a non-negative integer, not NaN', () => {
  assert(throwsWith(() => rr.buildTradeLayerReserveReconciliation({ network: NET, queue: queue(), reserve: { reservedSats: '1' }, maxReserveAgeBlocks: 'soon' }), /maxReserveAgeBlocks/), 'build must refuse NaN');
  const built = rr.buildTradeLayerReserveReconciliation({ network: NET, queue: queue(), reserve: { reservedSats: '100000' }, observedAtHeight: 100, currentHeight: 100 });
  assert(throwsWith(() => rr.verifyTradeLayerReserveReconciliation(built, queue(), { reserve: { reservedSats: '100000' }, currentHeight: 500, maxReserveAgeBlocks: -1 }), /maxReserveAgeBlocks/), 'verify must refuse a negative window');
});

// ---- taproot vault set: one funding outpoint, one counted reserve ----
const FUNDING_TXID = 'aa'.repeat(32);
const OPERATOR_XONLY = dlcSig.xOnlyPubkey(11n).toString('hex');
const GUARDIAN_XONLY = dlcSig.xOnlyPubkey(22n).toString('hex');

function vaultManifest(vaultId) {
  return tv.buildTaprootReserveVaultManifest({
    network: 'bitcoin-testnet4',
    vaultId,
    fundingOutpoint: { txid: FUNDING_TXID, vout: 0 },
    amountSats: 100000,
    operatorXonly: OPERATOR_XONLY,
    guardianXonly: GUARDIAN_XONLY,
    observedAtHeight: 1000,
    recoveryCsvDelay: 2016,
    reserveEpochId: 'epoch-77'
  });
}

test('two manifests naming the same funding outpoint count the reserve once', () => {
  const first = vaultManifest('vault-a');
  const second = vaultManifest('vault-b');
  const txout = { value: 0.001, scriptPubKey: { hex: first.core.p2trScriptPubKey }, confirmations: 201 };
  const chainTxouts = { [`${FUNDING_TXID}:0`]: txout };
  const single = tv.buildTaprootReserveVaultSet({ network: 'bitcoin-testnet4', reserveEpochId: 'epoch-77', currentHeight: 1200, manifests: [first], chainTxouts });
  const doubled = tv.buildTaprootReserveVaultSet({ network: 'bitcoin-testnet4', reserveEpochId: 'epoch-77', currentHeight: 1200, manifests: [first, second], chainTxouts });
  assertEq(single.reservedSats, '100000');
  assertEq(doubled.reservedSats, '100000', 'the same UTXO must not back two vaults');
  assertEq(doubled.countedVaultCount, 1);
  assertEq(doubled.rejectedVaultCount, 1);
  assertEq(doubled.core.vaults[1].verification.reason, 'duplicate funding outpoint');
});

// ---- oracle signature: the verifier's pinned key is the only key ----
const ORACLE_BLOB = {
  kind: 'tradelayer-send-state-oracle-v1',
  chain: 'litecoin-testnet',
  network: 'litecoin-testnet',
  epochId: 1,
  snapshotHeight: 100,
  oracleAddress: LTC,
  sends: [{ id: 's1', txid: 'cc'.repeat(32), toAddress: LTC_2, amountUnits: '100', depositUnits: '100', revealTxid: 'cc'.repeat(32) }],
  selectedSendId: 's1',
  dlcInput: { txid: 'dd'.repeat(32), vout: 0, address: LTC_2, sats: '100000' },
  sendBps: 10000
};

function signBlob(blob, privateKey, extra = {}) {
  const payload = pa.buildTradeLayerSendOracleSigningPayload(blob).payload;
  const signatureHex = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex');
  return { ...blob, oracleSignature: { algorithm: 'ed25519', signatureHex, ...extra } };
}

test('a blob-carried public key cannot verify a signature over a pinned oracle key', () => {
  const attacker = crypto.generateKeyPairSync('ed25519');
  const pinned = crypto.generateKeyPairSync('ed25519');
  const attackerPem = attacker.publicKey.export({ type: 'spki', format: 'pem' });
  const pinnedPem = pinned.publicKey.export({ type: 'spki', format: 'pem' });
  const forged = signBlob(ORACLE_BLOB, attacker.privateKey, { publicKeyPem: attackerPem, keyId: 'attacker' });
  const sig = pa.verifyTradeLayerSendOracleSignature(forged, { oraclePublicKeyPem: pinnedPem, requireOracleSignature: true });
  assertEq(sig.ok, false, 'the pinned key decides, not the blob');
  const route = pa.verifyTradeLayerSendStateOracleRoute(forged, { oraclePublicKeyPem: pinnedPem, requireOracleSignature: true });
  assertEq(route.ok, false, 'the route verdict inherits the pinned-key check');
  const unsignedRoute = pa.verifyTradeLayerSendStateOracleRoute(ORACLE_BLOB, { oraclePublicKeyPem: pinnedPem });
  assertEq(unsignedRoute.ok, false, 'a pinned key demands a signature on the blob');

  const honest = signBlob(ORACLE_BLOB, pinned.privateKey, { keyId: 'oracle-1' });
  const ok = pa.verifyTradeLayerSendOracleSignature(honest, { oraclePublicKeyPem: pinnedPem, oracleKeyId: 'oracle-1', requireOracleSignature: true });
  assertEq(ok.ok, true, ok.reason);
  assertEq(ok.keyId, 'oracle-1', 'the key id comes from the verifier, not the blob');
});

// ---- withdrawal challenges: the verdict is recomputed, not read from the flag ----
test('a withdrawal challenge with a forged challengeable flag is rejected', () => {
  const q = queue();
  const duplicate = wq.buildTradeLayerWithdrawalQueueChallenge(q, { challengeType: 'duplicate_withdrawal', duplicateCount: 1 });
  assertEq(duplicate.challengeable, false, 'a single entry is not a duplicate');
  const forged = { ...duplicate, challengeable: true };
  assertEq(wq.verifyTradeLayerWithdrawalQueueChallenge(forged, q).ok, false, 'the flag must match the core');
  assertEq(wq.verifyTradeLayerWithdrawalQueueChallenge(duplicate, q).challengeable, false);
});

test('an omitted-withdrawal challenge is refused for a request that is in the payable set', () => {
  const q = queue();
  const claim = wq.buildTradeLayerWithdrawalQueueChallenge(q, { challengeType: 'omitted_withdrawal' });
  assertEq(claim.challengeable, false, 'wd-1 is payable, so it cannot be omitted');
  const omitted = wq.buildTradeLayerWithdrawalQueueChallenge(q, {
    challengeType: 'omitted_withdrawal',
    request: { id: 'wd-missing', txid: '22'.repeat(32), address: PAYOUT_2, sats: '1000', propertyId: 0 }
  });
  assertEq(omitted.challengeable, true, 'a request outside the payable set is omitted');
  assertEq(wq.verifyTradeLayerWithdrawalQueueChallenge(omitted, q).challengeable, true);
});

test('a malformed queue entry is a verdict, not an exception', () => {
  const q = queue();
  const bad = clone(q);
  bad.queueCore.entries = ['not-an-entry'];
  bad.queueHash = pa.sha256Hex(bad.queueCore);
  const result = wq.verifyTradeLayerWithdrawalQueue(bad);
  assertEq(result.ok, false);
  assert(/request\[0\]/.test(result.reason), `unexpected reason: ${result.reason}`);
});

// ---- reserve insolvency challenge: verdict recomputed; bound to the reconciliation ----
test('an insolvency challenge is bound to the reconciliation it names', () => {
  const reserve = { reservedSats: '50000' };
  const reconciliation = rr.buildTradeLayerReserveReconciliation({ network: NET, queue: queue(), reserve });
  assertEq(reconciliation.solvent, false, 'the cap exceeds the reserve');
  const challenge = rr.buildTradeLayerReserveInsolvencyChallenge(reconciliation);
  assertEq(challenge.challengeable, true);
  assertEq(rr.verifyTradeLayerReserveInsolvencyChallenge(challenge, reconciliation).ok, true);

  const forgedFlag = { ...challenge, challengeable: false };
  assertEq(rr.verifyTradeLayerReserveInsolvencyChallenge(forgedFlag, reconciliation).ok, false, 'a flag that disagrees with the shortfall');

  const otherCore = { ...reconciliation.core, capSats: '10', marginSats: '49990' };
  const otherReconciliation = { ...reconciliation, core: otherCore, reconciliationHash: pa.sha256Hex(otherCore) };
  assertEq(rr.verifyTradeLayerReserveInsolvencyChallenge(challenge, otherReconciliation).ok, false, 'the reconciliation must be the one the challenge recomputes from');
});

// ---- perp challenge: the verdict follows from the claim ----
const POSITION = {
  side: 'long',
  entryPrice: 100,
  quantityUnits: 1,
  collateralSats: 1000,
  traderAddress: LTC,
  counterpartyAddress: LTC_2,
  contractId: 'perp-regression'
};

test('a perp challenge whose claim matches the settlement is not challengeable', () => {
  const settlement = pp.buildTradeLayerPerpPnlSettlement({ network: 'litecoin-testnet', epochId: 1, priceScale: 1, position: POSITION, close: { price: 100 } });
  const challenge = pp.buildTradeLayerPerpPnlChallenge(settlement, { challengeType: 'wrong_pnl_transfer' });
  assertEq(challenge.challengeable, true, 'the default claim is one sat off, so it is challengeable');
  const forged = { ...challenge, challengeable: false };
  assertEq(pp.verifyTradeLayerPerpPnlChallenge(forged, settlement).ok, false, 'verdict must match the claim');
  const honestCore = { ...challenge.core, claimed: { transferSats: settlement.settlementCore.transferSats } };
  const honest = { ...challenge, core: honestCore, challengeHash: pa.sha256Hex(honestCore) };
  assertEq(pp.verifyTradeLayerPerpPnlChallenge({ ...honest, challengeable: true }, settlement).ok, false, 'a claim equal to the settlement cannot be challengeable');
});

// ---- netting: the challenge type is bound to its core ----
const STATE_ORACLE_NETTING = {
  kind: 'tradelayer-pnl-state-oracle-v1',
  chain: 'litecoin-testnet',
  epochId: 9,
  snapshotHeight: 500,
  revealTxid: 'ab'.repeat(32),
  oracleAddress: LTC,
  dlcInput: { txid: 'dd'.repeat(32), vout: 0, address: LTC_2, sats: '10' },
  marks: { 'perp-regression': { price: 110 } },
  positions: [{ id: 'p1', contractId: 'perp-regression', side: 'long', traderAddress: LTC, counterpartyAddress: LTC_2, entryPrice: 100, quantityUnits: 1, priceScale: 1, collateralSats: 1000 }]
};

test('a netting challenge whose top-level type differs from its core is rejected', () => {
  const settlement = ps.buildTradeLayerPnlNettingSettlement(STATE_ORACLE_NETTING);
  const challenge = ps.buildTradeLayerPnlNettingChallenge(settlement, {
    challengeType: 'wrong_netting_edge',
    verifyOptions: { stateOracleBlob: STATE_ORACLE_NETTING }
  });
  assertEq(ps.verifyTradeLayerPnlNettingChallenge(challenge, settlement).ok, true);
  const relabelled = { ...challenge, challengeType: 'invalid_pnl_row' };
  assertEq(ps.verifyTradeLayerPnlNettingChallenge(relabelled, settlement).ok, false, 'the labelled type must be the hashed one');
});


// ---- checkpoint: the fraud-proof type is the hashed one ----
test('a checkpoint fraud proof whose top-level type differs from its hashed core is rejected', () => {
  const checkpoint = cp.buildTradeLayerStateCheckpoint({ acceptedTxids: ['11'.repeat(32)], rejectedTxids: [] });
  const notChallengeable = cp.buildTradeLayerCheckpointFraudProof(checkpoint, {
    proofType: 'invalid_accepted_tx',
    txid: 'ee'.repeat(32),
    rejectReason: 'x'
  });
  assertEq(notChallengeable.challengeable, false, 'a txid outside the accepted set is not an invalid accepted tx');
  assertEq(cp.verifyTradeLayerCheckpointFraudProof(notChallengeable, checkpoint).ok, true);
  const relabelled = { ...notChallengeable, proofType: 'state_root_mismatch' };
  assertEq(cp.verifyTradeLayerCheckpointFraudProof(relabelled, checkpoint).ok, false, 'the labelled type must be the hashed one');
});

// ---- policy: registry freshness is judged against a live height, never the snapshot ----
const POLICY_BLOB = {
  kind: 'tradelayer-send-state-oracle-v1',
  chain: 'litecoin-testnet',
  network: 'litecoin-testnet',
  epochId: 1,
  snapshotHeight: 1000,
  registryHeight: 10,
  oracleAddress: LTC,
  sends: [{ id: 's1', txid: 'cc'.repeat(32), toAddress: LTC_2, amountUnits: '100', depositUnits: '100', revealTxid: 'cc'.repeat(32) }],
  selectedSendId: 's1',
  dlcInput: { txid: 'dd'.repeat(32), vout: 0, address: LTC_2, sats: '100000' },
  sendBps: 10000
};

test('registry freshness fails without a live height and fails once the live height is past the window', () => {
  const noHeight = pol.buildTradeLayerSendProductionPolicy(POLICY_BLOB, { policy: { minChallengeWindowBlocks: 1 } });
  const freshness = noHeight.checks.find((item) => item.name === 'registry_freshness');
  assertEq(freshness.ok, false, 'no live height means no proof of freshness');
  const stale = pol.buildTradeLayerSendProductionPolicy(POLICY_BLOB, { policy: { minChallengeWindowBlocks: 1 }, currentHeight: 1000 + 2016 + 10 });
  assertEq(stale.checks.find((item) => item.name === 'registry_freshness').ok, false, 'past maxRegistryAgeBlocks is stale');
});

// ---- output scripts: an address and a scriptPubKey that disagree are refused ----
test('an output whose scriptPubKey does not match its address is refused, and scriptPubKey must be hex', () => {
  const other = pa.addressToScriptPubKey(LTC_2, 'litecoin-testnet').toString('hex');
  const mismatch = { route: 'pnl-netting', network: 'litecoin-testnet', outputPlan: [{ address: LTC, scriptPubKey: other, sats: '1000' }] };
  assert(throwsWith(() => pa.buildTradeLayerPnlCommitment(mismatch, { epochId: 1 }), /scriptPubKey/), 'address and script must agree');
  const notHex = { route: 'pnl-netting', network: 'litecoin-testnet', outputPlan: [{ scriptPubKey: '0014zz', sats: '1000' }] };
  assert(throwsWith(() => pa.buildTradeLayerPnlCommitment(notHex, { epochId: 1 }), /scriptPubKey must be hex/), 'hex must be canonical');
  const agree = { route: 'pnl-netting', network: 'litecoin-testnet', outputPlan: [{ address: LTC, scriptPubKey: pa.addressToScriptPubKey(LTC, 'litecoin-testnet').toString('hex'), sats: '1000' }] };
  assertEq(pa.buildTradeLayerPnlCommitment(agree, { epochId: 1 }).payoutTotalSats, 1000n);
});

// ---- claims are read against the committed inputs they name, not taken as written ----
function rehashed(challenge, core, hashField = 'challengeHash') {
  return { ...challenge, core, [hashField]: pa.sha256Hex(core) };
}

test('a request the queue holds but does not pay is not omitted', () => {
  const held = { id: 'wd-held', txid: '33'.repeat(32), address: PAYOUT_2, sats: '2000', propertyId: 0, status: 'pending' };
  const q = wq.buildTradeLayerWithdrawalQueue({
    network: NET,
    epochId: 77,
    requests: [{ id: 'wd-1', txid: '11'.repeat(32), address: PAYOUT, sats: 97000, propertyId: 0, status: 'approved' }, held]
  });
  const claim = wq.buildTradeLayerWithdrawalQueueChallenge(q, { challengeType: 'omitted_withdrawal', request: held });
  assertEq(claim.challengeable, false, 'a pending request is held out of the payable set on purpose');
  assertEq(wq.verifyTradeLayerWithdrawalQueueChallenge(claim, q).ok, true);
});

test('an amount or destination challenge must name what the queue holds for that request', () => {
  const q = queue();
  const amount = wq.buildTradeLayerWithdrawalQueueChallenge(q, { challengeType: 'amount_mismatch' });
  assertEq(amount.challengeable, true, 'the default claim is one sat off');
  const inflated = rehashed(amount, { ...amount.core, claimed: { ...amount.core.claimed, expectedSats: '90000', claimedSats: '90001' } });
  assertEq(wq.verifyTradeLayerWithdrawalQueueChallenge(inflated, q).ok, false, 'expectedSats must be the queue entry amount');
  const destination = wq.buildTradeLayerWithdrawalQueueChallenge(q, { challengeType: 'destination_mismatch' });
  const elsewhere = rehashed(destination, { ...destination.core, claimed: { ...destination.core.claimed, expectedAddress: PAYOUT_2 } });
  assertEq(wq.verifyTradeLayerWithdrawalQueueChallenge(elsewhere, q).ok, false, 'expectedAddress must be the queue entry address');
});

test('a perp challenge must name the settlement terms it claims against', () => {
  const settlement = pp.buildTradeLayerPerpPnlSettlement({ network: 'litecoin-testnet', epochId: 1, priceScale: 1, position: POSITION, close: { price: 100 } });
  const challenge = pp.buildTradeLayerPerpPnlChallenge(settlement, { challengeType: 'wrong_pnl_transfer' });
  const forged = rehashed(challenge, { ...challenge.core, expected: { ...challenge.core.expected, transferSats: '999' } });
  assertEq(pp.verifyTradeLayerPerpPnlChallenge(forged, settlement).ok, false, 'expected terms come from the settlement');
});

test('a checkpoint fraud proof must place its txid where the checkpoint does', () => {
  const checkpoint = cp.buildTradeLayerStateCheckpoint({ acceptedTxids: ['11'.repeat(32)], rejectedTxids: [] });
  const proof = cp.buildTradeLayerCheckpointFraudProof(checkpoint, { proofType: 'invalid_accepted_tx', txid: 'ee'.repeat(32), rejectReason: 'x' });
  const forged = { ...rehashed(proof, { ...proof.core, claimed: { ...proof.core.claimed, includedInAcceptedSet: true } }, 'proofHash'), challengeable: true };
  assertEq(cp.verifyTradeLayerCheckpointFraudProof(forged, checkpoint).ok, false, 'inclusion follows from the accepted set');
});

if (failed > 0) {
  console.log(`\nFAIL: ${failed} failed, ${passed} passed\n`);
  process.exit(1);
}

console.log(`\nPASS: ${passed} tests\n`);
