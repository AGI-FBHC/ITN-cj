package sqlite_driver

import std.collection.*

/*
 * ALTER TABLE 用的 DDL 文本改写。
 *
 * 列信息只存在 sqlite_schema.sql 里 (格式如此), 所以改表结构就是改这段文本。
 * 改写必须走 token 级替换而不是字符串 replace: 后者会把出现在字符串字面量、注释、
 * 或别的标识符里的同名子串一起改掉。例如把列 `id` 改名时, `CREATE TABLE t(id INT,
 * width INT)` 里的 `width` 会变成 `wnew_idth` —— 建表语句仍然合法, 下次打开库时才
 * 暴露成"没有 width 列"。
 */

/** 把 SQL 里作为**独立标识符**出现的 oldName 换成 newName。 */
func replaceIdentifierInSql(sql: String, oldName: String, newName: String): String {
    let tokens = Lexer(sql).tokenize()
    let sb = StringBuilder()
    var cursor = 0
    let lower = oldName.toAsciiLower()
    for (t in tokens) {
        if (isKind(t, TokenKind.TkEof)) {
            break
        }
        if (!isIdentLike(t) || t.text.toAsciiLower() != lower) {
            continue
        }
        // 把 token 之前的原文照抄, 再写替换后的名字。
        sb.append(sql[cursor..t.pos])
        sb.append(quoteIdentIfNeeded(newName, isKind(t, TokenKind.TkQuotedIdent)))
        cursor = t.pos + tokenSourceLength(t)
    }
    sb.append(sql[cursor..sql.size])
    sb.toString()
}

/** 需要时给标识符加双引号。原本带引号的一律保留引号。 */
func quoteIdentIfNeeded(name: String, forceQuote: Bool): String {
    if (!forceQuote && isPlainIdentifier(name)) {
        return name
    }
    let escaped = name.replace("\"", "\"\"")
    "\"${escaped}\""
}

func isPlainIdentifier(name: String): Bool {
    if (name.isEmpty()) {
        return false
    }
    let bs = name.toArray()
    let first = Int64(bs[0])
    if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first == 95)) {
        return false
    }
    for (i in 1..bs.size) {
        let c = Int64(bs[i])
        if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 95)) {
            return false
        }
    }
    !isSqlKeyword(name)
}

/**
 * 需要加引号保护的关键字。
 *
 * 只列真正会引起歧义的那些 —— 全量关键字表在这里没有价值, 因为 SQLite 多数关键字
 * 可以直接当标识符用。
 */
func isSqlKeyword(name: String): Bool {
    match (name.toAsciiUpper()) {
        case "SELECT" | "FROM" | "WHERE" | "TABLE" | "INDEX" | "INSERT" | "UPDATE" | "DELETE" | "CREATE" | "DROP"
            | "ALTER" | "PRIMARY" | "KEY" | "UNIQUE" | "NOT" | "NULL" | "DEFAULT" | "CHECK" | "REFERENCES" | "ORDER"
            | "GROUP" | "BY" | "AND" | "OR" | "JOIN" | "ON" | "AS" | "IN" | "IS" | "LIKE" | "BETWEEN" | "CASE" | "WHEN"
            | "THEN" | "ELSE" | "END" | "COLLATE" | "CONSTRAINT" | "FOREIGN" | "VALUES" | "SET" | "TRANSACTION"
            | "BEGIN" | "COMMIT" | "ROLLBACK" => true
        case _ => false
    }
}

/** ALTER TABLE … RENAME TO: 换掉 CREATE TABLE 后面的表名。 */
func replaceTableNameInCreate(sql: String, oldName: String, newName: String): String {
    let _ = oldName
    let tokens = Lexer(sql).tokenize()
    // 找 CREATE TABLE 之后的第一个标识符 —— 那就是表名。只换它, 不碰同名的列。
    var i = 0
    while (i < tokens.size) {
        let t = tokens[i]
        if (isKind(t, TokenKind.TkIdent) && t.text.toAsciiUpper() == "TABLE") {
            var j = i + 1
            while (j < tokens.size && isKind(tokens[j], TokenKind.TkIdent) && isSchemaModifierKeyword(tokens[j].text)) {
                j += 1
            }
            if (j < tokens.size && isIdentLike(tokens[j])) {
                let target = tokens[j]
                let before = sql[0..target.pos]
                let after = sql[target.pos + tokenSourceLength(target)..sql.size]
                return "${before}${quoteIdentIfNeeded(newName, isKind(target, TokenKind.TkQuotedIdent))}${after}"
            }
        }
        i += 1
    }
    throw SqliteRuntimeException("schema", "cannot locate the table name in the stored DDL: ${sql}")
}

func isSchemaModifierKeyword(word: String): Bool {
    match (word.toAsciiUpper()) {
        case "IF" | "NOT" | "EXISTS" => true
        case _ => false
    }
}

