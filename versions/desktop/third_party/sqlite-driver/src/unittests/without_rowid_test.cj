package sqlite_driver.unittests

import sqlite_driver.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * WITHOUT ROWID 表。
 *
 * 这类表的表树就是索引树，行身份是主键而不是 Int64 rowid。语义与 SQLite 差分，
 * 文件布局通过双向互读验证，避免本地编解码同时出现相同错误。
 */
private let wrBase: Array<String> = [
    "CREATE TABLE t(a INT, b TEXT, c TEXT, PRIMARY KEY(b,a)) WITHOUT ROWID",
    "INSERT INTO t VALUES (2,'k','two'),(1,'k','one'),(9,'a','aye')"
]

@Test
class WithoutRowidSchemaTest {
    @TestCase
    func requiresAPrimaryKeyAndRejectsAutoincrement(): Unit {
        expectBothReject(Array<String>(), "CREATE TABLE t(a INT) WITHOUT ROWID", "a row key is mandatory")
        expectBothReject(Array<String>(), "CREATE TABLE t(a INTEGER PRIMARY KEY AUTOINCREMENT) WITHOUT ROWID",
            "AUTOINCREMENT has no rowid to increment")
    }

    @TestCase
    func acceptsARepeatedWithoutRowidOption(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(a INT PRIMARY KEY) WITHOUT ROWID, WITHOUT ROWID",
                "INSERT INTO t VALUES (3),(1),(2)"
            ],
            "SELECT a FROM t",
            "a repeated WITHOUT ROWID table option"
        )
    }

    @TestCase
    func exposesPrimaryKeyMetadataWithoutASchemaIndexRow(): Unit {
        expectSameAsSqlite(["CREATE TABLE t(a INT, b INT UNIQUE, c TEXT, PRIMARY KEY(c,a)) WITHOUT ROWID"],
            "PRAGMA table_info(t)", "primary-key positions in table_info")
        expectSameAsSqlite(["CREATE TABLE t(a INT, b INT UNIQUE, c TEXT, PRIMARY KEY(c,a)) WITHOUT ROWID"],
            "PRAGMA index_list(t)", "the virtual primary-key index in index_list")
        expectSameAsSqlite(["CREATE TABLE t(a INT, b INT UNIQUE, c TEXT, PRIMARY KEY(c,a)) WITHOUT ROWID"],
            "PRAGMA index_info(sqlite_autoindex_t_2)", "index_info on the virtual primary-key index")
    }

    @TestCase
    func rejectsRowidPseudoColumnsButLetsRealColumnsShadowThem(): Unit {
        expectBothReject(["CREATE TABLE t(a INT PRIMARY KEY) WITHOUT ROWID"], "SELECT rowid FROM t",
            "rowid does not exist")
        expectBothReject(["CREATE TABLE t(a INT PRIMARY KEY) WITHOUT ROWID"], "SELECT oid FROM t", "oid does not exist")
        expectSameAsSqlite(
            [
                "CREATE TABLE t(rowid TEXT PRIMARY KEY, v INT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('real',7)"
            ],
            "SELECT rowid,v FROM t",
            "a real rowid column wins"
        )
    }

    @TestCase
    func rejectsPseudoRowidInEmptyDmlAndReturningPaths(): Unit {
        let schema = ["CREATE TABLE t(a INT PRIMARY KEY, v INT) WITHOUT ROWID"]
        expectBothReject(schema, "UPDATE t SET v=rowid WHERE 0", "rowid in an UPDATE assignment on an empty table")
        expectBothReject(schema, "UPDATE t SET v=1 WHERE rowid=7", "rowid in an UPDATE predicate on an empty table")
        expectBothReject(schema, "DELETE FROM t WHERE 0 ORDER BY rowid LIMIT 1",
            "rowid in a DELETE ordering expression on an empty table")
        expectBothReject(schema, "UPDATE t SET v=1 WHERE 0 RETURNING rowid", "rowid in an empty RETURNING result")
    }
}

