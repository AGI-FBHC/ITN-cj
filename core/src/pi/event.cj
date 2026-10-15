package itn_desktop_core.pi

import std.collection.*
import std.time.*
import stdx.encoding.json.*

/*
 * 事件：名字与字段照 Pi 的 AgentEvent。
 *
 *   agent_start / agent_end
 *   turn_start / turn_end              turn = 一次模型请求 + 它触发的工具
 *   message_start / message_update / message_end
 *   tool_execution_start / tool_execution_update / tool_execution_end
 *
 * message_update 只在 assistant 流式期间发，payload 里有 assistantEvent（Pi 的
 * AssistantMessageEvent：text_delta / thinking_delta / toolcall_delta ...）与当前的 partial message。
 * tool_execution_update 用来推"工具参数还在流式到达"的中间态。
 */

public enum EvKind {
    | AgentStart
    | AgentEnd
    | TurnStart
    | TurnEnd
    | MessageStart
    | MessageUpdate
    | MessageEnd
    | ToolExecStart
    | ToolExecUpdate
    | ToolExecEnd
}

public func kindText(k: EvKind): String {
    match (k) {
        case AgentStart => return "agent_start"
        case AgentEnd => return "agent_end"
        case TurnStart => return "turn_start"
        case TurnEnd => return "turn_end"
        case MessageStart => return "message_start"
        case MessageUpdate => return "message_update"
        case MessageEnd => return "message_end"
        case ToolExecStart => return "tool_execution_start"
        case ToolExecUpdate => return "tool_execution_update"
        case ToolExecEnd => return "tool_execution_end"
    }
}

/* 流式增量子类型（Pi 的 AssistantMessageEvent 里我们用得上的几个） */
public func deltaStart(): String { return "start" }
public func deltaTextStart(): String { return "text_start" }
public func deltaTextDelta(): String { return "text_delta" }
public func deltaTextEnd(): String { return "text_end" }
public func deltaThinkingStart(): String { return "thinking_start" }
public func deltaThinkingDelta(): String { return "thinking_delta" }
public func deltaThinkingEnd(): String { return "thinking_end" }
public func deltaToolCallStart(): String { return "toolcall_start" }
public func deltaToolCallDelta(): String { return "toolcall_delta" }
public func deltaToolCallEnd(): String { return "toolcall_end" }
public func deltaDone(): String { return "done" }

public class PiEvent {
    public let kind: EvKind
    public let payload = JsonObject()
    public var ts: String = ""

    public init(kind: EvKind) {
        this.kind = kind
        this.ts = DateTime.now().toString()
    }

    public func put(k: String, v: JsonValue): PiEvent {
        payload.put(k, v)
        return this
    }

    public func putStr(k: String, v: String): PiEvent {
        payload.put(k, JsonString(v))
        return this
    }

    public func putInt(k: String, v: Int64): PiEvent {
        payload.put(k, JsonInt(v))
        return this
    }

    public func putBool(k: String, v: Bool): PiEvent {
        payload.put(k, JsonBool(v))
        return this
    }

    /** 事件 JSON：{"type": "turn_start", ...payload} —— 与 Pi 的线上形状一致。 */
    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("type", JsonString(kindText(kind)))
        for ((k, v) in payload.getFields()) {
            o.put(k, v)
        }
        return o
    }

    /** 通用取值（测试与界面用）。 */
    public func str(k: String): String {
        return strOf(payload, k)
    }

    public func num(k: String): Int64 {
        return intOf(payload, k)
    }

    public func flag(k: String): Bool {
        return boolOf(payload, k, false)
    }

    /** message_update：assistantEvent 的子类型，例如 text_delta。 */
    public func deltaType(): String {
        match (payload.get("assistantEvent")) {
            case Some(v) =>
                match (objOf(v)) {
                    case Some(o) => return strOf(o, "type")
                    case None => return ""
                }
            case None => return ""
        }
    }

    public func delta(): String {
        match (payload.get("assistantEvent")) {
            case Some(v) =>
                match (objOf(v)) {
                    case Some(o) => return strOf(o, "delta")
                    case None => return ""
                }
            case None => return ""
        }
    }

    /** 事件里携带的消息（message_start/end/update）。 */
    public func messageJson(): ?JsonObject {
        match (payload.get("message")) {
            case Some(v) => return objOf(v)
            case None => return None
        }
    }

    /** toolcall 增量里那条调用的工具名（从 partial message 的 content 里取）。 */
    public func partialToolName(): String {
        match (messageJson()) {
            case Some(o) =>
                match (o.get("content")) {
                    case Some(v) =>
                        match (v) {
                            case a: JsonArray =>
                                var out = ""
                                var i = 0
                                while (i < a.size()) {
                                    match (a[i]) {
                                        case b: JsonObject =>
                                            if (strOf(b, "type") == "toolCall") {
                                                out = strOf(b, "name")
                                            }
                                        case _ => ()
                                    }
                                    i = i + 1
                                }
                                return out
                            case _ => return ""
                        }
                    case None => return ""
                }
            case None => return ""
        }
    }

    public func toolCallId(): String {
        return strOf(payload, "toolCallId")
    }

    public func toolName(): String {
        return strOf(payload, "toolName")
    }

    public func isError(): Bool {
        return boolOf(payload, "isError", false)
    }
}

/* ---------- 事件构造小助手：让循环里的代码短一点 ---------- */

public func evAgentStart(): PiEvent {
    return PiEvent(AgentStart)
}

public func evTurnStart(index: Int64): PiEvent {
    return PiEvent(TurnStart).putInt("index", index)
}

public func evMessageStart(m: Message): PiEvent {
    return PiEvent(MessageStart).put("message", m.toJson())
}

public func evMessageEnd(m: Message): PiEvent {
    return PiEvent(MessageEnd).put("message", m.toJson())
}

public func evMessageUpdate(deltaType: String, delta: String, m: Message): PiEvent {
    let ae = JsonObject()
    ae.put("type", JsonString(deltaType))
    if (delta.size > 0) {
        ae.put("delta", JsonString(delta))
    }
    return PiEvent(MessageUpdate).put("assistantEvent", ae).put("message", m.toJson())
}

public func evToolStart(callId: String, toolName: String, argsJson: String): PiEvent {
    return PiEvent(ToolExecStart).putStr("toolCallId", callId).putStr("toolName", toolName)
        .putStr("args", argsJson)
}

public func evToolUpdate(callId: String, toolName: String, partial: String): PiEvent {
    return PiEvent(ToolExecUpdate).putStr("toolCallId", callId).putStr("toolName", toolName)
        .putStr("partialResult", partial)
}

public func evToolEnd(callId: String, toolName: String, summary: String, isError: Bool, durationMs: Int64,
    details: JsonValue): PiEvent {
    let r = JsonObject()
    r.put("content", JsonString(summary))
    r.put("isError", JsonBool(isError))
    return PiEvent(ToolExecEnd).putStr("toolCallId", callId).putStr("toolName", toolName)
        .put("result", r).putBool("isError", isError).putInt("durationMs", durationMs)
        .putStr("summary", summary).put("details", details)
}

public func evTurnEnd(m: Message, toolResults: ArrayList<String>): PiEvent {
    let arr = JsonArray()
    for (t in toolResults) {
        arr.add(JsonString(t))
    }
    return PiEvent(TurnEnd).put("message", m.toJson()).put("toolResults", arr)
}

public func evAgentEnd(stopReason: String, turns: Int64): PiEvent {
    return PiEvent(AgentEnd).putStr("stopReason", stopReason).putInt("turns", turns)
}
