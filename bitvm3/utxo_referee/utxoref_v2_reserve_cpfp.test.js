const {
  buildReserveCpfpPlan,
  reserveSpendSighash,
  buildReserveGuardianApproval,
  verifyReserveGuardianApproval,
  verifyReserveGuardianApprovalSet,
  verifyApprovalChainFreshness,
  assertDecodedPlanBinding,
  finalizeReserveCpfp,
  preflightFinalTransaction,
  runReserveCpfp
} = require('./utxoref_v2_reserve_cpfp');
const { buildUtxorefV2FeeReserve } = require('./utxoref_v2_fee_reserve');
const { buildGuardianQuorumFeeReserve } = require('./utxoref_v2_guardian_quorum_reserve');
const tr = require('./tradelayer_taproot');
const a = require('./tradelayer_dlc_adaptor_sig');
const { txidFromUnsignedHex } = require('./recover_btc_testnet4_reserve_vault');
const { monitorChallenge } = require('./utxoref_v2_watchtower');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }

const CHALLENGER_SECRET = 11n;
const GUARDIAN_SECRET = 12n;
const REFUND_SECRET = 13n;
const QUORUM_GUARDIAN_SECRETS = [12n, 14n, 15n];
const BEST_BLOCK_HASH = '99'.repeat(32);

function fixture() {
  const graphHash = 'aa'.repeat(32);
  const artifact = {
    kind: 'btc_testnet4_utxoref_v2_live_ceremony',
    version: 2,
    graph: {
      graphHash,
      assertionOutpoint: { txid: 'bb'.repeat(32), vout: 2, amountSats: '100000' }
    }
  };
  const state = {
    kind: 'utxoref_v2_watchtower_state',
    challenge: {
      graphHash,
      vout: 0,
      outputSats: '99000',
      feeSats: '1000',
      challengeScriptPubKeyHex: `0014${'22'.repeat(20)}`,
      confirmation: null
    }
  };
  const challengeUnsigned = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(artifact.graph.assertionOutpoint.txid, artifact.graph.assertionOutpoint.vout),
    sequence: 0xfffffffd
  }], [{ valueSats: 99000n, script: state.challenge.challengeScriptPubKeyHex }], 0);
  state.challenge.txid = txidFromUnsignedHex(challengeUnsigned);
  const reserve = buildUtxorefV2FeeReserve({
    network: 'bitcoin-testnet4',
    graphHash,
    disputeId: 'reserve-cpfp-test',
    fundingOutpoint: { txid: 'cc'.repeat(32), vout: 1 },
    fundingHeight: 100,
    amountSats: 30000,
    maxFeeSats: 10000,
    challengeWindowBlocks: 18,
    confirmationTarget: 2,
    recoverySafetyBlocks: 6,
    recoveryCsvDelay: 144,
    challengerXonly: a.xOnlyPubkey(CHALLENGER_SECRET).toString('hex'),
    guardianXonly: a.xOnlyPubkey(GUARDIAN_SECRET).toString('hex'),
    refundXonly: a.xOnlyPubkey(REFUND_SECRET).toString('hex')
  });
  state.challenge.feeReserveHash = reserve.reserveHash;
  state.challenge.feeReserveOutpoint = `${reserve.core.vaultManifest.core.fundingOutpoint.txid}:1`;
  const chainEvidence = {
    chain: 'testnet4',
    height: 110,
    bestBlockHash: BEST_BLOCK_HASH,
    challengeConfirmations: 0,
    reserveConfirmations: 11,
    reserveStatus: 'available'
  };
  return { artifact, state, reserve, chainEvidence };
}

