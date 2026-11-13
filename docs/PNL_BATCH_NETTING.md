# Funded derivatives netting and proof batches

Date: 2026-11-13

The follow-up [funded execution adapter](PNL_BATCH_EXECUTION.md) now carries
this relation through a full signed V2 snapshot, an opened persistent ledger,
exact serialized transaction bytes and an isolated Core regtest settlement.
The reference kernel below retains its narrower accounting flags. Production
custody enforcement and a ZK backend remain pending.

## Scope and implementation boundary

This revision gives profit routing a precise acceptance condition: a committed
epoch must produce the correct account entitlements, and a funded allocation
must cover every resulting payout and vault residual. The reference kernel is
[`tradelayer_pnl_batch_settlement.js`](../bitvm3/utxo_referee/tradelayer_pnl_batch_settlement.js).
It checks an accounting transition against an independently supplied snapshot
and `expectedSnapshotHash`.

The kernel supplies a candidate allocation and an independently checkable
witness. The dedicated V2 modules now construct exact Bitcoin transactions and
guard test-network signing through durable replay state. Mandatory production
custody integration and cryptographic proof verification remain pending. The
beta report checks each capability within its documented scope.
The inherited restrictions in [`SECURITY_BLOCKERS.md`](../SECURITY_BLOCKERS.md)
and [`CLAIMS_MATRIX.md`](../CLAIMS_MATRIX.md) still apply.

The earlier
[`tradelayer_pnl_state_netting.js`](../bitvm3/utxo_referee/tradelayer_pnl_state_netting.js)
already computes account net balances and pairs debtors with creditors in
address order. This revision addresses the missing funding graph and strengthens
verification of the committed source. The associated security work addresses
the legacy verifier's dependence on submitted intermediate rows and roots.
Its original scope is recorded in
[`TRADELAYER_PNL_STATE_NETTING.md`](../bitvm3/utxo_referee/TRADELAYER_PNL_STATE_NETTING.md).

A snapshot hash establishes binding to a particular snapshot. The caller still
has to establish its authority, freshness and completeness against the accepted
TradeLayer state. A producer can hash an incomplete snapshot perfectly.

### Reference API and snapshot

The module exports `buildPnlSettlementBatch(snapshot)`,
`hashPnlSettlementSnapshot(snapshot)` and
`verifyPnlSettlementBatch(batch, { snapshot, expectedSnapshotHash })`.
Verification requires the caller's independently selected snapshot and its
expected hash. Canonical rederivation checks the submitted batch against that
source.

Public APIs copy inputs through the descriptor-aware plain-data boundary before
reading fields. Executable hooks, accessors and Proxies are rejected without
invoking them. Snapshot amounts may use exact `BigInt` values; candidate batches
use JSON-compatible data. The builder returns a deeply frozen batch. Both the
input and expanded witness must fit the canonical limits of 65,536 value nodes,
depth 64 and 16 MiB of string code units, which can bind before individual list
limits.

The snapshot kind is `tradelayer_pnl_batch_snapshot_v1`. Its top-level fields
are `network`, `epochId`, `previousStateRoot`, `nettingSets`, `vaults`,
`accounts`, `obligations`, `consumedObligationIds`, `spentOutpoints` and
`routes`, in addition to `kind`.

| Record | Fields used by the relation |
| --- | --- |
| Netting set | `id`, `assetId`, `unit` |
| Vault | `id`, `nettingSetId`, `assetId`, `unit`, `changeScriptPubKey`, `feeSats`, `protectedSats`, `utxos` |
| Funding input | `txid`, `vout`, `sats`, `scriptPubKey` |
| Account | `id`, `nettingSetId`, `assetId`, `unit`, `vaultId`, `equitySats`, `lockedSats`, `payoutSats`, optional `payoutScriptPubKey` |
| Realized obligation | `id`, `nettingSetId`, `assetId`, `unit`, `fromAccountId`, `toAccountId`, `sats` |
| Permitted route | `fromVaultId`, `toOutputId`, `capacitySats` |

Output IDs are `vault:<vaultId>` and `payout:<accountId>`. The initial kernel
accepts the selected network's native BTC or LTC asset with `unit: "satoshis"`.
It checks realized obligations supplied by the snapshot; contract pricing,
liquidation and oracle authentication occur upstream. It also checks consumed
IDs and spent outpoints supplied by that snapshot. Their durable history and
current chain status remain the caller's responsibility.

