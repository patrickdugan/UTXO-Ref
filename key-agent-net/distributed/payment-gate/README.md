# KeyAgentNet payment gate

Custodian A signs a payment-gated request only after this check accepts the proof the request carries. The proof shows that a Bitcoin payment to a script the coordinator registered has confirmed with enough confirmations, under a chain proven from genesis.

The proof is a final proof of the nova-bitvm3 **M16** guest ([garbled-snark-verifier `nova-bitvm3/m16`](https://github.com/patrickdugan/garbled-snark-verifier/tree/d4aefcdf714874d23b6a5bbfb64616cc27dcdb32/nova-bitvm3/m16)). That guest verifies a Nova proof of the header chain from genesis, then checks an SPV payment under its tip. Its SP1 proof is wrapped under BLAKE3 (`m13`), and this crate checks it with `m13-verify` as a library. The gate never runs Nova itself.

## What it checks, in order

Every failure is a refusal with its own reason code. The signer returns that code.

1. **Final proof** (`src/proof.rs`), in `m13_verify::verify_final`'s order:
   - the wrap key equals the pinned key (`proof_wrap_key`);
   - the BLAKE3 STARK verifies (`proof_rejected`);
   - the exit code is 0 (`proof_exit_code`) and the proof is complete (`proof_incomplete`);
   - the guest program is M16 (`proof_wrong_program`);
   - SP1's recursion key map is the pinned one (`proof_recursion_root`);
   - the proof commits to exactly the statement bytes supplied (`statement_digest_mismatch`).

   The proof commits only the statement's SHA-256, so the request carries the 1,292 statement bytes beside the proof. A proof over 2 MiB is refused as `proof_too_large`; one that fails to decode is `proof_malformed`.
2. **Statement** (`src/statement.rs`): guest A's 1,164-byte chain record plus the 128-byte `PAY1` record, at fixed offsets. Refusals:
   - a chain record with no payment: `no_payment_record`;
   - any other length: `statement_length`;
   - bad payment magic: `payment_record_magic`;
   - non-canonical heights or hash halves: `statement_state_encoding`;
   - a block height and confirmation count that disagree with the tip: `statement_inconsistent`.
3. **Policy** (`src/policy.rs`):
   - **network magic** (`wrong_network`) and **fold width** k = 1 (`wrong_fold_width`);
   - **genesis**: SHA-256 of z0 equals the pin, *and* z0 decodes to height 0 and the network's genesis hash (`wrong_genesis`);
   - **Nova key** (`wrong_nova_key`);
   - **chainwork floor**: the tip's chainwork is at least `min_tip_chainwork` (`chainwork_below_floor`);
   - **confirmations** at least `min_confirmations` (`too_few_confirmations`);
   - **registered script**: the output's script SHA-256 is registered (`script_not_registered`) and the value meets that script's minimum (`value_below_policy`).

The signer (`../signer/kan_policy.py`) adds one rule: each proven payment outpoint releases at most one request (`payment_already_used`). It records outpoints in its fsync'ed journal, so the rule survives restarts.

**The chainwork floor is required.** The proof shows *a* valid proof-of-work chain from genesis, not the heaviest one. Anyone can extend a low-difficulty fork from an early block and give a fake payment any number of confirmations. Set the floor from a chain observation the custodian trusts, such as Bitcoin Core's `chainwork` at a recent block.

## Policy

The signer policy carries the gate's policy as `payment_gate`:

```json
{
  "network": "mainnet",
  "min_confirmations": 6,
  "min_tip_chainwork": "<Core chainwork hex>",
  "scripts": [{"id": "deposit-1", "script_sha256": "<sha256 of scriptPubKey>", "min_value_sats": 100000}],
  "pins": {"wrap_vk_sha256": "…", "recursion_vk_root": "…", "program_vk_digest": "…", "nova_vk_sha256": "…", "genesis_z0_sha256": "…"}
}
```

A gated signer refuses a request without `payment_proof: {proof_b64, statement_hex}` (`payment_proof_required`). An ungated signer refuses a request that carries one (`malformed`).

## Pins (`pins.json`)

| Pin | Value | Source |
| --- | --- | --- |
| wrap key | `d42c63e3…b0d7` | `m13/pins.json`, the same for every guest |
| recursion key map | `7487c217…f257` | `m13/pins.json` |
| M16 program key | `dfc68a5d…cb60` | `tools/program-key` (SP1 6.9.0 setup, digest as nb3-prove computes it) on the M16 ELF `bb7d51b0…`. On guest A's ELF `2db52978…` and control C's `2d49248d…`, the same tool gives their pinned `5df3760f…` and `4686663f…`. |
| Nova key, mainnet | `6aa50d09…da1d` | the M16 guest's own pin (compressed encoding) |
| Nova key, testnet4 | `6894f490…c12a` | the same |
| genesis z0, mainnet | `b6eeaf96…f045` | z0 of the block-170 statement; it decodes to height 0, hash `000000000019d6…`, chainwork `0x100010001` |
| genesis z0, testnet4 | `9c82dffe…de9c` | z0 of m12's testnet4 bundle, the consensus genesis state |

## Fixtures

| File | SHA-256 | What |
| --- | --- | --- |
| `m16-block170-statement.bin` | `67a9deb9…5c71` | The statement the M16 guest committed when executed on the block-170 test inputs: headers 0–800 in two segments, and block 170's 10 BTC output with 631 confirmations. It was executed, not proved. |
| `guest-a-wrap-blake3-v2.bin` | `79c4af11…daad` | Guest A's final proof (m13 fixture): testnet4 heights 0–4, a chain record only. It is a real proof of another program. |
| `m16-wrap-blake3-v2.bin` | `97871e86…26e3` | M16's final proof on mainnet (m13 fixture, 2026-11-11): the Nova header chain from genesis to 975,072 and a payment in block 975,067, proved on GPU, then `m13 shrink-wrap` and `wrap-only-v2`. Program key `dfc68a5d…cb60`, the pin. The same file is in zk-rusto-no-bitcoino `c85ee60` at `integrations/bitvm3-nova/m13/fixtures/`. |
| `m16-statement.bin` | `cae6068f…c869` | The 1,292 statement bytes that proof commits (the guest's public values, `public.bin` of the M16 mainnet execute). |
| `m16-payment.json` | | Names the two files above and the policy values that accept the payment. |

`m16-payment.json`:

```json
{"proof": "m16-wrap-blake3-v2.bin", "statement": "m16-statement.bin", "network": "mainnet",
 "outpoint": "a652ab0cf381413ae854a86bb7e4784811b2d4158a65f26ff64a69eb3eb20045:0", "confirmations": 6,
 "script_sha256": "58432f41…7283", "min_value_sats": 940000,
 "min_tip_chainwork": "000000000000000000000000000000000000000156c4c3c54ad473bac5daf261"}
```

The statement:
- starts at the mainnet genesis state (z0 `b6eeaf96…`) and ends at 975,072 (`…6ff792`);
- pays 940,000 sats to output 0 of `a652ab0c…0045`, a 22-byte P2WPKH script, in block 975,067 (`…55fe22`), which has 6 confirmations.

Each policy value is the tightest that accepts:
- the chainwork floor is Bitcoin Core 31.1's `chainwork` at 975,072, from `fetch_mainnet.py`'s `core_ref.tsv`;
- the minimum value is the payment's value;
- `confirmations` is the statement's count, which the run's policy requires.

The tests check that one more confirmation, one more unit of chainwork or one more sat is refused.

## Build and test

```sh
cargo test --no-default-features      # statement and policy: seconds, no SP1 dependencies
cargo test --release                  # adds the proof layer on the real M16 and guest A proofs
cargo build --release                 # target/release/kan-payment-gate
kan-payment-gate check --proof P --statement S --policy GATE.json
kan-payment-gate inspect --statement S
```

On the signer host, `vps-signer.sh install-gate target/release/kan-payment-gate` installs the binary. `install-policy` then records it in the signer's config.

**Licence:** GPL-3.0-only, because the crate links `m13-verify`, which is GPL-3.0-only. The rest of UTXO-Ref stays MIT; this crate is built separately and the signer runs it as a separate process.
