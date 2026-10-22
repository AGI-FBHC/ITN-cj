package sqlite_driver

import std.collection.*

/*
 * 视图与触发器的 DDL。
 *
 * 两者都是"纯模式对象": sqlite_schema 里 rootpage 恒 0, 没有自己的 B-tree, 定义只存在
 * sql 列的那段文本里, 重开时靠重新解析恢复 (buildViewInfo / buildTriggerInfo)。
 * 于是这里的 DDL 只做两件事: 增删 sqlite_schema 的行、递增 schema_cookie。
 *
 * 表与视图共享名称空间，触发器使用独立名称空间，因此触发器可以与表同名。
 */

/** CREATE VIEW。 */
func execCreateView(db: SqliteDatabase, stmt: CreateViewStmt): Int64 {
    if (stmt.name.toAsciiLower().startsWith("sqlite_")) {
        throw SqliteRuntimeException("schema", "object name reserved for internal use: ${stmt.name}")
    }
    let schema = db.currentSchema()
    if (let Some(_) <- schema.findView(stmt.name)) {
        if (stmt.ifNotExists) {
            return 0
        }
        throw SqliteRuntimeException("schema", "view ${stmt.name} already exists")
    }
    if (let Some(_) <- schema.findTable(stmt.name)) {
        // 表与视图共用名字空间。IF NOT EXISTS 在这一支上**不**免除报错: 请求建的是视图,
        // 而存在的是表, 静默成功会让调用方以为视图建好了。
        throw SqliteRuntimeException("schema", "table ${stmt.name} already exists")
    }
    // 创建视图时不要求 body 引用的表存在，因此此处不校验数据源；列别名数量在查询时校验。
    match (stmt.body) {
        case Some(_) => ()
        case None => throw SqliteRuntimeException("schema", "view ${stmt.name} has no SELECT body")
    }
    let _ = insertSchemaRow(db, "view", stmt.name, stmt.name, 0, stmt.sourceSql)
    db.bumpSchemaCookie()
    0
}

/** DROP VIEW。 */
func execDropView(db: SqliteDatabase, stmt: DropStmt): Int64 {
    let schema = db.currentSchema()
    match (schema.findView(stmt.name)) {
        case Some(_) => ()
        case None =>
            if (let Some(_) <- schema.findTable(stmt.name)) {
                // 指错了对象种类。报出"该用 DROP TABLE"而不是"没有这个视图" —— 后者会让
                // 调用方以为对象不存在, 于是去建一个同名的, 然后撞上"已存在"。
                throw SqliteRuntimeException("schema", "use DROP TABLE to delete table ${stmt.name}")
            }
            if (stmt.ifExists) {
                return 0
            }
            throw SqliteRuntimeException("schema", "no such view: ${stmt.name}")
    }
    let _ = deleteSchemaRows(db, "view", stmt.name)
    // 视图上的 INSTEAD OF 触发器随视图一起删 —— 留着会指向一个不存在的视图。
    dropTriggersOn(db, stmt.name)
    db.bumpSchemaCookie()
    0
}

/** CREATE TRIGGER。 */
func execCreateTrigger(db: SqliteDatabase, stmt: CreateTriggerStmt): Int64 {
    if (stmt.name.toAsciiLower().startsWith("sqlite_")) {
        throw SqliteRuntimeException("schema", "object name reserved for internal use: ${stmt.name}")
    }
    let schema = db.currentSchema()
    for (tr in schema.triggers) {
        if (tr.name.toAsciiLower() == stmt.name.toAsciiLower()) {
            if (stmt.ifNotExists) {
                return 0
            }
            throw SqliteRuntimeException("schema", "trigger ${stmt.name} already exists")
        }
    }
    let onView = match (schema.findView(stmt.tableName)) {
        case Some(_) => true
        case None => false
    }
    let onTable = match (schema.findTable(stmt.tableName)) {
        case Some(_) => true
        case None => false
    }
    if (!onView && !onTable) {
        // 触发器目标必须存在，否则触发器无法执行。
        throw SqliteRuntimeException("schema", "no such table: ${stmt.tableName}")
    }
    // 触发时机必须与目标类型匹配：
    //   - 表上不能建 INSTEAD OF: 表本来就写得动, 那个触发器永远不会触发;
    //   - 视图上只能建 INSTEAD OF: 视图没有行可言, BEFORE/AFTER 无从谈起。
    if (stmt.timing == TRIGGER_TIMING_INSTEAD_OF && !onView) {
        throw SqliteRuntimeException("schema", "cannot create INSTEAD OF trigger on table: ${stmt.tableName}")
    }
    if (stmt.timing != TRIGGER_TIMING_INSTEAD_OF && onView) {
        throw SqliteRuntimeException("schema", "cannot create ${stmt.timing} trigger on view: ${stmt.tableName}")
    }
    if (stmt.body.isEmpty()) {
        throw SqliteRuntimeException("schema", "trigger ${stmt.name} has an empty body")
    }
    let _ = insertSchemaRow(db, "trigger", stmt.name, stmt.tableName, 0, stmt.sourceSql)
    db.bumpSchemaCookie()
    0
}

/** DROP TRIGGER。 */
func execDropTrigger(db: SqliteDatabase, stmt: DropStmt): Int64 {
    let schema = db.currentSchema()
    var found = false
    for (tr in schema.triggers) {
        if (tr.name.toAsciiLower() == stmt.name.toAsciiLower()) {
            found = true
            break
        }
    }
    if (!found) {
        if (stmt.ifExists) {
            return 0
        }
        throw SqliteRuntimeException("schema", "no such trigger: ${stmt.name}")
    }
    let _ = deleteSchemaRows(db, "trigger", stmt.name)
    db.bumpSchemaCookie()
    0
}

/**
 * 删掉挂在某个表/视图上的全部触发器。
 *
 * DROP TABLE 和 DROP VIEW 都需要删除关联触发器，避免模式中保留指向已删除对象的定义。
 */
func dropTriggersOn(db: SqliteDatabase, tableName: String): Unit {
    let lower = tableName.toAsciiLower()
    let victims = ArrayList<Int64>()
    for (row in readSchemaRows(db.pager)) {
        if (row.objType == "trigger" && row.tblName.toAsciiLower() == lower) {
            victims.add(row.rowid)
        }
    }
    for (rowid in victims) {
        let _ = btreeDeleteRow(db.pager, SCHEMA_ROOT_PAGE, rowid)
    }
}