`previousStateRoot` is bound into the snapshot and proposed statement. This
reference module has no Merkle-opening check linking the supplied account
equities and replay history to that root. The trusted caller must establish
that link. The [dedicated V2 adapter](PNL_BATCH_EXECUTION.md) now carries the
complete typed snapshot and checks its projection against the persisted ledger.
The historical row-only V2 schema keeps its original scope.

Replay history is represented as bounded arrays in this reference. A durable
integration needs authenticated sets and a checkpoint/compaction rule so that
history growth remains verifiable across batches.

The result carries `executionVerified: false` and `zkProofVerified: false`.
Its transaction proposal is classified as `atomic-spend-proposal` or
`accounting-only`.

The builder selects every UTXO supplied in the snapshot. It proposes consuming
those inputs and recreating the calculated residuals. Coin selection and an
adapter that tracks unchanged collateral outputs are future work.

### Run the synthetic example

```sh
node bitvm3/utxo_referee/tradelayer_pnl_batch_demo.js
node --test bitvm3/utxo_referee/tradelayer_pnl_batch_settlement.test.js
node bitvm3/utxo_referee/tradelayer_pnl_state_netting.test.js
node bitvm3/utxo_referee/tradelayer_beta_gate_package.test.js
```

The [fixture](../bitvm3/utxo_referee/artifacts/fixtures/pnl_batch_settlement_v1.snapshot.json)
contains invented outpoints and public scripts. The demo pins its hash and
prints the worked transfer below: 215,000 input sats, 1,000 fees, 4,000 paid to
the beneficiary and 6,000 retained profit. Removing the transfer route to the
winner's vault produces an exact 6,000-sat funding deficit. It performs local
arithmetic without RPC, signing or writes to the filesystem.

### Initial reference-kernel validation recorded on 2026-11-13

Node v24.22.1 on Linux produced these results:

| Check | Result |
| --- | --- |
| Batch settlement tests | 36 passed, including all 81 capacity assignments for a two-source, two-destination graph compared with an independent exhaustive allocation oracle |
| Legacy source replay tests | 30 passed |
| Beta gate tests | 9 passed |
| Existing V2 and package export boundaries | 10 and 7 passed |
| Watchtower restart tests | 8/8 passed on repeated invocations with the same process ID after isolating each run's temporary directory |
| `node scripts/run_every_test.js` | 116/116 test files passed |
| `node eval/utxo_referee_eval.js --profile=full --require-perfect` | 19/19 cases, 100/100 weighted points |
| `node eval/dlc_security_eval.js --profile=full --require-perfect` | 49/49 cases, 568/568 weighted points |
| Synthetic worked example | Valid batch accepted; removal of the retained-profit funding route rejected with a 6,000-sat deficit |

These initial runs exercised local reference code. The subsequent
[execution follow-up](PNL_BATCH_EXECUTION.md) adds prior-ledger opening and a
funded Core regtest exercise. Cryptographic batch proofs and mandatory
production custody integration remain open.

Before the legacy verifier was changed, local reproductions accepted a
rehashed recipient diversion, omitted source rows, a changed uncommitted
`priceScale`, an absent funding input and a duplicated position. The revised
source-replay suite rejects each case. These findings concern the legacy
adapter; existing V2 signed-checkpoint checks have their own scope.

Final boundary regressions also reject executable objects that conceal changed
recipients through `toJSON`, source or candidate getters, and Proxy traps. Side
effect counters remain zero. Legacy payout proofs still accept the builder's
Buffers and their plain JSON encodings.

A repeated full run exposed an existing watchtower test fixture collision:
state filenames used only the case name and process ID. Reused process IDs
loaded an earlier run's restart counters. The test now creates and cleans its
own unique temporary directory; the daemon implementation is unchanged.

## 1. Obligation graph and settlement domains

For each permitted netting set, form a directed graph of matured obligations.
An edge from account A to account B carries an integer amount owed by A to B.
Let `g` contain those nonnegative amounts and let `A` be the incidence matrix,
using -1 at an edge's debtor and +1 at its creditor. The account changes are

\[
b=Ag,\qquad \sum_i b_i=0.
\]

