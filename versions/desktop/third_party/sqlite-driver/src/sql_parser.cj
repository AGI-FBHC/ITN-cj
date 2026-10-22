package sqlite_driver

import std.collection.*
import std.convert.*

/*
 * 递归下降 parser, 表达式用优先级爬升。
 *
 * 运算符优先级照 SQLite (由紧到松):
 *   COLLATE / 一元 ~ - +
 *   ||
 *   * / %
 *   + -
 *   & | << >>
 *   < <= > >=
 *   = == != <> IS [NOT] IN LIKE GLOB BETWEEN
 *   NOT
 *   AND
 *   OR
 * 注意 `||` 比 `*` 更紧、`&`/`|` 比 `+` 更松。优先级错误会使 `a || b * c` 与
 * `1 & 2 + 3` 的结果与 SQLite 不一致，且不会报错。
 *
 * 报错一律带 token 偏移。每个 expect 都说明**实际期待的是什么**，避免把局部语法错误误报为
 * 不支持多语句。
 */
class Parser {
    private let tokens: ArrayList<Token>
    private let sql: String
    private var idx: Int64 = 0
    /** 已见过的 `?` 个数, 用于给无编号参数分配序号。 */
    private var anonParamCount: Int64 = 0
    /** 具名参数到序号的映射, 同名参数共享一个序号 (与 SQLite 一致)。 */
    private let namedParams = HashMap<String, Int64>()
    private var maxParamOrdinal: Int64 = 0

    init(sql: String) {
        this.sql = sql
        this.tokens = Lexer(sql).tokenize()
    }

    prop parameterCount: Int64 {
        get() {
            maxParamOrdinal
        }
    }

    private func peek(): Token {
        tokens[idx]
    }

    private func peekAt(n: Int64): Token {
        let p = idx + n
        if (p >= tokens.size) {
            tokens[tokens.size - 1]
        } else {
            tokens[p]
        }
    }

    private func advance(): Token {
        let t = tokens[idx]
        if (idx < tokens.size - 1) {
            idx += 1
        }
        t
    }

    private func atEnd(): Bool {
        isKind(peek(), TokenKind.TkEof)
    }

    /** 当前 token 是否是给定关键字 (大小写不敏感, 且必须是未加引号的标识符)。 */
    private func isKeyword(word: String): Bool {
        let t = peek()
        isKind(t, TokenKind.TkIdent) && t.text.toAsciiUpper() == word
    }

    private func isKeywordAt(n: Int64, word: String): Bool {
        let t = peekAt(n)
        isKind(t, TokenKind.TkIdent) && t.text.toAsciiUpper() == word
    }

    private func acceptKeyword(word: String): Bool {
        if (isKeyword(word)) {
            let _ = advance()
            return true
        }
        false
    }

    private func expectKeyword(word: String): Unit {
        if (!acceptKeyword(word)) {
            throw SqliteSyntaxException("expected ${word}, found '${describe(peek())}'", peek().pos)
        }
    }

    private func isPunct(p: String): Bool {
        let t = peek()
        isKind(t, TokenKind.TkPunct) && t.text == p
    }

    private func acceptPunct(p: String): Bool {
        if (isPunct(p)) {
            let _ = advance()
            return true
        }
        false
    }

    private func expectPunct(p: String): Unit {
        if (!acceptPunct(p)) {
            throw SqliteSyntaxException("expected '${p}', found '${describe(peek())}'", peek().pos)
        }
    }

    private func describe(t: Token): String {
        if (isKind(t, TokenKind.TkEof)) {
            "end of statement"
        } else {
            t.text
        }
    }

    /** 取一个标识符 (关键字也接受, SQLite 里多数关键字非保留)。 */
    private func expectIdent(what: String): String {
        let t = peek()
        if (!isIdentLike(t)) {
            throw SqliteSyntaxException("expected ${what}, found '${describe(t)}'", t.pos)
        }
        let _ = advance()
        t.text
    }

    /**
     * 解析一整条 SQL, 要求解析完后只剩分号与结尾。
     *
     * 多语句明确拒绝, 但报错说的是"这里出现了第二条语句", 而不是把所有解析失败都归到
     * 多语句上。
     */
    func parseStatement(): Stmt {
        let stmt = parseOneStatement()
        while (acceptPunct(";")) {}
        if (!atEnd()) {
            throw SqliteSyntaxException(
                "only one SQL statement may be prepared at a time; found another statement starting with '${describe(peek())}'",
                peek().pos)
        }
        stmt
    }

    private func parseOneStatement(): Stmt {
        let t = peek()
        if (!isKind(t, TokenKind.TkIdent)) {
            throw SqliteSyntaxException("expected a SQL statement, found '${describe(t)}'", t.pos)
        }
        match (t.text.toAsciiUpper()) {
            case "SELECT" => parseSelect()
            case "VALUES" => parseSelect()
            case "WITH" => parseWithPrefixedStatement()
            case "INSERT" => parseInsert()
            case "REPLACE" => parseInsert()
            case "UPDATE" => parseUpdate()
            case "DELETE" => parseDelete()
            case "CREATE" => parseCreate()
            case "DROP" => parseDrop()
            case "ALTER" => parseAlter()
            case "BEGIN" => parseBegin()
            case "COMMIT" => parseCommitOrEnd()
            case "END" => parseCommitOrEnd()
            case "ROLLBACK" => parseRollback()
            case "SAVEPOINT" => parseSavepoint()
            case "RELEASE" => parseRelease()
            case "PRAGMA" => parsePragma()
            case "VACUUM" => parseVacuum()
            case "ATTACH" => throw SqliteSyntaxException(
                "ATTACH is not supported by this driver; one database per connection", t.pos)
            case "EXPLAIN" => parseExplain()
            case _ => throw SqliteSyntaxException("unrecognized statement '${t.text}'", t.pos)
        }
    }

    /** 支持查询计划摘要；裸 EXPLAIN 依赖本引擎没有的字节码引擎，继续明确拒绝。 */
    private func parseExplain(): Stmt {
        let start = advance()
        if (!acceptKeyword("QUERY")) {
            throw SqliteSyntaxException("bare EXPLAIN is not supported; use EXPLAIN QUERY PLAN", start.pos)
        }
        expectKeyword("PLAN")
        let inner = parseOneStatement()
        if (!(inner is SelectStmt)) {
            throw SqliteSyntaxException("EXPLAIN QUERY PLAN currently describes SELECT statements", start.pos)
        }
        ExplainQueryPlanStmt(inner)
    }

    /*
     * WITH 子句。
     */

    /**
     * `WITH [RECURSIVE] name [(cols)] AS (select), … <statement>`。
     *
     * SELECT、INSERT、UPDATE 和 DELETE 都能带 WITH 前缀。解析后的 CTE 直接挂到主体语句上，
     * 使作用域覆盖整条语句及其子查询。
     */
    private func parseWithPrefixedStatement(): Stmt {
        let ctes = ArrayList<CteDef>()
        parseWithClause(ctes)
        let t = peek()
        if (!isKind(t, TokenKind.TkIdent)) {
            throw SqliteSyntaxException(
                "expected SELECT, INSERT, UPDATE, or DELETE after the WITH clause, found '${describe(t)}'", t.pos)
        }
        match (t.text.toAsciiUpper()) {
            case "SELECT" | "VALUES" =>
                let stmt = parseSelect()
                for (c in ctes) {
                    stmt.withCtes.add(c)
                }
                stmt
            case "INSERT" | "REPLACE" =>
                let stmt = parseInsert()
                for (c in ctes) {
                    stmt.withCtes.add(c)
                }
                stmt
            case "UPDATE" =>
                let stmt = parseUpdate()
                for (c in ctes) {
                    stmt.withCtes.add(c)
                }
                stmt
            case "DELETE" =>
                let stmt = parseDelete()
                for (c in ctes) {
                    stmt.withCtes.add(c)
                }
                stmt
            case _ => throw SqliteSyntaxException(
                "a WITH clause may only precede SELECT, INSERT, UPDATE, or DELETE, found '${t.text}'", t.pos)
        }
    }

    /** 解析 WITH 后面的 CTE 清单 (不含随后的语句)。 */
    func parseWithClause(into: ArrayList<CteDef>): Unit {
        expectKeyword("WITH")
        let recursive = acceptKeyword("RECURSIVE")
        while (true) {
            let def = CteDef()
            def.recursiveKeyword = recursive
            def.name = expectIdent("a common table expression name")
            if (acceptPunct("(")) {
                def.columnNames.add(expectIdent("a column name in the CTE column list"))
                while (acceptPunct(",")) {
                    def.columnNames.add(expectIdent("a column name in the CTE column list"))
                }
                expectPunct(")")
            }
            expectKeyword("AS")
            // MATERIALIZED / NOT MATERIALIZED 是提示而非语义, 接受并忽略。
            if (acceptKeyword("NOT")) {
                expectKeyword("MATERIALIZED")
            } else {
                let _ = acceptKeyword("MATERIALIZED")
            }
            expectPunct("(")
            if (!isKeyword("SELECT") && !isKeyword("VALUES") && !isKeyword("WITH")) {
                // SQLite 对 `WITH s AS (INSERT …)` 报语法错 —— CTE 的 body 只能是查询。
                throw SqliteSyntaxException(
                    "a common table expression body must be a SELECT or VALUES, found '${describe(peek())}'", peek().pos)
            }
            def.body = Some(parseSelect())
            expectPunct(")")
            for (existing in into) {
                if (existing.name.toAsciiLower() == def.name.toAsciiLower()) {
                    throw SqliteSyntaxException("duplicate WITH table name: ${def.name}", peek().pos)
                }
            }
            into.add(def)
            if (!acceptPunct(",")) {
                break
            }
        }
    }

    /*
     * 表达式。parseExpr 是入口, 每一级只管自己那一层的运算符。
     */
    func parseExpr(): Expr {
        parseOr()
    }

    private func parseOr(): Expr {
        var left = parseAnd()
        while (isKeyword("OR")) {
            let _ = advance()
            left = BinaryExpr("OR", left, parseAnd())
        }
        left
    }

    private func parseAnd(): Expr {
        var left = parseNot()
        while (isKeyword("AND")) {
            let _ = advance()
            left = BinaryExpr("AND", left, parseNot())
        }
        left
    }

    private func parseNot(): Expr {
        if (isKeyword("NOT")) {
            let _ = advance()
            return UnaryExpr("NOT", parseNot())
        }
        parseEquality()
    }

