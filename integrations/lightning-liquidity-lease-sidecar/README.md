# Lightning DLC Funding Sidecar

This sidecar exposes the wallet-facing flow for funding a UTXORef DLC/BitVM template from Lightning, then producing a TradeLayer tlBTC mint intent.

## Local Ports

- Sidecar: `http://127.0.0.1:8787`
- TradeLayer listener: `http://127.0.0.1:3000`
- WebRTC RPC route, when running: `http://127.0.0.1:18878/rpc/route`

## Authentication

Every `POST` route requires `Authorization: Bearer <token>`, where the token is the single line in the file named by `SIDECAR_API_TOKEN_FILE`. The sidecar refuses to start if that file is readable by group or others (use mode 0600). Windows files have ACLs instead of mode bits, so there the check is skipped: keep the token file under the operator's own profile. With no token file configured, every `POST` is refused. Bodies must be `application/json` and at most 16 KiB.

## LND REST Environment

The pay endpoint uses LND REST and reads credentials from environment variables:

```powershell
$env:LND_REST_URL = "https://127.0.0.1:8080"
$env:LND_MACAROON_PATH = "C:\path\to\admin.macaroon"
$env:LND_TLS_CERT_PATH = "C:\path\to\tls.cert"
```

For local throwaway testing with a trusted node, `LND_REST_INSECURE=1` disables TLS verification.

The macaroon must allow tracking payments (`GET /v2/router/track/{payment_hash}`, the router RPC) as well as sending them. The sidecar treats a request as paid only when LND reports a `SUCCEEDED` payment for the request's payment hash whose preimage hashes to it. It never trusts its own memory of a payment.

Requests are stored in `SIDECAR_REQUEST_STORE_PATH` (default `runtime/dlc-subswap-requests.json`, written mode 0600) and move quoted -> paid -> minted. A quote expires after `SIDECAR_QUOTE_TTL_SECONDS` (default 86400) unless it is paid, and an expired quote can be quoted again. A pay saves the attempt before LND is asked, so an attempted request does not expire: it is dropped only when LND reports its payment failed, and it becomes paid when LND reports the payment settled. `SIDECAR_MAX_QUOTED_REQUESTS` (default 1000) bounds the open requests, quoted or paid; when it is full new quotes get a 503 until live quotes expire. A minted request is appended to `<store path>.minted` with its intent, outside the open table, bounded by `SIDECAR_MAX_MINTED_REQUESTS` (default 100000), and is never quoted or paid again. An attempted request that LND reports unknown is dropped once max(`SIDECAR_QUOTE_TTL_SECONDS`, 1 hour) has passed since its attempt; a quote request looks up at most five attempted requests.

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

   Body: `{"requestId": "...", "recipientAddress": "..."}`. Only a request that LND reports as settled yields a mint intent; a restart does not change that. A request yields one intent: the intent is stored with its minted record, fsynced before it is returned, and a repeat for the same request and recipient gets that stored intent back byte for byte (so a lost response can be retried). Another recipient is refused with 409, because the intent is forwarded to TradeLayer and a second distinct one would be a second grant. The grant's `fromAddress` comes from `TL_PROCEDURAL_ADMIN_ADDRESS`, and the DLC state from the `TL_DLC_*` environment. The intent is a TradeLayer call descriptor:

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

