#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync, execFile } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { SATS_PER_BTC, btcToSats, captureStableSnapshot } = require('./btc_testnet4_snapshot');

const DEFAULT_CLI = 'D:\\Tools\\BitcoinCore-31.1\\bitcoin-31.1\\bin\\bitcoin-cli.exe';
const DEFAULT_DATADIR = 'D:\\BitcoinTestnet';
const DEFAULT_WALLET = 'utxoref-testnet';

function parseOption(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function runVerifierAgent(data) {
  const {
    CommitmentPackage,
    PayoutLeaf,
    SweepObject,
    buildTreeWithProofs,
    verifySweep
  } = require('./index');

  const leaves = data.utxos.map(utxo => new PayoutLeaf({
    epochId: BigInt(data.epochId),
    recipientScriptPubKey: Buffer.from(utxo.scriptPubKey, 'hex'),
    amountSats: BigInt(utxo.amountSats)
  }));
  const { root, proofs } = buildTreeWithProofs(leaves);
  const total = leaves.reduce((sum, leaf) => sum + leaf.amountSats, 0n);
  const maxAmount = leaves.reduce((max, leaf) => leaf.amountSats > max ? leaf.amountSats : max, 0n);
  const commitment = new CommitmentPackage({
    epochId: BigInt(data.epochId),
    withdrawalRoot: root,
    capSats: total + maxAmount,
    residualDest: leaves[0].recipientScriptPubKey
  });

  const copyPayout = index => ({
    recipientScriptPubKey: Buffer.from(leaves[index].recipientScriptPubKey),
    amountSats: leaves[index].amountSats,
    merkleProof: {
      index: proofs[index].index,
      siblings: proofs[index].siblings.map(sibling => Buffer.from(sibling))
    }
  });
  const makeSweep = outputs => {
    const payoutTotal = outputs.reduce((sum, output) => sum + BigInt(output.amountSats), 0n);
    return new SweepObject({
      epochIdCommitted: commitment.epochId,
      payoutOutputs: outputs,
      residualOutput: {
        recipientScriptPubKey: commitment.residualDest,
        amountSats: commitment.capSats - payoutTotal
      }
    });
  };
  const observe = sweep => {
    try {
      return { threw: false, result: verifySweep(commitment, sweep) };
    } catch (error) {
      return { threw: true, error: error.message || String(error) };
    }
  };

  const families = [
    'valid',
    'epoch-substitution',
    'amount-mutation',
    'sibling-mutation',
    'duplicate-position',
    'high-index-alias',
    'fractional-index',
    'string-index',
    'malformed-siblings',
    'negative-amount',
    'cap-overflow'
  ];
  const stats = Object.fromEntries(families.map(name => [name, {
    cases: 0,
    expectedAccept: name === 'valid',
    accepted: 0,
    rejected: 0,
    crashed: 0,
    violations: 0
  }]));

  const started = process.hrtime.bigint();
  for (let iteration = 0; iteration < data.iterations; iteration++) {
    const family = families[(iteration + data.agentId) % families.length];
    const index = (iteration * 17 + data.agentId) % leaves.length;
    let sweep;
    if (family === 'valid') {
      sweep = makeSweep(leaves.map((_, i) => copyPayout(i)));
    } else if (family === 'epoch-substitution') {
      sweep = makeSweep([copyPayout(index)]);
      sweep.epochIdCommitted += 1n;
    } else if (family === 'amount-mutation') {
      const output = copyPayout(index);
      output.amountSats += 1n;
      sweep = makeSweep([output]);
    } else if (family === 'sibling-mutation') {
      const output = copyPayout(index);
      output.merkleProof.siblings[0][0] ^= 1;
      sweep = makeSweep([output]);
    } else if (family === 'duplicate-position') {
      const outputs = leaves.map((_, i) => copyPayout(i));
      outputs.push(copyPayout(index));
      sweep = makeSweep(outputs);
    } else if (family === 'high-index-alias') {
      const output = copyPayout(index);
      output.merkleProof.index += 2 ** output.merkleProof.siblings.length;
      sweep = makeSweep([output]);
    } else if (family === 'fractional-index') {
      const output = copyPayout(index);
      output.merkleProof.index += 0.5;
      sweep = makeSweep([output]);
    } else if (family === 'string-index') {
      const output = copyPayout(index);
      output.merkleProof.index = String(output.merkleProof.index);
      sweep = makeSweep([output]);
    } else if (family === 'malformed-siblings') {
      sweep = makeSweep([copyPayout(index)]);
      sweep.payoutOutputs[0].merkleProof.siblings = Buffer.alloc(32);
    } else if (family === 'negative-amount') {
      sweep = makeSweep([copyPayout(index)]);
      sweep.payoutOutputs[0].amountSats = -1n;
    } else {
      const oneLeaf = new PayoutLeaf({
        epochId: commitment.epochId,
        recipientScriptPubKey: leaves[index].recipientScriptPubKey,
        amountSats: leaves[index].amountSats
      });
      const oneTree = buildTreeWithProofs([oneLeaf]);
      const lowCap = oneLeaf.amountSats - 1n;
      const lowCommitment = new CommitmentPackage({
        epochId: commitment.epochId,
        withdrawalRoot: oneTree.root,
        capSats: lowCap,
        residualDest: commitment.residualDest
      });
      sweep = new SweepObject({
        epochIdCommitted: commitment.epochId,
        payoutOutputs: [{
          recipientScriptPubKey: oneLeaf.recipientScriptPubKey,
          amountSats: oneLeaf.amountSats,
          merkleProof: oneTree.proofs[0]
        }],
        residualOutput: { recipientScriptPubKey: commitment.residualDest, amountSats: 0n }
      });
      try {
        const result = verifySweep(lowCommitment, sweep);
        const entry = stats[family];
        entry.cases++;
        result.ok ? entry.accepted++ : entry.rejected++;
        if (result.ok) entry.violations++;
      } catch (_) {
        stats[family].cases++;
        stats[family].crashed++;
        stats[family].violations++;
      }
      continue;
    }

    const observed = observe(sweep);
    const entry = stats[family];
    entry.cases++;
    if (observed.threw) {
      entry.crashed++;
      entry.violations++;
    } else if (observed.result.ok) {
      entry.accepted++;
      if (!entry.expectedAccept) entry.violations++;
    } else {
      entry.rejected++;
      if (entry.expectedAccept) entry.violations++;
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const cases = Object.values(stats).reduce((sum, entry) => sum + entry.cases, 0);
  const violations = Object.values(stats).reduce((sum, entry) => sum + entry.violations, 0);
  const crashes = Object.values(stats).reduce((sum, entry) => sum + entry.crashed, 0);
  return { agentId: data.agentId, cases, violations, crashes, elapsedMs, stats };
}

if (!isMainThread) {
  parentPort.postMessage(runVerifierAgent(workerData));
} else {
  const bitcoinCli = process.env.BITCOIN_CLI || DEFAULT_CLI;
  const dataDir = process.env.BITCOIN_DATADIR || DEFAULT_DATADIR;
  const walletName = process.env.BITCOIN_WALLET || DEFAULT_WALLET;
  const agents = Math.max(1, Number(parseOption('agents', '8')));
  const iterations = Math.max(1, Number(parseOption('iterations', '11000')));
  const rpcProbes = Math.max(1, Number(parseOption('rpc-probes', '100')));
  const mempoolMutations = Math.max(1, Number(parseOption('mempool-mutations', '32')));
  const signedMempoolProbe = process.argv.includes('--signed-mempool-probe');
  const unsignedMempoolProbe = process.argv.includes('--unsigned-mempool-probe');
  const requireSynced = process.argv.includes('--require-synced');
  const requireClean = process.argv.includes('--require-clean');
  const jsonOnly = process.argv.includes('--json');

  const baseArgs = [`-datadir=${dataDir}`, '-chain=testnet4'];
  const rpc = (method, params = [], wallet = false) => {
    const args = [...baseArgs, ...(wallet ? [`-rpcwallet=${walletName}`] : []), method, ...params.map(String)];
    const result = spawnSync(bitcoinCli, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `RPC ${method} failed`).trim());
    if (method === 'getbestblockhash') return result.stdout.trim();
    return JSON.parse(result.stdout);
  };
  const rpcText = (method, params = [], wallet = false) => {
    const args = [...baseArgs, ...(wallet ? [`-rpcwallet=${walletName}`] : []), method, ...params.map(String)];
    const result = spawnSync(bitcoinCli, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || `RPC ${method} failed`).trim());
    return result.stdout.trim();
  };
  const rpcAsync = (method, params = []) => new Promise((resolve, reject) => {
    execFile(bitcoinCli, [...baseArgs, method, ...params.map(String)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim()));
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });

  async function runRpcProbes(utxos, bestBlockHash) {
    let next = 0;
    const results = [];
    const worker = async () => {
      while (next < rpcProbes) {
        const probeIndex = next++;
        const utxo = utxos[probeIndex % utxos.length];
        try {
          const current = await rpcAsync('gettxout', [utxo.txid, utxo.vout, 'true']);
          const same = current &&
            btcToSats(current.value) === BigInt(utxo.amountSats) &&
            current.bestblock === bestBlockHash &&
            current.confirmations === utxo.confirmations &&
            current.scriptPubKey && current.scriptPubKey.hex === utxo.scriptPubKey;
          results.push({ found: !!current, same: !!same, error: false });
        } catch (_) {
          results.push({ found: false, same: false, error: true });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(agents, rpcProbes) }, worker));
    return {
      probes: results.length,
      found: results.filter(result => result.found).length,
      consistent: results.filter(result => result.same).length,
      staleOrChanged: results.filter(result => !result.error && !result.same).length,
      errors: results.filter(result => result.error).length
    };
  }

  function createSignedPolicyProbe(utxo, synced) {
    if (!signedMempoolProbe) return { attempted: false, skipped: 'flag not set', broadcastAttempted: false };
    if (!synced) return { attempted: false, skipped: 'node is still in initial block download', broadcastAttempted: false };
    if (!utxo.address) return { attempted: false, skipped: 'selected UTXO has no wallet address', broadcastAttempted: false };

    const inputs = JSON.stringify([{ txid: utxo.txid, vout: utxo.vout, sequence: 4294967293 }]);
    const outputs = JSON.stringify({ [utxo.address]: Number(utxo.amount) });
    const options = JSON.stringify({
      add_inputs: false,
      include_unsafe: false,
      lockUnspents: false,
      subtractFeeFromOutputs: [0],
      fee_rate: 2
    });
    const funded = rpc('walletcreatefundedpsbt', [inputs, outputs, '0', options, 'true'], true);
    const processed = rpc('walletprocesspsbt', [funded.psbt, 'true', 'ALL', 'true'], true);
    const finalized = rpc('finalizepsbt', [processed.psbt, 'true']);
    if (!finalized.complete || !finalized.hex) throw new Error('wallet could not finalize the non-broadcast policy probe');
    const baseline = rpc('testmempoolaccept', [JSON.stringify([finalized.hex])]);

    const mutants = [];
    for (let i = 0; i < mempoolMutations; i++) {
      const chars = finalized.hex.split('');
      const position = Math.max(20, Math.min(chars.length - 20, Math.floor(chars.length * (0.60 + (i % 30) / 100))));
      chars[position] = chars[position] === '0' ? '1' : '0';
      const candidate = chars.join('');
      try {
        rpc('decoderawtransaction', [candidate]);
        mutants.push(candidate);
      } catch (_) {
        // A decode failure is already a successful structural rejection; keep searching.
      }
    }

    let rejected = 0;
    let allowed = 0;
    for (let offset = 0; offset < mutants.length; offset += 25) {
      const batch = rpc('testmempoolaccept', [JSON.stringify(mutants.slice(offset, offset + 25))]);
      rejected += batch.filter(result => !result.allowed).length;
      allowed += batch.filter(result => result.allowed).length;
    }
    return {
      attempted: true,
      baselineAllowed: baseline.length === 1 && baseline[0].allowed === true,
      mutantsRequested: mempoolMutations,
      parseableMutants: mutants.length,
      mutantsRejected: rejected,
      mutantsAllowed: allowed,
      broadcastAttempted: false
    };
  }

  function createUnsignedPolicyProbe(utxo, synced, height) {
    if (!unsignedMempoolProbe) return { attempted: false, skipped: 'flag not set', broadcastAttempted: false };
    if (!synced) return { attempted: false, skipped: 'node is still in initial block download', broadcastAttempted: false };
    if (!utxo.address) return { attempted: false, skipped: 'selected UTXO has no address', broadcastAttempted: false };

    const amountSats = BigInt(utxo.amountSats);
    const toBtc = sats => Number(sats) / Number(SATS_PER_BTC);
    const input = (txid = utxo.txid, vout = utxo.vout, sequence = 4294967293) => ({ txid, vout, sequence });
    const raw = (inputs, outputs, locktime = 0) => rpcText('createrawtransaction', [
      JSON.stringify(inputs),
      JSON.stringify(outputs),
      String(locktime),
      'true'
    ]);
    const cases = [
      {
        name: 'unsigned-valid-shape',
        hex: raw([input()], { [utxo.address]: toBtc(amountSats - 1000n) }),
        expected: 'script-verify'
      },
      {
        name: 'duplicate-input',
        hex: raw([input(), input()], { [utxo.address]: toBtc(amountSats - 1000n) }),
        expected: 'bad-txns-inputs-duplicate'
      },
      {
        name: 'missing-input',
        hex: raw([input(`${'0'.repeat(63)}1`, 0)], { [utxo.address]: toBtc(1000n) }),
        expected: 'missing-inputs'
      },
      {
        name: 'bad-vout',
        hex: raw([input(utxo.txid, utxo.vout + 999999)], { [utxo.address]: toBtc(1000n) }),
        expected: 'missing-inputs'
      },
      {
        name: 'non-final',
        hex: raw([input()], { [utxo.address]: toBtc(amountSats - 1000n) }, height + 1),
        expected: 'non-final'
      },
      {
        name: 'dust-one-sat',
        hex: raw([input()], { [utxo.address]: toBtc(1n) }),
        expected: 'dust'
      },
      {
        name: 'zero-output',
        hex: raw([input()], { [utxo.address]: 0 }),
        expected: 'dust'
      },
      {
        name: 'overspend',
        hex: raw([input()], { [utxo.address]: toBtc(amountSats + 1000n) }),
        expected: 'bad-txns-in-belowout'
      },
      {
        name: 'empty-outputs',
        hex: raw([input()], {}),
        expected: 'bad-txns-vout-empty'
      }
    ];

    const results = cases.map(testCase => {
      const verdict = rpc('testmempoolaccept', [JSON.stringify([testCase.hex])])[0];
      const reason = verdict['reject-reason'] || '';
      return {
        name: testCase.name,
        allowed: verdict.allowed === true,
        rejectReason: reason,
        expectedRejectObserved: verdict.allowed !== true && reason.includes(testCase.expected)
      };
    });
    return {
      attempted: true,
      cases: results.length,
      cleanExpectedRejections: results.filter(result => result.expectedRejectObserved).length,
      violations: results.filter(result => !result.expectedRejectObserved).length,
      results,
      broadcastAttempted: false
    };
  }

  async function main() {
    if (!fs.existsSync(bitcoinCli)) throw new Error(`bitcoin-cli not found: ${bitcoinCli}`);
    const snapshot = captureStableSnapshot(rpc);
    const { chain: chainBefore, network, wallet, utxos: listed, anchor } = snapshot;
    if (listed.length === 0) throw new Error('no confirmed safe spendable UTXOs');
    const liveUtxos = listed.slice(0, 8);
    const synced = !chainBefore.initialblockdownload && chainBefore.blocks === chainBefore.headers;
    if (requireSynced && (!synced || network.networkactive !== true || network.connections < 1)) {
      throw new Error(`testnet4 is not ready: blocks=${chainBefore.blocks}, headers=${chainBefore.headers}, ` +
        `networkactive=${network.networkactive}, peers=${network.connections}`);
    }

    const activeAgents = Math.min(agents, iterations);
    const baseIterations = Math.floor(iterations / activeAgents);
    const extraIterations = iterations % activeAgents;
    const workers = Array.from({ length: activeAgents }, (_, agentId) => new Promise((resolve, reject) => {
      const agentIterations = baseIterations + (agentId < extraIterations ? 1 : 0);
      const worker = new Worker(__filename, {
        workerData: { agentId, iterations: agentIterations, epochId: anchor.epochId, utxos: liveUtxos }
      });
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`agent ${agentId} exited ${code}`)); });
    }));
    const [agentReports, rpcReport] = await Promise.all([
      Promise.all(workers),
      runRpcProbes(liveUtxos, chainBefore.bestblockhash)
    ]);
    const mempoolPolicy = createSignedPolicyProbe(liveUtxos.find(utxo => utxo.address) || liveUtxos[0], synced);
    const unsignedPolicy = createUnsignedPolicyProbe(
      liveUtxos.find(utxo => utxo.address) || liveUtxos[0],
      synced,
      chainBefore.blocks
    );
    const chainAfter = rpc('getblockchaininfo');
    const startHashNow = rpcText('getblockhash', [chainBefore.blocks]);

    const byFamily = {};
    for (const agent of agentReports) {
      for (const [family, values] of Object.entries(agent.stats)) {
        if (!byFamily[family]) byFamily[family] = { cases: 0, accepted: 0, rejected: 0, crashed: 0, violations: 0 };
        for (const key of Object.keys(byFamily[family])) byFamily[family][key] += values[key];
      }
    }
    const verifierCases = agentReports.reduce((sum, agent) => sum + agent.cases, 0);
    const violations = agentReports.reduce((sum, agent) => sum + agent.violations, 0);
    const crashes = agentReports.reduce((sum, agent) => sum + agent.crashes, 0);
    const validCases = byFamily.valid.cases;
    const attackCases = verifierCases - validCases;
    const attackFailures = Object.entries(byFamily)
      .filter(([family]) => family !== 'valid')
      .reduce((sum, [, values]) => sum + values.violations, 0);
    const cleanRejectionRate = attackCases === 0 ? 1 : (attackCases - attackFailures) / attackCases;
    const startTipStillCanonical = startHashNow === chainBefore.bestblockhash;
    const tipReorgObserved = !startTipStillCanonical;
    const report = {
      benchmark: 'utxo-referee-bitcoin-testnet4-redteam',
      version: 1,
      network: 'bitcoin-testnet4',
      dataDir,
      node: {
        coreVersion: network.subversion,
        connections: network.connections,
        pruned: chainBefore.pruned,
        initialBlockDownload: chainAfter.initialblockdownload,
        startHeight: chainBefore.blocks,
        startBestBlockHash: chainBefore.bestblockhash,
        endHeight: chainAfter.blocks,
        headers: chainAfter.headers,
        synced: !chainAfter.initialblockdownload && chainAfter.blocks === chainAfter.headers,
        tipAdvanced: chainAfter.blocks > chainBefore.blocks,
        startTipStillCanonical,
        tipReorgObserved,
        snapshotStable: true,
        snapshotAttempts: snapshot.attempts,
        snapshotMempoolSequence: snapshot.mempoolSequence,
        snapshotCommitmentHash: anchor.hash,
        eligibleUtxoCount: listed.length,
        omittedUtxoCount: listed.length - liveUtxos.length
      },
      wallet: {
        name: wallet.walletname,
        descriptors: wallet.descriptors,
        liveUtxosUsed: liveUtxos.length
      },
      swarm: {
        agents: activeAgents,
        requestedIterations: iterations,
        executedCases: verifierCases,
        attackCases,
        violations,
        crashes,
        cleanRejectionRate,
        elapsedMsMax: Math.max(...agentReports.map(agent => agent.elapsedMs)),
        byFamily
      },
      rpcFreshness: rpcReport,
      unsignedPolicy,
      mempoolPolicy,
      broadcastAttempted: false
    };

    if (jsonOnly) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      console.log('Bitcoin testnet4 UTXORef red-team swarm');
      console.log(`node: ${report.node.startHeight}->${report.node.endHeight}/${report.node.headers} peers=${report.node.connections}`);
      console.log(`agents: ${activeAgents}`);
      console.log(`cases: ${verifierCases}`);
      console.log(`violations: ${violations}`);
      console.log(`crashes: ${crashes}`);
      console.log(`cleanRejectionRate: ${cleanRejectionRate.toFixed(6)}`);
      console.log(`rpcFreshness: ${rpcReport.consistent}/${rpcReport.probes} consistent`);
      console.log(`unsignedPolicy: ${unsignedPolicy.attempted ? `${unsignedPolicy.cleanExpectedRejections}/${unsignedPolicy.cases} clean expected rejections` : `skipped (${unsignedPolicy.skipped})`}`);
      console.log(`mempoolProbe: ${mempoolPolicy.attempted ? 'attempted' : `skipped (${mempoolPolicy.skipped})`}`);
      console.log('broadcastAttempted: false');
    }
    if (requireClean && (violations > 0 || rpcReport.errors > 0 || rpcReport.staleOrChanged > 0 || unsignedPolicy.violations > 0)) {
      process.exitCode = 1;
    }
  }

  main().catch(error => {
    console.error(`Bitcoin testnet4 stress failed: ${error.message}`);
    process.exitCode = 1;
  });
}
