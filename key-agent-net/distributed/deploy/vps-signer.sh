#!/usr/bin/env bash
# KeyAgentNet Custodian A on a Linux VPS. Run as root (sudo). Regtest only.
#
#   vps-signer.sh init <code-dir>        account, private regtest Core, wallet, TLS key; prints identity
#   vps-signer.sh install-policy <policy.json> <client-ca.pem>   pin policy + coordinator CA, (re)start
#   vps-signer.sh start|stop|kill|status
#   vps-signer.sh install-gate <kan-payment-gate>  install the payment gate binary (payment-gated policies)
#   vps-signer.sh bypass-sign <psbt>     admin-level signing that skips the service (collusion test)
#   vps-signer.sh destroy                stop everything and delete the account, keys and journal
#
# Bitcoin Core comes from /usr/local/bin. On a host where it lives elsewhere (a root-only
# directory, as in a WSL distribution), set KAN_BITCOIN_SRC=<dir> for `init`, which installs
# copies of bitcoind and bitcoin-cli under the code directory.
#
# Layout: code /opt/kan-signer (root), config /etc/kan-signer (root, TLS key group-readable by
# the service), state /var/lib/kan-signer (service account only). The signer binds 127.0.0.1.
set -euo pipefail
USER_NAME=kansigner
CODE=/opt/kan-signer
CONF=/etc/kan-signer
STATE=/var/lib/kan-signer
RPCPORT=18998
BIND=127.0.0.1:18999
BIN=/usr/local/bin
[ -x "$CODE/bin/bitcoind" ] && BIN=$CODE/bin
GATE=$CODE/kan-payment-gate
CLI=($BIN/bitcoin-cli -datadir=$STATE/core -regtest -rpcport=$RPCPORT)
as_signer() { runuser -u "$USER_NAME" -- "$@"; }

units() {
  cat > /etc/systemd/system/kan-bitcoind.service <<EOF
[Unit]
Description=KeyAgentNet Custodian A private regtest Core
[Service]
User=$USER_NAME
ExecStart=$BIN/bitcoind -regtest -datadir=$STATE/core -server=1 -listen=0 -connect=0 -dnsseed=0 -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport=$RPCPORT -printtoconsole=0
ExecStop=${CLI[*]} stop
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$STATE
[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/kan-signer.service <<EOF
[Unit]
Description=KeyAgentNet Custodian A signer
Requires=kan-bitcoind.service
After=kan-bitcoind.service
[Service]
User=$USER_NAME
ExecStart=/usr/bin/python3 $CODE/kan_signer.py --config $CONF/signer.json
Restart=always
RestartSec=1
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$STATE
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

wait_core() {
  for _ in $(seq 1 60); do as_signer "${CLI[@]}" getblockchaininfo >/dev/null 2>&1 && return 0; sleep 0.5; done
  echo "private regtest Core did not start" >&2; return 1
}

case "${1:-}" in
  init)
    src="${2:?code dir}"
    id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin "$USER_NAME"
    install -d -m 0755 -o root -g root "$CODE"
    install -m 0644 -o root -g root "$src/kan_signer.py" "$src/kan_policy.py" "$CODE/"
    if [ -n "${KAN_BITCOIN_SRC:-}" ]; then
      install -d -m 0755 -o root -g root "$CODE/bin"
      install -m 0755 -o root -g root "$KAN_BITCOIN_SRC/bitcoind" "$KAN_BITCOIN_SRC/bitcoin-cli" "$CODE/bin/"
      BIN=$CODE/bin
      CLI=($BIN/bitcoin-cli -datadir=$STATE/core -regtest -rpcport=$RPCPORT)
    fi
    install -d -m 0750 -o root -g "$USER_NAME" "$CONF"
    install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$STATE" "$STATE/core"
    units
    systemctl start kan-bitcoind
    wait_core
    as_signer "${CLI[@]}" listwallets | grep -q '"custodian-a"' || as_signer "${CLI[@]}" createwallet custodian-a false false "" false true >/dev/null
    if [ ! -f "$CONF/server.key" ]; then
      openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 30 -subj "/CN=kan-signer-a" \
        -keyout "$CONF/server.key" -out "$CONF/server.crt" 2>/dev/null
      chown root:"$USER_NAME" "$CONF/server.key"; chmod 0640 "$CONF/server.key"; chmod 0644 "$CONF/server.crt"
    fi
    desc=$(as_signer "${CLI[@]}" -rpcwallet=custodian-a listdescriptors | python3 -c '
import json,sys
for d in json.load(sys.stdin)["descriptors"]:
    if d.get("active") and not d.get("internal") and d["desc"].startswith("wpkh("):
        print(d["desc"][5:].split("/0/*")[0]); break')
    python3 - "$desc" "$CONF/server.crt" <<'PY'
import json, sys
key, cert = sys.argv[1], open(sys.argv[2]).read()
print(json.dumps({"xpub": key, "fingerprint": key[1:9], "server_cert": cert}))
PY
    ;;
  install-policy)
    install -m 0644 -o root -g root "${2:?policy}" "$CONF/policy.json"
    install -m 0644 -o root -g root "${3:?client ca}" "$CONF/client-ca.pem"
    cat > "$CONF/signer.json" <<EOF
{"bitcoin_cli": "$BIN/bitcoin-cli", "payment_gate_bin": "$([ -x "$GATE" ] && echo "$GATE")", "datadir": "$STATE/core", "rpcport": $RPCPORT, "wallet": "custodian-a",
 "policy": "$CONF/policy.json", "journal": "$STATE/journal.jsonl", "bind": "$BIND",
 "tls_cert": "$CONF/server.crt", "tls_key": "$CONF/server.key", "client_ca": "$CONF/client-ca.pem"}
EOF
    chmod 0644 "$CONF/signer.json"
    systemctl restart kan-signer
    for _ in $(seq 1 40); do ss -ltn | grep -q "$BIND" && { echo "signer up"; exit 0; }; sleep 0.25; done
    journalctl -u kan-signer -n 20 --no-pager >&2; exit 1
    ;;
  install-gate)
    install -m 0755 -o root -g root "${2:?kan-payment-gate binary}" "$GATE"
    "$GATE" inspect --statement /dev/null >/dev/null 2>&1 || [ $? -eq 1 ] || { echo "payment gate does not run" >&2; exit 1; }
    sha256sum "$GATE"
    ;;
  start) systemctl start kan-bitcoind kan-signer ;;
  stop) systemctl stop kan-signer ;;
  kill) systemctl kill -s KILL kan-signer ;;
  status)
    systemctl show -p ActiveState -p NRestarts -p MainPID kan-signer
    [ -f "$STATE/journal.jsonl" ] && wc -l < "$STATE/journal.jsonl" || echo 0
    ;;
  bypass-sign)
    as_signer "${CLI[@]}" -rpcwallet=custodian-a walletprocesspsbt "${2:?psbt}" true ALL true false
    ;;
  journal) cat "$STATE/journal.jsonl" ;;
  destroy)
    systemctl stop kan-signer kan-bitcoind 2>/dev/null || true
    systemctl disable kan-signer kan-bitcoind 2>/dev/null || true
    rm -f /etc/systemd/system/kan-signer.service /etc/systemd/system/kan-bitcoind.service
    systemctl daemon-reload
    rm -rf "$CODE" "$CONF" "$STATE"
    id "$USER_NAME" >/dev/null 2>&1 && userdel "$USER_NAME"
    echo destroyed
    ;;
  *) sed -n 2,10p "$0"; exit 2 ;;
esac
