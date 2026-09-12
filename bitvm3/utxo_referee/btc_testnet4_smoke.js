#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  CommitmentPackage,
  PayoutLeaf,
  SweepObject,
  buildTreeWithProofs,
  verifySweep
} = require('./index');

const SATS_PER_BTC = 100000000n;
const bitcoinCli = process.env.BITCOIN_CLI ||
  'D:\\Tools\\BitcoinCore-31.1\\bitcoin-31.1\\bin\\bitcoin-cli.exe';
const dataDir = process.env.BITCOIN_DATADIR || 'D:\\BitcoinTestnet';
const walletName = process.env.BITCOIN_WALLET || 'utxoref-testnet';
const requireSynced = process.argv.includes('--require-synced');
const jsonOnly = process.argv.includes('--json');

function rpc(method, params = [], wallet = false) {
  const args = [
    `-datadir=${dataDir}`,
    '-chain=testnet4',
    ...(wallet ? [`-rpcwallet=${walletName}`] : []),
    method,
    ...params.map(String)
  ];
  const result = spawnSync(bitcoinCli, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`bitcoin-cli ${method} failed: ${detail || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout);
}

function btcToSats(amount) {
  const text = String(amount);
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new Error(`invalid BTC amount: ${text}`);
  const fraction = (match[2] || '').padEnd(8, '0');
  return BigInt(match[1]) * SATS_PER_BTC + BigInt(fraction || '0');
}

function buildLiveVerifierProbe(chain, utxos) {
  const selected = utxos
    .filter(utxo => utxo.spendable && utxo.safe && utxo.confirmations > 0 && utxo.scriptPubKey)
    .slice(0, 8);
  if (selected.length === 0) {
    return { ok: false, reason: 'wallet has no confirmed, safe, spendable UTXO' };
  }

  const leaves = selected.map(utxo => new PayoutLeaf({
    epochId: BigInt(chain.blocks),
    recipientScriptPubKey: Buffer.from(utxo.scriptPubKey, 'hex'),
    amountSats: btcToSats(utxo.amount)
  }));
  const { root, proofs } = buildTreeWithProofs(leaves);
  const capSats = leaves.reduce((sum, leaf) => sum + leaf.amountSats, 0n);
  const commitment = new CommitmentPackage({
    epochId: BigInt(chain.blocks),
    withdrawalRoot: root,
    capSats,
    residualDest: Buffer.from(selected[0].scriptPubKey, 'hex')
  });
  const sweep = new SweepObject({
    epochIdCommitted: commitment.epochId,
    payoutOutputs: leaves.map((leaf, index) => ({
      recipientScriptPubKey: leaf.recipientScriptPubKey,
      amountSats: leaf.amountSats,
      merkleProof: proofs[index]
    })),
    residualOutput: {
      recipientScriptPubKey: commitment.residualDest,
      amountSats: 0n
    }
  });
  const verification = verifySweep(commitment, sweep);
  return {
    ok: verification.ok,
    reason: verification.reason,
    epochId: commitment.epochId.toString(),
    payoutCount: leaves.length,
    capSats: capSats.toString(),
    withdrawalRoot: root.toString('hex'),
    commitmentHash: commitment.hash().toString('hex')
  };
}

function captureStableSnapshot(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const chainBefore = rpc('getblockchaininfo');
    if (chainBefore.chain !== 'testnet4') throw new Error(`wrong chain: expected testnet4, got ${chainBefore.chain}`);
    const mempoolBefore = rpc('getrawmempool', ['false', 'true']);
    const network = rpc('getnetworkinfo');
    const wallet = rpc('getwalletinfo', [], true);
    const balances = rpc('getbalances', [], true);
    const utxos = rpc('listunspent', ['1', '9999999'], true)
      .filter(utxo => utxo.safe && utxo.confirmations > 0 && utxo.scriptPubKey);
    const current = utxos.map(utxo => rpc('gettxout', [utxo.txid, utxo.vout, 'true']));
    const mempoolAfter = rpc('getrawmempool', ['false', 'true']);
    const chainAfter = rpc('getblockchaininfo');
    const coinsMatch = current.every((coin, index) => coin &&
      coin.bestblock === chainBefore.bestblockhash &&
      btcToSats(coin.value) === btcToSats(utxos[index].amount) &&
      coin.scriptPubKey && coin.scriptPubKey.hex === utxos[index].scriptPubKey);
    const walletAtTip = !wallet.lastprocessedblock ||
      (wallet.lastprocessedblock.height === chainBefore.blocks &&
       wallet.lastprocessedblock.hash === chainBefore.bestblockhash);
    if (chainBefore.blocks === chainAfter.blocks &&
        chainBefore.bestblockhash === chainAfter.bestblockhash &&
        mempoolBefore.mempool_sequence === mempoolAfter.mempool_sequence &&
        coinsMatch && walletAtTip) {
      return {
        chain: chainAfter,
        network,
        wallet,
        balances,
        utxos,
        attempts: attempt,
        mempoolSequence: mempoolAfter.mempool_sequence
      };
    }
  }
  throw new Error(`could not capture a stable chain/mempool/wallet snapshot after ${maxAttempts} attempts`);
}

function run() {
  if (!fs.existsSync(bitcoinCli)) throw new Error(`bitcoin-cli not found: ${bitcoinCli}`);
  const { chain, network, wallet, balances, utxos, attempts, mempoolSequence } = captureStableSnapshot();
  const synced = !chain.initialblockdownload && chain.blocks === chain.headers;
  if (requireSynced && !synced) {
    throw new Error(`testnet4 is not synced: blocks=${chain.blocks}, headers=${chain.headers}`);
  }
  const verifierProbe = buildLiveVerifierProbe(chain, utxos);
  if (!verifierProbe.ok) throw new Error(`live verifier probe failed: ${verifierProbe.reason}`);

  const report = {
    ok: true,
    network: 'bitcoin-testnet4',
    dataDir,
    coreVersion: network.subversion,
    blocks: chain.blocks,
    bestBlockHash: chain.bestblockhash,
    headers: chain.headers,
    verificationProgress: chain.verificationprogress,
    initialBlockDownload: chain.initialblockdownload,
    synced,
    pruned: chain.pruned,
    connections: network.connections,
    snapshotAttempts: attempts,
    snapshotStable: true,
    mempoolSequence,
    wallet: {
      name: wallet.walletname,
      descriptors: wallet.descriptors,
      transactionCount: wallet.txcount,
      trustedSats: btcToSats(balances.mine.trusted).toString(),
      confirmedSpendableUtxos: utxos.length
    },
    verifierProbe,
    broadcastAttempted: false
  };

  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  console.log('Bitcoin testnet4 UTXORef smoke');
  console.log(`chain: ${report.network}`);
  console.log(`core: ${report.coreVersion}`);
  console.log(`height: ${report.blocks}/${report.headers}`);
  console.log(`synced: ${report.synced}`);
  console.log(`peers: ${report.connections}`);
  console.log(`wallet: ${report.wallet.name}`);
  console.log(`trustedSats: ${report.wallet.trustedSats}`);
  console.log(`spendableUtxos: ${report.wallet.confirmedSpendableUtxos}`);
  console.log(`verifierProbe: ${report.verifierProbe.ok}`);
  console.log(`commitmentHash: ${report.verifierProbe.commitmentHash}`);
  console.log('broadcastAttempted: false');
}

try {
  run();
} catch (error) {
  console.error(`Bitcoin testnet4 smoke failed: ${error.message}`);
  process.exitCode = 1;
}
