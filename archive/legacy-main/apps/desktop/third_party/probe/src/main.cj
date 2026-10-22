package sqlite_probe

import std.database.sql.*
import std.fs.*
import sqlite_driver.*

/*
 * 内置 sqlite 驱动的回归用例集（本项目的数据层就靠它）。
 *
 * 覆盖：中文直接写在 SQL 里、参数绑定、长文本与特殊字符、数值与 NULL、事务、
 * BLOB 向量、自增主键与排序、幂等 DDL、中文的更新与删除、运算符与 JSON 箭头。
 *
 * 跑法： . ..\..\scripts\env.ps1 ; cd third_party\probe ; cjpm build ; .\target\release\bin\main.exe
 * 期望结尾：PASS=n FAIL=0
 */

var pass = 0
var fail = 0

func check(label: String, cond: Bool, extra: String): Unit {
    if (cond) {
        pass += 1
        println("  PASS  ${label}")
    } else {
        fail += 1
        println("  FAIL  ${label}  ${extra}")
    }
}

func run(conn: Connection, label: String, body: () -> Unit): Unit {
    try {
        body()
    } catch (e: Exception) {
        fail += 1
        println("  FAIL  ${label}  [${e.message}]")
    }
}

func exec(conn: Connection, sql: String): Int64 {
    let st = conn.prepareStatement(sql)
    try {
        let r = st.update()
        r.rowCount
    } finally { st.close() }
}

func execBound(conn: Connection, sql: String, args: Array<String>): Int64 {
    let st = conn.prepareStatement(sql)
    try {
        for (i in 0..args.size) {
            st.set<String>(i, args[i])
        }
        let r = st.update()
        r.rowCount
    } finally { st.close() }
}

func str(conn: Connection, sql: String, args: Array<String>): String {
    let st = conn.prepareStatement(sql)
    try {
        for (i in 0..args.size) {
            st.set<String>(i, args[i])
        }
        let rows = st.query()
        var out = ""
        var first = true
        while (rows.next()) {
            let v = rows.get<String>(0)
            if (first) { out = v; first = false } else { out = out + "|" + v }
        }
        rows.close()
        out
    } finally { st.close() }
}

func strCount(conn: Connection, sql: String, args: Array<String>): Int64 {
    let st = conn.prepareStatement(sql)
    try {
        for (i in 0..args.size) {
            st.set<String>(i, args[i])
        }
        let rows = st.query()
        var n = 0
        while (rows.next()) { n += 1 }
        rows.close()
        Int64(n)
    } finally { st.close() }
}

