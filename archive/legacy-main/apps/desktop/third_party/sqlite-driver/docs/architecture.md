# 架构说明

## 总体结构

`sqlite-driver` 同时实现数据库接口、SQL 执行器和 SQLite 文件存储。依赖方向保持单向：

```text
应用
  |
  +-- std.database.sql 门面
  |     Driver -> Datasource -> Connection -> Statement -> QueryResult
  |
  +-- 原生接口
        SqliteDSN -> SqliteConn -> SqliteResultSet
                    |
                    v
SQL 前端: lexer -> parser -> AST
                    |
                    v
执行层: schema / DML / SELECT / CTE / window / trigger / foreign key
                    |
                    v
记录层: SqliteValue <-> record serial types
                    |
                    v
存储层: B-tree -> pager -> journal / WAL -> memory / file backend
```

## 接口层

`SqliteDriver` 注册到 `DriverManager`。每次 `SqliteDatasource.connect()` 创建独立的
`SqliteConnection`，连接内部持有一个 `SqliteConn`。标准接口负责：

- 把仓颉值转换为 SQLite 的 NULL、INTEGER、REAL、TEXT、BLOB；
- 在 prepare 时解析 SQL 并统计参数，执行时复用只读 AST；
- 把原生结果包装为游标式 `QueryResult`；
- 管理资源状态、标准事务属性、超时和取消。

原生接口直接接受 `Array<SqliteValue>`，适合驱动扩展或不需要标准门面的场景。

## SQL 层

词法器保留 token 的原始文本与位置，解析器生成强类型 AST。执行入口按语句类型分派到独立模块：

- schema 模块维护 `sqlite_schema`、表、索引、视图与触发器；
- DML 模块处理冲突策略、外键动作、`RETURNING` 和受影响行；
- SELECT 模块负责行源、过滤、聚合、排序、集合运算和窗口；
- 函数模块分别实现通用、数学、日期时间与 JSON 函数；
- 事务控制由数据库中心对象统一驱动 pager。

`EXPLAIN QUERY PLAN` 会显示全表扫描、INTEGER PRIMARY KEY、普通索引或 `WITHOUT ROWID`
主键路径。执行器在 rowid 或索引条件可用时选择点查和范围路径。

## 存储层

pager 向上提供固定大小页面和事务语义，向下统一使用内存或文件后端。其职责包括：

- SQLite 文件头、页大小、数据库页数与 freelist；
- table/index B-tree，叶页和内页分裂、合并、溢出页与空闲空间回收；
- 记录 serial type 编解码、亲和性与排序规则；
- DELETE 模式回滚日志、热日志恢复；
- WAL 帧、校验和、读快照、自动/显式检查点与模式切换；
- 页缓存上限、脏页淘汰与 `integrity_check`。

存储格式遵循 SQLite 3 文件格式，兼容性由磁盘库双向读取验证。

## 事务与并发

每个 `SqliteConn` 使用互斥锁保护连接状态和页缓存，因此同一连接可由多个仓颉线程调用，但语句会
串行进入引擎。多个连接在 WAL 模式下可持有独立读快照。

文件写入使用 `<database>-cjflock` 锁文件协调使用本驱动的进程。锁内容记录进程号；支持 `/proc`
的平台可在持锁进程退出后识别并清理陈旧锁。WAL 读快照索引保存在本进程内存中，不共享外部
`-shm` 文件。该锁协议不与其他 SQLite 实现使用的建议锁互通，详见
[限制与注意事项](./limitations.md)。
