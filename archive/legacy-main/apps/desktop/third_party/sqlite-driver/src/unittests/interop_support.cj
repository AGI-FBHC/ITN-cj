package sqlite_driver.unittests

import sqlite_driver.*
import std.collection.*
import std.convert.*
import std.fs.*
import std.process.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 文件格式兼容性测试的共用工具。
 *
 * 本驱动写入 SQLite 文件格式。结构自检 (PRAGMA integrity_check) 仍有盲区，例如页号越界的
 * 文件可能在内部自检中保持自洽，却会被 SQLite 判为 malformed。因此这些用例
 * 使用对照 SQLite 给出外部判据。
 *
 * 对照环境不可用时整例失败而不是跳过，避免文件格式缺陷被静默忽略。
 */

/** 对照所用 SQLite 的最低版本要求（3.7 起支持 WAL）。 */
const MIN_PYTHON_SQLITE_VERSION: String = "3.7.0"

/** 一次外部命令调用的结果。 */
class PythonResult {
    let exitCode: Int64
    let stdout: String
    let stderr: String

    init(exitCode: Int64, stdout: String, stderr: String) {
        this.exitCode = exitCode
        this.stdout = stdout
        this.stderr = stderr
    }

    prop ok: Bool {
        get() {
            exitCode == 0
        }
    }

    /** 出错时的完整诊断, 拼进断言消息。 */
    func describe(): String {
        "exit=${exitCode} stdout=[${stdout.trimAscii()}] stderr=[${stderr.trimAscii()}]"
    }
}

/**
 * 执行一段差分判据脚本。
 *
 * 用 std.process.executeWithOutput: 这些判据脚本不派生常驻子进程, 也不会产生大输出,
 * 直接等同步完成即可。输出流按字节读回再解码，避免 NUL 字节造成内容截断。
 */
func runPython(script: String): PythonResult {
    let (code, outBytes, errBytes) = executeWithOutput("python3", ["-c", script], stdOut: ProcessRedirect.Pipe,
        stdErr: ProcessRedirect.Pipe)
    PythonResult(code, String.fromUtf8(outBytes), String.fromUtf8(errBytes))
}

/**
 * 执行一段差分判据脚本，并额外传入一个 argv 参数。
 *
 * 数据走 argv 而不是拼进脚本文本: 拼接要为引号、反斜杠与换行做转义, 一处漏了就变成
 * 语法错或静默改值 —— 而那种失败看起来与"被测语义不对"一模一样。
 */
func runPythonWithArg(script: String, argument: String): PythonResult {
    let (code, outBytes, errBytes) = executeWithOutput("python3", ["-c", script, argument], stdOut: ProcessRedirect.Pipe,
        stdErr: ProcessRedirect.Pipe)
    PythonResult(code, String.fromUtf8(outBytes), String.fromUtf8(errBytes))
}

/**
 * 确认差分判据环境可用，不可用时直接让用例失败。
 */
func requirePython(): Unit {
    let probe = try {
        runPython("import sqlite3, sys; sys.stdout.write(sqlite3.sqlite_version)")
    } catch (e: Exception) {
        throw Exception(
            "python3 with the sqlite3 module is required for interop tests but could not be started: ${e.message}")
    }
    if (!probe.ok) {
        throw Exception("python3 cannot import sqlite3; interop tests cannot run: ${probe.describe()}")
    }
    let version = probe.stdout.trimAscii()
    if (!versionAtLeast(version, MIN_PYTHON_SQLITE_VERSION)) {
        throw Exception("python3 sqlite3 version ${version} is older than the required ${MIN_PYTHON_SQLITE_VERSION}")
    }
}

/** 点分版本比较。位数不同时缺位按 0 补。 */
func versionAtLeast(actual: String, required: String): Bool {
    let a = splitDots(actual)
    let r = splitDots(required)
    let n = if (a.size > r.size) {
        a.size
    } else {
        r.size
    }
    for (i in 0..n) {
        let av = if (i < a.size) {
            a[i]
        } else {
            0
        }
        let rv = if (i < r.size) {
            r[i]
        } else {
            0
        }
        if (av != rv) {
            return av > rv
        }
    }
    true
}