@Test
class WithoutRowidCrudTest {
    @TestCase
    func scansInCompositePrimaryKeyOrder(): Unit {
        expectSameAsSqlite(wrBase, "SELECT b,a,c FROM t", "the table scan follows the composite primary key")
        expectSameAsSqlite(
            [
                "CREATE TABLE t(a INT PRIMARY KEY DESC, v TEXT) WITHOUT ROWID",
                "INSERT INTO t VALUES (1,'one'),(3,'three'),(2,'two')"
            ],
            "SELECT a,v FROM t",
            "DESC changes the physical table order"
        )
        expectSameAsSqlite(
            [
                "CREATE TABLE t(a TEXT COLLATE NOCASE PRIMARY KEY, v INT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('C',3),('a',1),('B',2)"
            ],
            "SELECT a,v FROM t",
            "the primary-key collation changes table order"
        )
        expectSameAsSqlite(
            [
                "CREATE TABLE t(a TEXT, v INT, PRIMARY KEY(a COLLATE NOCASE)) WITHOUT ROWID",
                "INSERT INTO t VALUES ('C',3),('a',1),('B',2)"
            ],
            "SELECT a,v FROM t",
            "a table-level primary-key collation changes table order"
        )
    }

    @TestCase
    func appliesAffinityAndImplicitNotNullToPrimaryKeys(): Unit {
        expectSameAsSqlite(
            [
                "CREATE TABLE t(a INTEGER PRIMARY KEY, v TEXT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('7','seven')"
            ],
            "SELECT a,typeof(a),v FROM t",
            "INTEGER is an ordinary affinity-bearing key"
        )
        expectBothReject(["CREATE TABLE t(a TEXT PRIMARY KEY) WITHOUT ROWID"], "INSERT INTO t VALUES (NULL)",
            "a primary-key column is implicitly NOT NULL")
    }

    @TestCase
    func enforcesPrimaryKeyConflictsAndConflictActions(): Unit {
        expectBothReject(
            [
                "CREATE TABLE t(a TEXT PRIMARY KEY, v INT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('k',1)"
            ],
            "INSERT INTO t VALUES ('k',2)",
            "a duplicate primary key"
        )
        expectSameEffectAsSqlite(
            [
                "CREATE TABLE t(a TEXT PRIMARY KEY, v INT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('k',1)"
            ],
            "INSERT OR IGNORE INTO t VALUES ('k',2)",
            "INSERT OR IGNORE INTO t VALUES ('k',2)",
            "SELECT * FROM t",
            "IGNORE on a primary-key conflict"
        )
        expectSameEffectAsSqlite(
            [
                "CREATE TABLE t(a TEXT PRIMARY KEY, v INT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('k',1)"
            ],
            "INSERT OR REPLACE INTO t VALUES ('k',2)",
            "INSERT OR REPLACE INTO t VALUES ('k',2)",
            "SELECT * FROM t",
            "REPLACE on a primary-key conflict"
        )
        expectSameEffectAsSqlite(
            [
                "CREATE TABLE t(a TEXT PRIMARY KEY, v INT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('k',1)"
            ],
            "INSERT INTO t VALUES ('k',2) ON CONFLICT DO UPDATE SET v=excluded.v+1",
            "INSERT INTO t VALUES ('k',2) ON CONFLICT DO UPDATE SET v=excluded.v+1",
            "SELECT * FROM t",
            "upsert on a primary-key conflict"
        )
    }

    @TestCase
    func updatesAndDeletesByStablePrimaryKeyIdentity(): Unit {
        expectSameEffectAsSqlite(wrBase, "UPDATE t SET a=5,c='moved' WHERE b='k' AND a=1",
            "UPDATE t SET a=5,c='moved' WHERE b='k' AND a=1", "SELECT * FROM t", "updating a primary key moves the row")
        expectSameEffectAsSqlite(wrBase, "DELETE FROM t WHERE b='k' AND a=2", "DELETE FROM t WHERE b='k' AND a=2",
            "SELECT * FROM t", "deleting by a composite primary key")
        expectBothReject(wrBase, "UPDATE t SET a=2 WHERE b='k' AND a=1", "updating into an existing primary key")
    }

