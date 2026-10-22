package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 外键约束。
 *
 * 每种引用动作各一例, 且判据必须能分辨相邻动作 —— 五种动作里有三对极易写成同一分支:
 *   - NO ACTION 与 RESTRICT: 立即约束下行为一致, 只在 DEFERRABLE 时分开。
 *   - SET NULL 与 SET DEFAULT: 列无 DEFAULT 时行为一致, 所以这里的子表列**必须带 DEFAULT**。
 *   - CASCADE 的 delete 与 update 方向: 只测删则改键那一支永不执行。
 * 每例都按"两分支互换后本例是否会红"来设计, 不满足这一条的用例不写。
 */

/** 开一条内存连接并打开外键 —— 默认关闭, 不打开则全部用例都恒绿。 */
func fkConn(): SqliteConn {
    let conn = openSqlite(SqliteDSN(path: ":memory:"))
    let _ = conn.execString("PRAGMA foreign_keys = ON")
    conn
}

/** 建一对父子表。childCols 直接拼进 CREATE TABLE, 由各例决定动作与 DEFAULT。 */
func makeParentChild(conn: SqliteConn, childCols: String): Unit {
    let _ = conn.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT)")
    let _ = conn.execString("CREATE TABLE child (${childCols})")
    let _ = conn.execString("INSERT INTO parent VALUES (1, 'one'), (2, 'two')")
}

func fkRowCount(conn: SqliteConn, sql: String): Int64 {
    conn.queryString(sql).rowCount
}

@Test
class ForeignKeySwitchTest {
    @TestCase
    func pragmaReportsTheValueThatWasSet(): Unit {
        let conn = openSqlite(SqliteDSN(path: ":memory:"))
        // 默认关闭, 与 SQLite 一致。
        @Expect(scalarInt(conn, "PRAGMA foreign_keys"), 0)
        let _ = conn.execString("PRAGMA foreign_keys = ON")
        @Expect(scalarInt(conn, "PRAGMA foreign_keys"), 1)
        let _ = conn.execString("PRAGMA foreign_keys = OFF")
        @Expect(scalarInt(conn, "PRAGMA foreign_keys"), 0)
        conn.close()
    }

    @TestCase
    func constraintIsNotEnforcedWhileTheSwitchIsOff(): Unit {
        // 开关必须真的控制实施。恒实施的话本例会红, 恒不实施则 violation 那些例会红 ——
        // 两例一起把"开关被消费"钉住。
        let conn = openSqlite(SqliteDSN(path: ":memory:"))
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 999)")
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 1)
        conn.close()
    }

    @TestCase
    func switchCannotBeFlippedInsideATransaction(): Unit {
        let conn = fkConn()
        let _ = conn.execString("BEGIN")
        try {
            let _ = conn.execString("PRAGMA foreign_keys = OFF")
            @Fail("flipping foreign_keys inside a transaction should be rejected")
        } catch (e: SqliteRuntimeException) {
            @Expect(e.message.contains("inside a transaction"), true)
        }
        let _ = conn.execString("ROLLBACK")
        conn.close()
    }
}

