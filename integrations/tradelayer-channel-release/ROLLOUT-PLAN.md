# Rollout plan: TradeLayer channel-repair candidate on Bitcoin testnet4

Written 2026-10-23. It covers the candidate in `work/redteam-tradelayer-channel` at `4f47b98` and the wallet in `work/redteam-wallet-integrated` at `db1b3dc`. Nothing in this plan has been executed. Every on-chain step needs Patrick's explicit go-ahead, because it spends testnet4 coins and signs with the admin key.

## Where things stand

**What is deployed.**
- Admin: `tb1q504z7g9twgpjv49zjktrs963gwwf7qqxz6ekhy`. Genesis block: 157135.
- Code hash: `e38f55e9…46db`. The deployment manifest definition reproduces it from `redteam-tradelayer-testnet4`.
- All six activations (types 0–35) are in block 157248.

**On-chain history (scanned 2026-10-23, blocks 157135–157333).** The only TradeLayer payloads are the six activations. No type 3 (token-for-UTXO trade), type 4 (channel commit) or any other transaction exists. Replaying the chain under the candidate therefore gives the same state as the frozen code. This stays true only until someone confirms a type 3 or type 4 under the frozen rules, so the plan is time-sensitive.

**Candidate hash at `4f47b98`:** `53af46f2a0577d7d293954f24ccbfe85d9ad1a0e63a8766e7ac7084dd0f3f5cb`, by the same definition. It will change again with the Phase 1 edits; the hash that goes on chain is the one at the frozen release commit. The `f3a9584f…` in the readiness note is the earlier `9e8adb2` and is stale.

**Rules the candidate changes:**
- type 3 decode, validation and settlement: output indices, satoshi units, no column switching, the fee charged once, and the expiry field;
- type 4 decoding of clearlist arrays;
- the output reference list that indexing passes to type 3;
- the listener routes `/tl_getChannelColumn` and `/tl_getProtocolCapabilities`.

**Why there is no "activation" to lean on.**
1. An activation transaction (`tl0<types>,<base36 hash>`) only records `{active, activationBlock, codeHash}` per type. No rule reads `codeHash`, and re-activating a type that is already active is accepted.
2. The peer check `Consensus.verifyConsensus` is never called. Its runtime hash (`Consensus.hashFiles`) covers a different file list, and it does not normalize line endings, so a Windows checkout and a Linux checkout of the same source disagree.
3. The frozen decoder does not check how many fields a trade has. It reads a 9-part trade and drops the expiry, and settles type 3 under the old rules.

So "activating the candidate" means three things:
- every indexer switches code;
- an admin announcement binds the new hash on chain;
- a code change in the candidate makes that binding enforceable.

A frozen node left running after the switch will disagree on the first type 3. That cannot be prevented from the chain; the only control is to stop or upgrade every frozen indexer.

## Phase 0: hold the line (now, until cutover)

- Keep channel trading off:
  - Wallets at `db1b3dc` refuse listeners that lack the new capability.
  - Deployed wallets cannot build a valid channel payload at all: the old bridge encodes property 0 and amount 0. Say plainly that they must not be used for channel trades.
- Rerun the scan once a day: `node outputs/scan-tradelayer-payloads.cjs <cookie> 157135`. `outputs/deployment-code-hash.cjs <repo>` recomputes a code hash.
- **Stop condition:** if any type 3 or type 4 confirms before cutover, stop. The frozen and candidate rules may settle it differently, and the plan has to account for that transaction explicitly.

## Phase 1: changes the candidate needs before cutover

Each change gets tests that fail on `4f47b98`.

1. **Gate the new rules on chain.** A type 3 or type 4 transaction is valid only when the latest activation of its type records this node's own code hash, and only from that activation's block on.
   - Before the cutover activation, the candidate refuses types 3 and 4 outright. This is safe because none exist (Phase 0 checks this).
   - Indexing replays in block order, so on any reindex a transaction is judged against the activation record as it stood at its own block.