    @TestCase
    func maintainsSecondaryIndexesWithPrimaryKeySuffixes(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a INT, b TEXT, u TEXT UNIQUE, v INT, PRIMARY KEY(b,a)) WITHOUT ROWID",
            "CREATE INDEX ix_v_b ON t(v,b)",
            "INSERT INTO t VALUES (1,'x','u1',7),(2,'x','u2',7),(3,'y','u3',8)"
        ]
        expectSameAsSqlite(setup, "SELECT b,a,u FROM t WHERE v=7 ORDER BY b,a",
            "a non-unique secondary index appends only missing key columns")
        expectSameEffectAsSqlite(setup, "UPDATE t SET v=9,u='u4' WHERE b='x' AND a=2",
            "UPDATE t SET v=9,u='u4' WHERE b='x' AND a=2", "SELECT b,a,u,v FROM t WHERE v>=7 ORDER BY v,b,a",
            "updating indexed values and the unique index")
        expectBothReject(setup, "INSERT INTO t VALUES (4,'z','u1',10)", "a unique secondary index conflict")
    }

    @TestCase
    func partialUniqueIndexesOnlyConstrainRowsInTheirPredicate(): Unit {
        let setup: Array<String> = [
            "CREATE TABLE t(a TEXT PRIMARY KEY, v INT) WITHOUT ROWID",
            "CREATE UNIQUE INDEX ux ON t(v) WHERE v > 0",
            "INSERT INTO t VALUES ('zero',0)"
        ]
        expectSameEffectAsSqlite(setup, "INSERT OR REPLACE INTO t VALUES ('one',0)",
            "INSERT OR REPLACE INTO t VALUES ('one',0)", "SELECT a,v FROM t ORDER BY a",
            "a partial unique index ignores rows outside its predicate")
        expectSameEffectAsSqlite(setup, "INSERT INTO t VALUES ('two',0) ON CONFLICT DO UPDATE SET v=excluded.v+1",
            "INSERT INTO t VALUES ('two',0) ON CONFLICT DO UPDATE SET v=excluded.v+1", "SELECT a,v FROM t ORDER BY a",
            "upsert does not find a partial-index conflict outside its predicate")
    }

    @TestCase
    func explainUsesThePrimaryKeyFastPath(): Unit {
        let conn = newMemConn()
        try {
            conn.execString("CREATE TABLE t(a INT, b TEXT, PRIMARY KEY(b,a)) WITHOUT ROWID")
            let detail = textOf(conn.queryString("EXPLAIN QUERY PLAN SELECT * FROM t WHERE b='x' AND a=2").rows[0][3])
            @Expect(detail.contains("USING PRIMARY KEY"), true)
        } finally {
            conn.close()
        }
    }

    @TestCase
    func doesNotChangeLastInsertRowid(): Unit {
        let conn = newMemConn()
        try {
            conn.execString("CREATE TABLE r(id INTEGER PRIMARY KEY)")
            conn.execString("INSERT INTO r VALUES (41)")
            conn.execString("CREATE TABLE w(id INTEGER PRIMARY KEY) WITHOUT ROWID")
            conn.execString("INSERT INTO w VALUES (99)")
            @Expect(conn.lastInsertRowid, 41)
        } finally {
            conn.close()
        }
    }
}

