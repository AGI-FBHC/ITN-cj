package sqlite_driver

import std.collection.*

/*
 * 行的运行期表示与求值上下文。
 */

/**
 * 解出一行的列值。
 *
 * INTEGER PRIMARY KEY 列在 record 里存的是 NULL —— 它的真值是 rowid。这不是优化,
 * 而是格式规定: 该列与 rowid 是同一个东西, 存两份会让二者可能不一致。所以解码后必须
 * 把 rowid 填回该列, 否则 `SELECT id FROM t` 全是 NULL。
 *
 * record 的字段数可能小于列数 (ALTER TABLE ADD COLUMN 不回填已有行), 缺的那些取列的
 * 常量 DEFAULT。
 */
func decodeRowValues(table: TableInfo, rowid: Int64, payload: Array<Byte>): Array<SqliteValue> {
    let values = decodeRecordWithDefaults(payload, table.columnDefaults)
    if (table.rowidAliasColumn >= 0) {
        values[table.rowidAliasColumn] = SqliteValue.SInt(rowid)
    }
    values
}

/**
 * 编一行的 record 字节。
 *
 * 与 decodeRowValues 对偶: rowid 别名列写 NULL。写成真值会让 record 多占几字节,
 * 且 SQLite 读到时会认为该列有独立值 —— 之后 UPDATE rowid 就会出现两个不同的 id。
 */
func encodeRowValues(table: TableInfo, values: Array<SqliteValue>): Array<Byte> {
    if (table.rowidAliasColumn < 0) {
        return encodeRecord(values)
    }
    let copy = Array<SqliteValue>(values.size, repeat: SqliteValue.SNull)
    for (i in 0..values.size) {
        copy[i] = values[i]
    }
    copy[table.rowidAliasColumn] = SqliteValue.SNull
    // 尾部的 NULL 可以省掉 (SQLite 也这么做), 但 rowid 别名列若在末尾就必须保留占位,
    // 否则列数对不上。这里不做尾部裁剪, 保持简单且正确。
    encodeRecord(copy)
}

/** 一个数据源在当前行上的取值。 */
class RowSource {
    /** 查询里可见的名字 (别名优先)。 */
    let name: String
    let columnNames: Array<String>
    var values: Array<SqliteValue>
    var rowid: Int64
    /** 有表信息时带上 (供亲和性与 rowid 关键字用); 子查询源为 None。 */
    let table: Option<TableInfo>
    /** LEFT JOIN 未匹配时整个源为 NULL。 */
    var isNullRow: Bool
    /**
     * 只能用限定名引用的伪表 (upsert 的 `excluded`, 触发器的 `OLD` / `NEW`)。
     *
     * 未限定的列名必须跳过这类源, 否则它与目标表的列名完全重合 —— `DO UPDATE SET v = v`
     * 会被判成 ambiguous column name, 而 SQLite 把未限定的 v 解析成目标表的旧值。
     * `*` 展开同样要跳过, 不然伪表的列会混进结果集。
     */
    var qualifiedOnly: Bool
    /**
     * 被 USING / NATURAL 合并掉的列序号。
     *
     * USING / NATURAL 的公共列在 `*` 结果中只出现一次，保留左侧列并在展开时跳过右侧列。
     * 使用限定名时仍可分别读取两侧列。
     */
    let mergedAway = HashSet<Int64>()

    init(name: String, columnNames: Array<String>, table: Option<TableInfo>) {
        this.name = name
        this.columnNames = columnNames
        this.table = table
        this.values = Array<SqliteValue>(columnNames.size, repeat: SqliteValue.SNull)
        this.rowid = 0
        this.isNullRow = false
        this.qualifiedOnly = false
    }

    func columnIndexOf(colName: String): Int64 {
        let lower = colName.toAsciiLower()
        for (i in 0..columnNames.size) {
            if (columnNames[i].toAsciiLower() == lower) {
                return i
            }
        }
        -1
    }

    func setNullRow(): Unit {
        isNullRow = true
        for (i in 0..values.size) {
            values[i] = SqliteValue.SNull
        }
        rowid = 0
    }
}

/**
 * 求值上下文。
 *
 * sources 是 FROM 里的所有数据源, 按顺序; 列引用先按限定名找源, 未限定时在所有源里找
 * 唯一匹配 —— 多个源都有同名列时报歧义而不是随便选一个。
 */