2. **Fail closed when superseded.** Once this node's own hash has been recorded for type 3 or type 4, a later activation of that type naming a different hash makes the listener stop indexing with an explicit "superseded code" error. It must not keep settling.
   - An activation seen before its own hash appears (the 157248 originals, during replay) is not an error.
   - This is the mechanism for every later upgrade.
3. **One hash definition.** The node computes its own hash with the deployment manifest definition: sorted, LF-normalized digests of `src/**/*.js`, `package.json`, `package-lock.json` and the deployment profile, under `TradeLayer deployment source v1`.
   - Either retire `Consensus.hashFiles` or make it call the same function.
   - Test that a CRLF checkout and an LF checkout give the same hash.
4. **Report the hashes to wallets.** `/tl_getProtocolCapabilities` also returns `codeHash`, plus the hash and block recorded for types 3 and 4.
   - The wallet's `assertListenerSupportsTrade` additionally requires the listener's hash to equal the hash recorded for type 3.
   - It still trusts its own listener; this catches a listener that was not upgraded, not a lying one.
5. **Freeze the release.**
   - Tag the commit and write `bitcoin-channel-release-source.json`: the commit, the manifest, the hash, and the base36 payload string.
   - The activation payload `tl03;4,<base36 hash>` is 57 bytes, well under the 80-byte limit.

## Phase 2: off-chain rehearsal (no coins)

All runs use a fresh random-admin database namespace. None touches the canonical deployment state.

1. **Full-block rehearsal** (extend `check-bitcoin-testnet4-channel.cjs`), in this order:
   - genesis;
   - the six original activations with the frozen hash;
   - a type 3 before cutover, which is refused;
   - re-activation of 3 and 4 with the release hash;
   - commit;
   - a 9-part trade confirming at or before its expiry, which settles;
   - a trade confirming after its expiry, which is refused;
   - a later activation with a third hash, after which the listener halts.

   Supply is conserved throughout.
2. **Determinism:** run the same blocks on a Windows CRLF checkout and a WSL LF checkout. The state hashes (tally, channels, activation registry) must be equal.
3. **Real-chain replay:** index testnet4 from 157135 to tip with the release. The resulting state must equal the frozen node's state, which holds only the activations and genesis balances.
4. **Wallet against the release listener:**
   - the existing suite;
   - `bitcoin-payload-bridge-probe.cjs`;
   - one swap on testnet4 run to a signed PSBT that is *not* broadcast, checked through the PSBT guard.

**Go/no-go:** every step passes and the Phase 0 scan is still clean.

## Phase 3: inventory and coordination

- **List every process that indexes testnet4 TradeLayer:**
  - the local observer (wallets disabled);
  - any wallet-bundled listener;
  - any relayer, collator or VPS listener behind the wallet's `endpoints.conf`.

  Only Patrick knows the full list. Each one is upgraded to the release or stopped before cutover; none may stay on the frozen code.
- **Wallets:** build the wallet release against the frozen candidate. Tell users that older wallet builds must not be used for channel trades.
- **Publish the release source** so that third parties can check the hash. This is Patrick's call: the repos are public and the change fixes security-relevant bugs.

## Phase 4: cutover (on chain; needs Patrick's go-ahead)

1. Stop the frozen indexers. Start the release indexers from a clean reindex from 157135 and let them reach tip. They hold, because types 3 and 4 are refused until step 2.
2. **One admin transaction:** payload `tl03;4,<base36 release hash>`.
   - The fee is about 1,500 sats from the 495,359-sat TradeLayer reserve output `5fb4fe54…f1b3:0`.
   - Build it with `activationTransaction.js` restricted to types `[3, 4]`. Leave out type 0: re-activating type 0 re-runs token initialization.
   - Patrick signs with the admin key; the key is never handled by tools.
   - The block it confirms in is the cutover height **H**.
3. **After 6 confirmations, check every listener:**
   - types 3 and 4 show the release hash, with `activationBlock = H`;
   - the state hashes are equal;
   - `/tl_getProtocolCapabilities` reports matching hashes.