func splitDots(s: String): Array<Int64> {
    let out = ArrayList<Int64>()
    var acc = 0
    var any = false
    for (b in s.toArray()) {
        if (b >= UInt8(b'0') && b <= UInt8(b'9')) {
            acc = acc * 10 + Int64(b - UInt8(b'0'))
            any = true
        } else {
            if (any) {
                out.add(acc)
            }
            acc = 0
            any = false
        }
    }
    if (any) {
        out.add(acc)
    }
    out.toArray()
}

/**
 * 临时目录的守卫。
 */
class TempDbDir {
    let dir: String

    init() {
        this.dir = Directory.createTemp(Path("/tmp")).toString()
    }

    func file(name: String): String {
        "${dir}/${name}"
    }

    public prop dbPath: String {
        get() {
            file("interop.db")
        }
    }

    public func cleanup(): Unit {
        try {
            remove(Path(dir), recursive: true)
        } catch (_: Exception) {
            ()
        }
    }
}

/** 打开一条落在给定路径的文件库连接。 */
public func openFileConn(path: String): SqliteConn {
    openSqlite(SqliteDSN(path: path))
}

/**
 * 内存库连接。
 */
func newMemConn(): SqliteConn {
    openSqlite(SqliteDSN(path: ":memory:"))
}

/*
 * 文件兼容性判据脚本。
 */
public func pythonOpen(dbPath: String): String {
    "import sqlite3, sys\n" + "con = sqlite3.connect('${dbPath}')\n" + "con.isolation_level = None\n" +
        "cur = con.cursor()\n"
}

public func pythonIntegrityCheck(): String {
    "rows = cur.execute('PRAGMA integrity_check').fetchall()\n" +
        "if rows != [('ok',)]: raise SystemExit('integrity_check said %r' % (rows,))\n"
}

public func pythonExpect(sql: String, expected: String): String {
    "got = cur.execute(\"${sql}\").fetchall()\n" + "want = ${expected}\n" +
        "if got != want: raise SystemExit('query %r gave %r, wanted %r' % (\"${sql}\", got, want))\n"
}

public func pythonDone(): String {
    "con.close()\n" + "sys.stdout.write('OK')\n"
}

/** 执行判据脚本并断言它通过。 */
public func expectPythonOk(script: String, what: String): Unit {
    let r = runPython(script)
    if (!r.ok || r.stdout.trimAscii() != "OK") {
        @Fail("${what}: ${r.describe()}")
    }
}

/*
 * 差分判据: 同一段 SQL 在本驱动与 SQLite 上跑, 逐值比对。
 */

/** 值的规范文本: 带类型标记, 于是 1 与 1.0、'1' 与 1 不会被读成同一个值。 */
func renderValue(v: SqliteValue): String {
    match (v) {
        case SNull => "N"
        case SInt(i) => "I:${i}"
        case SReal(f) => "R:${f.format(".17g")}"
        case SText(s) => "T:${s}"
        case SBlob(b) =>
            let sb = StringBuilder()
            sb.append("B:")
            for (byte in b) {
                sb.append(byteToHex(byte))
            }
            sb.toString()
    }
}

func byteToHex(b: Byte): String {
    let digits = "0123456789abcdef"
    let hi = Int64(b) / 16
    let lo = Int64(b) % 16
    "${digits[hi..hi + 1]}${digits[lo..lo + 1]}"
}

/** 整个结果集的规范文本: 行内用 \u{1F} 分隔, 行间用 \u{1E}。 */
func renderRows(rs: SqliteResultSet): String {
    let sb = StringBuilder()
    for (i in 0..rs.rows.size) {
        if (i > 0) {
            sb.append("\u{1E}")
        }
        let row = rs.rows[i]
        for (j in 0..row.size) {
            if (j > 0) {
                sb.append("\u{1F}")
            }
            sb.append(renderValue(row[j]))
        }
    }
    sb.toString()
}

