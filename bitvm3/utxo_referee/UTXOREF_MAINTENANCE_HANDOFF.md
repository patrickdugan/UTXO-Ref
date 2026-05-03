# UTXORef Maintenance Handoff

Date: 2026-05-03

## Current Good Stopping Point

The UTXORef/TradeLayer/BitVM prototype now has a deterministic live-path harness
that can be maintained or live-tested without redesigning the architecture.

Current UTXORef repo commit:

- `beddb2a` - Harden UTXORef live final output review

Related BitVMArena repo commit:

- `2cd6112` - Add TradeLayer stack Arena round two

## What Is Working

- TradeLayer send state oracle extraction from sample consensus/history data.
- DLC-funder registry route resolution.
- UTXORef payout commitment and sweep plan construction.
- RPC sweep preflight module.
- Final decoded transaction output vector hashing.
- Semantic final-output review against planned sweep outputs.
- Final spend binding hash.
- Stack bundle verification.
- Dashboard-ready hashes and artifact summaries.
- Fraud challenge, checkpoint, withdrawal queue, perp PNL, liquidity lease, and
  Arena-security surfaces.

## Main Files

- `tradelayer_utxoref_live_path.js`
- `tradelayer_utxoref_live_path.test.js`
- `tradelayer_utxoref_live_path_demo.js`
- `tradelayer_bitvm_stack.js`
- `tradelayer_bitvm_stack_demo.js`
- `tradelayer_send_rpc_sweep.js`
- `UTXOREF_PRODUCTION_GAP_AND_LIVE_PATH.md`

## Main Artifacts

- `artifacts/utxoref_live_path_latest.json`
- `artifacts/utxoref_live_path_latest.md`
- `artifacts/tradelayer_bitvm_stack_latest.json`
- `artifacts/tradelayer_bitvm_stack_latest.md`

## Verification Commands

Run from `C:\projects\UTXORef\UTXO-Ref`:

```powershell
node bitvm3\utxo_referee\tradelayer_utxoref_live_path.test.js
node bitvm3\utxo_referee\tradelayer_bitvm_stack.test.js
node bitvm3\utxo_referee\tradelayer_send_rpc_sweep.test.js
node -e "const r=require('./bitvm3/utxo_referee'); const e=r.buildTradeLayerUtxoRefLivePathEvidence(); const v=r.verifyTradeLayerUtxoRefLivePathEvidence(e); if(!v.ok) throw new Error(v.reason); console.log(v.evidenceHash)"
```

Regenerate the current deterministic live-path artifact:

```powershell
node bitvm3\utxo_referee\tradelayer_utxoref_live_path_demo.js
```

## Live Testnet Plug-In Points

Use a real decoded final transaction from Core RPC:

```powershell
node bitvm3\utxo_referee\tradelayer_utxoref_live_path_demo.js --final-txid <txid> --rpc-url <url> --rpc-user <user> --rpc-pass <pass>
```

or:

```powershell
node bitvm3\utxo_referee\tradelayer_utxoref_live_path_demo.js --final-hex <hex> --rpc-url <url> --rpc-user <user> --rpc-pass <pass>
```

The next live test should replace:

- sample consensus input with TradeLayer parser output
- deterministic decoded final tx with `decoderawtransaction`
- sample funding outpoint with a real funded DLC/BitVM output
- dashboard txids with explorer-linked testnet txids

## What A Maintenance Model Should Do

1. Keep changes narrow. Do not redesign the UTXORef architecture.
2. If a live tx fails, inspect `finalOutputReview.core.mismatches`.
3. Fix data adapters before changing verifier logic.
4. Never accept a final tx unless both conditions hold:
   - `finalTxOutputHash` matches the decoded transaction
   - `finalOutputReview.ok === true`
5. After any change, run the three verification tests above.
6. Commit only scoped changes; the repo has unrelated dirty files outside this
   handoff path.

## Remaining Real Work

- Wire the live TradeLayer parser output into `--input`.
- Use an actual testnet funding outpoint and final sweep tx.
- Add signer UX that displays route transcript, final output review, and stack
  hash before broadcast.
- Add challenge-path transaction construction, not just challenge evidence.
- Turn the JS predicates into real BitVM/script constraints.

## Do Not Confuse

The current harness is rigorous for deterministic evidence and tamper detection.
It is not yet a production BitVM circuit or a fully live TradeLayer consensus
deployment.
