# API 与连接配置

## 两套入口

推荐业务代码使用 `std.database.sql`：

```cangjie
registerSqliteDriver()
let driver = DriverManager.getDriver("sqlite").getOrThrow()
let datasource = driver.open("./data/app.db?foreign_keys=on", [])
let connection = datasource.connect()
```

需要直接处理 SQLite 存储类型时使用原生入口：

```cangjie
let dsn = parseSqliteDsn("./data/app.db?busy_timeout=5000")
let connection = openSqlite(dsn)
let affected = connection.exec(
    "INSERT INTO task(title) VALUES (?)",
    [SqliteValue.SText("first task")])
```

## DSN

连接串格式为：

```text
[path]?key=value&key=value
```

`path` 为空或为 `:memory:` 时创建内存数据库；其他值作为文件路径。支持以下参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `page_size` / `pagesize` | `4096` | 新数据库页大小，必须是 512 到 65536 的 2 次幂 |
| `sync` / `synchronous` | `normal` | `normal` 或 `full`；`full` 会额外尝试系统同步 |
| `busy_timeout` / `busytimeout` | `5000` | 获取写锁的等待毫秒数，不能为负数 |
| `foreign_keys` / `foreignkeys` / `fk` | `false` | 是否在连接打开时启用外键检查 |

未知参数会立即抛出 `SqliteRuntimeException`，避免拼写错误被静默忽略。打开已有文件时页大小以文件头
为准。

`Datasource.setOption(key, value)` 使用相同参数，并在下一次 `connect()` 时生效。

驱动、连接元数据和发布包使用同一版本号 `0.1.0`。

## 标准接口

### 参数与结果

参数索引和结果列索引都从 0 开始：

```cangjie
let statement = connection.prepareStatement("INSERT INTO item(id, name) VALUES (?, ?)")
statement.set<Int64>(0, 1)
statement.set<String>(1, "book")
let result = statement.update()
```

SQL NULL 使用 `setNull(index)` 写入，使用 `getOrNull<T>(index)` 读取。`get<T>` 遇到 NULL 会抛异常。
同一个 `Statement` 可以重复设置参数并执行；SQL 只在构造语句时解析一次。

`parameterColumnInfos` 报告参数数量。`QueryResult.columnInfos` 提供 `name`、`typeName`、`length`、
`scale`、`nullable` 和 `displaySize`；SQLite 使用动态类型，因此结果的长度、精度与显示宽度为 `0`，
可空性为 `true`，`typeName` 取首行值的存储类型。空结果的 `typeName` 为 `NULL`。

| 仓颉类型 | SQLite 存储类型 |
| --- | --- |
| `Bool`、`Int8/16/32/64` | INTEGER |
| `Float32/64` | REAL |
| `String`、`Decimal`、`DateTime` | TEXT |
| `Array<Byte>`、`InputStream`、`ByteBuffer` | BLOB |
| `None` / `setNull` | NULL |

`DateTime` 文本格式为 `yyyy-MM-dd HH:mm:ss`。`InputStream` 会完整读入内存；TEXT 和 BLOB 结果也可
包装为输入流，但不是增量 BLOB I/O。`Duration` 没有 SQLite 原生存储类型，因此明确拒绝。

原生值桥接函数可用于适配层：

- `coerceToSqliteValue<T>`：把受支持的仓颉值转换为 `SqliteValue`；
- `valueFromSqliteBool` / `valueFromSqliteInt8` / `valueFromSqliteInt16` /
  `valueFromSqliteInt32` / `valueFromSqliteInt64` / `valueFromSqliteFloat32` /
  `valueFromSqliteFloat64` / `valueFromSqliteString` / `valueFromSqliteBytes` /
  `valueFromSqliteDecimal` / `valueFromSqliteDateTime` / `valueFromSqliteInputStream` /
  `valueFromSqliteByteBuffer`：把非 NULL 的 `SqliteValue` 转换为对应的具体类型；
