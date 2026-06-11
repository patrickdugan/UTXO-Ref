# UTXORef Production Gap And Live Path

Date: 2026-05-03

## Current Position

We have enough to demonstrate the UTXORef architecture credibly, but not enough
to call it production-complete.

The strongest current slice is:

- TradeLayer consensus/state data is compressed into a state oracle blob.
- A selected send resolves through a DLC-funder registry.
- The resolved route becomes deterministic UTXORef payout leaves.
- RPC preflight checks the funding input before a signer builds a sweep.
- The decoded final sweep output vector is hash-bound after finalization.
- Fraud, checkpoint, withdrawal queue, PNL, lease, watchtower, and dashboard
  artifacts verify deterministically.
- BitVMArena now has round-2 pressure tests against the integrated stack.

## What Is Still Missing

Production UTXORef still needs the hard edges:

- Bitcoin Script or BitVM circuit implementations for the JS referee predicates.
- Live happy-path and challenge-path spends for every route.
- Full TradeLayer parser/consensus state as the source of truth, not sample blobs.
- Wallet policy that shows and verifies route, final outputs, and future recovery.
- Watchtower persistence, reorg handling, retries, and alert delivery.
- Fee, dust, mempool, RBF/CPFP, timeout, and challenge-bond hardening.
- Operator recovery runbooks for challenge, timeout, sweep, and replay cases.

## Path To Make Real First

The next slice should be one narrow live path:

1. Fund a DLC/BitVM UTXORef input.
2. Publish or ingest a TradeLayer send state oracle.
3. Resolve the recipient through the DLC-funder registry.
4. Build the UTXORef sweep plan.
5. Decode the final transaction and bind its output vector to the route.
6. Emit dashboard-ready evidence with txids, hashes, and fraud challenge handles.
7. Keep every step replaceable with real RPC/testnet data.

## Acceptance Gate

This path is useful when one command can emit:

- funding outpoint
- selected TradeLayer send txid
- state oracle hash
- registry hash
- route transcript hash
- UTXORef withdrawal root
- final transaction output hash
- final spend binding hash
- stack hash
- dashboard view hash
- challengeable fraud proof ids

The proof object must fail verification if any final output, route transcript,
component hash, or challenge binding is tampered with.

## Reserve Reconciliation (added 2026-06-10)

The deposit side and the withdrawal side are now reconciled against each other.
Previously the withdrawal queue committed to a cap that was just the sum of
approved requests, with no check that the tokenized reserve could cover it.

- `tradelayer_reserve_reconciliation_referee.js` enforces the peg invariant
  `sum(payable withdrawals) <= sum(credited deposit reserve)` as a verifiable,
  tamper-evident commitment.
- Reserve can be supplied explicitly, derived from a `ReceiptDepositIndexer`
  snapshot (credited deposits only), or from a `ReceiptLedger` snapshot.
- `buildTradeLayerReserveInsolvencyChallenge` packages a challengeable proof when
  the committed cap exceeds the proven reserve (shortfall > 0).
- The withdrawal queue itself is now fail-closed: only `approved`/`settled`
  statuses are payable (an unknown/pending status no longer becomes a payout),
  and two distinct request ids producing the identical payout leaf are rejected
  as a double-pay, while one send txid may still fan out to distinct recipients.

The reconciliation is now bound into the stack bundle and the production policy
gate: the gate emits `pause_spend` on insolvency, the dashboard flips to
`needs_attention` and lists `reserve_insolvency` as challengeable, and the
reconciliation hash is folded into the stack hash. Evidence still verifies when
insolvent; it is the spend gate that pauses.

### Live reserve (added 2026-06-10, real LTCTEST data)

The reserve is no longer a placeholder. `tradelayer_live_reserve_adapter.js`
turns Litecoin Core `listunspent` output into a credited `ReceiptDepositIndexer`
snapshot, which feeds the reconciliation as the `receipt-deposit-indexer`
source. `tradelayer_live_reserve_demo.js` is a one-command driver:

