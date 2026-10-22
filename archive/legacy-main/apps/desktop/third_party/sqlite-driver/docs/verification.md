# 验证说明

## 单元与集成测试

```bash
cd sqlite-driver
set -a && source env/.env && set +a   # 或自行导出 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm build
cjpm test
```

也可使用：

```bash
./build/build.sh
```

测试覆盖标准接口契约、SQL 语义、存储层、文件互操作、WAL、并发快照、页缓存、异常路径、
`WITHOUT ROWID`、`ADD COLUMN` 默认值回填以及显式事务内的语句级回滚。文件兼容性检查需要本机
可用的 `python3` 及其 `sqlite3` 模块。

判定以最终汇总为准：`FAILED` 和 `ERROR` 都必须为 0。

## 示例验收

```bash
cd sqlite-driver/examples
./run_all.sh
```

统一脚本会构建并运行全部示例子项目：

1. `basic`：最小标准接口路径；
2. `standard_api`：类型、完整元数据、兼容重载与事务断言；
3. `data_types`：类型映射与占位符；
4. `transactions`：事务形态与语句级回滚；
5. `advanced_sql`：高级 SQL、异常和超时；
6. `error_handling`：六种异常类型；
7. `file_database`：溢出页、freelist、WAL、检查点、关闭重开和 `VACUUM`；
8. `schema_metadata`：DDL 与元数据 PRAGMA；
9. `concurrency`：WAL 快照、写锁超时和跨线程取消；
10. `features`：45 组 SQL 矩阵，与 `expected.txt` 全文比对。

脚本只有在全部子程序返回 0、并打印对应 `PASS:` 标记时，才输出
`PASS: all sqlite-driver examples`。

## 环境说明

SQLite 是进程内文件数据库，不需要外部数据库服务。示例与测试只需要：

- 仓颉 1.1 系列工具链；
- `CANGJIE_STDX_PATH` 指向当前平台的扩展标准库动态库目录（见 [env/README.md](../env/README.md)）；
- 可写的临时目录；
- 根项目文件兼容性测试还需要系统可执行 `python3` 及其 `sqlite3` 模块。