    /**
     * 相等级: = == != <> IS [NOT] [NULL] IN LIKE GLOB BETWEEN。
     *
     * 这一级同时处理带 NOT 前缀的形态 (`NOT LIKE` / `NOT IN` / `NOT BETWEEN`), 所以
     * 要先看一眼 NOT 后面跟的是什么 —— `NOT` 单独出现时是上一级的一元运算。
     */
    private func parseEquality(): Expr {
        var left = parseComparison()
        while (true) {
            if (isPunct("=") || isPunct("==")) {
                let _ = advance()
                left = BinaryExpr("=", left, parseComparison())
                continue
            }
            if (isPunct("!=") || isPunct("<>")) {
                let _ = advance()
                left = BinaryExpr("<>", left, parseComparison())
                continue
            }
            if (isKeyword("IS")) {
                let _ = advance()
                let negated = acceptKeyword("NOT")
                if (isKeyword("NULL")) {
                    let _ = advance()
                    left = NullTestExpr(left, negated)
                    continue
                }
                let op = if (negated) {
                    "IS NOT"
                } else {
                    "IS"
                }
                left = BinaryExpr(op, left, parseComparison())
                continue
            }
            if (isKeyword("ISNULL")) {
                let _ = advance()
                left = NullTestExpr(left, false)
                continue
            }
            if (isKeyword("NOTNULL")) {
                let _ = advance()
                left = NullTestExpr(left, true)
                continue
            }
            // NOT LIKE / NOT IN / NOT BETWEEN / NOT GLOB
            if (isKeyword("NOT") && (isKeywordAt(1, "LIKE") || isKeywordAt(1, "IN") || isKeywordAt(1, "BETWEEN") ||
                isKeywordAt(1, "GLOB"))) {
                let _ = advance()
                left = parsePostfixPredicate(left, true)
                continue
            }
            if (isKeyword("LIKE") || isKeyword("IN") || isKeyword("BETWEEN") || isKeyword("GLOB")) {
                left = parsePostfixPredicate(left, false)
                continue
            }
            break
        }
        left
    }

    private func parsePostfixPredicate(left: Expr, negated: Bool): Expr {
        if (isKeyword("LIKE") || isKeyword("GLOB")) {
            let glob = isKeyword("GLOB")
            let _ = advance()
            let pattern = parseComparison()
            var escape: Option<Expr> = None
            if (acceptKeyword("ESCAPE")) {
                escape = Some(parseComparison())
            }
            return LikeExpr(left, pattern, escape, negated, glob)
        }
        if (isKeyword("BETWEEN")) {
            let _ = advance()
            let low = parseComparison()
            expectKeyword("AND")
            let high = parseComparison()
            return BetweenExpr(left, low, high, negated)
        }
        // IN
        let _ = advance()
        if (!acceptPunct("(")) {
            throw SqliteSyntaxException("expected '(' after IN; this driver does not support IN with a table name",
                peek().pos)
        }
        if (isKeyword("SELECT") || isKeyword("VALUES")) {
            let sub = parseSelect()
            expectPunct(")")
            return InExpr(left, ArrayList<Expr>(), Some(sub), negated)
        }
        let values = ArrayList<Expr>()
        if (!isPunct(")")) {
            values.add(parseExpr())
            while (acceptPunct(",")) {
                values.add(parseExpr())
            }
        }
        expectPunct(")")
        InExpr(left, values, None, negated)
    }

    private func parseComparison(): Expr {
        var left = parseBitwise()
        while (isPunct("<") || isPunct("<=") || isPunct(">") || isPunct(">=")) {
            let op = advance().text
            left = BinaryExpr(op, left, parseBitwise())
        }
        left
    }

    private func parseBitwise(): Expr {
        var left = parseAdditive()
        while (isPunct("&") || isPunct("|") || isPunct("<<") || isPunct(">>")) {
            let op = advance().text
            left = BinaryExpr(op, left, parseAdditive())
        }
        left
    }

    private func parseAdditive(): Expr {
        var left = parseMultiplicative()
        while (isPunct("+") || isPunct("-")) {
            let op = advance().text
            left = BinaryExpr(op, left, parseMultiplicative())
        }
        left
    }

    private func parseMultiplicative(): Expr {
        var left = parseConcat()
        while (isPunct("*") || isPunct("/") || isPunct("%")) {
            let op = advance().text
            left = BinaryExpr(op, left, parseConcat())
        }
        left
    }

    private func parseConcat(): Expr {
        var left = parseUnary()
        while (isPunct("||") || isPunct("->") || isPunct("->>")) {
            let op = advance().text
            left = BinaryExpr(op, left, parseUnary())
        }
        left
    }

    private func parseUnary(): Expr {
        if (isPunct("-")) {
            let _ = advance()
            return UnaryExpr("-", parseUnary())
        }
        if (isPunct("+")) {
            let _ = advance()
            return UnaryExpr("+", parseUnary())
        }
        if (isPunct("~")) {
            let _ = advance()
            return UnaryExpr("~", parseUnary())
        }
        if (isKeyword("NOT")) {
            let _ = advance()
            return UnaryExpr("NOT", parseUnary())
        }
        parsePostfix()
    }

    private func parsePostfix(): Expr {
        var e = parsePrimary()
        while (isKeyword("COLLATE")) {
            let _ = advance()
            let name = expectIdent("a collation name")
            e = CollateExpr(e, name.toAsciiUpper())
        }
        e
    }

    private func parsePrimary(): Expr {
        let t = peek()
        if (isKind(t, TokenKind.TkInteger)) {
            let _ = advance()
            return LiteralExpr(parseIntegerLiteral(t))
        }
        if (isKind(t, TokenKind.TkReal)) {
            let _ = advance()
            return LiteralExpr(SqliteValue.SReal(Float64.parse(t.text)))
        }
        if (isKind(t, TokenKind.TkString)) {
            let _ = advance()
            return LiteralExpr(SqliteValue.SText(t.text))
        }
        if (isKind(t, TokenKind.TkBlob)) {
            let _ = advance()
            return LiteralExpr(SqliteValue.SBlob(hexToBytes(t.text)))
        }
        if (isKind(t, TokenKind.TkParam)) {
            let _ = advance()
            return makeParam(t)
        }
        if (isPunct("(")) {
            let _ = advance()
            if (isKeyword("SELECT") || isKeyword("WITH")) {
                let sub = parseSelect()
                expectPunct(")")
                return SubqueryExpr(sub)
            }
            let inner = parseExpr()
            expectPunct(")")
            return inner
        }
        if (isPunct("*")) {
            let _ = advance()
            return StarExpr("")
        }
        if (isKind(t, TokenKind.TkQuotedIdent)) {
            let _ = advance()
            return parseIdentTail(t.text)
        }
        if (isKind(t, TokenKind.TkIdent)) {
            let upper = t.text.toAsciiUpper()
            if (upper == "NULL") {
                let _ = advance()
                return LiteralExpr(SqliteValue.SNull)
            }
            if (upper == "TRUE") {
                let _ = advance()
                return LiteralExpr(SqliteValue.SInt(1))
            }
            if (upper == "FALSE") {
                let _ = advance()
                return LiteralExpr(SqliteValue.SInt(0))
            }
            if (upper == "CASE") {
                return parseCase()
            }
            if (upper == "CAST") {
                return parseCast()
            }
            if (upper == "EXISTS") {
                let _ = advance()
                expectPunct("(")
                let sub = parseSelect()
                expectPunct(")")
                return ExistsExpr(sub, false)
            }
            if (upper == "CURRENT_DATE" || upper == "CURRENT_TIME" || upper == "CURRENT_TIMESTAMP") {
                let _ = advance()
                return FuncExpr(upper.toAsciiLower(), ArrayList<Expr>(), false, false)
            }
            let _ = advance()
            return parseIdentTail(t.text)
        }
        throw SqliteSyntaxException("expected an expression, found '${describe(t)}'", t.pos)
    }

    /** 整数字面量, 含 0x 形式。超出 Int64 时退成浮点, 与 SQLite 一致。 */
    private func parseIntegerLiteral(t: Token): SqliteValue {
        let text = t.text
        if (text.size > 2 && (text[1] == UInt8(b'x') || text[1] == UInt8(b'X'))) {
            var acc: UInt64 = 0
            let digits = text.toArray()
            for (i in 2..digits.size) {
                acc = (acc << 4) | UInt64(hexDigitValue(Int64(digits[i])))
            }
            return SqliteValue.SInt(bitsToI64(acc))
        }
        try {
            SqliteValue.SInt(Int64.parse(text))
        } catch (_: Exception) {
            SqliteValue.SReal(Float64.parse(text))
        }
    }

    /** 标识符之后可能是 `.列`、`.*` 或 `(` 函数调用。 */
    private func parseIdentTail(first: String): Expr {
        if (isPunct(".")) {
            let _ = advance()
            if (isPunct("*")) {
                let _ = advance()
                return StarExpr(first)
            }
            let col = expectIdent("a column name after '.'")
            // 三段式 db.table.column: 本驱动只有一个库, 中间段必须是 main。
            if (isPunct(".")) {
                let _ = advance()
                let realCol = expectIdent("a column name")
                if (first.toAsciiLower() != "main") {
                    throw SqliteSyntaxException("unknown database '${first}'; this driver supports only 'main'",
                        peek().pos)
                }
                return ColumnExpr(col, realCol)
            }
            return ColumnExpr(first, col)
        }
        if (isPunct("(")) {
            return parseFunctionCall(first)
        }
        ColumnExpr("", first)
    }

    private func parseFunctionCall(name: String): Expr {
        // RAISE 的参数不是表达式: 第一个是四个固定关键字之一, 第二个是消息字面量。走通用的
        // 函数调用路径会把 ABORT 当成列名。
        if (name.toAsciiUpper() == "RAISE") {
            return parseRaise()
        }
        expectPunct("(")
        let args = ArrayList<Expr>()
        var distinct = false
        var starArg = false
        if (isPunct("*")) {
            let _ = advance()
            starArg = true
        } else if (!isPunct(")")) {
            if (acceptKeyword("DISTINCT")) {
                distinct = true
            }
            args.add(parseExpr())
            while (acceptPunct(",")) {
                args.add(parseExpr())
            }
        }
        expectPunct(")")
        let funcExpr = FuncExpr(name.toAsciiLower(), args, distinct, starArg)
        var filter: Option<Expr> = None
        if (acceptKeyword("FILTER")) {
            expectPunct("(")
            expectKeyword("WHERE")
            filter = Some(parseExpr())
            expectPunct(")")
        }
        if (acceptKeyword("OVER")) {
            // `OVER 名字` 引用 WINDOW 子句里的定义。那个子句在 SELECT 末尾, 此刻还没解析到,
            // 所以只记名字, 留给 resolveNamedWindows 回填。
            if (!isPunct("(")) {
                let name = expectWindowName("a window name or a window definition after OVER")
                return WindowExpr(funcExpr, filter, WindowSpec(), name)
            }
            return WindowExpr(funcExpr, filter, parseWindowSpec())
        }
        if (let Some(_) <- filter) {
            throw SqliteSyntaxException("FILTER may only be used with a window function", peek().pos)
        }
        funcExpr
    }

