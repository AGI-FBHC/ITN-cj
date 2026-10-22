package sqlite_driver.unittests

import std.unittest.*
import std.unittest.testmacro.*

/*
 * ALTER TABLE … ADD COLUMN。
 *
 * 重点是**已有行**。加列只改写存下来的建表文本, 一行数据都不重写, 于是旧行的 record 比
 * 新的列数短。SQLite 对 record 里没有的字段读出的是该列的 DEFAULT 而非 NULL —— 这条只在
 * 加列时带了 DEFAULT 的表上才看得见, 而且不报错, 只是值不对。
 *
 * 判据一律与 SQLite 比对: 默认值要经过列亲和性转换, 手写期望值时人会照着实现
 * 写, 于是"忘了转换"这类实现错会和期望一起绿。被拒的形态用 expectBothReject, 因此拒绝
 * 前提本身也会被检验。
 */
private let twoOldRows: Array<String> = [
    "CREATE TABLE t(a INT)",
    "INSERT INTO t VALUES(1),(2)"
]

@Test
class AddColumnTest {
    /**
     * 加列时带 DEFAULT, 已有行读到的是默认值。
     *
     * 这条是加列语义的核心: 旧行的 record 到不了新列, 补齐时取的必须是列的默认值。补成
     * NULL 的实现在这里读到两个 NULL, 而查询本身照样成功。
     */
    @TestCase
    func existingRowsReadTheDefaultOfTheAddedColumn(): Unit {
        expectSameAsSqlite(
            ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES(1),(2)", "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'x'"],
            "SELECT a, b FROM t ORDER BY a", "an added column with a text default")
    }

