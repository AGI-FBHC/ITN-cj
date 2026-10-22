package sqlite_driver

import std.collection.*

/*
 * AST 节点。
 *
 * 表达式采用 class 层次。节点种类多且字段差异大，class 可以在类型判断后直接访问属性，
 * 避免递归 enum 在每次读取字段前都进行模式匹配。
 */
open class Expr {}

/** 字面量。参数占位符不在此列, 见 ParamExpr。 */
class LiteralExpr <: Expr {
    let value: SqliteValue

    init(value: SqliteValue) {
        this.value = value
    }
}

/** 列引用。table 为空表示未限定。 */
class ColumnExpr <: Expr {
    let table: String
    let name: String

    init(table: String, name: String) {
        this.table = table
        this.name = name
    }
}

/** `*` 或 `t.*`, 只出现在 SELECT 的结果列里。 */
class StarExpr <: Expr {
    let table: String

    init(table: String) {
        this.table = table
    }
}

/** 参数占位符。ordinal 从 1 起; 具名参数也归一到序号。 */
class ParamExpr <: Expr {
    let ordinal: Int64
    let name: String

    init(ordinal: Int64, name: String) {
        this.ordinal = ordinal
        this.name = name
    }
}

class UnaryExpr <: Expr {
    /** "-" | "+" | "NOT" | "~" */
    let op: String
    let operand: Expr

    init(op: String, operand: Expr) {
        this.op = op
        this.operand = operand
    }
}

class BinaryExpr <: Expr {
    /** "+" "-" "*" "/" "%" "||" "->" "->>" "=" "<>" "<" "<=" ">" ">=" "AND" "OR" "IS" "IS NOT" "&" "|" "<<" ">>" */
    let op: String
    let left: Expr
    let right: Expr

    init(op: String, left: Expr, right: Expr) {
        this.op = op
        this.left = left
        this.right = right
    }
}

/** IS NULL / IS NOT NULL。单列出来是因为它不是二元运算 —— 右边没有操作数。 */
class NullTestExpr <: Expr {
    let operand: Expr
    let negated: Bool

    init(operand: Expr, negated: Bool) {
        this.operand = operand
        this.negated = negated
    }
}

/** LIKE / GLOB。escape 只对 LIKE 有效。 */
class LikeExpr <: Expr {
    let target: Expr
    let pattern: Expr
    let escape: Option<Expr>
    let negated: Bool
    /** true = GLOB (大小写敏感、通配符不同), false = LIKE。 */
    let glob: Bool

    init(target: Expr, pattern: Expr, escape: Option<Expr>, negated: Bool, glob: Bool) {
        this.target = target
        this.pattern = pattern
        this.escape = escape
        this.negated = negated
        this.glob = glob
    }
}

class BetweenExpr <: Expr {
    let target: Expr
    let low: Expr
    let high: Expr
    let negated: Bool

    init(target: Expr, low: Expr, high: Expr, negated: Bool) {
        this.target = target
        this.low = low
        this.high = high
        this.negated = negated
    }
}

/** IN (值列表) 或 IN (子查询)。两者只有一个非空。 */
class InExpr <: Expr {
    let target: Expr
    let values: ArrayList<Expr>
    let subquery: Option<SelectStmt>
    let negated: Bool

    init(target: Expr, values: ArrayList<Expr>, subquery: Option<SelectStmt>, negated: Bool) {
        this.target = target
        this.values = values
        this.subquery = subquery
        this.negated = negated
    }
}

/** 标量子查询 `(SELECT …)`。 */
class SubqueryExpr <: Expr {
    let select: SelectStmt

    init(select: SelectStmt) {
        this.select = select
    }
}

class ExistsExpr <: Expr {
    let select: SelectStmt
    let negated: Bool

    init(select: SelectStmt, negated: Bool) {
        this.select = select
        this.negated = negated
    }
}

