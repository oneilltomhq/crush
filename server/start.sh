#!/usr/bin/env bash
# Start the crush agent server.
#
# Usage:
#   ./server/start.sh              # warm start (uses ~/.crush/profile/)
#   ./server/start.sh --cold       # cold start (empty temp profile dir)
#   ./server/start.sh --profile /path/to/dir  # custom profile dir
#
# Loads .env automatically. All env vars can still be overridden inline:
#   OPENROUTER_API_KEY=sk-xxx ./server/start.sh

set -euo pipefail
cd "$(dirname "$0")/.."  # project root

# --- Load .env (without clobbering vars already set in the environment) ---
if [[ -f .env ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    # Only set if not already exported
    if [[ -z "${!key+x}" ]]; then
      export "$key=$value"
    fi
  done < .env
fi

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case $1 in
    --cold)
      export CRUSH_PROFILE_DIR=$(mktemp -d /tmp/crush-cold-XXXXXX)
      echo "Cold start: profile dir = $CRUSH_PROFILE_DIR"
      shift ;;
    --profile)
      export CRUSH_PROFILE_DIR="$2"
      mkdir -p "$CRUSH_PROFILE_DIR"
      echo "Custom profile dir: $CRUSH_PROFILE_DIR"
      shift 2 ;;
    -h|--help)
      sed -n '2,/^$/s/^# \?//p' "$0"
      exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- Logging ---
LOG_DIR="server/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y%m%d-%H%M%S).log"
echo "Logging to $LOG_FILE"

exec npx tsx server/agent-server.ts 2>&1 | tee "$LOG_FILE"
