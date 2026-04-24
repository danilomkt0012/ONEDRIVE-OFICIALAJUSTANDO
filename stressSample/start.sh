#!/usr/bin/env bash
set -a
source "$(dirname "$0")/.env"
set +a

cd "$(dirname "$0")"
npm install axios 2>/dev/null
echo "$(date -Iseconds)"
node index.js