/** CASE。operand 为 None 时是搜索式 (`CASE WHEN cond THEN …`)。 */
class CaseExpr <: Expr {
    let operand: Option<Expr>
    let whens: ArrayList<(Expr, Expr)>
    let elseExpr: Option<Expr>

    init(operand: Option<Expr>, whens: ArrayList<(Expr, Expr)>, elseExpr: Option<Expr>) {
        this.operand = operand
        this.whens = whens
        this.elseExpr = elseExpr
    }
}

class CastExpr <: Expr {
    let operand: Expr
    let typeName: String

    init(operand: Expr, typeName: String) {
        this.operand = operand
        this.typeName = typeName
    }
}

/** 函数调用。distinct 只对聚合有意义 (`count(DISTINCT x)`)。 */
class FuncExpr <: Expr {
    let name: String
    let args: ArrayList<Expr>
    let distinct: Bool
    /** `count(*)` 的星号形态 —— 它与 count(expr) 语义不同 (后者跳过 NULL)。 */
    let starArg: Bool

    init(name: String, args: ArrayList<Expr>, distinct: Bool, starArg: Bool) {
        this.name = name
        this.args = args
        this.distinct = distinct
        this.starArg = starArg
    }
}

/** 窗口帧的三种模式。 */
enum WindowFrameType {
    | FrameRows
    | FrameRange
    | FrameGroups
}

/** 窗口帧边界的形态。offset 只对 PRECEDING/FOLLOWING 有值。 */
enum WindowBoundType {
    | BoundUnboundedPreceding
    | BoundPreceding
    | BoundCurrentRow
    | BoundFollowing
    | BoundUnboundedFollowing
}

class WindowFrameBound {
    let kind: WindowBoundType
    let offset: Option<Expr>

    init(kind: WindowBoundType, offset: Option<Expr>) {
        this.kind = kind
        this.offset = offset
    }
}

/** `OVER (...)` 的窗口定义。未显式写帧时由解析器按 SQLite 默认规则填充。 */
class WindowSpec {
    let partitionBy = ArrayList<Expr>()
    let orderBy = ArrayList<OrderTerm>()
    var frameType: WindowFrameType = WindowFrameType.FrameRange
    var frameStart: WindowFrameBound = WindowFrameBound(WindowBoundType.BoundUnboundedPreceding, None)
    var frameEnd: WindowFrameBound = WindowFrameBound(WindowBoundType.BoundCurrentRow, None)
    var frameExplicit: Bool = false
    /** 帧内剔除。只有写了显式帧时才能带 EXCLUDE (SQLite 的语法约束)。 */
    var exclude: WindowExclude = WindowExclude.ExcludeNoOthers
    /** `(base PARTITION BY …)` 里那个基窗口名; 无基窗口时为空。解析后即被合并掉。 */
    var baseName: String = ""

    init() {}

    /** 逐字段复制。基窗口继承要在副本上改, 不能动被继承的那一份。 */
    func copy(): WindowSpec {
        let out = WindowSpec()
        for (e in partitionBy) {
            out.partitionBy.add(e)
        }
        for (o in orderBy) {
            out.orderBy.add(o)
        }
        out.frameType = frameType
        out.frameStart = frameStart
        out.frameEnd = frameEnd
        out.frameExplicit = frameExplicit
        out.exclude = exclude
        out
    }
}

/**
 * 帧内剔除的四态。
 *
 * peer = 按窗口 ORDER BY 比较相等的那组行; 无 ORDER BY 时整个分区互为 peer。
 *   NoOthers   不剔 (默认)
 *   CurrentRow 只剔当前行
 *   Group      剔掉当前行所在的整个 peer 组 (含当前行)
 *   Ties       剔掉同组的其他行, 保留当前行
 */
enum WindowExclude {
    | ExcludeNoOthers
    | ExcludeCurrentRow
    | ExcludeGroup
    | ExcludeTies
}

