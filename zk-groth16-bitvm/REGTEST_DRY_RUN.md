# Bitcoin Core regtest settlement dry run

This standalone Node script starts **Bitcoin Core 31.0** on an isolated
temporary regtest chain, mines test-only coins and funds a wallet-controlled
Taproot P2TR output for 6,000 sats. It builds the current V2 settlement with
5,000 sats in exact payouts, a 1,000-sat fee and a sequence-6 input.

It checks the signed transaction with Bitcoin Core's
`testmempoolaccept` before and after relative-lock maturity; verifies the
V2 settlement reference and V0 Groth16 statement; signs an intentionally
misdirected payout using the regtest wallet's key path; and invalidates
the block containing the funding output and signed checkpoint snapshot.

**Important:** The wallet-controlled Taproot output is a surrogate, not the
NUMS-keyed BitVM assertion graph. The deliberately corrupted payout should
pass Bitcoin Core policy after maturity while V2 rejects it. This demonstrates
why the actual BitVM script/dispute graph must constrain settlement.

The drill also checks that a Core-backed chain observation would reject
the funding/snapshot evidence after a reorg. This evidence gate is absent
from the Stage 1 off-chain adapter.

The script never broadcasts settlement transactions, connects to a public
chain, generates a Groth16 proof or deploys an enforceable BitVM contract.

## Run

From repo root with verified Bitcoin Core binaries installed:

```sh
BITCOIN_BIN_DIR=/path/to/bitcoin-31.0/bin \
node zk-groth16-bitvm/regtest_core_dry_run.cjs \
  --regtest-only --receipt /tmp/utxoref-groth16-regtest.json
```

GitHub Actions workflow `groth16-bitvm-regtest.yml` downloads the
version-and-SHA256-pinned Core binary and uploads only the JSON receipt.
The binary digest is checked against a separately pinned SHA256 value and
the upstream checksum listing. A production supply-chain review should
also verify independent release GPG signatures.

## Next required gate

Integrate the actual UTXO-Ref V2 assertion graph and enforce its Taproot
script paths through Core regtest. Check the funding graph's non-circular
commitment ordering. Bind the pinned Groth16 verifier/program statement to
the graph's challengeable computation. The current checkpoint signer
remains a trust root; the real chain needs authenticated inclusion and
reorg-sensitive freshness checks.


## Recorded verified execution

Bitcoin Core release `31.0` SHA256-pinned tarball and
[run #41273922843](https://github.com/patrickdugan/UTXO-Ref/actions/runs/41273922843)
passed. Core's early sequence-6 rejection was `non-BIP68-final`; its
mature transaction was accepted after seven confirmations.
The deliberately misdirected payout passed Core policy after wallet
signing, while the V2 referee rejected it. After invalidating the
funding block, neither the signed snapshot nor the mature assertion
evidence remained valid.

The [JSON evidence receipt](artifacts/regtest_core_dry_run_2026-11-01.json)
is committed so it survives the CI artifact retention window.