/** CREATE INDEX … ON <table>: 换掉 ON 后面的表名。 */
func replaceIndexTableName(sql: String, oldName: String, newName: String): String {
    let _ = oldName
    let tokens = Lexer(sql).tokenize()
    var i = 0
    while (i < tokens.size) {
        let t = tokens[i]
        if (isKind(t, TokenKind.TkIdent) && t.text.toAsciiUpper() == "ON" && i + 1 < tokens.size && isIdentLike(
            tokens[i + 1])) {
            let target = tokens[i + 1]
            let before = sql[0..target.pos]
            let after = sql[target.pos + tokenSourceLength(target)..sql.size]
            return "${before}${quoteIdentIfNeeded(newName, isKind(target, TokenKind.TkQuotedIdent))}${after}"
        }
        i += 1
    }
    sql
}

/**
 * ALTER TABLE … RENAME COLUMN: 只改列定义与约束里的那个列名。
 *
 * 不能整篇 replaceIdentifierInSql: 表名可能与列名同名, 那样会把表名也改掉。做法是先定位
 * 列定义列表的括号范围, 只在范围内替换。
 */
func rewriteCreateWithRenamedColumn(table: TableInfo, oldCol: String, newCol: String): String {
    let sql = table.sql
    let range = findColumnListRange(sql)
    let head = sql[0..range[0]]
    let body = sql[range[0]..range[1]]
    let tail = sql[range[1]..sql.size]
    "${head}${replaceIdentifierInSql(body, oldCol, newCol)}${tail}"
}

/** 找 CREATE TABLE 的列定义括号范围 [开括号后, 闭括号前)。 */
func findColumnListRange(sql: String): Array<Int64> {
    let tokens = Lexer(sql).tokenize()
    var depth = 0
    var openPos = -1
    for (t in tokens) {
        if (isKind(t, TokenKind.TkEof)) {
            break
        }
        if (isKind(t, TokenKind.TkPunct) && t.text == "(") {
            depth += 1
            if (depth == 1) {
                openPos = t.pos + 1
            }
            continue
        }
        if (isKind(t, TokenKind.TkPunct) && t.text == ")") {
            depth -= 1
            if (depth == 0 && openPos >= 0) {
                return [openPos, t.pos]
            }
        }
    }
    throw SqliteRuntimeException("schema", "cannot locate the column list in the stored DDL: ${sql}")
}

/** ALTER TABLE … ADD COLUMN: 在列定义列表末尾追加一列。 */
func appendColumnToCreate(sql: String, def: ColumnDef): String {
    let range = findColumnListRange(sql)
    let head = sql[0..range[1]]
    let tail = sql[range[1]..sql.size]
    "${head.trimAsciiEnd()}, ${renderColumnDef(def)}${tail}"
}