Each netting set must identify the network, asset and epoch, together with the
collateral agreement that permits offsets. The same address can participate in
several sets. Its identity alone grants no permission to move collateral
between them. Every obligation, account, vault and permitted funding route
must belong to its pinned set.

If a circulation `z` satisfies `Az = 0` and `0 <= z <= g`, removing it preserves
every account's net entitlement:

\[
A(g-z)=Ag.
\]

For example, the obligations A->B:100, B->C:100 and C->A:100 have zero net
balance at every account. An agreement allowing their simultaneous discharge
can close the cycle without a profit output. The epoch must still record that
the obligations were consumed.

Cancellation and replacement of counterparties require explicit authority.
Replacing A->B and B->C with A->C changes the obligation relationship. A common
clearing agreement can authorize that replacement. Existing bilateral DLCs can
impose different conditions, including pre-signed output templates. The
accounting graph must preserve those conditions through its route policy and
the eventual spend check.

When a netting set permits arbitrary debtor-to-creditor transfers, the minimum
total contribution by net debtors is

\[
Q=\sum_i\max(b_i,0)=\frac12\sum_i|b_i|.
\]

A simple ordered pairing constructs a transportation plan with at most
`number_of_debtors + number_of_creditors - 1` nonzero edges. This bounds the
result of that construction. Finding the smallest number of Bitcoin inputs or
the cheapest executable transaction requires additional constraints and a
separate cost objective.

## 2. Account entitlements and retained profit

For account `i`, define:

| Symbol | Meaning |
| --- | --- |
| `e_i` | Pre-batch equity in sats, established by the snapshot |
| `b_i` | Signed net PnL from obligations in this batch |
| `p_i` | Requested direct profit payout, represented by `payoutSats` |
| `e'_i` | Equity retained after this batch |

The transition is

\[
e'_i=e_i+b_i-p_i,
\qquad
0\le p_i\le\max(b_i,0).
\]

The reference kernel handles payouts from the current positive net profit.
Principal redemption and withdrawals of profit retained in earlier epochs need
their own authenticated withdrawal transition. This restriction keeps the first
batch relation small enough to review.

Require each post-equity to remain nonnegative and at least its committed
`lockedSats`. A row-level loss cap is insufficient when several positions
draw from the same collateral. Their combined effect must pass the account and
vault checks. Fees in this version are paid from unallocated reserve under the
rule in the next section.

If a beneficiary earns 10,000 sats and requests a 4,000-sat payout, its retained
equity increases by 6,000 sats. Crediting 10,000 retained sats in addition to the
payout would overstate its claim by 4,000. The post-equity equation prevents this
duplication.

### Beneficiary identity and rBTC units

The payout destination is the authorized beneficiary's script pinned in the
snapshot. Beneficial claims can transfer according to the token and account
rules. The original depositor address therefore serves as provenance where
needed; current withdrawal authority comes from the authenticated ownership
state. A change of beneficiary or destination requires the authorized state
transition that updates that mapping.

This kernel consumes satoshi-denominated equity. The conversion from rBTC
balances, any mint or burn, and any share-price rule belong to the upstream
TradeLayer transition. The available integration material leaves rBTC unit
semantics unresolved, so token counts must stay distinct from satoshi amounts
until that conversion is pinned and verified.

For a vault-share design with backing `N` sats and supply `S`, the rational
share value is `N/S`. Realized retained profit changes `N`; deposits and
redemptions change supply under the specified rule. A fixed-denomination token
requires its own treatment of profit ownership. Either design needs exact
integer rounding and an explicit destination for residual amounts.

Use one rounded bilateral transfer and post equal-and-opposite entries.
Independently rounding the debtor and creditor creates an avoidable source of
one-sat discrepancies. Circuit implementations must range-check signed values
and accumulators so field wraparound cannot imitate valid integer arithmetic.

## 3. Exact vault residuals

For vault `v`, let:

| Symbol | Meaning |
| --- | --- |
| `U_v` | Value of the distinct funding inputs committed to the batch |
| `f_v` | Fee assigned to this vault |
| `E_v` | Sum of its pre-batch account equities |
| `E'_v` | Sum of its post-batch account equities |
| `P_v` | Protected reserve that must survive the batch |
| `R_v` | Required post-batch output to this vault's pinned residual script |

The funding precondition is

