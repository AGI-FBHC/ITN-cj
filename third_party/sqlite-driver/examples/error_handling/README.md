# 异常分类与不支持的用法

演示驱动抛出的六种异常各自的触发路径、可读取的字段以及统一的消息格式。

## 作用

驱动把失败分成六个异常类型，而不是让调用方去匹配错误文本：

| 异常类型 | 特有字段 | 消息前缀 |
| --- | --- | --- |
| `SqliteSyntaxException` | `position` | `sqlite syntax error at offset N: ` |
| `SqliteConstraintException` | `constraint`、`table` | `sqlite constraint failed [<constraint>]: ` |
| `SqliteRuntimeException` | `kind` | `sqlite <kind> error: ` |
| `SqliteBusyException` | — | `sqlite busy: ` |
| `SqliteInterruptedException` | — | `sqlite interrupted: ` |
| `SqliteFormatException` | — | `sqlite format error: ` |

六者都继承 `std.database.sql.SqlException`，所以适配层可以在边界只捕一次，而需要区分处置时再按
具体类型分支。本示例对每条失败路径都断言异常类型、特有字段与消息特征。

## 覆盖的功能

### `SqliteSyntaxException`

- `position` 指向出错处的字节偏移：未知语句报 0、缺右括号报文本末尾、`?0` 报参数记号自身的位置；
- 明确拒绝的语法：`ATTACH`、裸 `EXPLAIN`（提示改用 `EXPLAIN QUERY PLAN`）、`CREATE VIRTUAL TABLE`、
  `CREATE TEMP TABLE`、`GENERATED ALWAYS AS` 生成列、`VACUUM INTO`、`INSERT OR FAIL`、
  `INSERT OR ROLLBACK`、外键的 `MATCH FULL` 与 `MATCH PARTIAL`、`ALTER TABLE ... DROP COLUMN IF EXISTS`。

### `SqliteConstraintException`

- `constraint` 的取值：`unique`、`notnull`、`check`、`primarykey`、`datatype`、`foreignkey`；
- 触发器 `RAISE(ABORT, …)` 与 `RAISE(FAIL, …)` 抛出的 `trigger` 冲突，此时 `table` 为空串；
- 冲突之后表内容不变。

### `SqliteRuntimeException`

- `bind`：参数索引越界、绑定不支持的类型、参数个数少于占位符个数；
- `result`：请求不支持的结果类型、用非可空读法读 SQL NULL；
- `dsn`：未知连接串参数、页大小不是 2 的幂、页大小超出 512..65536、负的 `busy_timeout`；
- `state`：无事务时 `COMMIT`、事务中修改 `PRAGMA foreign_keys`；
- `sql`：未知函数、未知列、未知表；
- `collation`：未知排序规则；
- `schema`：`ALTER TABLE ADD COLUMN` 带 `UNIQUE`；
- `pragma`：`journal_mode` 设为 `off` 或 `memory`；
- `statement` / `connection` / `exec`：在已关闭的语句、连接上继续操作，以及不支持的语句选项。

### `SqliteBusyException`

一条连接 `BEGIN IMMEDIATE` 后持有写锁，另一条把 `busy_timeout` 设为 20 毫秒的连接写同一个文件库，
等待超时后抛出；回滚后数据保持原值。

### `SqliteInterruptedException`

- `Statement.setOption("timeout_ms", "1")` 后执行交叉连接查询触发超时；
- 另一个线程执行查询时调用 `SqliteStatement.cancel()` 取消。

### `SqliteFormatException`

打开一个内容为普通文本的文件，文件头解析在魔数处失败。

### 统一兜底

同一段 `catch (e: SqlException)` 依次接住语法、约束与运行期三类失败，并核对各自的消息前缀。

## 运行

不需要命令行参数。示例会在系统临时目录下建一个临时目录存放文件库与损坏文件，结束前整个删除。

```bash
cd sqlite-driver/examples/error_handling
export cjHeapSize=1gb
# 先按 ../../env/README.md 配置 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run
```

## 结果判定

每通过一项检查打印一行 `PASS: <检查名>`，例如：

```text
PASS: rejected syntax: ATTACH
PASS: UNIQUE constraint
PASS: write contention reports busy
PASS: temporary files removed
```

全部通过时最后一行为：

```text
PASS: error handling example (58 checks)
```

退出码为 `0`。任一检查失败时输出 `FAIL: <原因>`，退出码为 `1`。
