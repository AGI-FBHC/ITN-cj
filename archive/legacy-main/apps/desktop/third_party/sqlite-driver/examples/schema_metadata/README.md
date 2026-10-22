# 表结构管理、元数据查询与 PRAGMA

在一个新建的文件数据库上定义完整的表结构，再通过 `sqlite_schema` 与各类 PRAGMA 把结构读回来逐项断言。

## 作用

数据库的结构信息只有两条读取途径：目录表 `sqlite_schema` 保存原始 DDL 文本，元数据 PRAGMA 把
解析后的列、索引与外键信息按行返回。本示例先用各种约束、索引、视图、触发器和 `ALTER TABLE`
把结构建起来并改一遍，每一步都用这两条途径验证效果，随后覆盖数据库配置、日志模式与完整性
检查相关的 PRAGMA，最后确认未知 PRAGMA 的处理方式。

因为 `page_count`、`freelist_count`、`database_list`、`journal_mode` 与 WAL 检查点只在文件数据库上
有意义，示例要求调用方给出一个数据库文件路径。

## 覆盖的功能

### A. 表结构定义

- 列级约束：`PRIMARY KEY`、`AUTOINCREMENT`、`NOT NULL`、`UNIQUE`、`CHECK`、`DEFAULT`、
  `COLLATE`、`REFERENCES`；
- 表级约束：复合 `PRIMARY KEY(...)`、`UNIQUE(...)`、`CHECK(...)`、
  `FOREIGN KEY(...) REFERENCES`；
- `CREATE TABLE IF NOT EXISTS`、`WITHOUT ROWID` 表、`CREATE TABLE ... AS SELECT`；
- `CREATE INDEX`、`CREATE UNIQUE INDEX`、多列索引、逐列 `COLLATE` 与 `ASC`/`DESC`、带 `WHERE`
  的部分索引、`IF NOT EXISTS`；
- 带显式列名列表的 `CREATE VIEW`、`CREATE TRIGGER`；
- `ALTER TABLE` 的 `RENAME TO`、`RENAME COLUMN`、`ADD COLUMN`、`DROP COLUMN`；
- `DROP TABLE` / `DROP INDEX` / `DROP VIEW` / `DROP TRIGGER`，含 `IF EXISTS`。

### B. `sqlite_schema` 目录表

按 `type` 取 `table`、`index`、`view`、`trigger` 四类对象的 `name`、`tbl_name` 与 `sql`，
包括自动索引的 `sql` 为 NULL、`AUTOINCREMENT` 附带的 `sqlite_sequence` 计数表，以及旧名
`sqlite_master` 指向同一张目录表。

### C. 元数据 PRAGMA

`table_info`、`table_xinfo`、`index_list`、`index_info`、`index_xinfo`、`foreign_key_list`、
`foreign_key_check`（全库与单表两种形态）、`collation_list`、`database_list`，逐项断言列数、
列名与关键行的取值。

### D. 数据库配置 PRAGMA

`page_size`、`page_count`、`freelist_count`、`encoding`、`user_version`、`application_id`、
只读的 `schema_version`、`cache_size`（正数为页数、负数为 KiB，读回一律是负数形式）、
`busy_timeout`、`foreign_keys`、`recursive_triggers`、`journal_mode`（`wal` 与 `delete`）、
`wal_autocheckpoint`、`journal_size_limit`、`wal_checkpoint`（`PASSIVE`、`FULL`、`RESTART`、
`TRUNCATE` 四种模式）。

### E. 完整性检查

`PRAGMA integrity_check` 与 `PRAGMA quick_check` 均返回 `ok`。

### F. 未知 PRAGMA

查询形态返回空结果集，赋值形态被静默忽略且不留下任何状态。

## 运行

```bash
cd sqlite-driver/examples/schema_metadata
export cjHeapSize=1gb
# 先按 ../../env/README.md 配置 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run --run-args=/tmp/schema_metadata_demo/meta.db
```

参数必须是一个**尚不存在**的数据库文件路径：示例会自己建库，并依赖 `user_version`、
`freelist_count`、`schema_version` 等的初始状态。所在目录需要已经存在。示例结束时日志模式已
切回 `delete`，只留下这一个数据库文件，运行完可以直接删除。

## 结果判定

程序逐项打印 `PASS: <检查名>`，例如 `PASS: table_info rows`、`PASS: index_list origins`、
`PASS: foreign_key_check reports the offending row`。全部断言通过时最后一行为：

```text
PASS: schema metadata example (120 checks)
```

退出码为 `0`。参数个数不是 1 时输出 `usage: sqlite_driver_schema_metadata <database-path>`
并以 `2` 退出。任何检查失败时输出 `FAIL: ...` 并以 `1` 退出。