/** 独立判据使用的同款渲染函数，逐分支与 renderValue 对应。 */
func pythonRenderHelpers(): String {
    "def rv(v):\n" + "    if v is None: return 'N'\n" + "    if isinstance(v, bool): return 'I:%d' % int(v)\n" +
        "    if isinstance(v, int): return 'I:%d' % v\n" + "    if isinstance(v, float): return 'R:%.17g' % v\n" +
        "    if isinstance(v, str): return 'T:' + v\n" +
        "    if isinstance(v, (bytes, bytearray)): return 'B:' + bytes(v).hex()\n" +
        "    raise SystemExit('unexpected python value type %r' % (type(v),))\n" + "def rr(rows):\n" +
        "    return '\\x1e'.join('\\x1f'.join(rv(c) for c in r) for r in rows)\n"
}

/**
 * 断言一段查询在本驱动与 SQLite 上给出同样的行。
 */
public func expectSameAsSqlite(setup: Array<String>, query: String, what: String): Unit {
    requirePython()
    let conn = newMemConn()
    let rendered = try {
        for (sql in setup) {
            conn.execString(sql)
        }
        renderRows(conn.queryString(query))
    } finally {
        conn.close()
    }
    let script = "import sqlite3, sys\n" + pythonRenderHelpers() + "con = sqlite3.connect(':memory:')\n" +
        "cur = con.cursor()\n" + "for s in ${pythonStringList(setup)}: cur.execute(s)\n" +
        "got = rr(cur.execute(${pythonQuoted(query)}).fetchall())\n" + "want = sys.argv[1]\n" + "if got != want:\n" +
        "    raise SystemExit('sqlite gave %r but the driver gave %r' % (got, want))\n" + "con.close()\n" +
        "sys.stdout.write('OK')\n"
    let r = runPythonWithArg(script, rendered)
    if (!r.ok || r.stdout.trimAscii() != "OK") {
        @Fail("${what}: driver and sqlite disagree on `${query}`: ${r.describe()}")
    }
}

/**
 * 断言一段 DML 在本驱动与 SQLite 上留下同样的表内容, 两侧允许跑**不同写法**的 SQL。
 *
 * `UPDATE/DELETE … ORDER BY … LIMIT` 依赖可选编译能力，常见发行构建可能不接受原式。
 * 因此独立判据执行 SQLite 文档给出的等价重写
 * `… WHERE rowid IN (SELECT rowid … ORDER BY … LIMIT …)`，本驱动执行原式，再比较表内容。
 *
 * 这比手写期望值硬: 手写时人会照着实现写, 于是"先裁后排"这类实现错与期望一起绿 ——
 * 而先排后裁正是本项最容易写反的地方。
 */
public func expectSameEffectAsSqlite(schema: Array<String>, driverDml: String, sqliteDml: String, verify: String,
    what: String): Unit {
    requirePython()
    let conn = newMemConn()
    let rendered = try {
        for (sql in schema) {
            conn.execString(sql)
        }
        conn.execString(driverDml)
        renderRows(conn.queryString(verify))
    } finally {
        conn.close()
    }
    let script = "import sqlite3, sys\n" + pythonRenderHelpers() + "con = sqlite3.connect(':memory:')\n" +
        "cur = con.cursor()\n" + "for s in ${pythonStringList(schema)}: cur.execute(s)\n" +
        "cur.execute(${pythonQuoted(sqliteDml)})\n" + "got = rr(cur.execute(${pythonQuoted(verify)}).fetchall())\n" +
        "want = sys.argv[1]\n" + "if got != want:\n" +
        "    raise SystemExit('sqlite left %r but the driver left %r' % (got, want))\n" + "con.close()\n" +
        "sys.stdout.write('OK')\n"
    let r = runPythonWithArg(script, rendered)
    if (!r.ok || r.stdout.trimAscii() != "OK") {
        @Fail("${what}: driver `${driverDml}` and sqlite `${sqliteDml}` disagree: ${r.describe()}")
    }
}