\[
U_v\ge E_v+P_v+f_v.
\]

It reserves customer backing and protected funds before charging fees. Define

\[
K_v=U_v-f_v-E_v.
\]

Then `K_v >= P_v` and the exact residual demand is

\[
\boxed{R_v=U_v-f_v-E_v+E'_v=K_v+E'_v.}
\]

Every retained account claim remains backed within its assigned vault, and the
vault keeps its protected reserve. A positive aggregate reserve across the
system cannot substitute for these individual residuals.

The chosen input set must cover every pre-equity attributed to the participating
vault in this snapshot. If the implementation later permits partial input
selection or reserve outside the transaction, the snapshot and equations must
also account for those unchanged, authenticated outputs. Assigning all account
liabilities to a small selected subset would misstate available backing.

### Worked transfer

Both accounts belong to the same authorized netting set. A loses 10,000 sats to
B, which elects to withdraw 4,000 sats and retain 6,000.

| Vault | Inputs `U` | Pre-equity `E` | Fee `f` | Net PnL | Direct payout | Post-equity `E'` | Residual `R` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 110,000 | 100,000 | 500 | -10,000 | 0 | 90,000 | 99,500 |
| B | 105,000 | 100,000 | 500 | +10,000 | 4,000 | 106,000 | 110,500 |

The 215,000 input sats fund 210,000 sats of residuals, the 4,000-sat payout and
1,000 sats of fees. A feasible allocation sends 99,500 from A back to A, 6,000
from A to B's residual, and 4,000 from A to B's payout. B contributes its
remaining 104,500 to its own residual. The cross-vault and payout routes require
permission in the snapshot.

## 4. Funded graph and its exact feasibility condition

Build a bipartite graph whose source nodes are vaults and whose destination
nodes are all positive residual demands and requested direct payouts. Each
source has capacity

\[
C_v=U_v-f_v.
\]

Each destination `j` has an exact demand `d_j`. An allowed source-to-destination
edge has a committed nonnegative cap `u_vj`. A vault may fund its own residual
implicitly. Cross-vault routes and routes to direct payout destinations must be
explicitly authorized and capped. Cross-set routes are rejected.

A witness consists of integer amounts `x_vj` satisfying

\[
0\le x_{vj}\le u_{vj},\qquad
\sum_jx_{vj}\le C_v,\qquad
\sum_vx_{vj}=d_j.
\]

Within each set, summing the post-equity relation gives

\[
\sum_v E'_v=\sum_v E_v-\sum_i p_i.
\]

Consequently,

\[
\boxed{\sum_vR_v+\sum_ip_i=\sum_v(U_v-f_v).}
\]

Thus full demand satisfaction uses every source capacity, and transaction value
is conserved exactly. Fees are already excluded from source capacities.

### Cut theorem

For integer capacities and independently permitted transfers, a full allocation
exists exactly when every destination subset `J` satisfies

\[
\boxed{
\sum_{j\in J}d_j
\le
\sum_v\min\left(C_v,\sum_{j\in J}u_{vj}\right).
}
\]

To see this, add a source-to-vault edge of capacity `C_v` and a
destination-to-sink edge of capacity `d_j`. For a cut with destination set `J`
on the sink side, placing a particular vault on either side contributes the
smaller of `C_v` and the sum of its edge caps into `J`. The other destinations
contribute `sum(d_j for j outside J)`. Every cut has capacity at least total
demand precisely when the displayed inequalities hold. Max-flow/min-cut then
gives a saturating flow; integer capacities give integer amounts. [1]

Where allowed edges have unbounded caps, the condition becomes the weighted
Hall condition `demand(J) <= capacity(neighbors(J))`.

### FIFO failure with sufficient total money

| Source | Available sats | Permitted destinations |
| --- | ---: | --- |
| A | 10 | X, Y |
| B | 10 | X |

X and Y each require 10. A queue that uses A for X leaves Y without an eligible
source. Assigning B to X and A to Y satisfies both. The small values illustrate
the accounting graph; Bitcoin dust and fee rules are checked on executable
transaction fixtures at suitable amounts.

FIFO can order choices among allocations that remain feasible. A solver can
also undo an earlier choice through residual edges. Giving queue position
authority over losses would introduce an additional economic rule.

### Shortfalls

