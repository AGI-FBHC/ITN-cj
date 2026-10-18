# 数据类型与值映射

以内存库为例，演示仓颉类型与 SQLite 存储类之间的完整映射规则。

## 作用

SQLite 是动态类型数据库：值有存储类，列只有亲和性，两者共同决定一个值最终以什么形态落库。
仓颉是静态类型语言，绑定与读取都要指定具体类型。这个示例把两侧的规则逐条跑出来并断言，
用来回答三类问题：

- 某个仓颉类型绑定进去会变成哪种存储类，读回来还是不是原值；
- 同一个字面量存进不同声明类型的列会被改写成什么，`CAST` 与亲和性的差别在哪；
- 哪些转换是被拒绝的，拒绝时抛什么异常。

## 覆盖的功能

**类型往返**：`Bool`、`Int8`、`Int16`、`Int32`、`Int64`、`Float32`、`Float64`、`String`、
`Array<Byte>`、`Decimal`、`DateTime`、`InputStream` 逐个绑定并读回；`setNull` 与
`getOrNull` 的 SQL NULL 对应关系；TEXT 列用 `get<InputStream>` 读出 UTF-8 字节；
整数窄化的边界（300 可以读成 `Int16`，读成 `Int8` 报错）；`Int64.Max` 与 `Int64.Min` 原样往返。

**存储类**：用 `typeof()` 断言 NULL、INTEGER、REAL、TEXT、BLOB 五种。

**列亲和性**：`INTEGER`、`REAL`、`NUMERIC`、`TEXT`、`BLOB` 和无类型六种列声明各存一份同样的值，
断言存储类被亲和性改写的结果，以及改写后实际存下来的值。

**`CAST` 表达式**：`CAST('12abc' AS INTEGER)`、`CAST(3.9 AS INTEGER)`、`CAST(42 AS TEXT)`、
`CAST('x' AS REAL)`、`CAST(65 AS BLOB)`、`CAST('3.0' AS NUMERIC)` 的值与存储类。

**排序规则**：`BINARY`、`NOCASE`、`RTRIM` 三种；表达式里显式写 `COLLATE`、`ORDER BY` 上写
`COLLATE`、列声明上写 `COLLATE` 后的相等判定，以及 `PRAGMA collation_list`。

**参数占位符**：`?`、`?N`、`:name`、`@name`、`$name` 五种写法的绑定结果，配合
`parameterColumnInfos.size` 断言参数个数，包含 `?1` 出现两次只需绑定一次、`:name`
重复出现共享同一个序号。

**原生值 `SqliteValue`**：`SNull`、`SInt`、`SReal`、`SText`、`SBlob` 五个构造子的相等语义与
`toString()`；`SqliteConn.exec` / `query` 绑定原生值；`SqliteResultSet.value` 与
`columnIndexOf` 按列名取值（列名不区分大小写）；`coerceToSqliteValue`、`valueFromSqliteXxx`（13 个具名非可空桥接：
`Bool` / `Int8` / `Int16` / `Int32` / `Int64` / `Float32` / `Float64` / `String` / `Bytes` /
`Decimal` / `DateTime` / `InputStream` / `ByteBuffer`）、`valueFromSqliteOrNullXxx`（13 个具名可空桥接，
与上一组对应）与 `formatDateTimeForSqlite` 公开桥接函数。

**列元数据**：`QueryResult.columnInfos` 的 `size`、`name` 与 `typeName`。

**被拒绝的转换**：绑定不支持的参数类型、请求不支持的结果类型、把 BLOB 读成 `String`、
把 TEXT 读成 `Array<Byte>`、把 SQL NULL 读成 `Int64`、把非数值文本读成 `Int64`，
以及越界的参数下标，全部抛 `SqliteRuntimeException`。

## 运行

```bash
cd sqlite-driver/examples/data_types
# 先按 ../../env/README.md 配置 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run
```

也可以先构建再直接执行可执行文件：

```bash
cjpm build
./target/release/bin/main
```

示例不接受命令行参数，全部数据写在 `:memory:` 内存库里，不依赖任何外部服务或数据文件。

## 结果判定

每项检查通过时打印一行 `PASS: <检查名>`，全部通过后最后一行是：

```text
PASS: data types example (96 checks)
```

此时进程退出码为 `0`。任何一项检查不成立时，程序打印 `FAIL: <原因>` 到标准错误并以退出码 `1` 结束。
