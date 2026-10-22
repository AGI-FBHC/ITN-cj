package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * INTEGER PRIMARY KEY 撞值时的冲突处置。
 *
 * checkUniqueConstraints 只遍历索引，而 rowid 别名列不建索引（它就是 B-tree 的键）。
 * 因此必须在冲突处置范围内检查 rowid 碰撞，确保 `INSERT OR IGNORE` 能跳过冲突行。
 *
 * 判据覆盖三种 conflict 动作：IGNORE 跳过、REPLACE 替换、默认 ABORT 抛出异常。只测 ABORT
 * 无法区分异常是在约束检查还是 B-tree 写入时产生。
 */
let PK_SETUP: Array<String> = [
    "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)",
    "INSERT INTO t VALUES (1, 'keep')"
]

@Test
class InsertConflictOnRowidTest {
    /** OR IGNORE 撞主键: 跳过该行, 受影响 0 行, 原行不变。 */
    @TestCase
    func ignoresARowThatCollidesWithAnExistingRowid(): Unit {
        let conn = newMemConn()
        try {
            for (sql in PK_SETUP) {
                let _ = conn.execString(sql)
            }
            @Assert(conn.execString("INSERT OR IGNORE INTO t VALUES (1, 'dropped')"), 0)
            let rs = conn.queryString("SELECT id, v FROM t")
            @Assert(rs.rows.size, 1)
            @Assert(renderValue(rs.rows[0][1]), "T:keep")
        } finally {
            conn.close()
        }
    }

    /** 多行里只跳过撞的那一行, 其余照常插入。 */
    @TestCase
    func ignoresOnlyTheCollidingRowInAMultiRowInsert(): Unit {
        expectSameAsSqlite(PK_SETUP, "SELECT id, v FROM t ORDER BY id", "多行 OR IGNORE 之前的基线")
        let conn = newMemConn()
        try {
            for (sql in PK_SETUP) {
                let _ = conn.execString(sql)
            }
            @Assert(conn.execString("INSERT OR IGNORE INTO t VALUES (1, 'dup'), (2, 'fresh')"), 1)
            let rs = conn.queryString("SELECT id, v FROM t ORDER BY id")
            @Assert(rs.rows.size, 2)
            @Assert(renderValue(rs.rows[0][1]), "T:keep")
            @Assert(renderValue(rs.rows[1][1]), "T:fresh")
        } finally {
            conn.close()
        }
    }

    /** OR REPLACE 撞主键: 换掉原行。 */
    @TestCase
    func replacesTheRowThatOwnsTheRowid(): Unit {
        expectSameAsSqlite([PK_SETUP[0], PK_SETUP[1], "INSERT OR REPLACE INTO t VALUES (1, 'new')"],
            "SELECT id, v FROM t ORDER BY id", "OR REPLACE 撞主键")
    }

    /** 默认 ABORT 抛约束异常, 且不留下半行。 */
    @TestCase
    func abortsOnACollidingRowidByDefault(): Unit {
        let conn = newMemConn()
        try {
            for (sql in PK_SETUP) {
                let _ = conn.execString(sql)
            }
            try {
                let _ = conn.execString("INSERT INTO t VALUES (1, 'dup')")
                @Fail("inserting a duplicate INTEGER PRIMARY KEY should fail")
            } catch (e: SqliteConstraintException) {
                @Expect(e.constraint, "primarykey")
            }
            let rs = conn.queryString("SELECT id, v FROM t")
            @Assert(rs.rows.size, 1)
            @Assert(renderValue(rs.rows[0][1]), "T:keep")
        } finally {
            conn.close()
        }
    }

    /** 两侧都拒同一条语句, 确认这不是"我们额外严格"。 */
    @TestCase
    func rejectsDuplicatePrimaryKeyLikeRealSqlite(): Unit {
        expectBothReject(PK_SETUP, "INSERT INTO t VALUES (1, 'dup')", "重复主键")
    }

    /** 无别名列的表由引擎分配 rowid, 不该受这条检查影响。 */
    @TestCase
    func keepsAppendingRowsForATableWithoutARowidAlias(): Unit {
        expectSameAsSqlite(["CREATE TABLE p (v TEXT)", "INSERT INTO p VALUES ('a'), ('b'), ('c')"],
            "SELECT rowid, v FROM p ORDER BY rowid", "无别名列的 rowid 分配")
    }

    /** upsert 撞主键时走 DO UPDATE, 不该被这条检查提前挡掉。 */
    @TestCase
    func stillRoutesCollisionsToDoUpdate(): Unit {
        expectSameAsSqlite(
            [PK_SETUP[0], PK_SETUP[1],
                "INSERT INTO t VALUES (1, 'incoming') ON CONFLICT (id) DO UPDATE SET v = v || '-merged'"],
            "SELECT id, v FROM t", "upsert 撞主键")
    }
}