function quorumFixture() {
  const data = fixture();
  const reserve = buildGuardianQuorumFeeReserve({
    network: 'bitcoin-testnet4',
    graphHash: data.artifact.graph.graphHash,
    disputeId: 'reserve-cpfp-quorum-test',
    fundingOutpoint: { txid: 'cd'.repeat(32), vout: 1 },
    fundingHeight: 100,
    amountSats: 30000,
    maxFeeSats: 10000,
    challengeWindowBlocks: 18,
    confirmationTarget: 2,
    recoverySafetyBlocks: 6,
    recoveryCsvDelay: 144,
    challengerXonly: a.xOnlyPubkey(CHALLENGER_SECRET).toString('hex'),
    guardianXonlys: QUORUM_GUARDIAN_SECRETS.map((secret) => a.xOnlyPubkey(secret).toString('hex')),
    guardianThreshold: 2,
    refundXonly: a.xOnlyPubkey(REFUND_SECRET).toString('hex')
  });
  data.reserve = reserve;
  data.state.challenge.feeReserveHash = reserve.reserveHash;
  data.state.challenge.feeReserveOutpoint = `${reserve.core.vaultManifest.core.fundingOutpoint.txid}:1`;
  return data;
}

function btc(sats) {
  return Number((Number(sats) / 100000000).toFixed(8));
}

function decodedPlan(plan, options = {}) {
  const reserveWitness = options.reserveWitness || [];
  return {
    txid: options.txid || plan.txid,
    hash: options.hash || '77'.repeat(32),
    vin: [
      {
        txid: plan.challenge.txid,
        vout: plan.challenge.vout,
        sequence: 0xfffffffd,
        scriptSig: { hex: '' },
        ...(options.walletWitness ? { txinwitness: options.walletWitness } : {})
      },
      {
        txid: plan.reserve.txid,
        vout: plan.reserve.vout,
        sequence: 0xfffffffd,
        scriptSig: { hex: '' },
        ...(reserveWitness.length ? { txinwitness: reserveWitness } : {})
      }
    ],
    vout: [{ n: 0, value: btc(plan.outputSats), scriptPubKey: { hex: plan.outputScriptPubKeyHex } }]
  };
}

function initialRpc(plan, reserve, options = {}) {
  const walletWitness = ['aa'.repeat(64)];
  let finalizedHex = null;
  const calls = [];
  const rpc = async (method, params, wallet) => {
    calls.push({ method, params, wallet });
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 110, bestblockhash: BEST_BLOCK_HASH };
    if (method === 'getblockhash') return BEST_BLOCK_HASH;
    if (method === 'gettxout' && params[0] === plan.challenge.txid) return {
      confirmations: 0,
      bestblock: BEST_BLOCK_HASH,
      value: btc(plan.challenge.amountSats),
      scriptPubKey: { hex: plan.challenge.scriptPubKeyHex }
    };
    if (method === 'gettxout' && params[0] === plan.reserve.txid) return {
      confirmations: 11,
      bestblock: BEST_BLOCK_HASH,
      value: btc(plan.reserve.amountSats),
      scriptPubKey: { hex: plan.reserve.scriptPubKeyHex }
    };
    if (method === 'signrawtransactionwithwallet') return { complete: false, hex: 'partial-wallet-hex' };
    if (method === 'decoderawtransaction' && params[0] === 'partial-wallet-hex') {
      return decodedPlan(plan, {
        walletWitness,
        reserveWitness: options.walletAddsReserveWitness ? ['11'] : []
      });
    }
    if (method === 'decoderawtransaction') {
      finalizedHex = params[0];
      const leaf = reserve.core.vaultManifest.core.leaves[
        plan.reserve.guardianPolicyKind === 'guardian-quorum'
          ? 'immediate-operator-guardian-quorum'
          : 'immediate-operator-guardian'
      ];
      const approvals = options.approvals || [options.approval];
      const byGuardian = Object.fromEntries(approvals.map((approval) => [
        approval.core.guardianXonly,
        approval.transactionSignature
      ]));
      const guardianSignatures = (reserve.core.vaultManifest.core.guardianXonlys ||
        [reserve.core.vaultManifest.core.guardianXonly])
        .slice()
        .reverse()
        .map((guardianXonly) => byGuardian[guardianXonly] || '');
      const challengerSignature = options.challengerSignature();
      return decodedPlan(plan, {
        walletWitness,
        reserveWitness: [...guardianSignatures, challengerSignature, leaf.scriptHex, leaf.controlBlock]
      });
    }
    if (method === 'testmempoolaccept') return [{ allowed: true, txid: plan.txid, wtxid: '77'.repeat(32), vsize: 260 }];
    if (method === 'sendrawtransaction') return plan.txid;
    throw new Error(`unexpected RPC ${method}`);
  };
  return { rpc, calls, walletWitness, getFinalizedHex: () => finalizedHex };
}

