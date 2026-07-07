# BetweenBits UTXORef Adapter Prototype

This subfolder prototypes a BetweenBits-facing adapter for getting a Taproot USD
wallet asset into an institutional wallet surface. The asset is backed by
UTXORef BTC reserve-vault evidence and TradeLayer derivative/auto-roll state.
It is intentionally read-only for production value: guardian signing is
represented as a policy decision artifact, not as a live signer.

## Fit

The intended integration point is BetweenBits' institutional stack:

- BitCert / PoR receives `betweenbits_utxoref_asset_attestation_v1` as an
  asset-side reserve input.
- API Gateway exposes beta-gate and reserve status to client institutions.
- Policy Engine calls the watchtower proposal evaluator before any custody or
  MPC signing layer is asked to sign.
- Transaction Engine only receives transactions whose exact output hash passed
  policy.

For the wallet, the prototype emits `betweenbits_taproot_usd_wallet_asset_v1`.
That object is the product descriptor a BetweenBits wallet surface can render as
Taproot USD while binding it back to the BTC reserve outpoint, tx30 relay hash,
and TradeLayer rBTC/USD auto-roll state.

## Commands

From the repo root:

```powershell
node integrations\betweenbits-utxoref-adapter\test.js
node integrations\betweenbits-utxoref-adapter\cli.js status
node integrations\betweenbits-utxoref-adapter\cli.js attest --institution-id=demo-bank --amount-sats=20000
node integrations\betweenbits-utxoref-adapter\cli.js wallet-asset
node integrations\betweenbits-utxoref-adapter\server.js --port=8787
```

Then query:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/beta-gate
Invoke-RestMethod http://127.0.0.1:8787/v1/reserve-vaults/latest
Invoke-RestMethod http://127.0.0.1:8787/v1/wallet-assets/taproot-usd
```

## Prototype API

- `GET /health`
- `GET /v1/beta-gate`
- `GET /v1/reserve-vaults/latest`
- `GET /v1/wallet-assets/taproot-usd`
- `POST /v1/bitcert/asset-attestations`
- `POST /v1/watchtower/spend-proposals/evaluate`

Example spend evaluation:

```json
{
  "proposal": {
    "vaultId": "demo-vault",
    "amountSats": "1000",
    "feeSats": "150",
    "outputs": [{ "address": "tb1qallowed", "sats": 1000 }],
    "unsignedTxHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  },
  "policy": {
    "allowTestnet": true,
    "maxFeeSats": "500",
    "maxPerContractSats": "20000",
    "allowedAddresses": ["tb1qallowed"]
  }
}
```

## Safety Rule

`realMoneyAllowed` is never inferred by this adapter. It is copied from the
signed/hash-checked UTXORef beta package. If the package says `false`, the
adapter returns `BLOCK_PRODUCTION_VALUE` and only allows explicitly testnet
policy evaluation.
