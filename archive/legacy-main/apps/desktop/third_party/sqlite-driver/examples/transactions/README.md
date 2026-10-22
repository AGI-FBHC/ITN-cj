# 事务、保存点与隔离

在内存库上验证事务边界、保存点嵌套、事务属性取值以及出错时的回滚行为。

## 作用

事务的行为分布在两层：`std.database.sql` 的 `Transaction` 对象，以及 SQL 文本里的
`BEGIN` / `COMMIT` / `SAVEPOINT` 语句。本示例把两层都跑一遍，并逐项断言可见的结果，
包括约束违反、DDL 回滚与连接上的统计属性。

## 覆盖的功能

### A. 标准接口的 `Transaction`

- `connection.createTransaction()` 之后的 `begin()` / `commit()` / `rollback()`；
- 已结束的事务再次 `commit()` 或 `begin()` 被拒绝；
- `accessMode`、`deferrableMode`、`isoLevel` 的默认值 `Unspecified`，以及可接受取值
  `ReadWrite`、`NotDeferrable`、`Serializable`；
- 被拒绝的取值：只读访问、可延迟事务、`ReadCommitted` 与 `Snapshot` 隔离级别在 `begin()`
  时抛异常，且不留下活动事务，改回可接受取值后同一个对象仍可使用；
- `save(name)` / `rollback(name)` / `release(name)`，两层保存点嵌套与逐层部分回滚，
  以及已 `release` 的保存点不可再用；
- 同一个连接上同时开两个事务被拒绝，前一个事务结束后可以再开。

### B. SQL 层的事务语句

- `BEGIN`、`BEGIN DEFERRED`、`BEGIN IMMEDIATE`、`BEGIN EXCLUSIVE`，以及各自带
  `TRANSACTION` 关键字的写法；
- `COMMIT`、`COMMIT TRANSACTION`、`END`、`END TRANSACTION`；
- `ROLLBACK`、`ROLLBACK TRANSACTION`；
- `SAVEPOINT`、`ROLLBACK TO [SAVEPOINT]`、`RELEASE [SAVEPOINT]`（带与不带 `SAVEPOINT`
  关键字），`ROLLBACK TO` 保留保存点因而可重复回滚；
- 事务外的 `SAVEPOINT` 会开启事务，而 `RELEASE` 不结束它；
- 嵌套 `BEGIN`、无事务时的 `COMMIT` / `ROLLBACK` 均抛异常；
- `SqliteConn.inTransaction` 在事务内外的取值；
- `SqliteConn.changes`、`totalChanges`、`lastInsertRowid` 在事务中的取值，以及回滚不会
  把统计值减回去。

### C. 隐式事务与出错回滚

- 单条语句自行提交，执行前后都不处于事务中；
- 隐式事务里的批量 `INSERT` 撞到 `UNIQUE` 约束时整条语句的修改被回滚，表内数据不变；
- 显式事务里的语句失败后事务仍然活动，但失败语句自身的改动会被整体撤销；随后可继续写入并
  `COMMIT`，也可 `ROLLBACK` 整段事务，两条路径都有断言。

### D. 事务与约束

- `DEFERRABLE INITIALLY DEFERRED` 外键：事务内先插子行后插父行，提交成功；
- 只插子行时 `COMMIT` 抛 `SqliteConstraintException`（`foreignkey`），事务保持活动，
  `ROLLBACK` 之后数据一致；
- 事务内改 `PRAGMA foreign_keys` 抛 `SqliteRuntimeException`（`state`），设成当前值允许。

### E. 事务里的 DDL 与读一致性

- 事务内建表并写入的数据在事务内可见；
- 回滚后表不存在，访问它报 `no such table`；
- 提交后表与数据都保留。

## 运行

```bash
cd sqlite-driver/examples/transactions
export cjHeapSize=1gb
# 先按 ../../env/README.md 配置 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run
```

示例只用内存库 `:memory:`，不需要命令行参数、数据库文件或任何外部服务。

## 结果判定

每个检查通过时打印一行 `PASS: <检查名>`，例如：

```text
PASS: transaction commit
PASS: read-only access mode rejected
PASS: BEGIN EXCLUSIVE TRANSACTION commits
PASS: ROLLBACK TO SAVEPOINT reuses the savepoint
PASS: counters keep rolled-back statements
PASS: deferred foreign key checked at commit
PASS: rolled-back CREATE TABLE leaves no table
```

全部通过时最后一行为下面这句，退出码为 `0`：

```text
PASS: transactions example (77 checks)
```

任一断言不成立时程序输出 `FAIL: <原因>` 并以退出码 `1` 结束。
