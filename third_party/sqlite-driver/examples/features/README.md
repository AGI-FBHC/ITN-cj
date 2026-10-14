# SQL 功能矩阵

## 作用

在真实磁盘数据库上执行 45 组确定性用例，覆盖存储类型、DDL、DML、表达式、函数、聚合、连接、
集合运算、子查询、CTE、窗口函数、事务、外键、触发器、视图、PRAGMA、BLOB、WAL 和 `VACUUM`。

程序输出采用稳定格式。`run.sh` 会把完整输出与仓库中的 `expected.txt` 逐行比对，因此不是只判断
进程能否结束，而是判断每条 SQL 的实际结果是否符合预期。

## 运行

先按 [env/README.md](../../env/README.md) 配置环境，然后：

```bash
cd sqlite-driver/examples/features
./run.sh
```

如需保留数据库自行检查，可直接运行：

```bash
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run --run-args="/tmp/sqlite-driver-features.db"
```

## 结果判定

`run.sh` 成功时输出：

```text
PASS: SQL feature matrix matches expected output
```

任何输出行与 `expected.txt` 不同都会显示 unified diff，并以非零状态退出。程序异常、数据库损坏
或构建失败也会直接使脚本失败。
