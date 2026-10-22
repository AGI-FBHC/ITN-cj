package itn_desktop_core.db

import std.collection.*
import std.convert.*
import std.database.sql.*
import std.fs.*
import std.sync.*
import sqlite_driver.*
import itn_desktop_core.util.*

/*
 * 本地数据访问层。
 *
 * 这一层存在的理由：应用的所有数据（模型配置、知识库切片、向量、学习进度、笔记、
 * 错题、会话日志）都落在一个本机 SQLite 文件里。上层仓库类只与 Db 打交道，
 * 不再自己拼 SQL，也不直接碰文件。
 *
 * 两条必须遵守的规则，都是实测踩出来的：
 *   1) 参数一律走绑定，不把用户文本拼进 SQL 字符串字面量。绑定路径既避开转义问题，
 *      也不依赖词法器对非 ASCII 的处理。
 *   2) 表名/列名只用 ASCII。
 *
 * 连接进程内共享，HTTP 服务端是多线程的，所以每个操作都在同一把锁里做完。本地单人
 * 使用，串行化换来的确定性远比并发吞吐重要。
 */

/** 一个 SQL 值。绑定与读取都经过它，避免上层写一堆具体类型的重载。 */
public enum DbValue {
    | DbText(String)
    | DbInt(Int64)
    | DbReal(Float64)
    | DbBlob(Array<Byte>)
    | DbNull
}

public func tv(s: String): DbValue {
    DbText(s)
}

public func nv(n: Int64): DbValue {
    DbInt(n)
}

public func rv(f: Float64): DbValue {
    DbReal(f)
}

public func bv(b: Array<Byte>): DbValue {
    DbBlob(b)
}

public func boolValue(b: Bool): DbValue {
    DbInt(if (b) { 1 } else { 0 })
}

/** 数组字面量 → 参数列表，省掉每处手动 add。 */
public func va(values: Array<DbValue>): ArrayList<DbValue> {
    let out = ArrayList<DbValue>()
    for (v in values) {
        out.add(v)
    }
    return out
}

/** 一条待执行的语句。批量写入用它，一个事务里一次提交。 */
public class DbOp {
    public let sql: String
    public let args: ArrayList<DbValue>

    public init(sql: String, args: ArrayList<DbValue>) {
        this.sql = sql
        this.args = args
    }
}

/** 一行结果。列按类型读，读不出来就是空值/零。 */
public class DbRow {
    private let cells: Array<DbValue>

    init(cells: Array<DbValue>) {
        this.cells = cells
    }

    public func size(): Int64 {
        return Int64(cells.size)
    }

    public func isNull(i: Int64): Bool {
        match (cells[i]) {
            case DbNull => true
            case _ => false
        }
    }

    public func text(i: Int64): String {
        match (cells[i]) {
            case DbText(s) => s
            case DbInt(n) => n.toString()
            case DbReal(f) => f.toString()
            case _ => ""
        }
    }

    public func int(i: Int64): Int64 {
        match (cells[i]) {
            case DbInt(n) => n
            case DbText(s) =>
                try {
                    Int64.parse(s)
                } catch (e: Exception) {
                    0
                }
            case DbReal(f) => Int64(f)
            case _ => 0
        }
    }

    public func real(i: Int64): Float64 {
        match (cells[i]) {
            case DbReal(f) => f
            case DbInt(n) => Float64(n)
            case DbText(s) =>
                try {
                    Float64.parse(s)
                } catch (e: Exception) {
                    0.0
                }
            case _ => 0.0
        }
    }

    public func bool(i: Int64): Bool {
        int(i) != 0
    }

    public func blob(i: Int64): Array<Byte> {
        match (cells[i]) {
            case DbBlob(b) => b
            case _ => Array<Byte>()
        }
    }
}

public class Db {
    private let conn: Connection
    private let guard = Mutex()
    public let path: String

    init(path: String) {
        registerSqliteDriver()
        this.path = path
        let driver = DriverManager.getDriver("sqlite").getOrThrow()
        let ds = driver.open(path, Array<(String, String)>())
        this.conn = ds.connect()
    }

    public static func openFile(dbPath: String): Db {
        let parentDir = Path(dbPath)
        ensureDir(parentDir.parent.toString())
        let db = Db(dbPath)
        ensureSchema(db)
        return db
    }

    public func exec(sql: String): Int64 {
        run(sql, ArrayList<DbValue>())
    }

    public func run(sql: String, args: ArrayList<DbValue>): Int64 {
        guard.lock()
        try {
            if (sql.contains("session")) {
                bumpSessionEpoch()
            }
            return prepareAndRun(sql, args)
        } finally {
            guard.unlock()
        }
    }

    private func prepareAndRun(sql: String, args: ArrayList<DbValue>): Int64 {
        let st = conn.prepareStatement(sql)
        try {
            bindAll(st, args)
            let r = st.update()
            return r.rowCount
        } finally {
            st.close()
        }
    }

