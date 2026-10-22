package sqlite_driver

import std.collection.*
import std.sort.*

/*
 * sqlite_schema 的读写与内存模式缓存。
 *
 * sqlite_schema 是一张普通的表, 根页恒为 1, 五列:
 *   type      'table' | 'index' | 'view' | 'trigger'
 *   name      对象名
 *   tbl_name  所属表名 (表自己就是自己)
 *   rootpage  该对象的 B-tree 根页; view/trigger 为 0
 *   sql       创建时的原始 DDL 文本
 *
 * 列定义**不另存**, 而是每次打开库时重新解析 sql 列 —— 这与 SQLite 一致, 也是我们能
 * 读它写的库的原因: 对方只留下 DDL 文本, 没有结构化的列信息可读。
 */

/** sqlite_schema 自己的根页号, 格式规定死的。 */
const SCHEMA_ROOT_PAGE: Int64 = 1

/** sqlite_schema 的列数。 */
const SCHEMA_COLUMN_COUNT: Int64 = 5
const SCHEMA_TABLE_NAME: String = "sqlite_schema"
/** 旧名, 仍被广泛使用, 查询时视作同一张表。 */
const SCHEMA_TABLE_LEGACY_NAME: String = "sqlite_master"

/** 一列的运行期信息。 */
class ColumnInfo {
    let name: String
    let declaredType: String
    let affinity: SqliteAffinity
    let notNull: Bool
    let collation: SqliteCollation
    let defaultExpr: Option<Expr>
    let checkExpr: Option<Expr>
    /** 该列是否是 INTEGER PRIMARY KEY (即 rowid 的别名)。 */
    let isRowidAlias: Bool
    /** 在表里的序号, 从 0 起。 */
    let index: Int64
    /** 是否属于主键 (含复合主键)。 */
    let inPrimaryKey: Bool
    /**
     * 常量 DEFAULT 的取值, 已按列亲和性转换; 无默认值或默认值不是常量时为 NULL。
     *
     * record 里缺失的字段按它读出。在建列信息时算一次而不是解码时现求: 解码在全表扫描的
     * 最内层, 且那里拿不到求值上下文。
     */
    let constantDefault: SqliteValue

    init(name: String, declaredType: String, notNull: Bool, collation: SqliteCollation, defaultExpr: Option<Expr>,
        checkExpr: Option<Expr>, isRowidAlias: Bool, index: Int64, inPrimaryKey: Bool) {
        let aff = affinityOf(declaredType)
        this.name = name
        this.declaredType = declaredType
        this.affinity = aff
        this.notNull = notNull
        this.collation = collation
        this.defaultExpr = defaultExpr
        this.checkExpr = checkExpr
        this.isRowidAlias = isRowidAlias
        this.index = index
        this.inPrimaryKey = inPrimaryKey
        this.constantDefault = applyAffinity(constantDefaultValue(defaultExpr), aff)
    }
}

/** 默认值表达式的常量取值; 没写默认值或它不是常量时为 NULL。 */
func constantDefaultValue(defaultExpr: Option<Expr>): SqliteValue {
    match (defaultExpr) {
        case Some(e) => match (constantExprValue(e)) {
            case Some(v) => v
            case None => SqliteValue.SNull
        }
        case None => SqliteValue.SNull
    }
}

/**
 * 表达式的常量取值; 不是常量时为 None。
 *
 * 常量的范围是字面量, 以及一元 + / - 后跟字面量 (`DEFAULT -1`)。再复杂一层的表达式要在
 * 求值上下文里算, 而 ALTER TABLE ADD COLUMN 的默认值必须能脱离上下文求出来 —— 它要供
 * 已有行的解码使用, 所以 SQLite 也只接受这一类。
 */
func constantExprValue(e: Expr): Option<SqliteValue> {
    if (e is LiteralExpr) {
        return Some((e as LiteralExpr).getOrThrow().value)
    }
    if (e is UnaryExpr) {
        let u = (e as UnaryExpr).getOrThrow()
        if (!(u.operand is LiteralExpr)) {
            return None
        }
        let v = (u.operand as LiteralExpr).getOrThrow().value
        if (u.op == "+") {
            return Some(v)
        }
        if (u.op == "-") {
            return Some(match (v) {
                case SNull => v
                case _ => negateValue(v)
            })
        }
    }
    None
}

/** 各列的常量默认值, 按给定顺序。 */
func columnDefaultValues(columns: Array<ColumnInfo>): Array<SqliteValue> {
    let out = Array<SqliteValue>(columns.size, repeat: SqliteValue.SNull)
    for (i in 0..columns.size) {
        out[i] = columns[i].constantDefault
    }
    out
}