    /** `OVER ([基窗口] [PARTITION BY ...] [ORDER BY ...] [frame [EXCLUDE ...]])`。 */
    private func parseWindowSpec(): WindowSpec {
        expectPunct("(")
        let spec = WindowSpec()
        if (isWindowBaseName(peek())) {
            spec.baseName = expectWindowName("a base window name")
        }
        if (acceptKeyword("PARTITION")) {
            expectKeyword("BY")
            spec.partitionBy.add(parseExpr())
            while (acceptPunct(",")) {
                spec.partitionBy.add(parseExpr())
            }
        }
        if (acceptKeyword("ORDER")) {
            expectKeyword("BY")
            spec.orderBy.add(parseOrderTerm())
            while (acceptPunct(",")) {
                spec.orderBy.add(parseOrderTerm())
            }
        }
        if (isKeyword("ROWS") || isKeyword("RANGE") || isKeyword("GROUPS")) {
            let mode = advance().text.toAsciiUpper()
            spec.frameExplicit = true
            spec.frameType = if (mode == "ROWS") {
                WindowFrameType.FrameRows
            } else if (mode == "GROUPS") {
                WindowFrameType.FrameGroups
            } else {
                WindowFrameType.FrameRange
            }
            if (acceptKeyword("BETWEEN")) {
                spec.frameStart = parseWindowFrameBound(true)
                expectKeyword("AND")
                spec.frameEnd = parseWindowFrameBound(false)
            } else {
                spec.frameStart = parseWindowFrameBound(true)
                spec.frameEnd = WindowFrameBound(WindowBoundType.BoundCurrentRow, None)
            }
        } else if (spec.orderBy.isEmpty()) {
            // 无 ORDER BY 时所有行互为 peer，默认帧覆盖整个分区。
            spec.frameEnd = WindowFrameBound(WindowBoundType.BoundUnboundedFollowing, None)
        }
        if (isKeyword("EXCLUDE")) {
            // EXCLUDE 必须跟在显式帧之后 —— SQLite 对 `(ORDER BY v EXCLUDE CURRENT ROW)`
            // 报语法错。放开这条会让本驱动比任何发行版都宽松。
            if (!spec.frameExplicit) {
                throw SqliteSyntaxException("EXCLUDE requires an explicit ROWS/RANGE/GROUPS frame before it", peek().pos)
            }
            let _ = advance()
            spec.exclude = parseWindowExclude()
        }
        expectPunct(")")
        spec
    }

    /**
     * 把 `OVER 名字` 与内联基窗口都换成完整的窗口规格。
     *
     * 以下规则彼此不对称，不能合并为统一的双向覆盖判断：
     *
     *   1. `OVER 名字` 找不到定义 → 报 `no such window: 名字`;
     *      内联的 `OVER (基名 …)` 找不到 → **也报错**。两者查的都是整份清单, 所以基名
     *      可以指向写在后面的定义。
     *   2. WINDOW 子句里**最左那条**定义的基名**从不解析**: 整条丢掉, 连"基窗口不能带帧"
     *      之类的检查也一并不跑。前向引用 (`w1 AS (w2 …), w2 AS (…)`)、自引用
     *      (`w1 AS (w1 …)`) 与不存在的名称都等价于未写基窗口。
     *      这不是"找不到就忽略"—— 名字确实存在时它也照样被丢掉。
     *   3. 第 2 条起, 基名必须在**它左边**的定义里找得到, 否则报 `no such window`。
     *      于是同样的自引用/前向引用写法在第二条定义上是错的, 在第一条上是对的。
     *   4. 重名时后者胜 (`WINDOW w1 AS (A), w1 AS (B)` 用的是 B)。
     *
     * 规则 3 与 4 合起来正好是"按书写顺序从左到右逐条建, 每条只看得见前面建好的";
     * 规则 2 是这条链的起点没有左邻可看的直接后果。
     */
    private func resolveNamedWindows(stmt: SelectStmt): Unit {
        // 按顺序建表: 后定义的覆盖同名的前者, 而每条定义只能继承它之前的。
        let resolved = ArrayList<NamedWindow>()
        for (index in 0..stmt.windows.size) {
            let def = stmt.windows[index]
            let merged = if (index == 0) {
                // 规则 2: 最左那条的基名整条丢掉, 三项约束检查也不跑。
                def.spec.baseName = ""
                def.spec
            } else {
                mergeWindowBase(def.spec, resolved)
            }
            var replaced = false
            for (i in 0..resolved.size) {
                if (resolved[i].name.toAsciiLower() == def.name.toAsciiLower()) {
                    resolved[i] = NamedWindow(def.name, merged)
                    replaced = true
                    break
                }
            }
            if (!replaced) {
                resolved.add(NamedWindow(def.name, merged))
            }
        }
        for (window in collectWindowExprs(stmt)) {
            if (!window.windowName.isEmpty()) {
                window.spec = lookupNamedWindow(resolved, window.windowName)
                continue
            }
            if (!window.spec.baseName.isEmpty()) {
                window.spec = mergeWindowBase(window.spec, resolved)
            }
        }
    }

    /** 本 core 的结果列与 ORDER BY 里出现的窗口表达式。 */
    private func collectWindowExprs(stmt: SelectStmt): ArrayList<WindowExpr> {
        let out = ArrayList<WindowExpr>()
        for (column in stmt.columns) {
            collectWindowExprsIn(column.expr, out)
        }
        for (term in stmt.orderBy) {
            collectWindowExprsIn(term.expr, out)
        }
        out
    }

    private func collectWindowExprsIn(e: Expr, out: ArrayList<WindowExpr>): Unit {
        if (e is WindowExpr) {
            out.add((e as WindowExpr).getOrThrow())
        }
        for (child in childExpressions(e)) {
            collectWindowExprsIn(child, out)
        }
    }

    private func lookupNamedWindow(defs: ArrayList<NamedWindow>, name: String): WindowSpec {
        for (def in defs) {
            if (def.name.toAsciiLower() == name.toAsciiLower()) {
                return def.spec.copy()
            }
        }
        throw SqliteSyntaxException("no such window: ${name}", 0)
    }

    /**
     * 把基窗口的分区/排序并进本规格。
     *
     * 三条覆盖约束的触发条件不同，不能按“两边同时存在才拒绝”的对称规则处理：
     *
     *   1. 本规格写了 PARTITION BY → **一律**拒, 不问基窗口有没有分区。
     *      (`w1 AS (ORDER BY v), w2 AS (w1 PARTITION BY g)` 也拒。)
     *   2. 本规格写了 ORDER BY → 只有基窗口**也有** ORDER BY 时才拒。这一条才是对称的。
     *   3. 基窗口带显式帧 → **一律**拒, 不问本规格写不写帧。于是帧根本不可能被继承,
     *      `w2 AS (w1)` 在 w1 带帧时就是错的。EXCLUDE 只能与帧同处一个规格, 所以它也
     *      跟着不可继承。
     *
     * 优先级按上面的顺序: 三条同时违反时报 PARTITION 那条。
     *
     * 找不到基名一律报错。"静默当作没写基窗口"只发生在最左那条 WINDOW 定义上, 而那一条
     * 根本不进本函数 —— 见 resolveNamedWindows 的规则 2。
     */
    private func mergeWindowBase(spec: WindowSpec, defs: ArrayList<NamedWindow>): WindowSpec {
        if (spec.baseName.isEmpty()) {
            return spec
        }
        var base: Option<WindowSpec> = None
        for (def in defs) {
            if (def.name.toAsciiLower() == spec.baseName.toAsciiLower()) {
                base = Some(def.spec)
                break
            }
        }
        let found = match (base) {
            case Some(b) => b
            case None => throw SqliteSyntaxException("no such window: ${spec.baseName}", 0)
        }
        if (!spec.partitionBy.isEmpty()) {
            throw SqliteSyntaxException("cannot override PARTITION clause of window: ${spec.baseName}", 0)
        }
        if (!found.orderBy.isEmpty() && !spec.orderBy.isEmpty()) {
            throw SqliteSyntaxException("cannot override ORDER BY clause of window: ${spec.baseName}", 0)
        }
        if (found.frameExplicit) {
            throw SqliteSyntaxException("cannot override frame specification of window: ${spec.baseName}", 0)
        }
        let out = spec.copy()
        for (e in found.partitionBy) {
            out.partitionBy.add(e)
        }
        if (spec.orderBy.isEmpty()) {
            for (o in found.orderBy) {
                out.orderBy.add(o)
            }
        }
        // 继承来的排序会改变默认帧: 无 ORDER BY 时默认帧覆盖整个分区, 有则到当前行的 peer 末尾。
        // parseWindowSpec 是在还不知道基窗口的时候定的默认值, 这里按合并后的实际情况纠正。
        if (!out.frameExplicit && !out.orderBy.isEmpty()) {
            out.frameEnd = WindowFrameBound(WindowBoundType.BoundCurrentRow, None)
        }
        out
    }

    /**
     * 规格开头的这个 token 是不是基窗口名。
     *
     * 引号标识符**一律**是名字: 引号的作用就是"这是个名字, 别当关键字看", 所以
     * `OVER ("order" …)` 中的 `"order"` 是基窗口名，不是 ORDER 子句。不能按去除引号后的
     * 文本判断语法引导词。
     *
     * 裸标识符则要避开子句引导词, 否则 `(ORDER BY x)` 会把 ORDER 读成基窗口名, 然后在 BY
     * 处报一个指向别处的语法错。
     */
    private func isWindowBaseName(t: Token): Bool {
        if (isKind(t, TokenKind.TkQuotedIdent)) {
            return true
        }
        isKind(t, TokenKind.TkIdent) && !isWindowClauseKeyword(t.text)
    }

    /**
     * 窗口规格里的子句引导词。
     *
     * 清单恰好是 PARTITION / ORDER / ROWS / RANGE / GROUPS 五个, **不含 EXCLUDE**:
     * EXCLUDE 只能跟在帧之后，因此出现在规格开头时只能是窗口名，不能列入引导词清单。
     */
    private func isWindowClauseKeyword(word: String): Bool {
        match (word.toAsciiUpper()) {
            case "PARTITION" | "ORDER" | "ROWS" | "RANGE" | "GROUPS" => true
            case _ => false
        }
    }

    /**
     * 窗口名, 按原文拼写取。
     *
     * 与 expectIdent 的唯一区别是取 raw 而不是 text: 窗口名的比较连引号一起比 (见
     * Token.raw 的注释)。别把这两个函数合并 —— 表名/列名走的是去引号后的名字, 只有
     * 窗口名是这个例外。
     */
    private func expectWindowName(what: String): String {
        let t = peek()
        if (!isIdentLike(t)) {
            throw SqliteSyntaxException("expected ${what}, found '${describe(t)}'", t.pos)
        }
        let _ = advance()
        t.raw
    }