```powershell
# node running: litecoind -testnet -rpcport=19332 -rpcuser=user -rpcpassword=pass -server -datadir=D:\testnetwallet
node bitvm3/utxo_referee/tradelayer_live_reserve_demo.js `
  --rpc-url http://127.0.0.1:19332 --rpc-user user --rpc-pass pass --wallet tl-wallet
```

Verified live against a fully synced testnet node (tip ~4,761,052):
- `tl-wallet`: 42 real role UTXOs = 17,164,718 sats credited reserve, cap 99,000,
  margin 17,065,718 -> solvent -> `allow_sweep`, dashboard `ready`.
- `funding` (empty wallet): 0 sats reserve, cap 99,000, margin -99,000 ->
  insolvent -> `pause_spend`, dashboard `needs_attention`.

Captured live inputs: `artifacts/live/tl_wallet_unspent.json` (snapshot) and
`artifacts/live/reserve_reconciliation_latest.json` (result).

### Live sweep decode (added 2026-06-10, real Core decoderawtransaction)

The final sweep tx is no longer synthetic either. Using a real funded wallet.dat
UTXO as the DLC funding input, the route plan derives concrete outputs, a raw
sweep tx is built with Core `createrawtransaction`, and the live-path harness
decodes it through Core `decoderawtransaction` and reviews the decoded outputs
against the plan:

```powershell
node bitvm3/utxo_referee/tradelayer_utxoref_live_path_demo.js `
  --input bitvm3/utxo_referee/artifacts/live/live_consensus_input.json `
  --final-hex <raw sweep hex> `
  --rpc-url http://127.0.0.1:19332 --rpc-user user --rpc-pass pass `
  --out bitvm3/utxo_referee/artifacts/live/utxoref_live_path_realtx.json `
  --md  bitvm3/utxo_referee/artifacts/live/utxoref_live_path_realtx.md
```

Verified live (`verification=ok`, `finalOutputReview=ok`):
- Funding outpoint: `ac2518f11bff1c6f229b9431dbc91d0f0d280dcde2b90de7e46c627a8b5dbbae:0`
  (real, 960,560 sats).
- Outputs: 240,140 sats to the DLC funding address (tl-wallet) + 719,420 sats
  refund to the funding address (wallet.dat), fee 1,000.
- `finalTxOutputHash` now comes from a genuine Core decode, not the deterministic
  builder.

The sweep was then signed (`signrawtransactionwithwallet`) and broadcast
(`sendrawtransaction`) — both outputs are wallet-owned, so it is recoverable:

- Broadcast sweep txid:
  `3e8d784efab4a8b65d127267b441bfdf4a28aff7b46fa90c05f21113cfd001d7`
  (141 vB, 1,000 sat fee, `testmempoolaccept` allowed).
- Confirmed on-chain in block 4,761,067
  (`28785c0e5ba1d5ce7d7deafe632c830d88b45eec8e55631028643d3b05b8d254`).
- Re-ran the harness with `--final-txid` (the getrawtransaction path); it
  verifies (`verification=ok`, `finalOutputReview=ok`) and produces the same
  `finalTxOutputHash` (`916733...`) as the `--final-hex` round-trip, confirming
  the on-chain tx's outputs are byte-identical to the planned sweep.
- Evidence: `artifacts/live/utxoref_live_path_broadcast.{json,md}`.

The whole deposit->withdraw path now runs on real chain data: a live deposit
reserve (42 credited UTXOs) reconciled against the withdrawal cap, and a real
funded input swept to plan-matching outputs, broadcast, and decoded back through
Core.

### Real DLC funding-script output (added 2026-06-10)

The sweep's `send-to-dlc-funding-output` now pays an actual DLC funding script,
not a plain wallet address. Using two live tl-wallet pubkeys, a 2-of-2 P2WSH
funding address is built with Core `createmultisig` (the same construction as
`m1_dlc_psbt_cet.js`), wired into the DLC-funder registry's `dlcAddress`, and
swept to:

- DLC funding address (2-of-2 P2WSH):
  `tltc1qe0750cxs6fclks8rgaassf58c5gg0208v6faeg9kn0ra34hzq7ssg5ugfj`
