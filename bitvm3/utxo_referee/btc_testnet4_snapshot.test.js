'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  btcToSats,
  deriveSnapshotAnchor,
  captureStableSnapshot
} = require('./btc_testnet4_snapshot');

const tip = 'aa'.repeat(32);
const firstTxid = '11'.repeat(32);
const secondTxid = '22'.repeat(32);
const firstScript = `0014${'33'.repeat(20)}`;
const secondScript = `5120${'44'.repeat(32)}`;

function stableRpc({ walletHash = tip, scanning = false } = {}) {
  const utxos = [
    {
      txid: secondTxid,
      vout: 1,
      amount: '0.00000002',
      confirmations: 6,
      safe: true,
      solvable: true,
      scriptPubKey: secondScript
    },
    {
      txid: firstTxid,
      vout: 0,
      amount: 1e-8,
      confirmations: 6,
      safe: true,
      solvable: true,
      scriptPubKey: firstScript
    }
  ];
  return (method, params = []) => {
    if (method === 'getbestblockhash') return tip;
    if (method === 'getblockchaininfo') {
      return { chain: 'testnet4', blocks: 100, headers: 100, bestblockhash: tip, initialblockdownload: false };
    }
    if (method === 'getrawmempool') return { mempool_sequence: 17 };
    if (method === 'getnetworkinfo') return { networkactive: true, connections: 8 };
    if (method === 'getwalletinfo') {
      return { scanning, lastprocessedblock: { height: 100, hash: walletHash } };
    }
    if (method === 'getbalances') return { mine: { trusted: 3e-8 } };
    if (method === 'listunspent') return utxos;
    if (method === 'gettxout') {
      const selected = utxos.find(utxo => utxo.txid === params[0] && utxo.vout === params[1]);
      return selected && {
        bestblock: tip,
        confirmations: selected.confirmations,
        value: selected.amount,
        scriptPubKey: { hex: selected.scriptPubKey }
      };
    }
    throw new Error(`unexpected RPC ${method}`);
  };
}

test('BTC conversion accepts Core scientific notation without rounding sub-satoshi values', () => {
  assert.equal(btcToSats(1e-8), 1n);
  assert.equal(btcToSats(20999999.99999999), 2099999999999999n);
  assert.equal(btcToSats('21000000.00000000'), 2100000000000000n);
  assert.throws(() => btcToSats(-1e-8), /invalid BTC amount/);
  assert.throws(() => btcToSats(1e-9), /not an exact satoshi/);
  assert.throws(() => btcToSats('0.000000001'), /invalid BTC amount/);
  assert.throws(() => btcToSats('21000000.00000001'), /maximum money/);
});

test('stable snapshot binds sorted outpoints, tip hash, height, and mempool sequence', () => {
  const snapshot = captureStableSnapshot(stableRpc());
  assert.equal(snapshot.attempts, 1);
  assert.deepEqual(snapshot.utxos.map(utxo => utxo.txid), [firstTxid, secondTxid]);
  assert.match(snapshot.anchor.hash, /^[0-9a-f]{64}$/);
  assert.match(snapshot.anchor.epochId, /^\d+$/);

  const competingFork = deriveSnapshotAnchor({
    bestBlockHash: 'bb'.repeat(32),
    height: snapshot.chain.blocks,
    mempoolSequence: snapshot.mempoolSequence,
    utxos: snapshot.utxos
  });
  assert.notEqual(competingFork.hash, snapshot.anchor.hash);
  assert.notEqual(competingFork.epochId, snapshot.anchor.epochId);
});

test('stable snapshot rejects wallet lag and active rescans', () => {
  assert.throws(
    () => captureStableSnapshot(stableRpc({ walletHash: 'cc'.repeat(32) }), 2),
    /could not capture a stable/
  );
  assert.throws(
    () => captureStableSnapshot(stableRpc({ scanning: { duration: 1, progress: 0.5 } }), 1),
    /could not capture a stable/
  );
});
