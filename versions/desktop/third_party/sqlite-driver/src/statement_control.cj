package sqlite_driver

import std.sync.*
import std.time.*

/** 一次预编译语句执行的取消标志与单调时钟截止时间。 */
class StatementControl {
    private let canceled = AtomicBool(false)
    private var timeoutMs: Int64 = 0
    private var deadline: Option<MonoTime> = None

    init() {}

    func setTimeoutMs(value: Int64): Unit {
        if (value < 0) {
            throw SqliteRuntimeException("statement", "timeout_ms must be a non-negative integer")
        }
        timeoutMs = value
    }

    func beginExecution(): Unit {
        canceled.store(false)
        deadline = if (timeoutMs == 0) {
            None
        } else {
            Some(MonoTime.now() + Duration.millisecond * timeoutMs)
        }
    }

    func cancel(): Unit {
        canceled.store(true)
    }

    func check(): Unit {
        if (canceled.load()) {
            throw SqliteInterruptedException("statement was canceled")
        }
        if (let Some(limit) <- deadline) {
            if (MonoTime.now() >= limit) {
                throw SqliteInterruptedException("statement exceeded timeout_ms=${timeoutMs}")
            }
        }
    }
}

/** 检查当前语句控制器；文本直执行没有控制器时是零成本空分支。 */
func checkStatementControl(db: SqliteDatabase): Unit {
    if (let Some(control) <- db.statementControl) {
        control.check()
    }
}

/** 在连接锁内启动计时，并保证嵌套触发器共享同一个取消信号。 */
func executeControlledStatement(db: SqliteDatabase, stmt: Stmt, params: Array<SqliteValue>,
    control: StatementControl): StatementResult {
    control.beginExecution()
    let previous = db.statementControl
    db.statementControl = Some(control)
    try {
        executeStatement(db, stmt, params)
    } finally {
        db.statementControl = previous
    }
}
