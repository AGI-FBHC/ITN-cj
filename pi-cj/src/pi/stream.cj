package pi_cj.pi

import std.collection.*
import std.time.*

/**
 * 事件流。
 *
 * Pi 是一个"异步可迭代流"：生产者推、消费者按序消费、末尾能取到完整结果。
 * 仓颉 1.2 没有 async，这里用同步等价物表达同一件事：
 *
 * - `push(e)`：生产者推一个事件，**同步**通知所有监听者（界面/日志各一路消费者）
 * - `drain()`：拉走尚未被取走的事件（不注册监听者时的另一种消费方式）
 * - `finish(result)` / `fail(message)`：一轮结束，留下最终结果
 * - `abort()`：外部要求中止（对应我们的「停止生成」，这里由宿主注入判断，运行时不含业务）
 *
 * 两条消费者路径（对应 Pi 的设计）：界面看**实时**（onEvent 回调），会话日志看**持久**（drain 落库）。
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

    /** 注册一个消费者。立即生效，不重放已有事件。 */
    public func on(fn: (PiEvent) -> Unit): Unit {
        listeners.add(fn)
    }

    /** 生产者推事件：先入队（供 drain 取），再按注册顺序同步通知。 */
    public func push(e: PiEvent): Unit {
        if (e.at.size == 0) {
            e.at = DateTime.now().toString()
        }
        count = count + 1
        pending.add(e)
        for (fn in listeners) {
            fn(e)
        }
    }

    /** 便捷构造：带轮/步骤信息的事件。 */
    public func emit(kind: PiEventKind, turnId: String, step: Int64, text: String): PiEvent {
        let e = PiEvent(kind)
        e.turnId = turnId
        e.step = step
        e.text = text
        push(e)
        return e
    }

    /** 取走还没被取过的事件（消费者二：落日志）。 */
    public func drain(): ArrayList<PiEvent> {
        let out = pending
        pending = ArrayList<PiEvent>()
        return out
    }

    /** 还没被取走的事件数。 */
    public func pendingCount(): Int64 {
        return pending.size
    }

    public func finish(text: String): Unit {
        finalText = Some(text)
        finished = true
    }

    public func fail(message: String): Unit {
        failure = Some(message)
        finished = true
    }

    public func isFinished(): Bool {
        return finished
    }

    /** 最终正文；失败或未结束时返回 None。 */
    public func result(): ?String {
        return finalText
    }

    /** 失败原因；成功时 None。 */
    public func error(): ?String {
        return failure
    }

    /** 外部要求中止（宿主注入的策略：超时、用户点停止……）。 */
    public func abort(): Unit {
        abortFlag = true
    }

    public func aborted(): Bool {
        return abortFlag
    }

    /** 监听者数量，测试与诊断用。 */
    public func listenerCount(): Int64 {
        return listeners.size
    }
}