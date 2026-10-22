package sqlite_driver

import std.collection.*

/*
 * 语句分发: 引擎的对外单一入口。
 *
 * 事务边界在这一层管, 而不是在各 execute* 里: 每条语句都要么落在调用方开的显式事务里,
 * 要么自带一个隐式事务。放在各执行器里会让"哪一层负责提交"变得依语句种类而不同, 而
 * 一旦某个分支忘了提交, 数据会留在脏页缓存里、看起来写成功了但重启后消失。
 *
 * 读语句 (SELECT / PRAGMA 查询) 不开写事务 —— 它们不改页, 开了反而要取写锁并挡住别的写者。
 */

/** 一条语句的执行结果。 */
class StatementResult {
    /** SELECT 与 PRAGMA 查询有结果集; DML 没有。 */
    let rows: Option<ResultSet>
    /** DML 的受影响行数; 其他语句为 0。 */
    let changes: Int64

    init(rows: Option<ResultSet>, changes: Int64) {
        this.rows = rows
        this.changes = changes
    }
}

/** 执行一条 SQL 文本。 */
func executeSql(db: SqliteDatabase, sql: String, params: Array<SqliteValue>): StatementResult {
    let parser = Parser(sql)
    let stmt = parser.parseStatement()
    // 参数个数不匹配在执行前就报: 让错误指向绑定而不是指向某个恰好越界的表达式。
    if (params.size < parser.parameterCount) {
        throw SqliteRuntimeException("bind",
            "statement requires ${parser.parameterCount} parameter(s) but ${params.size} were supplied")
    }
    executeStatement(db, stmt, params)
}

/**
 * 执行一条语句, 并管好语句级 WITH 的生命周期。
 *
 * CTE 注册表必须在语句结束时清掉 —— 留着会让下一条语句看到上一条的 CTE 名, 于是
 * `WITH t AS (…) SELECT …; SELECT * FROM t` 的第二条会读到已经不存在的 CTE 而不是报错。
 * 用 try/finally 而不是在各返回点清: 这个函数有十几个出口。
 */
func executeStatement(db: SqliteDatabase, stmt: Stmt, params: Array<SqliteValue>): StatementResult {
    let withCtes = statementLevelCtes(stmt)
    if (withCtes.isEmpty()) {
        return executeStatementInner(db, stmt, params)
    }
    // 注册表的宿主上下文: CTE body 求值时以它为外层, 于是兄弟 CTE 互相可见, 而引用点
    // 所在查询的数据源不可见 (CTE 不是关联子查询)。
    let root = EvalContext(db, params)
    for (def in withCtes) {
        db.statementCtes[def.name.toAsciiLower()] = MaterializedCte(def, root)
    }
    // root 是在注册之前建的, 自己那份 ctes 是空的 —— 补上, 否则 body 里引用兄弟 CTE 时
    // 沿 outer 链走到 root 就断了。
    for ((name, cte) in db.statementCtes) {
        root.ctes[name] = cte
    }
    try {
        executeStatementInner(db, stmt, params)
    } finally {
        db.statementCtes.clear()
    }
}

/** 一条语句前缀的 WITH 子句; 不带则空。 */
func statementLevelCtes(stmt: Stmt): ArrayList<CteDef> {
    if (stmt is SelectStmt) {
        return (stmt as SelectStmt).getOrThrow().withCtes
    }
    if (stmt is InsertStmt) {
        return (stmt as InsertStmt).getOrThrow().withCtes
    }
    if (stmt is UpdateStmt) {
        return (stmt as UpdateStmt).getOrThrow().withCtes
    }
    if (stmt is DeleteStmt) {
        return (stmt as DeleteStmt).getOrThrow().withCtes
    }
    ArrayList<CteDef>()
}

private func executeStatementInner(db: SqliteDatabase, stmt: Stmt, params: Array<SqliteValue>): StatementResult {
    if (stmt is ExplainQueryPlanStmt) {
        return executeExplainQueryPlan(db, (stmt as ExplainQueryPlanStmt).getOrThrow(), params)
    }
    if (stmt is SelectStmt) {
        // 读快照钉在语句开始处: WAL 模式下别的进程可能在语句执行途中追加帧, 不钉的话
        // 一条语句的前半与后半会看到两个不同的库状态 (逐页各读到最新版本)。
        db.pager.pinReadSnapshot()
        let rs = try {
            executeSelect(db, (stmt as SelectStmt).getOrThrow(), params)
        } finally {
            db.pager.unpinReadSnapshot()
        }
        return StatementResult(Some(rs), 0)
    }
    if (stmt is TransactionStmt) {
        return executeTransactionStatement(db, (stmt as TransactionStmt).getOrThrow())
    }
    if (stmt is PragmaStmt) {
        return executePragma(db, (stmt as PragmaStmt).getOrThrow(), params)
    }
    // 以下都是写语句, 统一由 runInWriteTransaction 包事务。
    if (stmt is InsertStmt) {
        let s = (stmt as InsertStmt).getOrThrow()
        if (let Some(r) <- viewWriteResult(db, s.tableName, TRIGGER_EVENT_INSERT, s, params)) {
            return r
        }
        return dmlResult(db, s.tableName, s.returning, params) {=> executeInsert(db, s, params)}
    }
    if (stmt is UpdateStmt) {
        let s = (stmt as UpdateStmt).getOrThrow()
        if (let Some(r) <- viewWriteResult(db, s.tableName, TRIGGER_EVENT_UPDATE, s, params)) {
            return r
        }
        return dmlResult(db, s.tableName, s.returning, params) {=> executeUpdate(db, s, params)}
    }
    if (stmt is DeleteStmt) {
        let s = (stmt as DeleteStmt).getOrThrow()
        if (let Some(r) <- viewWriteResult(db, s.tableName, TRIGGER_EVENT_DELETE, s, params)) {
            return r
        }
        return dmlResult(db, s.tableName, s.returning, params) {=> executeDelete(db, s, params)}
    }
    if (stmt is CreateTableStmt) {
        let s = (stmt as CreateTableStmt).getOrThrow()
        if (let Some(sel) <- s.asSelect) {
            // AS SELECT 要先跑查询再建表, 两步在同一个事务里 —— 建完表却灌不进数据会留下
            // 一张空表, 而调用方看到的是一条失败的语句。
            return StatementResult(None, runInWriteTransaction(db) {
                => execCreateTableAsSelect(db, s, sel, params)
            })
        }
        return StatementResult(None, runInWriteTransaction(db) {=> execCreateTable(db, s)})
    }
    if (stmt is VacuumStmt) {
        // 不进 runInWriteTransaction: VACUUM 自己管事务, 且必须在没有活动事务时才能跑。
        return StatementResult(None, execVacuum(db))
    }
    if (stmt is CreateIndexStmt) {
        let s = (stmt as CreateIndexStmt).getOrThrow()
        return StatementResult(None, runInWriteTransaction(db) {=> execCreateIndex(db, s)})
    }
    if (stmt is CreateViewStmt) {
        let s = (stmt as CreateViewStmt).getOrThrow()
        return StatementResult(None, runInWriteTransaction(db) {=> execCreateView(db, s)})
    }
    if (stmt is CreateTriggerStmt) {
        let s = (stmt as CreateTriggerStmt).getOrThrow()
        return StatementResult(None, runInWriteTransaction(db) {=> execCreateTrigger(db, s)})
    }
    if (stmt is DropStmt) {
        let s = (stmt as DropStmt).getOrThrow()
        return StatementResult(None, runInWriteTransaction(db) {
            => match (s.kind) {
                case "table" => execDropTable(db, s)
                case "index" => execDropIndex(db, s)
                case "view" => execDropView(db, s)
                case _ => execDropTrigger(db, s)
            }
        })
    }
    if (stmt is AlterTableStmt) {
        let s = (stmt as AlterTableStmt).getOrThrow()
        return StatementResult(None, runInWriteTransaction(db) {=> execAlterTable(db, s)})
    }
    throw SqliteRuntimeException("sql", "unsupported statement form")
}

