package sqlite_driver

import std.collection.*
import std.database.sql.ColumnInfo as StdColumnInfo
import std.database.sql.QueryResult
import std.database.sql.SqlDbType

/*
 * std.database.sql 查询结果。
 *
 * 底层 SqliteResultSet 已把行物化在内存里; 这里只维护一个游标。next() 必须先调用一次才
 * 定位到第一行, 第二次定位到第二行, 与 std.database.sql 契约一致。
 */
public class SqliteQueryResult <: QueryResult {
    private let rs: SqliteResultSet
    private let infos: Array<StdColumnInfo>
    private var rowIndex: Int64 = -1
    private var closed = false

    init(rs: SqliteResultSet) {
        this.rs = rs
        let out = ArrayList<StdColumnInfo>()
        for (i in 0..rs.columnNames.size) {
            let typeName = if (rs.rows.isEmpty()) {
                "NULL"
            } else {
                sqliteTypeName(rs.rows[0][i])
            }
            out.add(SqliteColumnInfo(rs.columnNames[i], typeName, 0, 0, true, 0))
        }
        this.infos = out.toArray()
    }

    public prop columnInfos: Array<StdColumnInfo> {
        get() {
            infos
        }
    }

    public func next(): Bool {
        requireOpen()
        if (rowIndex + 1 < rs.rows.size) {
            rowIndex += 1
            return true
        }
        false
    }

    @Deprecated["Use next() with get<T>()/getOrNull<T>() instead.", since: "0.1.0"]
    public func next(values: Array<SqlDbType>): Bool {
        requireOpen()
        if (values.size != rs.columnNames.size) {
            throw SqliteRuntimeException("result",
                "column count mismatch: result has ${rs.columnNames.size}, values has ${values.size}")
        }
        if (!next()) {
            return false
        }
        let row = rs.rows[rowIndex]
        for (i in 0..values.size) {
            writeSqlDbType(row[i], values[i])
        }
        true
    }

    public func get<T>(index: Int64): T {
        requireOpen()
        requireRow()
        checkColumnIndex(index)
        let v = rs.rows[rowIndex][index]
        // 路径 D 运行期类型归属判定: is / as 哨兵 if 链 + 命中分支调具名公开桥接函数 + castTo<T>(...) 回转到 T。
        // 末条以 SENTINEL_INPUTSTREAM 单判定同时覆盖 InputStream 与 ByteBuffer
        // (由 ByteBuffer <: InputStream 子类型关系天然合并); 共 13 类目标类型。
        if (isT<T>(SENTINEL_BOOL)) {
            return castTo<T>(valueFromSqliteBool(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_I8)) {
            return castTo<T>(valueFromSqliteInt8(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_I16)) {
            return castTo<T>(valueFromSqliteInt16(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_I32)) {
            return castTo<T>(valueFromSqliteInt32(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_I64)) {
            return castTo<T>(valueFromSqliteInt64(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_F32)) {
            return castTo<T>(valueFromSqliteFloat32(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_F64)) {
            return castTo<T>(valueFromSqliteFloat64(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_STRING)) {
            return castTo<T>(valueFromSqliteString(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_BYTES)) {
            return castTo<T>(valueFromSqliteBytes(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_DECIMAL)) {
            return castTo<T>(valueFromSqliteDecimal(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_DATETIME)) {
            return castTo<T>(valueFromSqliteDateTime(v)).getOrThrow()
        }
        if (isT<T>(SENTINEL_INPUTSTREAM)) {
            return castTo<T>(valueFromSqliteInputStream(v)).getOrThrow()
        }
        throw SqliteRuntimeException("result", "unsupported requested type")
    }

    public func getOrNull<T>(index: Int64): ?T {
        requireOpen()
        requireRow()
        checkColumnIndex(index)
        let v = rs.rows[rowIndex][index]
        // SQL NULL 短路独立于 is 链之外: 保留原可空路径的 SNull → None 行为
        // (等价于方案 §4.3 可空侧角落行为表中"未支持 T + SQL NULL 保留 None"语义)。
        match (v) {
            case SqliteValue.SNull => return None
            case _ => ()
        }
        // 非 SNull 侧: 命中分支调具名非可空公开桥接函数 + castTo<T>(...) 对内层裸值回转到 T
        // + Some(...) 包装为 ?T —— 全程不出现装箱转型 castTo<?T>(?: ?Xxx) 路径。
        if (isT<T>(SENTINEL_BOOL)) {
            return Some(castTo<T>(valueFromSqliteBool(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_I8)) {
            return Some(castTo<T>(valueFromSqliteInt8(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_I16)) {
            return Some(castTo<T>(valueFromSqliteInt16(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_I32)) {
            return Some(castTo<T>(valueFromSqliteInt32(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_I64)) {
            return Some(castTo<T>(valueFromSqliteInt64(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_F32)) {
            return Some(castTo<T>(valueFromSqliteFloat32(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_F64)) {
            return Some(castTo<T>(valueFromSqliteFloat64(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_STRING)) {
            return Some(castTo<T>(valueFromSqliteString(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_BYTES)) {
            return Some(castTo<T>(valueFromSqliteBytes(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_DECIMAL)) {
            return Some(castTo<T>(valueFromSqliteDecimal(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_DATETIME)) {
            return Some(castTo<T>(valueFromSqliteDateTime(v)).getOrThrow())
        }
        if (isT<T>(SENTINEL_INPUTSTREAM)) {
            return Some(castTo<T>(valueFromSqliteInputStream(v)).getOrThrow())
        }
        throw SqliteRuntimeException("result", "unsupported requested type")
    }

    public func close(): Unit {
        closed = true
    }

    public func isClosed(): Bool {
        closed
    }

    private func requireOpen(): Unit {
        if (closed) {
            throw SqliteRuntimeException("result", "result set is closed")
        }
    }

    private func requireRow(): Unit {
        if (rowIndex < 0) {
            throw SqliteRuntimeException("result", "next() must be called before reading a row")
        }
    }

    private func checkColumnIndex(index: Int64): Unit {
        if (index < 0 || index >= rs.columnNames.size) {
            throw SqliteRuntimeException("result", "column index ${index} is out of range 0..${rs.columnNames.size - 1}")
        }
    }
}

func sqliteTypeName(v: SqliteValue): String {
    match (v) {
        case SqliteValue.SNull => "NULL"
        case SqliteValue.SInt(_) => "INTEGER"
        case SqliteValue.SReal(_) => "REAL"
        case SqliteValue.SText(_) => "TEXT"
        case SqliteValue.SBlob(_) => "BLOB"
    }
}
