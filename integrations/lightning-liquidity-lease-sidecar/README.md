# Lightning DLC Funding Sidecar

This sidecar exposes the wallet-facing flow for funding a UTXORef DLC/BitVM template from Lightning, then producing a TradeLayer tlBTC mint intent.

## Local Ports

- Sidecar: `http://127.0.0.1:8787`
- TradeLayer listener: `http://127.0.0.1:3000`
- WebRTC RPC route, when running: `http://127.0.0.1:18878/rpc/route`

## Authentication

Every `POST` route requires `Authorization: Bearer <token>`, where the token is the single line in the file named by `SIDECAR_API_TOKEN_FILE`. The sidecar refuses to start if that file is readable by group or others (use mode 0600). With no token file configured, every `POST` is refused. Bodies must be `application/json` and at most 16 KiB.

## LND REST Environment

The pay endpoint uses LND REST and reads credentials from environment variables:

```powershell
$env:LND_REST_URL = "https://127.0.0.1:8080"
$env:LND_MACAROON_PATH = "C:\path\to\admin.macaroon"
$env:LND_TLS_CERT_PATH = "C:\path\to\tls.cert"
```

For local throwaway testing with a trusted node, `LND_REST_INSECURE=1` disables TLS verification.

## Endpoint Flow

1. `POST /v1/dlc-subswap-funding/quote`

   Returns a DLC submarine-swap request and wallet view. For live testnet payment, pass the swap provider invoice and hash:

   ```json
   {
     "walletNodeId": "electrum-tradelayer",
     "requestedCollateralSats": "49000",
     "swapFeeSats": "1000",
     "refundBlocks": 6,
     "invoice": "lntb...",
     "paymentHashHex": "..."
   }
   ```

2. `POST /v1/dlc-subswap-funding/pay`

   Body: `{"requestId": "..."}`. Pays the invoice of a request this process quoted, via LND REST, and returns the payment preimage proof. Each quoted request can be paid once; the fee limit comes from `UTXOREF_LND_MAX_FEE_SATS` or the quoted swap fee.

3. `POST /v1/dlc-subswap-funding/tlbtc-mint-intent`

   Body: `{"requestId": "...", "recipientAddress": "..."}`. Only a request paid through step 2 yields a mint intent. The grant's `fromAddress` comes from `TL_PROCEDURAL_ADMIN_ADDRESS`, and the DLC state from the `TL_DLC_*` environment. The intent is a TradeLayer call descriptor:

   ```json
   {
     "method": "tl_createGrantManagedTokenTransaction",
     "params": {
       "propertyId": 1,
       "amountGranted": "0.00049000"
     }
   }
   ```

4. Electrum TradeLayer tab

   The tab calls quote, pay, verify, and mint-intent in order, then forwards the mint intent to the configured TradeLayer RPC endpoint or WebRTC gossip route.

