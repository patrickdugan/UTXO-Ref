# Programmable Lightning ZK Watchtower / ASP Bundle

- Bundle id: `92ecd80d8f10764833d16df5c0eee90fe381214bd96c9fe2f9d241f90f0f6f6f`
- Payment proof id: `ebb9fc532cd6e5417f272c3e720ba75d94eec9c7864afa8796da170f2e214395`
- Watchtower action: `accept_and_monitor`
- ASP action: `settle_and_release_asp_fee`

## Watchtower

- Program id: `3dc215f204a23b740383e8de7d172001a6eefa1a03d0107323485d6a1bf196d1`
- ZK receipt role: `utxoref_challenge_publication`
- ZK receipt id: `9e8cf05d6d7d58b10265ff065de8b1339415c7cfaf482e597cfe3e657e4e1f39`
- Challengeable: `false`
- Violations: none

## ASP Policy

- Policy id: `2fa422f798da3e6aa60b77040625f684c2cd9a2bcb64fdb501cc41d88d645c0a`
- Settlement receipt id: `9b8f3a7342bf1815c2951aa62b6dc5b03f006160db2c7c8a29d6ca8ddede6eec`
- Forfeit receipt id: `45cf25cad368ae31ce24a9368723a790509b416f0aebe195d8be7afff0477817`
- Slashable: `false`
- Violations: none

## Boundary

The bundle proves a payment-conditioned sidecar state transition. It does not reveal the LN route, and it does not change LN commitment transaction enforcement.
