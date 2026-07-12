# UTXORef V2 Security Model

## Status

UTXORef V2 is a Bitcoin testnet4 alpha. It constructs and verifies real
Bitcoin transactions and BIP341/BIP342 script paths, but it is not ready for
mainnet custody.

The current live assertion funding transaction is:

- Funding: [8bd4e076f0666cb3839f5056ef214aa116dd3e1edbd4528605716f55bb66a656](https://mempool.space/testnet4/tx/8bd4e076f0666cb3839f5056ef214aa116dd3e1edbd4528605716f55bb66a656)
- Assertion outpoint: `8bd4e076f0666cb3839f5056ef214aa116dd3e1edbd4528605716f55bb66a656:0`
- Assertion value: `6,000 sats`
- Settlement confirmed in block 143,764: [5a4f837b786369e338e087cf78e1d114d838bf0eadfce5470fe4b84f9b1152d0](https://mempool.space/testnet4/tx/5a4f837b786369e338e087cf78e1d114d838bf0eadfce5470fe4b84f9b1152d0)
- Graph hash: `34dfe4a3d05264fa54cd6d99e9a07ac784c22f3011b7704847337a0543d02eee`
- V2 commitment: `6689dc9a34b3c46aac63a308cba9dd01078dc0485cbce10ad8efb0180ee69bc6`

The previous 20,000-sat reserve vault aged beyond its reserve-freshness
window and was recovered with its operator-plus-guardian script path:

- Recovery: [63f7144661328c06cc1055bd7210cea4e7bc2e8a3bf4c178e0ed4a94c73c08e9](https://mempool.space/testnet4/tx/63f7144661328c06cc1055bd7210cea4e7bc2e8a3bf4c178e0ed4a94c73c08e9)

The funded gate-fraud path was also exercised with an immediate challenger
spend:

- Fraud assertion: [047c46864b5b0b3d634391323ab30e6af63fbd679dc56e2224ae7c93aba1a155](https://mempool.space/testnet4/tx/047c46864b5b0b3d634391323ab30e6af63fbd679dc56e2224ae7c93aba1a155)
- Gate disprove: [5aefff774e67c6b95f9d8ba89437e96dbcf97bdd3bbe44d072479be0b8132750](https://mempool.space/testnet4/tx/5aefff774e67c6b95f9d8ba89437e96dbcf97bdd3bbe44d072479be0b8132750)
- Input-fraud assertion: [12678731dcc0f815dc0545cbc00a1c023df65de62e2d3ddde6c1779178679f05](https://mempool.space/testnet4/tx/12678731dcc0f815dc0545cbc00a1c023df65de62e2d3ddde6c1779178679f05)
- Input-binding disprove: [eef1e750eed567e4ec1e32955af9964433abd92c0a3d381ad7b3c4f77d3d078c](https://mempool.space/testnet4/tx/eef1e750eed567e4ec1e32955af9964433abd92c0a3d381ad7b3c4f77d3d078c)

## Enforced Flow

```text
allowlisted Ed25519 state checkpoint
  -> deterministic PNL rows and net balances
  -> exact indexed payout vector
  -> state/output/fee trace binding
  -> secret-safe BitVM boolean trace
  -> NUMS-keyed Taproot assertion output
       | immediate gate or input disprove -> challenger
       | 6-block exact dual-signed settlement -> PNL winners
       ` 2016-block emergency recovery -> operator
```

The live test profile uses a six-block challenge delay. The library defaults
to 144 blocks. Emergency recovery remains 2,016 blocks.

## What V2 Checks

The state checkpoint must have a valid Ed25519 signature from an explicitly
allowlisted key. Network, genesis hash, snapshot height, and maximum age are
checked before funding authorization.

PNL rows, gross transfer edges, net balances, payout destinations, amounts,
and ordering are recomputed from the signed state. The settlement transaction
must spend the exact assertion outpoint and contain only the exact committed
outputs. Payout request identifiers and funding outpoints must be unique.

Each public BitVM wire reveals one selected preimage. The opposite preimage is
not published. Gate-disprove and input-binding leaves are reconstructed from
the public commitments. An honest trace exposes no valid invalid-row witness.

The Taproot internal key is a deterministic hash-to-curve NUMS point. V2 does
not accept a caller-provided internal key, so there is no known key-path
escape. The script tree also includes an unspendable trace-root commitment
leaf, making state or payout rebinding change the funded P2TR output.

The normal settlement path requires both operator and challenger BIP340
signatures over the exact transaction and can execute only after the challenge
CSV. A separate operator recovery path has the longer CSV.

## Trust Assumptions

The current model has one authoritative state signer. A bad but correctly
signed state is not rejected by Bitcoin.

At least one independently administered challenger must verify the state,
payout vector, trace, template, and exact settlement before the funding
transaction is broadcast. The local test ceremony stores challenger and
operator keys in separate files, but it does not provide administrative
separation. Production must move challenger signing to another host/operator.

If the recorded authorization block is reorganized, the watcher fails closed
for new challenge construction and challenge replacement. It may continue to
monitor a challenge already tracked under the same graph hash; that mode has
observation authority only and cannot create a new spend.

The boolean circuit currently consumes externally verified facts such as
`state_checkpoint_valid` and `payout_vector_exact`. It does not implement
Ed25519 or full TradeLayer consensus in Bitcoin Script. The challenger
pre-signature is therefore part of the authorization boundary, not merely a
monitoring convenience.

The NUMS construction assumes nobody knows the discrete logarithm of the
deterministically derived point.

## Live Commands

Start or attach Bitcoin Core 31.0 to the pruned D-drive testnet4 datadir, then:

```powershell
node bitvm3\utxo_referee\btc_testnet4_utxoref_v2_live.js --status
```

Once the assertion funding output has six confirmations, Core can execute a
policy preflight of the exact pre-signed tapscript settlement. Broadcast it
only if that preflight is allowed:

```powershell
node bitvm3\utxo_referee\btc_testnet4_utxoref_v2_live.js --settle
```

The public live package is
`artifacts/live/btc_testnet4_utxoref_v2_latest.json`. Private state, operator,
challenger, and wire material is stored outside the repository under the local
Bitcoin testnet key-backup directory.

## Remaining Mainnet Blockers

1. Move the challenger to an independently administered process and define a
   reproducible review/signing protocol.
2. Replace the single state signer or formally accept it as the protocol trust
   root; threshold authorization is not implemented.
3. Observe the funded testnet4 BIP125 replacement and exact one-input CPFP
   package through confirmation. Construction, broadcast, dependency checks,
   durable replacement history, wallet-isolated CPFP signing, and watcher
   tracking have all been exercised live.
4. Broaden adversarial package and mempool tests for every path. The forced
   reorg/reconfirmation lifecycle is covered against an isolated real Core
   regtest node; it has not and should not be forced against public testnet4.
5. Expand the circuit from externally verified boolean facts to the exact
   predicates that should be Bitcoin-challengeable.
6. Obtain an independent cryptographic and transaction-graph review before
   assigning real value.

## Main Files

- `utxoref_v2.js`: signed state, canonical commitments, exact settlement
- `bitvm_trace_v2.js`: secret-safe trace and fraud witnesses
- `bitvm_assertion_graph_v2.js`: NUMS Taproot tree and transaction graph
- `btc_testnet4_utxoref_v2_live.js`: staged funding, broadcast, status, settlement
- `recover_btc_testnet4_reserve_vault.js`: old-vault recovery preflight and receipt
- `utxoref_v2_challenge_cpfp.js`: local wallet-owned challenge fee rescue