@Test
class ForeignKeyChildDirectionTest {
    @TestCase
    func insertWithMissingParentIsRejected(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id)")
        try {
            let _ = conn.execString("INSERT INTO child VALUES (1, 999)")
            @Fail("inserting a row that references a missing parent should fail")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        // 失败的语句不能留下半行。
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 0)
        conn.close()
    }

    @TestCase
    func insertWithExistingParentSucceeds(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 2)")
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 1)
        conn.close()
    }

    @TestCase
    func nullChildKeyIsExemptFromTheCheck(): Unit {
        // MATCH SIMPLE: NULL 免检。写成"NULL 也要查父行"则本例红。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id)")
        let _ = conn.execString("INSERT INTO child VALUES (1, NULL)")
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 1)
        conn.close()
    }

    @TestCase
    func partiallyNullCompositeKeyIsExempt(): Unit {
        // 复合外键: 任一列 NULL 即整条免检。写成"全 NULL 才免检"则本例红 ——
        // 这里 pb 有值且在父表里不存在配对, 严格实现会拒。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE p2 (a INT, b INT, PRIMARY KEY (a, b))")
        let _ = conn.execString(
            "CREATE TABLE c2 (id INTEGER PRIMARY KEY, pa INT, pb INT, " + "FOREIGN KEY (pa, pb) REFERENCES p2(a, b))")
        let _ = conn.execString("INSERT INTO p2 VALUES (1, 1)")
        let _ = conn.execString("INSERT INTO c2 VALUES (1, NULL, 77)")
        @Expect(fkRowCount(conn, "SELECT * FROM c2"), 1)
        conn.close()
    }

    @TestCase
    func compositeKeyWithBothValuesMustMatchAsAPair(): Unit {
        // 两列各自都在父表里出现过, 但不作为同一行出现 —— 按行匹配才会拒, 按列分别匹配则漏。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE p2 (a INT, b INT, PRIMARY KEY (a, b))")
        let _ = conn.execString(
            "CREATE TABLE c2 (id INTEGER PRIMARY KEY, pa INT, pb INT, " + "FOREIGN KEY (pa, pb) REFERENCES p2(a, b))")
        let _ = conn.execString("INSERT INTO p2 VALUES (1, 1), (2, 2)")
        try {
            let _ = conn.execString("INSERT INTO c2 VALUES (1, 1, 2)")
            @Fail("a composite key must match one parent row, not two different rows")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        conn.close()
    }

    @TestCase
    func updatingChildKeyToAMissingParentIsRejected(): Unit {
        // UPDATE 也要走子表方向的校验。只在 INSERT 上接线则本例红。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        try {
            let _ = conn.execString("UPDATE child SET pid = 999 WHERE id = 1")
            @Fail("updating a child key to a missing parent should fail")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        @Expect(scalarInt(conn, "SELECT pid FROM child WHERE id = 1"), 1)
        conn.close()
    }

    @TestCase
    func referencingAMissingTableIsRejectedAtWriteTime(): Unit {
        // 子表可以先建 (父表那时还不存在), 但写子行的那一刻父表必须在。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE orphan (id INTEGER PRIMARY KEY, pid INT REFERENCES nowhere(id))")
        try {
            let _ = conn.execString("INSERT INTO orphan VALUES (1, 1)")
            @Fail("writing a child row whose parent table is missing should fail")
        } catch (e: SqliteConstraintException) {
            @Expect(e.message.contains("missing table"), true)
        }
        conn.close()
    }

    @TestCase
    func omittedParentColumnListUsesThePrimaryKey(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        try {
            let _ = conn.execString("INSERT INTO child VALUES (2, 42)")
            @Fail("the implicit parent key is the primary key, so 42 must be rejected")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        conn.close()
    }
}

@Test
class ForeignKeyOnDeleteTest {
    @TestCase
    func onDeleteNoActionRejectsWhileChildRowsRemain(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        try {
            let _ = conn.execString("DELETE FROM parent WHERE id = 1")
            @Fail("deleting a parent that still has children should fail under NO ACTION")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        @Expect(fkRowCount(conn, "SELECT * FROM parent WHERE id = 1"), 1)
        conn.close()
    }

    @TestCase
    func onDeleteRestrictRejects(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id) ON DELETE RESTRICT")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        try {
            let _ = conn.execString("DELETE FROM parent WHERE id = 1")
            @Fail("RESTRICT must reject the delete")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        conn.close()
    }

    @TestCase
    func onDeleteCascadeRemovesChildRows(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id) ON DELETE CASCADE")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1), (2, 1), (3, 2)")
        let _ = conn.execString("DELETE FROM parent WHERE id = 1")
        // 引用 1 的两行走了, 引用 2 的那行留着 —— 只按"清空子表"实现则后半句红。
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 1)
        @Expect(scalarInt(conn, "SELECT id FROM child"), 3)
        conn.close()
    }

    @TestCase
    func onDeleteSetNullClearsTheChildKey(): Unit {
        // 子列带 DEFAULT 7: SET NULL 若被写成 SET DEFAULT 则这里读到 7, 本例红。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT DEFAULT 7 REFERENCES parent(id) ON DELETE SET NULL")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        let _ = conn.execString("DELETE FROM parent WHERE id = 1")
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 1)
        @Expect(scalarText(conn, "SELECT typeof(pid) FROM child WHERE id = 1"), "null")
        conn.close()
    }

    @TestCase
    func onDeleteSetDefaultWritesTheColumnDefault(): Unit {
        // 与上一例配对: DEFAULT 指向存在的父行 2, 所以置默认值后仍合法。
        // SET DEFAULT 若被写成 SET NULL 则这里读到 NULL, 本例红。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT DEFAULT 2 REFERENCES parent(id) ON DELETE SET DEFAULT")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        let _ = conn.execString("DELETE FROM parent WHERE id = 1")
        @Expect(scalarInt(conn, "SELECT pid FROM child WHERE id = 1"), 2)
        conn.close()
    }

    @TestCase
    func onDeleteSetDefaultPointingAtAMissingParentFails(): Unit {
        // 默认值本身违约时这条 DELETE 必须整体失败, 不能留下一个违约的子行。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT DEFAULT 999 REFERENCES parent(id) ON DELETE SET DEFAULT")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        try {
            let _ = conn.execString("DELETE FROM parent WHERE id = 1")
            @Fail("a DEFAULT that violates the constraint must abort the delete")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        conn.close()
    }

    @TestCase
    func cascadeChainsThroughTwoLevels(): Unit {
        // 三层: 删 parent 应连带 child 与 grandchild。只做一层则最后一句红。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id) ON DELETE CASCADE")
        let _ = conn.execString(
            "CREATE TABLE grandchild (id INTEGER PRIMARY KEY, cid INT " + "REFERENCES child(id) ON DELETE CASCADE)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        let _ = conn.execString("INSERT INTO grandchild VALUES (1, 1)")
        let _ = conn.execString("DELETE FROM parent WHERE id = 1")
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 0)
        @Expect(fkRowCount(conn, "SELECT * FROM grandchild"), 0)
        conn.close()
    }

    @TestCase
    func selfReferencingCascadeDeletesTheSubtree(): Unit {
        // 自引用是合法且常见的形态, 不能被防环逻辑误拦。
        let conn = fkConn()
        let _ = conn.execString(
            "CREATE TABLE node (id INTEGER PRIMARY KEY, parent_id INT " + "REFERENCES node(id) ON DELETE CASCADE)")
        let _ = conn.execString("INSERT INTO node VALUES (1, NULL), (2, 1), (3, 2), (4, NULL)")
        let _ = conn.execString("DELETE FROM node WHERE id = 1")
        // 1→2→3 整条链走, 4 留着。
        @Expect(fkRowCount(conn, "SELECT * FROM node"), 1)
        @Expect(scalarInt(conn, "SELECT id FROM node"), 4)
        conn.close()
    }
}

