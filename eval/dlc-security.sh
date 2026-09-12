#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
node eval/dlc_security_eval.js --profile="${EVAL_PROFILE:-full}" --seed="${EVAL_SEED:-3549216002}"

