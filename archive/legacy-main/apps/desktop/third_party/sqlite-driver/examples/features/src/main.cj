package sqlite_driver_features

import std.convert.*
import sqlite_driver.*

let DUMP_QUERIES: Array<String> = [
    "PRAGMA integrity_check",
    "PRAGMA journal_mode",
    "SELECT count(*) FROM sqlite_schema WHERE type='table'",
    "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
    "SELECT id, v FROM tc ORDER BY id",
    "SELECT id, v FROM ud ORDER BY id",
    "SELECT id, pid, note FROM child ORDER BY id",
    "SELECT id, pid FROM c2",
    "SELECT count(*) FROM bulk",
    "SELECT id, v FROM wt ORDER BY id"
]

/*
 * SQL 功能矩阵。
 *
 * 每条查询都输出稳定的规范化文本，运行脚本会与已验证的期望结果逐行比较。
 *
 * 用法: sqlite_driver_features <数据库文件路径>
 */
main(args: Array<String>): Int64 {
    if (args.size >= 2 && args[0] == "dump") {
        dumpDb(args[1])
        return 0
    }
    if (args.size < 1) {
        eprintln("usage: sqlite_driver_features <database-path>")
        eprintln("       sqlite_driver_features dump <database-path>")
        return 1
    }
    let conn = openSqlite(SqliteDSN(path: args[0]))
    try {
        runCases(conn)
    } finally {
        conn.close()
    }
    return 0
}

/** 打开既有数据库并打印一组稳定查询结果。 */
func dumpDb(path: String): Unit {
    let conn = openSqlite(SqliteDSN(path: path))
    try {
        for (sql in DUMP_QUERIES) {
            querySql(conn, sql)
        }
    } finally {
        conn.close()
    }
}

