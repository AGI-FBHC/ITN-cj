# 基础用法

## 作用

演示只通过 `std.database.sql` 完成驱动注册、内存数据库连接、建表、0 基参数绑定、插入和查询。
这是首次使用 `sqlite-driver` 时建议运行的最小示例。

## 运行

先按 [env/README.md](../../env/README.md) 配置 `CANGJIE_STDX_PATH`，然后执行：

```bash
cd sqlite-driver/examples/basic
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run
```

也可以从 `sqlite-driver/examples` 执行 `./run_all.sh`，统一运行全部示例。

## 结果判定

成功时进程退出码为 `0`，输出包含：

```text
id=1, title=learn sqlite-driver
PASS: basic example
```

任一写入行数、生成主键或查询值不符合预期时，程序输出 `FAIL:` 并以非零状态退出。
