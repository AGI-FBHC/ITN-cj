# 内置依赖说明：sqlite_driver

本目录是第三方仓颉库 `sqlite_driver` 的**源码内置副本**（vendored），随本仓库一起提交，
目的是让本项目在离网机器上也能一条命令构建，不依赖任何需要联网获取的包。

- 上游：<https://gitcode.com/zhangyin_gitcode/sqlite-driver.git>
- 上游 cjpm.toml 里声明的仓库：<https://gitcode.com/ZhaoJun-zfh/sqlite-driver>
- 取得时的上游提交：`19dc96c feat: update sqlite driver with type bridge and query result improvements`
- 版本：`0.0.2`；许可证：Apache-2.0（见 `LICENSE`）
- 性质：纯仓颉实现的 SQLite 驱动与嵌入引擎，直接读写 SQLite 3 文件格式，
  不依赖本机 libsqlite3，实现标准库 `std.database.sql` 接口。

## 本地适配与修复

### 1. `cjpm.toml`：补 `x86_64-w64-mingw32` 目标段

上游只声明了 `x86_64-unknown-windows-gnu`，而仓颉 1.2.0 在 Windows 上的实际目标是
`x86_64-w64-mingw32`。作为路径依赖使用时，不补这一段会导致依赖方报
`imports package 'stdx.encoding.json' but not declared` —— 因为该目标段下的
`bin-dependencies.path-option` 没指向 stdx。

### 2. `src/sql_lexer.cj`：修词法器在中文 SQL 上崩溃（`lexPunct`）

**现象**：`INSERT INTO t (name) VALUES ('中文')`、`CREATE TABLE "表" (...)`、
`SELECT length('中文')` 这类语句直接抛 `IllegalArgumentException: Invalid utf8 byte sequence`，
栈顶固定在 `sql_lexer.cj` 的 `Lexer::lexPunct`。

**根因**：`lexPunct` 会用固定的字节长度去解码后比较运算符：

```
if (pos + 2 < src.size && sliceText(pos, pos + 3) == "->>") { ... }   // 无条件切 3 字节
let two = sliceText(pos, pos + 2)                                    // 切 2 字节
```

只要标点后面紧跟多字节字符，切出来的 3 字节就会落在字符中间，`String.fromUtf8` 立刻抛异常。
而「标点紧跟中文」在中文 SQL 里几乎必然出现：`VALUES ('中文')` 里的 `(` 紧跟 `'中文'`，
`CREATE TABLE 表 (...)` 里的 `(` 紧跟中文列名。所以现象看起来像"中文不能写进 SQL"，
真正的原因却只是词法器的 3 字节前瞻。

**修复**：新增 `matchAsciiBytes(at, lit)`，按字节逐个比较 ASCII 运算符字面量，不再解码；
单字符标点只在确认 `c < 128` 之后才切片；报错信息改用 `describeAt` 整字符解码，
解码失败时退回字节值，保证报错路径自身不抛异常。

**验证**：`third_party/probe` 里的 23 条用例全过（中文标识符、中文字面量、参数绑定、
长文本、引号、emoji、Int64/Float64/NULL、事务提交与回滚、BLOB 向量、自增主键、
排序分页、幂等 DDL、中文的更新与删除），并单独验证了 `->>` / `->` / `<=` / `>=` /
`<>` / `||` / `<<` / `>>` / `==` / `!=` 与中文键的 JSON 箭头取值。

### 页内空闲块与碎片合并

`src/btree_node.cj` 的空闲链释放原先只合并严格相邻的块。实际会话与配置反复更新后，两个空闲块之间可能留下 1–3 字节碎片。SQLite 文件格式要求把这些碎片吸收进相邻空闲块，同时减少页头碎片计数；否则原生 SQLite 的 `integrity_check` 会报告 `free space corruption`。

现在释放和再分配页内空间时统一检查并合并空闲链，保留至少 4 字节的存活区，拒绝重叠、越界和错误的碎片计数。再分配可规范化当前页中这种既有间隙，不代表扫描或修复整个历史数据库。

`FreeblockFragmentTest` 覆盖前驱、后继、双侧合并、存活区域和既有间隙再利用。`third_party/probe --freeblock-churn` 用纯仓颉写入 240 次变长更新与相邻删除案例；`tools/sqlite-freeblock-check.cjs` 使用 Node 内置原生 SQLite **只读**核对文件格式、全部最新值和主键索引。该独立验证不依赖 Python。修前最小案例的仓颉自验通过，而原生检查失败；修后两者通过。

## 它的已知边界（我们要一起认下来）

不提供文件级 fsync，掉电持久化只能尽力；结果集在内存物化，不适合超大对象；
只支持 UTF-8；不支持虚表、ATTACH、生成列、临时表、VACUUM INTO；递归 CTE 有行数上限；
多进程写只在本驱动的进程间协调。对本产品（单人本地使用）都不构成阻碍。

## 上游自带测试的运行情况

`cjpm test` 在本机得到 570 / 615 通过。未通过的全部集中在需要外部参照 sqlite 的用例类
（`InteropForward/ReverseTest`、`Wal*Test`、`VacuumTest`、`WithoutRowid*`、
`MathFunctionValueTest` 等），它们都靠 `python3` 起一个参照 sqlite 做差分比对，而本机
`python3` 一是指向 Store 版 Python（无法打开 temp 目录下的库文件），二是指向
Anaconda 版（其 sqlite 编译时未开启数学函数，`no such function: sqrt`）。
两种环境下失败的用例集合互补，都属于参照环境问题，与本项目无关。
纯仓颉侧（引擎、DDL/DML、表达式、窗口函数等）用例全部通过。
