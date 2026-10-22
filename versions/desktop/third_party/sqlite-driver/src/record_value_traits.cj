package sqlite_driver

/*
 * SqliteValue 的 Equatable 与 ToString。
 *
 * 两者都是对外 API 的一部分: SqliteValue 是公开类型, 调用方会拿它做断言与日志。缺了
 * Equatable 时 `v == SqliteValue.SInt(1)` 编译不过; 缺了 ToString 时字符串插值编译不过。
 *
 * == 的语义是**存储类与值都相同**, 而不是 SQL 的比较语义。区别在两处:
 *   - SNull == SNull 为 true (SQL 里 NULL = NULL 是 NULL);
 *   - SInt(1) != SReal(1.0) (SQL 比较里两者相等)。
 * 混用会让"这两个值是同一个"与"这两个值在 SQL 里相等"变成同一个判断, 而按存储类分桶
 * (如 DISTINCT 与 GROUP BY) 恰恰需要前者。SQL 语义的比较走 compareValues。
 */
extend SqliteValue <: Equatable<SqliteValue> {
    public operator func ==(rhs: SqliteValue): Bool {
        match ((this, rhs)) {
            case (SNull, SNull) => true
            case (SInt(a), SInt(b)) => a == b
            case (SReal(a), SReal(b)) => a == b
            case (SText(a), SText(b)) => a == b
            case (SBlob(a), SBlob(b)) => bytesEqual(a, b)
            case _ => false
        }
    }

    public operator func !=(rhs: SqliteValue): Bool {
        !(this == rhs)
    }
}

func bytesEqual(a: Array<Byte>, b: Array<Byte>): Bool {
    if (a.size != b.size) {
        return false
    }
    for (i in 0..a.size) {
        if (a[i] != b[i]) {
            return false
        }
    }
    true
}

/**
 * 调试形态: 带存储类前缀。
 *
 * 不用 valueToText: 那是 SQL 的文本转换 (NULL 变空串, BLOB 变原始字节), 用于日志时
 * NULL 与空串无法分辨, 而这正是排查数据问题时最需要区分的一对。
 */
extend SqliteValue <: ToString {
    public func toString(): String {
        match (this) {
            case SNull => "NULL"
            case SInt(i) => "INTEGER(${i})"
            case SReal(f) => "REAL(${formatReal(f)})"
            case SText(s) => "TEXT('${s}')"
            case SBlob(bs) => "BLOB(x'${bytesToHex(bs)}', ${bs.size} bytes)"
        }
    }
}

/** SqliteAffinity 的名字, 供 PRAGMA 与诊断信息用。 */
extend SqliteAffinity <: ToString {
    public func toString(): String {
        match (this) {
            case AffInteger => "INTEGER"
            case AffReal => "REAL"
            case AffNumeric => "NUMERIC"
            case AffText => "TEXT"
            case AffBlob => "BLOB"
        }
    }
}

extend SqliteCollation <: ToString {
    public func toString(): String {
        collationName(this)
    }
}
