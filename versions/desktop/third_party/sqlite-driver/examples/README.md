# 示例导航

这些示例都在本地创建数据库、执行 SQL、读取结果并进行断言。示例不依赖网络服务；文件数据库示例
使用调用方提供的临时路径。

| 目录 | 覆盖内容 | 运行方式 |
| --- | --- | --- |
| [`basic`](./basic) | 标准接口的最小连接、参数、插入和查询 | `cjpm run` |
| [`standard_api`](./standard_api) | 数据源、完整元数据、类型桥接、兼容重载、结果集、事务和保存点 | `cjpm run` |
| [`data_types`](./data_types) | 十二种仓颉类型往返、亲和性、CAST、排序规则、五种占位符 | `cjpm run` |
| [`transactions`](./transactions) | 标准事务 API、SQL 事务形态、语句级回滚、延迟外键 | `cjpm run` |
| [`advanced_sql`](./advanced_sql) | 高级 SQL、JSON、窗口、`WITHOUT ROWID`、执行计划、异常和超时 | `cjpm run` |
| [`error_handling`](./error_handling) | 六种异常类型的触发路径、字段与消息格式 | `cjpm run` |
| [`file_database`](./file_database) | 文件 DSN、大记录溢出页、freelist 复用、WAL、重开和 `VACUUM` | `cjpm run --run-args=<path>` |
| [`schema_metadata`](./schema_metadata) | DDL 全形态、`sqlite_schema`、元数据与配置 PRAGMA | `cjpm run --run-args=<path>` |
| [`concurrency`](./concurrency) | WAL 快照、读写并行、写锁超时和跨线程语句取消 | `cjpm run --run-args=<path>` |
| [`features`](./features) | 45 组 SQL 功能矩阵，与 `expected.txt` 全文比对 | `./features/run.sh` |

## 环境

先阅读并配置 [env/README.md](../env/README.md)：

```bash
cd sqlite-driver
cp env/.env.example env/.env
# 编辑 env/.env，设置 CANGJIE_STDX_PATH
```

单个示例也可在 shell 中直接导出：

```bash
export CANGJIE_STDX_PATH=/path/to/cangjie/stdx
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
```

SQLite 是嵌入式文件数据库，示例不需要启动外部服务。

公开接口、SQL 语法和存储行为到示例的逐项映射见
[示例覆盖矩阵](../docs/example-coverage.md)。

## 一键运行

```bash
cd sqlite-driver/examples
./run_all.sh
```

脚本会在未设置 `CANGJIE_STDX_PATH` 时尝试加载 `../env/.env`，然后对每个子项目执行
`cjpm build` 与 `cjpm test`，再运行程序、读取实际输出并检查对应的 `PASS:` 标记。
`features` 会把完整输出与仓库中的 `expected.txt` 做逐行比对。需要临时文件的示例会在临时目录
中创建数据库，并在结束时清理。

全部成功时打印：

```text
PASS: all sqlite-driver examples
```
