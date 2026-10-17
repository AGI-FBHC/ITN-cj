#!/usr/bin/env bash
# Launch Spire for local verification. Secrets are injected in-process only:
# PLATFORM_DB_URL / VERIFY_MYSQL_PW come from spire_db_env.sh (Windows User
# env), never from this file and never from a command line.
#
# Usage: bash tmp_verify/run_spire.sh <port>
set -euo pipefail

PORT="${1:?usage: run_spire.sh <port>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# shellcheck source=spire_db_env.sh
. tmp_verify/spire_db_env.sh

# Local verification JWT secret only — NOT a production secret.
export JWT_SECRET="${JWT_SECRET:-KNOWNSECRET20CHARSXX}"
export SPIRE_HTTP_URL="http://127.0.0.1:${PORT}"
# The matrix seeds PPTX fixtures here; the service must resolve them from the
# same root or download returns "Presentation file is missing".
export PRESENTATION_OUTPUT_DIR="${PRESENTATION_OUTPUT_DIR:-$HERE/tmp_verify/ppt_out}"

BIN="$HERE/target/release/bin/main.exe"
[ -x "$BIN" ] || { echo "!! binary missing: $BIN" >&2; exit 1; }

mkdir -p tmp_verify/logs
LOG="tmp_verify/logs/spire_${PORT}.out"
echo "==> spire :${PORT}  output_dir=${PRESENTATION_OUTPUT_DIR}  log=${LOG}"
nohup "$BIN" > "$LOG" 2>&1 &
echo "   pid $!"
