# Changelog

## 未发布

- Implementation Note：公开桥接函数 `valueFromSqlite` / `valueFromSqliteOrNull` 已由泛型壳
  重构为 13 个非可空具名函数（`valueFromSqliteBool` / ... / `valueFromSqliteByteBuffer`）
  与 13 个可空具名函数（`valueFromSqliteOrNullBool` / ... / `valueFromSqliteOrNullByteBuffer`），
  共 26 条；运行期类型分派由 `std.reflect.TypeInfo` 字符串比较改为 `is` / `as` 运行期类型归属
  判定，详见 `docs/limitations.md` 的"路径 D 与接口类型 `T`"段。
- 修复：DELETE 日志模式下另一进程的提交对已打开的连接永不可见。页缓存现按主库文件头的
  change counter 失效，脏页保留。
- 修复：提交时第 1 页（承载 change counter）改为在全部数据页与文件扩展之后写出，并在其前
  插入一次 flush。此前另一进程可能在数据页仍为旧内容时读到新 counter，将旧页当作最新内容
  缓存并更新基线，此后不再失效。
- 修复：WAL 重扫此前只比较文件长度。帧为定长，`RESTART` 后追加相同帧数会得到相同长度，
  导致另一进程沿用上一代索引而静默读到错页。现同时比较 WAL 头的 salt 与 checkpoint 序号。

## 0.1.0 - 2026-08-14

- 提供纯仓颉 SQLite 驱动与数据库引擎，可直接读写 SQLite 3 文件格式。
- 提供 `std.database.sql` 接口和 `SqliteValue`、`SqliteDSN`、`SqliteConn` 原生接口。
- 支持事务、保存点、语句级回滚、回滚日志、WAL、检查点、文件恢复与完整性检查。
- 支持常用 DDL、DML、CTE、窗口函数、JSON、触发器、外键、视图和 PRAGMA。
- 支持 `WITHOUT ROWID`、`RETURNING`、`ALTER TABLE ... DROP COLUMN`、`VACUUM` 与执行计划查询。
- `ALTER TABLE ... ADD COLUMN` 对已有行按列 DEFAULT（经亲和性转换）补齐。
- 完善主键约束、日期时间转换、命名窗口与文件格式兼容性。
