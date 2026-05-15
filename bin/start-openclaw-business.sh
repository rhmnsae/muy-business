#!/usr/bin/env bash
set -euo pipefail
export OPENCLAW_HOME="$HOME/openclaw-business"
if [ -f "$OPENCLAW_HOME/.openclaw/.env" ]; then
  set -a
  source "$OPENCLAW_HOME/.openclaw/.env"
  set +a
fi
exec openclaw gateway --port 18790 "$@"