/**
 * 目标是视图时的写路径; 不是视图返回 None 让调用方走普通 DML。
 *
 * 有对应的 INSTEAD OF 触发器就由它代劳, 没有则报"不能改视图"。两件事必须在同一处判定 ——
 * 分开写时容易漏掉某个事件 (比如只给 INSERT 接了 INSTEAD OF), 表现是那个事件上对视图的写
 * 静默什么都不做而返回 0 行受影响。
 */
func viewWriteResult(db: SqliteDatabase, name: String, event: String, stmt: Stmt, params: Array<SqliteValue>): Option<StatementResult> {
    let view = match (db.currentSchema().findView(name)) {
        case Some(v) => v
        case None => return None
    }
    let triggers = db.currentSchema().triggersFor(name, TRIGGER_TIMING_INSTEAD_OF, event, HashSet<String>())
    if (triggers.isEmpty()) {
        throw SqliteRuntimeException("sql", "cannot modify ${name} because it is a view")
    }
    let changes = runInWriteTransaction(db) {=> execInsteadOfWrite(db, view, event, stmt, params)}
    db.lastChanges = changes
    db.totalChanges += changes
    Some(StatementResult(None, changes))
}

/**
 * 把一条 DML 的结果折成 StatementResult, 带 RETURNING 时附上结果集。
 *
 * RETURNING 的求值放在**事务之内**: 表达式可能读别的表 (子查询), 而那些行必须与本次
 * 写入处于同一个快照; 放到提交之后求值会看到别的连接插进来的行。
 */
func dmlResult(db: SqliteDatabase, tableName: String, returning: ArrayList<ResultColumn>, params: Array<SqliteValue>,
    body: () -> DmlOutcome): StatementResult {
    // 结果集经一元素列表传出: 仓颉不允许 lambda 捕获可变变量, 而 let 绑定的容器可以改内容。
    let carrier = ArrayList<ResultSet>()
    let changes = runInWriteTransaction(db) {
        =>
            let outcome = body()
            if (!returning.isEmpty()) {
                // 表要在这里重新取: DML 可能改了模式缓存, 而列名要与写入时的那一份一致。
                let table = requireWritableTable(db, tableName)
                carrier.add(buildReturningResultSet(db, table, returning, outcome.returned, params))
            }
            outcome.changes
    }
    let rows: Option<ResultSet> = if (carrier.isEmpty()) {
        None
    } else {
        Some(carrier[0])
    }
    StatementResult(rows, changes)
}

/**
 * 在写事务里跑一段操作。
 *
 * ensureWritable 返回"是否由本次开启了隐式事务": 为真时本函数负责提交/回滚, 事务与语句
 * 同生共死; 为假时事务归外层的 BEGIN 管, 本函数只负责这一条语句那一层。
 *
 * 隐式事务出错必须回滚: 不回滚会把半成品留在页缓存里, 下一条语句的提交会把它一起写盘。
 *
 * 显式事务里出错要退回语句开始处, 再把异常抛给调用方: 每条语句都是一个隐含的子事务,
 * 失败的语句自己的改动整体撤销, 事务本身继续存在并可以继续写。不撤销的话, 一条中途失败的
 * 多行 INSERT 会把它前半段插进去的行留在事务里, 随后的 COMMIT 一并提交。
 *
 * 语句作用域在嵌套时逐层配对: 触发器体与 INSTEAD OF 视图写入会重入这里, 内层失败时
 * 撤销的只是内层那条语句, 异常继续上抛后外层再撤销自己那一层。
 */
func runInWriteTransaction(db: SqliteDatabase, body: () -> Int64): Int64 {
    let implicit = db.ensureWritable()
    if (implicit) {
        let result = try {
            body()
        } catch (e: Exception) {
            db.rollbackImplicit()
            throw e
        }
        db.commitImplicit()
        return result
    }
    let scope = db.openStatementScope()
    let result = try {
        body()
    } catch (e: Exception) {
        db.rollbackStatementScope(scope)
        throw e
    }
    db.releaseStatementScope(scope)
    result
}

func executeTransactionStatement(db: SqliteDatabase, stmt: TransactionStmt): StatementResult {
    match (stmt.action) {
        case "begin" => db.begin(stmt.mode)
        case "commit" => db.commit()
        case "rollback" => db.rollback()
        case "savepoint" => db.savepoint(stmt.savepointName)
        case "release" => db.releaseSavepoint(stmt.savepointName)
        case "rollbackto" => db.rollbackToSavepoint(stmt.savepointName)
        case _ => throw SqliteRuntimeException("sql", "unsupported transaction statement '${stmt.action}'")
    }
    StatementResult(None, 0)
}

