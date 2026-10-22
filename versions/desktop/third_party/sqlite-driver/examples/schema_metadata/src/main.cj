package sqlite_driver_schema_metadata

import sqlite_driver.*

main(args: Array<String>): Int64 {
    if (args.size != 1) {
        eprintln("usage: sqlite_driver_schema_metadata <database-path>")
        return 2
    }
    try {
        let checks = Checks()
        let connection = openSqlite(SqliteDSN(path: args[0]))
        try {
            checkColumnConstraints(checks, connection)
            checkTableConstraints(checks, connection)
            checkTableVariants(checks, connection)
            checkIndexForms(checks, connection)
            checkViewAndTrigger(checks, connection)
            checkSchemaCatalog(checks, connection)
            checkTableInfoPragma(checks, connection)
            checkIndexPragma(checks, connection)
            checkForeignKeyPragma(checks, connection)
            checkCollationAndDatabaseList(checks, connection, args[0])
            checkAlterTable(checks, connection)
            checkDropObjects(checks, connection)
            checkHeaderPragma(checks, connection)
            checkConnectionPragma(checks, connection)
            checkJournalPragma(checks, connection)
            checkIntegrityPragma(checks, connection)
            checkUnknownPragma(checks, connection)
        } finally {
            connection.close()
        }
        println("PASS: schema metadata example (${checks.count} checks)")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

/** 列级约束: PRIMARY KEY / AUTOINCREMENT / NOT NULL / UNIQUE / CHECK / DEFAULT / COLLATE / REFERENCES。 */
func checkColumnConstraints(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE author (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    connection.execString("INSERT INTO author VALUES (1,'ada'),(2,'grace')")
    connection.execString(
        "CREATE TABLE document (" + "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "title TEXT NOT NULL COLLATE NOCASE, " + "slug TEXT UNIQUE, " +
            "status TEXT DEFAULT 'draft' CHECK(status IN ('draft','ready')), " +
            "author_id INT REFERENCES author(id), " + "size INT DEFAULT 0)")

    connection.execString("INSERT INTO document(title, slug, author_id) VALUES ('Alpha','alpha',1)")
    checks.expect("column DEFAULT values",
        renderRows(connection.queryString("SELECT id, status, size FROM document")) == "1|draft|0")

    connection.execString("INSERT INTO document(title, slug, author_id) VALUES ('Beta','beta',2)")
    connection.execString("DELETE FROM document WHERE id=2")
    connection.execString("INSERT INTO document(title, slug, author_id) VALUES ('Gamma','gamma',2)")
    checks.expect("AUTOINCREMENT never reuses a rowid",
        scalarInt(connection, "SELECT id FROM document WHERE title='Gamma'") == 3)

    checks.expect("column NOT NULL",
        constraintRejects(connection, "INSERT INTO document(title, slug) VALUES (NULL,'delta')"))
    checks.expect("column UNIQUE",
        constraintRejects(connection, "INSERT INTO document(title, slug) VALUES ('Delta','alpha')"))
    checks.expect("column CHECK",
        constraintRejects(connection, "INSERT INTO document(title, status) VALUES ('Delta','bogus')"))
    checks.expect("column COLLATE NOCASE",
        scalarInt(connection, "SELECT count(*) FROM document WHERE title='ALPHA'") == 1)
}

/** 表级约束: 复合 PRIMARY KEY / UNIQUE / CHECK / FOREIGN KEY。 */
func checkTableConstraints(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("PRAGMA foreign_keys=ON")
    connection.execString(
        "CREATE TABLE revision (" + "document_id INT NOT NULL, revision INT NOT NULL, checksum TEXT, note TEXT, " +
            "PRIMARY KEY(document_id, revision), UNIQUE(checksum), CHECK(revision > 0), " +
            "FOREIGN KEY(document_id) REFERENCES document(id))")
    connection.execString("INSERT INTO revision VALUES (1,1,'c1','first'),(1,2,'c2','second'),(3,1,'c3','third')")

    checks.expect("table composite PRIMARY KEY",
        constraintRejects(connection, "INSERT INTO revision VALUES (1,1,'c9','duplicate')"))
    checks.expect("table UNIQUE", constraintRejects(connection, "INSERT INTO revision VALUES (1,3,'c1','duplicate')"))
    checks.expect("table CHECK", constraintRejects(connection, "INSERT INTO revision VALUES (1,0,'c9','bad')"))
    checks.expect("table FOREIGN KEY",
        constraintRejects(connection, "INSERT INTO revision VALUES (99,1,'c9','orphan')"))
    checks.expect("composite primary key order",
        renderRows(connection.queryString("SELECT document_id, revision FROM revision ORDER BY document_id, revision")) ==
            "1|1;1|2;3|1")
}

/** IF NOT EXISTS、WITHOUT ROWID 与 CREATE TABLE ... AS SELECT。 */
func checkTableVariants(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY)")
    checks.expect("CREATE TABLE IF NOT EXISTS keeps the original definition",
        connection.queryString("PRAGMA table_info(document)").rowCount == 6)

    connection.execString(
        "CREATE TABLE tag_link (tag TEXT, document_id INT, weight INT DEFAULT 1, " +
            "PRIMARY KEY(tag, document_id)) WITHOUT ROWID")
    connection.execString("INSERT INTO tag_link(tag, document_id) VALUES ('b',3),('a',1),('a',3)")
    checks.expect("WITHOUT ROWID rows follow the primary key",
        renderRows(connection.queryString("SELECT tag, document_id, weight FROM tag_link")) ==
            "a|1|1;a|3|1;b|3|1")
    checks.expect("WITHOUT ROWID primary key columns are NOT NULL",
        renderRows(connection.queryString("PRAGMA table_info(tag_link)")) ==
            "0|tag|TEXT|1|NULL|1;1|document_id|INT|1|NULL|2;2|weight|INT|0|1|0")

    connection.execString("CREATE TABLE document_summary AS SELECT id AS document_id, title FROM document ORDER BY id")
    checks.expect("CREATE TABLE AS SELECT copies rows",
        renderRows(connection.queryString("SELECT document_id, title FROM document_summary ORDER BY document_id")) ==
            "1|Alpha;3|Gamma")
    checks.expect("CREATE TABLE AS SELECT takes the result column names",
        columnValues(connection.queryString("PRAGMA table_info(document_summary)"), "name") == "document_id,title")
}

/** 索引的各种形态: 唯一、多列、逐列 COLLATE 与排序、部分索引、IF NOT EXISTS。 */
func checkIndexForms(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE INDEX ix_document_size ON document(size)")
    connection.execString("CREATE INDEX IF NOT EXISTS ix_document_size ON document(size)")
    connection.execString("CREATE UNIQUE INDEX ux_document_author_title ON document(author_id, title)")
    connection.execString("CREATE INDEX ix_document_ready ON document(title) WHERE status='ready'")
    connection.execString("CREATE INDEX ix_revision_lookup ON revision(document_id ASC, note COLLATE NOCASE DESC)")

    checks.expect("CREATE INDEX IF NOT EXISTS is a no-op",
        scalarInt(connection, "SELECT count(*) FROM sqlite_schema WHERE name='ix_document_size'") == 1)
    checks.expect("CREATE UNIQUE INDEX rejects duplicates",
        constraintRejects(connection, "INSERT INTO document(title, slug, author_id) VALUES ('Alpha','delta',1)"))
    checks.expect("index still serves lookups",
        renderRows(connection.queryString("SELECT title FROM revision JOIN document ON document.id=revision.document_id " +
            "WHERE revision.document_id=3")) == "Gamma")
}

/** 视图 (含显式列名) 与触发器。 */
func checkViewAndTrigger(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE VIEW document_titles (document_id, heading) AS SELECT id, title FROM document")
    checks.expect("CREATE VIEW column alias list",
        renderRows(connection.queryString("SELECT document_id, heading FROM document_titles ORDER BY document_id")) ==
            "1|Alpha;3|Gamma")

    connection.execString(
        "CREATE TRIGGER trg_revision_count AFTER INSERT ON revision BEGIN " +
            "UPDATE document SET size = size + 1 WHERE id = NEW.document_id; END")
    connection.execString("INSERT INTO revision VALUES (3,2,'c4','fourth')")
    checks.expect("CREATE TRIGGER fires on INSERT",
        scalarInt(connection, "SELECT size FROM document WHERE id=3") == 1)
}

/** sqlite_schema 目录表。 */
func checkSchemaCatalog(checks: Checks, connection: SqliteConn): Unit {
    checks.expect("sqlite_schema table row",
        renderRows(connection.queryString(
            "SELECT type, name, tbl_name FROM sqlite_schema WHERE name='revision'")) == "table|revision|revision")
    checks.expect("sqlite_schema index rows",
        renderRows(connection.queryString(
            "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='revision' ORDER BY name")) ==
            "ix_revision_lookup;sqlite_autoindex_revision_1;sqlite_autoindex_revision_2")
    checks.expect("automatic index keeps no DDL text",
        renderRows(connection.queryString(
            "SELECT sql FROM sqlite_schema WHERE name='sqlite_autoindex_revision_1'")) == "NULL")
    checks.expect("sqlite_schema view DDL",
        scalarText(connection, "SELECT sql FROM sqlite_schema WHERE type='view' AND name='document_titles'")
            .startsWith("CREATE VIEW document_titles (document_id, heading)"))
    checks.expect("sqlite_schema trigger DDL",
        scalarText(connection, "SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='trg_revision_count'")
            .contains("AFTER INSERT ON revision"))
    checks.expect("AUTOINCREMENT counter table",
        scalarInt(connection, "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='sqlite_sequence'") == 1)
    checks.expect("sqlite_master names the same catalog",
        scalarInt(connection, "SELECT count(*) FROM sqlite_master WHERE type='trigger'") == 1)
}

/** PRAGMA table_info 与 table_xinfo。 */
func checkTableInfoPragma(checks: Checks, connection: SqliteConn): Unit {
    let info = connection.queryString("PRAGMA table_info(document)")
    checks.expect("table_info column names", columnNameList(info) == "cid,name,type,notnull,dflt_value,pk")
    checks.expect("table_info rows",
        renderRows(info) ==
            "0|id|INTEGER|0|NULL|1;1|title|TEXT|1|NULL|0;2|slug|TEXT|0|NULL|0;" +
            "3|status|TEXT|0|'draft'|0;4|author_id|INT|0|NULL|0;5|size|INT|0|0|0")
    checks.expect("table_xinfo matches table_info",
        renderRows(connection.queryString("PRAGMA table_xinfo(document)")) == renderRows(info))
    checks.expect("table_info on a view lists its columns",
        columnValues(connection.queryString("PRAGMA table_info(document_titles)"), "name") == "document_id,heading")
    checks.expect("table_info on the catalog table",
        columnValues(connection.queryString("PRAGMA table_info(sqlite_schema)"), "name") ==
            "type,name,tbl_name,rootpage,sql")
    checks.expect("table_info on a missing table is empty",
        connection.queryString("PRAGMA table_info(no_such_table)").rowCount == 0)
}

/** PRAGMA index_list、index_info 与 index_xinfo。 */
func checkIndexPragma(checks: Checks, connection: SqliteConn): Unit {
    let list = connection.queryString("PRAGMA index_list(document)")
    checks.expect("index_list column names", columnNameList(list) == "seq,name,unique,origin,partial")
    checks.expect("index_list names",
        columnValues(list, "name") ==
            "sqlite_autoindex_document_1,ix_document_size,ux_document_author_title,ix_document_ready")
    checks.expect("index_list unique flags", columnValues(list, "unique") == "1,0,1,0")
    checks.expect("index_list origins", columnValues(list, "origin") == "u,c,c,c")
    checks.expect("index_list marks the partial index", columnValues(list, "partial") == "0,0,0,1")
    checks.expect("index_list origin of a table-level constraint",
        columnValues(connection.queryString("PRAGMA index_list(revision)"), "origin") == "pk,u,c")
    checks.expect("index_list of a WITHOUT ROWID table",
        renderRows(connection.queryString("PRAGMA index_list(tag_link)")) == "0|sqlite_autoindex_tag_link_1|1|pk|0")

    let info = connection.queryString("PRAGMA index_info(ux_document_author_title)")
    checks.expect("index_info column names", columnNameList(info) == "seqno,cid,name")
    checks.expect("index_info of a multi-column index", renderRows(info) == "0|4|author_id;1|1|title")
    checks.expect("index_xinfo matches index_info",
        renderRows(connection.queryString("PRAGMA index_xinfo(ux_document_author_title)")) == renderRows(info))
    checks.expect("index_info of a collated descending index",
        renderRows(connection.queryString("PRAGMA index_info(ix_revision_lookup)")) == "0|0|document_id;1|3|note")
    checks.expect("index_info of a WITHOUT ROWID primary key",
        renderRows(connection.queryString("PRAGMA index_info(sqlite_autoindex_tag_link_1)")) ==
            "0|0|tag;1|1|document_id")
    checks.expect("index_info on a missing index is empty",
        connection.queryString("PRAGMA index_info(no_such_index)").rowCount == 0)
}

/** PRAGMA foreign_key_list 与 foreign_key_check。 */
func checkForeignKeyPragma(checks: Checks, connection: SqliteConn): Unit {
    connection.execString(
        "CREATE TABLE mirror (document_id INT, revision INT, owner INT, " +
            "FOREIGN KEY(document_id, revision) REFERENCES revision(document_id, revision) " +
            "ON DELETE CASCADE ON UPDATE RESTRICT, " + "FOREIGN KEY(owner) REFERENCES author)")
    connection.execString("INSERT INTO mirror VALUES (1,1,1)")

    let list = connection.queryString("PRAGMA foreign_key_list(mirror)")
    checks.expect("foreign_key_list column names",
        columnNameList(list) == "id,seq,table,from,to,on_update,on_delete,match")
    checks.expect("foreign_key_list composite key and omitted parent columns",
        renderRows(list) ==
            "0|0|revision|document_id|document_id|RESTRICT|CASCADE|NONE;" +
            "0|1|revision|revision|revision|RESTRICT|CASCADE|NONE;" + "1|0|author|owner|NULL|NO ACTION|NO ACTION|NONE")
    checks.expect("foreign_key_list of a column-level REFERENCES",
        renderRows(connection.queryString("PRAGMA foreign_key_list(document)")) ==
            "0|0|author|author_id|id|NO ACTION|NO ACTION|NONE")

    let clean = connection.queryString("PRAGMA foreign_key_check")
    checks.expect("foreign_key_check column names", columnNameList(clean) == "table,rowid,parent,fkid")
    checks.expect("foreign_key_check finds no violation", clean.rowCount == 0)

    // 检查工具不看 PRAGMA foreign_keys 开关: 关着写进来的违约行正是它要找的。
    connection.execString("PRAGMA foreign_keys=OFF")
    connection.execString("INSERT INTO mirror VALUES (1,1,99)")
    connection.execString("PRAGMA foreign_keys=ON")
    checks.expect("foreign_key_check reports the offending row",
        renderRows(connection.queryString("PRAGMA foreign_key_check(mirror)")) == "mirror|2|author|1")
    checks.expect("foreign_key_check scans the whole database",
        connection.queryString("PRAGMA foreign_key_check").rowCount == 1)
    connection.execString("DELETE FROM mirror WHERE owner=99")
    checks.expect("foreign_key_check is clean again",
        connection.queryString("PRAGMA foreign_key_check").rowCount == 0)
}

/** PRAGMA collation_list 与 database_list。 */
func checkCollationAndDatabaseList(checks: Checks, connection: SqliteConn, path: String): Unit {
    let collations = connection.queryString("PRAGMA collation_list")
    checks.expect("collation_list column names", columnNameList(collations) == "seq,name")
    checks.expect("collation_list entries", renderRows(collations) == "0|BINARY;1|NOCASE;2|RTRIM")

    let databases = connection.queryString("PRAGMA database_list")
    checks.expect("database_list column names", columnNameList(databases) == "seq,name,file")
    checks.expect("database_list entry", renderRows(databases) == "0|main|${path}")
}

/** ALTER TABLE 的四种形态。 */
func checkAlterTable(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE staging (id INTEGER PRIMARY KEY, old_name TEXT NOT NULL, note TEXT)")
    connection.execString("CREATE INDEX ix_staging_name ON staging(old_name)")
    connection.execString("INSERT INTO staging VALUES (1,'first','n1')")

    connection.execString("ALTER TABLE staging RENAME TO archive")
    checks.expect("ALTER TABLE RENAME TO", scalarInt(connection, "SELECT count(*) FROM archive") == 1)
    checks.expect("ALTER TABLE RENAME TO retargets the index",
        renderRows(connection.queryString(
            "SELECT tbl_name FROM sqlite_schema WHERE name='ix_staging_name'")) == "archive")

    connection.execString("ALTER TABLE archive RENAME COLUMN old_name TO label")
    checks.expect("ALTER TABLE RENAME COLUMN",
        columnValues(connection.queryString("PRAGMA table_info(archive)"), "name") == "id,label,note")
    checks.expect("ALTER TABLE RENAME COLUMN keeps the data",
        scalarText(connection, "SELECT label FROM archive WHERE id=1") == "first")

    connection.execString("ALTER TABLE archive ADD COLUMN added_at TEXT DEFAULT 'unset'")
    checks.expect("ALTER TABLE ADD COLUMN records the default",
        renderRows(connection.queryString("PRAGMA table_info(archive)")).contains("added_at|TEXT|0|'unset'|0"))
    checks.expect("ALTER TABLE ADD COLUMN backfills existing rows",
        scalarText(connection, "SELECT added_at FROM archive WHERE id=1") == "unset")
    connection.execString("INSERT INTO archive(id, label, note) VALUES (2,'second','n2')")
    checks.expect("ALTER TABLE ADD COLUMN applies the default to new rows",
        scalarText(connection, "SELECT added_at FROM archive WHERE id=2") == "unset")

    connection.execString("ALTER TABLE archive DROP COLUMN note")
    checks.expect("ALTER TABLE DROP COLUMN",
        columnValues(connection.queryString("PRAGMA table_info(archive)"), "name") == "id,label,added_at")
    checks.expect("ALTER TABLE DROP COLUMN keeps the other columns",
        renderRows(connection.queryString("SELECT id, label FROM archive ORDER BY id")) == "1|first;2|second")
    checks.expect("ALTER TABLE rewrites the stored DDL",
        scalarText(connection, "SELECT sql FROM sqlite_schema WHERE name='archive'").contains("added_at"))
}

/** DROP TABLE / INDEX / VIEW / TRIGGER, 含 IF EXISTS。 */
func checkDropObjects(checks: Checks, connection: SqliteConn): Unit {
    connection.execString("CREATE TABLE scratch (id INTEGER PRIMARY KEY, value TEXT)")
    connection.execString(
        "WITH RECURSIVE number(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM number WHERE value<400) " +
            "INSERT INTO scratch SELECT value, 'row-' || value FROM number")
    connection.execString("CREATE INDEX ix_scratch_value ON scratch(value)")
    connection.execString("CREATE VIEW scratch_view AS SELECT id FROM scratch")
    connection.execString(
        "CREATE TRIGGER trg_scratch AFTER INSERT ON scratch BEGIN " +
            "UPDATE scratch SET value='seen' WHERE id=NEW.id; END")
    connection.execString("INSERT INTO scratch VALUES (401,'fresh')")
    checks.expect("trigger on the scratch table",
        scalarText(connection, "SELECT value FROM scratch WHERE id=401") == "seen")

    connection.execString("DROP TRIGGER trg_scratch")
    connection.execString("DROP TRIGGER IF EXISTS trg_scratch")
    checks.expect("DROP TRIGGER",
        scalarInt(connection, "SELECT count(*) FROM sqlite_schema WHERE name='trg_scratch'") == 0)

    connection.execString("DROP VIEW scratch_view")
    connection.execString("DROP VIEW IF EXISTS scratch_view")
    checks.expect("DROP VIEW",
        scalarInt(connection, "SELECT count(*) FROM sqlite_schema WHERE name='scratch_view'") == 0)

    connection.execString("DROP INDEX ix_scratch_value")
    connection.execString("DROP INDEX IF EXISTS ix_scratch_value")
    checks.expect("DROP INDEX", connection.queryString("PRAGMA index_list(scratch)").rowCount == 0)

    connection.execString("DROP TABLE scratch")
    connection.execString("DROP TABLE IF EXISTS scratch")
    checks.expect("DROP TABLE",
        scalarInt(connection, "SELECT count(*) FROM sqlite_schema WHERE tbl_name='scratch'") == 0)
}

/** 文件头与页统计类 PRAGMA。 */
func checkHeaderPragma(checks: Checks, connection: SqliteConn): Unit {
    let pageSize = connection.queryString("PRAGMA page_size")
    checks.expect("page_size column name", columnNameList(pageSize) == "page_size")
    checks.expect("page_size value", renderRows(pageSize) == "4096")
    connection.execString("PRAGMA page_size=8192")
    checks.expect("page_size is fixed once the file exists",
        scalarInt(connection, "PRAGMA page_size") == 4096)

    checks.expect("page_count column name",
        columnNameList(connection.queryString("PRAGMA page_count")) == "page_count")
    checks.expect("page_count value", scalarInt(connection, "PRAGMA page_count") > 1)
    checks.expect("freelist_count column name",
        columnNameList(connection.queryString("PRAGMA freelist_count")) == "freelist_count")
    checks.expect("DROP TABLE returns pages to the freelist",
        scalarInt(connection, "PRAGMA freelist_count") > 0)

    let encoding = connection.queryString("PRAGMA encoding")
    checks.expect("encoding column name", columnNameList(encoding) == "encoding")
    checks.expect("encoding value", renderRows(encoding) == "UTF-8")

    checks.expect("user_version default", scalarInt(connection, "PRAGMA user_version") == 0)
    connection.execString("PRAGMA user_version=42")
    checks.expect("user_version write", scalarInt(connection, "PRAGMA user_version") == 42)
    connection.execString("PRAGMA application_id=4242")
    checks.expect("application_id write", scalarInt(connection, "PRAGMA application_id") == 4242)

    checks.expect("schema_version tracks DDL", scalarInt(connection, "PRAGMA schema_version") > 0)
    checks.expect("schema_version is read-only", runtimeRejects(connection, "PRAGMA schema_version=1"))

    // cache_size 的正数是页数、负数是 KiB, 读回一律是负数形式。
    connection.execString("PRAGMA cache_size=400")
    checks.expect("cache_size accepts a page count", scalarInt(connection, "PRAGMA cache_size") == -1600)
    connection.execString("PRAGMA cache_size=-2000")
    checks.expect("cache_size accepts a KiB budget", scalarInt(connection, "PRAGMA cache_size") == -2000)
}

/** 连接行为类 PRAGMA。 */
func checkConnectionPragma(checks: Checks, connection: SqliteConn): Unit {
    let timeout = connection.queryString("PRAGMA busy_timeout")
    checks.expect("busy_timeout column name", columnNameList(timeout) == "timeout")
    connection.execString("PRAGMA busy_timeout=1500")
    checks.expect("busy_timeout write", scalarInt(connection, "PRAGMA busy_timeout") == 1500)

    checks.expect("foreign_keys read", scalarInt(connection, "PRAGMA foreign_keys") == 1)
    connection.execString("PRAGMA foreign_keys=OFF")
    checks.expect("foreign_keys write", scalarInt(connection, "PRAGMA foreign_keys") == 0)
    connection.execString("PRAGMA foreign_keys=ON")

    connection.execString("BEGIN")
    let rejected = runtimeRejects(connection, "PRAGMA foreign_keys=OFF")
    connection.execString("ROLLBACK")
    checks.expect("foreign_keys cannot change inside a transaction", rejected)

    checks.expect("recursive_triggers default", scalarInt(connection, "PRAGMA recursive_triggers") == 0)
    connection.execString("PRAGMA recursive_triggers=ON")
    checks.expect("recursive_triggers write", scalarInt(connection, "PRAGMA recursive_triggers") == 1)
    connection.execString("PRAGMA recursive_triggers=OFF")
}

/** 日志模式与 WAL 相关 PRAGMA。 */
func checkJournalPragma(checks: Checks, connection: SqliteConn): Unit {
    checks.expect("journal_mode default", scalarText(connection, "PRAGMA journal_mode") == "delete")
    checks.expect("journal_mode=WAL", scalarText(connection, "PRAGMA journal_mode=WAL") == "wal")
    checks.expect("journal_mode is persistent", scalarText(connection, "PRAGMA journal_mode") == "wal")

    connection.execString("PRAGMA wal_autocheckpoint=8")
    checks.expect("wal_autocheckpoint write", scalarInt(connection, "PRAGMA wal_autocheckpoint") == 8)
    // journal_size_limit 的赋值形态也返回生效后的值。
    checks.expect("journal_size_limit write returns the value",
        scalarInt(connection, "PRAGMA journal_size_limit=32768") == 32768)
    checks.expect("journal_size_limit read", scalarInt(connection, "PRAGMA journal_size_limit") == 32768)

    connection.execString("INSERT INTO document(title, slug, author_id) VALUES ('Delta','delta',1)")
    let modes: Array<String> = ["", "(PASSIVE)", "(FULL)", "(RESTART)", "(TRUNCATE)"]
    for (mode in modes) {
        let result = connection.queryString("PRAGMA wal_checkpoint${mode}")
        checks.expect("wal_checkpoint${mode} result shape",
            columnNameList(result) == "busy,log,checkpointed" && result.rowCount == 1)
        checks.expect("wal_checkpoint${mode} is never busy", intAt(result, 0, 0) == 0)
    }
    checks.expect("journal_mode=DELETE", scalarText(connection, "PRAGMA journal_mode=DELETE") == "delete")
}

/** 完整性检查。 */
func checkIntegrityPragma(checks: Checks, connection: SqliteConn): Unit {
    let full = connection.queryString("PRAGMA integrity_check")
    checks.expect("integrity_check column name", columnNameList(full) == "integrity_check")
    checks.expect("integrity_check result", renderRows(full) == "ok")
    checks.expect("quick_check result", scalarText(connection, "PRAGMA quick_check") == "ok")
}

/** 未知 PRAGMA: 查询形态返回空结果集, 赋值形态静默忽略。 */
func checkUnknownPragma(checks: Checks, connection: SqliteConn): Unit {
    let probe = connection.queryString("PRAGMA no_such_pragma")
    checks.expect("unknown pragma query returns an empty result set",
        probe.rowCount == 0 && probe.columnNames.size == 0)
    checks.expect("unknown pragma assignment is ignored", connection.execString("PRAGMA no_such_pragma=7") == 0)
    checks.expect("unknown pragma keeps no state",
        connection.queryString("PRAGMA no_such_pragma").rowCount == 0)
}

func constraintRejects(connection: SqliteConn, sql: String): Bool {
    try {
        let _ = connection.execString(sql)
    } catch (_: SqliteConstraintException) {
        return true
    }
    false
}

func runtimeRejects(connection: SqliteConn, sql: String): Bool {
    try {
        let _ = connection.execString(sql)
    } catch (_: SqliteRuntimeException) {
        return true
    }
    false
}

func scalarInt(connection: SqliteConn, sql: String): Int64 {
    match (connection.queryString(sql).rows[0][0]) {
        case SInt(value) => value
        case value => throw Exception("expected integer from '${sql}', got ${value}")
    }
}

func scalarText(connection: SqliteConn, sql: String): String {
    match (connection.queryString(sql).rows[0][0]) {
        case SText(value) => value
        case value => throw Exception("expected text from '${sql}', got ${value}")
    }
}

func intAt(rows: SqliteResultSet, row: Int64, column: Int64): Int64 {
    match (rows.rows[row][column]) {
        case SInt(value) => value
        case value => throw Exception("expected integer, got ${value}")
    }
}

/** 结果集的列名, 逗号分隔。 */
func columnNameList(rows: SqliteResultSet): String {
    let output = StringBuilder()
    for (i in 0..rows.columnNames.size) {
        if (i > 0) {
            output.append(",")
        }
        output.append(rows.columnNames[i])
    }
    output.toString()
}

/** 某一列的全部取值, 逗号分隔。 */
func columnValues(rows: SqliteResultSet, columnName: String): String {
    let output = StringBuilder()
    for (i in 0..rows.rowCount) {
        if (i > 0) {
            output.append(",")
        }
        output.append(renderValue(rows.value(i, columnName)))
    }
    output.toString()
}

func renderRows(rows: SqliteResultSet): String {
    let output = StringBuilder()
    for (rowIndex in 0..rows.rows.size) {
        if (rowIndex > 0) {
            output.append(";")
        }
        let row = rows.rows[rowIndex]
        for (columnIndex in 0..row.size) {
            if (columnIndex > 0) {
                output.append("|")
            }
            output.append(renderValue(row[columnIndex]))
        }
    }
    output.toString()
}

func renderValue(value: SqliteValue): String {
    match (value) {
        case SNull => "NULL"
        case SInt(number) => "${number}"
        case SReal(number) => "${number}"
        case SText(text) => text
        case SBlob(bytes) => "blob:${bytes.size}"
    }
}

class Checks {
    private var passed: Int64 = 0

    prop count: Int64 {
        get() {
            passed
        }
    }

    func expect(label: String, condition: Bool): Unit {
        if (!condition) {
            throw Exception("check failed: ${label}")
        }
        passed += 1
        println("PASS: ${label}")
    }
}