/**
 * 断言一段查询的结果列名清单与 SQLite 相同。
 */
public func expectSameColumnNamesAsSqlite(setup: Array<String>, query: String, what: String): Unit {
    requirePython()
    let conn = newMemConn()
    let rendered = try {
        for (sql in setup) {
            conn.execString(sql)
        }
        let rs = conn.queryString(query)
        let sb = StringBuilder()
        for (i in 0..rs.columnNames.size) {
            if (i > 0) {
                sb.append("\u{1F}")
            }
            sb.append(rs.columnNames[i])
        }
        sb.toString()
    } finally {
        conn.close()
    }
    let script = "import sqlite3, sys\n" + "con = sqlite3.connect(':memory:')\n" + "cur = con.cursor()\n" +
        "for s in ${pythonStringList(setup)}: cur.execute(s)\n" + "cur.execute(${pythonQuoted(query)})\n" +
        "got = '\\x1f'.join(d[0] for d in cur.description)\n" + "want = sys.argv[1]\n" + "if got != want:\n" +
        "    raise SystemExit('sqlite named the columns %r but the driver said %r' % (got, want))\n" + "con.close()\n" +
        "sys.stdout.write('OK')\n"
    let r = runPythonWithArg(script, rendered)
    if (!r.ok || r.stdout.trimAscii() != "OK") {
        @Fail("${what}: column names differ on `${query}`: ${r.describe()}")
    }
}

/**
 * 断言一段查询两侧都拒绝。
 */
public func expectBothReject(setup: Array<String>, query: String, what: String): Unit {
    requirePython()
    let conn = newMemConn()
    var driverRejected = false
    try {
        for (sql in setup) {
            conn.execString(sql)
        }
        try {
            let _ = conn.queryString(query)
        } catch (_: Exception) {
            driverRejected = true
        }
    } finally {
        conn.close()
    }
    let script = "import sqlite3, sys\n" + "con = sqlite3.connect(':memory:')\n" + "cur = con.cursor()\n" +
        "for s in ${pythonStringList(setup)}: cur.execute(s)\n" + "try:\n" +
        "    cur.execute(${pythonQuoted(query)}).fetchall()\n" + "except Exception:\n" + "    sys.stdout.write('OK')\n" +
        "    raise SystemExit(0)\n" + "raise SystemExit('sqlite accepted the query')\n"
    let r = runPython(script)
    let sqliteRejected = r.ok && r.stdout.trimAscii() == "OK"
    if (!sqliteRejected) {
        @Fail("${what}: real sqlite did **not** reject `${query}`, so this is not a rejection case: ${r.describe()}")
    }
    if (!driverRejected) {
        @Fail("${what}: real sqlite rejects `${query}` but the driver accepted it")
    }
}

/**
 * 断言一段代码抛异常。
 */
public func assertThrows(what: String, body: () -> Unit): Unit {
    try {
        body()
    } catch (_: Exception) {
        return
    }
    @Fail("${what}: expected an exception but the call returned normally")
}

/** 生成判据脚本所需的字符串字面量，并按目标语法转义内容。 */
func pythonQuoted(s: String): String {
    let sb = StringBuilder()
    sb.append("'")
    for (ch in s.toRuneArray()) {
        if (ch == r'\\') {
            sb.append("\\\\")
        } else if (ch == r'\'') {
            sb.append("\\'")
        } else if (ch == r'\n') {
            sb.append("\\n")
        } else if (ch == r'\r') {
            sb.append("\\r")
        } else {
            sb.append(ch)
        }
    }
    sb.append("'")
    sb.toString()
}

/** 生成判据脚本所需的列表字面量。 */
func pythonStringList(items: Array<String>): String {
    let sb = StringBuilder()
    sb.append("[")
    for (i in 0..items.size) {
        if (i > 0) {
            sb.append(", ")
        }
        sb.append(pythonQuoted(items[i]))
    }
    sb.append("]")
    sb.toString()
}
