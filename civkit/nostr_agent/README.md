# CivKit Nostr Agent

This module treats Nostr as the coordination bus for a backend-run marketplace, not as the product itself.

The intended operating model is:
- agents publish and consume canonical Nostr events
- the UI only renders state and forwards user approvals
- curated notary agents, settlement agents, and broadcast agents do the real work

## Scope

- canonical Nostr event serialization and IDs
- Schnorr signing and verification using local secp packages already present in the repo
- managed trade events for offers, notary assignment, settlement decisions, agent tasks, evidence submissions, appeals, and governance attestations
- event reduction into a backend-friendly trade state
- task derivation so an agent runtime can decide what to do next
- durable local event storage and relay cursor persistence
- signer job planning for threshold escrow settlement

## Files

- `events.js`: canonical event IDs, signing, verification
- `workflow.js`: trade-specific event builders and state reduction
- `store.js`: append-only local event store and relay cursor persistence
- `runtime.js`: signer-job planning and operational task derivation
- `demo.js`: end-to-end example
- `test.js`: focused tests

## Design Notes

- Event kinds are app-scoped custom kinds in the `30178` to `30184` range.
- Settlement decision events can carry the exact Taproot/PSBT package produced by `civkit/bitvm_escrow`.
- Those settlement events now also carry the selected authorization mode, signer bitmap, witness plan, and transition commitment binding so agents can coordinate a concrete threshold spend.
- Evidence submission and appeal events let the runtime move a thread into `dispute_open` or `appeal_pending` phases instead of treating disputes as out-of-band.
- The local store is not a production relay client, but it gives the project a durable backend state model instead of an in-memory reducer only.
- This makes Nostr a transport and audit layer for agents rather than forcing people to manually operate raw protocol primitives.