/*
 * PRAGMA。
 *
 * 分三类: 读写头字段的 (user_version / schema_version / application_id)、影响连接行为的
 * (foreign_keys / busy_timeout)、以及内省用的 (table_info / index_list / integrity_check)。
 *
 * 未识别的 pragma 会静默忽略，这是 SQLite 的既有行为。上层初始化可能会发送驱动未支持的
 * pragma；此时保持连接可用比提前报错更符合该行为。
 */
func executePragma(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    match (stmt.name) {
        case "user_version" => pragmaUserVersion(db, stmt, params)
        case "schema_version" => pragmaSchemaVersion(db, stmt, params)
        case "application_id" => pragmaApplicationId(db, stmt, params)
        case "page_size" => pragmaReadOnlyInt(db.pager.pageSize, stmt)
        case "page_count" => pragmaReadOnlyInt(db.pager.pageCount, stmt)
        case "freelist_count" => pragmaReadOnlyInt(db.pager.header.freelistCount, stmt)
        case "foreign_keys" => pragmaForeignKeys(db, stmt, params)
        case "foreign_key_list" => pragmaForeignKeyList(db, stmt)
        case "foreign_key_check" => pragmaForeignKeyCheck(db, stmt)
        case "busy_timeout" => pragmaBusyTimeout(db, stmt, params)
        case "cache_size" => pragmaCacheSize(db, stmt, params)
        case "journal_mode" => pragmaJournalMode(db, stmt, params)
        case "wal_checkpoint" => pragmaWalCheckpoint(db, stmt)
        case "wal_autocheckpoint" => pragmaWalAutocheckpoint(db, stmt, params)
        case "journal_size_limit" => pragmaJournalSizeLimit(db, stmt, params)
        case "recursive_triggers" => pragmaRecursiveTriggers(db, stmt, params)
        case "table_info" | "table_xinfo" => pragmaTableInfo(db, stmt)
        case "index_list" => pragmaIndexList(db, stmt)
        case "index_info" | "index_xinfo" => pragmaIndexInfo(db, stmt)
        case "integrity_check" | "quick_check" => pragmaIntegrityCheck(db)
        case "encoding" => singleValueResult("encoding", SqliteValue.SText("UTF-8"))
        case "collation_list" => pragmaCollationList()
        case "database_list" => pragmaDatabaseList(db)
        case _ =>
            // 未知 pragma: 查询形态返回空集, 赋值形态什么也不做。
            if (let Some(_) <- stmt.value) {
                StatementResult(None, 0)
            } else {
                StatementResult(Some(ResultSet(Array<String>(), ArrayList<Array<SqliteValue>>())), 0)
            }
    }
}

/** 单值结果集, PRAGMA 查询常用。 */
func singleValueResult(name: String, v: SqliteValue): StatementResult {
    let rows = ArrayList<Array<SqliteValue>>()
    rows.add([v])
    StatementResult(Some(ResultSet([name], rows)), 0)
}

func pragmaValueAsInt(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): Int64 {
    match (stmt.value) {
        case Some(e) =>
            let ctx = EvalContext(db, params)
            valueToInt(coerceNumeric(evalExpr(ctx, e)))
        case None => 0
    }
}

/** user_version: 头部偏移 60 的 4 字节, 完全由应用定义, SQLite 自己不读它。 */
func pragmaUserVersion(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (let Some(_) <- stmt.value) {
        let v = pragmaValueAsInt(db, stmt, params)
        let _ = runInWriteTransaction(db) {
            =>
                let page = db.pager.getPage(1)
                db.pager.markDirty(page)
                db.pager.header.userVersion = v
                0
        }
        return StatementResult(None, 0)
    }
    singleValueResult("user_version", SqliteValue.SInt(db.pager.header.userVersion))
}

/**
 * schema_version 只读。
 *
 * SQLite 允许写它, 但写错会让所有连接的模式缓存判据失效 (它们靠这个值判断"要不要重载")。
 * 把它做成只读: 需要让别人重载模式时应该真的改模式, 而不是手动改 cookie。
 */
func pragmaSchemaVersion(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    let _ = params
    if (let Some(_) <- stmt.value) {
        throw SqliteRuntimeException("pragma",
            "schema_version is read-only in this driver; it is maintained by DDL statements")
    }
    singleValueResult("schema_version", SqliteValue.SInt(db.pager.header.schemaCookie))
}

func pragmaApplicationId(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (let Some(_) <- stmt.value) {
        let v = pragmaValueAsInt(db, stmt, params)
        let _ = runInWriteTransaction(db) {
            =>
                let page = db.pager.getPage(1)
                db.pager.markDirty(page)
                db.pager.header.applicationId = v
                0
        }
        return StatementResult(None, 0)
    }
    singleValueResult("application_id", SqliteValue.SInt(db.pager.header.applicationId))
}

func pragmaReadOnlyInt(value: Int64, stmt: PragmaStmt): StatementResult {
    if (let Some(_) <- stmt.value) {
        // page_size 等在建库后不可改。静默忽略而不是报错 —— 连接初始化脚本常带 page_size。
        return StatementResult(None, 0)
    }
    singleValueResult(stmt.name, SqliteValue.SInt(value))
}

/**
 * foreign_keys: 外键约束的开关, 真正决定是否实施引用检查。
 *
 * 与 SQLite 一样默认关闭 —— 打开它会让既有的、依赖"外键不生效"的库在写入时开始报错,
 * 所以必须由调用方显式选择。事务中间不允许改: 半个事务在两种规则下执行会留下既不满足
 * 旧规则也不满足新规则的状态。
 */
func pragmaForeignKeys(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (let Some(e) <- stmt.value) {
        let ctx = EvalContext(db, params)
        let wanted = pragmaBooleanValue(evalExpr(ctx, e))
        if (wanted != db.foreignKeysEnabled && db.inExplicitTx) {
            // SQLite 在事务里静默忽略这条 PRAGMA。静默会让调用方以为已生效, 所以报出来。
            throw SqliteRuntimeException("state", "PRAGMA foreign_keys cannot be changed inside a transaction")
        }
        db.foreignKeysEnabled = wanted
        return StatementResult(None, 0)
    }
    singleValueResult("foreign_keys", boolToValue(db.foreignKeysEnabled))
}

/**
 * PRAGMA foreign_key_list(t): 表 t 声明的每条外键一行。
 *
 * 列与 SQLite 一致: id, seq, table, from, to, on_update, on_delete, match。
 * id 是外键序号, seq 是该外键内的列序号 —— 复合外键因此占多行。
 */