@Test
class WithoutRowidIntegrationTest {
    @TestCase
    func foreignKeysAndReturningUseOrdinaryPrimaryKeyValues(): Unit {
        let setup: Array<String> = [
            "PRAGMA foreign_keys=ON",
            "CREATE TABLE p(a TEXT, b INT, PRIMARY KEY(a,b)) WITHOUT ROWID",
            "CREATE TABLE c(id TEXT PRIMARY KEY, pa TEXT, pb INT, FOREIGN KEY(pa,pb) REFERENCES p(a,b) ON UPDATE CASCADE ON DELETE CASCADE) WITHOUT ROWID",
            "INSERT INTO p VALUES ('p',1)",
            "INSERT INTO c VALUES ('c','p',1)"
        ]
        expectSameEffectAsSqlite(setup, "UPDATE p SET b=2 WHERE a='p'", "UPDATE p SET b=2 WHERE a='p'",
            "SELECT * FROM c", "an ON UPDATE CASCADE into a WITHOUT ROWID child")
        expectSameEffectAsSqlite(setup, "DELETE FROM p WHERE a='p'", "DELETE FROM p WHERE a='p'",
            "SELECT count(*) FROM c", "an ON DELETE CASCADE into a WITHOUT ROWID child")
        expectSameAsSqlite(
            [
                "CREATE TABLE t(a TEXT PRIMARY KEY, v INT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('k',3)"
            ],
            "UPDATE t SET v=v+1 RETURNING a,v",
            "RETURNING on a WITHOUT ROWID update"
        )
        expectSameEffectAsSqlite(
            [
                "PRAGMA foreign_keys=ON",
                "CREATE TABLE p(a TEXT, b INT, PRIMARY KEY(b,a)) WITHOUT ROWID",
                "CREATE TABLE c(id INT PRIMARY KEY, x INT, y TEXT, " +
                    "FOREIGN KEY(x,y) REFERENCES p ON UPDATE CASCADE) WITHOUT ROWID",
                "INSERT INTO p VALUES ('p',1)",
                "INSERT INTO c VALUES (9,1,'p')"
            ],
            "UPDATE p SET a='q' WHERE b=1",
            "UPDATE p SET a='q' WHERE b=1",
            "SELECT x,y FROM c",
            "an omitted parent-column foreign key follows declared primary-key order"
        )
    }

    @TestCase
    func dropColumnAndVacuumPreserveTheIndexTable(): Unit {
        expectSameEffectAsSqlite(
            [
                "CREATE TABLE t(a TEXT PRIMARY KEY, removable TEXT, kept INT) WITHOUT ROWID",
                "INSERT INTO t VALUES ('b','drop',2),('a','drop',1)"
            ],
            "ALTER TABLE t DROP COLUMN removable",
            "ALTER TABLE t DROP COLUMN removable",
            "SELECT * FROM t",
            "dropping a non-key column rewrites index-tree payloads"
        )
        expectBothReject(["CREATE TABLE t(a TEXT PRIMARY KEY, v INT) WITHOUT ROWID"], "ALTER TABLE t DROP COLUMN a",
            "a primary-key column cannot be dropped")

        let conn = newMemConn()
        try {
            conn.execString("CREATE TABLE t(a TEXT PRIMARY KEY, v INT UNIQUE) WITHOUT ROWID")
            conn.execString("INSERT INTO t VALUES ('b',2),('a',1),('c',3)")
            conn.execString("DELETE FROM t WHERE a='b'")
            conn.execString("VACUUM")
            @Expect(textOf(conn.queryString("SELECT group_concat(a,'') FROM t").rows[0][0]), "ac")
            @Expect(textOf(conn.queryString("PRAGMA integrity_check").rows[0][0]), "ok")
        } finally {
            conn.close()
        }
    }

