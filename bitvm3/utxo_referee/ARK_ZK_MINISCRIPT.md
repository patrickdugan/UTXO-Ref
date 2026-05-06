# Ark ZK Miniscript Proof Path

This is the repo-local bridge between UTXORef Ark/DLC manifests and the
`ark-shinigami` Cairo/STWO prover.

The v2 circuit proves a compact Ark Taproot miniscript claim:

- manifest id, Taproot root, selected leaf hash, and settlement hash as full
  32-byte values split into two `u128` Cairo limbs
- selected Taproot branch-path commitment as full 32-byte limbs
- a fixed-depth Cairo path witness with up to three sibling hashes and side bits
- the Cairo arithmetic path fold recomputed from the selected leaf and siblings
- selected Ark role code
- settlement amount and exit delay
- binding commitment recomputed inside Cairo

The five role claims are:

```text
cooperative_round
owner_csv_exit
asp_forfeit_guard
dlc_virtual_cet_settlement
utxoref_challenge_publication
```

## Run

From the UTXORef repo root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\prove_ark_zk_miniscript_snacksack.ps1
```

The script:

1. generates the five-role claim corpus with
   `bitvm3\utxo_referee\ark_zk_miniscript_proof.js`
2. remote-builds the Cairo executable in `ark-shinigami` on `snacksack`
3. proves each role input with STWO on `snacksack`
4. verifies each proof with the Rust verifier
5. writes local receipt artifacts

Use these options for constrained runs:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\prove_ark_zk_miniscript_snacksack.ps1 -SkipProving
powershell -ExecutionPolicy Bypass -File scripts\prove_ark_zk_miniscript_snacksack.ps1 -SkipRemoteBuild
powershell -ExecutionPolicy Bypass -File scripts\prove_ark_zk_miniscript_snacksack.ps1 -RayonThreads 2 -MinRemoteAvailableGb 24
```

## Artifacts

Claim corpus and receipts:

```text
bitvm3\utxo_referee\artifacts\ark_zk_miniscript\ark_zk_miniscript_summary_latest.json
bitvm3\utxo_referee\artifacts\ark_zk_miniscript\ark_zk_miniscript_receipts_latest.json
```

Programmable Lightning watchtower/ASP sidecar receipts consume that summary:

```text
bitvm3\utxo_referee\PROGRAMMABLE_LIGHTNING_ZK.md
bitvm3\utxo_referee\artifacts\lightning_zk_programs\programmable_lightning_zk_latest.json
```

Each role has:

```text
ark_zk_miniscript_<role>.claim.json
ark_zk_miniscript_<role>.manifest.json
ark_zk_miniscript_<role>.input.json
ark_zk_miniscript_<role>.receipt.json
```

Heavy proof files and logs are kept outside the repo:

```text
D:\cargo-target\ark-shinigami\proofs\ark_zk_miniscript_<role>.proof.json
D:\cargo-target\ark-shinigami\logs\ark_zk_miniscript_<role>.log
D:\cargo-target\ark-shinigami\logs\ark_zk_miniscript_<role>.verify.log
```

## Boundary

This is now a manifest-binding plus selected-path-witness proof path. Cairo
checks the selected leaf's fixed-depth branch witness and folds that witness
into the binding commitment alongside the Ark role, amount, delay, and 256-bit
manifest identifiers. It is still not a full in-circuit Bitcoin Taproot or
miniscript semantics proof: the manifest generator defines the deterministic
branch path, while Bitcoin consensus script execution and descriptor compilation
remain outside the Cairo program. The next increment is to replace the
Cairo-friendly path fold with real Taproot tagged-hash inclusion and then move
selected miniscript policy clauses into the circuit.

## Checks

Cheap local checks:

```powershell
node bitvm3\utxo_referee\ark_taproot_miniscript_proof_manifest.test.js
node --check bitvm3\utxo_referee\ark_zk_miniscript_proof.js
node bitvm3\utxo_referee\ark_zk_miniscript_proof.test.js
```

Ark-side build check:

```powershell
Push-Location C:\projects\ark-shinigami
scarb build
Pop-Location
```
