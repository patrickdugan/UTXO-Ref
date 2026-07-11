#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/utxoref-v2-watchtower}"
STATE_DIR="${STATE_DIR:-/var/lib/utxoref-v2-watchtower}"
ENV_FILE="${ENV_FILE:-/etc/utxoref-v2-watchtower.env}"
SERVICE_FILE="${APP_DIR}/deploy/utxoref-v2-watchtower.service"

if [[ ! -f "${APP_DIR}/utxoref_v2_watchtower.js" ]]; then
  echo "Missing watcher application at ${APP_DIR}" >&2
  exit 1
fi

if ! id -u utxoref >/dev/null 2>&1; then
  sudo useradd --system --home-dir "${STATE_DIR}" --create-home --shell /usr/sbin/nologin utxoref
fi

sudo install -d -o utxoref -g utxoref -m 0750 "${STATE_DIR}"
sudo install -m 0644 "${SERVICE_FILE}" /etc/systemd/system/utxoref-v2-watchtower.service

if [[ ! -f "${ENV_FILE}" ]]; then
  sudo install -m 0600 "${APP_DIR}/deploy/utxoref-v2-watchtower.env.example" "${ENV_FILE}"
  echo "Created ${ENV_FILE}; set dedicated RPC credentials before enabling the service." >&2
fi

sudo systemctl daemon-reload
echo "Installed. Activate with: sudo systemctl enable --now utxoref-v2-watchtower.service"