func runCases(conn: SqliteConn): Unit {
    var caseId = 0

    // 存储类型
    caseId += 1
    emitCase(caseId, "storage.types")
    execSql(conn, "CREATE TABLE mixed (i INTEGER, r REAL, t TEXT, b BLOB, n TEXT)")
    execParams(conn, "INSERT INTO mixed(i,r,t,b,n) VALUES (?,?,?,?,?)",
        [SqliteValue.SInt(-9007199254740993), SqliteValue.SReal(3.5), SqliteValue.SText("héllo"),
            SqliteValue.SBlob([0u8, 1u8, 254u8, 255u8]), SqliteValue.SNull])
    querySql(conn, "SELECT i, r, t, n FROM mixed")
    querySql(conn, "SELECT hex(b) FROM mixed")
    querySql(conn, "SELECT typeof(i), typeof(r), typeof(t), typeof(b), typeof(n) FROM mixed")

    // 约束与索引
    caseId += 1
    emitCase(caseId, "ddl.constraints")
    execSql(conn,
        "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, " +
            "score REAL DEFAULT 1.5, age INT CHECK (age >= 0))")
    querySql(conn, "PRAGMA table_info(people)")

    caseId += 1
    emitCase(caseId, "ddl.index")
    execSql(conn, "CREATE INDEX idx_people_age ON people(age)")
    execSql(conn, "CREATE UNIQUE INDEX idx_people_score ON people(score)")
    querySql(conn,
        "SELECT type, name, tbl_name FROM sqlite_schema " + "WHERE type='index' AND tbl_name='people' ORDER BY name")

    caseId += 1
    emitCase(caseId, "ddl.alter")
    execSql(conn, "CREATE TABLE old_name (id INTEGER PRIMARY KEY, v TEXT)")
    execSql(conn, "INSERT INTO old_name(v) VALUES ('kept')")
    execSql(conn, "ALTER TABLE old_name RENAME TO new_name")
    execSql(conn, "ALTER TABLE new_name ADD COLUMN extra TEXT")
    execSql(conn, "ALTER TABLE new_name RENAME COLUMN v TO label")
    querySql(conn, "SELECT id, label, extra FROM new_name")

    caseId += 1
    emitCase(caseId, "ddl.ctas")
    execSql(conn, "CREATE TABLE src (id INTEGER PRIMARY KEY, n INT)")
    execSql(conn, "INSERT INTO src VALUES (1,10),(2,20),(3,30)")
    execSql(conn, "CREATE TABLE copy AS SELECT id, n * 2 AS doubled FROM src WHERE n >= 20")
    querySql(conn, "SELECT id, doubled FROM copy ORDER BY id")

    caseId += 1
    emitCase(caseId, "ddl.drop")
    execSql(conn, "CREATE TABLE gone (id INTEGER PRIMARY KEY, pad TEXT)")
    execSql(conn, "CREATE VIEW gone_view AS SELECT id FROM gone")
    execSql(conn, "DROP VIEW gone_view")
    execSql(conn, "DROP TABLE IF EXISTS gone")
    querySql(conn, "SELECT type, name FROM sqlite_schema WHERE name LIKE 'gone%' ORDER BY name")

    // 数据写入与修改
    caseId += 1
    emitCase(caseId, "dml.insert_defaults")
    execSql(conn, "CREATE TABLE d (id INTEGER PRIMARY KEY AUTOINCREMENT, a INT DEFAULT 7, b TEXT DEFAULT 'd')")
    execSql(conn, "INSERT INTO d DEFAULT VALUES")
    execSql(conn, "INSERT INTO d(a) VALUES (10)")
    querySql(conn, "SELECT id, a, b FROM d ORDER BY id")

    caseId += 1
    emitCase(caseId, "dml.ignore_replace")
    execSql(conn, "CREATE TABLE ir (id INTEGER PRIMARY KEY, v TEXT)")
    execSql(conn, "INSERT INTO ir VALUES (1,'first')")
    execSql(conn, "INSERT OR IGNORE INTO ir VALUES (1,'dup'),(2,'second')")
    execSql(conn, "INSERT OR REPLACE INTO ir VALUES (1,'new')")
    querySql(conn, "SELECT id, v FROM ir ORDER BY id")

    caseId += 1
    emitCase(caseId, "dml.upsert")
    execSql(conn, "CREATE TABLE u (id INTEGER PRIMARY KEY, v TEXT, n INT)")
    execSql(conn, "INSERT INTO u VALUES (1,'a',10)")
    execSql(conn,
        "INSERT INTO u VALUES (1,'incoming',99) " +
            "ON CONFLICT(id) DO UPDATE SET v = u.v || '-' || excluded.v, n = excluded.n")
    execSql(conn, "INSERT INTO u VALUES (2,'fresh',20) ON CONFLICT(id) DO NOTHING")
    querySql(conn, "SELECT id, v, n FROM u ORDER BY id")

    caseId += 1
    emitCase(caseId, "dml.update_delete")
    execSql(conn, "CREATE TABLE ud (id INTEGER PRIMARY KEY, v TEXT, n INT)")
    execSql(conn, "INSERT INTO ud VALUES (1,'a',1),(2,'b',2),(3,'c',3),(4,'d',4)")
    execSql(conn, "UPDATE ud SET n = n * 10, v = v || '!' WHERE id <= 2")
    execSql(conn, "DELETE FROM ud WHERE id IN (3,4)")
    querySql(conn, "SELECT id, v, n FROM ud ORDER BY id")

    caseId += 1
    emitCase(caseId, "dml.returning_insert")
    execSql(conn, "CREATE TABLE ri (id INTEGER PRIMARY KEY, v TEXT, n INT DEFAULT 5)")
    querySql(conn, "INSERT INTO ri(v) VALUES ('a'),('b'),('c') RETURNING id, v, n")

    caseId += 1
    emitCase(caseId, "dml.returning_update")
    querySql(conn, "UPDATE ri SET n = n * 2, v = v || '!' WHERE id <= 2 RETURNING id, v, n")

    caseId += 1
    emitCase(caseId, "dml.returning_delete")
    querySql(conn, "DELETE FROM ri WHERE id = 3 RETURNING id, v, n")
    querySql(conn, "SELECT id, v, n FROM ri ORDER BY id")

    // 查询表达式
    caseId += 1
    emitCase(caseId, "select.expressions")
    querySql(conn, "SELECT 1+2*3, 10/4, 10.0/4.0, 10%3, -7/2, 'ab' || 'cd', 1<<4, 256>>2, 5&3, 5|3, ~0")

    caseId += 1
    emitCase(caseId, "select.where_logic")
    querySql(conn,
        "SELECT CASE WHEN 1>0 AND 'a'<'b' THEN 'yes' ELSE 'no' END, " +
            "1 IN (1,2,3), 5 NOT IN (1,2,3), 3 BETWEEN 1 AND 5, " + "NULL IS NULL, 0 IS NOT NULL, NOT (1=2)")

    caseId += 1
    emitCase(caseId, "select.like_glob")
    querySql(conn,
        "SELECT 'apple' LIKE 'a%', 'apple' LIKE 'a_le', 'Apple' LIKE 'a%', " +
            "'apple' GLOB 'a*', 'a1b' GLOB 'a[0-9]b', 'hello' LIKE '%llo%'")

    caseId += 1
    emitCase(caseId, "select.order_limit_distinct")
    execSql(conn, "CREATE TABLE o (id INT, g TEXT, v INT)")
    execSql(conn, "INSERT INTO o VALUES (1,'b',20),(2,'a',10),(3,'b',20),(4,'a',30)")
    querySql(conn, "SELECT g, v FROM o ORDER BY g DESC, v DESC, id")
    querySql(conn, "SELECT DISTINCT g, v FROM o ORDER BY g, v")
    querySql(conn, "SELECT id, v FROM o ORDER BY v DESC LIMIT 2 OFFSET 1")

    caseId += 1
    emitCase(caseId, "select.group_having")
    querySql(conn, "SELECT g, count(*) AS c, sum(v) AS s, avg(v) AS a FROM o GROUP BY g HAVING sum(v) > 10 ORDER BY g")

    caseId += 1
    emitCase(caseId, "select.string_functions")
    querySql(conn,
        "SELECT length('héllo'), upper('abc'), lower('ABC'), substr('hello',2,3), " +
            "instr('hello','ll'), replace('hello','l','L'), trim('  hi  '), ltrim('xxhix','x'), " +
            "rtrim('hixxx','x'), concat('a',NULL,'b'), concat_ws('-','a',NULL,'b')")

    caseId += 1
    emitCase(caseId, "select.math_functions")
    querySql(conn,
        "SELECT abs(-5), round(2.567,2), sqrt(4), pow(2,10), exp(0), ln(1), log(100), log10(1000), " +
            "log2(8), floor(1.7), ceil(1.2), mod(-7,3), pi(), sin(0), cos(0), degrees(pi())")

    caseId += 1
    emitCase(caseId, "select.aggregates")
    querySql(conn, "SELECT count(*), count(v), sum(v), total(v), avg(v), min(v), max(v), group_concat(v,':') FROM o")

    caseId += 1
    emitCase(caseId, "select.datetime")
    querySql(conn,
        "SELECT date('2026-08-14','start of month'), date('2000-01-31','+1 month','-1 day'), " +
            "time('12:34:56'), datetime('2026-08-14 12:34:56','+2 days'), " +
            "julianday('2000-01-01'), unixepoch('1970-01-02 00:00:00'), strftime('%Y-%m-%d','2026-08-14')")

    // 表连接
    caseId += 1
    emitCase(caseId, "join.inner_left_cross")
    execSql(conn, "CREATE TABLE a (id INT, x TEXT)")
    execSql(conn, "CREATE TABLE b (id INT, y TEXT)")
    execSql(conn, "INSERT INTO a VALUES (1,'a1'),(2,'a2'),(3,'a3')")
    execSql(conn, "INSERT INTO b VALUES (2,'b2'),(3,'b3'),(4,'b4')")
    querySql(conn, "SELECT a.id, a.x, b.y FROM a JOIN b ON a.id=b.id ORDER BY a.id")
    querySql(conn, "SELECT a.id, a.x, b.y FROM a LEFT JOIN b ON a.id=b.id ORDER BY a.id")
    querySql(conn, "SELECT count(*) FROM a CROSS JOIN b")

    caseId += 1
    emitCase(caseId, "join.using_natural")
    querySql(conn, "SELECT * FROM a JOIN b USING(id) ORDER BY id")
    querySql(conn, "SELECT * FROM a NATURAL JOIN b ORDER BY id")

    caseId += 1
    emitCase(caseId, "join.full_right")
    querySql(conn, "SELECT * FROM a FULL OUTER JOIN b USING(id) ORDER BY id")
    querySql(conn, "SELECT * FROM a RIGHT JOIN b USING(id) ORDER BY id")

    // 集合运算
    caseId += 1
    emitCase(caseId, "setop")
    querySql(conn, "SELECT 1 AS n UNION SELECT 2 UNION SELECT 3")
    querySql(conn, "SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 2")
    querySql(conn, "SELECT 1 AS n INTERSECT SELECT 1 INTERSECT SELECT 1")
    querySql(conn, "SELECT 1 AS n EXCEPT SELECT 2")
    querySql(conn, "SELECT 3 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 ORDER BY n LIMIT 2")

    // 子查询
    caseId += 1
    emitCase(caseId, "subquery")
    querySql(conn, "SELECT (SELECT count(*) FROM a), (SELECT max(id) FROM b)")
    querySql(conn, "SELECT a.x FROM a WHERE a.id IN (SELECT id FROM b) ORDER BY a.id")
    querySql(conn, "SELECT a.x FROM a WHERE EXISTS (SELECT 1 FROM b WHERE b.id=a.id) ORDER BY a.id")
    querySql(conn, "SELECT x, (SELECT y FROM b WHERE b.id=a.id) AS y FROM a ORDER BY a.id")

    // 公用表表达式
    caseId += 1
    emitCase(caseId, "cte.non_recursive")
    querySql(conn, "WITH s AS (SELECT id, x FROM a WHERE id >= 2) SELECT * FROM s ORDER BY id")
    querySql(conn, "WITH t1(x) AS (SELECT 1), t2(y) AS (SELECT x+1 FROM t1) SELECT y FROM t2")

    caseId += 1
    emitCase(caseId, "cte.recursive")
    querySql(conn, "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x < 6) SELECT * FROM cnt")
    querySql(conn, "WITH RECURSIVE d(x) AS (SELECT 1 UNION SELECT (x+1)%4 FROM d) SELECT * FROM d")

    // 窗口函数
    caseId += 1
    emitCase(caseId, "window.ranking")
    execSql(conn, "CREATE TABLE w (id INT, g TEXT, v INT)")
    execSql(conn, "INSERT INTO w VALUES (1,'a',10),(2,'a',10),(3,'a',20),(4,'b',5),(5,'b',15),(6,'b',15)")
    querySql(conn,
        "SELECT id, row_number() OVER (PARTITION BY g ORDER BY v,id), " + "rank() OVER (PARTITION BY g ORDER BY v), " +
            "dense_rank() OVER (PARTITION BY g ORDER BY v), " + "percent_rank() OVER (PARTITION BY g ORDER BY v), " +
            "cume_dist() OVER (PARTITION BY g ORDER BY v), " + "ntile(4) OVER (ORDER BY id) FROM w ORDER BY id")

    caseId += 1
    emitCase(caseId, "window.value")
    querySql(conn,
        "SELECT id, lag(v) OVER (PARTITION BY g ORDER BY id), " + "lead(v) OVER (PARTITION BY g ORDER BY id), " +
            "first_value(v) OVER (PARTITION BY g ORDER BY id), " + "last_value(v) OVER (PARTITION BY g ORDER BY id " +
            "ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING), " +
            "nth_value(v,2) OVER (PARTITION BY g ORDER BY id " +
            "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM w ORDER BY id")

    caseId += 1
    emitCase(caseId, "window.aggregate")
    querySql(conn,
        "SELECT id, sum(v) OVER (PARTITION BY g ORDER BY id " + "ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING), " +
            "avg(v) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING), " +
            "count(*) OVER (ORDER BY v RANGE BETWEEN 5 PRECEDING AND 5 FOLLOWING), " +
            "count(*) OVER (ORDER BY v GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW), " +
            "sum(v) FILTER (WHERE id%2=0) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) " + "FROM w ORDER BY id")

    // 事务与保存点
    caseId += 1
    emitCase(caseId, "txn.commit")
    execSql(conn, "CREATE TABLE tc (id INTEGER PRIMARY KEY, v TEXT)")
    execSql(conn, "BEGIN")
    execSql(conn, "INSERT INTO tc(v) VALUES ('one')")
    execSql(conn, "INSERT INTO tc(v) VALUES ('two')")
    execSql(conn, "COMMIT")
    querySql(conn, "SELECT id, v FROM tc ORDER BY id")

    caseId += 1
    emitCase(caseId, "txn.rollback")
    execSql(conn, "BEGIN")
    execSql(conn, "INSERT INTO tc(v) VALUES ('three')")
    execSql(conn, "ROLLBACK")
    querySql(conn, "SELECT id, v FROM tc ORDER BY id")

    caseId += 1
    emitCase(caseId, "txn.savepoint")
    execSql(conn, "BEGIN")
    execSql(conn, "INSERT INTO tc(v) VALUES ('sp-outer')")
    execSql(conn, "SAVEPOINT sp1")
    execSql(conn, "INSERT INTO tc(v) VALUES ('sp-inner')")
    execSql(conn, "ROLLBACK TO sp1")
    execSql(conn, "RELEASE sp1")
    execSql(conn, "COMMIT")
    querySql(conn, "SELECT id, v FROM tc ORDER BY id")

    // 外键
    caseId += 1
    emitCase(caseId, "fk.cascade")
    execSql(conn, "PRAGMA foreign_keys = ON")
    execSql(conn, "CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT)")
    execSql(conn,
        "CREATE TABLE child (id INTEGER PRIMARY KEY, pid INT, note TEXT, " +
            "FOREIGN KEY(pid) REFERENCES parent(id) ON DELETE CASCADE ON UPDATE CASCADE)")
    execSql(conn, "INSERT INTO parent VALUES (1,'one'),(2,'two')")
    execSql(conn, "INSERT INTO child VALUES (10,1,'a'),(11,1,'b'),(12,2,'c')")
    execSql(conn, "DELETE FROM parent WHERE id=1")
    execSql(conn, "UPDATE parent SET id=20 WHERE id=2")
    querySql(conn, "SELECT id, pid, note FROM child ORDER BY id")
    querySql(conn, "SELECT id, label FROM parent ORDER BY id")

    caseId += 1
    emitCase(caseId, "fk.setnull_default")
    execSql(conn, "CREATE TABLE p2 (id INTEGER PRIMARY KEY)")
    execSql(conn,
        "CREATE TABLE c2 (id INTEGER PRIMARY KEY, pid INT DEFAULT 0, " +
            "FOREIGN KEY(pid) REFERENCES p2(id) ON DELETE SET NULL)")
    execSql(conn, "INSERT INTO p2 VALUES (1)")
    execSql(conn, "INSERT INTO c2 VALUES (1,1)")
    execSql(conn, "DELETE FROM p2 WHERE id=1")
    querySql(conn, "SELECT id, pid FROM c2")

    // 触发器
    caseId += 1
    emitCase(caseId, "trigger.before_after")
    execSql(conn, "CREATE TABLE tlog (id INT)")
    execSql(conn, "CREATE TABLE audit (stage TEXT, n INT)")
    execSql(conn,
        "CREATE TRIGGER before_i BEFORE INSERT ON tlog BEGIN " +
            "INSERT INTO audit SELECT 'before', count(*) FROM tlog; END")
    execSql(conn,
        "CREATE TRIGGER after_i AFTER INSERT ON tlog BEGIN " +
            "INSERT INTO audit SELECT 'after', count(*) FROM tlog; END")
    execSql(conn, "INSERT INTO tlog VALUES (1)")
    querySql(conn, "SELECT stage, n FROM audit ORDER BY n, stage")

    caseId += 1
    emitCase(caseId, "trigger.update_when")
    execSql(conn, "CREATE TABLE tr (id INTEGER PRIMARY KEY, a INT, b INT)")
    execSql(conn, "CREATE TABLE taudit (kind TEXT, old_a INT, new_a INT, note TEXT)")
    execSql(conn, "INSERT INTO tr VALUES (1,10,20)")
    execSql(conn,
        "CREATE TRIGGER tr_upd AFTER UPDATE OF a ON tr WHEN NEW.a > 0 BEGIN " +
            "INSERT INTO taudit VALUES ('update', OLD.a, NEW.a, 'hit'); END")
    execSql(conn, "UPDATE tr SET b=21 WHERE id=1")
    execSql(conn, "UPDATE tr SET a=11 WHERE id=1")
    querySql(conn, "SELECT kind, old_a, new_a, note FROM taudit ORDER BY kind, old_a")

    // 视图
    caseId += 1
    emitCase(caseId, "view.read")
    execSql(conn, "CREATE VIEW high_score AS SELECT g, v FROM o WHERE v >= 20")
    execSql(conn, "INSERT INTO o VALUES (5,'c',40)")
    querySql(conn, "SELECT * FROM high_score ORDER BY g, v")

    caseId += 1
    emitCase(caseId, "view.instead_of")
    execSql(conn, "CREATE VIEW iv AS SELECT id, v FROM ud")
    execSql(conn, "CREATE TRIGGER iv_insert INSTEAD OF INSERT ON iv BEGIN " + "INSERT INTO ud(v) VALUES (NEW.v); END")
    rawExec(conn, "INSERT INTO iv(v) VALUES ('via-view')")
    querySql(conn, "SELECT id, v FROM ud ORDER BY id")

    // 数据库配置与元数据
    caseId += 1
    emitCase(caseId, "pragma.introspection")
    querySql(conn, "PRAGMA integrity_check")
    querySql(conn, "PRAGMA user_version")
    querySql(conn, "PRAGMA table_info(people)")
    querySql(conn, "PRAGMA foreign_key_list(child)")

    // 二进制数据
    caseId += 1
    emitCase(caseId, "blob.roundtrip")
    execSql(conn, "CREATE TABLE bl (id INTEGER PRIMARY KEY, payload BLOB)")
    execSql(conn, "INSERT INTO bl(payload) VALUES (zeroblob(3)), (zeroblob(0)), (x'00FF')")
    querySql(conn, "SELECT id, length(payload), hex(payload), typeof(payload) FROM bl ORDER BY id")

    // 预写式日志
    caseId += 1
    emitCase(caseId, "wal.mode")
    querySql(conn, "PRAGMA journal_mode=WAL")
    execSql(conn, "CREATE TABLE wt (id INTEGER PRIMARY KEY, v TEXT)")
    execSql(conn, "INSERT INTO wt(v) VALUES ('wal-one'),('wal-two')")
    querySql(conn, "SELECT id, v FROM wt ORDER BY id")
    querySql(conn, "PRAGMA integrity_check")
    querySql(conn, "PRAGMA journal_mode=DELETE")
    querySql(conn, "PRAGMA journal_mode")

    // 数据库整理
    caseId += 1
    emitCase(caseId, "vacuum")
    execSql(conn, "CREATE TABLE bulk (id INTEGER PRIMARY KEY, pad TEXT)")
    execSql(conn, "BEGIN")
    for (i in 1..401) {
        conn.exec("INSERT INTO bulk(id, pad) VALUES (?, ?)",
            [SqliteValue.SInt(i), SqliteValue.SText(repeatText("x", 200))])
    }
    execSql(conn, "COMMIT")
    execSql(conn, "DELETE FROM bulk WHERE id > 50")
    execSql(conn, "VACUUM")
    querySql(conn, "PRAGMA integrity_check")
    querySql(conn, "SELECT count(*) FROM bulk")
    querySql(conn, "SELECT id FROM bulk ORDER BY id LIMIT 3")
}