/** 一个索引的运行期信息。 */
class IndexInfo {
    let name: String
    let tableName: String
    let rootPage: Int64
    let unique: Bool
    /** 索引列在表里的序号。 */
    let columnIndexes: Array<Int64>
    let columnNames: Array<String>
    let collations: Array<SqliteCollation>
    let descs: Array<Bool>
    /** 部分索引的 WHERE 条件。 */
    let whereExpr: Option<Expr>
    /** 是否由 UNIQUE 约束自动创建 (名字形如 sqlite_autoindex_…)。 */
    let autoIndex: Bool

    init(name: String, tableName: String, rootPage: Int64, unique: Bool, columnIndexes: Array<Int64>,
        columnNames: Array<String>, collations: Array<SqliteCollation>, descs: Array<Bool>, whereExpr: Option<Expr>,
        autoIndex: Bool) {
        this.name = name
        this.tableName = tableName
        this.rootPage = rootPage
        this.unique = unique
        this.columnIndexes = columnIndexes
        this.columnNames = columnNames
        this.collations = collations
        this.descs = descs
        this.whereExpr = whereExpr
        this.autoIndex = autoIndex
    }
}

/**
 * 一条外键约束的运行期信息。
 *
 * 子列已解析成序号 (查行值时直接用), 父列仍留名字: 父表在建子表时可能还不存在
 * (SQLite 允许先建子表), 所以父列到序号的解析推迟到真正校验的那一刻。
 */
class ForeignKeyInfo {
    let childTable: String
    /** 子表里参与外键的列序号, 按声明顺序。 */
    let childColumns: Array<Int64>
    let childColumnNames: Array<String>
    let parentTable: String
    /** 父表列名; 空表示引用父表主键。 */
    let parentColumns: Array<String>
    let onDelete: String
    let onUpdate: String
    let deferred: Bool

    init(childTable: String, childColumns: Array<Int64>, childColumnNames: Array<String>, parentTable: String,
        parentColumns: Array<String>, onDelete: String, onUpdate: String, deferred: Bool) {
        this.childTable = childTable
        this.childColumns = childColumns
        this.childColumnNames = childColumnNames
        this.parentTable = parentTable
        this.parentColumns = parentColumns
        this.onDelete = onDelete
        this.onUpdate = onUpdate
        this.deferred = deferred
    }
}

/** 一张表的运行期信息。 */
class TableInfo {
    let name: String
    let rootPage: Int64
    let columns: Array<ColumnInfo>
    let sql: String
    /** INTEGER PRIMARY KEY 列的序号; -1 表示没有 (用隐式 rowid)。 */
    let rowidAliasColumn: Int64
    let autoincrement: Bool
    /** 复合主键的列序号; 单列 INTEGER PRIMARY KEY 时为空 (它就是 rowid)。 */
    let primaryKeyColumns: Array<Int64>
    /** 表级 CHECK 约束。 */
    let checks: Array<Expr>
    let indexes = ArrayList<IndexInfo>()
    /** 本表声明的外键 (本表是子表)。 */
    let foreignKeys: Array<ForeignKeyInfo>
    /**
     * 各列的常量 DEFAULT, 按表的声明序; 解码时用来补齐 record 里缺失的字段。
     *
     * 备成一份数组而不是解码时逐列去 columns 里取: 解码在全表扫描的最内层。
     */
    let columnDefaults: Array<SqliteValue>
    /**
     * WITHOUT ROWID 表的键规格; 普通 rowid 表为 None。
     *
     * 是 var 且在构造后由 tableInfoFromCreate 填: 它要用到已建好的 ColumnInfo (取 collation),
     * 而那些列是在构造 TableInfo 的同一步里造出来的。
     */
    var rowKey: Option<RowKeySpec> = None

    /** 是不是 WITHOUT ROWID 表。判据就是有没有键规格, 不另设标志位以免两者不同步。 */
    prop withoutRowid: Bool {
        get() {
            match (rowKey) {
                case Some(_) => true
                case None => false
            }
        }
    }

    /** WITHOUT ROWID 表的键规格；rowid 表调用时报告内部状态错误。 */
    func requireRowKey(): RowKeySpec {
        match (rowKey) {
            case Some(spec) => spec
            case None => throw SqliteRuntimeException("internal",
                "table ${name} is not WITHOUT ROWID but a row key was requested")
        }
    }

