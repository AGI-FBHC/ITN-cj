package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/** 一条对话消息：role = system / user / assistant / tool。 */
public class ChatMessage {
    public var role: String = ""
    public var content: String = ""

    public init(role: String, content: String) {
        this.role = role
        this.content = content
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("role", JsonString(role))
        o.put("content", JsonString(content))
        return o
    }
}

/**
 * 会话历史 + **冻结视图**（DeepSeek Harness 那条：同一 step 内上下文不可变）。
 *
 * 为什么非要冻结：模型调用是"边流边解析"的，一步里会陆陆续续产生增量事件。
 * 如果这些事件顺手往历史里写，那么"这一步究竟看到了什么上下文"就没人说得清了，
 * 事后回放同一个 session 会得到不同结果。所以：
 *
 *   freeze()  取一份快照交给模型；此后 add() 只会进待合并队列，不进快照
 *   thaw()    一步结束，把冻结期间新增的消息并进主历史
 *
 * 宿主接内核时，drain() 出来的事件与 history 一起落 session_events，两者互相印证。
 */
public class History {
    private let msgs = ArrayList<ChatMessage>()
    private var pendingMsgs = ArrayList<ChatMessage>()
    private var frozen = false

    public init() {}

    public func add(role: String, content: String): Unit {
        let m = ChatMessage(role, content)
        if (frozen) {
            pendingMsgs.add(m)
        } else {
            msgs.add(m)
        }
    }

    /** 冻结：返回当前快照（交给模型的那一份）。 */
    public func freeze(): JsonArray {
        frozen = true
        return view()
    }

    /** 解冻：把冻结期间新增的消息并进主历史。一个 step 结束必须调用一次。 */
    public func thaw(): Unit {
        frozen = false
        for (m in pendingMsgs) {
            msgs.add(m)
        }
        pendingMsgs = ArrayList<ChatMessage>()
    }

    public func isFrozen(): Bool {
        return frozen
    }

    /** 当前全部历史的快照。 */
    public func view(): JsonArray {
        let a = JsonArray()
        for (m in msgs) {
            a.add(m.toJson())
        }
        return a
    }

    /** 最近 keep 条消息的快照（内核目前是"最近 6 轮"的口径，即 keep = 12）。 */
    public func viewTail(keep: Int64): JsonArray {
        let a = JsonArray()
        var start: Int64 = 0
        if (msgs.size > keep) {
            start = msgs.size - keep
        }
        var i = start
        while (i < msgs.size) {
            a.add(msgs[i].toJson())
            i = i + 1
        }
        return a
    }

    public func size(): Int64 {
        return msgs.size
    }

    public func pendingCount(): Int64 {
        return pendingMsgs.size
    }

    public func roleAt(i: Int64): String {
        return msgs[i].role
    }

    public func contentAt(i: Int64): String {
        return msgs[i].content
    }
}
