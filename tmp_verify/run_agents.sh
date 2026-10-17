#!/usr/bin/env bash
# Launch the Python agents-service for local P3 differential verification.
# Secrets are injected in-process only: PLATFORM_DB_URL / VERIFY_MYSQL_PW come
# from spire_db_env.sh (Windows User env). AGENT_INTERNAL_SECRET / JWT_SECRET
# are local verification values, never production secrets, and never on a
# command line.
#
# Usage: bash tmp_verify/run_agents.sh <port>
set -euo pipefail

PORT="${1:?usage: run_agents.sh <port>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BETA="${BETA_ROOT:-/d/cangjie/ITN-Beta}"
AGENTS_DIR="$BETA/src/agents"

# shellcheck source=spire_db_env.sh
. "$HERE/tmp_verify/spire_db_env.sh"

# Local verification secrets only — NOT production secrets.
export JWT_SECRET="${JWT_SECRET:-KNOWNSECRET20CHARSXX}"
export AGENT_INTERNAL_SECRET="${AGENT_INTERNAL_SECRET:-VERIFYINTERNALSECRET32CHARSXXXXXX}"
export PLATFORM_DB_URL
# Keep it off real model calls: the provider's mock path answers without keys.
export LLM_PROVIDER="${LLM_PROVIDER:-mock}"
export API_HOST="127.0.0.1"
export API_PORT="$PORT"
export PRESENTATION_OUTPUT_DIR="${PRESENTATION_OUTPUT_DIR:-$HERE/tmp_verify/ppt_out}"

cd "$AGENTS_DIR"
mkdir -p "$HERE/tmp_verify/logs"
LOG="$HERE/tmp_verify/logs/agents_${PORT}.out"
echo "==> agents :${PORT}  log=${LOG}"
nohup python main.py > "$LOG" 2>&1 &
echo "   pid $!"
