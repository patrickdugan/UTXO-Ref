#!/usr/bin/env bash
set -euo pipefail

node -e "const major=Number(process.versions.node.split('.')[0]); if (major < 18) throw new Error('Node.js 18+ required')"
