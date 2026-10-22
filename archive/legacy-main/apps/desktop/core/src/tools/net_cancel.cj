package itn_desktop_core.tools

import std.sync.*
import std.time.*

/** Each network call owns a watcher; cancelling one turn cannot close another turn's client. */
public class NetCancelWatch {
    let lock = Mutex()
    var done = false
    let shouldAbort: () -> Bool
    public init(shouldAbort: () -> Bool) { this.shouldAbort = shouldAbort }
    public func finish(): Unit { synchronized(lock) { done = true } }
    func finished(): Bool { synchronized(lock) { return done } }
    public func check(): Unit {
        if (shouldAbort()) { throw Exception("已取消") }
    }
    public func run(close: () -> Unit): Unit {
        while (!finished()) {
            sleep(Duration.millisecond * 100)
            if (finished()) { break }
            if (shouldAbort()) { close(); break }
        }
    }
}