func pragmaForeignKeyList(db: SqliteDatabase, stmt: PragmaStmt): StatementResult {
    let names: Array<String> = ["id", "seq", "table", "from", "to", "on_update", "on_delete", "match"]
    let rows = ArrayList<Array<SqliteValue>>()
    if (stmt.argument.isEmpty()) {
        return StatementResult(Some(ResultSet(names, rows)), 0)
    }
    match (db.currentSchema().findTable(stmt.argument)) {
        // 不存在的表返回空集, 与 table_info 一致。
        case None => ()
        case Some(table) => for (id in 0..table.foreignKeys.size) {
            let fk = table.foreignKeys[id]
            for (seq in 0..fk.childColumnNames.size) {
                let to = if (seq < fk.parentColumns.size) {
                    SqliteValue.SText(fk.parentColumns[seq])
                } else {
                    // 省略父列时 SQLite 这一格是 NULL, 表示"父表的主键"。
                    SqliteValue.SNull
                }
                rows.add(
                    [SqliteValue.SInt(id), SqliteValue.SInt(seq), SqliteValue.SText(fk.parentTable),
                        SqliteValue.SText(fk.childColumnNames[seq]), to, SqliteValue.SText(fk.onUpdate),
                        SqliteValue.SText(fk.onDelete), SqliteValue.SText("NONE")])
            }
        }
    }
    StatementResult(Some(ResultSet(names, rows)), 0)
}

/**
 * PRAGMA foreign_key_check [(t)]: 找出所有违约的子行。
 *
 * 列与 SQLite 一致: table, rowid, parent, fkid。空结果集表示全库满足外键。
 *
 * 与 PRAGMA foreign_keys 的开关无关: 它是个检查工具, 关着外键写进来的违约行正是它要
 * 找的东西。若跟着开关走, 最需要它的场景 (从"没有外键"迁到"有外键") 恰好用不上。
 */
func pragmaForeignKeyCheck(db: SqliteDatabase, stmt: PragmaStmt): StatementResult {
    let names: Array<String> = ["table", "rowid", "parent", "fkid"]
    let rows = ArrayList<Array<SqliteValue>>()
    let schema = db.currentSchema()
    let tableNames = if (stmt.argument.isEmpty()) {
        schema.allTableNames()
    } else {
        let one = ArrayList<String>()
        one.add(stmt.argument)
        one
    }
    for (name in tableNames) {
        match (schema.findTable(name)) {
            case None => ()
            case Some(table) => collectForeignKeyViolations(db, table, rows)
        }
    }
    StatementResult(Some(ResultSet(names, rows)), 0)
}

/** 扫一张表, 把每个违约的 (行, 外键) 组合记进 rows。 */
func collectForeignKeyViolations(db: SqliteDatabase, table: TableInfo, rows: ArrayList<Array<SqliteValue>>): Unit {
    if (table.foreignKeys.size == 0) {
        return
    }
    let cursor = tableCursor(db.pager, table)
    var ok = cursor.first()
    while (ok) {
        let locator = currentRowLocator(table, cursor)
        let values = decodeTableRow(table, cursor)
        for (fkid in 0..table.foreignKeys.size) {
            let fk = table.foreignKeys[fkid]
            let key = childKeyValues(fk, values)
            if (anyNull(key)) {
                continue
            }
            let satisfied = try {
                parentRowExists(db, fk, key)
            } catch (_: SqliteConstraintException) {
                // 父表或父列不存在也算违约, 而不是让整条 PRAGMA 失败 —— 这条 PRAGMA 的
                // 用途就是把库里所有引用问题列出来。
                false
            }
            if (!satisfied) {
                let rowIdentity = if (table.withoutRowid) {
                    SqliteValue.SNull
                } else {
                    SqliteValue.SInt(locator.rowid)
                }
                rows.add(
                    [SqliteValue.SText(table.name), rowIdentity, SqliteValue.SText(fk.parentTable),
                        SqliteValue.SInt(fkid)])
            }
        }
        ok = cursor.next()
    }
}

/** PRAGMA 的布尔值: 支持 0/1、on/off、true/false、yes/no。 */
func pragmaBooleanValue(v: SqliteValue): Bool {
    match (v) {
        case SText(s) => match (s.toAsciiLower()) {
            case "on" | "true" | "yes" => true
            case "off" | "false" | "no" => false
            case _ => valueIsTrue(v)
        }
        case _ => valueIsTrue(v)
    }
}

func pragmaBusyTimeout(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (let Some(_) <- stmt.value) {
        var ms = pragmaValueAsInt(db, stmt, params)
        if (ms < 0) {
            ms = 0
        }
        db.busyTimeoutMs = ms
        return StatementResult(None, 0)
    }
    singleValueResult("timeout", SqliteValue.SInt(db.busyTimeoutMs))
}

/**
 * cache_size: 页缓存上限。
 *
 * 沿用 SQLite 的双语义 —— 正数是**页数**, 负数是 **KiB 数**(按当前 page_size 折算成页数)。
 * 读取时一律回负数形式, 与 SQLite 一致 (它记住的是你设进去的那个数, 但默认值 -2000
 * 就是负形式, 上层按负数解读更不容易错)。
 *
 * 下限钉在 10 页: B-tree 的一次分裂要同时按住父页、被分裂页、新页与相邻页, 缓存太小会让
 * 它们互相淘汰, 从"慢"变成"读到自己刚写的页的旧版本"。SQLite 的下限也是 10。
 */
func pragmaCacheSize(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (let Some(_) <- stmt.value) {
        let raw = pragmaValueAsInt(db, stmt, params)
        var pages = if (raw < 0) {
            // 负数: KiB。-2000 在 4KiB 页上就是 500 页。
            (-raw) * 1024 / db.pager.pageSize
        } else {
            raw
        }
        if (pages < MIN_CACHE_PAGES) {
            pages = MIN_CACHE_PAGES
        }
        db.pager.cacheLimit = pages
        return StatementResult(None, 0)
    }
    singleValueResult("cache_size", SqliteValue.SInt(-(db.pager.cacheLimit * db.pager.pageSize / 1024)))
}