/** 输出一个用例的标题。 */
func emitCase(id: Int64, name: String): Unit {
    println("=== ${pad2(id)} ${name} ===")
}

func pad2(n: Int64): String {
    if (n < 10) {
        "0${n}"
    } else {
        "${n}"
    }
}

/** 执行一条语句。数据修改语句打印受影响行数，数据定义和事务控制语句打印 EXEC。 */
func execSql(conn: SqliteConn, sql: String): Unit {
    let changes = conn.execString(sql)
    let upper = sql.trimAscii().toAsciiUpper()
    if (upper.startsWith("INSERT") || upper.startsWith("UPDATE") || upper.startsWith("DELETE") || upper.startsWith(
        "REPLACE")) {
        println("EXEC rows=${changes}")
    } else {
        println("EXEC")
    }
}

/** 执行一条带绑定参数的语句并打印受影响行数。 */
func execParams(conn: SqliteConn, sql: String, params: Array<SqliteValue>): Unit {
    let changes = conn.exec(sql, params)
    println("EXEC rows=${changes}")
}

/** 执行语句并打印 EXEC，用于不以受影响行数作为判据的触发器和视图写入。 */
func rawExec(conn: SqliteConn, sql: String): Unit {
    conn.execString(sql)
    println("EXEC")
}