test('reserve CPFP has exactly two fixed inputs and preserves challenge principal', () => {
  const { artifact, state, reserve } = fixture();
  const plan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  const parsed = tr.parseTx(plan.unsignedTxHex);
  assert(parsed.vin.length === 2 && parsed.vout.length === 1);
  assert(parsed.vin.every((input) => input.sequence === 0xfffffffd));
  assert(parsed.vout[0].value === 127000n);
  assert(plan.outputSats === '127000');
  assert(BigInt(plan.outputSats) >= BigInt(plan.challenge.amountSats));
  assert(plan.txid === txidFromUnsignedHex(plan.unsignedTxHex));
});

test('reserve CPFP rejects fee-cap, reserve-binding, and old child mode violations', () => {
  for (const mutate of [
    ({ args }) => { args.feeSats = '10001'; },
    ({ state }) => { state.challenge.feeReserveHash = 'ff'.repeat(32); },
    ({ state }) => {
      state.challenge.cpfp = { txid: 'dd'.repeat(32), mode: 'wallet-only', feeSats: '1000', outputSats: '98000' };
    }
  ]) {
    const data = fixture();
    const args = { feeSats: '2000', replaceChild: false };
    mutate({ ...data, args });
    if (data.state.challenge.cpfp) args.replaceChild = true;
    let rejected = false;
    try { buildReserveCpfpPlan(data.state, args, data.artifact, data.reserve); }
    catch (_err) { rejected = true; }
    assert(rejected);
  }
});

test('guardian approval signs both the exact transaction and its authorization evidence', () => {
  const { artifact, state, reserve, chainEvidence } = fixture();
  const plan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  const approval = buildReserveGuardianApproval(plan, reserve, chainEvidence, GUARDIAN_SECRET, {
    authorizedAt: '2026-07-13T00:00:00.000Z'
  });
  const check = verifyReserveGuardianApproval(approval, plan, reserve);
  assert(check.ok, check.reason);
  assert(approval.core.guardianSetHash === undefined, 'legacy approval metadata shape changed');
  assert(approval.core.guardianThreshold === undefined, 'legacy approval metadata shape changed');
  assert(approval.core.transactionSighash === reserveSpendSighash(plan, reserve).toString('hex'));
  const differentPlan = buildReserveCpfpPlan(state, { feeSats: '3000' }, artifact, reserve);
  assert(!verifyReserveGuardianApproval(approval, differentPlan, reserve).ok, 'approval replayed across fee plans');
  const tampered = JSON.parse(JSON.stringify(approval));
  tampered.core.outputSats = '126999';
  tampered.approvalHash = require('./tradelayer_pnl_route_adapter').sha256Hex({
    ...tampered,
    approvalHash: undefined
  });
  assert(!verifyReserveGuardianApproval(tampered, plan, reserve).ok);
});

test('guardian approval fails after its block is reorged or freshness budget expires', async () => {
  const { artifact, state, reserve, chainEvidence } = fixture();
  const plan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  const approval = buildReserveGuardianApproval(plan, reserve, chainEvidence, GUARDIAN_SECRET);
  let staleRejected = false;
  try {
    await verifyApprovalChainFreshness(approval, async () => BEST_BLOCK_HASH, {
      chain: 'testnet4', blocks: 117, bestblockhash: BEST_BLOCK_HASH
    });
  } catch (err) { staleRejected = /stale/.test(err.message); }
  assert(staleRejected);
  let reorgRejected = false;
  try {
    await verifyApprovalChainFreshness(approval, async () => '88'.repeat(32), {
      chain: 'testnet4', blocks: 110, bestblockhash: '88'.repeat(32)
    });
  } catch (err) { reorgRejected = /reorged/.test(err.message); }
  assert(reorgRejected);
});