- decoded output 0 type `witness_v0_scripthash`, script
  `0020cbfd47e0d0d271fb40e3477b082687c51087a9e76693dca0b69bc7d8d6e207a1`
  (= `0020` + sha256(2-of-2 witnessScript)).
- harness review against the plan: `verification=ok`, `finalOutputReview=ok`
  (`artifacts/live/utxoref_live_path_dlc_funding.{json,md}`).

### Full DLC lifecycle on-chain (added 2026-06-10)

The complete deposit -> fund -> settle loop now runs and confirms on LTCTEST:

1. Sweep (send funds toward the DLC): txid
   `3e8d784efab4a8b65d127267b441bfdf4a28aff7b46fa90c05f21113cfd001d7`,
   confirmed in block 4,761,067.
2. Funding (lock collateral into the 2-of-2): txid
   `f2f1191b0d1a92c55b0d21d221979e97e7be741b57b720a1d070b9697ffa101a`,
   locks 179,855 sats into the 2-of-2 P2WSH funding output, confirmed in
   block 4,761,076.
3. CET (settle): txid
   `28976fd5c6d203ad81c4106c5402d68b21d8d66f4c9d61a18c10936f3876e121`,
   spends the 2-of-2 funding output to the winner (178,855 sats, 1,000 fee),
   confirmed in block 4,761,076.

The 2-of-2 was registered with `addmultisigaddress` and the CET was signed with
both keys (`signrawtransactionwithwallet` -> `complete: true`,
`testmempoolaccept` allowed) before broadcast. Txids captured under
`artifacts/live/dlc_*`.

### Oracle-attested, route-derived CET (added 2026-06-10)

The CET is no longer a single cooperative payout. `tradelayer_dlc_cet_oracle_selection.js`
derives concrete per-outcome CET output maps (settle-gain / settle-loss / roll)
from the bounded settlement model, and gates which CET settles on an Ed25519
oracle attestation that binds contractId + funding outpoint + outcomeId.

Verified live (`tradelayer_dlc_cet_oracle_selection.test.js`, 5 tests, plus an
on-chain run):
- Fresh collateral locked: funding txid
  `9b1d9e4806fcb50ad9b12921fab2f898a8d471e5ea4f2215734e6809ad32dc83`,
  150,000 sats into the 2-of-2 (block 4,761,083).
- Oracle attested `settle-loss`; `selectCetForAttestation` verified the
  signature + outpoint binding and returned the matching outputs
  (bob 7,500 / operator 1,500 / residual 140,000 = collateral - 1,000 fee).
- Oracle-selected CET txid
  `5e232095a0c01ab650214a85821bc555db58cfd73ade88b5273cb56fe198d442`,
  signed 2-of-2, confirmed in block 4,761,083.
- Evidence: `artifacts/live/dlc2_funding.json`,
  `artifacts/live/dlc2_oracle_cet.json` (includes oracle pubkey + attestation).

### Adaptor-signature DLC core (added 2026-06-10)

The oracle attestation now *cryptographically enforces* the outcome instead of
merely selecting a pre-built CET. `tradelayer_dlc_adaptor_sig.js` implements
secp256k1 + BIP340 Schnorr + Schnorr adaptor signatures from scratch (the repo
is zero-dependency):

- Each party publishes an adaptor pre-signature on a CET under the outcome point
  `T = t*G`. The pre-signature is *not* a valid signature on its own.
- The oracle commits an x-only pubkey + nonce (`buildDlcOracle`); each outcome
  point is computable in advance (`dlcOutcomePoint`); attesting an outcome
  reveals the scalar `t` (`dlcAttest`) with `t*G == T`.
- Only that scalar completes the matching CET pre-signature into a valid BIP340
  signature (`adaptorComplete`); the scalar is also extractable
  (`adaptorExtract`). Wrong-outcome CETs cannot be completed.

Correctness is anchored hard (`tradelayer_dlc_adaptor_sig.test.js`, 9 tests):
the scalar multiplication is cross-checked against Node's libsecp256k1 (ECDH)
for random keys, `N*G = O`, the BIP340 pubkey for secret 3 matches the published
vector, and an end-to-end multi-outcome DLC shows only the attested CET signature
verifies.

