# KeyAgentNet v0: custody threshold and failure-domain research

An isolated experiment under UTXO-Ref, informed by Unchained's
[Bitcoin Needs a Network of Keys](https://www.unchained.com/features/bitcoin-network-of-keys).
Its purpose is to evaluate custody signers as a threshold hypergraph before
proposing changes to the existing V2 transaction graph.

**Status:** hypothetical probability model and opt-in Core regtest harness.
There is no production signer, service registry, payment network, or settlement
authority. The probability inputs are illustrative assumptions, not measured
risk estimates. An isolated regtest cannot prove independent administration.

## Quickstart (Node.js >=22; no packages)

    node --test key-agent-net/model.test.cjs key-agent-net/regtest.cli.test.cjs
    node key-agent-net/simulate.cjs
    node key-agent-net/simulate.cjs --json

The Bitcoin Core regtest drill is explicitly opt-in. It requires bitcoind and
bitcoin-cli. The Bitcoin Core 31.0 SHA-pinned harness ran successfully in
[GitHub Actions #41281816903](https://github.com/patrickdugan/UTXO-Ref/actions/runs/41281816903).
Local execution remains optional.

    node key-agent-net/regtest.cjs --help
    node key-agent-net/regtest.cjs --run-isolated

BITCOIND_BIN and BITCOIN_CLI_BIN can override executable paths. The harness
starts a disposable datadir with cookie-authenticated local RPC, disables
outbound peer connections, creates fresh descriptor wallets, and removes
the temporary datadir after termination. Only regtest coins are mined.
Existing wallets and mainnet/testnet4 nodes are not accessed.

## Security model

Each vault specifies a threshold k of n distinct signer identities. Any
subset of k signers is an authorized quorum under a simple k-of-n script.
Independent signer compromise and outage are modeled as Bernoulli events.
A failure domain denotes shared infrastructure, admin, legal authority,
or software. One domain event affects all its associated signer identities.

The model enumerates elementary events exactly, reporting:

* **Unauthorized-spend probability:** compromised keys reach the threshold.
* **Unavailability probability:** online keys cannot reach the threshold.
* **Honest-rekey probability:** honest and online keys can co-sign a sweep
  into a replacement descriptor.
* **External-only quorums:** k-subsets that omit the named client signer.

All probabilities share the fixed horizon in the profile. The elementary
signer and domain events are independently sampled, including compromise
and outage events for the same source. Assigning multiple signers to one
domain induces exact common-mode dependence within that assumption.
Jointly correlated outage-and-compromise incidents require a later model.

For three independent keys with the same compromise probability p,
a 2-of-3 vault has P(unauthorized spend) = 3p² - 2p³. A single event
that compromises two signer keys already provides a 2-of-3 quorum.

These results describe *quorum feasibility*, not behavior or incentives.
Compromised signers might decline to steal; honest signers might decline
to help recover. An attacker-controlled quorum can also race a proposed
honest recovery. The model omits coercion incentives, transaction-mempool
races, stale keys, provider audits and legal enforcement.

Enumeration is bounded: at most 12 agents and 12 domains in the candidate
universe, and at most nine signer/domain sources per evaluated vault.
The selector enumerates candidate signer subsets and returns a Pareto
frontier on compromise probability, unavailability and illustrative cost
units. The frontier is a diagnostic, not an operational recommendation.

### Client veto is a separate policy

The example "Partner" vault has client, custodian A, custodian B and
threshold 2-of-3. Custodians A and B can sign without the client under
Bitcoin consensus. Client approval on every ordinary payment requires a
different script, for example a client signature AND an external threshold,
plus separately reviewed recovery leaves.

## Opt-in Bitcoin Core regtest checks

The regtest runner uses wsh(sortedmulti(2,...)) P2WSH descriptors and
individually generated signer HD keys. A watch-only vault constructs PSBTs.

1. Fund three separate multisig UTXOs using mined regtest coins.
2. Show that a single client signature cannot finalize a PSBT.
3. Finalize and confirm a client-plus-custodian spend.
4. Finalize and confirm an external-A-plus-external-B spend without client.
5. Treat A as unavailable and sweep another vault UTXO with client+B into
   a fresh descriptor with a replacement signer C.

Every spend goes through Bitcoin Core PSBT finalization and mempool
preflight. The runner fails if descriptor import, signatures, acceptance
or recovery receipt fail. All signer wallets live in one disposable Core
instance; this does not test signer-host independence. All four Core regtest assertions passed in [the CI run](https://github.com/patrickdugan/UTXO-Ref/actions/runs/41281816903),
which recorded three confirmed spending transactions and a 0.75-regtest-BTC
replacement vault receipt. The runner still uses a single local Core process.

Upstream Core references:
[Multisig tutorial](https://github.com/bitcoin/bitcoin/blob/master/doc/multisig-tutorial.md),
[Descriptor docs](https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md),
[walletcreatefundedpsbt RPC](https://bitcoincore.org/en/doc/32.0.0/rpc/wallet/walletcreatefundedpsbt/).

## UTXO-Ref integration boundary

Existing
[utxoref_v2_guardian_quorum_reserve.js](../bitvm3/utxo_referee/utxoref_v2_guardian_quorum_reserve.js)
encodes operator signature **AND** guardian quorum with a distinct CSV
recovery leaf. This is different from the plain multisig demonstration.
See the existing
[V2 security model](../bitvm3/utxo_referee/UTXOREF_V2_SECURITY_MODEL.md)
for checkpoint, challenger, watcher, fee-rescue and state assumptions.
KeyAgentNet must preserve those trust boundaries.

### Next acceptance gates

* Record measured, independently auditable failure-domain inputs.
* Execute the real Bitcoin Core regtest, recording version, TXIDs and logs.
* Test collusion, partitions, coercion, timeout, emergency sweep,
  reorg and fee-bump races against the actual V2 graph.
* Review the client-veto spend path and independent recovery script with
  separately administered signers, before accepting any funded custody.
* Keep this separate from the Groth16 settlement statement and Cashu work.

Offline tests and isolated Core regtest results are research evidence.
External signing, public testnet deployment, and mainnet custody require
separate security review and authorization.
