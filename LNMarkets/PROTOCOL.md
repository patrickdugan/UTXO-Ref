# Prototype protocol and source boundaries

## Roles and agreement

The trader and maker agree to a bounded inverse future. LN Markets supplies
the prospective market/UI integration and a public price reference. The
future venue adapter needs an authenticated maker quote; the reference
adapter here only supplies an indicative mark.

The contract binds market identity, side, notional, entry price, collateral,
payout scripts, funding keys, fee and anchor budgets, absolute maturity and
refund heights, CSV delay, oracle event, exact prices and oracle keys. Its
plan digest enters every outcome message. Each oracle announcement signs
that event and the ordered outcome-message set.

All BTC amounts and USD cents in saved artifacts are canonical decimal
strings. Heights are bounded integers below 500,000,000. This preserves
Bitcoin's block-height interpretation of nLockTime. Only `bitcoin-regtest`
is accepted by the current contract API.

## Setup and recovery API

```javascript
const { contract, settlement } = require('./LNMarkets');

const plan = contract.buildContractPlan(terms);
const packageValue = settlement.buildSettlementPackage({
  plan,
  oracleAnnouncements,
  fundingOutpoint: { txid, vout }
});

// Fixture-only API. Production key access belongs behind the existing
// UTXORef native-signer and contract-state authorization boundary.
const share = settlement.createResearchPartySignatures({
  settlementPackage: packageValue,
  partySecret: disposableFixtureSecret,
  acknowledgeResearchCrypto: true
});

const recoveryPackage = settlement.finalizeRecoveryPackage({
  settlementPackage: packageValue,
  partySignatures: [traderShare, makerShare]
});

// Retain these in the wallet's trusted storage before any future funding.
const pins = {
  expectedPlanId: plan.planDigest,
  expectedRecoveryDigest: recoveryPackage.recoveryDigest
};

const checked = settlement.verifyRecoveryPackage(recoveryPackage, pins);
const refund = settlement.getRefundTransaction({ recoveryPackage: checked, ...pins });
const cet = settlement.completeSettlement({
  recoveryPackage: checked,
  ...pins,
  outcomeId: plan.outcomes[selectedIndex].outcomeMessage,
  attestations: [
    { oraclePubkeyX: firstOracleKey, scalarHex: firstPublicAttestation },
    { oraclePubkeyX: secondOracleKey, scalarHex: secondPublicAttestation }
  ]
});
```

`finalizeRecoveryPackage` checks the full signature set from each party and
constructs the signed refund. `verifyRecoveryPackage` verifies against both
external pins and reconstructs the package. A previously valid package for
another outpoint fails the exact recovery pin even if its economic terms
produce the same plan digest.

All three possible two-key subsets are represented in the CET set. An oracle
can be absent without preventing completion by the remaining pair.
Authenticated announcements prove control of pinned keys. Operational
independence and truthful prices require separate deployment arrangements.
The default fixture controls all oracle keys in one process.

Current packets use UTXORef's research Schnorr/adaptor envelopes.
Interoperability with LN Markets or DLC Markets wire formats remains
unverified and needs a separate protocol review with the venue.

The offline APIs above construct and verify public settlement materials.
`regtest.js` adds a separate Core rehearsal using `DlcStateStore`, the existing
funding and execution prebroadcast guards, and durable one-use broadcast
authorization. The rehearsal's ephemeral Ed25519 validator signs receipts
for actual local checks. Both wallet roles restore the refund from their own
public files before approving the collaborative PSBT. Two one-shot
subprocesses hold disposable DLC party keys during setup and exit before
funding. Production authorization still requires an audited native signer,
independently authenticated peer transcripts and separately pinned
validators.

## Transaction details