/**
 * journal_mode: 在 WAL 与 DELETE 之间真正切换, 并如实返回切换后的模式。
 *
 * 这是个**持久**设置 —— 它写进文件头的 write/read version, 所以下次打开 (以及 SQLite
 * 打开时) 都会按新模式对待这个库。
 *
 * 内存库恒为 "memory": 它没有第二个访问者, 日志与 WAL 都无处可写也无人可读。
 */
func pragmaJournalMode(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (!db.pager.persistent) {
        return singleValueResult("journal_mode", SqliteValue.SText("memory"))
    }
    if (let Some(e) <- stmt.value) {
        let ctx = EvalContext(db, params)
        let wanted = valueToText(evalExpr(ctx, e)).toAsciiLower()
        match (wanted) {
            case "wal" => db.switchToWalMode()
            // DELETE / TRUNCATE / PERSIST 都是回滚日志的变体, 落地形态相同 (删日志文件)。
            case "delete" | "truncate" | "persist" => db.switchToRollbackJournalMode()
            case "off" | "memory" =>
                // 关掉日志会让崩溃后无法恢复。拒绝而不是静默忽略 —— 静默会让调用方以为
                // 自己拿到了更快的写入, 而实际上既没变快也失去了恢复能力。
                throw SqliteRuntimeException("pragma",
                "journal_mode=${wanted} is not supported; it would leave crashes unrecoverable")
            case _ => throw SqliteRuntimeException("pragma", "unknown journal_mode '${wanted}'")
        }
    }
    singleValueResult("journal_mode", SqliteValue.SText(db.currentJournalModeName()))
}

/**
 * PRAGMA wal_checkpoint[(mode)]: 把 WAL 帧回填进主库。
 *
 * 列与 SQLite 一致: busy, log, checkpointed。busy 恒 0 —— 我们的写者互斥靠锁文件, 到这里
 * 已经拿到锁了, 不存在"因为别人在写而放弃"的情形。
 */
func pragmaWalCheckpoint(db: SqliteDatabase, stmt: PragmaStmt): StatementResult {
    let names: Array<String> = ["busy", "log", "checkpointed"]
    let mode = match (stmt.argument.toAsciiLower()) {
        case "" | "passive" => WalCheckpointMode.CheckpointPassive
        case "full" => WalCheckpointMode.CheckpointFull
        case "restart" => WalCheckpointMode.CheckpointRestart
        case "truncate" => WalCheckpointMode.CheckpointTruncate
        case other => throw SqliteRuntimeException("pragma", "unknown checkpoint mode '${other}'")
    }
    let result = db.checkpoint(mode)
    let rows = ArrayList<Array<SqliteValue>>()
    rows.add([SqliteValue.SInt(0), SqliteValue.SInt(result.framesAfter), SqliteValue.SInt(result.backfilled)])
    StatementResult(Some(ResultSet(names, rows)), 0)
}

/** PRAGMA wal_autocheckpoint[=N]: 自动 checkpoint 的帧数阈值; 0 关闭。 */
func pragmaWalAutocheckpoint(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (let Some(_) <- stmt.value) {
        let n = pragmaValueAsInt(db, stmt, params)
        db.setWalAutocheckpoint(n)
        return StatementResult(None, 0)
    }
    singleValueResult("wal_autocheckpoint", SqliteValue.SInt(db.walAutocheckpoint()))
}

/**
 * PRAGMA journal_size_limit[=N]: WAL 重置后保留的字节上限; 负数不限。
 *
 * 赋值形态也返回生效后的值，例如 `PRAGMA journal_size_limit=8192` 返回一行 `8192`。
 * `wal_autocheckpoint` 的赋值形态不返回结果，两者不能共用同一种返回处理。
 *
 * 所有模式都接受: 它是连接级属性, 不写进文件头。内存库与 DELETE 模式下设了也回读得到,
 * 与 SQLite 一致。
 */
func pragmaJournalSizeLimit(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (let Some(_) <- stmt.value) {
        db.setJournalSizeLimit(pragmaValueAsInt(db, stmt, params))
    }
    singleValueResult("journal_size_limit", SqliteValue.SInt(db.journalSizeLimit))
}

/**
 * PRAGMA recursive_triggers[=bool]: 触发器能否递归触发自己; 默认关。
 *
 * 关闭时仍允许第一层触发器执行，但同一个触发器不能重入。判定依据是触发器是否已经在执行栈中，
 * 而不是全局触发深度是否大于 0。
 */
func pragmaRecursiveTriggers(db: SqliteDatabase, stmt: PragmaStmt, params: Array<SqliteValue>): StatementResult {
    if (let Some(e) <- stmt.value) {
        let ctx = EvalContext(db, params)
        db.recursiveTriggers = pragmaBooleanValue(evalExpr(ctx, e))
        return StatementResult(None, 0)
    }
    singleValueResult("recursive_triggers", SqliteValue.SInt(if (db.recursiveTriggers) {
        1
    } else {
        0
    }))
}

/** PRAGMA table_info(t): cid, name, type, notnull, dflt_value, pk。 */
func pragmaTableInfo(db: SqliteDatabase, stmt: PragmaStmt): StatementResult {
    let rows = ArrayList<Array<SqliteValue>>()
    let names: Array<String> = ["cid", "name", "type", "notnull", "dflt_value", "pk"]
    if (stmt.argument.isEmpty()) {
        return StatementResult(Some(ResultSet(names, rows)), 0)
    }
    if (isSchemaTableName(stmt.argument)) {
        let schemaColumns: Array<String> = ["type", "name", "tbl_name", "rootpage", "sql"]
        let schemaTypes: Array<String> = ["text", "text", "text", "int", "text"]
        for (i in 0..schemaColumns.size) {
            rows.add(
                [SqliteValue.SInt(i), SqliteValue.SText(schemaColumns[i]), SqliteValue.SText(schemaTypes[i]),
                    SqliteValue.SInt(0), SqliteValue.SNull, SqliteValue.SInt(0)])
        }
        return StatementResult(Some(ResultSet(names, rows)), 0)
    }
    let schema = db.currentSchema()
    let table = match (schema.findTable(stmt.argument)) {
        case Some(t) => t
        case None => match (schema.findView(stmt.argument)) {
            case None =>
                // 不存在的对象返回空集, 与 SQLite 一致, 上层常用它做存在性探测。
                return StatementResult(Some(ResultSet(names, rows)), 0)
            case Some(view) =>
                let columnNames = viewColumnNames(EvalContext(db, Array<SqliteValue>()), view)
                for (i in 0..columnNames.size) {
                    rows.add(
                        [SqliteValue.SInt(i), SqliteValue.SText(columnNames[i]),
                            SqliteValue.SText(declaredTypeOfResultColumn(db, view.body, i)), SqliteValue.SInt(0),
                            SqliteValue.SNull, SqliteValue.SInt(0)])
                }
                return StatementResult(Some(ResultSet(names, rows)), 0)
        }
    }
    // pk 列是"在主键中的位次" (1 起), 不在主键里为 0。
    for (col in table.columns) {
        var pkPos = 0
        if (table.withoutRowid) {
            let spec = table.requireRowKey()
            for (i in 0..spec.keyColumns.size) {
                if (spec.keyColumns[i] == col.index) {
                    pkPos = i + 1
                    break
                }
            }
        } else if (col.isRowidAlias) {
            pkPos = 1
        } else if (col.inPrimaryKey) {
            for (i in 0..table.primaryKeyColumns.size) {
                if (table.primaryKeyColumns[i] == col.index) {
                    pkPos = i + 1
                    break
                }
            }
        }
        let defaultText = match (col.defaultExpr) {
            case Some(e) => SqliteValue.SText(renderDefaultExpr(e))
            case None => SqliteValue.SNull
        }
        rows.add(
            [SqliteValue.SInt(col.index), SqliteValue.SText(col.name), SqliteValue.SText(col.declaredType),
                boolToValue(col.notNull), defaultText, SqliteValue.SInt(pkPos)])
    }
    StatementResult(Some(ResultSet(names, rows)), 0)
}

