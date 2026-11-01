# Stage 1 V2 adapter, partial

`v2_adapter.cjs` performs a fail-closed **off-chain** preflight using the existing
`verifyUtxoRefSettlementV2` implementation, then checks an explicitly pinned
assertion outpoint and derives the settlement TXID from the canonical
non-witness transaction bytes. It emits V0 statement bytes and two public
input limbs. All returned inspections explicitly deny proof verification and
settlement authorization.

Only externally configured keys, network, genesis, current height and proof
artifact hashes should be supplied as policy. The object is not a
self-authenticating trust policy; callers must pin it out of band.

The V2 referee currently validates a settlement transaction whose inputs
equal its configured funding outpoints. This adapter additionally requires
the assertion outpoint to occur among those inputs. A general L2 batch
funding-to-assertion-to-settlement graph requires an explicit reconciliation
of these input models before this adapter can accept it.

The adapter's current tests cover malformed policy and rejected V2 cases.
**There is no positive end-to-end fixture in this change.** Full Stage 1
relation parity, a constrained circuit, Groth16 verification, graph
enforcement and funded tests remain open.

Run:

```sh
node --test zk-groth16-bitvm/statement.test.cjs zk-groth16-bitvm/v2_adapter.test.cjs
```