    /** `EXCLUDE NO OTHERS | CURRENT ROW | GROUP | TIES`。裸 `EXCLUDE OTHERS` 是语法错。 */
    private func parseWindowExclude(): WindowExclude {
        if (acceptKeyword("NO")) {
            expectKeyword("OTHERS")
            return WindowExclude.ExcludeNoOthers
        }
        if (acceptKeyword("CURRENT")) {
            expectKeyword("ROW")
            return WindowExclude.ExcludeCurrentRow
        }
        if (acceptKeyword("GROUP")) {
            return WindowExclude.ExcludeGroup
        }
        if (acceptKeyword("TIES")) {
            return WindowExclude.ExcludeTies
        }
        throw SqliteSyntaxException("expected NO OTHERS, CURRENT ROW, GROUP, or TIES after EXCLUDE", peek().pos)
    }

    private func parseWindowFrameBound(isStart: Bool): WindowFrameBound {
        if (acceptKeyword("UNBOUNDED")) {
            if (acceptKeyword("PRECEDING")) {
                if (!isStart) {
                    throw SqliteSyntaxException("frame end may not be UNBOUNDED PRECEDING", peek().pos)
                }
                return WindowFrameBound(WindowBoundType.BoundUnboundedPreceding, None)
            }
            if (acceptKeyword("FOLLOWING")) {
                if (isStart) {
                    throw SqliteSyntaxException("frame start may not be UNBOUNDED FOLLOWING", peek().pos)
                }
                return WindowFrameBound(WindowBoundType.BoundUnboundedFollowing, None)
            }
            throw SqliteSyntaxException("expected PRECEDING or FOLLOWING after UNBOUNDED", peek().pos)
        }
        if (acceptKeyword("CURRENT")) {
            expectKeyword("ROW")
            return WindowFrameBound(WindowBoundType.BoundCurrentRow, None)
        }
        let offset = parseExpr()
        if (acceptKeyword("PRECEDING")) {
            return WindowFrameBound(WindowBoundType.BoundPreceding, Some(offset))
        }
        if (acceptKeyword("FOLLOWING")) {
            return WindowFrameBound(WindowBoundType.BoundFollowing, Some(offset))
        }
        throw SqliteSyntaxException("expected PRECEDING or FOLLOWING after frame offset", peek().pos)
    }

    /**
     * `RAISE(ABORT|FAIL|ROLLBACK, message)` 或 `RAISE(IGNORE)`。
     *
     * IGNORE 不带消息, 其余三个**必须**带 —— SQLite 的语法就是这样分的。消息只接受字符串
     * 字面量: 它要写进 sqlite_schema 的 SQL 文本再解析回来, 允许任意表达式会让"存下来的
     * 文本重解析后语义相同"这条不再显然成立。
     */
    private func parseRaise(): Expr {
        expectPunct("(")
        let word = expectIdent("ABORT, FAIL, IGNORE, or ROLLBACK in RAISE").toAsciiUpper()
        let action = match (word) {
            case "ABORT" => RAISE_ABORT
            case "FAIL" => RAISE_FAIL
            case "IGNORE" => RAISE_IGNORE
            case "ROLLBACK" => RAISE_ROLLBACK
            case _ => throw SqliteSyntaxException("RAISE takes ABORT, FAIL, IGNORE, or ROLLBACK, found '${word}'",
                peek().pos)
        }
        var message = ""
        if (action == RAISE_IGNORE) {
            expectPunct(")")
            return RaiseExpr(action, message)
        }
        expectPunct(",")
        let t = peek()
        if (!isKind(t, TokenKind.TkString)) {
            throw SqliteSyntaxException("RAISE(${word}, …) needs a string message, found '${describe(t)}'", t.pos)
        }
        message = t.text
        let _ = advance()
        expectPunct(")")
        RaiseExpr(action, message)
    }

    private func parseCase(): Expr {
        expectKeyword("CASE")
        var operand: Option<Expr> = None
        if (!isKeyword("WHEN")) {
            operand = Some(parseExpr())
        }
        let whens = ArrayList<(Expr, Expr)>()
        while (acceptKeyword("WHEN")) {
            let cond = parseExpr()
            expectKeyword("THEN")
            let result = parseExpr()
            whens.add((cond, result))
        }
        if (whens.isEmpty()) {
            throw SqliteSyntaxException("CASE requires at least one WHEN clause", peek().pos)
        }
        var elseExpr: Option<Expr> = None
        if (acceptKeyword("ELSE")) {
            elseExpr = Some(parseExpr())
        }
        expectKeyword("END")
        CaseExpr(operand, whens, elseExpr)
    }

    private func parseCast(): Expr {
        expectKeyword("CAST")
        expectPunct("(")
        let operand = parseExpr()
        expectKeyword("AS")
        // 类型名可能是多个词 (如 UNSIGNED BIG INT), 且可带 (n) 长度。
        let sb = StringBuilder()
        while (isIdentLike(peek())) {
            if (sb.size > 0) {
                sb.append(" ")
            }
            sb.append(advance().text)
        }
        if (sb.size == 0) {
            throw SqliteSyntaxException("expected a type name after AS", peek().pos)
        }
        if (acceptPunct("(")) {
            let _ = advance()
            if (acceptPunct(",")) {
                let _ = advance()
            }
            expectPunct(")")
        }
        expectPunct(")")
        CastExpr(operand, sb.toString())
    }

    /**
     * 参数占位符归一到序号。
     *
     * `?` 按出现顺序编号; `?N` 用 N; 具名参数首次出现时分配下一个序号, 重复出现共享 ——
     * 这与 SQLite 一致, 也是"同一个 :id 只需绑一次"的前提。
     */
    private func makeParam(t: Token): Expr {
        let text = t.text
        if (text == "?") {
            anonParamCount += 1
            let ord = maxParamOrdinal + 1
            maxParamOrdinal = ord
            return ParamExpr(ord, "")
        }
        if (text[0] == UInt8(b'?')) {
            let n = try {
                Int64.parse(text[1..text.size])
            } catch (_: Exception) {
                throw SqliteSyntaxException("invalid parameter index '${text}'", t.pos)
            }
            if (n < 1) {
                throw SqliteSyntaxException("parameter index must be at least 1", t.pos)
            }
            if (n > maxParamOrdinal) {
                maxParamOrdinal = n
            }
            return ParamExpr(n, "")
        }
        if (let Some(existing) <- namedParams.get(text)) {
            return ParamExpr(existing, text)
        }
        let ord = maxParamOrdinal + 1
        maxParamOrdinal = ord
        namedParams[text] = ord
        ParamExpr(ord, text)
    }

    /*
     * SELECT。
     */
    func parseSelect(): SelectStmt {
        // 子查询与 `INSERT … <query>` 里都可能出现 `WITH … SELECT`, 所以前缀在这里也要认。
        // 语句级入口 (parseWithPrefixedStatement) 已经消费掉的那一份不会再走到这里。
        let prefixCtes = ArrayList<CteDef>()
        if (isKeyword("WITH")) {
            parseWithClause(prefixCtes)
        }
        let stmt = parseSelectCore()
        for (c in prefixCtes) {
            stmt.withCtes.add(c)
        }
        // 集合运算: 右侧再解析一个 core, ORDER BY/LIMIT 归最外层。
        var tail = stmt
        while (true) {
            var op: Option<SetOp> = None
            if (isKeyword("UNION")) {
                let _ = advance()
                op = if (acceptKeyword("ALL")) {
                    Some(SetOp.SetUnionAll)
                } else {
                    Some(SetOp.SetUnion)
                }
            } else if (isKeyword("INTERSECT")) {
                let _ = advance()
                op = Some(SetOp.SetIntersect)
            } else if (isKeyword("EXCEPT")) {
                let _ = advance()
                op = Some(SetOp.SetExcept)
            }
            match (op) {
                case None => break
                case Some(o) =>
                    let right = parseSelectCore()
                    // AST 保存书写顺序的右向链; 执行器沿链逐项合并, 从而保持 SQLite 的左结合语义。
                    tail.setOp = Some(o)
                    tail.setRight = Some(right)
                    tail = right
            }
        }
        parseOrderLimit(stmt)
        // ORDER BY 表达式也可以引用命名窗口。它在最外层解析，因此需要在此再次执行幂等回填。
        resolveNamedWindows(stmt)
        stmt
    }

    private func parseSelectCore(): SelectStmt {
        let stmt = SelectStmt()
        if (isKeyword("VALUES")) {
            let _ = advance()
            parseValuesRows(stmt.valuesRows)
            return stmt
        }
        expectKeyword("SELECT")
        // DISTINCT / ALL 必须在这里消费，否则 `SELECT DISTINCT name` 会把 DISTINCT 当成列名，
        // 每行返回 NULL 且不去重。
        if (acceptKeyword("DISTINCT")) {
            stmt.distinct = true
        } else {
            let _ = acceptKeyword("ALL")
        }
        parseResultColumns(stmt.columns)
        if (acceptKeyword("FROM")) {
            parseFromClause(stmt.from)
        }
        if (acceptKeyword("WHERE")) {
            stmt.whereExpr = Some(parseExpr())
        }
        if (acceptKeyword("GROUP")) {
            expectKeyword("BY")
            stmt.groupBy.add(parseExpr())
            while (acceptPunct(",")) {
                stmt.groupBy.add(parseExpr())
            }
            if (acceptKeyword("HAVING")) {
                stmt.having = Some(parseExpr())
            }
        }
        // WINDOW 子句的位置是 HAVING 之后、ORDER BY 之前 (ORDER BY 由外层的 parseSelect 处理,
        // 因为它属于整条集合运算而不是单个 core)。
        if (acceptKeyword("WINDOW")) {
            parseWindowClause(stmt.windows)
        }
        resolveNamedWindows(stmt)
        stmt
    }

    /** `WINDOW name AS (…), name AS (…)`。 */
    private func parseWindowClause(into: ArrayList<NamedWindow>): Unit {
        while (true) {
            let name = expectWindowName("a window name")
            expectKeyword("AS")
            into.add(NamedWindow(name, parseWindowSpec()))
            if (!acceptPunct(",")) {
                break
            }
        }
    }

    private func parseValuesRows(into: ArrayList<ArrayList<Expr>>): Unit {
        while (true) {
            expectPunct("(")
            let row = ArrayList<Expr>()
            if (!isPunct(")")) {
                row.add(parseExpr())
                while (acceptPunct(",")) {
                    row.add(parseExpr())
                }
            }
            expectPunct(")")
            into.add(row)
            if (!acceptPunct(",")) {
                break
            }
        }
    }