For a failed full allocation, return the maximum settled amount, required total
and deficit, with a cut witness where available. Preserve all account and
reserve state. An infeasible candidate cannot earn payout authorization by
dropping a destination, crediting an unfunded retained claim, or letting the
earliest request consume the remaining money.

An insolvency policy would need a separately authorized waterfall and an
authenticated transition applying it to every affected claim. The present
kernel rejects the shortfall. Net settlement still depends on the ability of
the debtors and collateral system to fund the resulting obligations, a concern
also addressed in the CPMI's payment-system analysis. [2]

## 5. From a flow witness to a Bitcoin spend

The flow model assumes that an allowed edge can carry any integer amount up to
its cap independently of the other edges. A DLC template can couple several
outputs or restrict the transaction as a whole. Bitcoin also consumes complete
inputs and creates exact outputs, which introduces change, weight and dust
constraints. Each accepted accounting witness must therefore pass the concrete
spend check.

The transaction integration must establish:

- Distinct selected outpoints, their authenticated values and scripts, current
  unspent status, and the required confirmation depth.
- Exact residual and beneficiary scripts with exact amounts, including every
  fee and any additional output permitted by policy.
- Satisfaction of the relevant DLC, guardian, timelock or dispute conditions,
  with a signature hash that binds the required transaction data.
- A state commit tied to the observed settlement outcome, durable epoch replay
  protection, and a specified rollback response to a chain reorganization.

Taproot `SIGHASH_DEFAULT` and `SIGHASH_ALL` commit to the transaction outputs as
specified by BIP341. Input commitments also depend on the selected hash mode.
The signer and verifier must enforce the intended mode. [3]

A multi-input Bitcoin transaction provides a natural atomic boundary for
funding and outputs. When settlement spans several transactions, the protocol
must define which intermediate states exist and how to recover if only a
prefix confirms. A proof over the final accounting state leaves that execution
problem open.

Within one funded vault, an internal transfer of retained PnL can leave total
backing unchanged algebraically. The current builder still proposes spending
the supplied UTXOs and recreating the residual output. Skipping that transaction
would require a separate state adapter that authenticates the unchanged
collateral and applies the account transition under the existing spending
agreement.

A closed zero-net cycle can require no Bitcoin transaction when its account
changes and payouts are all zero. In this kernel, the initial backing rule
allows zero inputs only with zero initial equity, protected reserve and fees.
Any account with a negative net change then fails the equity rule, so an
accepted zero-input cycle has zero net change at every account. The accounting
transition must still satisfy the pinned snapshot and consume the epoch.

## 6. Exact statement for a future validity proof

The proposed proof relation uses the accounting kernel as a specification.
Let the public statement be

\[
\mathcal P=(
\mathit{version},\mathit{programId},\mathit{chain},\mathit{asset},
\mathit{epoch},\mathit{oldRoot},\mathit{newRoot},
\mathit{snapshotHash},\mathit{obligationsRoot},
\mathit{inputRoot},\mathit{outputRoot},\mathit{policyHash},
\mathit{consumedRoot},\mathit{txCommitment}).
\]

The witness opens the required positions, marks, account records, funding
records and route permissions, with the proposed allocation and state updates.
The verifier accepts only if all of the following hold:

1. Openings authenticate against the pinned roots. Network, asset, epoch and
   program version match the expected context.
2. Every obligation due in the committed batch appears exactly once. The
   selected complete batch is established by a canonical range, counter or
   authenticated enumeration rule. Membership proofs alone leave omission
   undetected.
3. PnL and loss limits follow the accepted upstream position and oracle rules.
   Integers, signs and rounding follow the reference semantics.
4. Account changes equal the incidence sums within each permitted netting set.
   Post-equity and margins pass; payout destinations follow the pinned
   beneficiary mapping.
5. Vault residuals and fees satisfy the equations above. Each flow edge obeys
   its permitted cap and every exact destination demand is funded.
6. Direct payout and retained equity account for each gain once. Any rBTC
   conversion, mint, burn or share update is authenticated through its upstream
   transition and binds to the resulting satoshi claims.
7. The committed output vector and input set agree with the actual transaction
   covered by the spending mechanism. Epoch and claim consumption update
   durable state exactly once.

