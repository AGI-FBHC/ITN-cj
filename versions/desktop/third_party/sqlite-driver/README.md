# sqlite-driver

纯仓颉实现的 SQLite 驱动与数据库引擎。直接读写 SQLite 3 文件格式，提供 `std.database.sql`
标准接口和轻量原生接口，不依赖本机 `libsqlite3`。

项目目录名使用连字符，仓颉模块名与导入名使用下划线：

```cangjie
import sqlite_driver.*
```

## 功能概览

- 内存库与磁盘库：可配置页大小、回滚日志、WAL 快照、检查点与 `VACUUM`；
- `std.database.sql`：Driver、Datasource、Connection、Statement、QueryResult、Transaction；
- 参数化 SQL、预备语句复用、事务、保存点、语句级回滚、写锁等待、超时、跨线程取消与分类异常；
- SQLite 五种存储类型，以及仓颉常用数值、布尔、时间、十进制与流类型转换；
- DDL、DML、CTE、子查询、连接、集合运算、窗口、JSON、触发器、视图、外键与 PRAGMA；
- `WITHOUT ROWID`、`RETURNING`、`ALTER TABLE ... DROP COLUMN` 与 `EXPLAIN QUERY PLAN`；
- B-tree、溢出页、freelist、页缓存、回滚恢复、WAL 快照与文件完整性检查。

完整清单见 [SQL 能力](./docs/sql-support.md)，分层见 [架构说明](./docs/architecture.md)。

## 快速开始

```bash
cp env/.env.example env/.env
# 编辑 env/.env，设置 CANGJIE_STDX_PATH
set -a && source env/.env && set +a
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
```

在应用 `cjpm.toml` 中加入依赖后：

```cangjie
registerSqliteDriver()
let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
let connection = datasource.connect()
```

参数索引从 **0** 开始。完整步骤见 [快速入门](./docs/getting-started.md)，连接与类型说明见
[API 与连接配置](./docs/api.md)。环境变量见 [env/README.md](./env/README.md)。

## 构建与验证

```bash
./build/build.sh
cd examples && ./run_all.sh
```

示例入口与结果判定见 [examples/README.md](./examples/README.md)，公开接口、SQL 与存储能力的映射见
[示例覆盖矩阵](./docs/example-coverage.md)，测试范围见 [验证说明](./docs/verification.md)。SQLite 是
嵌入式文件数据库，示例不需要外部数据库服务。

## 打包与发布

更新根目录 `cjpm.toml` 的 `version` 并提交变更后：

```bash
./build/package.sh
./build/release.sh
```

分步命令与安全检查见 [build/README.md](./build/README.md)。

## 使用前须知

- 仓颉标准库未提供文件级 `fsync`。`sync=full` 只能尽力调用系统 `sync`，不能承诺掉电后持久化；
- 多进程写仅能协调全部使用本驱动的进程；其他 SQLite 实现不会识别 `-cjflock`，不得混合并发写；
- 结果集和流会在内存中物化，不适合一次查询或读取超大对象；
- 当前只支持 UTF-8 数据库，不支持虚表、`ATTACH`、生成列、临时表和 `VACUUM INTO`；
- 递归 CTE 有 100 万行硬上限；WAL 索引为本进程内存结构，跨进程写依赖 `-cjflock`。

详细边界见 [限制与注意事项](./docs/limitations.md)。

## 文档

- [快速入门](./docs/getting-started.md)
- [架构说明](./docs/architecture.md)
- [API 与连接配置](./docs/api.md)
- [示例覆盖矩阵](./docs/example-coverage.md)
- [SQL 能力](./docs/sql-support.md)
- [限制与注意事项](./docs/limitations.md)
- [验证说明](./docs/verification.md)
- [运行环境](./env/README.md)
- [示例导航](./examples/README.md)
- [构建与发布](./build/README.md)
- [变更记录](./CHANGELOG.md)