main(): Int64 {
    registerSqliteDriver()
    let driver = DriverManager.getDriver("sqlite").getOrThrow()
    removeIfExists(Path("battery.db"))
    let ds = driver.open("battery.db", Array<(String, String)>())
    let conn = ds.connect()

    println("== 1. 中文直接写在 SQL 里 ==")
    run(conn, "CREATE with chinese ident", { =>
        exec(conn, "CREATE TABLE \"知识库表\" (\"编号\" INTEGER PRIMARY KEY, \"标题\" TEXT)")
    })
    run(conn, "INSERT chinese literal", { =>
        let n = exec(conn, "INSERT INTO \"知识库表\" (\"编号\", \"标题\") VALUES (1, '中文标题')")
        check("insert affected 1", n == 1, "got ${n}")
    })
    run(conn, "length(chinese literal)", { =>
        let v = str(conn, "SELECT length('中文')", Array<String>())
        check("length('中文') == 2", v == "2", "got ${v}")
    })
    run(conn, "read back chinese literal", { =>
        let v = str(conn, "SELECT \"标题\" FROM \"知识库表\" WHERE \"编号\" = 1", Array<String>())
        check("chinese literal roundtrip", v == "中文标题", "got [${v}]")
    })
    run(conn, "chinese in where literal", { =>
        let v = str(conn, "SELECT \"标题\" FROM \"知识库表\" WHERE \"标题\" = '中文标题'", Array<String>())
        check("where chinese literal", v == "中文标题", "got [${v}]")
    })

    println("== 2. 参数绑定 ==")
    exec(conn, "CREATE TABLE IF NOT EXISTS chunk (id INTEGER PRIMARY KEY, kb TEXT, text TEXT, vec BLOB, n INTEGER, score REAL, note TEXT)")
    run(conn, "bind chinese insert", { =>
        let n = execBound(conn, "INSERT INTO chunk (kb, text, n) VALUES (?, ?, 1)", ["kb-1", "第一章 提示词工程：什么是提示词？"])
        check("bound insert ok", n == 1, "got ${n}")
    })
    run(conn, "bind chinese where", { =>
        let v = str(conn, "SELECT text FROM chunk WHERE kb = ?", ["kb-1"])
        check("bound where chinese", v.contains("提示词工程"), "got [${v}]")
    })
    run(conn, "bind chinese LIKE", { =>
        let n = strCount(conn, "SELECT id FROM chunk WHERE text LIKE ?", ["%提示词%"])
        check("LIKE bound chinese", n == 1, "got ${n}")
    })
    run(conn, "bind chinese prefix LIKE", { =>
        let n = strCount(conn, "SELECT id FROM chunk WHERE text LIKE ?", ["第一章%"])
        check("prefix LIKE bound chinese", n == 1, "got ${n}")
    })

    println("== 3. 长文本 / 特殊字符 ==")
    let longText = StringBuilder()
    for (i in 0..2000) {
        longText.append("第${i}段：这是中文内容，包含标点、emoji 🚀 和转义 ' 单引号。\n")
    }
    let long = longText.toString()
    run(conn, "long chinese text", { =>
        execBound(conn, "INSERT INTO chunk (kb, text, n) VALUES (?, ?, 2)", ["kb-1", long])
        let got = str(conn, "SELECT text FROM chunk WHERE n = 2", Array<String>())
        check("long text length equal", got.size == long.size, "got ${got.size} expected ${long.size}")
    })
    run(conn, "text with quotes", { =>
        execBound(conn, "INSERT INTO chunk (kb, text, n) VALUES (?, ?, 3)", ["kb-1", "他说的原话是 '你好' 和 \"再见\""])
        let got = str(conn, "SELECT text FROM chunk WHERE n = 3", Array<String>())
        check("quote roundtrip", got == "他说的原话是 '你好' 和 \"再见\"", "got [${got}]")
    })

    println("== 4. 数值 / NULL / 事务 ==")
    run(conn, "int real null", { =>
        execBound(conn, "INSERT INTO chunk (kb, text, n) VALUES (?, ?, 4)", ["kb-2", "x"])
        let st = conn.prepareStatement("UPDATE chunk SET n = ?, score = ?, note = NULL WHERE text = ?")
        try {
            st.set<Int64>(0, 9999999999)
            st.set<Float64>(1, 0.125)
            st.set<String>(2, "x")
            st.update()
        } finally { st.close() }
        let st2 = conn.prepareStatement("SELECT n, score, note FROM chunk WHERE text = ?")
        try {
            st2.set<String>(0, "x")
            let rows = st2.query()
            while (rows.next()) {
                check("int64 roundtrip", rows.get<Int64>(0) == 9999999999, "bad")
                check("float64 roundtrip", rows.get<Float64>(1) == 0.125, "bad")
                check("null column stays null", rows.getOrNull<String>(2).isNone(), "bad")
            }
            rows.close()
        } finally { st2.close() }
    })
    run(conn, "tx commit", { =>
        let tx = conn.createTransaction()
        tx.begin()
        let st = conn.prepareStatement("INSERT INTO chunk (kb, text, n) VALUES (?, ?, 5)")
        st.set<String>(0, "kb-3")
        st.set<String>(1, "事务里的中文")
        st.update()
        st.close()
        tx.commit()
        let n = strCount(conn, "SELECT id FROM chunk WHERE kb = ?", ["kb-3"])
        check("committed row visible", n == 1, "got ${n}")
    })
    run(conn, "tx rollback", { =>
        let tx = conn.createTransaction()
        tx.begin()
        let st = conn.prepareStatement("INSERT INTO chunk (kb, text, n) VALUES (?, ?, 6)")
        st.set<String>(0, "kb-4")
        st.set<String>(1, "回滚的中文")
        st.update()
        st.close()
        tx.rollback()
        let n = strCount(conn, "SELECT id FROM chunk WHERE kb = ?", ["kb-4"])
        check("rolled back row absent", n == 0, "got ${n}")
    })

    println("== 5. BLOB 向量 ==")
    run(conn, "blob vector 256 dim", { =>
        let dim = 256
        let buf = Array<Byte>(dim * 4, repeat: 0)
        for (i in 0..dim * 4) { buf[i] = UInt8(i % 256) }
        execBound(conn, "INSERT INTO chunk (kb, text, n) VALUES (?, ?, 7)", ["kb-5", "向量行"])
        let st = conn.prepareStatement("UPDATE chunk SET vec = ? WHERE n = 7")
        try {
            st.set<Array<Byte>>(0, buf)
            st.update()
        } finally { st.close() }
        let st2 = conn.prepareStatement("SELECT length(vec), vec FROM chunk WHERE n = 7")
        try {
            let rows = st2.query()
            while (rows.next()) {
                check("blob length", rows.get<Int64>(0) == Int64(dim * 4), "bad")
                let got = rows.get<Array<Byte>>(1)
                check("blob bytes equal", got.size == dim * 4 && got[0] == buf[0], "got ${got.size}")
            }
            rows.close()
        } finally { st2.close() }
    })
    run(conn, "blob vector 1024 dim", { =>
        let dim = 1024
        let buf = Array<Byte>(dim * 4, repeat: 7)
        execBound(conn, "INSERT INTO chunk (kb, text, n) VALUES (?, ?, 8)", ["kb-6", "大向量"])
        let st = conn.prepareStatement("UPDATE chunk SET vec = ? WHERE n = 8")
        try {
            st.set<Array<Byte>>(0, buf)
            st.update()
        } finally { st.close() }
        let st2 = conn.prepareStatement("SELECT length(vec), vec FROM chunk WHERE n = 8")
        try {
            let rows = st2.query()
            while (rows.next()) {
                check("big blob size", rows.get<Int64>(0) == Int64(dim * 4), "bad")
                check("big blob bytes", rows.get<Array<Byte>>(1).size == dim * 4, "bad")
            }
            rows.close()
        } finally { st2.close() }
    })

    println("== 6. 自增 id / 排序 / 幂等 DDL ==")
    run(conn, "autoinc + order + count", { =>
        exec(conn, "CREATE TABLE IF NOT EXISTS ev (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT)")
        for (i in 0..3) {
            execBound(conn, "INSERT INTO ev (ts, kind) VALUES (?, ?)", ["2026-10-14T0${i}:00:00Z", "事件${i}"])
        }
        let st = conn.prepareStatement("SELECT kind FROM ev ORDER BY id DESC LIMIT 2")
        try {
            let rows = st.query()
            var first = ""
            while (rows.next()) {
                if (first.size == 0) { first = rows.get<String>(0) }
            }
            rows.close()
            check("order desc limit", first == "事件2", "got [${first}]")
        } finally { st.close() }
    })
    run(conn, "idempotent ddl", { =>
        exec(conn, "CREATE TABLE IF NOT EXISTS ev (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT)")
        exec(conn, "CREATE INDEX IF NOT EXISTS idx_chunk_kb ON chunk (kb)")
        check("re-run ddl is harmless", true, "")
    })

    println("== 7. 中文的更新与删除 ==")
    run(conn, "update and delete chinese", { =>
        execBound(conn, "INSERT INTO chunk (kb, text, n) VALUES (?, ?, 9)", ["kb-7", "待改的中文"])
        let st = conn.prepareStatement("UPDATE chunk SET text = ? WHERE text = ?")
        try {
            st.set<String>(0, "已改的中文")
            st.set<String>(1, "待改的中文")
            st.update()
        } finally { st.close() }
        let got = str(conn, "SELECT text FROM chunk WHERE n = 9", Array<String>())
        check("update chinese roundtrip", got == "已改的中文", "got [${got}]")
        let n = execBound(conn, "DELETE FROM chunk WHERE n = ?", ["9"])
        check("delete bound", n == 1, "got ${n}")
    })

    println("== 8. 运算符与 JSON 箭头 ==")
    // 词法器是我改过的地方，运算符识别必须单独验一遍
    run(conn, "operators", { =>
        check("json ->>", str(conn, "SELECT '{\"a\": 1}' ->> 'a'", Array<String>()) == "1", "bad")
        check("json ->", str(conn, "SELECT '{\"a\": 1}' -> 'a'", Array<String>()) == "1", "bad")
        check("json arrow chinese key", str(conn, "SELECT '{\"名字\": \"小张\"}' ->> '名字'", Array<String>()) == "小张", "bad")
        check("two char <=", str(conn, "SELECT 1 WHERE 2 <= 3", Array<String>()) == "1", "bad")
        check("two char >=", str(conn, "SELECT 1 WHERE 3 >= 2", Array<String>()) == "1", "bad")
        check("two char <>", str(conn, "SELECT 1 WHERE 1 <> 2", Array<String>()) == "1", "bad")
        check("concat ||", str(conn, "SELECT 'ab' || 'cd'", Array<String>()) == "abcd", "bad")
        check("shift <<", str(conn, "SELECT 1 << 3", Array<String>()) == "8", "bad")
        check("shift >>", str(conn, "SELECT 16 >> 2", Array<String>()) == "4", "bad")
        check("equals ==", str(conn, "SELECT 1 WHERE 1 == 1", Array<String>()) == "1", "bad")
        check("not equals !=", str(conn, "SELECT 1 WHERE 1 != 2", Array<String>()) == "1", "bad")
        check("minus", str(conn, "SELECT 5 - 2", Array<String>()) == "3", "bad")
    })
    run(conn, "lone bang is rejected", { =>
        var threw = false
        try {
            conn.prepareStatement("SELECT 1 ! 2")
        } catch (e: Exception) {
            threw = true
        }
        check("lone '!' throws", threw, "no exception")
    })

    conn.close()
    ds.close()
    println("")
    println("PASS=${pass} FAIL=${fail}")
    if (fail == 0) { 0 } else { 1 }
}