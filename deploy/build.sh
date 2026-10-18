#!/usr/bin/env bash
# Build both Cangjie services from a source checkout and place binaries for compose.
# Usage: bash deploy/build.sh [source-dir]
set -euo pipefail

SRC="${1:-/home/ubuntu/itn-cangjie-src}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

build_one() {
    local dir="$1"
    local image="$2"
    docker run --rm --name "itn-cj-build-$(basename "$dir")" \
        --cpus=1.5 --memory=1536m --memory-swap=1536m --pids-limit=256 \
        -v "$dir:/workspace" "$image" \
        bash -lc 'source /opt/cangjie/envsetup.sh; export CANGJIE_STDX_PATH=/opt/stdx/linux_x86_64_cjnative/static/stdx; export LD_LIBRARY_PATH=/opt/stdx/linux_x86_64_cjnative/dynamic/stdx:$LD_LIBRARY_PATH; cd /workspace; cjpm build -i -j1'
}

echo "==> build api (zyq Spire service)"
build_one "$SRC" itn-cangjie-sdk:1.1.3
echo "==> build business (yjy backend)"
build_one "$SRC/backend-cj" itn-cangjie-sdk:1.1.3-mysql

mkdir -p "$HERE/app/api" "$HERE/app/business"
cp "$SRC/target/release/bin/main" "$HERE/app/api/main"
cp "$SRC/backend-cj/target/release/bin/main" "$HERE/app/business/main"
chmod 755 "$HERE/app/api/main" "$HERE/app/business/main"
echo "==> binaries ready"
ls -l "$HERE/app/api/main" "$HERE/app/business/main"