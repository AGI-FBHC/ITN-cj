package lumin.pi

import std.collection.*
import std.time.*

/*
 * 事件流：与 Pi 的 EventStream 同一个意思——生产者推、消费者按序取、末尾能拿到结果。
 *
 * 两条消费路径（Pi 也是这样）：
 *   on(fn)    界面看实时
 *   drain()   会话日志/持久化看全量
 *
 * 仓颉 1.2 没有 async，所以这里是同步等价物：push 即通知，finish/fail 表示一轮结束。
 */
public class EventStream {
    private let listeners = ArrayList<(PiEvent) -> Unit>()
    private var pending = ArrayList<PiEvent>()
    private var finalText: ?String = None
    private var failure: ?String = None
    private var abortFlag = false
    private var finished = false
    public var count: Int64 = 0

    public init() {}

    /** 注册消费者。立即生效，不重放已有事件。 */
    public func on(fn: (PiEvent) -> Unit): Unit {
        listeners.add(fn)
    }

    public func push(e: PiEvent): Unit {
        count = count + 1
        pending.add(e)
        for (fn in listeners) {
            fn(e)
        }
    }

    /** 取走还没被取过的事件（消费者二：落日志）。 */
    public func drain(): ArrayList<PiEvent> {
        let out = pending
        pending = ArrayList<PiEvent>()
        return out
    }

    public func pendingCount(): Int64 {
        return pending.size
    }

    public func finish(reason: String): Unit {
        finalText = Some(reason)
        finished = true
    }

    public func fail(message: String): Unit {
        failure = Some(message)
        finished = true
    }

    public func isFinished(): Bool {
        return finished
    }

    public func result(): ?String {
        return finalText
    }

    public func error(): ?String {
        return failure
    }

    public func abort(): Unit {
        abortFlag = true
    }

    public func aborted(): Bool {
        return abortFlag
    }

    public func listenerCount(): Int64 {
        return listeners.size
    }
}