    /**
     * 一批写操作，同一个事务同一个锁。
     *
     * 上层的 save() 是「先删后写」的整体替换，中间崩掉会留下半个状态；
     * 走这个入口保证要么全有要么全无。
     */
    public func batch(ops: ArrayList<DbOp>): Int64 {
        if (ops.size == 0) {
            return 0
        }
        guard.lock()
        try {
            let tx = conn.createTransaction()
            tx.begin()
            var affected: Int64 = 0
            try {
                for (op in ops) {
                    if (op.sql.contains("session")) {
                        bumpSessionEpoch()
                    }
                    affected += prepareAndRun(op.sql, op.args)
                }
                tx.commit()
            } catch (e: Exception) {
                try {
                    tx.rollback()
                } catch (e2: Exception) {
                    ()
                }
                throw e
            }
            return affected
        } finally {
            guard.unlock()
        }
    }

    /** 批量写入同一条语句的不同参数。索引重建一次几万行的主路径。 */
    public func runMany(sql: String, rows: ArrayList<ArrayList<DbValue>>): Int64 {
        if (rows.size == 0) {
            return 0
        }
        guard.lock()
        try {
            let tx = conn.createTransaction()
            tx.begin()
            var affected: Int64 = 0
            try {
                let st = conn.prepareStatement(sql)
                try {
                    for (row in rows) {
                        if (sql.contains("session")) {
                            bumpSessionEpoch()
                        }
                        bindAll(st, row)
                        affected += st.update().rowCount
                    }
                } finally {
                    st.close()
                }
                tx.commit()
            } catch (e: Exception) {
                try {
                    tx.rollback()
                } catch (e2: Exception) {
                    ()
                }
                throw e
            }
            return affected
        } finally {
            guard.unlock()
        }
    }

    public func query(sql: String, args: ArrayList<DbValue>): ArrayList<DbRow> {
        guard.lock()
        try {
            let st = conn.prepareStatement(sql)
            try {
                bindAll(st, args)
                let rs = st.query()
                try {
                    let out = ArrayList<DbRow>()
                    while (rs.next()) {
                        out.add(readRow(rs))
                    }
                    return out
                } finally {
                    rs.close()
                }
            } finally {
                st.close()
            }
        } finally {
            guard.unlock()
        }
    }

    public func querySql(sql: String): ArrayList<DbRow> {
        query(sql, ArrayList<DbValue>())
    }

    public func one(sql: String, args: ArrayList<DbValue>): ?DbRow {
        let rows = query(sql, args)
        if (rows.size == 0) {
            return None
        }
        return Some(rows[0])
    }

    public func scalarInt(sql: String, args: ArrayList<DbValue>): Int64 {
        match (one(sql, args)) {
            case Some(r) =>
                if (r.size() == 0) {
                    return 0
                }
                return r.int(0)
            case None => 0
        }
    }

    public func scalarText(sql: String, args: ArrayList<DbValue>): String {
        match (one(sql, args)) {
            case Some(r) =>
                if (r.size() == 0) {
                    return ""
                }
                return r.text(0)
            case None => ""
        }
    }

    public func columnText(sql: String, args: ArrayList<DbValue>): ArrayList<String> {
        let out = ArrayList<String>()
        for (r in query(sql, args)) {
            out.add(r.text(0))
        }
        return out
    }

    /** meta/settings/profile 这类键值表。表名是代码里的常量，不是用户输入。 */
    public func putKv(table: String, k: String, v: String): Unit {
        run("INSERT OR REPLACE INTO " + table + " (k, v) VALUES (?, ?)", va([tv(k), tv(v)]))
    }

    public func getKv(table: String, k: String, fallback: String): String {
        let got = scalarText("SELECT v FROM " + table + " WHERE k = ?", va([tv(k)]))
        if (got.size == 0) {
            return fallback
        }
        return got
    }

    public func delKv(table: String, k: String): Unit {
        run("DELETE FROM " + table + " WHERE k = ?", va([tv(k)]))
    }

    public func close(): Unit {
        guard.lock()
        try {
            conn.close()
        } finally {
            guard.unlock()
        }
    }

    private func bindAll(st: Statement, args: ArrayList<DbValue>): Unit {
        var i: Int64 = 0
        while (i < args.size) {
            match (args[i]) {
                case DbText(s) => st.set<String>(i, s)
                case DbInt(n) => st.set<Int64>(i, n)
                case DbReal(f) => st.set<Float64>(i, f)
                case DbBlob(b) => st.set<Array<Byte>>(i, b)
                case DbNull => st.setNull(i)
            }
            i += 1
        }
    }

