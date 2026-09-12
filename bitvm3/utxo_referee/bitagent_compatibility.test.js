/**
 * BitAgent integration contract for UTXORef.
 * Run: node bitvm3/utxo_referee/bitagent_compatibility.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const referee = require('./index');
const reserveVault = require('./taproot_reserve_vault');

const txidA = 'aa'.repeat(32);
const txidB = 'bb'.repeat(32);
const scriptA = '0014' + '11'.repeat(20);
const scriptB = '5120' + '22'.repeat(32);
const generatorXonly = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

function throwsMatching(fn, pattern) {
  assert.throws(fn, (error) => pattern.test(error.message));
}

assert.strictEqual(typeof referee.ReceiptDepositIndexer, 'function');
assert.strictEqual(typeof referee.v2?.settlement?.buildFundingSetV2, 'function');

const single = referee.v2.settlement.buildFundingSetV2([{
  txid: txidA,
  vout: 0,
  amountSats: '6000',
  scriptPubKeyHex: scriptA
}]);
assert.strictEqual(single.fundingCount, 1);
assert.strictEqual(single.fundingTotalSats, '6000');
assert.strictEqual(single.fundingRoot.length, 64);
assert.deepStrictEqual(single.funding[0], {
  index: 0,
  txid: txidA,
  vout: 0,
  amountSats: '6000',
  scriptPubKeyHex: scriptA
});

const ordered = referee.v2.settlement.buildFundingSetV2([
  { txid: txidA, vout: 0, amountSats: '6000', scriptPubKeyHex: scriptA },
  { txid: txidB, vout: 7, amountSats: '9000', scriptPubKeyHex: scriptB }
]);
const reversed = referee.v2.settlement.buildFundingSetV2([
  { txid: txidB, vout: 7, amountSats: '9000', scriptPubKeyHex: scriptB },
  { txid: txidA, vout: 0, amountSats: '6000', scriptPubKeyHex: scriptA }
]);
assert.strictEqual(ordered.fundingTotalSats, '15000');
assert.strictEqual(ordered.fundingRoot, '9fe1edb8997282ceabb3144f720634d8fb2bdbc1d9202edc7b9ef417ba20d421');
assert.notStrictEqual(ordered.fundingRoot, reversed.fundingRoot);
assert.deepStrictEqual(
  ordered,
  referee.v2.settlement.buildFundingSetV2([
    { txid: txidA, vout: 0, amountSats: 6000n, scriptPubKeyHex: scriptA.toUpperCase() },
    { txid: txidB, vout: 7, amountSats: 9000, scriptPubKey: Buffer.from(scriptB, 'hex') }
  ])
);
throwsMatching(() => referee.v2.settlement.buildFundingSetV2([]), /non-empty/);
throwsMatching(() => referee.v2.settlement.buildFundingSetV2([
  { txid: txidA, vout: 0, amountSats: '1', scriptPubKeyHex: scriptA },
  { txid: txidA, vout: 0, amountSats: '2', scriptPubKeyHex: scriptA }
]), /duplicate funding outpoint/);
throwsMatching(() => referee.v2.settlement.buildFundingSetV2([
  { txid: txidA, vout: 0, amountSats: '0', scriptPubKeyHex: scriptA }
]), /must be positive/);
throwsMatching(() => referee.v2.settlement.buildFundingSetV2([
  { txid: txidA, vout: 0x100000000, amountSats: '1', scriptPubKeyHex: scriptA }
]), /must fit u32/);
throwsMatching(() => referee.v2.settlement.buildFundingSetV2([
  { txid: txidA, vout: 0, amountSats: '1', scriptPubKeyHex: 'abc' }
]), /even-length hex/);

const indexer = new referee.ReceiptDepositIndexer({
  network: 'bitcoin-testnet4',
  minConfirmations: 3
});
const unconfirmed = indexer.observeDeposit({
  depositId: 'bitagent:deposit:1',
  accountId: 'wallet-session',
  txid: txidA,
  vout: 0,
  amountSats: '6000',
  blockHeight: 100,
  targetScriptPubKey: scriptA
}, 101);
assert.strictEqual(unconfirmed.status, 'observed');
assert.strictEqual(unconfirmed.confirmations, 2);
const confirmed = indexer.observeDeposit({
  depositId: 'bitagent:deposit:1',
  accountId: 'wallet-session',
  txid: txidA,
  vout: 0,
  amountSats: '6000',
  blockHeight: 100,
  targetScriptPubKey: scriptA
}, 102);
assert.strictEqual(confirmed.status, 'confirmed');
assert.strictEqual(indexer.buildLedgerCreditEvent(confirmed.depositId).amountSats, 6000n);

const bindingA = crypto.createHash('sha256').update('bitagent-plan-a').digest('hex');
const bindingB = crypto.createHash('sha256').update('bitagent-plan-b').digest('hex');
const vaultA = reserveVault.buildTaprootReserveVaultTemplate({
  network: 'bitcoin-testnet4',
  operatorXonly: generatorXonly,
  guardianXonly: generatorXonly,
  recoveryXonly: generatorXonly,
  recoveryCsvDelay: 2016,
  bindingHash: bindingA
});
const vaultARepeat = reserveVault.buildTaprootReserveVaultTemplate({
  network: 'bitcoin-testnet4',
  operatorXonly: generatorXonly,
  guardianXonly: generatorXonly,
  recoveryXonly: generatorXonly,
  recoveryCsvDelay: 2016,
  bindingHash: bindingA
});
const vaultB = reserveVault.buildTaprootReserveVaultTemplate({
  network: 'bitcoin-testnet4',
  operatorXonly: generatorXonly,
  guardianXonly: generatorXonly,
  recoveryXonly: generatorXonly,
  recoveryCsvDelay: 2016,
  bindingHash: bindingB
});
assert.strictEqual(vaultA.p2trScriptPubKey.slice(0, 4), '5120');
assert.strictEqual(vaultA.p2trScriptPubKey.length, 68);
assert.strictEqual(vaultA.merkleRoot.length, 64);
assert.deepStrictEqual(vaultA, vaultARepeat);
assert.notStrictEqual(vaultA.p2trScriptPubKey, vaultB.p2trScriptPubKey);
assert.strictEqual(vaultA.immediateLeaf.controlBlock.length, 130);
assert.strictEqual(vaultA.recoveryLeaf.controlBlock.length, 130);

console.log(JSON.stringify({
  ok: true,
  fundingRoot: ordered.fundingRoot,
  depositStatus: confirmed.status,
  reserveScriptPubKey: vaultA.p2trScriptPubKey
}, null, 2));