    private func parseResultColumns(into: ArrayList<ResultColumn>): Unit {
        while (true) {
            let e = parseExpr()
            var alias = ""
            if (acceptKeyword("AS")) {
                alias = expectIdent("a column alias after AS")
            } else if (isIdentLike(peek()) && !isReservedAfterColumn()) {
                alias = advance().text
            }
            into.add(ResultColumn(e, alias))
            if (!acceptPunct(",")) {
                break
            }
        }
    }

    /**
     * 判断紧跟结果列的标识符是不是"应当结束列列表的关键字"。
     *
     * 没有这一步, `SELECT a FROM t` 会把 FROM 当成 a 的别名。列表必须穷尽所有能跟在
     * 结果列后面的关键字 —— 漏一个就会静默吞掉一个子句。
     */
    private func isReservedAfterColumn(): Bool {
        let t = peek()
        if (!isKind(t, TokenKind.TkIdent)) {
            return false
        }
        match (t.text.toAsciiUpper()) {
            case "FROM" | "WHERE" | "GROUP" | "HAVING" | "ORDER" | "LIMIT" | "OFFSET" | "UNION" | "INTERSECT" | "EXCEPT"
                | "ON" | "USING" | "JOIN" | "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS" | "NATURAL" | "AND" | "OR"
                | "COLLATE" | "AS" | "IS" | "NOT" | "IN" | "LIKE" | "GLOB" | "BETWEEN" | "THEN" | "ELSE" | "END"
                | "WHEN" | "SET" | "VALUES" | "RETURNING" | "DO" | "NOTHING" | "CONFLICT" | "ASC" | "DESC" | "FILTER"
                | "OVER" | "PARTITION" | "ROWS" | "RANGE" | "GROUPS" | "PRECEDING" | "FOLLOWING" | "CURRENT"
                | "UNBOUNDED" | "NULLS" | "FIRST" | "LAST" | "EXCLUDE" | "WINDOW" => true
            case _ => false
        }
    }

    private func parseFromClause(into: ArrayList<JoinClause>): Unit {
        // 第一个操作数也可能是括号分组, 故走同一条 parseJoinOperand。
        parseJoinOperand(into, JoinKind.JoinCross, false)
        while (true) {
            var kind = JoinKind.JoinInner
            var natural = false
            var isJoin = false
            if (acceptPunct(",")) {
                // 逗号连接等价于 CROSS JOIN。
                kind = JoinKind.JoinCross
                isJoin = true
            } else {
                // NATURAL 是连接前缀修饰，不是独立连接种类；LEFT 和 CROSS JOIN 都可与其组合。
                if (isKeyword("NATURAL")) {
                    let _ = advance()
                    natural = true
                    isJoin = true
                }
                if (isKeyword("JOIN")) {
                    let _ = advance()
                    isJoin = true
                } else if (isKeyword("INNER")) {
                    let _ = advance()
                    expectKeyword("JOIN")
                    isJoin = true
                } else if (isKeyword("CROSS")) {
                    let _ = advance()
                    expectKeyword("JOIN")
                    kind = JoinKind.JoinCross
                    isJoin = true
                } else if (isKeyword("LEFT")) {
                    let _ = advance()
                    let _ = acceptKeyword("OUTER")
                    expectKeyword("JOIN")
                    kind = JoinKind.JoinLeft
                    isJoin = true
                } else if (isKeyword("RIGHT")) {
                    let _ = advance()
                    let _ = acceptKeyword("OUTER")
                    expectKeyword("JOIN")
                    kind = JoinKind.JoinRight
                    isJoin = true
                } else if (isKeyword("FULL")) {
                    let _ = advance()
                    let _ = acceptKeyword("OUTER")
                    expectKeyword("JOIN")
                    kind = JoinKind.JoinFull
                    isJoin = true
                } else if (natural) {
                    throw SqliteSyntaxException("expected JOIN after NATURAL, found '${describe(peek())}'", peek().pos)
                }
            }
            if (!isJoin) {
                break
            }
            parseJoinOperand(into, kind, natural)
        }
    }

    /**
     * 解析一个连接操作数 (一张表、一个子查询, 或一个括号分组) 并追加进 into。
     *
     * 括号分组展平为连续的 JoinClause，并在首项记录 groupSpan。分组内的表名在外层连接条件中
     * 仍然可见，因此它们与外层处在同一名称作用域。
     *
     * 分组的嵌套结构由执行期的连接树还原 (exec_join_tree.cj), groupSpan 就是还原的依据 ——
     * 于是分组里再套外连接也能表达, 不需要在这里拦。
     */
    private func parseJoinOperand(into: ArrayList<JoinClause>, kind: JoinKind, natural: Bool): Unit {
        let startIndex = into.size
        if (isPunct("(") && !isSubqueryStart()) {
            expectPunct("(")
            // 括号里是一个完整的 FROM 子句: 递归解析后整段成为一个操作数。
            parseFromClause(into)
            expectPunct(")")
        } else {
            let source = parseTableRef()
            into.add(JoinClause(source, kind, None, ArrayList<String>()))
        }
        let span = into.size - startIndex
        if (span == 0) {
            throw SqliteSyntaxException("empty parenthesized FROM clause", peek().pos)
        }
        // 连接条件跟在整个操作数之后。
        var parsedOn: Option<Expr> = None
        let parsedUsing = ArrayList<String>()
        if (acceptKeyword("ON")) {
            if (natural) {
                throw SqliteSyntaxException("a NATURAL join may not have an ON or USING clause", peek().pos)
            }
            parsedOn = Some(parseExpr())
        } else if (acceptKeyword("USING")) {
            if (natural) {
                throw SqliteSyntaxException("a NATURAL join may not have an ON or USING clause", peek().pos)
            }
            expectPunct("(")
            parsedUsing.add(expectIdent("a column name in USING"))
            while (acceptPunct(",")) {
                parsedUsing.add(expectIdent("a column name in USING"))
            }
            expectPunct(")")
        }
        // 把 kind / 条件安到操作数的首个 clause 上, 并记下跨度。
        let first = into[startIndex]
        let rebuilt = JoinClause(first.source, kind, parsedOn, parsedUsing)
        rebuilt.natural = natural
        rebuilt.groupSpan = span
        into[startIndex] = rebuilt
    }

    /** 当前的 `(` 后面是不是子查询 —— 那由 parseTableRef 处理, 不是括号分组。 */
    private func isSubqueryStart(): Bool {
        if (!isPunct("(")) {
            return false
        }
        let next = peekAt(1)
        if (!isKind(next, TokenKind.TkIdent)) {
            return false
        }
        match (next.text.toAsciiUpper()) {
            case "SELECT" | "VALUES" | "WITH" => true
            case _ => false
        }
    }

    private func parseTableRef(): TableRef {
        if (acceptPunct("(")) {
            if (isKeyword("SELECT") || isKeyword("VALUES") || isKeyword("WITH")) {
                let sub = parseSelect()
                expectPunct(")")
                var alias = ""
                if (acceptKeyword("AS")) {
                    alias = expectIdent("a subquery alias")
                } else if (isIdentLike(peek()) && !isReservedAfterColumn()) {
                    alias = advance().text
                }
                return TableRef("", alias, Some(sub))
            }
            // 括号分组由 parseJoinOperand 处理, 走不到这里。
            throw SqliteSyntaxException("expected SELECT or VALUES after '(' in FROM", peek().pos)
        }
        var name = expectIdent("a table name")
        // main.t 形式
        if (isPunct(".")) {
            let _ = advance()
            let real = expectIdent("a table name after '.'")
            if (name.toAsciiLower() != "main") {
                throw SqliteSyntaxException("unknown database '${name}'; this driver supports only 'main'", peek().pos)
            }
            name = real
        }
        var alias = ""
        if (acceptKeyword("AS")) {
            alias = expectIdent("a table alias after AS")
        } else if (isIdentLike(peek()) && !isReservedAfterColumn()) {
            alias = advance().text
        }
        TableRef(name, alias, None)
    }

    func parseOrderLimit(stmt: SelectStmt): Unit {
        if (acceptKeyword("ORDER")) {
            expectKeyword("BY")
            while (true) {
                stmt.orderBy.add(parseOrderTerm())
                if (!acceptPunct(",")) {
                    break
                }
            }
        }
        if (acceptKeyword("LIMIT")) {
            let first = parseExpr()
            if (acceptKeyword("OFFSET")) {
                stmt.limit = Some(first)
                stmt.offset = Some(parseExpr())
            } else if (acceptPunct(",")) {
                // `LIMIT offset, count` 表示先偏移、后取行数；SQLite 接受该写法。
                stmt.offset = Some(first)
                stmt.limit = Some(parseExpr())
            } else {
                stmt.limit = Some(first)
            }
        }
    }

    /** SELECT 与窗口定义共用的一个 ORDER BY 项。 */
    private func parseOrderTerm(): OrderTerm {
        let e = parseExpr()
        var collation = ""
        if (acceptKeyword("COLLATE")) {
            collation = expectIdent("a collation name").toAsciiUpper()
        }
        var desc = false
        if (acceptKeyword("DESC")) {
            desc = true
        } else {
            let _ = acceptKeyword("ASC")
        }
        // NULLS FIRST / LAST; 未写时 SQLite 的默认是 ASC→NULL 在前, DESC→NULL 在后。
        var nullsFirst = !desc
        if (acceptKeyword("NULLS")) {
            if (acceptKeyword("FIRST")) {
                nullsFirst = true
            } else if (acceptKeyword("LAST")) {
                nullsFirst = false
            } else {
                throw SqliteSyntaxException("expected FIRST or LAST after NULLS", peek().pos)
            }
        }
        OrderTerm(e, desc, nullsFirst, collation)
    }

    /*
     * DML。
     */
    private func parseInsert(): InsertStmt {
        let stmt = InsertStmt()
        if (isKeyword("REPLACE")) {
            let _ = advance()
            stmt.conflict = ConflictAction.ConflictReplace
        } else {
            expectKeyword("INSERT")
            if (acceptKeyword("OR")) {
                stmt.conflict = parseConflictAction()
            }
        }
        expectKeyword("INTO")
        stmt.tableName = parseQualifiedName("a table name")
        if (acceptPunct("(")) {
            stmt.columns.add(expectIdent("a column name"))
            while (acceptPunct(",")) {
                stmt.columns.add(expectIdent("a column name"))
            }
            expectPunct(")")
        }
        if (isKeyword("VALUES")) {
            let _ = advance()
            parseValuesRows(stmt.rows)
        } else if (isKeyword("SELECT") || isKeyword("WITH")) {
            stmt.select = Some(parseSelect())
        } else if (acceptKeyword("DEFAULT")) {
            expectKeyword("VALUES")
            stmt.defaultValues = true
        } else {
            throw SqliteSyntaxException("expected VALUES, SELECT, or DEFAULT VALUES, found '${describe(peek())}'",
                peek().pos)
        }
        if (acceptKeyword("ON")) {
            expectKeyword("CONFLICT")
            parseUpsertClause(stmt)
        }
        parseReturningClause(stmt.returning)
        stmt
    }

