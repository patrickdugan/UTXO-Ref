# Litecoin Mainnet Ship Plan

Target order:
1. Litecoin mainnet launch for deposit and withdrawal rails
2. Bitcoin support on the same referee architecture after Litecoin mainnet is operational

## Shipping Objective

Ship TradeLayer with Bitcoin-style UTXO deposit and withdrawal guarantees on Litecoin mainnet first:
- deterministic deposit crediting from confirmed Litecoin UTXOs
- deterministic withdrawal epochs committed as payout roots
- referee verification on sweep correctness before operator acceptance and broadcast

BitVM remains the dispute-hardening path, not the blocker for the first mainnet launch.

## Phase 1: Chain Abstraction

Goal: remove the current Litecoin-testnet hard-coding without forking the referee flow.

Deliverables:
- shared chain config/env adapter for Litecoin mainnet, Litecoin testnet, and Bitcoin profiles
- chain-specific template selection instead of fixed `dlc-receipt-ltc-testnet-v1`
- live workflow scripts read `BITVM_CHAIN` and generic RPC env vars with legacy LTC env compatibility

Files:
- `m1_chain_env.js`
- `m1_spec.js`
- `m1_dlc_bootstrap.js`
- `m1_dlc_psbt_cet.js`
- `m1_dlc_sign_finalize.js`

## Phase 2: Litecoin Mainnet Deposit Rail

Goal: deterministic 1:1 receipt minting from real Litecoin deposits.

Deliverables:
- deposit indexer for watched UTXOs
- configurable confirmation threshold for crediting
- reorg-safe deposit status model: observed, confirmed, credited, rolled_back
- receipt-ledger event ingestion from indexed chain events

Files:
- `m1_receipt_ledger.js`
- `m1_tally_map.js`
- new deposit indexer module and tests

## Phase 3: Litecoin Mainnet Withdrawal Epochs

Goal: turn finalized TradeLayer balances into referee-verifiable Litecoin sweeps.

Deliverables:
- deterministic epoch finalizer producing `epochId`, `withdrawalRoot`, `capSats`, `residualDest`
- raw transaction adapter for actual Litecoin sweep transactions instead of hand-built objects
- operator workflow for commit, verify, PSBT assembly, finalize, and broadcast

Files:
- `TLInt.md`
- `verify.js`
- new raw transaction adapter module
- `m1_validate_latest_settlement.js`

## Phase 4: Operational Hardening

Goal: make Litecoin mainnet safe to run continuously.

Deliverables:
- dust and fee policy normalization
- spend-status and double-spend handling
- stale-artifact detection across deposit, funding, witness, and sweep stages
- replayable operational summaries for wallet/runtime integration

Files:
- `m1_pipeline.js`
- `m1_procedural_sync.js`
- artifact validators and tests

## Phase 5: BitVM Upgrade Path

Goal: add challenge packaging after the withdrawal rail already works.

Deliverables:
- witness generation from committed sweep data
- challenge protocol packaging around the referee circuit
- parity tests between off-chain verification and challenge inputs

Files:
- `circuit.js`
- `m1_transition_circuit.js`
- witness-generation modules

## Immediate Execution Order

1. Land chain abstraction with Litecoin-mainnet support and legacy compatibility.
2. Move the bootstrap, funding PSBT, and finalize scripts to the shared adapter.
3. Add tests for chain profile resolution and chain-specific template generation.
4. Start the deposit indexer so receipt minting can be backed by observed Litecoin mainnet UTXOs.
