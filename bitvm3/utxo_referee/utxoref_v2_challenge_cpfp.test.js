const {
  btcToSats,
  buildCpfpPlan,
  runCpfp
} = require('./utxoref_v2_challenge_cpfp');
const { strictUnsignedTx } = require('./utxoref_v2');
const { monitorChallenge } = require('./utxoref_v2_watchtower');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

function fixture() {
  return {
    challenge: {
      graphHash: 'aa'.repeat(32),
      txid: '11'.repeat(32),
      vout: 0,
      outputSats: '5000',
      feeSats: '1000',
      challengeScriptPubKeyHex: `0014${'22'.repeat(20)}`,
      confirmation: null
    }
  };
}

test('CPFP plan spends only the tracked output and preserves its script', () => {
  const plan = buildCpfpPlan(fixture(), { feeSats: '1000' });
  const tx = strictUnsignedTx(plan.unsignedTxHex);
  assert(tx.vin.length === 1 && tx.vout.length === 1);
  assert(tx.vin[0].sequence === 0xfffffffd);
  assert(tx.vout[0].value === 4000n);
  assert(tx.vout[0].script.toString('hex') === plan.parentScriptPubKeyHex);
});

test('CPFP plan enforces integer amounts, native SegWit, and dust', () => {
  assert(btcToSats('0.00005000') === 5000n);
  for (const mutate of [
    (state) => { state.challenge.outputSats = '5.5'; },
    (state) => { state.challenge.challengeScriptPubKeyHex = '76a914' + '22'.repeat(20) + '88ac'; }
  ]) {
    const state = fixture();
    mutate(state);
    let rejected = false;
    try { buildCpfpPlan(state, { feeSats: '1000' }); } catch (_err) { rejected = true; }
    assert(rejected);
  }
  let dustRejected = false;
  try { buildCpfpPlan(fixture(), { feeSats: '4800' }); } catch (err) { dustRejected = /dust floor/.test(err.message); }
  assert(dustRejected);
});

test('CPFP signer preflights and broadcasts without adding wallet inputs', async () => {
  const state = fixture();
  const plan = buildCpfpPlan(state, { feeSats: '1000' });
  const calls = [];
  const rpc = async (method, params, wallet) => {
    calls.push({ method, params, wallet });
    if (method === 'getblockchaininfo') return { chain: 'testnet4' };
    if (method === 'gettxout') return {
      confirmations: 0,
      value: 0.00005,
      scriptPubKey: { hex: plan.parentScriptPubKeyHex }
    };
    if (method === 'signrawtransactionwithwallet') return { complete: true, hex: 'signed-child' };
    if (method === 'testmempoolaccept') return [{ allowed: true, vsize: 110 }];
    if (method === 'sendrawtransaction') return plan.txid;
    throw new Error(`unexpected RPC ${method}`);
  };
  const outcome = await runCpfp(state, { feeSats: '1000', wallet: 'utxoref-testnet', broadcast: true }, rpc);
  assert(outcome.action === 'cpfp_broadcast');
  assert(state.challenge.cpfp.txid === plan.txid);
  const signer = calls.find((call) => call.method === 'signrawtransactionwithwallet');
  assert(signer.wallet === 'utxoref-testnet');
  assert(signer.params[0] === plan.unsignedTxHex, 'wallet must sign the exact one-input plan');
});

test('watchtower follows the CPFP output after the parent is spent', async () => {
  const state = fixture();
  state.challenge.cpfp = {
    txid: '33'.repeat(32),
    vout: 0,
    outputSats: '4000',
    feeSats: '1000',
    confirmation: null
  };
  const calls = [];
  const result = await monitorChallenge(async (method, params) => {
    calls.push({ method, params });
    if (method === 'gettxout') return { confirmations: 2 };
    if (method === 'getblockhash') return '44'.repeat(32);
    throw new Error(`unexpected RPC ${method}`);
  }, state, 120);
  assert(calls[0].params[0] === state.challenge.cpfp.txid);
  assert(result.role === 'cpfp' && result.action === 'challenge_confirmed');
  assert(state.challenge.cpfp.confirmation.height === 119);
});

test('CPFP replacement verifies the parent and records child history', async () => {
  const state = fixture();
  state.challenge.cpfp = {
    txid: '33'.repeat(32),
    parentTxid: state.challenge.txid,
    feeSats: '500',
    outputSats: '4500',
    replacements: []
  };
  const plan = buildCpfpPlan(state, { feeSats: '1500', replaceChild: true });
  const rpc = async (method) => {
    if (method === 'getblockchaininfo') return { chain: 'testnet4' };
    if (method === 'getmempoolentry') return { 'bip125-replaceable': true };
    if (method === 'getrawtransaction') return {
      vout: [{ n: 0, value: 0.00005, scriptPubKey: { hex: plan.parentScriptPubKeyHex } }]
    };
    if (method === 'signrawtransactionwithwallet') return { complete: true, hex: 'signed-replacement-child' };
    if (method === 'sendrawtransaction') return plan.txid;
    throw new Error(`unexpected RPC ${method}`);
  };
  const outcome = await runCpfp(state, {
    feeSats: '1500',
    wallet: 'utxoref-testnet',
    replaceChild: true,
    broadcast: true
  }, rpc);
  assert(outcome.action === 'cpfp_replaced');
  assert(state.challenge.cpfp.feeSats === '1500');
  assert(state.challenge.cpfp.replacements.length === 1);
  assert(state.challenge.cpfp.replacements[0].txid === '33'.repeat(32));
});

(async () => {
  let passed = 0;
  let failed = 0;
  console.log('\n=== UTXORef V2 Challenge CPFP Tests ===\n');
  for (const item of tests) {
    try { await item.fn(); console.log(`  OK  ${item.name}`); passed++; }
    catch (err) { console.log(`  FAIL ${item.name}`); console.log(`       ${err.message}`); failed++; }
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
