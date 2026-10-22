# 并发、WAL 快照与语句取消

## 作用

演示文件数据库在并发访问场景下的可观察行为：

- 两条连接分别作为读者和写者，验证 WAL 读快照在事务内保持稳定；
- 验证读事务不会阻塞另一条连接提交写入；
- 验证写锁竞争遵循 `busy_timeout` 并抛出 `SqliteBusyException`；
- 从另一条仓颉线程调用 `SqliteStatement.cancel()`，中断正在执行的长查询。

## 运行

数据库路径必须指向尚不存在的文件：

```bash
cd sqlite-driver/examples/concurrency
# 先按 ../../env/README.md 配置 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run --run-args="/tmp/sqlite-driver-concurrency.db"
```

也可以从 `sqlite-driver/examples` 执行 `./run_all.sh`。统一脚本会创建并清理临时数据库。

## 结果判定

程序读取每条连接实际可见的值，并检查锁超时和取消异常。全部检查通过时最后输出：

```text
PASS: concurrency example (... checks)
```

成功退出码为 `0`。路径参数缺失时退出码为 `2`；任一快照、锁或取消结果不符合预期时输出
`FAIL:` 并以退出码 `1` 结束。
