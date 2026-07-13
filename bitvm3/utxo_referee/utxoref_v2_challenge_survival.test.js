const {
  createChallengeSurvivalState,
  applyChallengeSurvivalEvent,
  verifyReceiptChain,
  runChallengeSurvivalScenario,
  defaultChallengeSurvivalScenarios
} = require('./utxoref_v2_challenge_survival');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

test('default corpus separates surviving and failed challenge paths', () => {
  const results = defaultChallengeSurvivalScenarios().map(runChallengeSurvivalScenario);
  const byName = Object.fromEntries(results.map((result) => [result.name, result]));
  assert(results.every((result) => result.receiptVerification.ok), 'every default receipt chain must verify');
  for (const name of ['baseline-confirmation', 'parent-eviction-rebroadcast', 'pinning-clears-with-margin', 'superseded-conflict-wins', 'reorg-and-reconfirm']) {
    assert(byName[name].survived, `${name} should survive`);
  }
  assert(!byName['unisolated-reserve-depletion'].survived);
  assert(/isolated reserve/.test(byName['unisolated-reserve-depletion'].errors[0].message));
  assert(!byName['deadline-compression-failure'].survived);
  assert(byName['deadline-compression-failure'].state.status === 'expired');
});

test('replacement reserves only the winning maximum fee', () => {
  const state = createChallengeSurvivalState({ feeReserveSats: 10000, maxFeeSats: 10000 });
  applyChallengeSurvivalEvent(state, { type: 'broadcast_child', txid: '11'.repeat(32), feeSats: 1000 });
  applyChallengeSurvivalEvent(state, { type: 'replace_child', txid: '22'.repeat(32), feeSats: 3000 });
  assert(state.reservedFeeSats === 3000, 'replacement should reserve its fee, not sum attempts');
  assert(state.feeReserveSats === 10000, 'broadcast attempts must not consume the reserve balance');
});

test('isolated reserve rejects unrelated consumption', () => {
  const state = createChallengeSurvivalState();
  let rejected = false;
  try { applyChallengeSurvivalEvent(state, { type: 'consume_reserve', source: 'other-contract', sats: 1, isolatedReserve: true }); }
  catch (err) { rejected = /rejects unrelated/.test(err.message); }
  assert(rejected);
});

test('parent eviction and pinning block child publication', () => {
  const evicted = createChallengeSurvivalState();
  applyChallengeSurvivalEvent(evicted, { type: 'evict_parent' });
  let missingParent = false;
  try { applyChallengeSurvivalEvent(evicted, { type: 'broadcast_child', feeSats: 1000 }); }
  catch (err) { missingParent = /parent is absent/.test(err.message); }
  assert(missingParent);
  const pinned = createChallengeSurvivalState();
  applyChallengeSurvivalEvent(pinned, { type: 'pin', blocks: 2 });
  let pinRejected = false;
  try { applyChallengeSurvivalEvent(pinned, { type: 'broadcast_child', feeSats: 1000 }); }
  catch (err) { pinRejected = /pinned until/.test(err.message); }
  assert(pinRejected);
});

test('replacement fees increase and stay inside fee and dust bounds', () => {
  const state = createChallengeSurvivalState({ challengeOutputSats: 5000, maxFeeSats: 4500, feeReserveSats: 4500 });
  applyChallengeSurvivalEvent(state, { type: 'broadcast_child', feeSats: 1000 });
  for (const [feeSats, pattern] of [[1000, /must increase/], [4600, /maxFeeSats/]]) {
    let rejected = false;
    try { applyChallengeSurvivalEvent(state, { type: 'replace_child', feeSats }); }
    catch (err) { rejected = pattern.test(err.message); }
    assert(rejected, `fee ${feeSats} should reject`);
  }
});

test('a superseded tracked child can become the confirmed winner', () => {
  const state = createChallengeSurvivalState();
  const oldTxid = '33'.repeat(32);
  applyChallengeSurvivalEvent(state, { type: 'broadcast_child', txid: oldTxid, feeSats: 1000 });
  applyChallengeSurvivalEvent(state, { type: 'replace_child', txid: '44'.repeat(32), feeSats: 2000 });
  const result = applyChallengeSurvivalEvent(state, { type: 'confirm', txid: oldTxid });
  assert(result.supersededWinner === true);
  assert(state.activeChild.txid === oldTxid);
});

test('reorg clears terminal confirmation and allows a bounded replacement', () => {
  const state = createChallengeSurvivalState();
  applyChallengeSurvivalEvent(state, { type: 'broadcast_child', txid: '55'.repeat(32), feeSats: 1000 });
  applyChallengeSurvivalEvent(state, { type: 'confirm', txid: '55'.repeat(32) });
  applyChallengeSurvivalEvent(state, { type: 'advance', blocks: 1 });
  assert(state.status === 'confirmed');
  const heightBeforeReorg = state.height;
  applyChallengeSurvivalEvent(state, { type: 'reorg', depth: 2 });
  assert(state.status === 'active' && state.confirmation === null);
  assert(state.height === heightBeforeReorg - 2, 'reorg must roll back modeled chain height');
  applyChallengeSurvivalEvent(state, { type: 'replace_child', feeSats: 3000 });
  assert(state.activeChild.feeSats === 3000);
});

test('a shallow reorg cannot remove a deeper confirmation', () => {
  const state = createChallengeSurvivalState();
  applyChallengeSurvivalEvent(state, { type: 'broadcast_child', txid: '77'.repeat(32), feeSats: 1000 });
  applyChallengeSurvivalEvent(state, { type: 'confirm', txid: '77'.repeat(32) });
  applyChallengeSurvivalEvent(state, { type: 'advance', blocks: 2 });
  let rejected = false;
  try { applyChallengeSurvivalEvent(state, { type: 'reorg', depth: 2 }); }
  catch (err) { rejected = /does not remove/.test(err.message); }
  assert(rejected, 'reorg must reach the challenge confirmation block');
});

test('receipt chain detects state-event tampering', () => {
  const state = createChallengeSurvivalState();
  applyChallengeSurvivalEvent(state, { type: 'broadcast_child', feeSats: 1000 });
  applyChallengeSurvivalEvent(state, { type: 'advance', blocks: 1 });
  assert(verifyReceiptChain(state).ok);
  state.receipts[0].core.result.feeSats = 9999;
  assert(!verifyReceiptChain(state).ok);
});

test('receipt chain binds the final modeled state', () => {
  const state = createChallengeSurvivalState();
  applyChallengeSurvivalEvent(state, { type: 'broadcast_child', feeSats: 1000 });
  assert(verifyReceiptChain(state).ok);
  state.feeReserveSats -= 1;
  const verification = verifyReceiptChain(state);
  assert(!verification.ok && /final state/.test(verification.reason));
});

let passed = 0;
let failed = 0;
for (const item of tests) {
  try { item.fn(); console.log(`  OK  ${item.name}`); passed += 1; }
  catch (err) { console.log(`  FAIL ${item.name}\n       ${err.message}`); failed += 1; }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
if (failed) process.exit(1);
