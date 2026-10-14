package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/**
 * 一条对话消息：role = system / user / assistant / tool。
 *
 * 后两个字段是给原生 function calling 用的（OpenAI 协议要求"模型要调工具"这条消息带 tool_calls、
 * "工具结果"这条带 tool_call_id，否则下一轮请求会被服务端拒掉）：
 *   toolCallsJson = 一整个 tool_calls 数组的 JSON 文本
 *   toolCallId    = 这条是哪个 tool_call 的结果
 * 不支持原生的服务端走的是"纯文本"路径，这两个字段都是空，序列化出来还是普通消息。
 */
public class ChatMessage {
    public var role: String = ""
    public var content: String = ""
    public var toolCallsJson: String = ""
    public var toolCallId: String = ""

    public init(role: String, content: String) {
        this.role = role
        this.content = content
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("role", JsonString(role))
        o.put("content", JsonString(content))
        if (toolCallsJson.size > 0) {
            try {
                o.put("tool_calls", JsonValue.fromStr(toolCallsJson))
            } catch (e: Exception) {
                ()
            }
        }
        if (toolCallId.size > 0) {
            o.put("tool_call_id", JsonString(toolCallId))
        }
        return o
    }
}

/** 把一段文本变成 JSON 字符串字面量（带引号、转义），用于把 arguments 嵌进 tool_calls。 */
func jsonStringLiteral(s: String): String {
    let b = s.toArray()
    let sb = StringBuilder()
    sb.append("\"")
    var i = 0
    while (i < b.size) {
        let c = b[i]
        if (c == 34) {
            sb.append("\\\"")
        } else if (c == 92) {
            sb.append("\\\\")
        } else if (c == 10) {
            sb.append("\\n")
        } else if (c == 13) {
            sb.append("\\r")
        } else if (c == 9) {
            sb.append("\\t")
        } else if (c < 128) {
            sb.append(String.fromUtf8(b[i..i + 1]))
        } else {
            let n = utf8CharLen(c)
            var j = i + n
            if (j > b.size) {
                j = b.size
            }
            sb.append(String.fromUtf8(b[i..j]))
            i = j
            continue
        }
        i = i + 1
    }
    sb.append("\"")
    return sb.toString()
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

    /**
     * 记下"模型这一步要调哪些工具"。
     *
     * 原生 function calling 要求把一次请求里的**全部** tool_calls 写在同一条 assistant 消息里，
     * 并且每一条都要有对应的 tool 结果消息；否则下一轮请求会被服务端拒掉。
     * 提示词协议没有 id，就退化成一句普通说明。
     */
    public func addToolCalls(requests: ArrayList<ToolRequest>): Unit {
        if (requests.size == 0) {
            return
        }
        var anyId = false
        for (r in requests) {
            if (r.id.size > 0) {
                anyId = true
            }
        }
        if (!anyId) {
            var note = ""
            for (r in requests) {
                if (note.size > 0) {
                    note = note + "；"
                }
                note = note + r.name + " 参数 " + r.args.toString()
            }
            add("assistant", "（调用工具 " + note + "）")
            return
        }
        var arr = "["
        var i: Int64 = 0
        while (i < requests.size) {
            if (i > 0) {
                arr = arr + ","
            }
            let r = requests[i]
            arr = arr + "{\"id\":\"" + r.id + "\",\"type\":\"function\",\"function\":{\"name\":\"" + r.name +
                "\",\"arguments\":" + jsonStringLiteral(r.args.toString()) + "}}"
            i = i + 1
        }
        arr = arr + "]"
        let m = ChatMessage("assistant", "")
        m.toolCallsJson = arr
        pushMsg(m)
    }

    private func pushMsg(m: ChatMessage): Unit {
        if (frozen) {
            pendingMsgs.add(m)
        } else {
            msgs.add(m)
        }
    }

    /** 记一条工具结果。有 id 就写成 role=tool + tool_call_id，否则写成普通文本消息。 */
    public func addToolResult(id: String, name: String, content: String): Unit {
        let m = ChatMessage("tool", content)
        m.toolCallId = id
        pushMsg(m)
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