test('finalizer rejects the wrong challenger and assembles the exact tapscript witness', () => {
  const { artifact, state, reserve, chainEvidence } = fixture();
  const plan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  const approval = buildReserveGuardianApproval(plan, reserve, chainEvidence, GUARDIAN_SECRET);
  let wrongKeyRejected = false;
  try { finalizeReserveCpfp(plan, reserve, approval, 14n, ['aa']); }
  catch (err) { wrongKeyRejected = /challenger secret/.test(err.message); }
  assert(wrongKeyRejected);
  const finalized = finalizeReserveCpfp(plan, reserve, approval, CHALLENGER_SECRET, ['aa']);
  assert(finalized.txid === plan.txid);
  assert(finalized.guardianApprovalHashes.length === 1);
  assert(finalized.guardianApprovalHashes[0] === approval.approvalHash);
  assert(finalized.guardianApprovalHash === finalized.guardianApprovalSetHash);
  assert(/^[0-9a-f]+$/.test(finalized.witnessTxHex));
});

test('guardian quorum requires distinct threshold approvals and fills fixed witness slots', () => {
  const { artifact, state, reserve, chainEvidence } = quorumFixture();
  const plan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  assert(plan.reserve.guardianThreshold === 2);
  assert(plan.reserve.guardianCount === 3);
  const approvals = [QUORUM_GUARDIAN_SECRETS[0], QUORUM_GUARDIAN_SECRETS[2]]
    .map((secret) => buildReserveGuardianApproval(plan, reserve, chainEvidence, secret));
  const setCheck = verifyReserveGuardianApprovalSet(approvals, plan, reserve);
  assert(setCheck.ok && setCheck.approvedGuardianCount === 2);
  assert(!verifyReserveGuardianApprovalSet(approvals.slice(0, 1), plan, reserve).ok);
  assert(/duplicate/.test(verifyReserveGuardianApprovalSet([approvals[0], approvals[0]], plan, reserve).reason));

  const finalized = finalizeReserveCpfp(plan, reserve, approvals, CHALLENGER_SECRET, ['aa']);
  assert(finalized.guardianTransactionSignatures.length === 3);
  assert(finalized.guardianTransactionSignatures[0] === approvals[1].transactionSignature);
  assert(finalized.guardianTransactionSignatures[1] === '');
  assert(finalized.guardianTransactionSignatures[2] === approvals[0].transactionSignature);
  assert(finalized.guardianApprovalHashes.length === 2);
});

test('live preflight rejects wallet authority over the guardian reserve input', async () => {
  const { artifact, state, reserve, chainEvidence } = fixture();
  const plan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  const approval = buildReserveGuardianApproval(plan, reserve, chainEvidence, GUARDIAN_SECRET);
  const harness = initialRpc(plan, reserve, {
    approval,
    walletAddsReserveWitness: true,
    challengerSignature: () => '00'.repeat(64)
  });
  let rejected = false;
  try {
    await preflightFinalTransaction(plan, reserve, approval, CHALLENGER_SECRET, { wallet: 'test-wallet' }, harness.rpc);
  } catch (err) { rejected = /unexpectedly supplied the reserve witness/.test(err.message); }
  assert(rejected);
});