/**
 * ALTER TABLE … DROP COLUMN: 从列定义列表里摘掉一列的定义文本。
 *
 * 删的跨度是 [该列首 token, 下一个列表项首 token) —— 即连它后面那个逗号一起吞。末列没有
 * 后继逗号, 改吞它前面的那个。这条规则是拿 SQLite 逐形态比对出来的: 它保证多行 DDL 的
 * 换行与缩进、以及列表里的注释都逐字保留 (`CREATE TABLE t(a INT, /*keep*/ b INT, c INT)`
 * 删 b 之后 `/*keep*/` 仍在原处)。
 *
 * 不能按"列名 token 到下一个逗号"删: 列定义里可以有带逗号的括号 (如 `DECIMAL(10,2)` 或
 * `CHECK(x IN (1,2))`), 那样会从括号里的逗号处截断, 留下语法上仍合法但列数不对的 DDL。
 * 所以扫描要跟踪括号深度, 只认深度 0 的逗号。
 */
func removeColumnFromCreate(sql: String, columnName: String): String {
    let range = findColumnListRange(sql)
    let head = sql[0..range[0]]
    let body = sql[range[0]..range[1]]
    let tail = sql[range[1]..sql.size]
    let starts = topLevelItemStarts(body)
    let target = columnDefIndexInBody(body, starts, columnName)
    if (target < 0) {
        throw SqliteRuntimeException("schema", "cannot locate the definition of column '${columnName}' in: ${sql}")
    }
    let cut = if (target + 1 < starts.size) {
        // 非末项: 从本项开头删到下一项开头, 顺带吃掉分隔的逗号。
        (starts[target], starts[target + 1])
    } else {
        // 末项: 往前找深度 0 的逗号, 从它删到本项结束。
        (precedingSeparatorPos(body, starts[target]), body.size)
    }
    "${head}${body[0..cut[0]]}${body[cut[1]..body.size]}${tail}"
}

/** 列定义列表里每个顶层项 (列定义或表级约束) 的起始下标。 */
func topLevelItemStarts(body: String): Array<Int64> {
    let starts = ArrayList<Int64>()
    let tokens = Lexer(body).tokenize()
    var depth = 0
    var expectItem = true
    for (t in tokens) {
        if (isKind(t, TokenKind.TkEof)) {
            break
        }
        if (isKind(t, TokenKind.TkPunct) && t.text == "(") {
            depth += 1
            continue
        }
        if (isKind(t, TokenKind.TkPunct) && t.text == ")") {
            depth -= 1
            continue
        }
        if (depth == 0 && isKind(t, TokenKind.TkPunct) && t.text == ",") {
            expectItem = true
            continue
        }
        if (expectItem) {
            starts.add(t.pos)
            expectItem = false
        }
    }
    starts.toArray()
}

/**
 * 在列表项里找列名为 columnName 的那一项。
 *
 * 只认"项的第一个 token 就是该标识符"的项 —— 列定义以列名开头, 而表级约束以 CONSTRAINT /
 * PRIMARY / UNIQUE / CHECK / FOREIGN 开头。这条区分是必要的: 表级 `UNIQUE(a,b)` 里也出现
 * 列名 a, 按"哪一项提到了 a"去找会摘掉约束而不是列。
 */
func columnDefIndexInBody(body: String, starts: Array<Int64>, columnName: String): Int64 {
    let lower = columnName.toAsciiLower()
    for (i in 0..starts.size) {
        let tokens = Lexer(body[starts[i]..body.size]).tokenize()
        if (tokens.isEmpty() || isKind(tokens[0], TokenKind.TkEof)) {
            continue
        }
        let first = tokens[0]
        if (!isIdentLike(first) || isTableConstraintKeyword(first.text)) {
            continue
        }
        if (first.text.toAsciiLower() == lower) {
            return i
        }
    }
    -1
}

/** 表级约束的引导关键字。列定义不会以这些开头。 */
func isTableConstraintKeyword(word: String): Bool {
    match (word.toAsciiUpper()) {
        case "CONSTRAINT" | "PRIMARY" | "UNIQUE" | "CHECK" | "FOREIGN" => true
        case _ => false
    }
}

/** 从 itemStart 往前找那个深度 0 的分隔逗号, 返回它的下标。 */
func precedingSeparatorPos(body: String, itemStart: Int64): Int64 {
    let tokens = Lexer(body).tokenize()
    var depth = 0
    var lastComma = -1
    for (t in tokens) {
        if (isKind(t, TokenKind.TkEof) || t.pos >= itemStart) {
            break
        }
        if (isKind(t, TokenKind.TkPunct) && t.text == "(") {
            depth += 1
        } else if (isKind(t, TokenKind.TkPunct) && t.text == ")") {
            depth -= 1
        } else if (depth == 0 && isKind(t, TokenKind.TkPunct) && t.text == ",") {
            lastComma = t.pos
        }
    }
    if (lastComma < 0) {
        throw SqliteRuntimeException("schema", "cannot locate the separator before the last column definition")
    }
    lastComma
}

/** 把列定义还原成 DDL 文本。 */
func renderColumnDef(def: ColumnDef): String {
    let sb = StringBuilder()
    sb.append(quoteIdentIfNeeded(def.name, false))
    if (!def.typeName.isEmpty()) {
        sb.append(" ")
        sb.append(def.typeName)
    }
    if (def.notNull) {
        sb.append(" NOT NULL")
    }
    if (let Some(e) <- def.defaultExpr) {
        sb.append(" DEFAULT ")
        sb.append(renderDefaultExpr(e))
    }
    if (def.collation != "BINARY") {
        sb.append(" COLLATE ")
        sb.append(def.collation)
    }
    sb.toString()
}

/**
 * DEFAULT 表达式还原成文本。
 *
 * 只覆盖字面量与带符号数字。更复杂的默认值 (如函数调用) 在 ADD COLUMN 里被拒绝 ——
 * 那是 SQLite 自己的限制, 不是我们省略的。
 */
func renderDefaultExpr(e: Expr): String {
    if (e is LiteralExpr) {
        return renderLiteral((e as LiteralExpr).getOrThrow().value)
    }
    if (e is UnaryExpr) {
        let u = (e as UnaryExpr).getOrThrow()
        if (u.op == "-" || u.op == "+") {
            return "${u.op}${renderDefaultExpr(u.operand)}"
        }
    }
    if (e is FuncExpr) {
        let f = (e as FuncExpr).getOrThrow()
        if (f.args.isEmpty()) {
            return f.name.toAsciiUpper()
        }
    }
    throw SqliteRuntimeException("schema",
        "this DEFAULT expression is too complex for ALTER TABLE ADD COLUMN in this driver")
}

func renderLiteral(v: SqliteValue): String {
    match (v) {
        case SNull => "NULL"
        case SInt(i) => "${i}"
        case SReal(f) => formatReal(f)
        case SText(s) => "'${s.replace("'", "''")}'"
        case SBlob(bs) => "x'${bytesToHex(bs)}'"
    }
}
