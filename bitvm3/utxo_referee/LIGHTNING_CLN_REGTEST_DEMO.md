# Core Lightning Regtest Demo

This demo starts a private Bitcoin regtest chain plus two Core Lightning nodes
inside WSL, opens an Alice-to-Bob channel, pays a Bob invoice, and writes the
payment receipt into repo artifacts.

## Installed Tools

The local WSL install is user-scoped:

- Bitcoin Core: `~/.local/utxoref-lightning/bin/bitcoind`
- Bitcoin CLI: `~/.local/utxoref-lightning/bin/bitcoin-cli`
- Core Lightning: `~/.local/utxoref-lightning/bin/lightningd`
- Lightning CLI: `~/.local/utxoref-lightning/bin/lightning-cli`
- Extra runtime libs: `~/.local/utxoref-lightning/lib`

## Run

From PowerShell:

```powershell
wsl -d Ubuntu --exec /bin/bash /mnt/c/projects/UTXORef/UTXO-Ref/bitvm3/utxo_referee/cln_regtest_demo.sh
```

The script owns only:

```text
~/.local/utxoref-lightning/run/regtest-demo
```

It cleans and recreates that directory on each run.

## Outputs

- `bitvm3/utxo_referee/artifacts/cln_regtest_demo_latest.json`
- `bitvm3/utxo_referee/artifacts/cln_regtest_demo_latest.md`

The Markdown artifact records:

- Bitcoin and Core Lightning versions
- Alice and Bob node ids
- the funding txid and channel txid
- the BOLT11 invoice
- the payment hash
- the payment preimage

## Interactive CLI

After a successful run, the nodes are left running for live inspection.

```powershell
wsl -d Ubuntu --exec /usr/bin/env LD_LIBRARY_PATH=/home/duganist/.local/utxoref-lightning/lib /home/duganist/.local/utxoref-lightning/bin/lightning-cli --lightning-dir=/home/duganist/.local/utxoref-lightning/run/regtest-demo/alice --network=regtest getinfo
```

Useful commands inside WSL:

```bash
source ~/.local/utxoref-lightning/run/regtest-demo/env.sh
lightning-cli --lightning-dir="$UTXOREF_LN_RUN/alice" --network=regtest getinfo
lightning-cli --lightning-dir="$UTXOREF_LN_RUN/alice" --network=regtest listpeerchannels
lightning-cli --lightning-dir="$UTXOREF_LN_RUN/bob" --network=regtest listinvoices
```

## Notes

The CLN nodes run with `--developer`, `--dev-bitcoind-poll=1`, and
`--funding-confirms=1` to keep the regtest demo fast. This is a local demo
surface for Lightning receipts and BitVM/DLC integration transcripts, not a
mainnet configuration.