    /**
     * `RETURNING expr [AS alias], …`。
     *
     * 复用 parseResultColumns: RETURNING 的列语法与 SELECT 的完全一致, 含 `*` 与
     * `t.*`。另起一套解析会让两处的别名规则慢慢分叉。
     *
     * RETURNING 必须是语句的最后一个子句，后面不能再接 WHERE、ORDER BY 或 LIMIT。
     */
    private func parseReturningClause(into: ArrayList<ResultColumn>): Unit {
        if (!acceptKeyword("RETURNING")) {
            return
        }
        parseResultColumns(into)
    }

    private func parseUpsertClause(stmt: InsertStmt): Unit {
        if (acceptPunct("(")) {
            stmt.upsertTarget.add(expectIdent("a conflict target column"))
            while (acceptPunct(",")) {
                stmt.upsertTarget.add(expectIdent("a conflict target column"))
            }
            expectPunct(")")
            if (acceptKeyword("WHERE")) {
                stmt.upsertWhere = Some(parseExpr())
            }
        }
        expectKeyword("DO")
        if (acceptKeyword("NOTHING")) {
            stmt.conflict = ConflictAction.ConflictIgnore
            return
        }
        expectKeyword("UPDATE")
        expectKeyword("SET")
        stmt.conflict = ConflictAction.ConflictUpdate
        while (true) {
            let col = expectIdent("a column name")
            expectPunct("=")
            stmt.upsertSets.add((col, parseExpr()))
            if (!acceptPunct(",")) {
                break
            }
        }
        if (acceptKeyword("WHERE")) {
            stmt.upsertWhere = Some(parseExpr())
        }
    }

    private func parseConflictAction(): ConflictAction {
        if (acceptKeyword("IGNORE")) {
            return ConflictAction.ConflictIgnore
        }
        if (acceptKeyword("REPLACE")) {
            return ConflictAction.ConflictReplace
        }
        if (acceptKeyword("ABORT")) {
            return ConflictAction.ConflictAbort
        }
        if (isKeyword("ROLLBACK") || isKeyword("FAIL")) {
            let word = advance().text.toAsciiUpper()
            throw SqliteSyntaxException(
                "OR ${word} is not supported by this driver; use OR ABORT, OR IGNORE, or OR REPLACE", peek().pos)
        }
        throw SqliteSyntaxException("expected IGNORE, REPLACE, or ABORT after OR, found '${describe(peek())}'",
            peek().pos)
    }

    private func parseUpdate(): UpdateStmt {
        let stmt = UpdateStmt()
        expectKeyword("UPDATE")
        if (acceptKeyword("OR")) {
            stmt.conflict = parseConflictAction()
        }
        stmt.tableName = parseQualifiedName("a table name")
        expectKeyword("SET")
        while (true) {
            let col = expectIdent("a column name")
            expectPunct("=")
            stmt.sets.add((col, parseExpr()))
            if (!acceptPunct(",")) {
                break
            }
        }
        if (acceptKeyword("WHERE")) {
            stmt.whereExpr = Some(parseExpr())
        }
        parseDmlOrderLimit("UPDATE", stmt.orderBy) {
            l, o =>
                stmt.limit = l
                stmt.offset = o
        }
        parseReturningClause(stmt.returning)
        stmt
    }

    private func parseDelete(): DeleteStmt {
        let stmt = DeleteStmt()
        expectKeyword("DELETE")
        expectKeyword("FROM")
        stmt.tableName = parseQualifiedName("a table name")
        if (acceptKeyword("WHERE")) {
            stmt.whereExpr = Some(parseExpr())
        }
        parseDmlOrderLimit("DELETE", stmt.orderBy) {
            l, o =>
                stmt.limit = l
                stmt.offset = o
        }
        parseReturningClause(stmt.returning)
        stmt
    }

    /**
     * UPDATE / DELETE 尾部的 ORDER BY + LIMIT。
     *
     * ORDER BY 必须配 LIMIT: 没有 LIMIT 时排序改不了"哪些行被改", 只是白排一趟, SQLite
     * 的语法也要求这样。单独的 ORDER BY 报错而不是静默忽略 —— 忽略会让
     * `DELETE … ORDER BY x` 看起来生效, 而它其实删了全表。
     */
    private func parseDmlOrderLimit(what: String, orderBy: ArrayList<OrderTerm>,
        setLimit: (Option<Expr>, Option<Expr>) -> Unit): Unit {
        let hadOrderBy = acceptKeyword("ORDER")
        if (hadOrderBy) {
            expectKeyword("BY")
            while (true) {
                orderBy.add(parseOrderTerm())
                if (!acceptPunct(",")) {
                    break
                }
            }
        }
        if (!acceptKeyword("LIMIT")) {
            if (hadOrderBy) {
                throw SqliteSyntaxException("${what} with ORDER BY also requires LIMIT", peek().pos)
            }
            return
        }
        let first = parseExpr()
        if (acceptKeyword("OFFSET")) {
            setLimit(Some(first), Some(parseExpr()))
        } else if (acceptPunct(",")) {
            setLimit(Some(parseExpr()), Some(first))
        } else {
            setLimit(Some(first), None)
        }
    }

    /** `t` 或 `main.t`。 */
    private func parseQualifiedName(what: String): String {
        var name = expectIdent(what)
        if (isPunct(".")) {
            let _ = advance()
            let real = expectIdent(what)
            if (name.toAsciiLower() != "main") {
                throw SqliteSyntaxException("unknown database '${name}'; this driver supports only 'main'", peek().pos)
            }
            name = real
        }
        name
    }

    /*
     * DDL。
     */
    private func parseCreate(): Stmt {
        let startPos = peek().pos
        expectKeyword("CREATE")
        if (isKeyword("TABLE")) {
            return parseCreateTable(startPos)
        }
        if (isKeyword("UNIQUE") || isKeyword("INDEX")) {
            return parseCreateIndex(startPos)
        }
        if (isKeyword("VIEW")) {
            return parseCreateView(startPos)
        }
        if (isKeyword("TRIGGER")) {
            return parseCreateTrigger(startPos)
        }
        if (isKeyword("VIRTUAL")) {
            throw SqliteSyntaxException("CREATE VIRTUAL TABLE is not supported by this driver", peek().pos)
        }
        if (isKeyword("TEMP") || isKeyword("TEMPORARY")) {
            throw SqliteSyntaxException("temporary tables are not supported by this driver", peek().pos)
        }
        throw SqliteSyntaxException("expected TABLE, INDEX, VIEW, or TRIGGER after CREATE, found '${describe(peek())}'",
            peek().pos)
    }

    private func parseCreateView(startPos: Int64): CreateViewStmt {
        let stmt = CreateViewStmt()
        expectKeyword("VIEW")
        if (isKeyword("IF")) {
            let _ = advance()
            expectKeyword("NOT")
            expectKeyword("EXISTS")
            stmt.ifNotExists = true
        }
        stmt.name = parseQualifiedName("a view name")
        if (acceptPunct("(")) {
            stmt.columnNames.add(expectIdent("a column name in the view column list"))
            while (acceptPunct(",")) {
                stmt.columnNames.add(expectIdent("a column name in the view column list"))
            }
            expectPunct(")")
        }
        expectKeyword("AS")
        stmt.body = Some(parseSelect())
        stmt.sourceSql = normalizeCreateSql(sql, startPos, currentEndPos())
        stmt
    }

    /**
     * `CREATE TRIGGER name {BEFORE|AFTER|INSTEAD OF} event ON table
     *  [FOR EACH ROW] [WHEN expr] BEGIN stmt; … END`。
     *
     * body 里的语句用分号分隔, 以 END 收尾。`FOR EACH ROW` 接受但不影响语义 —— SQLite 只有
     * 行级触发器, 语句级 (`FOR EACH STATEMENT`) 从未实现。
     */
    private func parseCreateTrigger(startPos: Int64): CreateTriggerStmt {
        let stmt = CreateTriggerStmt()
        expectKeyword("TRIGGER")
        if (isKeyword("IF")) {
            let _ = advance()
            expectKeyword("NOT")
            expectKeyword("EXISTS")
            stmt.ifNotExists = true
        }
        stmt.name = parseQualifiedName("a trigger name")
        if (acceptKeyword("BEFORE")) {
            stmt.timing = TRIGGER_TIMING_BEFORE
        } else if (acceptKeyword("AFTER")) {
            stmt.timing = TRIGGER_TIMING_AFTER
        } else if (acceptKeyword("INSTEAD")) {
            expectKeyword("OF")
            stmt.timing = TRIGGER_TIMING_INSTEAD_OF
        }
        // 时机不写时 SQLite 默认 BEFORE。
        if (acceptKeyword("INSERT")) {
            stmt.event = TRIGGER_EVENT_INSERT
        } else if (acceptKeyword("DELETE")) {
            stmt.event = TRIGGER_EVENT_DELETE
        } else if (acceptKeyword("UPDATE")) {
            stmt.event = TRIGGER_EVENT_UPDATE
            if (acceptKeyword("OF")) {
                stmt.updateColumns.add(expectIdent("a column name after UPDATE OF"))
                while (acceptPunct(",")) {
                    stmt.updateColumns.add(expectIdent("a column name after UPDATE OF"))
                }
            }
        } else {
            throw SqliteSyntaxException(
                "expected INSERT, UPDATE, or DELETE in the trigger event, found '${describe(peek())}'", peek().pos)
        }
        expectKeyword("ON")
        stmt.tableName = parseQualifiedName("a table or view name")
        if (acceptKeyword("FOR")) {
            expectKeyword("EACH")
            expectKeyword("ROW")
        }
        if (acceptKeyword("WHEN")) {
            stmt.whenExpr = Some(parseExpr())
        }
        expectKeyword("BEGIN")
        while (!isKeyword("END")) {
            if (atEnd()) {
                throw SqliteSyntaxException("trigger body is missing its END", peek().pos)
            }
            stmt.body.add(parseTriggerBodyStatement())
            // 每条语句后面的分号是必需的 (SQLite 要求), 但连续的分号无害。
            if (!acceptPunct(";")) {
                if (!isKeyword("END")) {
                    throw SqliteSyntaxException(
                        "expected ';' after a statement in the trigger body, found '${describe(peek())}'", peek().pos)
                }
            }
            while (acceptPunct(";")) {}
        }
        expectKeyword("END")
        stmt.sourceSql = normalizeCreateSql(sql, startPos, currentEndPos())
        stmt
    }