4. Enable wallet trading.

## Phase 5: first live trades

1. 1 TL for a small amount of sats, between two wallets Patrick controls. Check the settlement on two independent listeners.
2. A negative case: expiry set to tip + 1, with the buyer broadcasting after the expiry. Every listener must refuse it. This costs only the fee and the payment between Patrick's own wallets.

Then widen access. Rerun the scan and the cross-listener state comparison daily for the first week.

## Rollback

- **Before H confirms:** do not broadcast, and restart the frozen indexers. Nothing changes.
- **After H:** a type 3 or type 4 settled under the release cannot be re-settled under the frozen rules without a split. So rollback means "stop and fix forward":
  1. Pause wallet trading.
  2. Fix the release.
  3. Record the fixed hash with another activation of 3 and 4. Phase 1 item 2 makes outdated release nodes halt rather than diverge.

  Going back to the frozen code after H is not supported.

## Decisions for Patrick

1. Approve the on-chain gate and the fail-closed behaviour (Phase 1, items 1–2), or keep the hash advisory.
2. The listener inventory (Phase 3).
3. Whether and where to publish the release source.
4. Go-ahead for, and signing of, the cutover transaction and the Phase 5 trades.

Still out of scope: the free option the buyer holds after SELLER:STEP5, and RBF; the orderbook's STEP5-to-STEP4 binding; token-for-token and futures settlement.

## Status (2026-10-23, after Patrick's go-ahead)

**Phase 1: done.** Candidate commit `76db3a7`, tagged `release-channel-e89d270e`. Release hash: `e89d270e01ef1ff5e594f1ab8ab96dab2c601bc6008fe3faf4bcc8a10d1a2e84`.
- `src/releaseIdentity.js` holds the single hash definition, which `Consensus.hashFiles` now returns.
- Types 3 and 4 are valid only while the latest activation names this release.
- A later activation naming another release throws `SupersededCodeError`. Every per-transaction and per-block handler rethrows it, so indexing stops before the block is marked processed.
- The capability route reports this release and the hashes recorded on chain.
- The wallet (`30c0a93`) refuses a listener whose release is not the one recorded, or whose rules are not active.
- Release record: `bitcoin-channel-release-source.json`. Cutover payload: `tl03;4,5spr604fsnmwpozm3jtblop0b7eqomfqrq76lqxcgnndhapwg4` (57 bytes).

**Phase 2: done, except the signed testnet4 swap.**
- Rehearsal (`scripts/check-bitcoin-testnet4-release.cjs --height 157300`) passes every stage:
  - a commit before the cutover is refused;
  - the cutover activation is recorded;
  - commit and trade at the expiry block settle;
  - a late trade is refused as expired;
  - a third-release activation halts indexing and is not recorded.
- Determinism: the Windows CRLF checkout and an LF copy give the same release hash and the same state digest, `c5686a53…85e9`, and a rerun reproduces it.
- Real-chain replay: the frozen code (in a fresh clone that reproduces `e38f55e9…`) and the release each indexed testnet4 from 157135 to 157334. The states are identical apart from random storage ids and the added index `vout` (`replay-state-comparison.json`).
- Tests:
  - candidate: channel 28/28, other gates 18/18, index regressions 3/3;
  - wallet: 72/73 files, 687 cases (only the pre-existing `watchtower-stop` fails);
  - bridge probe: exits 0.
- A running release listener on the replayed state reports release `e89d…`, with types 3 and 4 still recorded for `e38f…` at 157248 and their rules off. That is correct before cutover.
- Not done: the signed-but-unbroadcast testnet4 swap through the Electron wallet.

**Phase 3: blocked.** Looking up the Bitvise "orderbook" profile was refused by the Claude Code auto-mode classifier ("Credential Exploration"), so the VPS listener inventory has not been taken.

**Phases 4–5: not started.** The cutover waits on the inventory: a frozen listener left running would split on the first channel trade.