- `valueFromSqliteOrNullBool` / `valueFromSqliteOrNullInt8` /
  `valueFromSqliteOrNullInt16` / `valueFromSqliteOrNullInt32` /
  `valueFromSqliteOrNullInt64` / `valueFromSqliteOrNullFloat32` /
  `valueFromSqliteOrNullFloat64` / `valueFromSqliteOrNullString` /
  `valueFromSqliteOrNullBytes` / `valueFromSqliteOrNullDecimal` /
  `valueFromSqliteOrNullDateTime` / `valueFromSqliteOrNullInputStream` /
  `valueFromSqliteOrNullByteBuffer`：把 SQL NULL 转换为 `None`、其他值转换为对应具体类型
  并 `Some(...)` 包装；
- `formatDateTimeForSqlite`：生成驱动读取日期时间时使用的固定文本格式。

### 兼容重载

`Statement.query(Array<SqlDbType>)`、`Statement.update(Array<SqlDbType>)` 和
`QueryResult.next(Array<SqlDbType>)` 用于兼容已有调用代码。它们已由标准库标记为废弃，新代码应使用
泛型 `set<T>` / `get<T>` 接口。迁移示例见 [`standard_api`](../examples/standard_api)。

### 事务

```cangjie
let transaction = connection.createTransaction()
transaction.begin()
transaction.save("before_optional_work")
// 执行语句
transaction.rollback("before_optional_work")
transaction.release("before_optional_work")
transaction.commit()
```

标准事务使用 `BEGIN IMMEDIATE`。可表达的属性是 `ReadWrite`、`NotDeferrable`、`Serializable`；其他
取值会在 `begin()` 时被拒绝。同一连接一次只能有一个标准事务。

每条写语句都是一个隐含的子事务：无论是否已经 `BEGIN`，语句失败时都会撤销本语句自己的改动，外层
事务（若存在）保持活动，可以继续写入或整体回滚。

### 超时与取消

`Statement.setOption("timeout_ms", value)` 设置单次执行截止时间。值为 `0` 时不设截止时间。
`SqliteStatement.cancel()` 可从另一线程请求取消当前执行；取消和超时都抛出
`SqliteInterruptedException`。没有活动执行时调用 `cancel()` 不影响下一次执行。

## 原生接口

`SqliteConn` 提供：

- `exec` / `execString`：执行并返回受影响行数；
- `query` / `queryString`：返回已物化的 `SqliteResultSet`；
- `lastInsertRowid`、`changes`、`totalChanges`、`inTransaction`、`isAlive`；
- `close()`：关闭连接，未提交事务会回滚。

`SqliteResultSet` 提供列名、行集合、`rowCount`、不区分大小写的 `columnIndexOf` 和按列名读取的
`value(row, name)`。

## 并发访问

同一条 `SqliteConn` 使用连接级互斥保护，多个仓颉线程可以安全调用，但语句按顺序执行。需要并行
事务时应创建不同连接。

文件库在 WAL 模式下为每条连接维护独立读快照：读事务内多次查询看到同一版本，其他连接仍可提交
写入。两个写者竞争时，后到连接最多等待其 DSN 的 `busy_timeout`，超时后抛出
`SqliteBusyException`。

`SqliteStatement.cancel()` 可以从另一条仓颉线程请求中断当前执行。取消是协作式的，执行器会在
扫描、连接和表达式求值期间检查信号；没有活动执行时调用不会影响下一次执行。

## 异常

所有数据库异常继承 `std.database.sql.SqlException`：

| 类型 | 场景 |
| --- | --- |
| `SqliteSyntaxException` | SQL 词法、语法或不支持的语句，包含出错偏移 |
| `SqliteConstraintException` | 主键、唯一、非空、检查、类型或外键约束冲突 |
| `SqliteBusyException` | 在 `busy_timeout` 内未取得文件写锁 |
| `SqliteInterruptedException` | 语句被取消或超过截止时间 |
| `SqliteFormatException` | 文件头、页面、记录、日志或 WAL 格式损坏 |
| `SqliteRuntimeException` | 连接状态、绑定、类型转换或 SQL 运行期错误 |

连接、语句、结果集和数据源都应在 `finally` 中关闭。重复关闭是安全的，关闭后的资源拒绝继续使用。
