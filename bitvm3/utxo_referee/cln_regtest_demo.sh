#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
ARTIFACT_DIR="$SCRIPT_DIR/artifacts"

BASE="${UTXOREF_LN_BASE:-$HOME/.local/utxoref-lightning}"
RUN="${UTXOREF_LN_RUN:-$BASE/run/regtest-demo}"
LOG_DIR="$RUN/logs"
BITCOIN_DIR="$RUN/bitcoin"
ALICE_DIR="$RUN/alice"
BOB_DIR="$RUN/bob"
RPC_USER="${UTXOREF_LN_RPC_USER:-utxoref}"
RPC_PASS="${UTXOREF_LN_RPC_PASS:-utxorefpass}"
RPC_PORT="${UTXOREF_LN_RPC_PORT:-18443}"
ALICE_PORT="${UTXOREF_LN_ALICE_PORT:-9737}"
BOB_PORT="${UTXOREF_LN_BOB_PORT:-9738}"
CHANNEL_AMOUNT="${UTXOREF_LN_CHANNEL_AMOUNT:-500000sat}"
INVOICE_AMOUNT="${UTXOREF_LN_INVOICE_AMOUNT:-25000msat}"

export PATH="$BASE/bin:$PATH"
export LD_LIBRARY_PATH="$BASE/lib:${LD_LIBRARY_PATH:-}"

