#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [[ -z "${CANGJIE_STDX_PATH:-}" && -f "$ROOT/env/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/env/.env"
    set +a
fi
: "${CANGJIE_STDX_PATH:?请设置 CANGJIE_STDX_PATH，或在 env/.env 中配置；参见 env/README.md}"
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"

run_project() {
    local project="$1"
    local expected="$2"
    shift 2
    echo "==> ${project}"
    local output
    if ! output="$(cd "$HERE/${project}" && cjpm build >/dev/null && cjpm test >/dev/null &&
        ./target/release/bin/main "$@" 2>&1)"; then
        printf '%s\n' "$output" >&2
        return 1
    fi
    printf '%s\n' "$output"
    if [[ "$output" != *"$expected"* ]]; then
        echo "FAIL: ${project} 未打印成功标记" >&2
        return 1
    fi
}

run_project basic "PASS: basic example"
run_project standard_api "PASS: standard API example"
run_project data_types "PASS: data types example"
run_project transactions "PASS: transactions example"
run_project advanced_sql "PASS: advanced SQL example"
run_project error_handling "PASS: error handling example"

file_work="$(mktemp -d "${TMPDIR:-/tmp}/sqlite-driver-example.XXXXXX")"
trap 'rm -rf "$file_work"' EXIT
run_project file_database "PASS: file database example" "$file_work/file.db"
run_project schema_metadata "PASS: schema metadata example" "$file_work/schema.db"
run_project concurrency "PASS: concurrency example" "$file_work/concurrency.db"

echo "==> features"
if ! feature_output="$(cd "$HERE/features" && cjpm test >/dev/null && ./run.sh 2>&1)"; then
    printf '%s\n' "$feature_output" >&2
    exit 1
fi
printf '%s\n' "$feature_output"
if [[ "$feature_output" != *"PASS: SQL feature matrix matches expected output"* ]]; then
    echo "FAIL: features 未打印成功标记" >&2
    exit 1
fi
echo "PASS: all sqlite-driver examples"