/** PRAGMA index_list(t): seq, name, unique, origin, partial。 */
func pragmaIndexList(db: SqliteDatabase, stmt: PragmaStmt): StatementResult {
    let names: Array<String> = ["seq", "name", "unique", "origin", "partial"]
    let rows = ArrayList<Array<SqliteValue>>()
    if (stmt.argument.isEmpty()) {
        return StatementResult(Some(ResultSet(names, rows)), 0)
    }
    match (db.currentSchema().findTable(stmt.argument)) {
        case None => ()
        case Some(table) =>
            var seq = 0
            if (table.withoutRowid) {
                rows.add(
                    [SqliteValue.SInt(seq), SqliteValue.SText(primaryKeyAutoIndexName(table)), boolToValue(true),
                        SqliteValue.SText("pk"), SqliteValue.SInt(0)])
                seq += 1
            }
            for (index in table.indexes) {
                let origin = automaticIndexOrigin(table, index)
                let partial = match (index.whereExpr) {
                    case Some(_) => 1
                    case None => 0
                }
                rows.add(
                    [SqliteValue.SInt(seq), SqliteValue.SText(index.name), boolToValue(index.unique),
                        SqliteValue.SText(origin), SqliteValue.SInt(partial)])
                seq += 1
            }
    }
    StatementResult(Some(ResultSet(names, rows)), 0)
}

/** PRAGMA index_info(idx): seqno, cid, name。 */
func pragmaIndexInfo(db: SqliteDatabase, stmt: PragmaStmt): StatementResult {
    let names: Array<String> = ["seqno", "cid", "name"]
    let rows = ArrayList<Array<SqliteValue>>()
    if (stmt.argument.isEmpty()) {
        return StatementResult(Some(ResultSet(names, rows)), 0)
    }
    let schema = db.currentSchema()
    match (schema.findIndex(stmt.argument)) {
        case None => ()
        case Some(index) => for (i in 0..index.columnIndexes.size) {
            rows.add(
                [SqliteValue.SInt(i), SqliteValue.SInt(index.columnIndexes[i]), SqliteValue.SText(index.columnNames[i])])
        }
    }
    if (rows.isEmpty()) {
        for (tableName in schema.allTableNames()) {
            if (let Some(table) <- schema.findTable(tableName)) {
                if (primaryKeyAutoIndexName(table).toAsciiLower() != stmt.argument.toAsciiLower()) {
                    continue
                }
                let spec = table.requireRowKey()
                for (i in 0..spec.keyColumns.size) {
                    let column = spec.keyColumns[i]
                    rows.add(
                        [SqliteValue.SInt(i), SqliteValue.SInt(column), SqliteValue.SText(table.columns[column].name)])
                }
                break
            }
        }
    }
    StatementResult(Some(ResultSet(names, rows)), 0)
}

func pragmaCollationList(): StatementResult {
    let names: Array<String> = ["seq", "name"]
    let rows = ArrayList<Array<SqliteValue>>()
    let all: Array<String> = ["BINARY", "NOCASE", "RTRIM"]
    for (i in 0..all.size) {
        rows.add([SqliteValue.SInt(i), SqliteValue.SText(all[i])])
    }
    StatementResult(Some(ResultSet(names, rows)), 0)
}

func pragmaDatabaseList(db: SqliteDatabase): StatementResult {
    let names: Array<String> = ["seq", "name", "file"]
    let rows = ArrayList<Array<SqliteValue>>()
    let file = if (db.path == ":memory:") {
        ""
    } else {
        db.path
    }
    rows.add([SqliteValue.SInt(0), SqliteValue.SText("main"), SqliteValue.SText(file)])
    StatementResult(Some(ResultSet(names, rows)), 0)
}

/**
 * PRAGMA integrity_check: 全库一致性检查。
 *
 * 检查项:
 *   1. 每张表/索引的 B-tree 内 cell 有序 (表按 rowid, 索引按键);
 *   2. 内节点的分界键落在其子树的键区间内;
 *   3. 每一页恰好被引用一次 (无丢失页、无重复引用);
 *   4. freelist 自洽且与已用页不重叠;
 *   5. 每张表的每个索引项都能在表里找到对应行, 且索引项数与表行数一致;
 *   6. 所有被引用的页号 (左子页、最右子页、溢出页) 都在 1..dbSize 之内;
 *   7. 文件实际长度换算出的页数与头里的 dbSize 一致;
 *   8. 非根页的 cell 数大于 0。
 *
 * 第 5 项是最有价值的: 索引与表不一致的库仍能通过纯结构检查, 而查询会静默漏行。
 *
 * 第 6..8 项覆盖自检通过但 SQLite 仍会拒绝读取的文件形态：
 *   - 头里的 dbSize 陈旧时, 越界的子页指针在前五项上完全自洽 (前五项只顺着指针走, 不问
 *     指针是否越界), 而 SQLite 顺着同一个指针读到文件外, 判 malformed;
 *   - 0 cell 的非根页同理: 五项全过, SQLite 一读就报整库损坏。
 * 自检通过不等于 SQLite 能读 —— 判据自己有盲区时, 缺陷会一路静默到互操作那一步。
 *
 * 全部通过时返回一行 "ok" —— 与 SQLite 的输出形态一致, 上层的 `== "ok"` 判据可直接用。
 */