    /**
     * 触发器 body 里的一条语句。
     *
     * 只允许 INSERT / UPDATE / DELETE / SELECT —— DDL 与事务语句在 body 里没有意义, SQLite
     * 也拒绝。不走 parseOneStatement 是因为那一层会把 `WITH` 之外的东西也放进来, 且它对
     * 分号的处理与 body 不同。
     */
    private func parseTriggerBodyStatement(): Stmt {
        let t = peek()
        if (!isKind(t, TokenKind.TkIdent)) {
            throw SqliteSyntaxException("expected a statement in the trigger body, found '${describe(t)}'", t.pos)
        }
        match (t.text.toAsciiUpper()) {
            case "INSERT" | "REPLACE" => parseInsert()
            case "UPDATE" => parseUpdate()
            case "DELETE" => parseDelete()
            case "SELECT" | "VALUES" => parseSelect()
            case "WITH" => parseWithPrefixedStatement()
            case other => throw SqliteSyntaxException(
                "a trigger body may only contain INSERT, UPDATE, DELETE, or SELECT, found '${other}'", t.pos)
        }
    }

    private func parseCreateTable(startPos: Int64): CreateTableStmt {
        let stmt = CreateTableStmt()
        expectKeyword("TABLE")
        if (isKeyword("IF")) {
            let _ = advance()
            expectKeyword("NOT")
            expectKeyword("EXISTS")
            stmt.ifNotExists = true
        }
        stmt.name = parseQualifiedName("a table name")
        if (acceptKeyword("AS")) {
            // CREATE TABLE ... AS SELECT: 列由结果集推出, 没有列定义可解析。
            stmt.asSelect = Some(parseSelect())
            stmt.sourceSql = normalizeCreateSql(sql, startPos, currentEndPos())
            return stmt
        }
        expectPunct("(")
        parseTableBody(stmt)
        expectPunct(")")
        if (acceptKeyword("WITHOUT")) {
            expectKeyword("ROWID")
            stmt.withoutRowid = true
            // SQLite 的表选项是逗号分隔清单，同一个 WITHOUT ROWID 重复出现也接受。
            // 本驱动只接受这一种表选项；逗号后出现别的名字仍按语法错处理。
            while (acceptPunct(",")) {
                expectKeyword("WITHOUT")
                expectKeyword("ROWID")
            }
        }
        stmt.sourceSql = normalizeCreateSql(sql, startPos, currentEndPos())
        stmt
    }

    private func parseTableBody(stmt: CreateTableStmt): Unit {
        while (true) {
            if (isTableConstraintStart()) {
                stmt.constraints.add(parseTableConstraint())
            } else {
                stmt.columns.add(parseColumnDef())
            }
            if (!acceptPunct(",")) {
                break
            }
        }
        if (stmt.columns.isEmpty()) {
            throw SqliteSyntaxException("a table must have at least one column", peek().pos)
        }
    }

    private func isTableConstraintStart(): Bool {
        isKeyword("PRIMARY") || isKeyword("UNIQUE") || isKeyword("CHECK") || isKeyword("FOREIGN") || isKeyword(
            "CONSTRAINT")
    }

    private func parseTableConstraint(): TableConstraint {
        let tc = TableConstraint()
        if (acceptKeyword("CONSTRAINT")) {
            tc.name = expectIdent("a constraint name")
        }
        if (acceptKeyword("PRIMARY")) {
            expectKeyword("KEY")
            tc.kind = "primarykey"
            parseIndexedColumnList(tc.columns, tc.collations, tc.descs)
            skipConflictClause()
            return tc
        }
        if (acceptKeyword("UNIQUE")) {
            tc.kind = "unique"
            parseIndexedColumnList(tc.columns, tc.collations, tc.descs)
            skipConflictClause()
            return tc
        }
        if (acceptKeyword("CHECK")) {
            tc.kind = "check"
            expectPunct("(")
            tc.checkExpr = Some(parseExpr())
            expectPunct(")")
            return tc
        }
        expectKeyword("FOREIGN")
        expectKeyword("KEY")
        tc.kind = "foreignkey"
        parseIndexedColumnList(tc.columns, tc.collations, tc.descs)
        let fk = ForeignKeyClause()
        for (c in tc.columns) {
            fk.columns.add(c)
        }
        parseReferencesClause(fk)
        tc.foreignKey = Some(fk)
        tc
    }

    /**
     * `REFERENCES parent [(cols)] [ON DELETE|UPDATE action] [MATCH x] [[NOT] DEFERRABLE …]`。
     *
     * 子句可以按任意顺序出现且可重复 (后者覆盖前者), 与 SQLite 一致。
     */
    private func parseReferencesClause(fk: ForeignKeyClause): Unit {
        expectKeyword("REFERENCES")
        fk.parentTable = expectIdent("a referenced table name")
        if (acceptPunct("(")) {
            fk.parentColumns.add(expectIdent("a referenced column name"))
            while (acceptPunct(",")) {
                fk.parentColumns.add(expectIdent("a referenced column name"))
            }
            expectPunct(")")
        }
        while (true) {
            if (isKeyword("ON")) {
                let _ = advance()
                let isDelete = if (acceptKeyword("DELETE")) {
                    true
                } else {
                    expectKeyword("UPDATE")
                    false
                }
                let action = parseForeignKeyAction()
                if (isDelete) {
                    fk.onDelete = action
                } else {
                    fk.onUpdate = action
                }
                continue
            }
            if (isKeyword("MATCH")) {
                let _ = advance()
                // MATCH SIMPLE 是 SQLite 唯一实现的形态, 也是本驱动的语义 (任一列为 NULL
                // 即免检)。FULL / PARTIAL 会静默按 SIMPLE 处理, 所以明确拒绝而不是装作支持。
                let mode = expectIdent("a MATCH mode").toAsciiUpper()
                if (mode != "SIMPLE") {
                    throw SqliteSyntaxException(
                        "only MATCH SIMPLE is supported; MATCH ${mode} would change which rows are checked", peek().pos)
                }
                continue
            }
            if (isKeyword("NOT") && isKeywordAt(1, "DEFERRABLE")) {
                // NOT DEFERRABLE: 立即校验, 即默认值。先看第二个 token 再决定吃不吃,
                // 免得把列约束里的 NOT NULL 误吞。
                let _ = advance()
                let _ = advance()
                fk.deferred = false
                skipInitiallyClause(fk)
                continue
            }
            if (isKeyword("DEFERRABLE")) {
                let _ = advance()
                skipInitiallyClause(fk)
                continue
            }
            break
        }
    }

    /** `INITIALLY DEFERRED` / `INITIALLY IMMEDIATE`; 缺省为 IMMEDIATE。 */
    private func skipInitiallyClause(fk: ForeignKeyClause): Unit {
        if (!acceptKeyword("INITIALLY")) {
            return
        }
        if (acceptKeyword("DEFERRED")) {
            fk.deferred = true
            return
        }
        expectKeyword("IMMEDIATE")
        fk.deferred = false
    }

    private func parseForeignKeyAction(): String {
        if (acceptKeyword("CASCADE")) {
            return FK_CASCADE
        }
        if (acceptKeyword("RESTRICT")) {
            return FK_RESTRICT
        }
        if (acceptKeyword("SET")) {
            if (acceptKeyword("NULL")) {
                return FK_SET_NULL
            }
            expectKeyword("DEFAULT")
            return FK_SET_DEFAULT
        }
        expectKeyword("NO")
        expectKeyword("ACTION")
        FK_NO_ACTION
    }

    private func parseIndexedColumnList(into: ArrayList<String>, collations: ArrayList<String>, descs: ArrayList<Bool>): Unit {
        expectPunct("(")
        while (true) {
            into.add(expectIdent("a column name"))
            var coll = "BINARY"
            if (acceptKeyword("COLLATE")) {
                coll = expectIdent("a collation name").toAsciiUpper()
            }
            collations.add(coll)
            if (acceptKeyword("DESC")) {
                descs.add(true)
            } else {
                let _ = acceptKeyword("ASC")
                descs.add(false)
            }
            if (!acceptPunct(",")) {
                break
            }
        }
        expectPunct(")")
    }

    /** ON CONFLICT … 子句在本驱动里被接受但不改变行为, 统一按 ABORT 处理。 */
    private func skipConflictClause(): Unit {
        if (acceptKeyword("ON")) {
            expectKeyword("CONFLICT")
            let _ = advance()
        }
    }

    private func parseColumnDef(): ColumnDef {
        let col = ColumnDef()
        col.name = expectIdent("a column name")
        // 类型名: 若干个标识符 + 可选 (n) 或 (n, m)。
        let sb = StringBuilder()
        while (isIdentLike(peek()) && !isColumnConstraintStart()) {
            if (sb.size > 0) {
                sb.append(" ")
            }
            sb.append(advance().text)
        }
        if (isPunct("(") && sb.size > 0) {
            let _ = advance()
            while (!isPunct(")")) {
                let _ = advance()
                if (atEnd()) {
                    throw SqliteSyntaxException("unterminated type length specification", peek().pos)
                }
            }
            expectPunct(")")
        }
        col.typeName = sb.toString()
        parseColumnConstraints(col)
        col
    }

    private func isColumnConstraintStart(): Bool {
        let t = peek()
        if (!isKind(t, TokenKind.TkIdent)) {
            return false
        }
        match (t.text.toAsciiUpper()) {
            case "PRIMARY" | "NOT" | "NULL" | "UNIQUE" | "CHECK" | "DEFAULT" | "COLLATE" | "REFERENCES" | "GENERATED"
                | "AS" | "CONSTRAINT" | "AUTOINCREMENT" => true
            case _ => false
        }
    }

    private func parseColumnConstraints(col: ColumnDef): Unit {
        while (true) {
            if (acceptKeyword("CONSTRAINT")) {
                let _ = expectIdent("a constraint name")
                continue
            }
            if (isKeyword("PRIMARY")) {
                let _ = advance()
                expectKeyword("KEY")
                col.primaryKey = true
                if (acceptKeyword("DESC")) {
                    col.primaryKeyDesc = true
                } else {
                    let _ = acceptKeyword("ASC")
                }
                skipConflictClause()
                if (acceptKeyword("AUTOINCREMENT")) {
                    col.autoincrement = true
                }
                continue
            }
            if (isKeyword("NOT")) {
                let _ = advance()
                expectKeyword("NULL")
                col.notNull = true
                skipConflictClause()
                continue
            }
            if (isKeyword("NULL")) {
                let _ = advance()
                continue
            }
            if (isKeyword("UNIQUE")) {
                let _ = advance()
                col.unique = true
                skipConflictClause()
                continue
            }
            if (isKeyword("CHECK")) {
                let _ = advance()
                expectPunct("(")
                col.checkExpr = Some(parseExpr())
                expectPunct(")")
                continue
            }
            if (isKeyword("DEFAULT")) {
                let _ = advance()
                col.defaultExpr = Some(parseDefaultValue())
                continue
            }
            if (isKeyword("COLLATE")) {
                let _ = advance()
                col.collation = expectIdent("a collation name").toAsciiUpper()
                continue
            }
            if (isKeyword("REFERENCES")) {
                let fk = ForeignKeyClause()
                fk.columns.add(col.name)
                parseReferencesClause(fk)
                col.references = Some(fk)
                continue
            }
            if (isKeyword("GENERATED") || isKeyword("AS")) {
                throw SqliteSyntaxException("generated columns are not supported by this driver", peek().pos)
            }
            break
        }
    }