test('reserve CPFP broadcasts and records the reserve lifecycle', async () => {
  const { artifact, state, reserve, chainEvidence } = fixture();
  const args = { feeSats: '2000', wallet: 'test-wallet', broadcast: true };
  const plan = buildReserveCpfpPlan(state, args, artifact, reserve);
  const approval = buildReserveGuardianApproval(plan, reserve, chainEvidence, GUARDIAN_SECRET);
  let challengerSignature = null;
  const harness = initialRpc(plan, reserve, {
    approval,
    challengerSignature: () => challengerSignature
  });
  const originalDecoder = harness.rpc;
  const rpc = async (method, params, wallet) => {
    if (method === 'decoderawtransaction' && params[0] !== 'partial-wallet-hex') {
      const finalized = finalizeReserveCpfp(plan, reserve, approval, CHALLENGER_SECRET, harness.walletWitness);
      challengerSignature = finalized.challengerSignature;
    }
    return originalDecoder(method, params, wallet);
  };
  const outcome = await runReserveCpfp(state, args, rpc, artifact, reserve, approval, CHALLENGER_SECRET);
  assert(outcome.action === 'reserve_cpfp_broadcast');
  assert(state.challenge.cpfp.mode === 'reserve-backed');
  assert(state.challenge.cpfp.reserveHash === reserve.reserveHash);
  assert(state.challenge.feeReserveLifecycle.status === 'committed_to_cpfp');
  assert(state.challenge.feeReserveLifecycle.activeCpfpTxid === plan.txid);
  assert(harness.getFinalizedHex(), 'final witness transaction was not decoded');
});

test('reserve CPFP replacement reuses both inputs and records superseded authority', async () => {
  const { artifact, state, reserve, chainEvidence } = fixture();
  const initialPlan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  state.challenge.cpfp = {
    mode: 'reserve-backed',
    txid: initialPlan.txid,
    vout: 0,
    parentTxid: initialPlan.challenge.txid,
    feeSats: initialPlan.feeSats,
    outputSats: initialPlan.outputSats,
    scriptPubKeyHex: initialPlan.outputScriptPubKeyHex,
    reserveHash: reserve.reserveHash,
    reserveOutpoint: initialPlan.reserve.outpoint,
    reserveAmountSats: initialPlan.reserve.amountSats,
    guardianApprovalHash: '55'.repeat(32),
    replacements: []
  };
  state.challenge.feeReserveLifecycle = {
    reserveHash: reserve.reserveHash,
    outpoint: initialPlan.reserve.outpoint,
    amountSats: initialPlan.reserve.amountSats,
    status: 'committed_to_cpfp',
    activeCpfpTxid: initialPlan.txid,
    replacements: []
  };
  const args = { feeSats: '5000', replaceChild: true, wallet: 'test-wallet', broadcast: true };
  const plan = buildReserveCpfpPlan(state, args, artifact, reserve);
  const replacementEvidence = { ...chainEvidence, reserveStatus: 'committed_to_replacement' };
  const approval = buildReserveGuardianApproval(plan, reserve, replacementEvidence, GUARDIAN_SECRET);
  const walletWitness = ['aa'.repeat(64)];
  let challengerSignature;
  const rpc = async (method, params) => {
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: 110, bestblockhash: BEST_BLOCK_HASH };
    if (method === 'getblockhash') return BEST_BLOCK_HASH;
    if (method === 'getmempoolentry') return { 'bip125-replaceable': true };
    if (method === 'getrawtransaction' && params[0] === initialPlan.txid) {
      const existing = decodedPlan(plan, { txid: initialPlan.txid });
      existing.vout[0].value = btc(initialPlan.outputSats);
      return existing;
    }
    if (method === 'getrawtransaction' && params[0] === plan.challenge.txid) return {
      confirmations: 0,
      vout: [{ n: plan.challenge.vout, value: btc(plan.challenge.amountSats), scriptPubKey: { hex: plan.challenge.scriptPubKeyHex } }]
    };
    if (method === 'getrawtransaction' && params[0] === plan.reserve.txid) return {
      confirmations: 11,
      vout: [{ n: plan.reserve.vout, value: btc(plan.reserve.amountSats), scriptPubKey: { hex: plan.reserve.scriptPubKeyHex } }]
    };
    if (method === 'signrawtransactionwithwallet') return { complete: false, hex: 'partial-wallet-hex' };
    if (method === 'decoderawtransaction' && params[0] === 'partial-wallet-hex') {
      return decodedPlan(plan, { walletWitness });
    }
    if (method === 'decoderawtransaction') {
      const finalized = finalizeReserveCpfp(plan, reserve, approval, CHALLENGER_SECRET, walletWitness);
      challengerSignature = finalized.challengerSignature;
      const leaf = reserve.core.vaultManifest.core.leaves['immediate-operator-guardian'];
      return decodedPlan(plan, {
        walletWitness,
        reserveWitness: [approval.transactionSignature, challengerSignature, leaf.scriptHex, leaf.controlBlock]
      });
    }
    if (method === 'sendrawtransaction') return plan.txid;
    throw new Error(`unexpected RPC ${method}`);
  };
  const outcome = await runReserveCpfp(state, args, rpc, artifact, reserve, approval, CHALLENGER_SECRET);
  assert(outcome.action === 'reserve_cpfp_replaced');
  assert(state.challenge.cpfp.txid === plan.txid);
  assert(state.challenge.cpfp.replacements.length === 1);
  assert(state.challenge.cpfp.replacements[0].txid === initialPlan.txid);
  assert(state.challenge.feeReserveLifecycle.status === 'committed_to_replacement');
  assert(state.challenge.feeReserveLifecycle.replacements.length === 1);
});

