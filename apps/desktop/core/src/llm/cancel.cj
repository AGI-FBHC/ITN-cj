package itn_desktop_core.llm

import std.sync.*
import std.time.*

/** A client belongs to one operation; cancellation never closes another task's request. */
class LlmCancelWatch {
    let lock = Mutex()
    var done = false
    let shouldAbort: () -> Bool
    init(shouldAbort: () -> Bool) { this.shouldAbort = shouldAbort }
    func finish(): Unit { synchronized(lock) { done = true } }
    func finished(): Bool { synchronized(lock) { return done } }
    func run(close: () -> Unit): Unit {
        while (!finished()) {
            sleep(Duration.millisecond * 100)
            if (finished()) { break }
            if (shouldAbort()) { close(); break }
        }
    }
}
