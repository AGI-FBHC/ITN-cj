# 示例覆盖矩阵

本页把驱动公开入口、SQL 能力和可观察的存储行为映射到真实可运行示例。每个示例都会读取实际结果并
断言；统一入口只有在所有断言、完整输出比对和进程退出码都成功时才通过。

## 公开接口

| 能力 | 示例 | 判定内容 |
| --- | --- | --- |
| 驱动注册、名称、版本、连接池偏好 | `basic`、`standard_api` | 从 `DriverManager` 取得驱动并核对属性 |
| `Driver.open`、`Datasource` 选项和生命周期 | `standard_api` | 选项在新连接生效，关闭状态可观察 |
| `Connection` 状态、元数据与预备语句 | `standard_api`、`error_handling` | 元数据值、资源关闭和关闭后拒绝调用 |
| 泛型参数绑定与 NULL | `basic`、`standard_api`、`data_types` | 0 基索引、十二种仓颉类型、`setNull` 与错误下标 |
| 参数和结果列元数据 | `standard_api`、`data_types` | 数量、名称、类型、长度、精度、可空性与显示宽度 |
| `Statement` 查询、更新、复用、超时和取消 | `standard_api`、`concurrency`、`error_handling` | 返回值、重复执行、截止时间和跨线程取消 |
| `QueryResult` 游标、泛型读取和生命周期 | `basic`、`standard_api`、`data_types` | `next`、`get`、`getOrNull`、流读取与关闭状态 |
| `UpdateResult` | `basic`、`standard_api` | 受影响行数与最后插入行号 |
| 标准事务属性、提交、回滚与保存点 | `standard_api`、`transactions` | 属性校验、完整回滚和局部回滚 |
| `SqlDbType` 兼容重载 | `standard_api` | 参数数组、结果槽写回、BLOB 与可空值 |
| 类型桥接函数与公开值类型 | `standard_api`、`data_types` | 转换函数、日期格式、相等语义与文本表示 |
| 六种驱动异常 | `error_handling`、`advanced_sql` | 具体异常类型、字段、消息前缀与失败后的状态 |

兼容重载中的完整 `SqlDbType` 类型组合由根项目的流与列类型测试覆盖；示例保留一条可读的迁移路径，
避免在新代码中推广废弃接口。

## 原生接口

| 能力 | 示例 | 判定内容 |
| --- | --- | --- |
| `SqliteDSN` 构造与连接串解析 | `file_database`、`error_handling` | 路径、同步级别、页大小、锁等待、外键和非法配置 |
| `openSqlite` 与连接状态 | `file_database` | 打开、关闭、未提交事务处理和关闭状态 |
| `exec` / `execString` | `file_database`、`features` | 参数绑定、受影响行数和事务状态 |
| `query` / `queryString` | `data_types`、`file_database`、`features` | 参数绑定、列名、行集合和五种存储类型 |
| 变更计数与事务属性 | `transactions`、`file_database` | `lastInsertRowid`、`changes`、`totalChanges`、`inTransaction` |
| `SqliteResultSet` | `data_types`、`file_database` | `rowCount`、列名查找、按名称取值和越界异常 |

## SQL 与模式

| 能力组 | 主要示例 |
| --- | --- |
| DDL、索引、视图、触发器、目录表和 ALTER/DROP | `schema_metadata`、`features` |
| INSERT、冲突策略、UPSERT、UPDATE、DELETE 与 RETURNING | `features`、`transactions`、`advanced_sql` |
| 表达式、排序规则、聚合、字符串、数学、日期时间与 JSON | `data_types`、`features`、`advanced_sql` |
| 子查询、连接、集合运算、普通/递归 CTE 与窗口函数 | `features`、`advanced_sql` |
| 外键动作、延迟外键、事务语句与语句级回滚 | `transactions`、`features` |
| `WITHOUT ROWID`、执行计划、DML 排序与限制 | `advanced_sql`、`schema_metadata` |
| PRAGMA、完整性检查和未识别 PRAGMA | `schema_metadata`、`file_database` |
| 不支持语法的明确拒绝 | `error_handling` |

`features` 在磁盘库上执行 45 组确定性用例，并将完整输出与 `expected.txt` 逐行比对。函数与语法的
详细清单见 [SQL 能力](./sql-support.md)。

## 存储与并发

| 能力 | 示例 | 判定内容 |
| --- | --- | --- |
| SQLite 文件头与持久化字段 | `file_database`、`schema_metadata` | 页大小、应用标识、用户版本和关闭重开 |
| B-tree 分页、溢出页和 freelist | `file_database` | 大记录往返、删除回收、空闲页复用和重开读取 |
| 回滚、保存点与语句原子性 | `transactions`、`file_database` | 失败语句不留部分写入，外层事务仍可用 |
| WAL、检查点和模式切换 | `file_database`、`features` | 自动/显式检查点、日志限制和 DELETE/WAL 切换 |
| WAL 读快照与写竞争 | `concurrency` | 读事务快照、并行提交、锁等待和释放后写入 |
| `VACUUM` 与完整性检查 | `file_database`、`features` | 页数收缩、数据保留、`integrity_check` 与 `quick_check` |

热日志恢复、损坏页识别、WAL 校验和和跨进程文件兼容性需要构造异常文件或外部检查进程，不适合作为
入门示例；这些路径由根项目集成测试覆盖，运行方法见 [验证说明](./verification.md)。

## 统一验收

```bash
cd sqlite-driver/examples
./run_all.sh
```

成功标记为：

```text
PASS: all sqlite-driver examples
```