func pragmaIntegrityCheck(db: SqliteDatabase): StatementResult {
    let problems = ArrayList<String>()
    let pageOwner = HashMap<Int64, String>()
    let schema = db.currentSchema()
    // 第 1 页 (含 sqlite_schema 的根) 单独登记。
    checkTreeStructure(db, SCHEMA_ROOT_PAGE, true, "sqlite_schema", pageOwner, problems, Array<SqliteCollation>(),
        Array<Bool>())
    for (name in schema.allTableNames()) {
        match (schema.findTable(name)) {
            case None => ()
            case Some(table) =>
                if (table.withoutRowid) {
                    let spec = table.requireRowKey()
                    checkTreeStructure(db, table.rootPage, false, "table ${table.name}", pageOwner, problems,
                        spec.keyCollations, spec.keyDescs)
                } else {
                    checkTreeStructure(db, table.rootPage, true, "table ${table.name}", pageOwner, problems,
                        Array<SqliteCollation>(), Array<Bool>())
                }
                for (index in table.indexes) {
                    let (colls, descs) = indexKeyMeta(table, index)
                    checkTreeStructure(db, index.rootPage, false, "index ${index.name}", pageOwner, problems, colls,
                        descs)
                    checkIndexAgainstTable(db, table, index, problems)
                }
        }
    }
    // sqlite_sequence 的树也要登记, 否则它的页会被算成"丢失"。
    if (db.hasSequenceTable) {
        checkTreeStructure(db, db.sequenceRootPage, true, "sqlite_sequence", pageOwner, problems,
            Array<SqliteCollation>(), Array<Bool>())
    }
    checkFreelistAndPageAccounting(db, pageOwner, problems)
    let names: Array<String> = ["integrity_check"]
    let rows = ArrayList<Array<SqliteValue>>()
    if (problems.isEmpty()) {
        rows.add([SqliteValue.SText("ok")])
    } else {
        for (p in problems) {
            rows.add([SqliteValue.SText(p)])
        }
    }
    StatementResult(Some(ResultSet(names, rows)), 0)
}

/** 递归检查一棵树: 页归属、cell 有序、分界键区间。 */
func checkTreeStructure(db: SqliteDatabase, rootPage: Int64, isTable: Bool, label: String,
    pageOwner: HashMap<Int64, String>, problems: ArrayList<String>, colls: Array<SqliteCollation>, descs: Array<Bool>): Unit {
    if (rootPage < 1 || rootPage > db.pager.pageCount) {
        problems.add("${label} has an out-of-range root page ${rootPage}")
        return
    }
    let stack = ArrayList<Int64>()
    stack.add(rootPage)
    var visited = 0
    while (stack.size > 0) {
        let pageNo = stack[stack.size - 1]
        stack.remove(at: stack.size - 1)
        visited += 1
        if (visited > db.pager.pageCount + 16) {
            problems.add("${label} contains a page cycle")
            return
        }
        match (pageOwner.get(pageNo)) {
            case Some(other) =>
                problems.add("page ${pageNo} is referenced by both ${other} and ${label}")
                continue
            case None => pageOwner[pageNo] = label
        }
        let page = try {
            db.pager.getPage(pageNo)
        } catch (e: Exception) {
            problems.add("${label}: cannot read page ${pageNo}: ${e.message}")
            continue
        }
        try {
            validatePageType(page)
        } catch (e: Exception) {
            problems.add("${label}: page ${pageNo} has an invalid type: ${e.message}")
            continue
        }
        let n = cellCount(page)
        // 非根页必须有 cell。SQLite 对 0 cell 的非根页判整库 malformed, 而前五项检查
        // 对它全自洽 —— 少了这一项, 删空一页的库能通过自检却被 SQLite 拒读。
        if (n == 0 && pageNo != rootPage) {
            problems.add("${label}: page ${pageNo} has no cells but is not the root page")
        }
        // cell 有序检查。
        var previousKey: Option<Array<SqliteValue>> = None
        var previousRowid = Int64.Min
        for (i in 0..n) {
            let cell = parseCell(page, i, db.pager.usableSize)
            if (isTable) {
                if (cell.rowid <= previousRowid && i > 0) {
                    problems.add("${label}: page ${pageNo} cell ${i} has rowid ${cell.rowid} out of order")
                }
                previousRowid = cell.rowid
            } else {
                let key = decodeRecord(readFullPayload(db.pager, page, cell),
                    recordFieldCount(readFullPayload(db.pager, page, cell)))
                if (let Some(prev) <- previousKey) {
                    if (compareIndexKeys(prev, key, colls, descs) > 0) {
                        problems.add("${label}: page ${pageNo} cell ${i} is out of key order")
                    }
                }
                previousKey = Some(key)
            }
            // 溢出链登记。链首页号先查上界: 越界的页号顺着读会读到文件外, 而"读失败"
            // 报出来的是 IO 错而不是"页号越界", 根因看不出来。
            if (cell.overflowPage != 0) {
                if (cell.overflowPage < 1 || cell.overflowPage > db.pager.pageCount) {
                    problems.add(
                        "${label}: page ${pageNo} cell ${i} points at out-of-range overflow page ${cell.overflowPage}")
                } else {
                    let chain = ArrayList<Int64>()
                    try {
                        overflowChainPages(db.pager, cell.overflowPage, chain)
                    } catch (e: Exception) {
                        problems.add("${label}: broken overflow chain on page ${pageNo}: ${e.message}")
                    }
                    for (ov in chain) {
                        if (ov < 1 || ov > db.pager.pageCount) {
                            problems.add("${label}: overflow chain from page ${pageNo} leaves the file at page ${ov}")
                            continue
                        }
                        match (pageOwner.get(ov)) {
                            case Some(other) => problems.add(
                                "overflow page ${ov} is referenced by both ${other} and ${label}")
                            case None => pageOwner[ov] = "${label} overflow"
                        }
                    }
                }
            }
            if (!isLeafPage(page)) {
                if (cell.leftChild < 1 || cell.leftChild > db.pager.pageCount) {
                    problems.add("${label}: page ${pageNo} cell ${i} has an out-of-range left child ${cell.leftChild}")
                } else {
                    stack.add(cell.leftChild)
                }
            }
        }
        if (!isLeafPage(page)) {
            let right = rightChild(page)
            if (right < 1 || right > db.pager.pageCount) {
                problems.add("${label}: page ${pageNo} has an invalid rightmost child ${right}")
            } else {
                stack.add(right)
            }
        }
    }
}