BTC_CLI=(bitcoin-cli -regtest -datadir="$BITCOIN_DIR" -rpcconnect=127.0.0.1 -rpcport="$RPC_PORT" -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASS")
LN_ALICE=(lightning-cli --lightning-dir="$ALICE_DIR" --network=regtest)
LN_BOB=(lightning-cli --lightning-dir="$BOB_DIR" --network=regtest)

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

wait_for() {
  local label="$1"
  local timeout="$2"
  shift 2
  local start now
  start="$(date +%s)"
  while true; do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    if (( now - start >= timeout )); then
      echo "timed out waiting for $label" >&2
      return 1
    fi
    sleep 1
  done
}

json_value() {
  local key="$1"
  python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$key"
}

wait_for_alice_funds() {
  local snapshot="$1"
  shift
  python3 - "$snapshot" "$@" <<'PY'
import json
import subprocess
import sys
from pathlib import Path
snapshot = Path(sys.argv[1])
cmd = sys.argv[2:]
funds = json.loads(subprocess.check_output(cmd + ["listfunds"], text=True))
snapshot.write_text(json.dumps(funds, indent=2) + "\n", encoding="utf-8")
outputs = funds.get("outputs", [])
raise SystemExit(0 if outputs and any(o.get("status") == "confirmed" for o in outputs) else 1)
PY
}

wait_for_channel_normal() {
  python3 - "$@" <<'PY'
import json
import subprocess
import sys
cmd = sys.argv[1:]
channels = json.loads(subprocess.check_output(cmd, text=True)).get("channels", [])
raise SystemExit(0 if any(c.get("state") == "CHANNELD_NORMAL" for c in channels) else 1)
PY
}

case "$RUN" in
  "$BASE"/run/*) ;;
  *)
    echo "refusing to clean unsafe run path: $RUN" >&2
    exit 1
    ;;
esac

require_cmd bitcoind
require_cmd bitcoin-cli
require_cmd lightningd
require_cmd lightning-cli
require_cmd python3

mkdir -p "$ARTIFACT_DIR"

echo "[cln-regtest] cleaning previous demo workspace: $RUN"
pkill -f "$RUN/bitcoin" >/dev/null 2>&1 || true
pkill -f "$RUN/alice" >/dev/null 2>&1 || true
pkill -f "$RUN/bob" >/dev/null 2>&1 || true
sleep 1
rm -rf "$RUN"
mkdir -p "$LOG_DIR" "$BITCOIN_DIR" "$ALICE_DIR" "$BOB_DIR"

cat >"$RUN/env.sh" <<EOF
export UTXOREF_LN_BASE="$BASE"
export UTXOREF_LN_RUN="$RUN"
export PATH="$BASE/bin:\$PATH"
export LD_LIBRARY_PATH="$BASE/lib:\${LD_LIBRARY_PATH:-}"
export UTXOREF_LN_ALICE_CLI='lightning-cli --lightning-dir="$ALICE_DIR" --network=regtest'
export UTXOREF_LN_BOB_CLI='lightning-cli --lightning-dir="$BOB_DIR" --network=regtest'
EOF

echo "[cln-regtest] starting Bitcoin Core regtest"
bitcoind \
  -regtest \
  -daemon \
  -datadir="$BITCOIN_DIR" \
  -rpcuser="$RPC_USER" \
  -rpcpassword="$RPC_PASS" \
  -rpcbind=127.0.0.1 \
  -rpcallowip=127.0.0.1 \
  -rpcport="$RPC_PORT" \
  -fallbackfee=0.0002 \
  -server=1 \
  -txindex=1 \
  -debug=0 \
  -printtoconsole=0

wait_for "bitcoind RPC" 60 "${BTC_CLI[@]}" getblockchaininfo

"${BTC_CLI[@]}" -named createwallet wallet_name=miner descriptors=true load_on_startup=true >/dev/null
MINER_ADDR="$("${BTC_CLI[@]}" -rpcwallet=miner getnewaddress miner bech32)"
"${BTC_CLI[@]}" -rpcwallet=miner generatetoaddress 101 "$MINER_ADDR" >/dev/null

echo "[cln-regtest] starting Core Lightning nodes"
setsid -f lightningd \
  --developer \
  --network=regtest \
  --lightning-dir="$ALICE_DIR" \
  --addr=127.0.0.1:"$ALICE_PORT" \
  --alias=utxoref-alice \
  --rgb=00aa88 \
  --bitcoin-rpcconnect=127.0.0.1 \
  --bitcoin-rpcport="$RPC_PORT" \
  --bitcoin-rpcuser="$RPC_USER" \
  --bitcoin-rpcpassword="$RPC_PASS" \
  --bitcoin-datadir="$BITCOIN_DIR" \
  --dev-bitcoind-poll=1 \
  --funding-confirms=1 \
  --log-level=debug \
  --log-file="$LOG_DIR/alice.log" \
  --disable-plugin=cln-grpc \
  </dev/null >"$LOG_DIR/alice.stdout.log" 2>"$LOG_DIR/alice.stderr.log"

setsid -f lightningd \
  --developer \
  --network=regtest \
  --lightning-dir="$BOB_DIR" \
  --addr=127.0.0.1:"$BOB_PORT" \
  --alias=utxoref-bob \
  --rgb=aa5500 \
  --bitcoin-rpcconnect=127.0.0.1 \
  --bitcoin-rpcport="$RPC_PORT" \
  --bitcoin-rpcuser="$RPC_USER" \
  --bitcoin-rpcpassword="$RPC_PASS" \
  --bitcoin-datadir="$BITCOIN_DIR" \
  --dev-bitcoind-poll=1 \
  --funding-confirms=1 \
  --log-level=debug \
  --log-file="$LOG_DIR/bob.log" \
  --disable-plugin=cln-grpc \
  </dev/null >"$LOG_DIR/bob.stdout.log" 2>"$LOG_DIR/bob.stderr.log"

wait_for "Alice lightning-cli" 60 "${LN_ALICE[@]}" getinfo
wait_for "Bob lightning-cli" 60 "${LN_BOB[@]}" getinfo

ALICE_INFO="$("${LN_ALICE[@]}" getinfo)"
BOB_INFO="$("${LN_BOB[@]}" getinfo)"
ALICE_ID="$(printf '%s' "$ALICE_INFO" | json_value id)"
BOB_ID="$(printf '%s' "$BOB_INFO" | json_value id)"

echo "[cln-regtest] funding Alice on-chain wallet"
ALICE_ADDR="$("${LN_ALICE[@]}" newaddr bech32 | json_value bech32)"
ALICE_FUNDING_TXID="$("${BTC_CLI[@]}" -rpcwallet=miner sendtoaddress "$ALICE_ADDR" 0.02)"
"${BTC_CLI[@]}" -rpcwallet=miner generatetoaddress 6 "$MINER_ADDR" >/dev/null
wait_for "Alice confirmed funds" 120 wait_for_alice_funds "$LOG_DIR/alice-listfunds.json" "${LN_ALICE[@]}"

echo "[cln-regtest] opening Alice -> Bob channel"
"${LN_ALICE[@]}" connect "$BOB_ID" 127.0.0.1 "$BOB_PORT" >/dev/null
CHANNEL_OPEN="$("${LN_ALICE[@]}" fundchannel "$BOB_ID" "$CHANNEL_AMOUNT")"
CHANNEL_TXID="$(printf '%s' "$CHANNEL_OPEN" | json_value txid)"
"${BTC_CLI[@]}" -rpcwallet=miner generatetoaddress 6 "$MINER_ADDR" >/dev/null
wait_for "CHANNELD_NORMAL" 90 wait_for_channel_normal "${LN_ALICE[@]}" listpeerchannels "$BOB_ID"

echo "[cln-regtest] creating Bob invoice and paying it from Alice"
INVOICE="$("${LN_BOB[@]}" invoice "$INVOICE_AMOUNT" bitvm-dlc-demo "UTXORef BitVM/DLC Lightning receipt")"
BOLT11="$(printf '%s' "$INVOICE" | json_value bolt11)"
PAYMENT_HASH="$(printf '%s' "$INVOICE" | json_value payment_hash)"
PAYMENT="$("${LN_ALICE[@]}" pay "$BOLT11")"
PAYMENT_STATUS="$(printf '%s' "$PAYMENT" | json_value status)"
PAYMENT_PREIMAGE="$(printf '%s' "$PAYMENT" | json_value payment_preimage)"

BLOCK_HEIGHT="$("${BTC_CLI[@]}" getblockcount)"
BITCOIN_VERSION="$(bitcoind --version | head -1)"
CLN_VERSION="$(lightningd --version)"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SUMMARY_JSON="$ARTIFACT_DIR/cln_regtest_demo_latest.json"
SUMMARY_MD="$ARTIFACT_DIR/cln_regtest_demo_latest.md"

export CREATED_AT BASE RUN RPC_PORT ALICE_PORT BOB_PORT ALICE_ID BOB_ID ALICE_ADDR
export ALICE_FUNDING_TXID CHANNEL_TXID CHANNEL_AMOUNT INVOICE_AMOUNT BOLT11 PAYMENT_HASH
export PAYMENT_STATUS PAYMENT_PREIMAGE BLOCK_HEIGHT BITCOIN_VERSION CLN_VERSION SUMMARY_JSON SUMMARY_MD

python3 <<'PY'
import json
import os
from pathlib import Path

summary = {
    "createdAt": os.environ["CREATED_AT"],
    "network": "regtest",
    "base": os.environ["BASE"],
    "runDir": os.environ["RUN"],
    "bitcoin": {
        "version": os.environ["BITCOIN_VERSION"],
        "rpcPort": int(os.environ["RPC_PORT"]),
        "blockHeight": int(os.environ["BLOCK_HEIGHT"]),
    },
    "coreLightning": {
        "version": os.environ["CLN_VERSION"],
        "alice": {
            "id": os.environ["ALICE_ID"],
            "port": int(os.environ["ALICE_PORT"]),
            "cli": f'lightning-cli --lightning-dir="{os.environ["RUN"]}/alice" --network=regtest',
        },
        "bob": {
            "id": os.environ["BOB_ID"],
            "port": int(os.environ["BOB_PORT"]),
            "cli": f'lightning-cli --lightning-dir="{os.environ["RUN"]}/bob" --network=regtest',
        },
    },
    "onchainFunding": {
        "aliceAddress": os.environ["ALICE_ADDR"],
        "fundingTxid": os.environ["ALICE_FUNDING_TXID"],
    },
    "channel": {
        "txid": os.environ["CHANNEL_TXID"],
        "amount": os.environ["CHANNEL_AMOUNT"],
        "state": "CHANNELD_NORMAL",
    },
    "payment": {
        "invoiceAmount": os.environ["INVOICE_AMOUNT"],
        "bolt11": os.environ["BOLT11"],
        "paymentHash": os.environ["PAYMENT_HASH"],
        "status": os.environ["PAYMENT_STATUS"],
        "paymentPreimage": os.environ["PAYMENT_PREIMAGE"],
    },
    "commands": {
        "loadEnv": f'source "{os.environ["RUN"]}/env.sh"',
        "aliceInfo": f'lightning-cli --lightning-dir="{os.environ["RUN"]}/alice" --network=regtest getinfo',
        "bobInvoices": f'lightning-cli --lightning-dir="{os.environ["RUN"]}/bob" --network=regtest listinvoices',
        "aliceChannels": f'lightning-cli --lightning-dir="{os.environ["RUN"]}/alice" --network=regtest listpeerchannels',
    },
}

Path(os.environ["SUMMARY_JSON"]).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

md = f"""# Core Lightning Regtest Demo

Created: {summary["createdAt"]}

## Live Nodes

- Bitcoin: {summary["bitcoin"]["version"]}
- Core Lightning: {summary["coreLightning"]["version"]}
- Network: regtest
- Block height: {summary["bitcoin"]["blockHeight"]}
- Run directory: `{summary["runDir"]}`

## Channel

- Alice id: `{summary["coreLightning"]["alice"]["id"]}`
- Bob id: `{summary["coreLightning"]["bob"]["id"]}`
- Alice funding txid: `{summary["onchainFunding"]["fundingTxid"]}`
- Channel txid: `{summary["channel"]["txid"]}`
- Channel state: {summary["channel"]["state"]}
- Channel amount: {summary["channel"]["amount"]}

## Payment Receipt

- Invoice amount: {summary["payment"]["invoiceAmount"]}
- Payment status: {summary["payment"]["status"]}
- Payment hash: `{summary["payment"]["paymentHash"]}`
- Payment preimage: `{summary["payment"]["paymentPreimage"]}`
- BOLT11: `{summary["payment"]["bolt11"]}`

## Useful Commands

```bash
source "{summary["runDir"]}/env.sh"
lightning-cli --lightning-dir="{summary["runDir"]}/alice" --network=regtest getinfo
lightning-cli --lightning-dir="{summary["runDir"]}/alice" --network=regtest listpeerchannels
lightning-cli --lightning-dir="{summary["runDir"]}/bob" --network=regtest listinvoices
```
"""
Path(os.environ["SUMMARY_MD"]).write_text(md, encoding="utf-8")
PY

echo "[cln-regtest] wrote $SUMMARY_JSON"
echo "[cln-regtest] wrote $SUMMARY_MD"
echo "[cln-regtest] Alice CLI: ${LN_ALICE[*]} getinfo"
echo "[cln-regtest] Bob CLI: ${LN_BOB[*]} listinvoices"