@Test
class ForeignKeyOnUpdateTest {
    @TestCase
    func onUpdateCascadeRewritesTheChildKey(): Unit {
        // 改键方向: CASCADE 在 update 时是"写新键", 不是"删子行"。
        // 两方向共用一支则子行会被删掉, 第一句就红。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id) ON UPDATE CASCADE")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        let _ = conn.execString("UPDATE parent SET id = 10 WHERE id = 1")
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 1)
        @Expect(scalarInt(conn, "SELECT pid FROM child WHERE id = 1"), 10)
        conn.close()
    }

    @TestCase
    func onUpdateSetNullClearsTheChildKey(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT DEFAULT 7 REFERENCES parent(id) ON UPDATE SET NULL")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        let _ = conn.execString("UPDATE parent SET id = 10 WHERE id = 1")
        @Expect(scalarText(conn, "SELECT typeof(pid) FROM child WHERE id = 1"), "null")
        conn.close()
    }

    @TestCase
    func onUpdateSetDefaultWritesTheColumnDefault(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT DEFAULT 2 REFERENCES parent(id) ON UPDATE SET DEFAULT")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        let _ = conn.execString("UPDATE parent SET id = 10 WHERE id = 1")
        @Expect(scalarInt(conn, "SELECT pid FROM child WHERE id = 1"), 2)
        conn.close()
    }

    @TestCase
    func onUpdateRestrictRejects(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id) ON UPDATE RESTRICT")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        try {
            let _ = conn.execString("UPDATE parent SET id = 10 WHERE id = 1")
            @Fail("RESTRICT must reject the parent key update")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        @Expect(scalarInt(conn, "SELECT id FROM parent WHERE label = 'one'"), 1)
        conn.close()
    }

    @TestCase
    func onDeleteSetDefaultPointingAtTheDeletedRowFails(): Unit {
        // DEFAULT 指向正在被删的那一行。只有"先删父行再施加动作"的顺序才判得出违约 ——
        // 反过来则自检在父行还在的状态下通过, 留下一个引用已删行的子行, 而且全绿。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT DEFAULT 1 REFERENCES parent(id) ON DELETE SET DEFAULT")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        try {
            let _ = conn.execString("DELETE FROM parent WHERE id = 1")
            @Fail("a DEFAULT pointing at the row being deleted must abort the delete")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        conn.close()
    }

    @TestCase
    func updatingANonKeyColumnTriggersNoAction(): Unit {
        // 键没变就不该级联。按"父行被 UPDATE 就级联"实现则 label 一改子行就被清空, 本例红。
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id) ON UPDATE SET NULL")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1)")
        let _ = conn.execString("UPDATE parent SET label = 'renamed' WHERE id = 1")
        @Expect(scalarInt(conn, "SELECT pid FROM child WHERE id = 1"), 1)
        conn.close()
    }
}

