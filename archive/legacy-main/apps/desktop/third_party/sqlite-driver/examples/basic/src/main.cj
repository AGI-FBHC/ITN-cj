package sqlite_driver_basic

import std.database.sql.*
import sqlite_driver.*

main(): Int64 {
    try {
        runExample()
        println("PASS: basic example")
        return 0
    } catch (e: Exception) {
        eprintln("FAIL: ${e.message}")
        return 1
    }
}

func runExample(): Unit {
    registerSqliteDriver()
    let driver = DriverManager.getDriver("sqlite").getOrThrow()
    let datasource = driver.open(":memory:", [])
    try {
        let connection = datasource.connect()
        try {
            executeUpdate(connection, "CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")

            let insert = connection.prepareStatement("INSERT INTO task(title) VALUES (?)")
            try {
                insert.set<String>(0, "learn sqlite-driver")
                let result = insert.update()
                require(result.rowCount == 1, "insert should affect one row")
                require(result.lastInsertId == 1, "first row id should be 1")
            } finally {
                insert.close()
            }

            let query = connection.prepareStatement("SELECT id, title FROM task ORDER BY id")
            try {
                let rows = query.query()
                try {
                    require(rows.next(), "query should return one row")
                    let id = rows.get<Int64>(0)
                    let title = rows.get<String>(1)
                    require(id == 1, "queried id should be 1")
                    require(title == "learn sqlite-driver", "queried title should match the inserted value")
                    require(!rows.next(), "query should return exactly one row")
                    println("id=${id}, title=${title}")
                } finally {
                    rows.close()
                }
            } finally {
                query.close()
            }
        } finally {
            connection.close()
        }
    } finally {
        datasource.close()
    }
}

func executeUpdate(connection: Connection, sql: String): Unit {
    let statement = connection.prepareStatement(sql)
    try {
        let _ = statement.update()
    } finally {
        statement.close()
    }
}

func require(condition: Bool, message: String): Unit {
    if (!condition) {
        throw Exception(message)
    }
}
