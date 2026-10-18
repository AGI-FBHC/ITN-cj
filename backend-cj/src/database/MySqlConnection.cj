package web.database
import std.convert.*
import std.collection.ArrayList
import web.config.DatabaseConfig
foreign func mysql_init(handle: CPointer<Unit>): CPointer<Unit>
foreign func mysql_real_connect(handle: CPointer<Unit>, host: CString, user: CString,
    password: CString, database: CString, port: UInt32, socket: CString,
    flags: UInt32): CPointer<Unit>
foreign func mysql_close(handle: CPointer<Unit>): Unit
foreign func mysql_error(handle: CPointer<Unit>): CString
foreign func mysql_query(handle: CPointer<Unit>, query: CString): Int32
foreign func mysql_store_result(handle: CPointer<Unit>): CPointer<Unit>
foreign func mysql_fetch_row(result: CPointer<Unit>): CPointer<CString>
foreign func mysql_free_result(result: CPointer<Unit>): Unit
foreign func mysql_num_fields(result: CPointer<Unit>): UInt32
foreign func mysql_fetch_lengths(result: CPointer<Unit>): CPointer<UInt32>
foreign func mysql_set_character_set(handle: CPointer<Unit>, charset: CString): Int32
foreign func mysql_field_count(handle: CPointer<Unit>): UInt32
foreign func mysql_affected_rows(handle: CPointer<Unit>): UInt64
// Windows x64 MySQL C API: unsigned long is UInt32.
public class MySqlConnection {
    private init() {}
    public static func countUsers(config: DatabaseConfig): Int64 {
        let rows = query(config, "SELECT COUNT(*) FROM users")
        if (rows.isEmpty()) { throw Exception("MySQL user count returned no row") }
        match (rows[0][0]) {
            case Some(value) => return Int64.parse(value)
            case None => throw Exception("MySQL user count returned NULL")
        }
    }
    // Repository code must encode values; do not concatenate raw input into SQL.
    public static func query(config: DatabaseConfig, sql: String): Array<Array<Option<String>>> {
        unsafe {
            let handle = mysql_init(CPointer<Unit>())
            if (handle.isNull()) {
                throw Exception("MySQL initialization failed")
            }
            try {
                // Each allocation is released even when connection fails.
                try (host = LibC.mallocCString(config.host).asResource(),
                     user = LibC.mallocCString(config.username).asResource(),
                     password = LibC.mallocCString(config.getPassword()).asResource(),
                     database = LibC.mallocCString(config.database).asResource()) {
                    let connected = mysql_real_connect(handle, host.value, user.value,
                        password.value, database.value, UInt32(config.port), CString(CPointer<UInt8>()), 0)
                    if (connected.isNull()) {
                        throw Exception("MySQL connection failed: " + mysql_error(handle).toString())
                    }
                }
                try (charset = LibC.mallocCString("utf8mb4").asResource()) {
                    if (mysql_set_character_set(handle, charset.value) != 0) {
                        throw Exception("MySQL charset failed: " + mysql_error(handle).toString())
                    }
                }
                // Legacy Instant fields are stored as timestamps; retrieve them in UTC.
                try (timezone = LibC.mallocCString("SET time_zone = '+00:00'").asResource()) {
                    if (mysql_query(handle, timezone.value) != 0) {
                        throw Exception("MySQL timezone failed: " + mysql_error(handle).toString())
                    }
                }
                try (query = LibC.mallocCString(sql).asResource()) {
                    if (mysql_query(handle, query.value) != 0) {
                        throw Exception("MySQL query failed: " + mysql_error(handle).toString())
                    }
                }
                let result = mysql_store_result(handle)
                if (result.isNull()) {
                    throw Exception("MySQL result failed: " + mysql_error(handle).toString())
                }
                try {
                    let rows = ArrayList<Array<Option<String>>>()
                    let fieldCount = Int64(mysql_num_fields(result))
                    while (true) {
                        let row = mysql_fetch_row(result)
                        if (row.isNull()) { break }
                        let lengths = mysql_fetch_lengths(result)
                        if (lengths.isNull()) { throw Exception("MySQL field lengths unavailable") }
                        let cells = Array<Option<String>>(fieldCount, { _ => None })
                        for (i in 0..fieldCount) {
                            let value = (row + i).read()
                            if (!value.isNull()) {
                                let size = Int64((lengths + i).read())
                                let bytes = Array<UInt8>(size, { j => (value.getChars() + j).read() })
                                cells[i] = Some(String.fromUtf8(bytes))
                            }
                        }
                        rows.add(cells)
                    }
                    return rows.toArray()
                } finally {
                    mysql_free_result(result)
                }
            } finally {
                mysql_close(handle)
            }
        }
    }
    // INSERT / UPDATE / DELETE return affected rows rather than a result table.
    public static func execute(config: DatabaseConfig, sql: String): Int64 {
        unsafe {
            let handle = mysql_init(CPointer<Unit>())
            if (handle.isNull()) { throw Exception("MySQL initialization failed") }
            try {
                try (host = LibC.mallocCString(config.host).asResource(),
                     user = LibC.mallocCString(config.username).asResource(),
                     password = LibC.mallocCString(config.getPassword()).asResource(),
                     database = LibC.mallocCString(config.database).asResource()) {
                    let connected = mysql_real_connect(handle, host.value, user.value,
                        password.value, database.value, UInt32(config.port), CString(CPointer<UInt8>()), 0)
                    if (connected.isNull()) {
                        throw Exception("MySQL connection failed: " + mysql_error(handle).toString())
                    }
                }
                try (charset = LibC.mallocCString("utf8mb4").asResource()) {
                    if (mysql_set_character_set(handle, charset.value) != 0) {
                        throw Exception("MySQL charset failed: " + mysql_error(handle).toString())
                    }
                }
                try (timezone = LibC.mallocCString("SET time_zone = '+00:00'").asResource()) {
                    if (mysql_query(handle, timezone.value) != 0) {
                        throw Exception("MySQL timezone failed: " + mysql_error(handle).toString())
                    }
                }
                try (statement = LibC.mallocCString(sql).asResource()) {
                    if (mysql_query(handle, statement.value) != 0) {
                        throw Exception("MySQL query failed: " + mysql_error(handle).toString())
                    }
                }
                if (mysql_field_count(handle) != 0) {
                    throw Exception("MySQL execute expects a statement without result rows")
                }
                let affected = mysql_affected_rows(handle)
                if (affected == 0xffffffffffffffffu64) {
                    throw Exception("MySQL affected rows failed: " + mysql_error(handle).toString())
                }
                return Int64(affected)
            } finally {
                mysql_close(handle)
            }
        }
    }
}