test('watchtower marks a confirmed reserve-backed CPFP as consumed', async () => {
  const { artifact, state, reserve } = fixture();
  const plan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  state.challenge.cpfp = {
    mode: 'reserve-backed',
    txid: plan.txid,
    vout: 0,
    parentTxid: plan.challenge.txid,
    feeSats: plan.feeSats,
    outputSats: plan.outputSats,
    scriptPubKeyHex: plan.outputScriptPubKeyHex,
    reserveHash: reserve.reserveHash,
    reserveOutpoint: plan.reserve.outpoint,
    replacements: [],
    confirmation: null
  };
  state.challenge.feeReserveLifecycle = {
    reserveHash: reserve.reserveHash,
    outpoint: plan.reserve.outpoint,
    amountSats: plan.reserve.amountSats,
    status: 'committed_to_cpfp',
    activeCpfpTxid: plan.txid,
    replacements: []
  };
  const result = await monitorChallenge(async (method) => {
    if (method === 'gettxout') return {
      confirmations: 2,
      value: btc(plan.outputSats),
      scriptPubKey: { hex: plan.outputScriptPubKeyHex }
    };
    if (method === 'getblockhash') return '88'.repeat(32);
    throw new Error(method);
  }, state, 120);
  assert(result.action === 'challenge_confirmed');
  assert(state.challenge.feeReserveLifecycle.status === 'consumed_confirmed');
  assert(state.challenge.feeReserveLifecycle.confirmation.height === 119);
});

test('decoded transaction binding rejects output and input mutations', () => {
  const { artifact, state, reserve } = fixture();
  const plan = buildReserveCpfpPlan(state, { feeSats: '2000' }, artifact, reserve);
  assertDecodedPlanBinding(plan, decodedPlan(plan));
  const changed = decodedPlan(plan);
  changed.vin.reverse();
  let rejected = false;
  try { assertDecodedPlanBinding(plan, changed); } catch (err) { rejected = /input 0 outpoint/.test(err.message); }
  assert(rejected);
});

(async () => {
  let passed = 0;
  let failed = 0;
  console.log('\n=== UTXORef V2 Reserve CPFP Tests ===\n');
  for (const item of tests) {
    try { await item.fn(); console.log(`  OK  ${item.name}`); passed++; }
    catch (err) { console.log(`  FAIL ${item.name}`); console.log(`       ${err.message}`); failed++; }
  }
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed${failed ? `, ${failed} failed` : ''}\n`);
  if (failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
