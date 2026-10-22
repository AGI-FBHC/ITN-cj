package sqlite_driver

import std.database.sql.*

/*
 * 本包的异常分四类, 区分"库文件坏了"、"SQL 写错了"、"约束不让写"和"锁拿不到" ——
 * 四者的处置完全不同, 混成一个类型会逼调用方去 match 错误文本。
 *
 * 它们继承 std.database.sql.SqlException, 引擎内部仍抛精确类型;
 * 上层适配器可以在边界把它们转换为自己的数据库异常体系。
 */

/** 磁盘格式不符合 SQLite 规范: 头字段非法、页类型未知、varint 截断等。 */
public class SqliteFormatException <: SqlException {
    public init(message: String) {
        super("sqlite format error: ${message}", "", 0)
    }
}

/**
 * SQL 文本无法解析或语义不成立。
 *
 * position 是出错处在原 SQL 中的字节偏移, 且写进 message。
 */
public class SqliteSyntaxException <: SqlException {
    public let position: Int64

    public init(message: String, position: Int64) {
        super("sqlite syntax error at offset ${position}: ${message}", "", 0)
        this.position = position
    }
}

/** 运行期约束或状态错误: 唯一约束冲突、NOT NULL 违反、无事务时 COMMIT 等。 */
public class SqliteRuntimeException <: SqlException {
    public let kind: String

    public init(kind: String, message: String) {
        super("sqlite ${kind} error: ${message}", "", 0)
        this.kind = kind
    }
}

/** 取不到写锁: 另一个使用本驱动的进程持锁且 busy_timeout 已耗尽。 */
public class SqliteBusyException <: SqlException {
    public init(message: String) {
        super("sqlite busy: ${message}", "", 0)
    }
}

/** 语句被 cancel() 主动取消，或超过 timeout_ms。 */
public class SqliteInterruptedException <: SqlException {
    public init(message: String) {
        super("sqlite interrupted: ${message}", "", 0)
    }
}

/** 约束冲突的细分, 供 ON CONFLICT 判断该不该转成"忽略"或"更新"。 */
public class SqliteConstraintException <: SqlException {
    /** "unique" | "notnull" | "check" | "primarykey" | "datatype" | "foreignkey" */
    public let constraint: String
    /** 冲突涉及的表名, 无表上下文时为空串。 */
    public let table: String

    public init(constraint: String, table: String, message: String) {
        super("sqlite constraint failed [${constraint}]: ${message}", "", 0)
        this.constraint = constraint
        this.table = table
    }
}
