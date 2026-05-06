# Wallet Integration Manifest

## Status

- Manifest id: `8bb7d5e3a6945f653f946b39b75a0f9315b26fef5d657385d9051907e0d9e5cd`
- Verification: ok
- Wallet status: verified
- Inbound liquidity: 49000 sats
- Channel/splice outpoint: `fd3e97d30b39c04dea7748cd5a7e8b057bf9e0f7656a6be7d9733c413828be43:0`
- Payment hash: `79cdbfa62ea28e4177514f55ae3f5d6e7dbdd780254a6aeff6428270cd5d1d3f`

## LDK Server Target

- Target repo: lightningdevkit/ldk-server
- Mode: sidecar first, then native gRPC service
- Proto: `integrations/ldk-server/liquidity_lease.proto`
- Methods: QuoteLiquidityLease, GetLiquidityLease, VerifyLiquidityLease, PrepareLiquidityLeaseChallenge

## ZEUS Target

- Target repo: ZeusLN/zeus
- Mode: React Native screen consuming sidecar REST API
- Screen: `integrations/zeus/LiquidityLeaseScreen.tsx`
- Client: `integrations/zeus/liquidityLeaseClient.ts`

## Sidecar

Run:

```bash
node integrations/lightning-liquidity-lease-sidecar/server.js
```

Then open:

```text
http://127.0.0.1:8787/v1/liquidity-lease/wallet-view
```