/**
 * 窗口函数表达式。serial 用于在执行期把同一 AST 节点的值放回当前行。
 *
 * spec 是 var: `OVER win` 形态在解析到该表达式时还看不到 WINDOW 子句 (它在 SELECT 末尾),
 * 所以先留个占位, 等整条 SELECT 解析完再由 resolveNamedWindows 换成真正的规格。
 */
class WindowExpr <: Expr {
    let funcExpr: FuncExpr
    let filter: Option<Expr>
    var spec: WindowSpec
    let serial: Int64
    /** `OVER <名字>` 里的名字; 写成 `OVER (…)` 时为空。 */
    let windowName: String

    init(funcExpr: FuncExpr, filter: Option<Expr>, spec: WindowSpec) {
        this.funcExpr = funcExpr
        this.filter = filter
        this.spec = spec
        this.serial = nextWindowSerial()
        this.windowName = ""
    }

    init(funcExpr: FuncExpr, filter: Option<Expr>, spec: WindowSpec, windowName: String) {
        this.funcExpr = funcExpr
        this.filter = filter
        this.spec = spec
        this.serial = nextWindowSerial()
        this.windowName = windowName
    }
}

/** WINDOW 子句里的一条命名窗口定义。 */
class NamedWindow {
    let name: String
    let spec: WindowSpec

    init(name: String, spec: WindowSpec) {
        this.name = name
        this.spec = spec
    }
}

var windowSerialCounter: Int64 = 0

func nextWindowSerial(): Int64 {
    windowSerialCounter += 1
    windowSerialCounter
}

/** `expr COLLATE name`。 */
class CollateExpr <: Expr {
    let operand: Expr
    let collation: String

    init(operand: Expr, collation: String) {
        this.operand = operand
        this.collation = collation
    }
}

/*
 * 语句。
 */
open class Stmt {}

/** `EXPLAIN QUERY PLAN <select>`；只描述访问路径，不执行被包装的语句。 */
class ExplainQueryPlanStmt <: Stmt {
    let statement: Stmt

    init(statement: Stmt) {
        this.statement = statement
    }
}

/** SELECT 的一个结果列。 */
class ResultColumn {
    let expr: Expr
    /** AS 别名; 空表示没写。 */
    let alias: String

    init(expr: Expr, alias: String) {
        this.expr = expr
        this.alias = alias
    }
}

enum JoinKind {
    | JoinInner
    | JoinLeft
    | JoinCross
    | JoinRight
    | JoinFull
}

/** FROM 里的一个数据源。 */
class TableRef {
    /** 表名; 子查询时为空。 */
    let name: String
    let alias: String
    let subquery: Option<SelectStmt>

    init(name: String, alias: String, subquery: Option<SelectStmt>) {
        this.name = name
        this.alias = alias
        this.subquery = subquery
    }

    /** 在结果里可见的名字: 有别名用别名, 否则用表名。 */
    prop effectiveName: String {
        get() {
            if (alias.isEmpty()) {
                name
            } else {
                alias
            }
        }
    }
}

/** FROM 子句: 第一个源 + 后续的 join。 */
class JoinClause {
    let source: TableRef
    let kind: JoinKind
    let on: Option<Expr>
    /** USING (a, b) 的列名; 与 on 互斥。NATURAL 的公共列在执行期算出后也填这里。 */
    let using: ArrayList<String>
    /**
     * NATURAL JOIN: 连接列由两侧列名的交集自动决定, 解析期还不知道有哪些列。
     *
     * 与 on / using 互斥 —— SQLite 对 `NATURAL JOIN … ON …` 直接报错。
     */
    var natural: Bool = false
    /**
     * 本连接操作数占用的层级数, 括号分组被展平后 > 1。
     *
     * `a LEFT JOIN (b JOIN c ON p) ON q` 里, 括号整体是**一个**操作数: q 要在 b 与 c
     * 都绑定之后才求值, 而未匹配时 b 与 c 要一起补 NULL。只按层级各自处理会让 q 在 b 的
     * 层级上求值 (那时 c 还没绑定), 且只给 b 补 NULL 而 c 留着上一轮的值。
     */
    var groupSpan: Int64 = 1