Computing a candidate flow can happen outside the circuit. Checking its
capacities and conservation takes a pass over the authenticated edges and
nodes. A proof of this feasible witness suffices for the acceptance relation.
Optimizing cost can remain an operational choice unless the protocol promises
a particular optimum or ordering policy.

The current JavaScript verifier rebuilds the deterministic solver and compares
the entire candidate, including its allocation. A future circuit accepting
any feasible allocation must identify that witness policy in its program
version. Account states and exact outputs remain fixed by the authenticated
snapshot in either formulation.

The current `transactionTemplateHash` commits the economic proposal: selected
input outpoints, values and scripts, ordered outputs, network and fee. The
dedicated transaction adapter additionally binds version, locktime and input
sequences to exact serialized bytes. Production custody still needs to enforce
the same statement through its required DLC/CET, guardian or BitVM spend paths.

The native proof gate needs a real verifier invocation, pinned program and
verification parameters, canonical public-input encoding and rejection of
malformed or wrong-statement proofs. The existing
[`rbtc_dlc_zk_settlement_adapter.js`](../bitvm3/utxo_referee/rbtc_dlc_zk_settlement_adapter.js)
models receipt routing and root comparisons. A receipt identifier or producer
`ok` field cannot establish this proof relation. The batch kernel reports its
accounting scope and leaves cryptographic verification unavailable until that
backend is implemented and tested.

### Data availability and exits

Users and guardians need enough authenticated data to recover their balances,
construct the permitted exit and challenge an invalid spend where the protocol
uses challenges. A validity proof can hide witness data while leaving those
operations unable to proceed. The gate therefore needs a concrete publication
or recovery requirement for the account updates, destination openings and
funding information used by exits. Retention periods and the response to
withheld data belong to that requirement.

The old-state root, available data and proof must all refer to the same batch.
Publishing an unrelated manifest with a matching epoch label is insufficient.

## 7. Transparent proof paths

The intended proof path preserves the requirement of no trusted setup through
every compression and verification layer.

| Candidate | Proposed role | Setup and integration considerations |
| --- | --- | --- |
| Transparent STARK | Prove the integer transition and flow-check program | Pin the program, hashes, security parameters and any recursion. Hash-based transparent construction is supported by the original STARK work. [4] |
| Nova with Pedersen commitments and IPA-based compression | Fold successive authenticated settlement steps and compress their verification | Pin the curve cycle and commitment backend. The no-trusted-setup path uses transparent parameter derivation and a compatible final compressor. [5][6] |
| Existing Groth16 research | Comparison fixture and study of the existing BitVM verifier work | Its circuit-specific reference-string requirements remain part of the experiment. It cannot be substituted into a path that promises no trusted setup. [7] |

Nova's library supports several commitment backends. Its HyperKZG and Mercury
backends require a universal setup, so a generic claim that every Nova
configuration is transparent would be incorrect. The proposed configuration
must pin Pedersen/IPA and inspect the complete wrapper chain. The library also
describes how its final proof obtains zero knowledge; that property must be
established for the selected construction. [6]

The repository's [`zk-groth16-bitvm`](../zk-groth16-bitvm) directory remains
useful as an existing research comparison. A new proof backend must implement
the full relation above before its proof size or verifier cost becomes
comparable. Transplanting the proof of a smaller or different statement would
invalidate the comparison.

The reference kernel currently supplies neither a STARK nor a Nova proof.
Proof generation and verification results remain unmeasured for this batch
relation.

## 8. Benchmark needed to choose batching and a proof backend

Measure batching and proof compression separately. The common reference input
must produce identical account states, residuals and beneficiary outputs across
every compared implementation.

Use deterministic datasets with sparse and dense route permissions, cycles,
concentrated liquidity, multiple netting sets, and fragmented UTXOs. Include
unfunded cuts and an unavailable required source. Report dataset hashes with
the accepted output commitments.

| Measurement | Required evidence |
| --- | --- |
| Accounting | Obligation count, account count, vault count, route count, full/failed flow result, exact shortfall where applicable |
| Bitcoin cost | Executable transaction bytes and weight, input/output counts, fee rate and fee, script paths, confirmation behavior |
| Native validation | Wall time and peak memory for snapshot authentication, PnL derivation, flow construction and witness verification separately |
| Proof construction | Circuit or program hash, backend/version, security parameters, setup provenance, proof bytes, proving time and peak RAM/VRAM |
| Proof verification | Native verification time, tamper rejection, public-input binding, and the measured cost of the actual Bitcoin enforcement path |
| Data availability | Published/recoverable bytes, recovery time and success of an exit after the operator stops serving data |
| Failure handling | Reorg, stale epoch, duplicate input, withheld witness and partial multi-transaction settlement outcomes |