/** 执行查询并打印规范化结果。 */
func querySql(conn: SqliteConn, sql: String): Unit {
    let rs = conn.queryString(sql)
    if (rs.rowCount == 0) {
        println("EMPTY")
        return
    }
    println(renderRows(rs))
}

/** 值的规范化文本。 */
func renderValue(v: SqliteValue): String {
    match (v) {
        case SNull => "N"
        case SInt(i) => "I:${i}"
        case SReal(f) => "R:${f.format(".17g")}"
        case SText(s) => "T:${s}"
        case SBlob(b) => "B:${renderHex(b)}"
    }
}

/** 整个结果集的规范化文本。 */
func renderRows(rs: SqliteResultSet): String {
    let sb = StringBuilder()
    for (i in 0..rs.rows.size) {
        if (i > 0) {
            sb.append("\u{1E}")
        }
        let row = rs.rows[i]
        for (j in 0..row.size) {
            if (j > 0) {
                sb.append("\u{1F}")
            }
            sb.append(renderValue(row[j]))
        }
    }
    sb.toString()
}

/** 小写十六进制。 */
func renderHex(b: Array<Byte>): String {
    let digits = "0123456789abcdef"
    let sb = StringBuilder()
    for (byte in b) {
        let hi = Int64(byte) / 16
        let lo = Int64(byte) % 16
        sb.append(digits[hi..hi + 1])
        sb.append(digits[lo..lo + 1])
    }
    sb.toString()
}

/** 按指定次数重复文本。 */
func repeatText(unit: String, times: Int64): String {
    let sb = StringBuilder()
    for (_ in 0..times) {
        sb.append(unit)
    }
    sb.toString()
}