    init(source: TableRef, kind: JoinKind, on: Option<Expr>, using: ArrayList<String>) {
        this.source = source
        this.kind = kind
        this.on = on
        this.using = using
    }
}

class OrderTerm {
    let expr: Expr
    let desc: Bool
    /** NULL 排在前还是后。SQLite 默认 ASC 时 NULL 在前, DESC 时在后。 */
    let nullsFirst: Bool
    let collation: String

    init(expr: Expr, desc: Bool, nullsFirst: Bool, collation: String) {
        this.expr = expr
        this.desc = desc
        this.nullsFirst = nullsFirst
        this.collation = collation
    }
}

enum SetOp {
    | SetUnion
    | SetUnionAll
    | SetIntersect
    | SetExcept
}

/**
 * 一个 WITH 子句里的公共表表达式。
 *
 * columnNames 是 `WITH s(a,b) AS …` 写明的别名; 空表示没写, 列名由 body 的结果列决定。
 *
 * recursive 记录整个 WITH 是否写了 RECURSIVE 关键字，而不是本条 CTE 是否自引用。递归 CTE
 * 可以省略该关键字，因此是否使用递归求解必须根据 body 中的自引用判断。
 */
class CteDef {
    var name: String = ""
    let columnNames = ArrayList<String>()
    var body: Option<SelectStmt> = None
    var recursiveKeyword: Bool = false
    /**
     * 解析期分配的唯一序号。
     *
     * 用来判"这两个引用指的是同一条声明吗": 语句级的 WITH 会被注册两次 (一次在
     * executeStatement, 一次在 runSelectInto), 只有认出是同一条才能跳过第二次 —— 否则同一个
     * CTE 被物化两遍, body 里带 random() 时两次引用给出不同的行。按名字比不行: 子查询里
     * 重新声明的同名 CTE 是另一条声明, 必须遮蔽外层那条。
     */
    let serial: Int64

    init() {
        this.serial = nextCteSerial()
    }
}

/*
 * CTE 声明的序号发号器。
 *
 * 单调递增且不复用。仓颉没有通用的引用相等运算符, 而这里要的正是对象身份 —— 一个显式序号
 * 比"比较各字段是否相等"可靠: 两条内容完全相同的声明 (`WITH s AS (SELECT 1)` 出现在嵌套的
 * 两层里) 是不同的声明, 按字段比会把它们混为一个。
 */
var cteSerialCounter: Int64 = 0

func nextCteSerial(): Int64 {
    cteSerialCounter += 1
    cteSerialCounter
}

class SelectStmt <: Stmt {
    var distinct: Bool = false
    let columns = ArrayList<ResultColumn>()
    /**
     * WITH 子句声明的公共表表达式, 按书写顺序。
     *
     * 作用域覆盖整条语句，包括子查询和标量子查询。CTE 可以引用声明列表中靠后的 CTE，
     * 因此物化必须按需触发，不能只按声明顺序执行。
     */
    let withCtes = ArrayList<CteDef>()
    /** FROM: 第一项的 kind 无意义。空表示无 FROM (如 `SELECT 1`)。 */
    let from = ArrayList<JoinClause>()
    var whereExpr: Option<Expr> = None
    let groupBy = ArrayList<Expr>()
    var having: Option<Expr> = None
    /**
     * WINDOW 子句的命名窗口, 按书写顺序 (位置在 HAVING 之后、ORDER BY 之前)。
     *
     * 顺序有语义：定义中的基窗口名只在已经定义的窗口中查找；重名时后定义者覆盖先定义者。
     */
    let windows = ArrayList<NamedWindow>()
    let orderBy = ArrayList<OrderTerm>()
    var limit: Option<Expr> = None
    var offset: Option<Expr> = None
    /** 集合运算的右侧。链式 `a UNION b UNION c` 表示为嵌套。 */
    var setOp: Option<SetOp> = None
    var setRight: Option<SelectStmt> = None
    /** VALUES (…), (…) 形态; 非空时 columns/from 都不用。 */
    let valuesRows = ArrayList<ArrayList<Expr>>()

