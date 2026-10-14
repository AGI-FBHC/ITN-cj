# 高级 SQL 能力

## 作用

验证最新代码中的高级 SQL 与执行控制能力：

- `ALTER TABLE ... DROP COLUMN`；
- `UPDATE` / `DELETE` 的 `ORDER BY`、`LIMIT` 和受影响行数；
- 排序规则、部分唯一索引和延迟外键；
- JSON 函数与 `->` / `->>` 运算符；
- 命名窗口与 `EXCLUDE` 帧；
- `WITHOUT ROWID` 表、复合主键和二级索引；
- 递归 CTE 驱动写入、递归触发器、`RAISE` 和 `EXPLAIN QUERY PLAN`；
- `unhex`、`quote`、`unicode`、`sign`、`likely`、`format` 等标量函数；
- 约束异常、语法异常和语句超时。

## 运行

```bash
cd sqlite-driver/examples/advanced_sql
# 先按 ../../env/README.md 配置 CANGJIE_STDX_PATH
export LD_LIBRARY_PATH="${CANGJIE_STDX_PATH}:${LD_LIBRARY_PATH:-}"
cjpm run
```

## 结果判定

每项能力都由程序读取真实查询结果并断言。成功时以退出码 `0` 结束，最后输出：

```text
PASS: advanced SQL example (... checks)
```

任一 SQL 结果、受影响行数、执行计划或异常类型不符合预期时，程序输出 `FAIL:` 并返回非零退出码。