### On-chain taproot adaptor-DLC settlement (added 2026-06-10)

The adaptor signature now settles on-chain. `tradelayer_taproot.js` adds the
BIP341 keypath tweak, P2TR scriptPubKey, and `SIGHASH_DEFAULT` sighash, all
validated against the published BIP341 wallet test vectors
(`tradelayer_taproot.test.js`, vectors vendored as
`bip341-wallet-test-vectors.json`). Because the tweak/sighash are vector-anchored,
a hand-built P2TR output is safe to fund even though this node runs Litecoin Core
0.21.2.2 (no taproot address tooling).

`tradelayer_taproot_dlc_demo.js` funds a P2TR keypath output and spends it with a
witness that is the oracle-completed adaptor signature:

- Funding txid `276b600baf04432b4b3bec03b2fc7aefd26203d8a6e51fa48f16639c08069045`
  (locks 100,000 sats into the P2TR), confirmed in block 4,761,191.
- Spend txid `ce9e727324e3467129eb3a6e306610a2be4f0e53f7957fbec098124d6d3f0366`,
  witness = adaptor-completed BIP340 signature, accepted by the network and
  confirmed in block 4,761,191. The completed signature verifies against the
  taproot output key, which is exactly what the consensus rules check.

Network acceptance is the end-to-end proof that the taproot tweak, BIP341
sighash, witness serialization, and adaptor completion are all correct.

### 2-party MuSig2 adaptor-DLC on-chain (added 2026-06-10)

The unilateral-spend gap is closed. `tradelayer_musig2.js` implements MuSig2
(BIP327) key aggregation, x-only (taproot) tweak, nonce aggregation, and partial
signing, with an adaptor offset on the aggregate nonce. KeyAgg, the x-only tweak,
and partial signing are validated against the published BIP327 test vectors
(`tradelayer_musig2.test.js`, vectors vendored).

The funding output is a P2TR keypath whose internal key is the MuSig2 aggregate
of two parties, so settlement requires BOTH partial signatures AND the oracle
attestation:

- Funding txid `bfe988a468f2bf8a8da1ef2ee2fa462d6ea6f0c0b6bff3b68a3c36b09fe9bd37`,
  confirmed in block 4,761,258.
- Spend txid `8b8d18f45b209f7a687d9201e8e9b44a2aff2608aca7aad2b5d1472cfc9e5463`,
  witness = 2-party MuSig2 adaptor-completed BIP340 signature, accepted by the
  network and confirmed in block 4,761,258.
- The driver asserts the negative cases before broadcast: one party alone is
  rejected, and the pre-signature does not verify without the oracle.

`tradelayer_musig2_dlc_demo.js` runs the full flow. The signing side of the DLC
is now complete on-chain: oracle-enforced, 2-of-2, taproot.

### BitVM referee constraint enforced on-chain (added 2026-06-10)

The referee challenge is no longer just an evidence object. `tradelayer_taproot_script.js`
adds the taproot script-path machinery (tapleaf hash, merkle root, script-tree
tweak, control block, BIP341 script-path sighash), validated against the BIP341
wallet test vectors. `tradelayer_bitvm_gadgets.js` adds the foundational BitVM
primitive: a bit commitment (hash0/hash1 over two preimages) and an
equivocation-punishment tapscript that is spendable only by revealing BOTH
preimages plus a challenger signature.

`tradelayer_bitvm_punishment_demo.js` bonds a taproot output with the punishment
leaf and spends it on the script path, so the network executes the tapscript:

- Funding txid `46180ba8af7a2892c6374d409a5f806f42cf98c105fdb1b6202d792d2fd25895`
  (bonds the output with the equivocation-punishment leaf), block 4,761,263.
- Script-path spend txid
  `aa3cd2fcd0cbe9a7b13355aab639e35c8a79a9b32f1080e55989434c63c8163a`,
  witness reveals both committed preimages + the challenger BIP340 signature; the
  consensus rules ran `OP_SHA256/OP_EQUALVERIFY` on each preimage and `OP_CHECKSIG`
  on the signature and accepted it. Confirmed in block 4,761,263.