    init() {}
}

/*
 * 外键引用动作。字符串常量而不是 enum: 它们要原样写进 sqlite_schema.sql 再解析回来,
 * 而模式的唯一权威来源是那段 SQL 文本 —— 多一层枚举映射就多一处两边不一致的机会。
 */
const FK_NO_ACTION: String = "NO ACTION"
const FK_RESTRICT: String = "RESTRICT"
const FK_CASCADE: String = "CASCADE"
const FK_SET_NULL: String = "SET NULL"
const FK_SET_DEFAULT: String = "SET DEFAULT"

/**
 * 一条外键约束的语法形态。
 *
 * 列级 `REFERENCES t(c)` 与表级 `FOREIGN KEY (a,b) REFERENCES t(x,y)` 都归到这里,
 * 区别只是 columns 的长度。parentColumns 为空表示引用父表的主键 (SQL 标准的省略形态)。
 */
class ForeignKeyClause {
    let columns = ArrayList<String>()
    var parentTable: String = ""
    let parentColumns = ArrayList<String>()
    var onDelete: String = FK_NO_ACTION
    var onUpdate: String = FK_NO_ACTION
    /** DEFERRABLE INITIALLY DEFERRED: 校验推迟到 COMMIT。 */
    var deferred: Bool = false

    init() {}
}

/** 列定义里的约束。 */
class ColumnDef {
    var name: String = ""
    var typeName: String = ""
    var notNull: Bool = false
    var primaryKey: Bool = false
    var primaryKeyDesc: Bool = false
    var autoincrement: Bool = false
    var unique: Bool = false
    var collation: String = "BINARY"
    var defaultExpr: Option<Expr> = None
    var checkExpr: Option<Expr> = None
    /** 列级 REFERENCES; 建表时与表级约束合并成同一份清单。 */
    var references: Option<ForeignKeyClause> = None

    init() {}
}

/** 表级约束。 */
class TableConstraint {
    /** "primarykey" | "unique" | "check" | "foreignkey" */
    var kind: String = ""
    let columns = ArrayList<String>()
    /** 每个索引列的显式 COLLATE; 未写时解析器填 BINARY。 */
    let collations = ArrayList<String>()
    let descs = ArrayList<Bool>()
    var checkExpr: Option<Expr> = None
    var name: String = ""
    /** kind == "foreignkey" 时的引用信息。 */
    var foreignKey: Option<ForeignKeyClause> = None

    init() {}
}

class CreateTableStmt <: Stmt {
    var name: String = ""
    var ifNotExists: Bool = false
    var withoutRowid: Bool = false
    let columns = ArrayList<ColumnDef>()
    let constraints = ArrayList<TableConstraint>()
    /** 原始 SQL 文本, 要原样写进 sqlite_schema.sql。 */
    var sourceSql: String = ""
    /** SELECT 源 (CREATE TABLE … AS SELECT); 有它时 columns 由结果集推出。 */
    var asSelect: Option<SelectStmt> = None

    init() {}

    /**
     * 列级与表级外键合并后的清单, 按声明顺序。
     *
     * 合并在这里而不是解析时: sqlite_schema 里存的是原始 SQL, 模式重建要靠重新解析,
     * 两条路径必须得到同一份清单 —— 让它们共用这一个函数就不会分叉。
     */
    func allForeignKeys(): ArrayList<ForeignKeyClause> {
        let out = ArrayList<ForeignKeyClause>()
        for (col in columns) {
            if (let Some(fk) <- col.references) {
                out.add(fk)
            }
        }
        for (tc in constraints) {
            if (let Some(fk) <- tc.foreignKey) {
                out.add(fk)
            }
        }
        out
    }
}