    init(name: String, rootPage: Int64, columns: Array<ColumnInfo>, sql: String, rowidAliasColumn: Int64,
        autoincrement: Bool, primaryKeyColumns: Array<Int64>, checks: Array<Expr>, foreignKeys: Array<ForeignKeyInfo>) {
        this.name = name
        this.rootPage = rootPage
        this.columns = columns
        this.sql = sql
        this.rowidAliasColumn = rowidAliasColumn
        this.autoincrement = autoincrement
        this.primaryKeyColumns = primaryKeyColumns
        this.checks = checks
        this.foreignKeys = foreignKeys
        this.columnDefaults = columnDefaultValues(columns)
    }

    func columnByName(colName: String): Option<ColumnInfo> {
        let lower = colName.toAsciiLower()
        for (c in columns) {
            if (c.name.toAsciiLower() == lower) {
                return Some(c)
            }
        }
        None
    }

    /** 列序号; 找不到返回 -1。 */
    func columnIndexOf(colName: String): Int64 {
        match (columnByName(colName)) {
            case Some(c) => c.index
            case None => -1
        }
    }
}

/**
 * 一个视图的运行期信息。
 *
 * 视图没有自己的 B-tree（sqlite_schema 中 rootpage 恒为 0），每次引用都展开并执行其 SELECT。
 * 视图不物化，因此同一语句中的后续读取可以看到该语句先前写入的数据。
 *
 * columnNames 是 `CREATE VIEW v(a,b) AS …` 写明的别名; 空表示没写, 列名由 body 的结果列决定。
 */
class ViewInfo {
    let name: String
    let columnNames: Array<String>
    let body: SelectStmt
    let sql: String

    init(name: String, columnNames: Array<String>, body: SelectStmt, sql: String) {
        this.name = name
        this.columnNames = columnNames
        this.body = body
        this.sql = sql
    }
}

/**
 * 一个触发器的运行期信息。
 *
 * body 是解析好的语句列表。存解析结果而不是每次重新解析文本: 触发器在每一行上都要触发,
 * 逐行重新词法+语法分析会让批量 DML 的代价翻几倍。
 *
 * updateColumns 是 `UPDATE OF a, b` 的列清单 (小写); 空表示不限列。
 */
class TriggerInfo {
    let name: String
    let timing: String
    let event: String
    let updateColumns: Array<String>
    let tableName: String
    let whenExpr: Option<Expr>
    let body: Array<Stmt>
    let sql: String

    init(name: String, timing: String, event: String, updateColumns: Array<String>, tableName: String,
        whenExpr: Option<Expr>, body: Array<Stmt>, sql: String) {
        this.name = name
        this.timing = timing
        this.event = event
        this.updateColumns = updateColumns
        this.tableName = tableName
        this.whenExpr = whenExpr
        this.body = body
        this.sql = sql
    }

    /**
     * 本触发器关心这次 UPDATE 改的列吗。
     *
     * `UPDATE OF v` 只在 `v` 出现在 SET 子句时触发；未写 OF 时任何被更新列都匹配。
     */
    func matchesUpdatedColumns(updated: HashSet<String>): Bool {
        if (updateColumns.size == 0) {
            return true
        }
        for (c in updateColumns) {
            if (updated.contains(c)) {
                return true
            }
        }
        false
    }
}

/** 由 CREATE TRIGGER 的 AST 造 TriggerInfo。建触发器与重载模式共用。 */
func triggerInfoFrom(stmt: CreateTriggerStmt, sql: String): TriggerInfo {
    let cols = Array<String>(stmt.updateColumns.size, repeat: "")
    for (i in 0..stmt.updateColumns.size) {
        cols[i] = stmt.updateColumns[i].toAsciiLower()
    }
    TriggerInfo(stmt.name, stmt.timing, stmt.event, cols, stmt.tableName, stmt.whenExpr, stmt.body.toArray(), sql)
}

/** 内存模式缓存。 */
class SchemaCache {
    let tables = HashMap<String, TableInfo>()
    let views = HashMap<String, ViewInfo>()
    /**
     * 全部触发器, 按 sqlite_schema 里的顺序。
     *
     * 用列表而不是按表名分组的 map: 同一个表上可以有多个触发器, 而触发顺序在 SQLite 里
     * 未规定 —— 保持读出来的顺序比按名字排序更接近"库里怎么存的"。
     */
    let triggers = ArrayList<TriggerInfo>()
    /** 记下加载时的 schema_cookie: 变了就说明别的连接改过模式, 要重载。 */
    var cookie: Int64 = -1

    init() {}

    func findTable(name: String): Option<TableInfo> {
        tables.get(name.toAsciiLower())
    }

    func findView(name: String): Option<ViewInfo> {
        views.get(name.toAsciiLower())
    }

    /** 表或视图任一存在。建表/建视图的重名判定用它 —— 两者共用一个名字空间。 */
    func nameExists(name: String): Bool {
        let lower = name.toAsciiLower()
        tables.contains(lower) || views.contains(lower)
    }

