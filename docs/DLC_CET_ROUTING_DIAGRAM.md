# DLC → CET → BitVM Vault Routing (current repo state)

Grounded in the actual modules in `bitvm3/utxo_referee/`, not an idealized
design. Evidence tiers per `CLAIMS_MATRIX.md` apply per-node (oracle
attestation + CET selection + fee/queue math = LOCAL_SIMULATION/unit-tested;
funding/CSV-refund/BitVM disprove legs = NETWORK_VERIFIED self-play on
LTCTEST; independent-challenger operation = NOT_IMPLEMENTED, see
`SECURITY_BLOCKERS.md` #3/#5).

Split into four diagrams (the single combined graph got too dense to read;
kept as `docs/diagrams/dlc_cet_full_reference.svg`/`.png` for anyone who
wants it all on one page).

Each diagram below is available as both `.svg` (vector, best for print/zoom)
and `.png` (raster, 3x scale — use this for Google Docs: Insert > Image >
Upload from computer, since Docs doesn't reliably import SVG).

## On the "n% loss increment" question

The percentage granularity **does** exist, but it's continuous math done
once per contract, not a ladder of discrete per-percentage CETs:
`computeBoundedSettlementAmounts()` (`m1_transition.js`) computes
`effectivePnlBps = min(bucketCapBps, realizedPnlBps)` — an oracle-reported
PnL in basis points, capped at a bucket — and scales the payout by that
single value. `buildDlcSettlementOutcomes()`
(`tradelayer_dlc_cet_oracle_selection.js`) then wraps that **one** computed
payout magnitude into three CET branches, and the oracle attestation only
picks a *direction* (`settle-gain` → alice, `settle-loss` → bob, `roll` →
carry forward) rather than selecting among many pre-built percentage-bucket
CETs. The residual/change output (`refundSats` / `rolloverCollateralSats`)
is exactly the mechanism you're recalling: it's what "banks" whatever the
bps math didn't pay out, back into the vault, instead of needing a discrete
CET per possible outcome value. Diagram 2 below shows this precisely.

---

## 1. High-level overview

![overview](diagrams/dlc_cet_00_overview.svg)

```mermaid
flowchart LR
    classDef oracle fill:#ede9fe,stroke:#7c3aed,color:#3b0764,stroke-width:1.5px;
    classDef dlc fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:1.5px;
    classDef bitvm fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:1.5px;
    classDef out fill:#e0e7ff,stroke:#4f46e5,color:#312e81,stroke-width:1.5px;

    ORACLE["ORACLE LAYER<br/>Ed25519 attestation selects outcomeId<br/>(or stays silent -> timeout)"]:::oracle
    DLC["DLC / CET LAYER<br/>2-of-2 MuSig2 Taproot funding<br/>continuous bps settlement math<br/>ternary split: payout / fee / change"]:::dlc
    BITVM["BITVM VAULT LAYER<br/>indexed withdrawal queue + reserve recon<br/>bonded solvency circuit, disprove/dispute<br/>watchtower + trace-publication SLA"]:::bitvm
    WIN["Indexed set of winners<br/>Merkle-proof-verified, admissible<br/>against the bonded vault"]:::out

    ORACLE -->|"attests outcomeId"| DLC
    ORACLE -.->|"no attestation -> CSV timeout"| DLC
    DLC -->|"payout + fee + change outputs"| BITVM
    BITVM -->|"admission gate"| WIN
```

## 2. Oracle layer

![oracle](diagrams/dlc_cet_01_oracle.svg)

```mermaid
flowchart TD
    classDef oracle fill:#ede9fe,stroke:#7c3aed,color:#3b0764,stroke-width:1.5px;
    classDef dlc fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:1.5px;
    classDef note fill:#f3f4f6,stroke:#9ca3af,color:#111827,stroke-width:1px;

    OUT["OUTCOME_IDS = settle-gain | settle-loss | roll<br/>(ternary directional choice, not a per-% CET ladder)"]:::note
    MSG["attestationMessage()<br/>contractId + fundingTxid:vout + outcomeId<br/><i>tradelayer_dlc_cet_oracle_selection.js</i>"]:::oracle
    SIGN["buildDlcOracleAttestation()<br/>Ed25519 sign(message)"]:::oracle
    VERIFY["verifyDlcOracleAttestation()<br/>checks: kind, outcomeId in OUTCOME_IDS,<br/>message recompute, Ed25519 signature"]:::oracle
    BIND["selectCetForAttestation()<br/>bind contractId + fundingTxid + fundingVout,<br/>return the matching CET output map"]:::dlc

    OUT --> MSG --> SIGN --> VERIFY --> BIND

    SILENT["oracle never attests"]:::note
    REFUND["CSV refund CET<br/>24h / 576-block timeout, no MuSig2, no adaptor sig<br/><i>tradelayer_dlc_refund_cet_demo.js</i>"]:::dlc
    SILENT -.-> REFUND
```

## 3. DLC settlement math (where the % increment actually lives)

![settlement math](diagrams/dlc_cet_02_settlement_math.svg)

```mermaid
flowchart TD
    classDef fund fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:1.5px;
    classDef math fill:#ccfbf1,stroke:#0d9488,color:#134e4a,stroke-width:1.5px;
    classDef split fill:#ffedd5,stroke:#ea580c,color:#7c2d12,stroke-width:1.5px;

    FUND["2-of-2 Taproot funding<br/>+ adaptor pre-signatures"]:::fund
    IN["collateral, bucket cap %,<br/>realized PnL %, fee %"]:::fund
    EFF["effective % = min(bucket cap %, realized PnL %)"]:::math
    PAYOUT["payout = collateral x effective %"]:::math
    FEE["fee = collateral x fee %"]:::math
    CHANGE["change = collateral - payout - fee"]:::math

    FUND --> IN --> EFF
    EFF --> PAYOUT
    IN --> FEE
    PAYOUT --> CHANGE
    FEE --> CHANGE

    GAIN["settle-gain: payout -> alice"]:::split
    LOSS["settle-loss: payout -> bob"]:::split
    ROLL["roll: change -> residual,<br/>payout carried forward"]:::split

    PAYOUT --> GAIN
    PAYOUT --> LOSS
    CHANGE --> ROLL
```

*(Node text is simplified for readability; the exact fields are
`bucketCapBps`/`realizedPnlBps`/`feeBps` as basis points, computed by
`computeBoundedSettlementAmounts()` in `m1_transition.js` and wrapped into
CETs by `buildDlcSettlementOutcomes()` in
`tradelayer_dlc_cet_oracle_selection.js`. The "% increment" is this
continuous `effectivePnlBps` value, computed once per contract — not a
discrete CET per percentage bucket; the `change` output is what absorbs
whatever the single payout calculation didn't pay out.)*

## 4. BitVM vault routing (fees, change, indexed winners)

![bitvm vault](diagrams/dlc_cet_03_bitvm_vault.svg)

```mermaid
flowchart TD
    classDef split fill:#ffedd5,stroke:#ea580c,color:#7c2d12,stroke-width:1.5px;
    classDef queue fill:#fef9c3,stroke:#ca8a04,color:#713f12,stroke-width:1.5px;
    classDef vault fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-width:1.5px;
    classDef gate fill:#e0e7ff,stroke:#4f46e5,color:#312e81,stroke-width:1.5px;
    classDef watch fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:1.5px;

    IN["CET outputs: payout / fee / change<br/>(alice, bob, residual, operator)"]:::split

    WQ["Indexed withdrawal queue<br/>-> Merkle withdrawalRoot"]:::queue
    RR["Reserve reconciliation:<br/>cap &lt;= reserve, freshness window"]:::queue

    IN -->|"payout outputs"| WQ
    IN -->|"fee + change outputs"| RR

    STK["BitVM stack bundle<br/>(binds reserve + withdrawal root)"]:::vault
    CIRC["Solvency circuit + disprove leaves<br/>bound to the real reconciliation"]:::vault
    DISPUTE["CSV dispute timeout tree<br/>operator reclaims bond if unchallenged"]:::vault

    WQ --> STK
    RR --> STK
    STK --> CIRC
    STK --> DISPUTE

    QIR["Route admission gate<br/>(bound to withdrawal root + reserve + payout vector)"]:::gate
    STK --> QIR

    WD["Watchtower daemon<br/>re-derives solvency/freshness every tick"]:::watch
    TP["Trace publication SLA check"]:::watch
    STK --> WD --> TP

    TP -.->|"fault: trace withheld"| CIRC
    WD -.->|"alert: insolvent/stale"| DISPUTE

    QIR --> WIN["Indexed set of winners"]:::gate
```

*(Simplified for readability — the underlying modules are
`tradelayer_withdrawal_queue_referee.js`, `tradelayer_reserve_reconciliation_referee.js`,
`tradelayer_bitvm_stack.js`, `tradelayer_bitvm_comparator.js` +
`tradelayer_bitvm_circuit.js` + `tradelayer_bitvm_solvency_referee.js` (folded
into "solvency circuit + disprove leaves"), `tradelayer_bitvm_dispute.js`,
the quirk-indexed route referee, `tradelayer_watchtower_daemon.js`, and
`tradelayer_trace_publication.js`. Per-outcome payout/fee/change breakdown
lives in diagram 3.)*

## Self-play caveat

Every BitVM disprove/timeout/watchtower-fault edge in diagram 4 has only
been exercised with the operator also acting as challenger. See
`SECURITY_BLOCKERS.md` #3 and #5.
