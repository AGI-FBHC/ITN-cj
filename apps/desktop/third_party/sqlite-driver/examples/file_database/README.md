# 文件数据库与 WAL

## 作用

演示真实磁盘数据库的完整生命周期：

- 解析文件 DSN，以及 `page_size`、`sync`、`busy_timeout`、`foreign_keys` 选项；
- 原生连接的绑定查询、按列名取值、变更计数、文件头应用字段、页缓存、外键约束和事务保存点；
- 超过单页的大记录、B-tree 分页、溢出页、删除后的 freelist 回收与再次分配；
- WAL 模式、自动检查点、日志大小限制、显式检查点和日志模式切换；
- 关闭后重新打开、溢出记录持久化、`foreign_key_check`、`VACUUM` 收缩、`quick_check` 和数据库清单。

## 运行

数据库路径必须指向尚不存在的文件：

```bash
cd sqlite-driver/examples/file_database
# 先按 ../../env/README.md 配置 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run --run-args="/tmp/sqlite-driver-example.db"
```

统一入口 `sqlite-driver/examples/run_all.sh` 会自动创建和清理临时数据库。

## 结果判定

程序对每次查询、事务结果、检查点结果和重新打开后的数据进行断言。成功时最后输出：

```text
PASS: file database example (48 checks)
```

成功退出码为 `0`。路径参数缺失时退出码为 `2`；验证失败时输出 `FAIL:` 并以退出码 `1` 结束。