Compare a direct deterministic batch verifier with the transparent proof
candidates using the same complete statement. Report the first batch size at
which an implementation meets the chosen latency and resource budgets, along
with the total published data and transaction cost. ZK proof bytes alone omit
outputs and any data required for recovery.

The decision remains open until this relation has a prover, a working
enforcement integration and measured runs. The available accounting tests
establish the transition and its rejection behavior. Proof costs and mainnet
readiness require separate evidence.

The beta package is a readiness report. Its accounting gate invokes the batch
verifier, and its V2 gate requires an authenticated envelope for that same
batch. The dedicated execution API opens the persisted ledger and guards the
test-network signing and broadcast path. Production custody integration keeps
the spend-enforcement gate pending and `realMoneyAllowed` false.

## 9. Adversarial cases required by the gates

| Case | Required outcome |
| --- | --- |
| FIFO consumes the only flexible source | Recover a feasible full flow when one exists |
| Total supply is adequate but a destination cut is deficient | Reject and preserve state |
| Duplicate obligation, account, vault, route or funding outpoint | Reject ambiguous or repeated use |
| Two netting sets share an address | Keep their obligations and routes separate |
| Gross edges or post-state are changed and all local hashes recomputed | Reject against the independently pinned source snapshot |
| Wrong payout script keeps the same account label and amount | Reject destination substitution |
| Current positive profit is paid and also fully retained | Reject the duplicated claim |
| Several positions reuse one loss cap or equity allocation | Reject aggregate undercollateralization |
| Fee exceeds the unallocated reserve | Reject the reserve drain |
| One-sat division boundary or large signed intermediate | Match the pinned integer semantics |
| Claimed receipt has equal roots and `ok: true` without a proof | Keep the cryptographic capability gate closed |
| Valid flow conflicts with a CET template or current chain state | Keep the spend gate closed |
| Zero-net cycle with zero payouts | Accept only the valid accounting transition and consume its epoch |
| Proof verifies while required exit data is withheld | Keep the data-availability gate closed |

## Primary references

1. [MIT, Principles of Discrete Applied Mathematics, flow and matching lecture notes](https://ocw.mit.edu/courses/18-200-principles-of-discrete-applied-mathematics-spring-2024/mit18_200_s24_lec11-12.pdf), and [MIT 6.854, max-flow/min-cut notes](https://courses.csail.mit.edu/6.854/19/Scribe/s6-maxflow/s6-maxflow.html). The weighted cut inequality in this document is the explicit reduction for this funding graph.
2. [BIS/CPMI, Core Principles for Systemically Important Payment Systems](https://www.bis.org/cpmi/publ/d43.pdf), especially its treatment of funding and participant failure in deferred multilateral settlement. This is background on the settlement mechanism, with no claim that this prototype meets those institutional standards.
3. [Bitcoin BIP341, Taproot signature message and spending rules](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki), and [BIP342, Tapscript validation](https://github.com/bitcoin/bips/blob/master/bip-0342.mediawiki).
4. Eli Ben-Sasson, Iddo Bentov, Yinon Horesh and Michael Riabzev, [Scalable, transparent, and post-quantum secure computational integrity](https://eprint.iacr.org/2018/046), 2018.
5. Abhiram Kothapalli, Srinath Setty and Ioanna Tzialla, [Nova: Recursive Zero-Knowledge Arguments from Folding Schemes](https://eprint.iacr.org/2021/370), CRYPTO 2022; see also [Revisiting the Nova Proof System on a Cycle of Curves](https://eprint.iacr.org/2023/969).
6. [Microsoft Nova, official implementation documentation](https://github.com/microsoft/Nova/blob/main/README.md), including commitment backends, compression, zero knowledge and universal setup requirements. Backend details must be pinned to the revision selected for implementation.
7. Jens Groth, [On the Size of Pairing-based Non-interactive Arguments](https://eprint.iacr.org/2016/260), EUROCRYPT 2016.