    /**
     * 某个表/视图上、某个时机与事件的触发器。
     *
     * UPDATE 时按 updated 过滤 `UPDATE OF` 的列清单。过滤放在这里而不是各调用点: 三条 DML
     * 路径都要这份清单, 各自过滤会让其中一条漏掉 OF 判定 —— 表现是那条路径上的触发器
     * 对任何列改动都触发。
     */
    /**
     * 这个表/视图上有任何触发器吗。
     *
     * 供 DML 的快速判断: 没有触发器时跳过"重读该行"那一步。绝大多数库一个触发器都没有,
     * 而那一步是一次额外的 B-tree 查找。
     */
    func hasTriggersOn(target: String): Bool {
        let lower = target.toAsciiLower()
        for (tr in triggers) {
            if (tr.tableName.toAsciiLower() == lower) {
                return true
            }
        }
        false
    }

    func triggersFor(target: String, timing: String, event: String, updated: HashSet<String>): ArrayList<TriggerInfo> {
        let lower = target.toAsciiLower()
        let out = ArrayList<TriggerInfo>()
        for (tr in triggers) {
            if (tr.tableName.toAsciiLower() != lower || tr.timing != timing || tr.event != event) {
                continue
            }
            if (event == TRIGGER_EVENT_UPDATE && !tr.matchesUpdatedColumns(updated)) {
                continue
            }
            out.add(tr)
        }
        out
    }

    func findIndex(name: String): Option<IndexInfo> {
        let lower = name.toAsciiLower()
        for ((_, t) in tables) {
            for (ix in t.indexes) {
                if (ix.name.toAsciiLower() == lower) {
                    return Some(ix)
                }
            }
        }
        None
    }

    func allTableNames(): ArrayList<String> {
        let out = ArrayList<String>()
        for ((_, t) in tables) {
            out.add(t.name)
        }
        sort(out)
        out
    }

    /**
     * 引用了 parentName 的所有外键 (即"谁是我的子表")。
     *
     * 删父行或改父键时要顺着这份清单查子行。每次现算而不是建常驻反向索引: 外键声明是
     * 模式的一部分, 模式变了反向索引就要跟着失效, 而表的张数是个位数到几十的量级 ——
     * 现算的代价远小于维护两份可能不一致的数据。
     */
    func foreignKeysReferencing(parentName: String): ArrayList<ForeignKeyInfo> {
        let lower = parentName.toAsciiLower()
        let out = ArrayList<ForeignKeyInfo>()
        for (name in allTableNames()) {
            match (tables.get(name.toAsciiLower())) {
                case None => ()
                case Some(t) => for (fk in t.foreignKeys) {
                    if (fk.parentTable.toAsciiLower() == lower) {
                        out.add(fk)
                    }
                }
            }
        }
        out
    }
}

/** sqlite_schema 里的一行原始形态。 */
class SchemaRow {
    let objType: String
    let name: String
    let tblName: String
    let rootPage: Int64
    let sql: String
    let rowid: Int64

    init(objType: String, name: String, tblName: String, rootPage: Int64, sql: String, rowid: Int64) {
        this.objType = objType
        this.name = name
        this.tblName = tblName
        this.rootPage = rootPage
        this.sql = sql
        this.rowid = rowid
    }
}

/** 读出 sqlite_schema 的全部行。 */
func readSchemaRows(pager: Pager): ArrayList<SchemaRow> {
    let out = ArrayList<SchemaRow>()
    let entries = collectTableEntries(pager, SCHEMA_ROOT_PAGE)
    for (e in entries) {
        let vals = decodeRecord(e.payload, SCHEMA_COLUMN_COUNT)
        out.add(
            SchemaRow(valueToText(vals[0]), valueToText(vals[1]), valueToText(vals[2]), valueToInt(vals[3]),
                valueToText(vals[4]), e.rowid))
    }
    out
}

/**
 * 从 sqlite_schema 重建内存模式。
 *
 * 三类对象都真加载: 表、索引、视图、触发器。视图与触发器的 body 是靠重新解析存下来的 SQL
 * 得到的, 与表的列信息同一条路径 —— 模式的唯一权威来源是那段 SQL 文本。
 *
 * 视图/触发器的 body 解析失败时**跳过那一条而不是让整个 loadSchema 抛**: 库里可能有 SQLite
 * 建的、用到我们不支持的语法的视图, 而那不该让整个库打不开。用到它的查询会在引用点报
 * "no such table", 所以不会静默返回错结果。
 */
