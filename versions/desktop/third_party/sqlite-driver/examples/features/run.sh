#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sqlite-driver-features.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

if [[ -z "${CANGJIE_STDX_PATH:-}" && -f "$ROOT/env/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/env/.env"
    set +a
fi
: "${CANGJIE_STDX_PATH:?请设置 CANGJIE_STDX_PATH，或在 env/.env 中配置；参见 env/README.md}"
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"

cd "$HERE"
cjpm build
"$HERE/target/release/bin/main" "$WORK_DIR/features.db" >"$WORK_DIR/actual.txt"

if ! diff -u "$HERE/expected.txt" "$WORK_DIR/actual.txt"; then
    echo "FAIL: features 输出与 expected.txt 不一致" >&2
    exit 1
fi
echo "PASS: SQL feature matrix matches expected output"
