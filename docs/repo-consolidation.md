# March Repo Consolidation

This repo is the canonical home for the BitVM3 UTXO referee and the DLC-adjacent primitives.
The March work was split across several sibling repos, so this note consolidates the split and marks the seams.

## What lives where

- `C:\projects\UTXORef\UTXO-Ref`
  - BitVM3 referee core in `bitvm3\utxo_referee`
  - DLC adaptor experiments in `DLCAdaptor`
  - local `node-dlc` checkout in this workspace

- `C:\projects\tradelayer.js`
  - Protocol-side tx builders, validation, and DLC/receipt rules
  - BitVM3-oriented tests and settlement harnesses

- `C:\projects\BitAgent\BitAgent\tradelayer-thorchain-starter\tradelayer-thorchain-starter`
  - March THORChain onboarding starter
  - EVM deposit, quote, adapter, and demo scaffolding
  - Repo map and integration log for that flow

- `C:\Users\patri\tradelayer-wallet`
  - Wallet integration work for the BitVM watchtower flow
  - `packages\wallet-fe\src\app\@pages\bitvm-page\bitvm-page.component.ts`
  - `bitvm/watchtower/*` API wiring in `packages\wallet-fe\src\app\@core\apis\main-api.service.ts`
  - Matching backend routes in `packages\wallet-server\src\routes\main.route.ts`

- `C:\projects\CryptoCOO\CryptoCOO`
  - Session notes, repo inventories, and operational docs
  - Not the canonical implementation home for the referee or onboarding code

## Consolidated read

- The infra-heavy March onboarding flow is in the BitAgent starter, not in this repo.
- The referee and DLC proof surface are already here and should remain the source of truth for UTXO-linked settlement logic.
- `tradelayer.js` remains the place to look for protocol message construction and tx validation.
- The wallet-side BitVM watchtower UI belongs to `tradelayer-wallet`, and it is an integration surface rather than referee core.
- `CryptoCOO` mostly holds context, logs, and session material.

## Practical boundary

- Keep referee-specific changes in `bitvm3\utxo_referee`.
- Keep TradeLayer protocol encoding changes in `tradelayer.js`.
- Keep THORChain onboarding scaffolding in the BitAgent starter unless it is explicitly being turned into a shared package.
- Keep BitVM watchtower / wallet UI changes in `tradelayer-wallet`.
- Do not merge the THORChain starter into this repo just because it shares UTXO language; it is a separate integration path.

## Outstanding split

- `UTXO-Ref` does not currently carry the THORChain onboarding starter.
- `UTXO-Ref` does not currently carry the wallet BitVM page or watchtower API layer.
- The BitAgent starter does not replace the referee logic in this repo.
- The overlap between them is conceptual, not yet a shared code package.
