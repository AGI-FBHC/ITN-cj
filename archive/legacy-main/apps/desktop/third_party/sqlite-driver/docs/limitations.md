# 限制与注意事项

## 持久化保证

仓颉标准库当前未提供文件级 `fsync`。`sync=normal` 只把用户态缓冲提交给操作系统；进程崩溃后可
通过日志恢复，但掉电或内核崩溃可能丢失已提交数据。

`sync=full` 会额外尝试执行 `/bin/sync`。它同步整个系统而不是单个数据库文件，代价高，且不能提供
与文件级同步相同的完成保证。对掉电持久性有严格要求的系统，不应把当前实现作为唯一数据副本。

## 多进程与混合访问

本驱动使用 `<database>-cjflock` 文件协调多个本驱动写进程。`busy_timeout` 控制等待时间，Linux
等具有 `/proc` 的系统可识别已经退出的持锁进程并接管陈旧锁。

其他 SQLite 实现使用不同的文件锁协议，不会观察 `-cjflock`。因此：

- 可以在不同时间互相打开和修改同一数据库文件；
- 可以并发只读；
- 不得让本驱动与其他实现并发写同一个文件；
- 混合部署需要由应用提供唯一写者或外部互斥。

不提供 `/proc` 的平台无法可靠识别陈旧锁，异常退出后可能需要运维确认没有写者，再移除对应
`-cjflock` 文件。

## 内存与结果集

查询结果会完整物化为 `ArrayList<Array<SqliteValue>>`，标准 `QueryResult` 只在物化结果上移动游标。
流参数会先完整读入内存，流结果也基于已物化字节创建。因此应使用 `LIMIT`、分页或拆分对象控制单次
查询和 BLOB 大小。

页缓存可通过 `PRAGMA cache_size` 调整；设置过小会被提升到保障 B-tree 操作所需的最低页数。

## 未支持机制

当前明确拒绝或不实现：

- 虚表，包括 FTS 和 R-Tree；
- `ATTACH` / `DETACH` 和跨数据库语句；
- 临时表、生成列、`VACUUM INTO`；
- UTF-16 数据库文件；
- 裸 `EXPLAIN` 字节码，仅支持 SELECT 的 `EXPLAIN QUERY PLAN`；
- 增量 BLOB 句柄；
- `ANALYZE`、`REINDEX` 等未列入 [SQL 能力](./sql-support.md) 的维护语句；
- 多条 SQL 拼在一次 prepare 中执行。

未知 PRAGMA 会被忽略，调用方需要在启用关键配置后查询其值并确认结果。

## 行为注意点

- 标准接口的参数和列索引是 0 基；SQL 文本中的 `?1` 等显式参数编号仍遵循 SQLite 的 1 基语义；
- `UPDATE` / `DELETE ... ORDER BY ... LIMIT` 依赖发行构建选项，跨环境 SQL 建议使用子查询改写；
- 词法器允许较宽的标识符范围，本驱动接受的未加引号名称可能在更严格的解析器中被视为关键字；
- `WITHOUT ROWID` 表没有 `rowid`、`oid`、`_rowid_` 伪列，最后插入 rowid 也不会因其写入而改变；
- 一个连接上的语句会串行执行；需要独立并发事务时应创建不同连接；
- 关闭连接会回滚未提交事务，不会隐式提交；
- 递归 CTE 有硬上限 `1_000_000` 行，超过后抛运行期错误，避免无界递归耗尽内存；
- `ALTER TABLE ... ADD COLUMN` 的 DEFAULT 必须是常量；旧行读该列时按列的 DEFAULT（经亲和性转换）补齐；
- WAL 索引在本进程内存中维护，不共享 `-shm` 文件；跨进程写互斥依赖 `-cjflock`。

## 路径 D 与接口类型 `T`

