# TradeLayer channel-repair release for Bitcoin testnet4

This directory publishes the source of a TradeLayer consensus release so that anyone can check its code hash before it is activated on chain. It replaces the deployed testnet4 release `e38f55e9…46db` for two transaction types: type 3, a token-for-UTXO channel trade, and type 4, a channel commit.

| | |
|---|---|
| Release code hash | `e89d270e01ef1ff5e594f1ab8ab96dab2c601bc6008fe3faf4bcc8a10d1a2e84` |
| Release commit | `76db3a73dc8c338461f31c4e102984fd766002bb`, tag `release-channel-e89d270e`, built from `patrickdugan/tradelayer.js` at the deployed baseline `99ba2e7` |
| Replaces | `e38f55e9e2306f0c05fd8fb03507798fd8db471c195a6e3d03eddf54983646db` (activations in testnet4 block 157248) |
| Cutover payload | `tl03;4,5spr604fsnmwpozm3jtblop0b7eqomfqrq76lqxcgnndhapwg4` (57 bytes), sent from the deployment admin `tb1q504z7g9twgpjv49zjktrs963gwwf7qqxz6ekhy` |
| Status | **Not activated.** Nothing has been broadcast. See `ROLLOUT-PLAN.md`. |

## Verify the hash

```
node tools/deployment-code-hash.cjs source
```

It prints `e89d270e…2e84 58 files`.

The hash definition is in `source/src/releaseIdentity.js`, and the activation payload carries the same value:

- the SHA-256 of each file, after converting line endings to LF;
- the files are `src/**/*.js`, `package.json`, `package-lock.json` and `config/bitcoin-testnet4-deployment.json`;
- the sorted list of those digests is hashed under the tag `TradeLayer deployment source v1`.

Windows and Linux checkouts of the same source therefore give the same hash.

## What the release changes

**Type 3 (channel trade):**
- Decoding, validation and settlement work on the actual output indices, in satoshi units.
- A trade never switches to the other participant's channel column.
- The token fee is charged once.
- The trade may carry a ninth field, an expiry block (base36). A trade confirming after that block is refused.

**Type 4 (channel commit):** clearlist arrays decode as a single field.

**Indexing:** every indexed output reference keeps its `vout`.

**Release gate:**
- Types 3 and 4 are valid only while the latest on-chain activation of the type names this release's hash.
- The first activation of a type may name any release.
- A later activation naming a different release makes the node stop indexing (`SupersededCodeError`) before that block is marked processed. An outdated node therefore halts rather than settling under replaced rules.

**Listener:**
- `/tl_getChannelColumn` loads the channel record before predicting the column; before, it passed the address string.
- `/tl_getProtocolCapabilities` reports this release's hash and the hash recorded on chain for types 3 and 4.

**Wallet** (`wallet-patches/`, against the TradeLayer desktop wallet):
- The swap payload bridge takes positional fields and returns the `{ data }` envelope.
- The seller passes the negotiated channel address. Both sides take the column from the listener.
- Token delivery is pinned to output 0 and payment to output 1, and the PSBT guard enforces this.
- Each side refuses a listener whose release is not the one activated on chain: the seller before its commit, the buyer before building the trade.

The deployed decoder does not check how many fields a type-3 trade has, so it reads a nine-part trade and silently drops the expiry. The expiry and the gate bind only after the cutover activation, and every indexer must run this release by then.

## Evidence (no transactions were signed or broadcast)

- **`evidence/release-rehearsal-{crlf,lf}.json`:** `source/scripts/check-bitcoin-testnet4-release.cjs` on unsigned fixtures in a separate state namespace. In block order:
  1. a commit before the cutover is refused;
  2. the cutover activation is recorded;
  3. a commit, and a trade at its expiry block, settle;
  4. the same trade one block later is refused as expired;
  5. an activation naming a third release halts indexing and is not recorded.

  The CRLF and LF checkouts produce the same state digest, `c5686a53…85e9`.
- **`evidence/replay-*.json` and `evidence/replay-state-comparison.json`:** the deployed release and this release each indexed testnet4 from genesis (157135) to 157334. The states are identical apart from NeDB's random ids and the added `vout`. As of 157333, the six activations are the only TradeLayer transactions on chain.
- **`evidence/release-listener-capabilities.txt`:** a running release listener on that replayed state. It reports this hash, with types 3 and 4 still recorded for the deployed release and their rules off, which is correct before cutover.
- **`evidence/payload-bridge-report.json`:** the wallet's payload bridge, decoded through this release.

The tests are in `source/tests/utxoChannel.node.check.js`: 28 cases. It is renamed from `.test.js` because UTXO-Ref's runner executes every `*.test.js`, and this file needs TradeLayer's own dependencies. To run it:

```
npm ci --ignore-scripts
node --test tests/utxoChannel.node.check.js
```

`tools/scan-tradelayer-payloads.cjs` and `tools/compare-nedb-state.cjs` rerun the chain scan and the state comparison against your own testnet4 node.
