package sqlite_probe

import std.database.sql.*
import std.fs.*
import sqlite_driver.*

func scalar(conn: Connection, label: String, sql: String): Unit {
    try {
        let st = conn.prepareStatement(sql)
        try {
            let rows = st.query()
            var v = ""
            while (rows.next()) { v = rows.get<String>(0) }
            rows.close()
            println("${label}: OK -> [${v}]")
        } finally { st.close() }
    } catch (e: Exception) {
        println("${label}: ERR [${e.message}]")
    }
}

main(): Int64 {
    registerSqliteDriver()
    let driver = DriverManager.getDriver("sqlite").getOrThrow()
    removeIfExists(Path("ops.db"))
    let ds = driver.open("ops.db", [])
    let conn = ds.connect()
    // JSON 箭头运算符：我改动了它的识别方式，单独验一次
    scalar(conn, "json ->>", "SELECT '{\"a\": 1}' ->> 'a'")
    scalar(conn, "json ->", "SELECT '{\"a\": 1}' -> 'a'")
    scalar(conn, "two char <=", "SELECT 1 WHERE 2 <= 3")
    scalar(conn, "two char >=", "SELECT 1 WHERE 3 >= 2")
    scalar(conn, "two char <>", "SELECT 1 WHERE 1 <> 2")
    scalar(conn, "concat ||", "SELECT 'ab' || 'cd'")
    scalar(conn, "shift <<", "SELECT 1 << 3")
    scalar(conn, "shift >>", "SELECT 16 >> 2")
    scalar(conn, "equals ==", "SELECT 1 WHERE 1 == 1")
    scalar(conn, "not equals !=", "SELECT 1 WHERE 1 != 2")
    scalar(conn, "minus and arrow mixed", "SELECT 5 - 2")
    scalar(conn, "json arrow with chinese", "SELECT '{\"名字\": \"小张\"}' ->> '名字'")
    try {
        conn.prepareStatement("SELECT 1 ! 2")
    } catch (e: Exception) {
        println("lone '!' message: [${e.message}]")
    }
    try {
        conn.prepareStatement("SELECT 文字 1")
    } catch (e: Exception) {
        println("bad chinese token message: [${e.message}]")
    }
    conn.close()
    ds.close()
    return 0
}