    @TestCase
    func driverWrittenFilesAreReadableAndWritableByRealSqlite(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            try {
                conn.execString("CREATE TABLE t(a INT, b TEXT, payload TEXT, PRIMARY KEY(b DESC,a)) WITHOUT ROWID")
                conn.execString("CREATE INDEX ix_payload ON t(payload)")
                conn.execString("INSERT INTO t VALUES (1,'x','small'),(2,'x','second'),(3,'y','third')")
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect(
                    "SELECT b,a,payload FROM t ORDER BY b DESC,a",
                    "[('y', 3, 'third'), ('x', 1, 'small'), ('x', 2, 'second')]") +
                    "cur.execute(\"UPDATE t SET payload='changed' WHERE b='x' AND a=2\")\n" +
                    "cur.execute(\"INSERT INTO t VALUES (4,'z','python')\")\n" + pythonDone(),
                "real sqlite reads and modifies a driver-written WITHOUT ROWID file")
            let reopened = openFileConn(tmp.dbPath)
            try {
                @Expect(textOf(reopened.queryString("SELECT payload FROM t WHERE b='x' AND a=2").rows[0][0]),
                    "changed")
                @Expect(scalarInt(reopened, "SELECT count(*) FROM t"), 4)
            } finally {
                reopened.close()
            }
        } finally {
            tmp.cleanup()
        }
    }

    @TestCase
    func readsAndModifiesARealSqliteWithoutRowidFile(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            expectPythonOk(
                pythonOpen(tmp.dbPath) +
                    "cur.execute(\"CREATE TABLE t(a TEXT PRIMARY KEY, payload TEXT) WITHOUT ROWID\")\n" +
                    "cur.execute(\"CREATE INDEX ix_payload ON t(payload)\")\n" +
                    "cur.execute(\"INSERT INTO t VALUES ('b',printf('%08000d',2)),('a','short')\")\n" + pythonDone(),
                "real sqlite creates the source WITHOUT ROWID file")
            let conn = openFileConn(tmp.dbPath)
            try {
                @Expect(scalarInt(conn, "SELECT length(payload) FROM t WHERE a='b'"), 8000)
                conn.execString("UPDATE t SET payload='driver' WHERE a='b'")
                conn.execString("INSERT INTO t VALUES ('c','added')")
                @Expect(textOf(conn.queryString("PRAGMA integrity_check").rows[0][0]), "ok")
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT a,payload FROM t ORDER BY a",
                    "[('a', 'short'), ('b', 'driver'), ('c', 'added')]") + pythonDone(),
                "real sqlite reads the driver-modified WITHOUT ROWID file")
        } finally {
            tmp.cleanup()
        }
    }

    @TestCase
    func splitTableTreesRemainCrossDriverReadableAndWritable(): Unit {
        requirePython()
        let tmp = TempDbDir()
        try {
            let conn = openFileConn(tmp.dbPath)
            try {
                conn.execString("CREATE TABLE t(id INT PRIMARY KEY, payload TEXT) WITHOUT ROWID")
                conn.execString("CREATE INDEX ix_payload ON t(payload)")
                conn.execString("BEGIN")
                let pad = repeatText("x", 240)
                for (i in 1..2501) {
                    conn.exec("INSERT INTO t VALUES (?,?)", [SqliteValue.SInt(i), SqliteValue.SText("${i}:${pad}")])
                }
                conn.execString("COMMIT")
                conn.execString("UPDATE t SET id=5001,payload='driver-moved' WHERE id=1250")
                conn.execString("DELETE FROM t WHERE id BETWEEN 2000 AND 2100")
                @Expect(textOf(conn.queryString("PRAGMA integrity_check").rows[0][0]), "ok")
            } finally {
                conn.close()
            }
            expectPythonOk(
                pythonOpen(tmp.dbPath) + pythonIntegrityCheck() + pythonExpect("SELECT count(*),min(id),max(id) FROM t",
                    "[(2399, 1, 5001)]") + pythonExpect("SELECT payload FROM t WHERE id=5001", "[('driver-moved',)]") +
                    "cur.execute(\"UPDATE t SET id=6001,payload='python-moved' WHERE id=5001\")\n" +
                    "cur.execute(\"DELETE FROM t WHERE id BETWEEN 100 AND 150\")\n" + pythonDone(),
                "real sqlite traverses and modifies a split driver-written table tree")
            let reopened = openFileConn(tmp.dbPath)
            try {
                @Expect(scalarInt(reopened, "SELECT count(*) FROM t"), 2348)
                @Expect(textOf(reopened.queryString("SELECT payload FROM t WHERE id=6001").rows[0][0]),
                    "python-moved")
                @Expect(textOf(reopened.queryString("PRAGMA integrity_check").rows[0][0]), "ok")
            } finally {
                reopened.close()
            }
        } finally {
            tmp.cleanup()
        }
    }
}
