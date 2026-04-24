#!/usr/bin/env bash
# Supervisor for the XTTS v2 microservice.
# - Bootstraps Python dependencies on every start (idempotent).
# - Restarts the service automatically on crash with back-off.
# - Logs crash reasons and restart count.
set -uo pipefail

export COQUI_TOS_AGREED=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TTS_MAIN="$SCRIPT_DIR/../server/tts_service/main.py"
INSTALL_SCRIPT="$SCRIPT_DIR/install_tts.sh"

RESTART_DELAY=2
MAX_RESTART_DELAY=30
restarts=0

echo "[start_tts] Bootstrap: ensuring TTS dependencies are installed…"
bash "$INSTALL_SCRIPT"

echo "[start_tts] Starting XTTS v2 microservice (PID: $$)…"

while true; do
    start_ts=$(date +%s)

    python3 "$TTS_MAIN"
    exit_code=$?

    end_ts=$(date +%s)
    uptime_s=$(( end_ts - start_ts ))

    restarts=$(( restarts + 1 ))
    echo "[start_tts] Process exited (code=$exit_code, uptime=${uptime_s}s, restart=#${restarts})."

    # Reset back-off if the process ran for more than 60 s (healthy run).
    if [ "$uptime_s" -gt 60 ]; then
        RESTART_DELAY=2
    fi

    echo "[start_tts] Restarting in ${RESTART_DELAY}s…"
    sleep "$RESTART_DELAY"

    # Exponential back-off, capped at MAX_RESTART_DELAY.
    RESTART_DELAY=$(( RESTART_DELAY * 2 ))
    if [ "$RESTART_DELAY" -gt "$MAX_RESTART_DELAY" ]; then
        RESTART_DELAY=$MAX_RESTART_DELAY
    fi
done
