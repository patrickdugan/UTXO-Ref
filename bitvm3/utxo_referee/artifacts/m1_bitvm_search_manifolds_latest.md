# M1 BitVM Search Manifolds

- Generated: `2026-04-25T18:15:08.714Z`
- Artifact hash: `ba4b374cdffdf0d3c588c315b92a08fb55f78ca4c854191abbe4356ab977759b`
- Contract id: `ltc-testnet-epoch-1-1777140673550`
- Route: `roll`
- Funding txid: `2edb992eade4f6fa7c3f9849a7f4390e839522f9b07d7b4e08ee33550a4eb2fe`
- Statement hash: `045028ff4ac49296e4fe93fcf39ec4d5e7af87d5208f3b41a0916c1487340866`
- Transcript core hash: `0fb2eebc4acac9c1e327b6e5735189cff7fb06f6be973aa833e1c76423563461`

## Transcript Multiplicity
- Thesis: Reuse FindAndDelete-style alias classes for controlled retry families, and treat SIGHASH_SINGLE constant-one collapse as a red-flag detector only.
- Variants: `7`
- Unique transcript ids: `5`
- Hazard variants: `2`
- Primary branch split: `fd_repeat_aabb`
- Retry alias pair: `fd_repeat_aa, fd_repeat_aaaa`
- canonical_control: `1a7f8a6bba27502d472a2e4639fc04adc03af4062fbec315b4a77578ee582ce4` via canonical/baseline (low)
- fd_repeat_aa: `37ef599b0dae68f7506b8babb97c617dc7ce2db7939792a546c763691d7ba257` via findanddelete/aa (medium)
- fd_repeat_aaaa: `37ef599b0dae68f7506b8babb97c617dc7ce2db7939792a546c763691d7ba257` via findanddelete/aaaa (medium)
- fd_repeat_aabb: `10f62eeed75ac05f9aebbac04ed0b572f94a3bf5781d1cb87caf03cc0c2ebada` via findanddelete/aabb (low)
- single_control_00: `6c1929f4590c269195fcd5ad3a8d1e2a17b14567b1e50dd0eaf5bb2ff38f6d56` via sighash_single/control-input0-output0 (low)
- single_bug_oob_a: `0000000000000000000000000000000000000000000000000000000000000001` via sighash_single/bug-out-of-range-a (high)
- single_bug_oob_b: `0000000000000000000000000000000000000000000000000000000000000001` via sighash_single/bug-out-of-range-b (high)

## Identifier Bifurcation
- Thesis: Treat txid-like identifiers as a search envelope around a stable settlement core, so overlay protocols can rotate anchors without rewriting the economic claim.
- Variants: `4`
- Unique projected anchors: `4`
- Primary projected anchor: `anchor_retry_window`
- anchor_primary: `6da39ec564c73ab90ad8ebc4c5662553acbc168cd3e27c7dbc78fbdc8c674e3b` for BitVM next-contract handoff id
- anchor_retry_window: `f18a103229826e0d16112bcaef25d24a0cb0f9828b75714ca6dd6b6a585ea90b` for mempool retry / rebroadcast lane
- anchor_parallel_shadow: `b6636bd85ccf00b0a86fa3439d4297e3db33a7f98bcf638d5709d43a17989f3a` for wallet and observer mirror index
- anchor_oracle_mirror: `dab1a769c0aee7c8508ddc54d47b1328b67d8d8fd272d06fd18c44698d06a9f0` for OP_RETURN / DLC oracle sidecar mirror

## Recommendations
- Promote fd_repeat_aabb as the primary branch-splitting transcript and reserve fd_repeat_aa/fd_repeat_aaaa for retry-equivalent sessions.
- Reject any candidate transcript whose digest collapses to 0000000000000000000000000000000000000000000000000000000000000001.
- Use anchor_retry_window as the first txid-like bifurcation lane because it preserves the transcript core while giving a separate external anchor id.

## Source Artifacts
- challengeBundle: `m1_challenge_bundle_latest.json` (m1_challenge_bundle, ff8e8cbb81c6d89b2b762fa8fac96c974f66dff0396c4830b0eb65f4810f760c)
- challengeWitness: `m1_challenge_witness_latest.json` (m1_challenge_witness, 9c3f5bb678fcfcecc1da7d9788b0b1325bf7a0de8939d82395484880b0259450)
- proceduralSync: `bitvm_procedural_sync_latest.json` (bitvm_procedural_sync, 24218a48fa20315c75cf0f6704208f7e2bb263161fff3e4424deed994b100f85)
- parallelUtxoIndex: `m1_parallel_utxo_index_latest.json` (m1_parallel_utxo_index, 1579f5e711363fceaaa66a208d7c7c412815e3b42fbc1c104336a9fe90c0a079)