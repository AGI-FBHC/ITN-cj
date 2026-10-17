#!/usr/bin/env bash
# Server-side deploy for itn_spire (Cangjie Spire).
#
# Usage (on the server):
#   cd <your-project-dir> && bash deploy/deploy.sh
#
# Expects:
#   - this directory is a git clone of the ITN-Beta repo, branch itn-spire
#   - Cangjie SDK + STDX installed and CANGJIE_STDX_PATH set in the environment
#   - JWT_SECRET / PLATFORM_DB_URL / SPIRE_HTTP_URL exported (never committed)
#
# No secrets are read into logs or written to disk by this script.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
mkdir -p logs

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> branch: $BRANCH"
if [ "$BRANCH" != "itn-spire" ]; then
    echo "!! expected branch itn-spire, got $BRANCH" >&2
    exit 1
fi

echo "==> pull"
git pull --ff-only

echo "==> env check (presence + length only, values never printed)"
missing=0
for v in JWT_SECRET PLATFORM_DB_URL SPIRE_HTTP_URL; do
    val="${!v:-}"
    if [ -n "$val" ]; then
        echo "   $v: set (len=${#val})"
    else
        echo "   $v: MISSING"
        missing=1
    fi
done
if [ -z "${CANGJIE_STDX_PATH:-}" ]; then
    echo "   CANGJIE_STDX_PATH: MISSING (point it at the STDX static dir)" >&2
    missing=1
else
    echo "   CANGJIE_STDX_PATH: set"
fi
if [ "$missing" -ne 0 ]; then
    echo "!! export the variables above before deploying" >&2
    exit 1
fi

echo "==> build"
cjpm build

BIN=""
for c in target/release/bin/main target/release/bin/itn_spire target/debug/bin/main; do
    if [ -x "$c" ]; then BIN="$c"; break; fi
done
if [ -z "$BIN" ]; then
    echo "!! built binary not found under target/" >&2
    find target -maxdepth 3 -type f -perm -u+x 2>/dev/null | head -20 >&2
    exit 1
fi
echo "==> binary: $BIN"

# Drop any previous instance of this binary, then start fresh.
pkill -f "/itn_spire/$BIN" 2>/dev/null || true
pkill -f "$HERE/$BIN" 2>/dev/null || true
sleep 1

echo "==> start"
nohup "$BIN" > logs/spire.out 2>&1 &
echo "   pid $! -> logs/spire.out"
sleep 2

echo "==> health"
curl -fsS "${SPIRE_HTTP_URL%/}/health" && echo
echo "==> deploy done"