    /** DEFAULT 的值: 字面量、带符号数字、或括号里的表达式。 */
    private func parseDefaultValue(): Expr {
        if (acceptPunct("(")) {
            let e = parseExpr()
            expectPunct(")")
            return e
        }
        if (isPunct("-") || isPunct("+")) {
            let op = advance().text
            return UnaryExpr(op, parsePrimary())
        }
        parsePrimary()
    }

    private func parseCreateIndex(startPos: Int64): CreateIndexStmt {
        let stmt = CreateIndexStmt()
        if (acceptKeyword("UNIQUE")) {
            stmt.unique = true
        }
        expectKeyword("INDEX")
        if (isKeyword("IF")) {
            let _ = advance()
            expectKeyword("NOT")
            expectKeyword("EXISTS")
            stmt.ifNotExists = true
        }
        stmt.name = parseQualifiedName("an index name")
        expectKeyword("ON")
        stmt.tableName = expectIdent("a table name")
        expectPunct("(")
        while (true) {
            stmt.columns.add(expectIdent("a column name"))
            var coll = "BINARY"
            if (acceptKeyword("COLLATE")) {
                coll = expectIdent("a collation name").toAsciiUpper()
            }
            stmt.collations.add(coll)
            if (acceptKeyword("DESC")) {
                stmt.descs.add(true)
            } else {
                let _ = acceptKeyword("ASC")
                stmt.descs.add(false)
            }
            if (!acceptPunct(",")) {
                break
            }
        }
        expectPunct(")")
        if (acceptKeyword("WHERE")) {
            stmt.whereExpr = Some(parseExpr())
        }
        stmt.sourceSql = normalizeCreateSql(sql, startPos, currentEndPos())
        stmt
    }

    private func parseDrop(): DropStmt {
        let stmt = DropStmt()
        expectKeyword("DROP")
        if (acceptKeyword("TABLE")) {
            stmt.kind = "table"
        } else if (acceptKeyword("INDEX")) {
            stmt.kind = "index"
        } else if (acceptKeyword("VIEW")) {
            stmt.kind = "view"
        } else if (acceptKeyword("TRIGGER")) {
            stmt.kind = "trigger"
        } else {
            throw SqliteSyntaxException(
                "expected TABLE, INDEX, VIEW, or TRIGGER after DROP, found '${describe(peek())}'", peek().pos)
        }
        if (isKeyword("IF")) {
            let _ = advance()
            expectKeyword("EXISTS")
            stmt.ifExists = true
        }
        stmt.name = parseQualifiedName("a name")
        stmt
    }

    private func parseAlter(): AlterTableStmt {
        let stmt = AlterTableStmt()
        expectKeyword("ALTER")
        expectKeyword("TABLE")
        stmt.tableName = parseQualifiedName("a table name")
        if (acceptKeyword("RENAME")) {
            if (acceptKeyword("TO")) {
                stmt.action = "rename"
                stmt.newName = expectIdent("the new table name")
                return stmt
            }
            let _ = acceptKeyword("COLUMN")
            stmt.action = "renamecolumn"
            stmt.oldColumn = expectIdent("the column to rename")
            expectKeyword("TO")
            let def = ColumnDef()
            def.name = expectIdent("the new column name")
            stmt.newColumn = Some(def)
            return stmt
        }
        if (acceptKeyword("ADD")) {
            let _ = acceptKeyword("COLUMN")
            stmt.action = "addcolumn"
            stmt.newColumn = Some(parseColumnDef())
            return stmt
        }
        if (acceptKeyword("DROP")) {
            let _ = acceptKeyword("COLUMN")
            // `DROP COLUMN IF EXISTS` 在 SQLite 里是语法错而不是"静默跳过": IF 被当成列名,
            // 于是 EXISTS 成了多余 token。显式拦一下, 否则报出来的是"只能预编译一条语句"。
            if (isKeyword("IF")) {
                throw SqliteSyntaxException("ALTER TABLE ... DROP COLUMN does not accept IF EXISTS", peek().pos)
            }
            stmt.action = "dropcolumn"
            stmt.oldColumn = expectIdent("the column to drop")
            return stmt
        }
        throw SqliteSyntaxException("expected RENAME, ADD, or DROP after ALTER TABLE, found '${describe(peek())}'",
            peek().pos)
    }

    /*
     * 事务与 PRAGMA。
     */
    private func parseBegin(): TransactionStmt {
        let stmt = TransactionStmt()
        expectKeyword("BEGIN")
        stmt.action = "begin"
        if (acceptKeyword("DEFERRED")) {
            stmt.mode = "DEFERRED"
        } else if (acceptKeyword("IMMEDIATE")) {
            stmt.mode = "IMMEDIATE"
        } else if (acceptKeyword("EXCLUSIVE")) {
            stmt.mode = "EXCLUSIVE"
        }
        let _ = acceptKeyword("TRANSACTION")
        stmt
    }

    private func parseCommitOrEnd(): TransactionStmt {
        let stmt = TransactionStmt()
        let _ = advance()
        stmt.action = "commit"
        let _ = acceptKeyword("TRANSACTION")
        stmt
    }

    private func parseRollback(): TransactionStmt {
        let stmt = TransactionStmt()
        expectKeyword("ROLLBACK")
        let _ = acceptKeyword("TRANSACTION")
        if (acceptKeyword("TO")) {
            let _ = acceptKeyword("SAVEPOINT")
            stmt.action = "rollbackto"
            stmt.savepointName = expectIdent("a savepoint name")
            return stmt
        }
        stmt.action = "rollback"
        stmt
    }

    /**
     * VACUUM [模式名] —— 模式名接受后忽略, 没有 ATTACH 就只有一个模式。
     *
     * `VACUUM INTO 'file'` 明确拒绝而不是忽略 INTO: 忽略会让调用方以为备份已经写出去了,
     * 而实际上什么文件都没生成。
     */
    private func parseVacuum(): VacuumStmt {
        expectKeyword("VACUUM")
        if (isKeyword("INTO")) {
            throw SqliteSyntaxException("VACUUM INTO is not supported by this driver; one database per connection",
                peek().pos)
        }
        if (isKind(peek(), TokenKind.TkIdent) && !isKeyword("INTO")) {
            let _ = advance()
            if (isKeyword("INTO")) {
                throw SqliteSyntaxException("VACUUM INTO is not supported by this driver; one database per connection",
                    peek().pos)
            }
        }
        VacuumStmt()
    }

    private func parseSavepoint(): TransactionStmt {
        let stmt = TransactionStmt()
        expectKeyword("SAVEPOINT")
        stmt.action = "savepoint"
        stmt.savepointName = expectIdent("a savepoint name")
        stmt
    }

    private func parseRelease(): TransactionStmt {
        let stmt = TransactionStmt()
        expectKeyword("RELEASE")
        let _ = acceptKeyword("SAVEPOINT")
        stmt.action = "release"
        stmt.savepointName = expectIdent("a savepoint name")
        stmt
    }

    private func parsePragma(): PragmaStmt {
        let stmt = PragmaStmt()
        expectKeyword("PRAGMA")
        stmt.name = parseQualifiedName("a pragma name").toAsciiLower()
        if (acceptPunct("=")) {
            stmt.value = Some(parsePragmaValue())
            return stmt
        }
        if (acceptPunct("(")) {
            let t = peek()
            if (isIdentLike(t) || isKind(t, TokenKind.TkString)) {
                stmt.argument = advance().text
            } else if (isKind(t, TokenKind.TkInteger)) {
                stmt.argument = advance().text
            }
            expectPunct(")")
            return stmt
        }
        stmt
    }

    /** PRAGMA 的值可以不加引号 (如 `journal_mode = DELETE`)。 */
    private func parsePragmaValue(): Expr {
        let t = peek()
        if (isKind(t, TokenKind.TkIdent)) {
            let _ = advance()
            return LiteralExpr(SqliteValue.SText(t.text))
        }
        if (isPunct("-")) {
            let _ = advance()
            return UnaryExpr("-", parsePrimary())
        }
        parsePrimary()
    }

    /** 当前 token 起点即上一条语句的结束位置。 */
    private func currentEndPos(): Int64 {
        if (idx == 0) {
            return 0
        }
        let prev = tokens[idx - 1]
        prev.pos + tokenSourceLength(prev)
    }
}

/**
 * token 在原文里占的字节数。
 *
 * 不能直接用 text.size: 字符串与引号标识符的 text 已经去掉引号并解过转义, 比原文短。
 * 这个长度用于截取 CREATE 语句原文写进 sqlite_schema.sql —— 截短了会让存下来的 SQL
 * 缺尾括号, 而那要等下次打开库重新解析时才暴露。
 */
func tokenSourceLength(t: Token): Int64 {
    match (t.kind) {
        case TkString => t.text.size + 2 + countOccurrences(t.text, "'")
        case TkQuotedIdent => t.text.size + 2
        case TkBlob => t.text.size + 3
        case TkEof => 0
        case _ => t.text.size
    }
}

func countOccurrences(s: String, needle: String): Int64 {
    var count = 0
    var from = 0
    while (from < s.size) {
        match (s.indexOf(needle, from)) {
            case Some(at) =>
                count += 1
                from = at + needle.size
            case None => break
        }
    }
    count
}

/**
 * 从原 SQL 里截出 CREATE 语句的规范文本, 供写入 sqlite_schema.sql。
 *
 * SQLite 存的是**原始文本**而不是重新生成的 SQL，因此这里保留用户写入的 DDL。仅去掉
 * IF NOT EXISTS，因为 SQLite 本身也不保存它。
 */
func normalizeCreateSql(sql: String, startPos: Int64, endPos: Int64): String {
    let end = if (endPos > sql.size) {
        sql.size
    } else {
        endPos
    }
    let raw = sql[startPos..end].trimAscii()
    removeIfNotExists(raw)
}

func removeIfNotExists(sql: String): String {
    let upper = sql.toAsciiUpper()
    match (upper.indexOf("IF NOT EXISTS")) {
        case Some(at) =>
            let before = sql[0..at]
            let after = sql[at + 13..sql.size]
            "${before.trimAsciiEnd()} ${after.trimAsciiStart()}"
        case None => sql
    }
}