@Test
class ForeignKeyDeferredTest {
    @TestCase
    func deferredCheckToleratesAnIntermediateViolation(): Unit {
        // 延迟约束的全部用途: 事务中间态可以违约, COMMIT 时补齐即可。
        // 写成立即校验则第一条 INSERT 就红。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        let _ = conn.execString(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INT " +
                "REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)")
        let _ = conn.execString("BEGIN")
        let _ = conn.execString("INSERT INTO child VALUES (1, 5)")
        let _ = conn.execString("INSERT INTO parent VALUES (5)")
        let _ = conn.execString("COMMIT")
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 1)
        conn.close()
    }

    @TestCase
    func deferredViolationLeftUnfixedFailsAtCommit(): Unit {
        // 与上一例配对: 不补齐则 COMMIT 必须失败。缺了这一例, "延迟"会退化成"不检查"。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        let _ = conn.execString(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INT " +
                "REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)")
        let _ = conn.execString("BEGIN")
        let _ = conn.execString("INSERT INTO child VALUES (1, 5)")
        try {
            let _ = conn.execString("COMMIT")
            @Fail("an unresolved deferred violation must fail the commit")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        conn.close()
    }

    @TestCase
    func deferredViolationRemovedBeforeCommitIsAccepted(): Unit {
        // 违约的子行在同一事务里被删掉 —— COMMIT 时按当时状态重查, 应通过。
        // 按"记下的行"而不是"记下的键值重查"实现则本例红。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        let _ = conn.execString(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INT " +
                "REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)")
        let _ = conn.execString("BEGIN")
        let _ = conn.execString("INSERT INTO child VALUES (1, 5)")
        let _ = conn.execString("DELETE FROM child WHERE id = 1")
        let _ = conn.execString("COMMIT")
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 0)
        conn.close()
    }

    @TestCase
    func rollbackDiscardsPendingDeferredChecks(): Unit {
        // 回滚后待验清单必须清空, 否则下一个事务会带着上一个事务的违约记录被拒。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        let _ = conn.execString(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INT " +
                "REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)")
        let _ = conn.execString("BEGIN")
        let _ = conn.execString("INSERT INTO child VALUES (1, 5)")
        let _ = conn.execString("ROLLBACK")
        // 干净事务, 不该受上一轮影响。
        let _ = conn.execString("BEGIN")
        let _ = conn.execString("INSERT INTO parent VALUES (5)")
        let _ = conn.execString("COMMIT")
        @Expect(fkRowCount(conn, "SELECT * FROM parent"), 1)
        conn.close()
    }

    @TestCase
    func restrictIgnoresDeferrability(): Unit {
        // RESTRICT 与 NO ACTION 的唯一区别: 前者无视 DEFERRABLE, 立即生效。
        // 两者合并成一支则本例红 (会被推到 COMMIT 才报, 于是 DELETE 那句不抛)。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        let _ = conn.execString(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INT " +
                "REFERENCES parent(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED)")
        let _ = conn.execString("INSERT INTO parent VALUES (5)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 5)")
        let _ = conn.execString("BEGIN")
        try {
            let _ = conn.execString("DELETE FROM parent WHERE id = 5")
            @Fail("RESTRICT is immediate even when the constraint is DEFERRABLE")
        } catch (e: SqliteConstraintException) {
            @Expect(e.constraint, "foreignkey")
        }
        let _ = conn.execString("ROLLBACK")
        conn.close()
    }

    @TestCase
    func deferredNoActionAllowsDeleteThenChildCleanup(): Unit {
        // 与上一例配对: 同样的序列在 NO ACTION 下合法 —— 先删父行, 同一事务内再删子行。
        // 这是 SQL 标准里 NO ACTION 与 RESTRICT 唯一的区别所在。
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        let _ = conn.execString(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INT " +
                "REFERENCES parent(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED)")
        let _ = conn.execString("INSERT INTO parent VALUES (5)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 5)")
        let _ = conn.execString("BEGIN")
        let _ = conn.execString("DELETE FROM parent WHERE id = 5")
        let _ = conn.execString("DELETE FROM child WHERE id = 1")
        let _ = conn.execString("COMMIT")
        @Expect(fkRowCount(conn, "SELECT * FROM parent"), 0)
        @Expect(fkRowCount(conn, "SELECT * FROM child"), 0)
        conn.close()
    }
}

