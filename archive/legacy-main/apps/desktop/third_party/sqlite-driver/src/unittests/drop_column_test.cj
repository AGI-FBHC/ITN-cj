package sqlite_driver.unittests

import std.unittest.*
import std.unittest.testmacro.*

/*
 * ALTER TABLE … DROP COLUMN。
 *
 * 接受的形态用 expectSameEffectAsSqlite 比较**表内容与改写后的 DDL 文本**，被拒的形态用
 * expectBothReject 与 SQLite 核对，因此拒绝前提本身也会被检验。
 *
 * DDL 文本必须进判据而不只比表内容: 删列是文本级改写, 一个"多吞了一个逗号"或"少留了缩进"
 * 的实现照样能让 SELECT 的结果对上, 而库的 sqlite_schema 已经与 SQLite 分叉了。
 *
 * 三条**接受**的用例 (viewQualifiedToAnotherTable / triggerOnAnotherTable /
 * triggerUnqualifiedRefToItsOwnTarget) 用于防止引用校验过宽；这些合法引用不能因出现同名列而被拒绝。
 */
private let baseSchema: Array<String> = [
    "CREATE TABLE t(a INT, b INT, c TEXT)",
    "INSERT INTO t VALUES(1,2,'x'),(3,4,'y')"
]

/** 改写后存下来的建表文本。 */
private let storedDdl = "SELECT sql FROM sqlite_schema WHERE name='t'"

@Test
class DropColumnTest {
    /** 基本形态: 表内容与 DDL 文本两侧都要对上。 */
    @TestCase
    func dropColumnRemovesTheValuesAndRewritesTheStoredDdl(): Unit {
        expectSameEffectAsSqlite(baseSchema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b",
            "SELECT * FROM t ORDER BY a", "dropping a middle column")
        expectSameEffectAsSqlite(baseSchema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", storedDdl,
            "the stored DDL after dropping a middle column")
    }

    /** COLUMN 关键字可省。 */
    @TestCase
    func theColumnKeywordIsOptional(): Unit {
        expectSameEffectAsSqlite(baseSchema, "ALTER TABLE t DROP b", "ALTER TABLE t DROP b",
            "SELECT * FROM t ORDER BY a", "DROP without the COLUMN keyword")
        expectSameEffectAsSqlite(baseSchema, "ALTER TABLE t DROP b", "ALTER TABLE t DROP b", storedDdl,
            "the stored DDL after DROP without COLUMN")
    }

    /**
     * 首列与末列。
     *
     * 两端各自走删列跨度规则的不同分支: 非末项吞后面的逗号, 末项吞前面的。分开断言, 否则
     * 一个只对中间列成立的实现能靠中间列那条用例蒙过去。
     */
    @TestCase
    func droppingTheFirstOrLastColumnKeepsTheRestIntact(): Unit {
        expectSameEffectAsSqlite(baseSchema, "ALTER TABLE t DROP COLUMN a", "ALTER TABLE t DROP COLUMN a",
            "SELECT * FROM t ORDER BY b", "dropping the first column")
        expectSameEffectAsSqlite(baseSchema, "ALTER TABLE t DROP COLUMN a", "ALTER TABLE t DROP COLUMN a", storedDdl,
            "the stored DDL after dropping the first column")
        expectSameEffectAsSqlite(baseSchema, "ALTER TABLE t DROP COLUMN c", "ALTER TABLE t DROP COLUMN c",
            "SELECT * FROM t ORDER BY a", "dropping the last column")
        expectSameEffectAsSqlite(baseSchema, "ALTER TABLE t DROP COLUMN c", "ALTER TABLE t DROP COLUMN c", storedDdl,
            "the stored DDL after dropping the last column")
    }