标准 `QueryResult.get<T>` / `getOrNull<T>` 函数体内部以 `is` / `as` 做运行期类型归属判定。`as` 是
子类型判定而非精确类型相等：当 `T` 为不在 13 类支持类型之内的接口类型或 `Any` 时，会命中首个匹配
哨兵分支（按类型归属的最窄优先顺序——由 `get<T>` 函数体 `is` 哨兵 `if` 链的书写顺序决定，`Bool` 先于其它类型，故 `T = ToString` 命中首个探针分支
`SENTINEL_BOOL`——因 `Bool <: ToString` 首支即中，`SENTINEL_STRING` 分支对 `T = ToString` 不可达），
并按 `v` 形态走 `boolFromSqlite(v)`：

- `v` 为 Bool 可读形态（`SInt(1)`、`SReal` 非零、`SText` 的 `"true"`/`"1"`/`"yes"`/`"on"` 等）时
  返回该值经 `castTo<T>` 升格的结果（如 `Some(true as ToString)`）；
- `v` 为 `SText` 非 Bool 文本（如 `SText("hello")`）时抛
  `SqliteRuntimeException("result", "cannot parse '...' as Bool")`（非 `unsupported requested type`）；
- `v` 为 `SNull` 时 `getOrNull<T>` 短路返回 `None`、`get<T>` 抛 `SQL NULL cannot be read as Bool`；
- `v` 为 `SBlob` 时抛 `BLOB cannot be read as Bool`。

该角落与反射实现的"对不支持的 `T` 抛 `unsupported requested type`"行为不等价，但不触碰现有测试
基线：`src/unittests/cdbc_contract_test.cj` 14 处 `get<>` 与 3 处 `getOrNull<>` 均为具体类型实例
化，未涉及接口类型或 `Any`。用户代码不应以接口类型或 `Any` 实例化 `get<T>` / `getOrNull<T>`。

## 具名桥接函数 API 形态变更

公开桥接函数由原来的泛型壳 `valueFromSqlite` / `valueFromSqliteOrNull`（绑定目标类型的泛型形参）
改为 13 个非可空具名函数与 13 个可空具名函数，共 26 条：

- 非可空：`valueFromSqliteBool` / `valueFromSqliteInt8` / `valueFromSqliteInt16` /
  `valueFromSqliteInt32` / `valueFromSqliteInt64` / `valueFromSqliteFloat32` /
  `valueFromSqliteFloat64` / `valueFromSqliteString` / `valueFromSqliteBytes` /
  `valueFromSqliteDecimal` / `valueFromSqliteDateTime` / `valueFromSqliteInputStream` /
  `valueFromSqliteByteBuffer`；
- 可空：`valueFromSqliteOrNullBool` / ... / `valueFromSqliteOrNullByteBuffer`（与上一组逐一对应，
  返回 `?Bool` / ... / `?ByteBuffer`）。

每个具名函数返回类型在签名中已确定，调用形式本身携带目标类型信息，不再需要泛型实参。SQL NULL
处理由可空具名函数承担：`SqliteValue.SNull` 返回 `None`，其他值按对应非可空具名函数转换后用
`Some(...)` 包装。运行期类型分派由 `std.reflect.TypeInfo` 字符串比较改为 `is` / `as` 运行期类型
归属判定，路径 D 的实现见 `src/sqlite_type_bridge.cj` 与 `src/sqlite_query_result.cj`。

迁移方式：把旧 `valueFromSqlite` 泛型调用改为对应具名调用 `valueFromSqliteXxx(v)`（`Xxx` 为
目标类型在 13 类支持类型集合 `Bool` / `Int8` / `Int16` / `Int32` / `Int64` / `Float32` / `Float64` /
`String` / `Bytes` / `Decimal` / `DateTime` / `InputStream` / `ByteBuffer` 中的具名后缀）；旧
`valueFromSqliteOrNull` 泛型调用对应改为 `valueFromSqliteOrNullXxx(v)`。

回退路径：若外部代码依赖已删除的泛型签名，需要在调用方显式指定具名后缀；若需保留向后兼容，可
在 `sqlite-driver` 侧叠加两个 `@Deprecated` 标注的泛型壳作为兼容层（方案 §5.2 选项 D3）。