    /**
     * 交替加列与插入: 同一张表里同时存在三种宽度的 record。
     *
     * 每一行缺的字段数不同, 补齐要按各自的宽度算。按"整表统一缺几列"实现的话只有最旧的
     * 那一行是对的。加列之后插入的行走的是另一条路径 (插入时就把默认值写进 record),
     * 两条路径的结果必须一致。
     */
    @TestCase
    func rowsOfDifferentWidthsEachGetTheirOwnDefaults(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT)",
            "INSERT INTO t VALUES(1)",
            "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'b'",
            "INSERT INTO t(a) VALUES(2)",
            "ALTER TABLE t ADD COLUMN c TEXT DEFAULT 'c'",
            "INSERT INTO t(a) VALUES(3)"
        ]
        expectSameAsSqlite(setup, "SELECT a, b, c FROM t ORDER BY a", "three record widths in one table")
    }

    /**
     * 各存储类的默认值。
     *
     * 值与 typeof 都要比: 整数 7 与文本 '7' 在结果里长得一样, 只有类型判据分得开, 而
     * 存储类正是补齐时最容易丢的东西。负号形式 (`DEFAULT -7`) 与字面量不是同一种语法节点,
     * 所以另占一列。
     */
    @TestCase
    func defaultsOfEveryStorageClassSurviveTheAdd(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT)",
            "INSERT INTO t VALUES(1)",
            "ALTER TABLE t ADD COLUMN i INT DEFAULT 7",
            "ALTER TABLE t ADD COLUMN m INT DEFAULT -7",
            "ALTER TABLE t ADD COLUMN r REAL DEFAULT 1.5",
            "ALTER TABLE t ADD COLUMN s TEXT DEFAULT 'x'",
            "ALTER TABLE t ADD COLUMN z TEXT DEFAULT NULL",
            "ALTER TABLE t ADD COLUMN g BLOB DEFAULT x'4142'"
        ]
        expectSameAsSqlite(setup, "SELECT i, m, r, s, z, g FROM t", "defaults of every storage class")
        expectSameAsSqlite(setup, "SELECT typeof(i), typeof(m), typeof(r), typeof(s), typeof(z), typeof(g) FROM t",
            "the storage class of every default")
    }

    /**
     * 默认值按列亲和性转换。
     *
     * `INTEGER DEFAULT '42'` 存进去的是整数 42, 不是文本 '42'。旧行的补齐若直接拿字面量,
     * 读到的类型就与插入路径不一致 —— 表现是同一列上新旧行的 typeof 不同, 且
     * `WHERE n = 42` 只命中一半。
     */
    @TestCase
    func theDefaultGoesThroughTheColumnAffinity(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT)",
            "INSERT INTO t VALUES(1)",
            "ALTER TABLE t ADD COLUMN n INTEGER DEFAULT '42'",
            "ALTER TABLE t ADD COLUMN s TEXT DEFAULT 5",
            "ALTER TABLE t ADD COLUMN r REAL DEFAULT 2",
            "INSERT INTO t(a) VALUES(2)"
        ]
        expectSameAsSqlite(setup, "SELECT typeof(n), typeof(s), typeof(r) FROM t ORDER BY a",
            "the affinity applied to a default")
        expectSameAsSqlite(setup, "SELECT a FROM t WHERE n = 42 ORDER BY a", "matching a converted default by value")
    }

    /**
     * 不带 DEFAULT 的新列仍然是 NULL, 哪怕同一张表上另有带默认值的新列。
     *
     * 补齐是逐列的。写成"缺字段就取最后一个见过的默认值"或"整行统一取一个值"的实现会让
     * 这一列跟着旁边那列一起变成 'x'。
     */
    @TestCase
    func anAddedColumnWithoutADefaultStaysNull(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT)",
            "INSERT INTO t VALUES(1)",
            "ALTER TABLE t ADD COLUMN plain TEXT",
            "ALTER TABLE t ADD COLUMN filled TEXT DEFAULT 'x'",
            "ALTER TABLE t ADD COLUMN extra TEXT"
        ]
        expectSameAsSqlite(setup, "SELECT plain, filled, extra FROM t", "an added column with no default")
        expectSameAsSqlite(setup, "SELECT count(*) FROM t WHERE plain IS NULL AND extra IS NULL",
            "IS NULL on an added column with no default")
    }

    /**
     * 旧行被改写之后该列的值不变。
     *
     * UPDATE 会把整行按当前列数重编, record 从此是全宽的, 缺失字段的补齐路径不再参与。
     * 两种宽度下读出的值必须相同, 否则"改一下就变了"这种缺陷只在改过的行上暴露。
     */
    @TestCase
    func updatingAnOldRowKeepsTheDefaultedValue(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT)",
            "INSERT INTO t VALUES(1),(2)",
            "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'x'",
            "ALTER TABLE t ADD COLUMN n INTEGER DEFAULT '42'",
            "UPDATE t SET a = a + 10 WHERE a = 1"
        ]
        expectSameAsSqlite(setup, "SELECT a, b, n, typeof(n) FROM t ORDER BY a", "a rewritten row keeps its defaults")
        expectSameAsSqlite(
            ["CREATE TABLE t(a INT)", "INSERT INTO t VALUES(1)", "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'x'",
                "UPDATE t SET b = 'set' WHERE a = 1"], "SELECT a, b FROM t", "an explicit write over a defaulted column")
    }

    /**
     * 过滤、排序与聚合读到的也是默认值。
     *
     * 这些路径各自读行: WHERE 在扫描时求值, ORDER BY 收集排序键, 聚合逐行累加。只在
     * 结果列上补齐的实现会让 `WHERE b = 5` 一行都选不出来, 而 `SELECT b` 看着是对的。
     */
    @TestCase
    func filtersOrderingAndAggregatesSeeTheDefault(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT)",
            "INSERT INTO t VALUES(1),(2)",
            "ALTER TABLE t ADD COLUMN b INT DEFAULT 5",
            "INSERT INTO t VALUES(3,1)"
        ]
        expectSameAsSqlite(setup, "SELECT a FROM t WHERE b = 5 ORDER BY a", "WHERE over a defaulted column")
        expectSameAsSqlite(setup, "SELECT a, b FROM t ORDER BY b, a", "ORDER BY over a defaulted column")
        expectSameAsSqlite(setup, "SELECT b, count(*), sum(b) FROM t GROUP BY b ORDER BY b",
            "aggregating a defaulted column")
    }

    /**
     * 加列之后建的索引里存的是默认值。
     *
     * 建索引要扫一遍表, 走的是与查询同一条解码路径。索引项里若存成 NULL, 之后走索引的
     * 查询会漏掉全部旧行 —— 而同一条查询不走索引时是对的, 于是缺陷随访问路径时隐时现。
     */
    @TestCase
    func anIndexBuiltAfterTheAddIndexesTheDefault(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT)",
            "INSERT INTO t VALUES(1),(2)",
            "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'x'",
            "INSERT INTO t VALUES(3,'y')",
            "CREATE INDEX ix ON t(b)"
        ]
        expectSameAsSqlite(setup, "SELECT a, b FROM t WHERE b = 'x' ORDER BY a", "a point lookup on the new index")
        expectSameAsSqlite(setup, "SELECT a, b FROM t WHERE b > 'x' ORDER BY a", "a range scan on the new index")
        expectSameAsSqlite(setup, "SELECT b, count(*) FROM t GROUP BY b ORDER BY b", "grouping through the new index")
    }

    /**
     * WITHOUT ROWID 表上的同样行为。
     *
     * 那种表的 record 按磁盘列序存 (主键列在前), 补齐要按磁盘序而不是声明序对位。按声明序
     * 补的实现会把默认值填到错误的列上 —— 主键不在首列时尤其明显。
     */
    @TestCase
    func withoutRowidRowsReadTheDefaultToo(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT, k TEXT PRIMARY KEY) WITHOUT ROWID",
            "INSERT INTO t VALUES(1,'k1'),(2,'k2')",
            "ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'x'",
            "ALTER TABLE t ADD COLUMN n INTEGER DEFAULT '42'",
            "INSERT INTO t(a,k) VALUES(3,'k3')"
        ]
        expectSameAsSqlite(setup, "SELECT k, a, b, n, typeof(n) FROM t ORDER BY k", "defaults on a WITHOUT ROWID table")
        expectSameAsSqlite(setup, "SELECT k FROM t WHERE b = 'x' ORDER BY k",
            "WHERE over a defaulted column of a WITHOUT ROWID table")
    }

    /**
     * 非常量默认值的加列被拒。
     *
     * 已有行不被回填, 新列的值要在读它们时算出来, 而那条路径上没有求值上下文。SQLite 出于
     * 同样的理由拒绝这些形态, 包括只差一步常量折叠的 `(1+2)` 与 `(abs(-1))`。
     */
    @TestCase
    func addColumnRejectsNonConstantDefaults(): Unit {
        expectBothReject(twoOldRows, "ALTER TABLE t ADD COLUMN b TEXT DEFAULT (random())", "a function-call default")
        expectBothReject(twoOldRows, "ALTER TABLE t ADD COLUMN b TEXT DEFAULT CURRENT_TIMESTAMP",
            "a CURRENT_TIMESTAMP default")
        expectBothReject(twoOldRows, "ALTER TABLE t ADD COLUMN b INT DEFAULT (1+2)", "an arithmetic default")
        expectBothReject(twoOldRows, "ALTER TABLE t ADD COLUMN b INT DEFAULT (abs(-1))",
            "a default that only needs constant folding")
        expectBothReject(twoOldRows, "ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT (random())",
            "a non-constant default on a NOT NULL column")
    }

    /** NOT NULL 的新列必须带一个非 NULL 的默认值, 否则已有行全部违约。 */
    @TestCase
    func addColumnRejectsANotNullColumnWithoutAUsableDefault(): Unit {
        expectBothReject(twoOldRows, "ALTER TABLE t ADD COLUMN b TEXT NOT NULL", "NOT NULL with no default")
        expectBothReject(twoOldRows, "ALTER TABLE t ADD COLUMN b TEXT NOT NULL DEFAULT NULL",
            "NOT NULL with a NULL default")
    }

    /**
     * CREATE TABLE 里的非常量 DEFAULT 不受影响。
     *
     * 拒绝只针对加列: 建表时列一开始就在, 每一行的 record 都写着它的值, 默认值在插入那一刻
     * 按完整的求值上下文算。把拒绝放宽到建表会让一大类合法的表建不出来。
     */
    @TestCase
    func createTableStillAcceptsNonConstantDefaults(): Unit {
        expectSameAsSqlite(
            ["CREATE TABLE t(a INT, b INT DEFAULT (abs(-3)), c INT DEFAULT (1+2))", "INSERT INTO t(a) VALUES(1)"],
            "SELECT a, b, c FROM t", "computed defaults in CREATE TABLE")
        expectSameAsSqlite(["CREATE TABLE t(a INT, ts TEXT DEFAULT CURRENT_TIMESTAMP)"],
            "SELECT sql FROM sqlite_schema WHERE name='t'", "CURRENT_TIMESTAMP declared as a CREATE TABLE default")
    }
}
