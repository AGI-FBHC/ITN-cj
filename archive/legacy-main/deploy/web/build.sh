#!/usr/bin/env bash
# Build both Cangjie services from a source checkout and place binaries for compose.
# Usage: bash deploy/web/build.sh [repository-root]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-$(cd "$HERE/../.." && pwd)}"

for project in "$SRC/services/api" "$SRC/services/business"; do
    test -f "$project/cjpm.toml" || { echo "Missing Cangjie project: $project" >&2; exit 1; }
done

build_one() {
    local dir="$1"
    local image="$2"
    docker run --rm --name "itn-cj-build-$(basename "$dir")" \
        --cpus=1.5 --memory=1536m --memory-swap=1536m --pids-limit=256 \
        -v "$dir:/workspace" "$image" \
        bash -lc 'source /opt/cangjie/envsetup.sh; export CANGJIE_STDX_PATH=/opt/stdx/linux_x86_64_cjnative/static/stdx; export LD_LIBRARY_PATH=/opt/stdx/linux_x86_64_cjnative/dynamic/stdx:$LD_LIBRARY_PATH; cd /workspace; cjpm build -i -j1'
}

echo "==> build api"
build_one "$SRC/services/api" itn-cangjie-sdk:1.1.3
echo "==> build business"
build_one "$SRC/services/business" itn-cangjie-sdk:1.1.3-mysql

mkdir -p "$HERE/app/api" "$HERE/app/business"
cp "$SRC/services/api/target/release/bin/main" "$HERE/app/api/main"
cp "$SRC/services/business/target/release/bin/main" "$HERE/app/business/main"
chmod 755 "$HERE/app/api/main" "$HERE/app/business/main"
echo "==> binaries ready"
ls -l "$HERE/app/api/main" "$HERE/app/business/main"
