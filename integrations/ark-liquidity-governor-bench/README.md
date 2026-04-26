# Ark Liquidity Governor Throughput Bench

This Rust prototype benchmarks the hot path for asset-agnostic Lightning
liquidity routing:

- Ark VTXOs make liquidity pathing cheap enough for frequent route repair.
- UTXORef/BitVM acts as the governor maze around ASP pathing promises.
- BitVM/DLC settlement stays out of the hot path and only escalates slashable
  batches.

The harness reads the latest Ark liquidity graft artifact, fans it out into many
synthetic route obligations, and compares serial verification with scoped Rust
worker threads.

## Run

From this directory:

```powershell
$env:CARGO_TARGET_DIR='D:\codex-target\ark-liquidity-governor-bench'
cargo run --release -- --obligations 5000 --work-factor 128 --bad-every 0
```

Useful flags:

```text
--workers <n>       Override detected CPU workers
--bad-every <n>     Make every nth obligation slashable
--work-factor <n>   Raise/lower simulated proof/signature verification work
```

The report is written to:

```text
bitvm3/utxo_referee/artifacts/ark_liquidity_governor_bench_latest.json
```

## What Is Verified

Each obligation is asset agnostic: it only cares that liquidity was delivered
within the quoted fee and CLTV bounds. Verification checks:

- Ark VTXO capacity covers promised inbound liquidity
- delivered inbound liquidity meets the quote
- observed fee ppm and CLTV delta are within bounds
- payment preimage hashes to the payment hash
- Ark exit and forfeit paths are present
- UTXORef governor policy digest binds the ASP, template, VTXO, quote, and path
- proof-work digest matches the expected transcript

The proof-work digest is intentionally synthetic. It models parallelizable
signature/proof hashing throughput without pretending this crate performs real
BitVM settlement.

## secp256k1 Throughput

The harness also runs real `rust-secp256k1` / `libsecp256k1` ECDSA signing and
verification for the same obligation count. On the current 12-worker Windows
machine, a warm 5,000-operation run produced:

```text
ECDSA sign serial:    343.110 ms
ECDSA sign parallel:   69.676 ms
ECDSA verify serial:  550.483 ms
ECDSA verify parallel: 93.670 ms
```

That puts raw curve work in the tens to hundreds of milliseconds for 5,000
CET-like messages, not hundreds of milliseconds per CET. If a DLC path takes
minutes, the bottleneck is likely transaction construction, adaptor-signature
protocol flow, serialization, database writes, JS/native boundaries, wallet
round trips, or network chatter.

## Bottleneck Suite

The release harness now profiles the main local suspects independently:

- CET template construction
- oracle outcome fanout
- JSON serialization and parse
- JSONL local persistence
- compact binary transcript serialization, parse, and persistence

On the current run, CET template construction was not the bottleneck. JSON parse
and persistence were materially slower than compact binary transcripts:

```text
JSON parse:          77.116 ms
binary parse:         4.757 ms   16.210x faster

JSONL persistence:   60.655 ms
binary persistence:   2.643 ms   22.953x faster
```

The optimization direction is therefore clear: keep JSON at API and debugging
boundaries, but use fixed-width binary transcripts or a schema format for the
inner CET/governor pipeline.
