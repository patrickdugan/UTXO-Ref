# Spiral / LDK Value-Add Brief

Created: 2026-04-25T21:23:17.356Z

## Thesis

Make Lightning-paid advanced contract opens look like normal LDK funding, LSP, and recovery plumbing.

## Prototype Adapter

- Adapter id: `e2b34586d749df08fded072f259ce61679a9ef7e67c1509165c57eb7dd6c61d2`
- Target surface: LDK FundingBuilder external contribution
- Contract transcript id: `db4e1d8fbc44bdac33921a9080a2064d3edc4fa4c1f062994f3e3bd381e9d703`
- Funding output commitment: `3329af156c5a58fc62d2964ba2d3524862d9ff61726d2855e42c31016b28ff86`
- Lightning payment hash: `96a63707bb7393eb39c1f2b070b81f28dd359571c9dae54277c009c8af0ea26d`
- VSS key: `contract-open/db4e1d8fbc44bdac33921a9080a2064d3edc4fa4c1f062994f3e3bd381e9d703`
- Verification: ok

## Bound Live CLN Receipt

- Network: regtest
- Channel txid: `2a23e6ea3c963446787077f15ff479bff375a2893b9ed31520bfd628cb55a506`
- Channel amount: 500000 sats
- Invoice amount: 25000msat
- Payment status: complete
- Payment preimage: `7c2f23d21225ad45b1380f48b511dd1427ed64db909e96e51d2585c88f192900`


## Public Commit Evidence

- lightningdevkit/rust-lightning b1c3e29: [Introduce FundingBuilder for splice requests](https://github.com/lightningdevkit/rust-lightning/commit/b1c3e29a257a70dbc273eb7080f35c42e87d6615)
- lightningdevkit/rust-lightning 9f9fe58: [Replace FundingTemplate contribution methods with FundingBuilder](https://github.com/lightningdevkit/rust-lightning/commit/9f9fe58bbefaaf7023980e068230cd79c8626bc9)
- lightningdevkit/rust-lightning 5237c9a: [Use bitreq::Url for LSPS5 webhook URLs](https://github.com/lightningdevkit/rust-lightning/commit/5237c9a9a7441317b4d8e1ee6f096234792d69ce)
- lightningdevkit/ldk-server 9645cb1: [Add OpenChannel::disable_counterparty_reserve](https://github.com/lightningdevkit/ldk-server/commit/9645cb1f02020a41f0541bafded7be82a2a8470d)
- lightningdevkit/vss-server b6d80c7: [Add configurable request body size with 1GB hard limit](https://github.com/lightningdevkit/vss-server/commit/b6d80c74ba1de4238c53eba43a055e0ad94fce41)
- lightningdevkit/rapid-gossip-sync-server b0c2bca: [Fix deadlock with many peers, few threads, and slow postgres writes](https://github.com/lightningdevkit/rapid-gossip-sync-server/commit/b0c2bcaa185211a852250cdb5ba9aada55795497)

## Proposed Milestones

- M1: LDK-shaped funding receipt vectors: Rust/JS vectors binding invoice preimage, FundingBuilder-style contribution, funding output, and contract transcript.
- M2: ldk-node / ldk-server demo surface: CLI/API demo for contract-open quote, invoice payment, receipt verification, and replay.
- M3: VSS recovery record: Persist/reload contract-open receipt and prove the recovered state verifies against the funding transcript.

## Boundary

- Do not ask Spiral to bless production BitVM semantics.
- Present the value as reusable LDK funding, receipt, storage, and test-vector plumbing.
- Keep Litecoin/testnet demos as local harness evidence, not the headline.
