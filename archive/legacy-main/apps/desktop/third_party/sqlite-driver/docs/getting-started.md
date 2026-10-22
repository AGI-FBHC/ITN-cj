# 快速入门

## 环境

先按 [env/README.md](../env/README.md) 配置 `CANGJIE_STDX_PATH`，再把该目录加入动态库搜索路径：

```bash
cd sqlite-driver
cp env/.env.example env/.env   # 首次使用
# 编辑 env/.env
set -a && source env/.env && set +a
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
```

本驱动读写本地 SQLite 文件或内存库，不需要外部数据库进程。

## 依赖

在应用的 `cjpm.toml` 中加入：

```toml
[dependencies]
# 本地开发
  "sqlite_driver" = { path = "../sqlite-driver" }

# 发布到中心仓后
# "sqlite_driver" = "0.1.0"
```

目录名是 `sqlite-driver`，仓颉模块名与导入名是 `sqlite_driver`：

```cangjie
import sqlite_driver.*
```

## 最小示例

```cangjie
package demo

import std.database.sql.*
import sqlite_driver.*

main(): Int64 {
    registerSqliteDriver()
    let datasource = DriverManager.getDriver("sqlite").getOrThrow().open(":memory:", [])
    let connection = datasource.connect()
    try {
        let create = connection.prepareStatement(
            "CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
        try {
            let _ = create.update()
        } finally {
            create.close()
        }

        let insert = connection.prepareStatement("INSERT INTO task(title) VALUES (?)")
        try {
            insert.set<String>(0, "first task")
            let result = insert.update()
            println("inserted=${result.rowCount}, id=${result.lastInsertId}")
        } finally {
            insert.close()
        }

        let query = connection.prepareStatement("SELECT id, title FROM task")
        try {
            let rows = query.query()
            try {
                while (rows.next()) {
                    println("${rows.get<Int64>(0)}: ${rows.get<String>(1)}")
                }
            } finally {
                rows.close()
            }
        } finally {
            query.close()
        }
    } finally {
        connection.close()
        datasource.close()
    }
    return 0
}
```

`Statement.set(index, value)` 的参数索引从 **0** 开始。

## 连接串

```text
[path]?key=value&key=value
```

- `path` 为空或 `:memory:`：内存库；
- 其他值：磁盘文件路径；
- 常用参数：`page_size`、`sync`、`busy_timeout`、`foreign_keys`。

完整参数表见 [API 与连接配置](./api.md)。

## 原生接口

不走标准门面时，可直接使用：

```cangjie
let connection = openSqlite(parseSqliteDsn("./data/app.db?foreign_keys=on"))
let affected = connection.exec(
    "INSERT INTO task(title) VALUES (?)",
    [SqliteValue.SText("first task")])
```

## 运行示例

```bash
cd examples
./run_all.sh
```

或进入单个子目录执行 `cjpm run`。每个示例子项目都有独立 `README.md`，说明作用、运行方式与结果判定。

## 下一步

- [架构说明](./architecture.md)
- [API 与连接配置](./api.md)
- [SQL 能力](./sql-support.md)
- [限制与注意事项](./limitations.md)
- [验证说明](./verification.md)