func loadSchema(pager: Pager): SchemaCache {
    let cache = SchemaCache()
    let rows = readSchemaRows(pager)
    // 先建表, 再挂索引 —— 索引要按列名找表里的列序号。
    for (row in rows) {
        if (row.objType != "table") {
            continue
        }
        if (row.name.toAsciiLower().startsWith("sqlite_")) {
            // 内部表 (如 sqlite_sequence) 不进用户模式, 但它的根页要认得, 见 sequenceRootPage。
            continue
        }
        let info = buildTableInfo(row)
        cache.tables[info.name.toAsciiLower()] = info
    }
    for (row in rows) {
        if (row.objType != "index") {
            continue
        }
        match (cache.tables.get(row.tblName.toAsciiLower())) {
            case Some(table) => table.indexes.add(buildIndexInfo(row, table))
            case None => ()
        }
    }
    for (row in rows) {
        if (row.objType != "view" || row.sql.isEmpty()) {
            continue
        }
        match (buildViewInfo(row)) {
            case Some(v) => cache.views[v.name.toAsciiLower()] = v
            case None => ()
        }
    }
    for (row in rows) {
        if (row.objType != "trigger" || row.sql.isEmpty()) {
            continue
        }
        match (buildTriggerInfo(row)) {
            case Some(tr) => cache.triggers.add(tr)
            case None => ()
        }
    }
    cache.cookie = pager.header.schemaCookie
    cache
}

/** 解析存下来的 CREATE VIEW 文本。解析不了返回 None —— 见 loadSchema 的注释。 */
func buildViewInfo(row: SchemaRow): Option<ViewInfo> {
    let parsed = try {
        Parser(row.sql).parseStatement()
    } catch (_: SqliteSyntaxException) {
        return None
    }
    if (!(parsed is CreateViewStmt)) {
        return None
    }
    let stmt = (parsed as CreateViewStmt).getOrThrow()
    match (stmt.body) {
        case Some(b) => Some(ViewInfo(row.name, stmt.columnNames.toArray(), b, row.sql))
        case None => None
    }
}

/** 解析存下来的 CREATE TRIGGER 文本。解析不了返回 None。 */
func buildTriggerInfo(row: SchemaRow): Option<TriggerInfo> {
    let parsed = try {
        Parser(row.sql).parseStatement()
    } catch (_: SqliteSyntaxException) {
        return None
    }
    if (!(parsed is CreateTriggerStmt)) {
        return None
    }
    Some(triggerInfoFrom((parsed as CreateTriggerStmt).getOrThrow(), row.sql))
}

/** 解析 CREATE TABLE 文本重建列信息。 */
func buildTableInfo(row: SchemaRow): TableInfo {
    let stmt = try {
        let parsed = Parser(row.sql).parseStatement()
        if (parsed is CreateTableStmt) {
            (parsed as CreateTableStmt).getOrThrow()
        } else {
            throw SqliteFormatException("schema row for '${row.name}' is not a CREATE TABLE statement")
        }
    } catch (e: SqliteSyntaxException) {
        throw SqliteFormatException("cannot parse the stored DDL for table '${row.name}': ${e.message}")
    }
    tableInfoFromCreate(stmt, row.rootPage, row.sql)
}

