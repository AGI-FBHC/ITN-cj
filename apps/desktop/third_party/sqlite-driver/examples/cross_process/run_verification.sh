#!/usr/bin/env bash
#
# 跨进程可见性判据（D-SQLITE-1）。
#
# 判据本体：B 先开连接并读一次（把旧页钉进自己的缓存），A 之后在另一个进程里提交 —— B 必须
# 能读到 A 的提交。这一条在页缓存不做跨进程失效时永久不成立。
#
# 三个必须同时在的部分：
#   判据    B 先读后等，A 后写，B 必须看到（observe rc=0）
#   对照 1  A 先写、B 后开连接：这一种顺序即使有缺陷也是绿的，用来证明"能读到"不是判据
#           本身的功劳，而 B 先开连接那一轮才是有分辨力的那个顺序
#   对照 2  A 从不写：B 必须超时（rc=3），排除"observe 无论如何都返回 0"
#
# 退出码：0 全绿；1 有判据不成立；2 前提不成立（编不出、二进制找不到）。

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRIVER_ROOT="$(cd "$HERE/../.." && pwd)"
BIN="$HERE/target/release/bin/main"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# stdx 动态库路径，与 examples/run_all.sh 同一套解析顺序。
if [[ -z "${CANGJIE_STDX_PATH:-}" && -f "$DRIVER_ROOT/env/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$DRIVER_ROOT/env/.env"
    set +a
fi
: "${CANGJIE_STDX_PATH:?请设置 CANGJIE_STDX_PATH，或在 env/.env 中配置；参见 env/README.md}"
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"

OK=0
BAD=0
ok()  { printf '[OK] %s\n' "$1"; OK=$((OK + 1)); }
bad() { printf '[BAD] %s\n' "$1"; BAD=$((BAD + 1)); }

# 无条件重建：判据必须能说出跑的是哪一次构建的产物。手工跑单条命令绕过这一步，就会拿旧
# 二进制配新夹具，得到一个两向都不可信的结果。
printf '=== 基线构建 ===\n'
if ! (cd "$HERE" && cjHeapSize=1gb cjpm build >"$WORK/build.log" 2>&1); then
    printf '[FATAL] cjpm build 失败：\n'
    sed 's/\x1b\[[0-9;]*m//g' "$WORK/build.log" | grep -E "^error" | head -10
    exit 2
fi
[ -x "$BIN" ] || { printf '[FATAL] 找不到可执行文件 %s\n' "$BIN"; exit 2; }
printf '构建通过\n\n'

# ---------------------------------------------------------------------------
# 判据：B 先开连接读一次，A 后写，B 必须看到
# ---------------------------------------------------------------------------
printf '=== 判据 B先开连接 → A写 → B必须可见 ===\n'
DB="$WORK/main.db"
"$BIN" init "$DB" >/dev/null || { printf '[FATAL] init 失败\n'; exit 2; }

READY="$WORK/observe.ready"
"$BIN" observe "$DB" worker-a 8000 "$READY" >"$WORK/observe.log" 2>&1 &
OBS_PID=$!

# 等 observe 完成它的第一次读再让 A 写 —— 这是启动顺序的全部要点。
#
# 同步用的是 observe 落下的标记文件，不是 grep 它的 stdout：println 带缓冲，日志里那行
# OBSERVE_READY 要等进程退出才出现，而那时判据早跑完了。第一版就是这么写的，表现为
# "observe 从未打印 OBSERVE_READY"，而它其实打印了。
for _ in $(seq 1 200); do
    [ -f "$READY" ] && break
    sleep 0.05
done
if [ ! -f "$READY" ]; then
    kill "$OBS_PID" 2>/dev/null
    printf '[FATAL] observe 未落下就绪标记，判据前提不成立\n'
    cat "$WORK/observe.log"
    exit 2
fi

"$BIN" write "$DB" worker-a >"$WORK/write.log" 2>&1
WRC=$?
wait "$OBS_PID"; ORC=$?

cat "$WORK/write.log"
cat "$WORK/observe.log"

if [ "$WRC" != "0" ]; then
    bad "写入进程 rc=$WRC，判据前提不成立（不是缓存问题）"
elif [ "$ORC" = "0" ]; then
    ok "判据 B 先开连接仍读到 A 的提交（跨进程失效生效）"
elif [ "$ORC" = "3" ]; then
    bad "判据 B 永久读不到 A 的提交 —— D-SQLITE-1 仍成立"
else
    bad "判据 observe rc=$ORC（既非可见也非超时）"
fi

# ---------------------------------------------------------------------------
# 对照 1：A 先写、B 后开连接 —— 这一种顺序即使有缺陷也必须是绿的
# ---------------------------------------------------------------------------
printf '\n=== 对照1 A先写 → B后开连接（有缺陷时也绿，故不能当判据本体）===\n'
DB2="$WORK/order.db"
"$BIN" init "$DB2" >/dev/null
"$BIN" write "$DB2" worker-a >/dev/null 2>&1
"$BIN" observe "$DB2" worker-a 3000 >"$WORK/observe2.log" 2>&1
ORC2=$?
if [ "$ORC2" = "4" ]; then
    # observe 自己会拒绝这一轮：基线已经是期望值，它明说"该轮没有分辨力"
    ok "对照1 observe 主动判为无分辨力 (rc=4)，与判据轮的顺序差异被显式区分"
elif [ "$ORC2" = "0" ]; then
    ok "对照1 后开连接读到（预期；这一顺序不构成判据）"
else
    bad "对照1 rc=$ORC2 —— 连最容易的顺序都读不到，说明坏的不止缓存失效"
fi
sed 's/^/    /' "$WORK/observe2.log"

# ---------------------------------------------------------------------------
# 对照 2：A 从不写 —— B 必须超时，否则 observe 是恒真的
# ---------------------------------------------------------------------------
printf '\n=== 对照2 A从不写（observe 必须超时）===\n'
DB3="$WORK/nowrite.db"
"$BIN" init "$DB3" >/dev/null
"$BIN" observe "$DB3" worker-a 1500 >"$WORK/observe3.log" 2>&1
ORC3=$?
if [ "$ORC3" = "3" ]; then
    ok "对照2 无人写入时 observe 按预期超时 (rc=3)"
else
    bad "对照2 无人写入时 observe rc=$ORC3 —— 它并不真的在检查内容"
fi
sed 's/^/    /' "$WORK/observe3.log"

printf '\n结果：[OK] %d 项，[BAD] %d 项\n' "$OK" "$BAD"
[ "$BAD" = "0" ] || exit 1
exit 0