class CreateIndexStmt <: Stmt {
    var name: String = ""
    var tableName: String = ""
    var unique: Bool = false
    var ifNotExists: Bool = false
    let columns = ArrayList<String>()
    let descs = ArrayList<Bool>()
    let collations = ArrayList<String>()
    var whereExpr: Option<Expr> = None
    var sourceSql: String = ""

    init() {}
}

class DropStmt <: Stmt {
    /** "table" | "index" */
    var kind: String = ""
    var name: String = ""
    var ifExists: Bool = false

    init() {}
}

class AlterTableStmt <: Stmt {
    var tableName: String = ""
    /** "rename" | "renamecolumn" | "addcolumn" | "dropcolumn" */
    var action: String = ""
    var newName: String = ""
    var oldColumn: String = ""
    var newColumn: Option<ColumnDef> = None

    init() {}
}

enum ConflictAction {
    | ConflictAbort
    | ConflictIgnore
    | ConflictReplace
    | ConflictUpdate
}

class InsertStmt <: Stmt {
    var tableName: String = ""
    /** 语句前缀的 WITH 子句; 作用域覆盖整条语句。 */
    let withCtes = ArrayList<CteDef>()
    let columns = ArrayList<String>()
    /** 显式 VALUES 行。 */
    let rows = ArrayList<ArrayList<Expr>>()
    /** INSERT … SELECT 形态。 */
    var select: Option<SelectStmt> = None
    /** DEFAULT VALUES 形态。 */
    var defaultValues: Bool = false
    var conflict: ConflictAction = ConflictAction.ConflictAbort
    /** ON CONFLICT (cols) DO UPDATE SET … 的赋值对。 */
    let upsertSets = ArrayList<(String, Expr)>()
    let upsertTarget = ArrayList<String>()
    var upsertWhere: Option<Expr> = None
    /** RETURNING 的结果列; 空表示没写该子句。 */
    let returning = ArrayList<ResultColumn>()

    init() {}
}

/*
 * UPDATE / DELETE 的 ORDER BY + LIMIT。
 *
 * 语法上 ORDER BY 只能与 LIMIT 同时出现 —— 单独的 ORDER BY 对 UPDATE/DELETE 没有意义
 * (改/删的集合不受顺序影响), SQLite 的语法也这么定。语义等价于
 * `… WHERE rowid IN (SELECT rowid … ORDER BY … LIMIT …)`, 见 exec_dml 的 limitTargets。
 */
class UpdateStmt <: Stmt {
    var tableName: String = ""
    /** 语句前缀的 WITH 子句; 作用域覆盖整条语句。 */
    let withCtes = ArrayList<CteDef>()
    let sets = ArrayList<(String, Expr)>()
    var whereExpr: Option<Expr> = None
    var conflict: ConflictAction = ConflictAction.ConflictAbort
    let returning = ArrayList<ResultColumn>()
    /** 只在 limit 非空时有意义, 决定 LIMIT 挑中哪些行。 */
    let orderBy = ArrayList<OrderTerm>()
    var limit: Option<Expr> = None
    var offset: Option<Expr> = None

    init() {}
}

class DeleteStmt <: Stmt {
    var tableName: String = ""
    /** 语句前缀的 WITH 子句; 作用域覆盖整条语句。 */
    let withCtes = ArrayList<CteDef>()
    var whereExpr: Option<Expr> = None
    let returning = ArrayList<ResultColumn>()
    /** 只在 limit 非空时有意义, 决定 LIMIT 挑中哪些行。 */
    let orderBy = ArrayList<OrderTerm>()
    var limit: Option<Expr> = None
    var offset: Option<Expr> = None