    /**
     * 读一行。
     *
     * 先按字符串读：驱动会把整数/浮点转成文本，NULL 返回 None，正好覆盖最常用的三类列。
     * BLOB 会在这一步抛（驱动不允许把二进制读成字符串），所以第二步单独按字节读。
     * 之所以不读列类型元信息，是因为结果集为空时驱动给不出类型。
     */
    private func readRow(rs: QueryResult): DbRow {
        let n = Int64(rs.columnInfos.size)
        let cells = Array<DbValue>(n, repeat: DbNull)
        var i: Int64 = 0
        while (i < n) {
            cells[i] = cellOf(rs, i)
            i += 1
        }
        return DbRow(cells)
    }

    private func cellOf(rs: QueryResult, i: Int64): DbValue {
        try {
            match (rs.getOrNull<String>(i)) {
                case Some(s) => return DbText(s)
                case None => return DbNull
            }
        } catch (e: Exception) {
            ()
        }
        try {
            match (rs.getOrNull<Array<Byte>>(i)) {
                case Some(b) => return DbBlob(b)
                case None => return DbNull
            }
        } catch (e: Exception) {
            ()
        }
        return DbNull
    }
}

/*
 * 进程内共享连接。
 *
 * 之前每个仓库类各持一个文件路径、各读自己的 JSON；共享连接后，写与读看到同一份状态，
 * 不会再出现「这个页面刚存的，另一个页面读不到」。
 */
/*
 * 会话相关表的写纪元。
 *
 * sessions/list 的组装在纯仓颉引擎上要 ~1 秒，所以它在 session.cj 里做了进程内缓存；
 * 缓存靠这个计数器失效：凡是写到 sessions / session_events / sessions_meta 的 SQL
 * 都让纪元 +1（表名都含 "session"，判定就按这个来）。比“每次重新查 MAX(id)/摘要”便宜得多
 * ——那个指纹本身在这台引擎上就要 380ms。
 */
let sessionEpochLock = Mutex()
var sessionEpochValue: Int64 = 0
public func bumpSessionEpoch(): Unit {
    sessionEpochLock.lock()
    try {
        sessionEpochValue += 1
    } finally {
        sessionEpochLock.unlock()
    }
}
public func sessionEpoch(): Int64 {
    sessionEpochLock.lock()
    try {
        return sessionEpochValue
    } finally {
        sessionEpochLock.unlock()
    }
}

public class DbHub {
    private static let lock = Mutex()
    private static var current: ?Db = None
    private static var currentDir: String = ""

    public static func open(dataDir: String): Db {
        lock.lock()
        try {
            match (current) {
                case Some(d) =>
                    if (currentDir == dataDir) {
                        return d
                    }
                    try {
                        d.close()
                    } catch (e: Exception) {
                        ()
                    }
                case None => ()
            }
            let db = Db.openFile(dataDir + Path.Separator + "itn.db")
            current = Some(db)
            currentDir = dataDir
            return db
        } finally {
            lock.unlock()
        }
    }

    /** 供测试使用：关掉共享连接，让下一次 open 重新建。 */
    public static func reset(): Unit {
        lock.lock()
        try {
            match (current) {
                case Some(d) =>
                    try {
                        d.close()
                    } catch (e: Exception) {
                        ()
                    }
                case None => ()
            }
            current = None
            currentDir = ""
        } finally {
            lock.unlock()
        }
    }
}

// ==================== 向量编解码 ====================
// 向量存 BLOB：每维 4 字节小端 Float32。
//
// 之前是 vectors.txt 里几十万个十进制数字，冷启动要逐个 Float64.parse。二进制后
// 加载是纯位移，3500×1024 维从 30MB 降到 14MB，解析时间从秒级降到可忽略。

public func encodeVector(v: ArrayList<Float64>): Array<Byte> {
    let out = Array<Byte>(v.size * 4, repeat: 0)
    var i = 0
    while (i < v.size) {
        let bits = Float32(v[i]).toBits()
        out[i * 4] = UInt8((bits >> 24) & 0xFFu32)
        out[i * 4 + 1] = UInt8((bits >> 16) & 0xFFu32)
        out[i * 4 + 2] = UInt8((bits >> 8) & 0xFFu32)
        out[i * 4 + 3] = UInt8(bits & 0xFFu32)
        i += 1
    }
    return out
}

public func decodeVector(b: Array<Byte>): ArrayList<Float64> {
    let out = ArrayList<Float64>()
    if (b.size % 4 != 0) {
        return out
    }
    var i = 0
    while (i < b.size) {
        let bits = (UInt32(b[i]) << 24) | (UInt32(b[i + 1]) << 16) | (UInt32(b[i + 2]) << 8) | UInt32(b[i + 3])
        out.add(Float64(Float32.fromBits(bits)))
        i += 4
    }
    return out
}

public func vectorDim(b: Array<Byte>): Int64 {
    return Int64(b.size) / 4
}