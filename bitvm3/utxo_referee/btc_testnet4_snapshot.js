'use strict';

const crypto = require('crypto');

const SATS_PER_BTC = 100000000n;
const MAX_MONEY_SATS = 21000000n * SATS_PER_BTC;

function btcToSats(amount) {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`invalid BTC amount: ${amount}`);
    const numberText = String(amount);
    if (!/[eE]/.test(numberText)) return btcToSats(numberText);
    const exponent = Number(numberText.match(/[eE]([+-]?\d+)$/)?.[1]);
    if (!Number.isSafeInteger(exponent) || exponent < -8) {
      throw new Error(`BTC amount is not an exact satoshi value: ${amount}`);
    }
    const scaled = amount * Number(SATS_PER_BTC);
    const rounded = Math.round(scaled);
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.000001) {
      throw new Error(`BTC amount is not an exact satoshi value: ${amount}`);
    }
    const sats = BigInt(rounded);
    if (sats > MAX_MONEY_SATS) throw new Error(`BTC amount exceeds maximum money: ${amount}`);
    return sats;
  }
  const text = String(amount);
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new Error(`invalid BTC amount: ${text}`);
  const fraction = (match[2] || '').padEnd(8, '0');
  const sats = BigInt(match[1]) * SATS_PER_BTC + BigInt(fraction || '0');
  if (sats > MAX_MONEY_SATS) throw new Error(`BTC amount exceeds maximum money: ${text}`);
  return sats;
}

function normalizeUtxos(values) {
  if (!Array.isArray(values)) throw new Error('listunspent did not return an array');
  const seen = new Set();
  const normalized = values.map(value => {
    if (!value || typeof value !== 'object' ||
        typeof value.txid !== 'string' || !/^[0-9a-f]{64}$/.test(value.txid) ||
        !Number.isSafeInteger(value.vout) || value.vout < 0 || value.vout > 0xffffffff ||
        !Number.isSafeInteger(value.confirmations) || value.confirmations < 1 ||
        value.safe !== true || value.solvable !== true ||
        typeof value.scriptPubKey !== 'string' || value.scriptPubKey.length === 0 ||
        value.scriptPubKey.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value.scriptPubKey)) {
      throw new Error('listunspent returned a malformed or unsafe confirmed UTXO');
    }
    const outpoint = `${value.txid}:${value.vout}`;
    if (seen.has(outpoint)) throw new Error(`listunspent returned duplicate outpoint ${outpoint}`);
    seen.add(outpoint);
    const amountSats = btcToSats(value.amount);
    if (amountSats <= 0n) throw new Error(`listunspent returned non-positive value for ${outpoint}`);
    return Object.freeze({
      txid: value.txid,
      vout: value.vout,
      address: typeof value.address === 'string' ? value.address : null,
      amount: value.amount,
      amountSats: amountSats.toString(),
      confirmations: value.confirmations,
      scriptPubKey: value.scriptPubKey
    });
  });
  normalized.sort((left, right) => left.txid.localeCompare(right.txid) || left.vout - right.vout);
  return Object.freeze(normalized);
}

function deriveSnapshotAnchor({ bestBlockHash, height, mempoolSequence, utxos }) {
  if (typeof bestBlockHash !== 'string' || !/^[0-9a-f]{64}$/.test(bestBlockHash) ||
      !Number.isSafeInteger(height) || height < 0 ||
      !Number.isSafeInteger(mempoolSequence) || mempoolSequence < 0 ||
      !Array.isArray(utxos)) {
    throw new Error('invalid testnet4 snapshot anchor inputs');
  }
  const canonical = JSON.stringify({
    network: 'bitcoin-testnet4',
    bestBlockHash,
    height,
    mempoolSequence,
    utxos: utxos.map(utxo => ({
      txid: utxo.txid,
      vout: utxo.vout,
      amountSats: utxo.amountSats,
      confirmations: utxo.confirmations,
      scriptPubKey: utxo.scriptPubKey
    }))
  });
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return Object.freeze({
    hash,
    epochId: BigInt(`0x${hash.slice(0, 16)}`).toString()
  });
}

function captureStableSnapshot(rpc, maxAttempts = 3) {
  if (typeof rpc !== 'function' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('invalid stable snapshot configuration');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tipBefore = rpc('getbestblockhash');
    const chainBefore = rpc('getblockchaininfo');
    if (chainBefore.chain !== 'testnet4') {
      throw new Error(`wrong chain: expected testnet4, got ${chainBefore.chain}`);
    }
    const mempoolBefore = rpc('getrawmempool', ['false', 'true']);
    const network = rpc('getnetworkinfo');
    const wallet = rpc('getwalletinfo', [], true);
    const balances = rpc('getbalances', [], true);
    const utxos = normalizeUtxos(
      rpc('listunspent', ['1', '9999999'], true)
        .filter(utxo => utxo && utxo.safe === true && utxo.solvable === true && utxo.confirmations > 0)
    );
    const current = utxos.map(utxo => rpc('gettxout', [utxo.txid, utxo.vout, 'true']));
    const mempoolAfter = rpc('getrawmempool', ['false', 'true']);
    const chainAfter = rpc('getblockchaininfo');
    const tipAfter = rpc('getbestblockhash');
    const sequenceBefore = mempoolBefore && mempoolBefore.mempool_sequence;
    const sequenceAfter = mempoolAfter && mempoolAfter.mempool_sequence;
    const coinsMatch = current.every((coin, index) => coin &&
      coin.bestblock === tipBefore &&
      coin.confirmations === utxos[index].confirmations &&
      btcToSats(coin.value).toString() === utxos[index].amountSats &&
      coin.scriptPubKey && coin.scriptPubKey.hex === utxos[index].scriptPubKey);
    const walletAtTip = wallet && wallet.scanning === false && wallet.lastprocessedblock &&
      wallet.lastprocessedblock.height === chainBefore.blocks &&
      wallet.lastprocessedblock.hash === tipBefore;
    if (tipBefore === tipAfter &&
        tipBefore === chainBefore.bestblockhash &&
        tipAfter === chainAfter.bestblockhash &&
        chainBefore.blocks === chainAfter.blocks &&
        Number.isSafeInteger(sequenceBefore) && sequenceBefore >= 0 &&
        sequenceBefore === sequenceAfter && coinsMatch && walletAtTip) {
      const anchor = deriveSnapshotAnchor({
        bestBlockHash: tipAfter,
        height: chainAfter.blocks,
        mempoolSequence: sequenceAfter,
        utxos
      });
      return Object.freeze({
        chain: chainAfter,
        network,
        wallet,
        balances,
        utxos,
        attempts: attempt,
        mempoolSequence: sequenceAfter,
        anchor
      });
    }
  }
  throw new Error(`could not capture a stable chain/mempool/wallet snapshot after ${maxAttempts} attempts`);
}

module.exports = {
  SATS_PER_BTC,
  MAX_MONEY_SATS,
  btcToSats,
  normalizeUtxos,
  deriveSnapshotAnchor,
  captureStableSnapshot
};