    init() {}
}

class TransactionStmt <: Stmt {
    /** "begin" | "commit" | "rollback" | "savepoint" | "release" | "rollbackto" */
    var action: String = ""
    /** BEGIN 的模式: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"。 */
    var mode: String = "DEFERRED"
    var savepointName: String = ""

    init() {}
}

class PragmaStmt <: Stmt {
    var name: String = ""
    /** 赋值形态的值; None 表示查询。 */
    var value: Option<Expr> = None
    /** 括号形态的参数, 如 table_info(t)。 */
    var argument: String = ""

    init() {}
}

/**
 * VACUUM。
 *
 * `INTO 'file'` 不支持: 那要往另一个路径写完整一份库, 而本驱动一个连接只管一个文件。
 * 模式名 (`VACUUM main`) 接受但忽略 —— 没有 ATTACH, 只有一个模式。
 */
class VacuumStmt <: Stmt {
    init() {}
}

/**
 * CREATE VIEW。
 *
 * columnNames 是 `CREATE VIEW v(a,b) AS …` 写明的别名; 空表示没写。
 * sourceSql 要原样写进 sqlite_schema.sql —— 视图的定义只存在那段文本里, 重开时靠重解析恢复。
 */
class CreateViewStmt <: Stmt {
    var name: String = ""
    var ifNotExists: Bool = false
    let columnNames = ArrayList<String>()
    var body: Option<SelectStmt> = None
    var sourceSql: String = ""

    init() {}
}

/*
 * 触发器的时机与事件。
 *
 * 字符串常量而不是 enum, 与外键动作同一个理由: 它们要原样写进 sqlite_schema.sql 再解析回来,
 * 而模式的唯一权威来源是那段 SQL 文本 —— 多一层枚举映射就多一处两边不一致的机会。
 */
const TRIGGER_TIMING_BEFORE: String = "BEFORE"
const TRIGGER_TIMING_AFTER: String = "AFTER"
const TRIGGER_TIMING_INSTEAD_OF: String = "INSTEAD OF"
const TRIGGER_EVENT_INSERT: String = "INSERT"
const TRIGGER_EVENT_UPDATE: String = "UPDATE"
const TRIGGER_EVENT_DELETE: String = "DELETE"

/**
 * CREATE TRIGGER。
 *
 * body 是多条语句 (`BEGIN … END`), 每条都能是 INSERT / UPDATE / DELETE / SELECT。
 * SELECT 出现在 body 里唯一的用处是 `SELECT RAISE(…)` —— 它的结果集被丢掉。
 *
 * updateColumns 是 `UPDATE OF a, b` 的列清单; 空表示不限列。
 */
class CreateTriggerStmt <: Stmt {
    var name: String = ""
    var ifNotExists: Bool = false
    var timing: String = TRIGGER_TIMING_BEFORE
    var event: String = TRIGGER_EVENT_INSERT
    let updateColumns = ArrayList<String>()
    var tableName: String = ""
    var whenExpr: Option<Expr> = None
    let body = ArrayList<Stmt>()
    var sourceSql: String = ""

    init() {}
}

/*
 * RAISE 的四种处置。
 */
const RAISE_ABORT: String = "ABORT"
const RAISE_FAIL: String = "FAIL"
const RAISE_IGNORE: String = "IGNORE"
const RAISE_ROLLBACK: String = "ROLLBACK"

/**
 * `RAISE(ABORT|FAIL|IGNORE|ROLLBACK [, message])`。
 *
 * 只在触发器 body 里合法。做成 Expr 而不是 Stmt 是因为它出现在 `SELECT RAISE(…)` 的结果列
 * 位置上 —— 语法上就是个函数调用。
 */
class RaiseExpr <: Expr {
    let action: String
    let message: String

    init(action: String, message: String) {
        this.action = action
        this.message = message
    }
}