@Test
class ForeignKeyPragmaTest {
    @TestCase
    func foreignKeyListReportsEachDeclaredKey(): Unit {
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
        let _ = conn.execString(
            "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INT " +
                "REFERENCES parent(id) ON DELETE CASCADE ON UPDATE SET NULL)")
        let rs = conn.queryString("PRAGMA foreign_key_list(child)")
        @Expect(rs.rowCount, 1)
        // 列序与 SQLite 一致: id, seq, table, from, to, on_update, on_delete, match。
        @Expect(rs.columnNames[2], "table")
        @Expect(rs.columnNames[5], "on_update")
        @Expect(rs.columnNames[6], "on_delete")
        match (rs.rows[0][2]) {
            case SText(s) => @Expect(s, "parent")
            case v => @Fail("expected the parent table name, got ${v}")
        }
        match (rs.rows[0][6]) {
            case SText(s) => @Expect(s, "CASCADE")
            case v => @Fail("expected the ON DELETE action, got ${v}")
        }
        match (rs.rows[0][5]) {
            case SText(s) => @Expect(s, "SET NULL")
            case v => @Fail("expected the ON UPDATE action, got ${v}")
        }
        conn.close()
    }

    @TestCase
    func foreignKeyListGivesOneRowPerColumnOfACompositeKey(): Unit {
        let conn = fkConn()
        let _ = conn.execString("CREATE TABLE p2 (a INT, b INT, PRIMARY KEY (a, b))")
        let _ = conn.execString(
            "CREATE TABLE c2 (id INTEGER PRIMARY KEY, pa INT, pb INT, " + "FOREIGN KEY (pa, pb) REFERENCES p2(a, b))")
        let rs = conn.queryString("PRAGMA foreign_key_list(c2)")
        // 一条复合外键占两行, seq 为 0 与 1。按"一条外键一行"实现则本例红。
        @Expect(rs.rowCount, 2)
        match ((rs.rows[0][1], rs.rows[1][1])) {
            case (SInt(a), SInt(b)) =>
                @Expect(a, 0)
                @Expect(b, 1)
            case _ => @Fail("expected integer seq values")
        }
        conn.close()
    }

    @TestCase
    func foreignKeyCheckFindsRowsWrittenWhileTheSwitchWasOff(): Unit {
        // 开关关着时写进去的违约行, 打开后由 foreign_key_check 找出来。
        // 恒返回空表则本例红。
        let conn = openSqlite(SqliteDSN(path: ":memory:"))
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 999), (2, 1)")
        let _ = conn.execString("PRAGMA foreign_keys = ON")
        let rs = conn.queryString("PRAGMA foreign_key_check")
        // 只有引用 999 的那行违约。
        @Expect(rs.rowCount, 1)
        match (rs.rows[0][0]) {
            case SText(s) => @Expect(s, "child")
            case v => @Fail("expected the offending table name, got ${v}")
        }
        conn.close()
    }

    @TestCase
    func foreignKeyCheckIsEmptyForAConsistentDatabase(): Unit {
        let conn = fkConn()
        makeParentChild(conn, "id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id)")
        let _ = conn.execString("INSERT INTO child VALUES (1, 1), (2, 2)")
        @Expect(fkRowCount(conn, "PRAGMA foreign_key_check"), 0)
        conn.close()
    }
}
