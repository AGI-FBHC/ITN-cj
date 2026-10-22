package sqlite_driver.unittests

import std.unittest.*
import std.unittest.testmacro.*

let VIEW_SETUP: Array<String> = [
    "CREATE TABLE base(id INTEGER PRIMARY KEY, grp TEXT, v INT)",
    "INSERT INTO base VALUES (1,'a',10),(2,'a',20),(3,'b',30)",
    "CREATE VIEW visible AS SELECT id, grp, v FROM base WHERE v >= 20"
]

@Test
class ViewReadTest {
    @TestCase
    func readsAPlainView(): Unit {
        expectSameAsSqlite(VIEW_SETUP, "SELECT * FROM visible ORDER BY id", "plain view expansion")
    }

    @TestCase
    func anExplicitColumnListRenamesTheViewColumns(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT, v TEXT)",
                "INSERT INTO t VALUES (1,'x')",
                "CREATE VIEW renamed(a,b) AS SELECT id, v FROM t"
            ],
            "SELECT b, a FROM renamed",
            "view column alias list"
        )
    }

    @TestCase
    func aViewAlwaysSeesTheLatestRows(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "CREATE VIEW live AS SELECT id FROM t",
                "INSERT INTO t VALUES (2),(1)"
            ],
            "SELECT * FROM live ORDER BY id",
            "views are not stale materializations"
        )
    }

    @TestCase
    func aViewMayContainAJoinAndColumnMerge(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE a(id INT, av TEXT)",
                "CREATE TABLE b(id INT, bv TEXT)",
                "INSERT INTO a VALUES (1,'a1'),(2,'a2')",
                "INSERT INTO b VALUES (2,'b2'),(3,'b3')",
                "CREATE VIEW joined AS SELECT * FROM a FULL JOIN b USING(id)"
            ],
            "SELECT * FROM joined ORDER BY id",
            "join semantics inside a view"
        )
    }

    @TestCase
    func aViewMayContainAWithClause(): Unit {
        expectSameAsSqlite(VIEW_SETUP, "SELECT * FROM (SELECT * FROM visible) ORDER BY id", "view use inside a subquery")
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "INSERT INTO t VALUES (1),(2)",
                "CREATE VIEW cte_view AS WITH x AS (SELECT id + 10 AS n FROM t) SELECT n FROM x"
            ],
            "SELECT * FROM cte_view ORDER BY n",
            "CTE inside a view body"
        )
    }

    @TestCase
    func aNestedViewExpandsThroughAnotherView(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT, v INT)",
                "INSERT INTO t VALUES (1,3),(2,4)",
                "CREATE VIEW first_v AS SELECT id, v * 2 AS doubled FROM t",
                "CREATE VIEW second_v AS SELECT id, doubled + 1 AS answer FROM first_v"
            ],
            "SELECT * FROM second_v ORDER BY id",
            "nested view expansion"
        )
    }

    @TestCase
    func sqliteSchemaStoresAViewWithRootPageZero(): Unit {
        expectSameAsSqlite(VIEW_SETUP, "SELECT type, name, tbl_name, rootpage FROM sqlite_schema WHERE name='visible'",
            "view schema row")
    }

    @TestCase
    func pragmaTableInfoDescribesAView(): Unit {
        expectSameAsSqlite(VIEW_SETUP, "PRAGMA table_info(visible)", "PRAGMA table_info on a view")
    }

    @TestCase
    func aViewKeepsItsResultColumnNames(): Unit {
        expectSameColumnNamesAsSqlite(VIEW_SETUP, "SELECT * FROM visible", "view result column names")
    }
}

@Test
class ViewDdlTest {
    @TestCase
    func createIfNotExistsIsIdempotent(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "INSERT INTO t VALUES (1)",
                "CREATE VIEW v AS SELECT id FROM t",
                "CREATE VIEW IF NOT EXISTS v AS SELECT id + 100 AS id FROM t"
            ],
            "SELECT * FROM v",
            "CREATE VIEW IF NOT EXISTS"
        )
    }

    @TestCase
    func dropViewRemovesOnlyTheView(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(id INT)",
                "INSERT INTO t VALUES (7)",
                "CREATE VIEW v AS SELECT id FROM t",
                "DROP VIEW v"
            ],
            "SELECT id FROM t",
            "DROP VIEW keeps its base table"
        )
    }

    @TestCase
    func aViewCannotBeWrittenWithoutAnInsteadOfTrigger(): Unit {
        expectBothReject(VIEW_SETUP, "INSERT INTO visible VALUES (4,'c',40)",
            "write to a view without INSTEAD OF trigger")
    }

    @TestCase
    func dropTableCannotBeUsedForAView(): Unit {
        expectBothReject(VIEW_SETUP, "DROP TABLE visible", "DROP TABLE on a view")
    }

    @TestCase
    func aViewColumnListMustMatchTheBodyWidthWhenUsed(): Unit {
        expectBothReject(
            [
                "CREATE TABLE t(a INT, b INT)",
                "INSERT INTO t VALUES (1,2)",
                "CREATE VIEW bad(x) AS SELECT a, b FROM t"
            ],
            "SELECT * FROM bad",
            "view alias count mismatch"
        )
    }
}