This is the original "hard edge": a referee predicate (here, equivocation on the
committed final-output-review bit) is now punished by a real Bitcoin Script
executed by the network, not a JS evidence object.

### BitVM circuit framework - Block 1: wires + logic gates (added 2026-06-11)

`tradelayer_bitvm_circuit.js` turns the single-gate primitive into a circuit
framework: a wire is a bit commitment; a gate (AND/OR/XOR/NAND/NOT) is enforced
by one disprove leaf per invalid truth-table row. A fraudulent gate assertion
(output != f(inputs)) is punishable by revealing the prover's own preimages for
that invalid row; an honest assertion has no satisfiable disprove leaf. The
reveal script generalizes the equivocation gadget to N wires
(`tradelayer_bitvm_circuit.test.js`, 8 tests).

`tradelayer_bitvm_gate_demo.js` runs an on-chain gate disprove: a prover claims
`1 AND 1 = 0`, and the challenger spends the gate's disprove leaf on the script
path, revealing a=1/b=1/c=0:
- funding txid `985914a430f661805cdb8e10c746bb424fb70a57da098f90e93d6d7d1a7e1971`
  bonds the disprove leaf (block 4,761,431)
- disprove spend `2be77c16ee1de2e378a882671d48a688e73a352fb849972818874de69d3e5d78`,
  network executed the 3-wire reveal tapscript, confirmed in block 4,761,431

This is Block 1 of the launch-grade BitVM plan.

### BitVM Blocks 2-3: the cap <= reserve predicate circuit (added 2026-06-11)

`tradelayer_bitvm_comparator.js` composes the gates into the real referee
predicate - the solvency invariant `cap <= reserve` over N-bit unsigned integers,
built as a full-subtractor borrow chain (`solvent = NOT final_borrow`). A 16-bit
comparator is 93 gates. Validated (`tradelayer_bitvm_comparator.test.js`, 6 tests):

- computes `cap <= reserve` correctly for 200 random pairs + boundary cases;
- the honest execution trace has no satisfiable disprove leaf;
- a tampered solvency claim (flip the final solvent bit) is localized to exactly
  one bad gate, whose disprove leaf is in the committed set and whose required
  reveals match the prover's own committed wire values;
- a flipped internal borrow wire is also caught.

So the operator commits the full wire-by-wire execution of the solvency check; if
any gate is inconsistent, a challenger disproves that one gate on-chain (Block 1
mechanism). Remaining: commit the whole disprove leaf set as a taproot tree
(merkle tree + control-block-with-path), and the assert -> challenge ->
disprove/timeout transaction flow with bonds and CSV timeouts (Blocks 4-8). The
per-gate on-chain disprove and the predicate circuit are both now real.

### BitVM Blocks 4-5: whole circuit bonded in one taproot output (added 2026-06-11)

`tradelayer_taproot_tree.js` commits every disprove leaf of the circuit into a
single taproot output (balanced merkle tree) and produces each leaf's merkle
path + control block. Root and control blocks are validated against the
multi-leaf BIP341 wallet test vectors (`tradelayer_taproot_tree.test.js`).

`tradelayer_bitvm_circuit_demo.js` runs the full predicate on-chain: the 16-bit
`cap<=reserve` comparator's 308 disprove leaves are bonded in one P2TR output;
the operator publishes a fraudulent solvency claim (reserve 1000 < cap 2000, but
asserts solvent); a challenger localizes the inconsistent gate
(`not(borrow16) -> solvent`) and spends its disprove leaf on the script path with
an 8-deep merkle-path control block:

- funding txid `8015156110bcbfe8a35fe6957ba4f0c18a107a369ae7ead0eb728c29a96fee46`
  bonds the whole circuit (block 4,761,436)
- disprove spend `05d9d2b258a0c20306f88d23cdbf45c80d9156a7f628511fbbc177b3ee299d08`,
  network verified the merkle path AND executed the gate-disprove tapscript,
  confirmed in block 4,761,436

