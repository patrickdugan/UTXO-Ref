function btcToSats(value) {
  const text = Number(value).toFixed(8);
  const [whole, fraction] = text.split('.');
  return BigInt(whole) * 100000000n + BigInt(fraction);
}

function satsToBtcNumber(sats) {
  const value = BigInt(sats);
  if (value < 0n || value > 2100000000000000n) throw new Error('satoshi amount is out of range');
  return Number(value) / 100000000;
}

function nativeSegwitScript(scriptPubKey) {
  const script = String(scriptPubKey || '').toLowerCase();
  return /^(0014[0-9a-f]{40}|0020[0-9a-f]{64}|5120[0-9a-f]{64})$/.test(script);
}

class BitcoinBackend {
  constructor(rpc, wallet) {
    if (typeof rpc !== 'function') throw new Error('rpc function is required');
    this.rpc = rpc;
    this.wallet = wallet;
  }

  async status() {
    const [chain, balances] = await Promise.all([
      this.rpc('getblockchaininfo'),
      this.rpc('getbalances', [], this.wallet)
    ]);
    return {
      chain: chain.chain,
      blocks: Number(chain.blocks),
      headers: Number(chain.headers),
      initialBlockDownload: Boolean(chain.initialblockdownload),
      verificationProgress: Number(chain.verificationprogress),
      pruned: Boolean(chain.pruned),
      walletTrustedSats: btcToSats(balances.mine?.trusted || 0).toString(),
      walletPendingSats: btcToSats(balances.mine?.untrusted_pending || 0).toString()
    };
  }

  async validateDestination(address) {
    const normalized = String(address || '').trim();
    if (normalized.length < 14 || normalized.length > 100) throw new Error('destination address length is invalid');
    const result = await this.rpc('validateaddress', [normalized]);
    if (!result?.isvalid) throw new Error('destination is not a valid Bitcoin testnet address');
    if (!nativeSegwitScript(result.scriptPubKey)) throw new Error('destination must be native SegWit or Taproot');
    return { address: normalized, scriptPubKey: result.scriptPubKey.toLowerCase() };
  }

  async sendFaucet(address, amountSats, claimId) {
    const txid = await this.rpc('sendtoaddress', [
      address,
      satsToBtcNumber(amountSats),
      `UTXORef beta ${claimId}`,
      '',
      false,
      true,
      6,
      'economical'
    ], this.wallet);
    if (!/^[0-9a-f]{64}$/.test(String(txid || ''))) throw new Error('Bitcoin Core returned an invalid faucet txid');
    return txid;
  }

  async getTxout(txid, vout) {
    return this.rpc('gettxout', [txid, Number(vout), true]);
  }

  async findFaucetTransaction(claimId) {
    const comment = `UTXORef beta ${claimId}`;
    const entries = await this.rpc('listtransactions', ['*', 10000, 0, true], this.wallet);
    const txids = [...new Set(entries
      .filter((entry) => entry.comment === comment && /^[0-9a-f]{64}$/.test(String(entry.txid || '')))
      .map((entry) => entry.txid))];
    if (txids.length > 1) throw new Error(`multiple wallet transactions match claim ${claimId}`);
    return txids[0] || null;
  }
}

module.exports = { btcToSats, satsToBtcNumber, nativeSegwitScript, BitcoinBackend };
