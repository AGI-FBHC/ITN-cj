package sqlite_driver

import std.collection.*
import std.convert.*

/*
 * 从连接字符串解析 SqliteDSN。
 *
 * 为什么要 query 串: SQLite 没有网络层字段, 真正的连接参数是 syncMode / busyTimeoutMs /
 * pageSize / foreignKeys。它们写成 `key=value`, 通过同一套解析器归一。
 *
 * 形态: `路径?键=值&键=值`。路径部分为空或 ":memory:" 时是内存库。
 */

/**
 * 从连接字符串建一个 SqliteDSN。
 *
 * 公开是因为它对调用方本身有用: 从配置文件、环境变量里读到的是一整串, 手工拆成四个字段
 * 又要各自解析一遍。未识别的键报错而不是忽略, 理由见下面 case _ 处。
 */
public func parseSqliteDsn(raw: String): SqliteDSN {
    let qmark = raw.indexOf("?")
    var path = raw
    var query = ""
    if (let Some(i) <- qmark) {
        path = raw[0..i]
        query = raw[(i + 1)..raw.size]
    }
    if (path.isEmpty()) {
        path = ":memory:"
    }

    var syncMode = SqliteSyncMode.SyncNormal
    var busyTimeoutMs = 5000
    var pageSize = DEFAULT_PAGE_SIZE
    var foreignKeys = false

    for (pair in splitNonEmpty(query, "&")) {
        let eq = pair.indexOf("=")
        let key = match (eq) {
            case Some(i) => pair[0..i].trimAscii().toAsciiLower()
            case None => pair.trimAscii().toAsciiLower()
        }
        let value = match (eq) {
            case Some(i) => pair[(i + 1)..pair.size].trimAscii()
            case None => ""
        }
        match (key) {
            case "sync" | "synchronous" => syncMode = parseSyncModeParam(value)
            case "busy_timeout" | "busytimeout" => busyTimeoutMs = parseIntParam(key, value)
            case "page_size" | "pagesize" => pageSize = parseIntParam(key, value)
            case "foreign_keys" | "foreignkeys" | "fk" => foreignKeys = parseBoolParam(key, value)
            case _ =>
                // 不识别就报错: 静默忽略会让写错的键 (`page_sise=8192`) 表现为"配了没生效",
                // 而 pageSize 建库后不可改，问题会延后到文件使用时才暴露。
                throw SqliteRuntimeException("dsn", "unknown sqlite dsn parameter '${key}'")
        }
    }

    SqliteDSN(path: path, syncMode: syncMode, busyTimeoutMs: busyTimeoutMs, pageSize: pageSize, foreignKeys: foreignKeys)
}

/** `sync=normal|full`。SQLite 的 off/1/2/3 也接受, 归到最近的两档。 */
func parseSyncModeParam(value: String): SqliteSyncMode {
    match (value.toAsciiLower()) {
        case "normal" | "1" | "off" | "0" => SqliteSyncMode.SyncNormal
        case "full" | "2" | "extra" | "3" => SqliteSyncMode.SyncFull
        case _ => throw SqliteRuntimeException("dsn", "invalid sqlite dsn sync mode '${value}'")
    }
}

func parseIntParam(key: String, value: String): Int64 {
    try {
        Int64.parse(value)
    } catch (_: Exception) {
        throw SqliteRuntimeException("dsn", "sqlite dsn parameter '${key}' expects an integer, got '${value}'")
    }
}

func parseBoolParam(key: String, value: String): Bool {
    match (value.toAsciiLower()) {
        case "1" | "true" | "on" | "yes" => true
        case "0" | "false" | "off" | "no" => false
        case _ => throw SqliteRuntimeException("dsn", "sqlite dsn parameter '${key}' expects a boolean, got '${value}'")
    }
}

/** 按分隔符切分并丢掉空段, 免得 `a&&b` 或结尾的 `&` 造出空键。 */
func splitNonEmpty(s: String, sep: String): ArrayList<String> {
    let out = ArrayList<String>()
    if (s.isEmpty()) {
        return out
    }
    for (part in s.split(sep)) {
        if (!part.trimAscii().isEmpty()) {
            out.add(part)
        }
    }
    out
}
