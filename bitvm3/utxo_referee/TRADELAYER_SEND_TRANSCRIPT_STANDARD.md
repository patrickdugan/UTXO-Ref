# TradeLayer Send Transcript Standard

Date: 2026-05-03

## Purpose

`tradelayer_send_route_transcript_v1` is the canonical binding between a
TradeLayer token send and the UTXORef movement that settles the matching BTC/LTC
UTXO. It exists because wallet/RPC checks can prove that an input is spendable
without proving that the spend still matches the state oracle, registry, and
BitVM payout root reviewed by the protocol.

## Flow

```text
TradeLayer tx2 send
  -> state oracle blob
  -> DLC-funder registry lookup
  -> send route plan
  -> UTXORef withdrawal root
  -> sweep plan / PSBT / final tx
```

## Required Transcript Fields

- `stateOracleHash`: hash of the selected state-oracle core
- `selectedSendHash`: hash of the exact TradeLayer send record
- `dlcFunderRegistryHash`: hash of the registry used for DLC address mapping
- `routePlanHash`: hash of the resolved send route plan
- `fundingInputHash`: hash of the DLC/UTXORef input outpoint, address, and sats
- `outputPlanHash`: hash of the exact expected sweep outputs
- `withdrawalRootHex`: UTXORef payout Merkle root
- `commitmentHashHex`: UTXORef commitment hash

Optional fields:

- `signedPsbtOutputHash`
- `finalTxOutputHash`

Those optional fields are for later binding the final wallet-signed PSBT or
broadcast transaction back to the same reviewed transcript.

## Enforced Today

The implemented helpers are:

- `buildTradeLayerSendRouteTranscript(routePlan, options)`
- `verifyTradeLayerSendRouteTranscript(transcript, routePlan, options)`

Sweep plans carry `routeTranscriptHash` and the embedded `routeTranscript`.
Wallet flows bind that hash into the flow hash. RPC sweep preflight refuses to
sign when the declared transcript hash, embedded transcript hash, or embedded
transcript core hash do not match.

## Security Rule

For a TradeLayer send route, no cooperative sweep should be signed unless:

```text
routeTranscriptHash == hash(routeTranscript.core)
routeTranscript.core.outputPlanHash == hash(expected sweep outputs)
routeTranscript.core.withdrawalRootHex == UTXORef payout root
routeTranscript.core.stateOracleHash == selected state oracle
routeTranscript.core.selectedSendHash == selected TradeLayer send
routeTranscript.core.dlcFunderRegistryHash == registry used for mapping
```

This is the concrete control that came out of the Arena red-team pass.