So the entire solvency predicate is bonded in one UTXO and any single
inconsistent gate is punishable on-chain.

### BitVM Blocks 6-7: dispute game (disprove vs CSV timeout) (added 2026-06-11)

`tradelayer_bitvm_dispute.js` assembles the assert-output taproot tree from the
circuit's disprove leaves PLUS a CSV timeout leaf
(`<csvDelay> OP_CHECKSEQUENCEVERIFY OP_DROP <operatorXonly> OP_CHECKSIG`), so the
bond has two exits: a challenger disproves a bad gate, or the operator reclaims
after the challenge window. Both outcomes are now on-chain:

- Disprove (challenger wins): Blocks 4-5, block 4,761,436.
- Timeout (operator wins): `tradelayer_bitvm_timeout_demo.js` bonds the assert
  output (148 disprove leaves + CSV timeout leaf, csv=2 blocks), waits for CSV
  maturity, and reclaims via the timeout leaf with `nSequence=2`:
  - funding `935a56903bd3a702f8a4bf1213d2f2dcfc974f62810ad026bcff989cd2064eea`
  - timeout reclaim `581020bf4037bde521a0a87a2c9dc1d7cb9ab8b944062f6f63dbb15552e1840d`,
    `OP_CHECKSEQUENCEVERIFY` passed, confirmed in block 4,761,442.

The dispute game is complete: a bonded solvency assertion is safe iff the
operator's committed circuit execution is honest.

### BitVM Block 8: input binding -> the complete solvency referee (added 2026-06-11)

`tradelayer_bitvm_solvency_referee.js` closes the last soundness gap: the
operator must feed the *real* reserve/cap as circuit inputs. Wire commitments are
derived deterministically from the reconciliation hash (binding the bonded
circuit to one specific `tradelayer_reserve_reconciliation_referee` output), and
because reserve/cap are public, every input wire has a known correct bit. An
input-binding disprove leaf punishes the operator for asserting any input bit
wrong. The full assert tree is gate-disprove + input-binding + CSV timeout
(`tradelayer_bitvm_solvency_referee.test.js`, 5 tests, incl. binding to a real
referee reconciliation).

`tradelayer_bitvm_solvency_demo.js` runs it on-chain end to end: a real insolvent
reconciliation (reserve 99,000 < cap 17,164,718) is bonded as a 32-bit solvency
assert tree (628 gate + 64 input-binding + 1 timeout leaves); the operator fakes
reserve bit r25 to make the circuit compute solvent; the challenger disproves via
that input-binding leaf:

- funding `b189825dd6b0d407f6830d34a6f2b1059f303a595215bb7931e2b9ce763c2565`
  bonds the full referee (block 4,761,536)
- disprove spend `134f204895ee57d5e748d28b4c7f33e5601fde9aa4cc1101c773798131746970`,
  network punished the faked solvency input, confirmed in block 4,761,536

This completes the launch-grade BitVM solvency referee (Blocks 1-8): a bonded
"solvent" assertion tied to the real reserve reconciliation is sound on-chain -
the operator can fake neither the inputs (input binding) nor the gate execution
(gate disprove), and the dispute resolves by disprove or CSV timeout. Remaining
(Blocks 9-10): a SHA256 gadget for the final-output-equality predicate (the
second referee check) + hardening. The solvency predicate is launch-complete.

## Work Started

This repo now adds a live-path evidence harness:

- `tradelayer_utxoref_live_path.js`
- `tradelayer_utxoref_live_path.test.js`
- `tradelayer_utxoref_live_path_demo.js`
- `artifacts/utxoref_live_path_latest.json`
- `artifacts/utxoref_live_path_latest.md`

The demo is deterministic today. The intended live swap points are:

- replace `SAMPLE_CONSENSUS_INPUT` with parser output
- replace the synthetic decoded transaction with `decoderawtransaction`
- or pass `--final-hex` / `--final-txid` so the demo asks Core RPC to decode it
- require the final output review to match every planned sweep output by value
  and script before signer/dashboard acceptance
- attach the resulting final txid to the dashboard
- broadcast only after wallet policy verifies the final output hash
