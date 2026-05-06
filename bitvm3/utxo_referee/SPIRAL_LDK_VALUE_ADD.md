# Spiral / LDK Value-Add Plan

This plan turns the Lightning integration prototype into a contribution that
matches active public LDK work: external funding, LSP flows, node/server
packaging, VSS recovery, and repeatable test harnesses.

## Run

```bash
node bitvm3/utxo_referee/spiral_ldk_value_add_demo.js
```

Outputs:

- `bitvm3/utxo_referee/artifacts/spiral_ldk_value_add_latest.json`
- `bitvm3/utxo_referee/artifacts/spiral_ldk_value_add_latest.md`

If `artifacts/cln_regtest_demo_latest.json` exists, the demo binds the latest
live CLN regtest payment preimage into the LDK-shaped receipt adapter.

## Pitch

The useful Spiral-facing contribution is not "production BitVM inside LDK."
It is a small, reviewable bridge:

```text
LSPS quote -> Lightning receipt -> FundingBuilder-style contribution
          -> contract funding output -> VSS recovery record
```

That creates reusable test vectors for wallets and LSPs that need to reason
about externally funded contract opens without adding consensus changes or
production contract semantics to LDK.

## Review Surfaces

- `rust-lightning::ln::funding::FundingBuilder`
- rust-lightning splicing tests
- `ldk-node` payment and resolution APIs
- `ldk-server` OpenChannel/gRPC API
- `vss-client` / `vss-server` recovery records
- Rapid Gossip Sync harness metrics and failure-mode tests