| Property | Construction |
|---|---|
| Funding output | Existing deterministic NUMS, two-party Taproot template |
| CET input | Exact funding outpoint and committed value; script path with both completed signatures |
| CET maturity | `nLockTime = maturityHeight`; BIP68-disabled, non-final sequence |
| Subset identity | Distinct sequence for each CET, preserving outputs and avoiding duplicate txids |
| Refund input | Same outpoint; `nSequence = refundCsvBlocks`; both signatures already present |
| Refund absolute lock | `nLockTime = refundHeight` |
| Exit outputs | Ordered trader payout, maker payout, then committed anchor |
| Exit miner fee | Exact `settlementFeeSats` |
| Recovery policy | `cpfp-anchor-v1`, additional fee cap 10,000 sats, feerate cap 50 sat/vB, relay quorum 2 |

The regtest harness spends the CET's committed anchor with a confirmed
trader wallet input. The existing watchtower checks the child's fee budget
and stable Core policy, records a one-node relay-quorum halt, and observes
the confirmed child. The rehearsal uses the normal regtest relay floor.
A raw refund remains a candidate until Core validates absolute and relative
maturity, current unspent status and relay policy.

The venue has no designated signing key in this construction. Both
counterparties can also agree to a different cooperative spend while they
hold their keys. The safety property under test is that a wallet holding
the accepted public package can recover according to the committed paths
after losing access to the other party's signing service and the venue.

## Reused UTXORef code

This implementation was based on repository commit
`0dff29eaa259a2b853f599852aae232092629b78`.

| Module | Responsibility used here |
|---|---|
| [`dlc_canonical_json.js`](../bitvm3/utxo_referee/dlc_canonical_json.js) | Detached, immutable JSON boundary and canonical encoding |
| [`dlc_funding_output.js`](../bitvm3/utxo_referee/dlc_funding_output.js) | Funding output, CET/refund leaves, NUMS key and witnesses |
| [`dlc_transaction_validator.js`](../bitvm3/utxo_referee/dlc_transaction_validator.js) | Outpoint, amount, output order, transaction and fee commitments |
| [`dlc_signature_validator.js`](../bitvm3/utxo_referee/dlc_signature_validator.js) | Party shares, refund signatures, settlement assembly and witness checks |
| [`dlc_threshold_oracle.js`](../bitvm3/utxo_referee/dlc_threshold_oracle.js) | All threshold subsets and attestation combination |
| [`dlc_signing_target.js`](../bitvm3/utxo_referee/dlc_signing_target.js) | Oracle announcement normalization |
| [`tradelayer_dlc_adaptor_sig.js`](../bitvm3/utxo_referee/tradelayer_dlc_adaptor_sig.js) | Existing research Schnorr/adaptor implementation and fixture oracle signing |
| [`tradelayer_taproot.js`](../bitvm3/utxo_referee/tradelayer_taproot.js) | Bitcoin transaction serialization |

The existing repository runner discovers `LNMarkets/test/*.test.js`
automatically. The pinned Core workflow separately runs the funded
integration. See [REGTEST_REPORT.md](REGTEST_REPORT.md) for the rehearsal's
transaction and trust boundaries.

## Public LN Markets sources

Reviewed on 2026-11-19:

- [Official REST documentation](https://docs.lnmarkets.com/en/api/): public
  API origins, `/markets`, market identity and `/perp/ticker` mark semantics.
- [Pinned Python market schema](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/rest/v3/models/markets.py):
  market status and quantity unit fields.
- [Pinned Python perp schema](https://github.com/ln-markets/sdk-python/blob/236b2739a05494295561655861b75648fcf98abc/src/lnmarkets_sdk/rest/v3/models/perp.py):
  ticker time, market identity and mark fields.
- [Prior contract and SDK review](https://github.com/patrickdugan/bitcoin-defi-bench/pull/3):
  separate benchmark work from the repository scan.

The SDK's `volume24h` field describes reference-exchange volume. It cannot
be used here as evidence of LN Markets' own activity. This prototype makes
no claim about venue open interest, user counts or commercial traction.