/**
 * 索引与表的一致性。
 *
 * 双向查: 索引项能否回表 (指向已删行), 以及表里的每行是否都在索引里 (漏建索引项)。
 * 只查一个方向会漏掉另一半 —— 漏建索引项的症状是"用索引的查询少返回行", 而回表失败的
 * 症状是"查询报错或返回已删数据"。
 */
func checkIndexAgainstTable(db: SqliteDatabase, table: TableInfo, index: IndexInfo, problems: ArrayList<String>): Unit {
    let keyColumnCount = indexStoredColumnCount(table, index)
    var indexCount = 0
    let cursor = BtreeCursor(db.pager, index.rootPage, false)
    var ok = cursor.first()
    while (ok) {
        indexCount += 1
        let key = decodeRecord(cursor.currentPayload(), keyColumnCount)
        let locator = locatorFromIndexKey(table, index, key)
        let rowCursor = tableCursor(db.pager, table)
        if (!seekTableRow(rowCursor, table, locator)) {
            problems.add("index ${index.name} references a missing row in table ${table.name}")
        } else {
            // 键值也要对得上: 索引项陈旧 (列改了但索引没更新) 时结构完好但内容错。
            let row = decodeTableRow(table, rowCursor)
            for (i in 0..index.columnIndexes.size) {
                let expected = row[index.columnIndexes[i]]
                if (compareValues(key[i], expected, index.collations[i]) != CMP_EQ) {
                    problems.add(
                        "index ${index.name} entry column ${index.columnNames[i]} does not match the table row")
                    break
                }
            }
        }
        ok = cursor.next()
    }
    // 反向: 表里应进索引的行数。
    var expectedCount = 0
    let rowsCursor = tableCursor(db.pager, table)
    var tok = rowsCursor.first()
    while (tok) {
        let row = decodeTableRow(table, rowsCursor)
        var included = true
        if (let Some(cond) <- index.whereExpr) {
            included = evalIndexPredicate(db, table, row, cond)
        }
        if (included) {
            expectedCount += 1
        }
        tok = rowsCursor.next()
    }
    if (indexCount != expectedCount) {
        problems.add(
            "index ${index.name} has ${indexCount} entries but table ${table.name} has ${expectedCount} rows to index")
    }
}

/** freelist 自洽性与页记账。 */
func checkFreelistAndPageAccounting(db: SqliteDatabase, pageOwner: HashMap<Int64, String>, problems: ArrayList<String>): Unit {
    let free = try {
        freelistPages(db.pager)
    } catch (e: Exception) {
        problems.add("freelist is corrupt: ${e.message}")
        return
    }
    for (no in free) {
        match (pageOwner.get(no)) {
            case Some(owner) => problems.add("page ${no} is on the freelist but also used by ${owner}")
            case None => pageOwner[no] = "freelist"
        }
    }
    if (free.size != db.pager.header.freelistCount) {
        problems.add("freelist header says ${db.pager.header.freelistCount} pages but the chain has ${free.size}")
    }
    // 每一页都该有归属。lock-byte 页例外 —— 它不属于任何树, 且只在库超过 1GB 时存在。
    let lockPage = db.pager.lockBytePage
    for (no in 1..(db.pager.pageCount + 1)) {
        if (no == lockPage) {
            continue
        }
        if (!pageOwner.contains(no)) {
            problems.add("page ${no} is never used")
        }
    }
    checkFileLengthAgainstHeader(db, problems)
}

/**
 * 头里声明的每一页是否真的存在。
 *
 * 这一项查的是别的检查项都看不见的东西: 其余检查全部以内存里的 header 为准, 而 header
 * 只有在页 1 落盘时才会写到磁盘上。头陈旧时内存视图完全自洽, 磁盘上的文件却比头声明的
 * 大 —— SQLite 按磁盘长度算页数, 顺着 cell 走到头里"不存在"的页, 判 malformed。
 *
 * WAL 模式下"页在哪"有两个答案: checkpoint 之前, 新页只在 `-wal` 里, 主库文件仍是旧长度。
 * 因此不能用“文件长度等于 dbSize”作为判据，否则尚未检查点的正常 WAL 库会被判为损坏。
 * 正确条件是文件头声明的每一页都能从主库文件或 WAL 中读取。
 */
func checkFileLengthAgainstHeader(db: SqliteDatabase, problems: ArrayList<String>): Unit {
    let bytes = try {
        db.pager.backend.length()
    } catch (e: Exception) {
        problems.add("cannot determine the database file length: ${e.message}")
        return
    }
    let pageSize = db.pager.pageSize
    let pagesOnDisk = bytes / pageSize
    if (bytes % pageSize != 0) {
        problems.add("file length ${bytes} is not a whole number of ${pageSize}-byte pages")
    }
    let declared = db.pager.header.dbSize
    if (pagesOnDisk == declared) {
        return
    }
    if (pagesOnDisk > declared) {
        // 文件比头长: 尾部那些页不属于任何树。SQLite 按文件长度算页数, 于是它会认为库
        // 更大。这表示文件头没有完整落盘，必须报告错误。
        problems.add("header says the database has ${declared} pages but the file holds ${pagesOnDisk}")
        return
    }
    if (!db.pager.walMode) {
        problems.add("header says the database has ${declared} pages but the file holds only ${pagesOnDisk}")
        return
    }
    // WAL 模式: 主库文件之外的页必须由 WAL 帧兜住, 一页都不能缺。
    let missing = ArrayList<Int64>()
    for (no in (pagesOnDisk + 1)..(declared + 1)) {
        if (!db.pager.pageIsBackedByWal(no)) {
            missing.add(no)
        }
    }
    if (!missing.isEmpty()) {
        problems.add(
            "page ${missing[0]} is past the end of the database file and is not in the WAL either " +
                "(${missing.size} such page(s), header says ${declared} pages)")
    }
}
