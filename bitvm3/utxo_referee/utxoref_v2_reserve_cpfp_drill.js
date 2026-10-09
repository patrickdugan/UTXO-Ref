#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { startNode, stopNode, waitFor } = require('./utxoref_v2_two_node_survival_drill');
const { addressToScriptPubKey, sha256Hex } = require('./tradelayer_pnl_route_adapter');
const tr = require('./tradelayer_taproot');
const a = require('./tradelayer_dlc_adaptor_sig');
const { coinValueToSats, buildTaprootReserveVaultTemplate } = require('./taproot_reserve_vault');
const { buildUtxorefV2FeeReserve } = require('./utxoref_v2_fee_reserve');
const {
  buildGuardianQuorumVaultTemplate,
  buildGuardianQuorumFeeReserve
} = require('./utxoref_v2_guardian_quorum_reserve');
const {
  buildReserveCpfpPlan,
  buildReserveGuardianApproval,
  preflightReserveCpfpInputs,
  runReserveCpfp
} = require('./utxoref_v2_reserve_cpfp');
const { monitorChallenge, saveJsonAtomic } = require('./utxoref_v2_watchtower');
const { txidFromUnsignedHex } = require('./recover_btc_testnet4_reserve_vault');

const DEFAULT_BITCOIND = 'C:\\projects\\BitcoinConsensusObservatory\\jurassic-bitcoin\\tools\\bitcoin-core-30.2\\bitcoin-30.2\\bin\\bitcoind.exe';
const DEFAULT_RECEIPT = path.join(__dirname, 'artifacts', 'tmp', 'utxoref_v2_reserve_cpfp_drill_latest.json');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--keep-datadir') { args.keepDatadir = true; continue; }
    if (arg === '--guardian-quorum') { args.guardianQuorum = true; continue; }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    args[key] = value;
  }
  return args;
}

function usage() {
  return [
    'Exercise a guardian-approved, reserve-backed CPFP and replacement in Bitcoin Core.',
    '',
    '  node utxoref_v2_reserve_cpfp_drill.js --bitcoind <path-to-bitcoind.exe> [--guardian-quorum]',
    '',
    'The drill uses one isolated temporary regtest node and writes an ignored receipt.'
  ].join('\n');
}

async function ensureWallet(rpc, wallet) {
  try { await rpc('getwalletinfo', [], wallet); } catch (_err) {
    await rpc('createwallet', [wallet, false, false, '', false, true]);
  }
}

async function signWalletTransaction(rpc, wallet, unsignedTxHex) {
  const signed = await rpc('signrawtransactionwithwallet', [unsignedTxHex], wallet);
  if (!signed.complete) throw new Error(`wallet failed to sign transaction: ${JSON.stringify(signed.errors || [])}`);
  const decoded = await rpc('decoderawtransaction', [signed.hex]);
  return { hex: signed.hex, decoded };
}

async function buildControlledOutputTransaction(rpc, wallet, utxo, outputSats, outputScript, feeSats, changeScript) {
  const inputSats = coinValueToSats(utxo.amount, 'wallet UTXO amount');
  const changeSats = inputSats - BigInt(outputSats) - BigInt(feeSats);
  if (changeSats < 330n) throw new Error('controlled output funding change would be dust');
  const unsignedTxHex = tr.serializeUnsignedTx(2, [{
    outpoint: tr.outpoint(utxo.txid, utxo.vout),
    sequence: 0xfffffffd
  }], [
    { valueSats: BigInt(outputSats), script: outputScript },
    { valueSats: changeSats, script: changeScript }
  ], 0);
  const signed = await signWalletTransaction(rpc, wallet, unsignedTxHex);
  return { ...signed, txid: signed.decoded.txid, vout: 0, amountSats: String(outputSats) };
}

async function mempoolContains(rpc, txid) {
  try { await rpc('getmempoolentry', [txid]); return true; }
  catch (_err) { return false; }
}