    /**
     * 多行 DDL 的换行与缩进逐字保留。
     *
     * SQLite 删列是文本级改写而不是"按 AST 重新渲染": 三行的建表语句删掉中间一行之后,
     * 余下两行的缩进与换行位置一个字节都不变。按 AST 重渲染的实现会把它压成一行 ——
     * 表内容判据看不出这件事, 只有 DDL 文本判据能。
     */
    @TestCase
    func multilineDdlKeepsItsNewlinesAndIndentation(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(\n  a INT,\n  b INT,\n  c TEXT\n)",
            "INSERT INTO t VALUES(1,2,'x')"
        ]
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", storedDdl,
            "multiline DDL after dropping the middle column")
    }

    /**
     * 列定义列表里的注释留在原处。
     *
     * `/*keep*/` 在被删列**之前**, 所以它不在删除跨度里, 应当保留; 而写在被删列尾部的注释
     * 落在跨度内, 跟着一起走。两种位置都断言, 因为它们检验的是跨度的两个端点。
     */
    @TestCase
    func commentsInsideTheColumnListSurviveWhenTheyPrecedeTheDroppedColumn(): Unit {
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, /*keep*/ b INT, c INT)"], "ALTER TABLE t DROP COLUMN b",
            "ALTER TABLE t DROP COLUMN b", storedDdl, "a comment before the dropped column")
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b INT /*tail*/, c INT)"], "ALTER TABLE t DROP COLUMN b",
            "ALTER TABLE t DROP COLUMN b", storedDdl, "a comment trailing the dropped column")
        expectSameEffectAsSqlite(["CREATE TABLE t(\n a INT, -- first\n b INT, -- second\n c INT\n)"],
            "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", storedDdl,
            "line comments in a multiline column list")
    }

    /**
     * 列定义里出现的逗号不能当分隔符。
     *
     * `DECIMAL(10,2)` 与 `CHECK(b IN (1,2,3))` 里都有逗号。按"列名到下一个逗号"删会从括号
     * 内部截断, 留下一段语法上仍然合法、但列数已经不对的 DDL —— 那种库要到下次打开时才暴露。
     */
    @TestCase
    func commasInsideParenthesesAreNotColumnSeparators(): Unit {
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b DECIMAL(10,2), c INT)"], "ALTER TABLE t DROP COLUMN b",
            "ALTER TABLE t DROP COLUMN b", storedDdl, "dropping a column whose type carries a comma")
        expectSameEffectAsSqlite(["CREATE TABLE t(a DECIMAL(10,2), b INT, c INT)"], "ALTER TABLE t DROP COLUMN b",
            "ALTER TABLE t DROP COLUMN b", storedDdl, "a preceding column whose type carries a comma")
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b INT CHECK(b IN (1,2,3)), c INT)"],
            "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", storedDdl,
            "dropping a column whose CHECK carries commas")
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b DECIMAL(10,2))"], "ALTER TABLE t DROP COLUMN b",
            "ALTER TABLE t DROP COLUMN b", storedDdl, "the last column carries a comma in its type")
    }

    /**
     * 被删列是最后一个**列定义**, 但后面还跟着表级约束。
     *
     * 这一条容易写错成走"末项"分支 (吞前面的逗号), 因为它确实是最后一列。但列表里它不是
     * 最后一**项**, 所以该吞后面那个逗号。判据看的是留下来的约束前面有没有多余/缺失的逗号。
     */
    @TestCase
    func aTrailingTableConstraintMakesTheLastColumnANonFinalItem(): Unit {
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b INT, UNIQUE(a))"], "ALTER TABLE t DROP COLUMN b",
            "ALTER TABLE t DROP COLUMN b", storedDdl, "last column definition followed by UNIQUE")
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b INT, CHECK(a>0))"], "ALTER TABLE t DROP COLUMN b",
            "ALTER TABLE t DROP COLUMN b", storedDdl, "last column definition followed by CHECK")
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b INT, CONSTRAINT ck CHECK(a>0))"],
            "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", storedDdl,
            "last column definition followed by a named constraint")
    }

    /** 带引号的列名, 含本身是关键字的那种。 */
    @TestCase
    func quotedColumnNamesCanBeDropped(): Unit {
        expectSameEffectAsSqlite(["CREATE TABLE t(\"odd name\" INT, b INT)", "INSERT INTO t VALUES(1,2)"],
            "ALTER TABLE t DROP COLUMN \"odd name\"", "ALTER TABLE t DROP COLUMN \"odd name\"", storedDdl,
            "dropping a quoted column name")
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, \"select\" INT, c INT)"],
            "ALTER TABLE t DROP COLUMN \"select\"", "ALTER TABLE t DROP COLUMN \"select\"", storedDdl,
            "dropping a quoted keyword column name")
    }

    /** 列名匹配不分大小写。 */
    @TestCase
    func theColumnNameMatchesCaseInsensitively(): Unit {
        expectSameEffectAsSqlite(["CREATE TABLE t(ABC INT, b INT)", "INSERT INTO t VALUES(1,2)"],
            "ALTER TABLE t DROP COLUMN abc", "ALTER TABLE t DROP COLUMN abc", "SELECT * FROM t",
            "dropping a column by a differently-cased name")
    }

    /**
     * rowid 不重排。
     *
     * 删列要重写每一行的 payload, 最省事的实现是"读出来再逐行 INSERT", 而那会重新分配 rowid。
     * 判据取 `SELECT rowid,*`, 并且先删掉一行造出 rowid 空洞 —— 没有空洞时重排与不重排
     * 结果相同, 这条判据就空转了。
     */
    @TestCase
    func rowidsAreNotRenumbered(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(a INT, b INT, c INT)",
            "INSERT INTO t VALUES(1,2,3),(4,5,6),(7,8,9)",
            "DELETE FROM t WHERE a=1"
        ]
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b",
            "SELECT rowid,* FROM t ORDER BY rowid", "rowids survive a column drop")
    }

    /**
     * INTEGER PRIMARY KEY 表上删别的列。
     *
     * 别名列的序号会因为前面的列被删而前移。编码时若仍按旧序号把"别名列"写成 NULL, 抹掉的
     * 就是另一列 —— 表现为某一整列的数据全变 NULL。判据必须读到 id 之后的那些列。
     */
    @TestCase
    func droppingAColumnBeforeTheRowidAliasKeepsEveryOtherValue(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(pre INT, id INTEGER PRIMARY KEY, post TEXT)",
            "INSERT INTO t VALUES(1,10,'kept'),(2,20,'also')"
        ]
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN pre", "ALTER TABLE t DROP COLUMN pre",
            "SELECT rowid, id, post FROM t ORDER BY id", "dropping a column that precedes the rowid alias")
        let after: Array<String> = [
            "CREATE TABLE t(id INTEGER PRIMARY KEY, mid INT, post TEXT)",
            "INSERT INTO t VALUES(10,1,'kept'),(20,2,'also')"
        ]
        expectSameEffectAsSqlite(after, "ALTER TABLE t DROP COLUMN mid", "ALTER TABLE t DROP COLUMN mid",
            "SELECT rowid, id, post FROM t ORDER BY id", "dropping a column that follows the rowid alias")
    }

    /**
     * 无关列上的索引在删列之后仍然可用。
     *
     * 索引项里存的是列值加 rowid, 删掉别的列不改变这些字节; 变的只是列在表里的序号。判据
     * 走一条会用到该索引的查询, 于是"索引项没跟着重建"与"索引项被错误重建"两种错都能看出来。
     */
    @TestCase
    func anIndexOnASurvivingColumnStillResolvesRows(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(a INT, b INT, c INT)",
            "CREATE INDEX ix ON t(c)",
            "INSERT INTO t VALUES(1,2,30),(4,5,10),(7,8,20)"
        ]
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b",
            "SELECT a, c FROM t WHERE c >= 20 ORDER BY c", "an index on a surviving column after a drop")
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b",
            "SELECT sql FROM sqlite_schema WHERE name='ix'", "the index DDL is left untouched")
    }

    /** 可删的列形态: 生成列、NOT NULL DEFAULT、自引用的列级 CHECK、外键子侧列。 */
    @TestCase
    func columnsWithDefaultsChecksOrForeignKeysCanBeDropped(): Unit {
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b INT NOT NULL DEFAULT 7)", "INSERT INTO t VALUES(1,2)"],
            "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", "SELECT * FROM t",
            "dropping a NOT NULL DEFAULT column")
        expectSameEffectAsSqlite(["CREATE TABLE t(a INT, b INT CHECK(b>0))", "INSERT INTO t VALUES(1,2)"],
            "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", "SELECT * FROM t",
            "dropping a column whose CHECK only mentions itself")
        expectSameEffectAsSqlite(
            ["CREATE TABLE p(id INT PRIMARY KEY)", "CREATE TABLE t(a INT, b INT REFERENCES p(id))",
                "INSERT INTO t VALUES(1,NULL)"], "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b",
            "SELECT * FROM t", "dropping a column that is the child side of a foreign key")
    }

    /**
     * 视图里的引用**限定到另一张表**时删列被放过。
     *
     * 这条盯的是"校验写得过宽"。SQLite 会重新解析视图, `u.b` 绑到 u 上, 于是删 t.b 无碍。
     * 按"视图里出现过 b 就拒"实现的话这里会误拒 —— 而误拒是比漏拒更难发现的错, 因为它表现为
     * "一个合法操作莫名失败", 没人会去怀疑校验器。
     */
    @TestCase
    func aViewReferenceQualifiedToAnotherTableDoesNotBlockTheDrop(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(a INT, b INT)",
            "CREATE TABLE u(b INT, z INT)",
            "CREATE VIEW v AS SELECT u.b FROM t JOIN u ON t.a=u.z",
            "INSERT INTO t VALUES(1,2)",
            "INSERT INTO u VALUES(9,1)"
        ]
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", "SELECT * FROM v",
            "a view column qualified to another table")
    }

    /**
     * 触发器建在**别的**表上时, 它 body 里对本表被删列的写入被放过。
     *
     * 对 `CREATE TRIGGER tr AFTER INSERT ON u BEGIN UPDATE t SET b=1; END` 加
     * `ALTER TABLE t DROP COLUMN b` 是**接受**的 —— 它重新 prepare 触发器时并不急着解析
     * UPDATE 目标的列。这条与上一条一起把"过宽的校验"钉住。
     */
    @TestCase
    func aTriggerOnAnotherTableWritingTheDroppedColumnDoesNotBlockTheDrop(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(a INT, b INT)",
            "CREATE TABLE u(x INT)",
            "CREATE TRIGGER tr AFTER INSERT ON u BEGIN UPDATE t SET b=1; END",
            "INSERT INTO t VALUES(1,2)"
        ]
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", "SELECT * FROM t",
            "a trigger on another table that writes the dropped column")
    }

    /**
     * 触发器 body 里**未限定**的列引用属于它操作的那张表, 不是触发器所在的表。
     *
     * `UPDATE l SET seen = b + 1` 里的 b 解析到 l.b。把 body 里未限定的名字当成触发器所在表
     * (t) 的列是个很自然的写法错 —— 毕竟触发器建在 t 上 —— 而它会让这次删列被误拒。
     *
     * b 必须出现在**值表达式**里。若写成 `INSERT INTO l(b) VALUES(1)`，b 只是目标列名而 1 是
     * 字面量，body 的引用清单为空，无法验证未限定引用的归属。
     */
    @TestCase
    func anUnqualifiedTriggerBodyReferenceBelongsToTheTableItWrites(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(a INT, b INT)",
            "CREATE TABLE l(b INT, seen INT)",
            "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE l SET seen = b + 1; END",
            "INSERT INTO t VALUES(1,2)"
        ]
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", "SELECT * FROM t",
            "an unqualified trigger body reference to another table's column")
        expectSameEffectAsSqlite(schema, "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", storedDdl,
            "the stored DDL when a trigger body mentions the name unqualified")
    }

    /** 视图/触发器只引用别的列或别的表时不受影响。 */
    @TestCase
    func unrelatedViewsAndTriggersAreLeftAlone(): Unit {
        expectSameEffectAsSqlite(
            ["CREATE TABLE t(a INT, b INT)", "CREATE VIEW v AS SELECT a FROM t", "INSERT INTO t VALUES(1,2)"],
            "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b", "SELECT * FROM v",
            "a view that only selects a surviving column")
        expectSameEffectAsSqlite(
            ["CREATE TABLE t(a INT, b INT)", "CREATE TABLE u(b INT)", "CREATE VIEW v AS SELECT b FROM u",
                "INSERT INTO u VALUES(5)"], "ALTER TABLE t DROP COLUMN b", "ALTER TABLE t DROP COLUMN b",
            "SELECT * FROM v", "a view over an entirely different table")
    }

    /** `IF EXISTS` 是语法错而不是"静默跳过"。 */
    @TestCase
    func dropColumnDoesNotAcceptIfExists(): Unit {
        expectBothReject(baseSchema, "ALTER TABLE t DROP COLUMN IF EXISTS zz", "DROP COLUMN IF EXISTS")
        expectBothReject(baseSchema, "ALTER TABLE t DROP COLUMN IF EXISTS b", "DROP COLUMN IF EXISTS on a real column")
    }

    /** 不存在的表与不存在的列。 */
    @TestCase
    func missingTablesAndColumnsAreRejected(): Unit {
        expectBothReject(baseSchema, "ALTER TABLE nope DROP COLUMN b", "dropping from a missing table")
        expectBothReject(baseSchema, "ALTER TABLE t DROP COLUMN zz", "dropping a missing column")
        expectBothReject(baseSchema, "ALTER TABLE t DROP COLUMN \"Zz\"", "dropping a missing quoted column")
    }

    /**
     * 主键列不能删, 三种声明形态都覆盖。
     *
     * `INTEGER PRIMARY KEY` 与普通 `PRIMARY KEY` 走的是不同的内部表示 (前者是 rowid 别名,
     * 不进 primaryKeyColumns), 表级 `PRIMARY KEY(a,b)` 又是第三种。只测一种会漏掉另两条路径。
     */
    @TestCase
    func primaryKeyColumnsCannotBeDropped(): Unit {
        expectBothReject(["CREATE TABLE t(a INT PRIMARY KEY, b INT)"], "ALTER TABLE t DROP COLUMN a",
            "dropping a PRIMARY KEY column")
        expectBothReject(["CREATE TABLE t(a INTEGER PRIMARY KEY, b INT)"], "ALTER TABLE t DROP COLUMN a",
            "dropping an INTEGER PRIMARY KEY column")
        expectBothReject(["CREATE TABLE t(a INT, b INT, PRIMARY KEY(a,b))"], "ALTER TABLE t DROP COLUMN a",
            "dropping a member of a table-level PRIMARY KEY")
    }

    /**
     * UNIQUE 列不能删。
     *
     * 列级与表级在 SQLite 里报的是**两种不同的错**: 列级是
     * `cannot drop UNIQUE column`, 表级是改写后重解析失败的 `error in table … no such column`。
     * expectBothReject 只看"拒不拒", 所以两条都列在这里, 而报错形态的区分靠
     * theRejectionReasonDistinguishesColumnLevelFromTableLevelUnique。
     */
    @TestCase
    func uniqueColumnsCannotBeDropped(): Unit {
        expectBothReject(["CREATE TABLE t(a INT UNIQUE, b INT)"], "ALTER TABLE t DROP COLUMN a",
            "dropping a column-level UNIQUE column")
        expectBothReject(["CREATE TABLE t(a INT, b INT, UNIQUE(a,b))"], "ALTER TABLE t DROP COLUMN a",
            "dropping a member of a table-level UNIQUE")
    }

    /**
     * 列级与表级 UNIQUE 的报错文本不同形。
     *
     * 两者都被拒, 所以 expectBothReject 分辨不出实现有没有把它们混成一条。这里直接看消息:
     * 混成一条的实现会在其中一侧给出另一侧的措辞。
     */
    @TestCase
    func theRejectionReasonDistinguishesColumnLevelFromTableLevelUnique(): Unit {
        let columnLevel = dropColumnFailureMessage("CREATE TABLE t(a INT UNIQUE, b INT)", "ALTER TABLE t DROP COLUMN a")
        if (!columnLevel.contains("cannot drop UNIQUE column")) {
            @Fail("a column-level UNIQUE should be refused as `cannot drop UNIQUE column`, got: ${columnLevel}")
        }
        let tableLevel = dropColumnFailureMessage("CREATE TABLE t(a INT, b INT, UNIQUE(a,b))",
            "ALTER TABLE t DROP COLUMN a")
        if (!tableLevel.contains("after drop column")) {
            @Fail("a table-level UNIQUE should be refused as `error in table … after drop column`, got: ${tableLevel}")
        }
    }

    /** 表里只剩一列时不能删。 */
    @TestCase
    func theLastRemainingColumnCannotBeDropped(): Unit {
        expectBothReject(["CREATE TABLE t(a INT)"], "ALTER TABLE t DROP COLUMN a", "dropping the only column")
    }

    /**
     * 检查顺序有可观测后果。
     *
     * 一张只有一列且那列是主键的表, 报的是 PRIMARY KEY 而不是 "no other columns exist";
     * 列不存在又赶上表只有一列时, 报的是 no such column。顺序写反了这两条会互换 ——
     * 而两种顺序下"都被拒"这件事是一样的, 所以只有看消息才有分辨力。
     */
    @TestCase
    func theCheckOrderIsPrimaryKeyBeforeLastColumnAndMissingColumnFirst(): Unit {
        let pkAndOnly = dropColumnFailureMessage("CREATE TABLE t(a INT PRIMARY KEY)", "ALTER TABLE t DROP COLUMN a")
        if (!pkAndOnly.contains("PRIMARY KEY")) {
            @Fail("a sole PRIMARY KEY column should be refused for being a primary key, got: ${pkAndOnly}")
        }
        let missingAndOnly = dropColumnFailureMessage("CREATE TABLE t(a INT)", "ALTER TABLE t DROP COLUMN zz")
        if (!missingAndOnly.contains("no such column")) {
            @Fail("a missing column should be reported before the one-column rule, got: ${missingAndOnly}")
        }
    }

    /** 被删列上有索引、被表级外键引用、被表级 CHECK 引用: 都拒。 */
    @TestCase
    func dependentSchemaObjectsBlockTheDrop(): Unit {
        expectBothReject(["CREATE TABLE t(a INT, b INT)", "CREATE INDEX ix ON t(a)"], "ALTER TABLE t DROP COLUMN a",
            "dropping an indexed column")
        expectBothReject(["CREATE TABLE t(a INT, b INT)", "CREATE INDEX ix ON t(b) WHERE a > 0"],
            "ALTER TABLE t DROP COLUMN a", "dropping a column used by a partial index predicate")
        expectBothReject(
            ["CREATE TABLE p(id INT PRIMARY KEY)", "CREATE TABLE t(a INT, b INT, FOREIGN KEY(b) REFERENCES p(id))"],
            "ALTER TABLE t DROP COLUMN b", "dropping a column named by a table-level foreign key")
        expectBothReject(["CREATE TABLE t(a INT, b INT, CHECK(b > 0))"], "ALTER TABLE t DROP COLUMN b",
            "dropping a column used by a table-level CHECK")
    }

    /** 视图与触发器引用被删列时拒。 */
    @TestCase
    func viewsAndTriggersReferencingTheColumnBlockTheDrop(): Unit {
        expectBothReject(["CREATE TABLE t(a INT, b INT)", "CREATE VIEW v AS SELECT b FROM t"],
            "ALTER TABLE t DROP COLUMN b", "dropping a column selected by a view")
        expectBothReject(
            ["CREATE TABLE t(a INT, b INT)", "CREATE TABLE l(x INT)",
                "CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO l VALUES(NEW.b); END"],
            "ALTER TABLE t DROP COLUMN b", "dropping a column read by a trigger body")
        expectBothReject(
            ["CREATE TABLE t(a INT, b INT)", "CREATE TABLE l(x INT)",
                "CREATE TRIGGER tr AFTER INSERT ON t WHEN NEW.b > 0 BEGIN INSERT INTO l VALUES(1); END"],
            "ALTER TABLE t DROP COLUMN b", "dropping a column read by a trigger WHEN clause")
    }

    /**
     * 校验失败时 DDL 与数据都不留半成品 —— 裸跑一条 ALTER 的形态。
     *
     * 这条验证隐式事务的拒绝路径。runInWriteTransaction 会在 body 抛异常时执行
     * rollbackImplicit，因此无论检查发生在何处，DDL 与数据都不能被部分修改。显式事务中的
     * 检查顺序由 aRefusedDropInsideAnExplicitTransactionLeavesNothingBehind 验证。
     */
    @TestCase
    func aRefusedDropLeavesTheTableAndItsDataUntouched(): Unit {
        let schema: Array<String> = [
            "CREATE TABLE t(a INT, b INT, UNIQUE(a,b))",
            "INSERT INTO t VALUES(1,2),(3,4)"
        ]
        let conn = newMemConn()
        try {
            for (sql in schema) {
                conn.execString(sql)
            }
            try {
                conn.execString("ALTER TABLE t DROP COLUMN a")
                @Fail("dropping a table-level UNIQUE member should have been refused")
            } catch (_: Exception) {
                ()
            }
            let ddl = renderRows(conn.queryString(storedDdl))
            if (!ddl.contains("UNIQUE(a,b)")) {
                @Fail("the stored DDL should be unchanged after a refused drop, got: ${ddl}")
            }
            // 读 a 与 b 两列: 数据被提前重写过的话, record 已经少一列, b 读出来是 NULL 而
            // 不是原值 —— 这正是"先写后校验"的实现留下的形态。
            let rows = renderRows(conn.queryString("SELECT a, b FROM t ORDER BY a"))
            if (rows != "I:1\u{1F}I:2\u{1E}I:3\u{1F}I:4") {
                @Fail("the rows should be unchanged after a refused drop, got: ${rows}")
            }
        } finally {
            conn.close()
        }
    }

    /**
     * 显式事务里被拒的删列, 之后照样 COMMIT: 库里不能留下半成品。
     *
     * 这条才是"校验必须在写之前"的判据。`BEGIN` 之后 implicit 为假, 出错时
     * runInWriteTransaction 只往上抛而不回滚, 于是"先重写数据再校验"的实现会把已经改过的页
     * 跟着 COMMIT 落盘 —— 留下一张 record 少一列、而 DDL 仍写着原列数的表。读它的时候列会
     * 错位, 而 DDL 判据看不出这件事, 所以断言要落在**数据**上。
     *
     * 期望值取自 SQLite: 同一序列 (BEGIN / 失败的 DROP / COMMIT) 之后它的 DDL 与两行数据
     * 都完好。
     */
    @TestCase
    func aRefusedDropInsideAnExplicitTransactionLeavesNothingBehind(): Unit {
        let conn = newMemConn()
        try {
            conn.execString("CREATE TABLE t(a INT, b INT, UNIQUE(a,b))")
            conn.execString("INSERT INTO t VALUES(1,2),(3,4)")
            conn.execString("BEGIN")
            try {
                conn.execString("ALTER TABLE t DROP COLUMN a")
                @Fail("dropping a table-level UNIQUE member should have been refused")
            } catch (_: Exception) {
                ()
            }
            conn.execString("COMMIT")
            let rows = renderRows(conn.queryString("SELECT a, b FROM t ORDER BY a"))
            if (rows != "I:1\u{1F}I:2\u{1E}I:3\u{1F}I:4") {
                @Fail("a refused drop inside a transaction must not survive the commit, got: ${rows}")
            }
            let ddl = renderRows(conn.queryString(storedDdl))
            if (!ddl.contains("UNIQUE(a,b)")) {
                @Fail("the stored DDL should be unchanged after a refused drop, got: ${ddl}")
            }
        } finally {
            conn.close()
        }
    }

    /**
     * 文件库删列后仍能被 SQLite 读取。
     *
     * integrity_check 不是格式正确性的充分判据，对"被引用页号 > dbSize"与
     * "非根叶页 ncell = 0"等损坏可能仍返回 ok。删列会重写每一行的 payload，因此必须通过
     * 独立读取器检查文件。
     */
    @TestCase
    func aFileDatabaseStaysReadableByRealSqliteAfterADrop(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            try {
                conn.execString("CREATE TABLE t(a INT, b TEXT, c INT)")
                conn.execString("CREATE INDEX ix ON t(c)")
                var i = 1
                while (i <= 200) {
                    conn.execString("INSERT INTO t VALUES(${i}, 'row-${i}', ${1000 - i})")
                    i += 1
                }
                // 造出 rowid 空洞：删列若靠"逐行重新 INSERT"实现，空洞会被填掉，独立读取器
                // 看到的 rowid 序列就会发生变化。
                conn.execString("DELETE FROM t WHERE a % 7 = 0")
                conn.execString("ALTER TABLE t DROP COLUMN b")
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*) FROM t", "[(172,)]") +
                    pythonExpect("SELECT sql FROM sqlite_schema WHERE name='t'", "[('CREATE TABLE t(a INT, c INT)',)]") +
                    pythonExpect("SELECT a, c FROM t WHERE c >= 997 ORDER BY a", "[(1, 999), (2, 998), (3, 997)]") +
                    pythonExpect("SELECT rowid, a FROM t ORDER BY rowid LIMIT 3", "[(1, 1), (2, 2), (3, 3)]") +
                    pythonDone(), "real sqlite reads a file database after DROP COLUMN")
        } finally {
            tmp.cleanup()
        }
    }
}

/**
 * 跑一条注定失败的 DROP COLUMN, 返回它的报错消息。
 *
 * 单独抽出来是因为 expectBothReject 只回答"拒不拒", 而检查顺序与报错形态那几条判据要看
 * **消息内容**才有分辨力。
 */
private func dropColumnFailureMessage(schema: String, dml: String): String {
    let conn = newMemConn()
    try {
        conn.execString(schema)
        try {
            conn.execString(dml)
        } catch (e: Exception) {
            return e.message
        }
        @Fail("`${dml}` was expected to fail but it succeeded")
        ""
    } finally {
        conn.close()
    }
}