/** 由 CREATE TABLE 的 AST 造 TableInfo。建表与重载模式共用。 */
func tableInfoFromCreate(stmt: CreateTableStmt, rootPage: Int64, sql: String): TableInfo {
    let checks = ArrayList<Expr>()
    // 表级主键约束先收集, 列级的在下面循环里补。
    let tablePkNames = ArrayList<String>()
    for (tc in stmt.constraints) {
        if (tc.kind == "primarykey") {
            for (c in tc.columns) {
                tablePkNames.add(c.toAsciiLower())
            }
        }
        if (tc.kind == "check") {
            if (let Some(e) <- tc.checkExpr) {
                checks.add(e)
            }
        }
    }
    let cols = ArrayList<ColumnInfo>()
    var rowidAlias = -1
    var autoinc = false
    for (i in 0..stmt.columns.size) {
        let def = stmt.columns[i]
        let inPk = def.primaryKey || tablePkNames.contains(def.name.toAsciiLower())
        // INTEGER PRIMARY KEY 是 rowid 的别名, 但只在**单列**主键且声明类型恰为 INTEGER 时成立。
        // "恰为 INTEGER": BIGINT 或 INT 都不算 —— 这是 SQLite 一个确定但常被误解的细节。
        // WITHOUT ROWID 表没有 rowid，该列是普通键列，记录按键值而不是插入顺序排列。
        let singleColumnPk = (def.primaryKey && tablePkNames.isEmpty()) || (tablePkNames.size == 1 &&
            tablePkNames.contains(def.name.toAsciiLower()))
        let isAlias = !stmt.withoutRowid && singleColumnPk && def.typeName.toAsciiUpper() == "INTEGER"
        if (isAlias) {
            rowidAlias = i
            if (def.autoincrement) {
                autoinc = true
            }
        }
        // WITHOUT ROWID 表的主键列**隐式 NOT NULL** (SQLite 报的是
        // `NOT NULL constraint failed`, 且 table_info 的 notnull 列显示 1)。rowid 表相反:
        // 那里主键允许 NULL, 甚至允许多行 NULL。
        let notNull = def.notNull || (stmt.withoutRowid && inPk)
        cols.add(
            ColumnInfo(def.name, def.typeName, notNull, collationByName(def.collation), def.defaultExpr, def.checkExpr,
                isAlias, i, inPk))
    }
    let fks = ArrayList<ForeignKeyInfo>()
    for (clause in stmt.allForeignKeys()) {
        fks.add(foreignKeyInfoFrom(stmt.name, clause, cols))
    }
    // 主键顺序是 PRIMARY KEY 子句的声明顺序, 不是表列顺序。省略父列名的外键会直接
    // 复用这份序列; `PRIMARY KEY(b,a)` 若按列序收集会把外键两列反过来匹配。
    let pkColumns = ArrayList<Int64>()
    var hasTablePrimaryKey = false
    for (tc in stmt.constraints) {
        if (tc.kind != "primarykey") {
            continue
        }
        hasTablePrimaryKey = true
        for (name in tc.columns) {
            let idx = columnIndexByName(cols.toArray(), name)
            if (idx >= 0 && !cols[idx].isRowidAlias && !pkColumns.contains(idx)) {
                pkColumns.add(idx)
            }
        }
    }
    if (!hasTablePrimaryKey) {
        for (col in cols) {
            if (col.inPrimaryKey && !col.isRowidAlias) {
                pkColumns.add(col.index)
            }
        }
    }
    let info = TableInfo(stmt.name, rootPage, cols.toArray(), sql, rowidAlias, autoinc, pkColumns.toArray(),
        checks.toArray(), fks.toArray())
    if (stmt.withoutRowid) {
        info.rowKey = Some(buildRowKeySpec(stmt, info.columns))
    }
    info
}

/**
 * 把语法层的外键子句解析成运行期信息。
 *
 * 子列名必须在本表里存在, 不存在就报 —— 一条指向不存在的列的外键永远不会被触发, 而
 * 声明它的人以为约束生效了。父列的存在性留到校验时查 (父表可以后建)。
 */
func foreignKeyInfoFrom(childTable: String, clause: ForeignKeyClause, cols: ArrayList<ColumnInfo>): ForeignKeyInfo {
    let idxs = Array<Int64>(clause.columns.size, repeat: -1)
    let names = Array<String>(clause.columns.size, repeat: "")
    for (i in 0..clause.columns.size) {
        let wanted = clause.columns[i].toAsciiLower()
        var found = -1
        for (c in cols) {
            if (c.name.toAsciiLower() == wanted) {
                found = c.index
                break
            }
        }
        if (found < 0) {
            throw SqliteRuntimeException("sql",
                "foreign key on table ${childTable} refers to unknown column ${clause.columns[i]}")
        }
        idxs[i] = found
        names[i] = clause.columns[i]
    }
    if (!clause.parentColumns.isEmpty() && clause.parentColumns.size != clause.columns.size) {
        throw SqliteRuntimeException("sql",
            "foreign key on table ${childTable} has ${clause.columns.size} columns but references ${clause.parentColumns.size}")
    }
    ForeignKeyInfo(childTable, idxs, names, clause.parentTable, clause.parentColumns.toArray(), clause.onDelete,
        clause.onUpdate, clause.deferred)
}

/** 解析 CREATE INDEX 文本重建索引信息。 */
func buildIndexInfo(row: SchemaRow, table: TableInfo): IndexInfo {
    // 自动索引 (UNIQUE 约束生成的) 在 sqlite_schema 里 sql 列是 NULL。它的列要从表的
    // UNIQUE 约束推回来 —— 名字里的序号指第几个 UNIQUE 约束。
    if (row.sql.isEmpty()) {
        return buildAutoIndexInfo(row, table)
    }
    let stmt = try {
        let parsed = Parser(row.sql).parseStatement()
        if (parsed is CreateIndexStmt) {
            (parsed as CreateIndexStmt).getOrThrow()
        } else {
            throw SqliteFormatException("schema row for index '${row.name}' is not a CREATE INDEX statement")
        }
    } catch (e: SqliteSyntaxException) {
        throw SqliteFormatException("cannot parse the stored DDL for index '${row.name}': ${e.message}")
    }
    indexInfoFromCreate(stmt, row.rootPage, table)
}

