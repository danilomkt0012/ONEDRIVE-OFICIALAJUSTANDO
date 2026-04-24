#!/usr/bin/env bash
# Thin shim — delegates to the canonical supervisor in scripts/start_tts.sh.
exec bash "$(dirname "$0")/../../scripts/start_tts.sh" "$@"