async function runReserveCpfpDrill(args = {}) {
  const bitcoind = path.resolve(args.bitcoind || process.env.BITCOIND || DEFAULT_BITCOIND);
  if (!fs.existsSync(bitcoind)) throw new Error(`bitcoind does not exist: ${bitcoind}`);
  const rpcPort = Number(args.rpcPort || 18473);
  const p2pPort = Number(args.p2pPort || 18474);
  if (![rpcPort, p2pPort].every((port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535) || rpcPort === p2pPort) {
    throw new Error('RPC and P2P ports must be distinct integers in 1024..65535');
  }
  const autoRoot = !args.datadirRoot;
  const root = autoRoot ? fs.mkdtempSync(path.join(os.tmpdir(), 'utxoref-reserve-cpfp-')) : path.resolve(args.datadirRoot);
  const auth = { user: `reserve-cpfp-${process.pid}`, pass: `drill-${Date.now()}-${process.pid}` };
  let node;
  try {
    node = startNode(bitcoind, path.join(root, 'node'), { rpc: rpcPort, p2p: p2pPort }, auth, 'reserve-cpfp');
    await waitFor(async () => {
      if (node.child.startError) throw node.child.startError;
      if (node.child.exitCode !== null) throw new Error(`bitcoind exited ${node.child.exitCode}: ${node.child.output}`);
      return node.rpc('getblockchaininfo');
    }, 'reserve CPFP RPC', 60000);

    const wallet = 'utxoref-reserve-cpfp';
    await ensureWallet(node.rpc, wallet);
    const miningAddress = await node.rpc('getnewaddress', ['mining', 'bech32'], wallet);
    await node.rpc('generatetoaddress', [1, miningAddress]);
    await node.rpc('generatetodescriptor', [100, 'raw(51)']);

    const splitAddresses = [];
    const splitAmounts = {};
    for (let index = 0; index < 2; index++) {
      const address = await node.rpc('getnewaddress', [`split-${index}`, 'bech32'], wallet);
      splitAddresses.push(address);
      splitAmounts[address] = 1;
    }
    await node.rpc('sendmany', ['', splitAmounts], wallet);
    await node.rpc('generatetoaddress', [1, miningAddress]);
    const splitUtxos = await node.rpc('listunspent', [1, 9999999, splitAddresses], wallet);
    if (splitUtxos.length !== 2) throw new Error(`expected two split UTXOs, got ${splitUtxos.length}`);

    const challengerSecret = 101n;
    const guardianSecrets = args.guardianQuorum ? [102n, 104n, 105n] : [102n];
    const guardianXonlys = guardianSecrets.map((secret) => a.xOnlyPubkey(secret).toString('hex'));
    const guardianThreshold = args.guardianQuorum ? 2 : 1;
    const refundSecret = 103n;
    const graphHash = sha256Hex('UTXORef V2 reserve-backed CPFP Core drill v1');
    const reserveTemplate = args.guardianQuorum
      ? buildGuardianQuorumVaultTemplate({
        network: 'bitcoin-regtest',
        operatorXonly: a.xOnlyPubkey(challengerSecret).toString('hex'),
        guardianXonlys,
        guardianThreshold,
        recoveryXonly: a.xOnlyPubkey(refundSecret).toString('hex'),
        recoveryCsvDelay: 144,
        bindingHash: graphHash
      })
      : buildTaprootReserveVaultTemplate({
      network: 'bitcoin-regtest',
      operatorXonly: a.xOnlyPubkey(challengerSecret).toString('hex'),
      guardianXonly: guardianXonlys[0],
      recoveryXonly: a.xOnlyPubkey(refundSecret).toString('hex'),
      recoveryCsvDelay: 144,
      bindingHash: graphHash
    });
    const changeAddress = await node.rpc('getrawchangeaddress', ['bech32'], wallet);
    const changeScript = addressToScriptPubKey(changeAddress, 'bitcoin-regtest').toString('hex');
    const reserveFunding = await buildControlledOutputTransaction(
      node.rpc,
      wallet,
      splitUtxos[0],
      30000,
      reserveTemplate.p2trScriptPubKey,
      1000,
      changeScript
    );
    const assertionAddress = await node.rpc('getnewaddress', ['assertion', 'bech32'], wallet);
    const assertionScript = addressToScriptPubKey(assertionAddress, 'bitcoin-regtest').toString('hex');
    const assertionFunding = await buildControlledOutputTransaction(
      node.rpc,
      wallet,
      splitUtxos[1],
      100000,
      assertionScript,
      1000,
      changeScript
    );
    await node.rpc('sendrawtransaction', [reserveFunding.hex]);
    await node.rpc('sendrawtransaction', [assertionFunding.hex]);
    const [fundingBlockHash] = await node.rpc('generatetoaddress', [1, miningAddress]);
    const fundingHeight = Number(await node.rpc('getblockcount'));

    const reserveInput = {
      network: 'bitcoin-regtest',
      graphHash,
      disputeId: args.guardianQuorum ? 'reserve-cpfp-quorum-core-drill' : 'reserve-cpfp-core-drill',
      fundingOutpoint: { txid: reserveFunding.txid, vout: reserveFunding.vout },
      fundingHeight,
      amountSats: 30000,
      maxFeeSats: 10000,
      challengeWindowBlocks: 18,
      confirmationTarget: 2,
      recoverySafetyBlocks: 6,
      recoveryCsvDelay: 144,
      challengerXonly: a.xOnlyPubkey(challengerSecret).toString('hex'),
      refundXonly: a.xOnlyPubkey(refundSecret).toString('hex'),
      p2trScriptPubKey: reserveTemplate.p2trScriptPubKey
    };
    const feeReserve = args.guardianQuorum
      ? buildGuardianQuorumFeeReserve({ ...reserveInput, guardianXonlys, guardianThreshold })
      : buildUtxorefV2FeeReserve({ ...reserveInput, guardianXonly: guardianXonlys[0] });

    const challengeAddress = await node.rpc('getnewaddress', ['challenge', 'bech32'], wallet);
    const challengeScript = addressToScriptPubKey(challengeAddress, 'bitcoin-regtest').toString('hex');
    const challengeUnsignedTxHex = tr.serializeUnsignedTx(2, [{
      outpoint: tr.outpoint(assertionFunding.txid, assertionFunding.vout),
      sequence: 0xfffffffd
    }], [{ valueSats: 99000n, script: challengeScript }], 0);
    const signedChallenge = await signWalletTransaction(node.rpc, wallet, challengeUnsignedTxHex);
    const challengeTxid = await node.rpc('sendrawtransaction', [signedChallenge.hex]);
    const expectedChallengeTxid = txidFromUnsignedHex(challengeUnsignedTxHex);
    if (challengeTxid !== expectedChallengeTxid) throw new Error('challenge txid does not match its unsigned commitment');

    const artifact = {
      kind: 'btc_testnet4_utxoref_v2_live_ceremony',
      version: 2,
      graph: {
        graphHash,
        assertionOutpoint: { txid: assertionFunding.txid, vout: assertionFunding.vout, amountSats: '100000' }
      }
    };
    const state = {
      kind: 'utxoref_v2_watchtower_state',
      challenge: {
        graphHash,
        txid: challengeTxid,
        vout: 0,
        outputSats: '99000',
        feeSats: '1000',
        challengeAddress,
        challengeScriptPubKeyHex: challengeScript,
        feeReserveHash: feeReserve.reserveHash,
        feeReserveOutpoint: `${reserveFunding.txid}:${reserveFunding.vout}`,
        confirmation: null,
        replacements: []
      }
    };

    const initialArgs = { feeSats: '4000', wallet, broadcast: true };
    const initialPlan = buildReserveCpfpPlan(state, initialArgs, artifact, feeReserve);
    const initialInputCheck = await preflightReserveCpfpInputs(initialPlan, feeReserve, node.rpc);
    const initialApprovals = guardianSecrets.slice(0, guardianThreshold).map((guardianSecret) =>
      buildReserveGuardianApproval(initialPlan, feeReserve, initialInputCheck.chainEvidence, guardianSecret)
    );
    const initialOutcome = await runReserveCpfp(
      state,
      initialArgs,
      node.rpc,
      artifact,
      feeReserve,
      initialApprovals,
      challengerSecret
    );
    if (initialOutcome.action !== 'reserve_cpfp_broadcast') {
      throw new Error(`initial reserve CPFP failed: ${JSON.stringify(initialOutcome)}`);
    }
    if (!await mempoolContains(node.rpc, initialPlan.txid)) throw new Error('initial reserve CPFP is not in the mempool');

    const replacementArgs = { feeSats: '8000', wallet, broadcast: true, replaceChild: true };
    const replacementPlan = buildReserveCpfpPlan(state, replacementArgs, artifact, feeReserve);
    const replacementInputCheck = await preflightReserveCpfpInputs(replacementPlan, feeReserve, node.rpc);
    const replacementApprovals = guardianSecrets.slice(0, guardianThreshold).map((guardianSecret) =>
      buildReserveGuardianApproval(replacementPlan, feeReserve, replacementInputCheck.chainEvidence, guardianSecret)
    );
    const replacementOutcome = await runReserveCpfp(
      state,
      replacementArgs,
      node.rpc,
      artifact,
      feeReserve,
      replacementApprovals,
      challengerSecret
    );
    if (replacementOutcome.action !== 'reserve_cpfp_replaced') {
      throw new Error(`replacement reserve CPFP failed: ${JSON.stringify(replacementOutcome)}`);
    }
    const initialEvicted = !await mempoolContains(node.rpc, initialPlan.txid);
    const replacementPresent = await mempoolContains(node.rpc, replacementPlan.txid);
    if (!initialEvicted || !replacementPresent) throw new Error('reserve CPFP replacement did not win the mempool conflict');

    const [settlementBlockHash] = await node.rpc('generatetoaddress', [1, miningAddress]);
    const settlementHeight = Number(await node.rpc('getblockcount'));
    const monitored = await monitorChallenge(node.rpc, state, settlementHeight);
    if (monitored.action !== 'challenge_confirmed') throw new Error(`replacement was not confirmed: ${monitored.action}`);
    if (state.challenge.feeReserveLifecycle?.status !== 'consumed_confirmed') {
      throw new Error('watchtower did not mark the fee reserve as consumed and confirmed');
    }

    const receipt = {
      kind: 'utxoref_v2_reserve_cpfp_drill_receipt',
      version: 1,
      observedAt: new Date().toISOString(),
      bitcoinCore: path.basename(bitcoind),
      chain: 'regtest',
      graphHash,
      guardianPolicy: {
        kind: args.guardianQuorum ? 'guardian-quorum' : 'single-guardian',
        guardianXonlys,
        threshold: guardianThreshold
      },
      funding: {
        blockHash: fundingBlockHash,
        height: fundingHeight,
        assertionOutpoint: `${assertionFunding.txid}:${assertionFunding.vout}`,
        reserveOutpoint: `${reserveFunding.txid}:${reserveFunding.vout}`,
        reserveHash: feeReserve.reserveHash,
        reserveScriptPubKey: reserveTemplate.p2trScriptPubKey
      },
      challenge: {
        txid: challengeTxid,
        outputSats: '99000',
        scriptPubKey: challengeScript
      },
      initialCpfp: {
        txid: initialPlan.txid,
        planHash: initialPlan.planHash,
        feeSats: initialPlan.feeSats,
        outputSats: initialPlan.outputSats,
        guardianApprovalHash: initialOutcome.result.guardianApprovalSetHash,
        guardianApprovalHashes: initialOutcome.result.guardianApprovalHashes,
        broadcast: initialOutcome.result.broadcast
      },
      replacementCpfp: {
        txid: replacementPlan.txid,
        replaces: initialPlan.txid,
        planHash: replacementPlan.planHash,
        feeSats: replacementPlan.feeSats,
        outputSats: replacementPlan.outputSats,
        guardianApprovalHash: replacementOutcome.result.guardianApprovalSetHash,
        guardianApprovalHashes: replacementOutcome.result.guardianApprovalHashes,
        initialEvicted,
        replacementPresentBeforeMining: replacementPresent
      },
      settlement: {
        blockHash: settlementBlockHash,
        height: settlementHeight,
        confirmedTxid: state.challenge.cpfp.txid,
        reserveLifecycle: state.challenge.feeReserveLifecycle
      },
      checks: {
        exactTwoInputs: true,
        singleChallengeScriptOutput: true,
        guardianThresholdAndChallengerSignedReserveLeaf: true,
        walletSignedOnlyChallengeInput: true,
        higherFeeReplacementWon: true,
        reserveConsumedIntoConfirmedChallengeOutput: true
      }
    };
    saveJsonAtomic(path.resolve(args.receipt || DEFAULT_RECEIPT), receipt);
    return receipt;
  } finally {
    await stopNode(node);
    if (autoRoot && !args.keepDatadir) {
      const resolvedRoot = path.resolve(root);
      const tempRoot = path.resolve(os.tmpdir()) + path.sep;
      if (!resolvedRoot.startsWith(tempRoot)) throw new Error(`refusing to remove non-temporary datadir ${resolvedRoot}`);
      fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  console.log(JSON.stringify(await runReserveCpfpDrill(args), null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`UTXORef V2 reserve CPFP drill failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildControlledOutputTransaction,
  runReserveCpfpDrill
};