func indexInfoFromCreate(stmt: CreateIndexStmt, rootPage: Int64, table: TableInfo): IndexInfo {
    let idxs = Array<Int64>(stmt.columns.size, repeat: 0)
    let colls = Array<SqliteCollation>(stmt.columns.size, repeat: SqliteCollation.CollBinary)
    for (i in 0..stmt.columns.size) {
        let ci = table.columnIndexOf(stmt.columns[i])
        if (ci < 0) {
            throw SqliteRuntimeException("schema",
                "index '${stmt.name}' refers to column '${stmt.columns[i]}' which table '${table.name}' does not have")
        }
        idxs[i] = ci
        // 索引没写 COLLATE 时用列自己的 collation —— 不是恒定 BINARY。写错会让
        // NOCASE 列上的索引按字节序存, 于是查找命中不到 (且不报错)。
        colls[i] = if (stmt.collations[i] == "BINARY") {
            table.columns[ci].collation
        } else {
            collationByName(stmt.collations[i])
        }
    }
    IndexInfo(stmt.name, table.name, rootPage, stmt.unique, idxs, stmt.columns.toArray(), colls, stmt.descs.toArray(),
        stmt.whereExpr, false)
}

/**
 * 自动索引 (sqlite_autoindex_<table>_<n>) 的列从表的 UNIQUE 约束推回。
 *
 * SQLite 的编号规则: 按 CREATE TABLE 里出现顺序, 每个需要索引的 UNIQUE 约束 (含
 * 复合主键) 依次编号, 从 1 起。
 */
func buildAutoIndexInfo(row: SchemaRow, table: TableInfo): IndexInfo {
    let seq = autoIndexSequence(row.name)
    let specs = autoIndexSpecs(table)
    if (seq < 1 || seq > specs.size) {
        throw SqliteFormatException(
            "automatic index '${row.name}' has no matching UNIQUE constraint on table '${table.name}'")
    }
    let spec = specs[seq - 1]
    let cols = spec.columns
    let names = Array<String>(cols.size, repeat: "")
    for (i in 0..cols.size) {
        names[i] = table.columns[cols[i]].name
    }
    // descs 要照约束里写的来: `PRIMARY KEY(b DESC, a)` 的索引键序是降序的, 按全 ASC 建会让
    // 沿这个索引的扫描顺序与 SQLite 相反。
    IndexInfo(row.name, table.name, row.rootPage, true, cols, names, spec.collations, spec.descs, None, true)
}

func autoIndexSequence(indexName: String): Int64 {
    match (indexName.lastIndexOf("_")) {
        case Some(at) => try {
            parseDecimal(indexName[at + 1..indexName.size])
        } catch (_: Exception) {
            -1
        }
        case None => -1
    }
}

/** WITHOUT ROWID 表的主键自动索引名；它只用于内省，不在 sqlite_schema 中占一行。 */
func primaryKeyAutoIndexName(table: TableInfo): String {
    if (!table.withoutRowid) {
        return ""
    }
    let specs = autoIndexSpecs(table)
    for (i in 0..specs.size) {
        if (specs[i].primaryKey) {
            return "sqlite_autoindex_${table.name}_${i + 1}"
        }
    }
    ""
}

func automaticIndexOrigin(table: TableInfo, index: IndexInfo): String {
    if (!index.autoIndex) {
        return "c"
    }
    let seq = autoIndexSequence(index.name)
    let specs = autoIndexSpecs(table)
    if (seq >= 1 && seq <= specs.size && specs[seq - 1].primaryKey) {
        "pk"
    } else {
        "u"
    }
}

func parseDecimal(s: String): Int64 {
    if (s.isEmpty()) {
        throw SqliteFormatException("expected a decimal number")
    }
    var acc = 0
    for (b in s.toArray()) {
        if (b < UInt8(b'0') || b > UInt8(b'9')) {
            throw SqliteFormatException("'${s}' is not a decimal number")
        }
        acc = acc * 10 + Int64(b - UInt8(b'0'))
    }
    acc
}

/**
 * 表上需要自动索引的 UNIQUE 列组, 按 CREATE TABLE 里的出现顺序。
 *
 * 复合主键也算一组 (它需要一个 UNIQUE 索引); 单列 INTEGER PRIMARY KEY 不算 ——
 * 它就是 rowid, 表树自身保证唯一。
 */
