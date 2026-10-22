# 标准数据库接口

## 作用

完整演示 `std.database.sql` 门面，包括：

- 驱动注册、数据源选项、连接状态与元数据；
- 预备语句复用、0 基参数绑定，以及参数和结果列的完整元数据字段；
- `Bool`、整数、浮点数、文本、BLOB、流、`Decimal`、`DateTime` 和 SQL NULL 往返；
- `coerceToSqliteValue`、`valueFromSqliteXxx`（13 个具名非可空桥接）、`valueFromSqliteOrNullXxx`
  （13 个具名可空桥接）和日期时间格式化；
- `SqliteColumnInfo`、`SqliteUpdateResult` 和公开枚举的直接使用；
- 更新结果、结果集生命周期、事务提交、事务回滚和保存点；
- `timeout_ms` 配置，以及无活动执行时调用 `cancel()` 的幂等行为。

示例还验证 `query(params)`、`update(params)` 与 `next(values)` 兼容重载，便于已有代码迁移。
新代码应使用 `set<T>`、`setNull`、`get<T>` 与 `getOrNull<T>`。

## 运行

```bash
cd sqlite-driver/examples/standard_api
# 先按 ../../env/README.md 配置 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run
```

## 结果判定

程序会逐项打印 `PASS:`。全部断言通过时最后一行为：

```text
PASS: standard API example (57 checks)
```

任何检查失败时会输出 `FAIL:` 并以非零状态退出。
