package web.database

import std.collection.ArrayList
import web.config.DatabaseConfig

// One connection for an entire unit of work; resources are scoped by run().
public class DbTransaction {
    private let handle: CPointer<Unit>
    private init(config: DatabaseConfig) {
        unsafe {
            this.handle = mysql_init(CPointer<Unit>())
            if (handle.isNull()) { throw Exception("MySQL initialization failed") }
            try {
                try (host = LibC.mallocCString(config.host).asResource(),
                     user = LibC.mallocCString(config.username).asResource(),
                     password = LibC.mallocCString(config.getPassword()).asResource(),
                     database = LibC.mallocCString(config.database).asResource()) {
                    if (mysql_real_connect(handle, host.value, user.value, password.value,
                        database.value, UInt32(config.port), CString(CPointer<UInt8>()), 0).isNull()) {
                        throw Exception("MySQL connection failed: " + mysql_error(handle).toString())
                    }
                }
                try (charset = LibC.mallocCString("utf8mb4").asResource()) {
                    if (mysql_set_character_set(handle, charset.value) != 0) {
                        throw Exception("MySQL charset failed")
                    }
                }
                execute("SET time_zone = '+00:00'")
            } catch (e: Exception) {
                mysql_close(handle)
                throw e
            }
        }
    }
    public static func run<T>(config: DatabaseConfig, work: (DbTransaction) -> T): T {
        let connection = DbTransaction(config)
        try {
            connection.execute("START TRANSACTION")
            try {
                let result = work(connection)
                connection.execute("COMMIT")
                return result
            } catch (e: Exception) {
                try { connection.execute("ROLLBACK") } catch (_: Exception) { () }
                throw e
            }
        } finally {
            unsafe { mysql_close(connection.handle) }
        }
    }
    private func statement(sql: String): Unit {
        unsafe {
            try (value = LibC.mallocCString(sql).asResource()) {
                if (mysql_query(handle, value.value) != 0) {
                    throw Exception("MySQL query failed: " + mysql_error(handle).toString())
                }
            }
        }
    }
    public func execute(sql: String): Int64 {
        unsafe {
            statement(sql)
            if (mysql_field_count(handle) != 0) { throw Exception("Expected write statement") }
            let count = mysql_affected_rows(handle)
            if (count == 0xffffffffffffffffu64) { throw Exception("MySQL write failed") }
            return Int64(count)
        }
    }
    public func query(sql: String): Array<Array<Option<String>>> {
        unsafe {
            statement(sql)
            let result = mysql_store_result(handle)
            if (result.isNull()) { throw Exception("MySQL result failed") }
            try {
                let rows = ArrayList<Array<Option<String>>>()
                let fields = Int64(mysql_num_fields(result))
                while (true) {
                    let row = mysql_fetch_row(result)
                    if (row.isNull()) { break }
                    let lengths = mysql_fetch_lengths(result)
                    if (lengths.isNull()) { throw Exception("Missing MySQL field lengths") }
                    let cells = Array<Option<String>>(fields, { _ => None })
                    for (i in 0..fields) {
                        let value = (row + i).read()
                        if (!value.isNull()) {
                            let size = Int64((lengths + i).read())
                            cells[i] = Some(String.fromUtf8(Array<UInt8>(size,
                                { j => (value.getChars() + j).read() })))
                        }
                    }
                    rows.add(cells)
                }
                return rows.toArray()
            } finally { mysql_free_result(result) }
        }
    }
}