/**
 * 一个需要自动索引的约束。
 *
 * primaryKey 这个标志有两处用途: 报唯一性冲突时的措辞, 以及 WITHOUT ROWID 表上"主键占掉
 * 一个序号但不写 sqlite_schema 行"这条规则 (那种表的主键就是表树本身)。
 */
class AutoIndexSpec {
    let columns: Array<Int64>
    let collations: Array<SqliteCollation>
    let descs: Array<Bool>
    let primaryKey: Bool

    init(columns: Array<Int64>, collations: Array<SqliteCollation>, descs: Array<Bool>, primaryKey: Bool) {
        this.columns = columns
        this.collations = collations
        this.descs = descs
        this.primaryKey = primaryKey
    }
}

/**
 * 需要自动索引的约束, **按 DDL 里的书写顺序**。
 *
 * 顺序决定 sqlite_autoindex_<表>_<N> 的编号，而该名称会写入 sqlite_schema。编号按约束的
 * 书写位置递增，主键与
 * UNIQUE 共用它: 列级约束按列序在前 (语法上列定义总在表级约束之前), 表级约束按约束序在后。
 * 例: `t(a INT UNIQUE, b TEXT PRIMARY KEY, c INT UNIQUE)` 得到 a=_1, b=_2, c=_3;
 * `t(a INT, b INT, c INT UNIQUE, PRIMARY KEY(b,a))` 得到 c=_1, (b,a)=_2。
 *
 * **单列非 INTEGER 主键必须在这里出现。** 它不是 rowid 别名, 表树的键管不到它, 唯一性
 * 全靠这个索引。漏掉它的后果不只是"重复主键被接受": sqlite_schema 里缺了那一行, SQLite
 * 打开这个库后，integrity_check、主键点查和 INSERT 都会报告数据库映像损坏。
 *
 * 反过来, INTEGER PRIMARY KEY (rowid 别名) **不占序号**: 它没有索引树。
 * 同一列同时声明 PRIMARY KEY 与 UNIQUE 时只创建主键所需的索引。
 */
func autoIndexSpecs(table: TableInfo): ArrayList<AutoIndexSpec> {
    let out = ArrayList<AutoIndexSpec>()
    let stmt = try {
        (Parser(table.sql).parseStatement() as CreateTableStmt).getOrThrow()
    } catch (_: Exception) {
        return out
    }
    for (i in 0..stmt.columns.size) {
        let def = stmt.columns[i]
        // rowid 别名不占序号; 主键与 UNIQUE 写在同一列上时只算主键那一个。
        if (def.primaryKey) {
            if (table.columns[i].isRowidAlias) {
                continue
            }
            out.add(AutoIndexSpec([Int64(i)], [table.columns[i].collation], [def.primaryKeyDesc], true))
        } else if (def.unique) {
            out.add(AutoIndexSpec([Int64(i)], [table.columns[i].collation], [false], false))
        }
    }
    for (tc in stmt.constraints) {
        if (tc.kind == "primarykey") {
            let cols = columnIndexesFor(table, tc.columns)
            if (cols.size == 1 && table.columns[cols[0]].isRowidAlias) {
                continue
            }
            out.add(AutoIndexSpec(cols, constraintCollations(tc, cols, table), constraintDescs(tc, cols.size), true))
        } else if (tc.kind == "unique") {
            let cols = columnIndexesFor(table, tc.columns)
            out.add(AutoIndexSpec(cols, constraintCollations(tc, cols, table), constraintDescs(tc, cols.size), false))
        }
    }
    out
}

/** 表级 PRIMARY KEY / UNIQUE 的 COLLATE, 未显式写时沿用列声明规则。 */
func constraintCollations(tc: TableConstraint, columns: Array<Int64>, table: TableInfo): Array<SqliteCollation> {
    let out = Array<SqliteCollation>(columns.size, repeat: SqliteCollation.CollBinary)
    for (i in 0..columns.size) {
        out[i] = if (i < tc.collations.size) {
            collationByName(tc.collations[i])
        } else {
            table.columns[columns[i]].collation
        }
    }
    out
}

/** 表级约束里逐列的 DESC 标志; 没写的按 ASC 补齐。 */
func constraintDescs(tc: TableConstraint, count: Int64): Array<Bool> {
    let out = Array<Bool>(count, repeat: false)
    for (i in 0..count) {
        if (i < tc.descs.size) {
            out[i] = tc.descs[i]
        }
    }
    out
}

func columnIndexesFor(table: TableInfo, names: ArrayList<String>): Array<Int64> {
    let out = Array<Int64>(names.size, repeat: 0)
    for (i in 0..names.size) {
        out[i] = table.columnIndexOf(names[i])
    }
    out
}
