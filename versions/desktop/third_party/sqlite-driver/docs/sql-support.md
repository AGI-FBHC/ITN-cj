# SQL 能力

## 语句

| 类别 | 支持内容 |
| --- | --- |
| 查询 | `SELECT`、`VALUES`、表达式、别名、`DISTINCT`、`WHERE`、`GROUP BY`、`HAVING`、`ORDER BY`、`LIMIT/OFFSET` |
| 行源 | 表、子查询、逗号连接、INNER/CROSS/LEFT/RIGHT/FULL JOIN、`ON`、`USING`、NATURAL JOIN |
| 集合 | `UNION`、`UNION ALL`、`INTERSECT`、`EXCEPT` |
| CTE | 普通和递归 CTE；可用于 SELECT、INSERT、UPDATE、DELETE |
| DML | INSERT/REPLACE、DEFAULT VALUES、INSERT SELECT、多行 VALUES、UPDATE、DELETE、RETURNING |
| 冲突 | `OR ABORT`、`OR IGNORE`、`OR REPLACE`、UPSERT `ON CONFLICT DO NOTHING/UPDATE` |
| DDL | CREATE TABLE/INDEX/VIEW/TRIGGER、部分索引、DROP TABLE/INDEX/VIEW、ALTER TABLE RENAME/ADD/RENAME COLUMN/DROP COLUMN、CTAS |
| 表能力 | INTEGER PRIMARY KEY、AUTOINCREMENT、复合主键、UNIQUE、NOT NULL、CHECK、DEFAULT、列排序规则、外键、`WITHOUT ROWID` |
| 触发器 | BEFORE/AFTER/INSTEAD OF、INSERT/UPDATE/DELETE、WHEN、OLD/NEW、递归触发器、`RAISE` |
| 事务 | BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE、COMMIT/END、ROLLBACK、SAVEPOINT、ROLLBACK TO、RELEASE |
| 维护 | `VACUUM`、`EXPLAIN QUERY PLAN`、支持清单中的 PRAGMA |

`UPDATE` 和 `DELETE` 额外接受 `ORDER BY ... LIMIT/OFFSET`。该语法在部分 SQLite 发行构建中需要编译
选项；需要跨环境移植时，可改写为按 rowid 或主键子查询筛选。

## 表达式与窗口

支持算术、比较、逻辑、位运算、字符串连接、`IS [NOT] NULL`、`IN`、`BETWEEN`、`LIKE`、`GLOB`、
`CASE`、`CAST`、`COLLATE`、标量子查询和 `EXISTS`。内置排序规则包括 `BINARY`、`NOCASE` 和
`RTRIM`。

窗口函数包括：

- 排名：`row_number`、`rank`、`dense_rank`、`percent_rank`、`cume_dist`、`ntile`；
- 取值：`lag`、`lead`、`first_value`、`last_value`、`nth_value`；
- 聚合窗口：`count`、`sum`、`total`、`avg`、`min`、`max`、`group_concat`；
- `PARTITION BY`、`ORDER BY`、命名窗口、基窗口；
- ROWS/RANGE/GROUPS 帧、边界偏移、`FILTER` 和四种 `EXCLUDE` 状态。

## 函数

### 通用与字符串

`abs`、`length`、`lower`、`upper`、`substr`/`substring`、`trim`、`ltrim`、`rtrim`、`replace`、
`instr`、`hex`、`unhex`、`quote`、`char`、`unicode`、`round`、`nullif`、`coalesce`、`ifnull`、
`iif`/`if`、`typeof`、`min`、`max`、`random`、`randomblob`、`zeroblob`、`concat`、`concat_ws`、
`printf`/`format`、`sign`、`likely`、`unlikely`、`likelihood`、`like`、`glob`。

连接状态函数包括 `last_insert_rowid`、`changes`、`total_changes`、`sqlite_version` 和
`sqlite_source_id`。

### 聚合

`count`、`sum`、`total`、`avg`、`min`、`max`、`group_concat`，支持适用位置的 `DISTINCT` 和
`FILTER`。

### 数学

`sqrt`、`floor`、`ceil`/`ceiling`、`trunc`、`exp`、`ln`、`log`、`log10`、`log2`、`pow`/`power`、
`mod`、`atan2`、`pi`、`sin`、`cos`、`tan`、`asin`、`acos`、`atan`、`sinh`、`cosh`、`tanh`、
`asinh`、`acosh`、`atanh`、`degrees`、`radians`。

### 日期时间

`date`、`time`、`datetime`、`julianday`、`unixepoch`、`strftime`，支持常用日期时间文本、Unix 时间、
儒略日和日/月/年等修饰符。

### JSON

`json`、`json_valid`、`json_extract`、`json_type`、`json_array`、`json_object`，以及 `->`、`->>`。

## 外键

支持单列和复合外键、隐式引用父表主键、`MATCH` 语法，以及 `ON DELETE` / `ON UPDATE` 的
`NO ACTION`、`RESTRICT`、`CASCADE`、`SET NULL`、`SET DEFAULT`。可使用
`DEFERRABLE INITIALLY DEFERRED` 把 `NO ACTION` 检查延迟到提交；`RESTRICT` 始终立即检查。

## PRAGMA

支持：

- 应用与模式：`user_version`、`schema_version`、`application_id`；
- 存储：`page_size`、`page_count`、`freelist_count`、`cache_size`；
- 外键：`foreign_keys`、`foreign_key_list`、`foreign_key_check`；
- 锁与日志：`busy_timeout`、`journal_mode`、`wal_checkpoint`、`wal_autocheckpoint`、
  `journal_size_limit`；
- 触发器：`recursive_triggers`；
- 元数据：`table_info`、`table_xinfo`、`index_list`、`index_info`、`index_xinfo`、
  `collation_list`、`database_list`；
- 检查：`integrity_check`、`quick_check`、`encoding`。

未知 PRAGMA 按 SQLite 行为忽略：查询形态返回空结果，赋值形态不执行操作。

## 示例覆盖

能力到可运行示例的完整映射见 [示例覆盖矩阵](./example-coverage.md)：

- `basic` / `standard_api`：标准接口入门与完整门面；
- `data_types`：类型映射、亲和性、CAST、排序规则与占位符；
- `transactions`：事务、保存点与语句级回滚；
- `advanced_sql`：高级语法、JSON、窗口、异常与超时；
- `error_handling`：六种异常类型的触发路径；
- `file_database` / `schema_metadata`：磁盘库、WAL 与元数据 PRAGMA；
- `concurrency`：WAL 快照、写锁竞争和跨线程取消；
- `features`：45 组广度矩阵，与 `expected.txt` 全文比对。