class EvalContext {
    let db: SqliteDatabase
    let params: Array<SqliteValue>
    let sources = ArrayList<RowSource>()
    /** OLD / NEW 等只接受限定名的伪表；不占 FROM 层号，避免打乱连接树的源索引。 */
    let pseudoSources = ArrayList<RowSource>()
    /** 聚合累加器: 键是聚合表达式在语句里的序号。 */
    var aggregates: Option<HashMap<Int64, AggregateState>> = None
    /** 聚合的第二遍求值时用: 直接取已算好的结果。 */
    var aggregateResults: Option<HashMap<Int64, SqliteValue>> = None
    /** 当前逻辑行上已经算好的窗口函数值，键是 WindowExpr.serial。 */
    var windowResults: Option<HashMap<Int64, SqliteValue>> = None
    /** 外层上下文, 供关联子查询访问外层列。 */
    var outer: Option<EvalContext> = None
    /**
     * 本层语句声明的公共表表达式, 键是小写名。
     *
     * 查找沿 outer 向上进行，因此子查询与标量子查询可以访问外层 CTE；内层同名声明遮蔽外层。
     */
    let ctes = HashMap<String, MaterializedCte>()
    /**
     * 正在执行的 SELECT。
     *
     * 访问路径选择要看 WHERE 才能挑索引, 而它发生在数据源迭代的最内层 —— 把语句作为参数
     * 一路传下去会穿透五六层回调, 放在上下文里更直接。
     */
    var currentStatement: Option<SelectStmt> = None
    /**
     * USING / NATURAL 合并后的公共列: 小写列名 → 参与合并的列位置, 按左到右。
     *
     * 未限定引用取组里第一个非 NULL 值 (COALESCE 语义), 所以 `SELECT id FROM a JOIN b
     * USING(id)` 既不歧义、又能在外连接的未匹配行上取到非 NULL 的那一侧。
     */
    let mergeGroups = HashMap<String, ArrayList<ColumnRef>>()
    /** 本次 SELECT 的连接树; 由 runSelectCore 建好后复用, 免得每次迭代重建。 */
    var joinTree: Option<JoinNode> = None
    /**
     * 正在物化某个子树 (RIGHT / FULL 的右操作数)。
     *
     * 物化在外层循环之外发生, 此时外层源里是残值, 所以索引选择必须停掉 —— 见
     * materializeSubtree 的注释。
     */
    var materializing: Bool = false

    init(db: SqliteDatabase, params: Array<SqliteValue>) {
        this.db = db
        this.params = params
        // 语句级 WITH 的 CTE 对本语句内的每个上下文都可见, 且只物化一份。DML 的各个执行器
        // 各自新建上下文 (8 处), 逐处注册漏一处就会让那条路径上的 CTE 名解析成"没有这张表";
        // 从 db 上取则一处都漏不掉。
        for ((name, cte) in db.statementCtes) {
            ctes[name] = cte
        }
        // 触发器 body 里的语句同样各自新建上下文, 而 OLD / NEW 要在它们里面可见。
        if (let Some(row) <- db.triggerRow) {
            addTriggerPseudoSources(this, row)
        }
    }

    func addSource(src: RowSource): Unit {
        sources.add(src)
    }

    func addPseudoSource(src: RowSource): Unit {
        pseudoSources.add(src)
    }

    func findSource(name: String): Option<RowSource> {
        let lower = name.toAsciiLower()
        for (s in sources) {
            if (s.name.toAsciiLower() == lower) {
                return Some(s)
            }
        }
        for (s in pseudoSources) {
            if (s.name.toAsciiLower() == lower) {
                return Some(s)
            }
        }
        None
    }

    /**
     * 按名字找 CTE, 沿 outer 链往上。
     *
     * 本层优先: 内层的 `WITH s AS …` 遮蔽外层的同名 CTE。
     */
    func findCte(name: String): Option<MaterializedCte> {
        let lower = name.toAsciiLower()
        if (let Some(c) <- ctes.get(lower)) {
            return Some(c)
        }
        match (outer) {
            case Some(o) => o.findCte(name)
            case None => None
        }
    }

    /** 造一个共享同一批数据源的子上下文, 供子查询用。 */
    func childContext(): EvalContext {
        let child = EvalContext(db, params)
        child.outer = Some(this)
        child
    }
}

/** 聚合函数的累加状态。 */
class AggregateState {
    let name: String
    var count: Int64 = 0
    var intSum: Int64 = 0
    var floatSum: Float64 = 0.0
    /** 累加过程中是否出现过浮点或整数溢出 —— 决定 sum 返回整数还是浮点。 */
    var useFloat: Bool = false
    var minMax: SqliteValue = SqliteValue.SNull
    var hasValue: Bool = false
    let texts = ArrayList<String>()
    /** DISTINCT 去重用: 已见过的值的规范文本形式。 */
    let seen = HashSet<String>()
    let distinct: Bool
    var separator: String = ","

    init(name: String, distinct: Bool) {
        this.name = name
        this.distinct = distinct
    }
}
