package itn_desktop_core.pi

import std.collection.*
import std.time.*
import stdx.encoding.json.*

/*
 * 消息模型：字段与 Pi 的 AgentMessage 对齐。
 * 角色：system / user / assistant / toolResult（Pi 的四种）。
 * 会话里存 Pi 的形状（content blocks + toolCalls），发给 OpenAI 兼容服务端时
 * 由提供方转成 chat 形状（见 toChatJson）。
 */

public enum MsgRole {
    | SystemMsg
    | UserMsg
    | AssistantMsg
    | ToolResultMsg

    /** 判别值：比较与排序都用它（仓颉的 enum 默认没有 ==）。 */
    public func tag(): Int64 {
        match (this) {
            case SystemMsg => return 0
            case UserMsg => return 1
            case AssistantMsg => return 2
            case ToolResultMsg => return 3
        }
    }

    public operator func ==(other: MsgRole): Bool {
        return this.tag() == other.tag()
    }

    public operator func !=(other: MsgRole): Bool {
        return this.tag() != other.tag()
    }
}

public func roleName(r: MsgRole): String {
    match (r) {
        case SystemMsg => return "system"
        case UserMsg => return "user"
        case AssistantMsg => return "assistant"
        case ToolResultMsg => return "toolResult"
    }
}

public func roleOf(s: String): ?MsgRole {
    if (s == "system") {
        return Some(SystemMsg)
    }
    if (s == "user") {
        return Some(UserMsg)
    }
    if (s == "assistant") {
        return Some(AssistantMsg)
    }
    if (s == "toolResult" || s == "tool") {
        return Some(ToolResultMsg)
    }
    return None
}

public func nowMillis(): Int64 {
    return DateTime.now().toUnixTimeStamp().toMilliseconds()
}

/** assistant 消息里的一次工具调用（对应 Pi 的 toolCall content block）。 */
public class ToolCallBlock {
    public var id: String = ""
    public var name: String = ""
    /** 原始参数 JSON 文本（流式拼出来的） */
    public var argsJson: String = "{}"

    public init(id: String, name: String, argsJson: String) {
        this.id = id
        this.name = name
        this.argsJson = argsJson
    }

    public func args(): JsonObject {
        try {
            match (JsonValue.fromStr(argsJson)) {
                case o: JsonObject => return o
                case _ => return JsonObject()
            }
        } catch (e: Exception) {
            return JsonObject()
        }
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("type", JsonString("toolCall"))
        o.put("id", JsonString(id))
        o.put("name", JsonString(name))
        o.put("arguments", args())
        return o
    }
}

public class Message {
    public var role: MsgRole
    public var text: String = ""
    /** assistant 才有：思考内容（Pi 的 thinking content block） */
    public var thinking: String = ""
    /** assistant 才有 */
    public let toolCalls = ArrayList<ToolCallBlock>()
    /** toolResult 才有 */
    public var toolCallId: String = ""
    public var toolName: String = ""
    public var isError: Bool = false
    /** assistant 才有：stop / length / toolUse / error / aborted */
    public var stopReason: String = "stop"
    public var model: String = ""
    public var ts: Int64 = 0

    public init(role: MsgRole) {
        this.role = role
        this.ts = nowMillis()
    }

    public func hasToolCalls(): Bool {
        return toolCalls.size > 0
    }

    /** 会话里存的形状（Pi 的 AgentMessage）。 */
    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("role", JsonString(roleName(role)))
        if (role == AssistantMsg) {
            let blocks = JsonArray()
            if (thinking.size > 0) {
                let th = JsonObject()
                th.put("type", JsonString("thinking"))
                th.put("thinking", JsonString(thinking))
                blocks.add(th)
            }
            if (text.size > 0) {
                let t = JsonObject()
                t.put("type", JsonString("text"))
                t.put("text", JsonString(text))
                blocks.add(t)
            }
            for (tc in toolCalls) {
                blocks.add(tc.toJson())
            }
            o.put("content", blocks)
            o.put("stopReason", JsonString(stopReason))
            if (model.size > 0) {
                o.put("model", JsonString(model))
            }
        } else if (role == ToolResultMsg) {
            let blocks = JsonArray()
            let t = JsonObject()
            t.put("type", JsonString("text"))
            t.put("text", JsonString(text))
            blocks.add(t)
            o.put("content", blocks)
            o.put("toolCallId", JsonString(toolCallId))
            o.put("toolName", JsonString(toolName))
            o.put("isError", JsonBool(isError))
        } else {
            o.put("content", JsonString(text))
        }
        o.put("timestamp", JsonInt(ts))
        return o
    }

    /** 发给 OpenAI 兼容服务端的形状。 */
    public func toChatJson(): JsonObject {
        let o = JsonObject()
        match (role) {
            case SystemMsg => o.put("role", JsonString("system"))
            case UserMsg => o.put("role", JsonString("user"))
            case AssistantMsg => o.put("role", JsonString("assistant"))
            case ToolResultMsg => o.put("role", JsonString("tool"))
        }
        if (role == ToolResultMsg) {
            o.put("tool_call_id", JsonString(toolCallId))
        }
        o.put("content", JsonString(text))
        if (role == AssistantMsg && toolCalls.size > 0) {
            let arr = JsonArray()
            for (tc in toolCalls) {
                let fn = JsonObject()
                fn.put("name", JsonString(tc.name))
                fn.put("arguments", JsonString(tc.argsJson))
                let e = JsonObject()
                e.put("id", JsonString(tc.id))
                e.put("type", JsonString("function"))
                e.put("function", fn)
                arr.add(e)
            }
            o.put("tool_calls", arr)
        }
        return o
    }
}

/** 反序列化：会话里的一条 message entry -> Message。 */
public func messageFromJson(o: JsonObject): ?Message {
    let roleText = strOf(o, "role")
    match (roleOf(roleText)) {
        case None => return None
        case Some(r) =>
            let m = Message(r)
            m.ts = intOf(o, "timestamp")
            if (r == AssistantMsg) {
                match (o.get("content")) {
                    case Some(v) =>
                        match (v) {
                            case blocks: JsonArray =>
                                var i = 0
                                while (i < blocks.size()) {
                                    match (blocks[i]) {
                                        case b: JsonObject =>
                                            if (strOf(b, "type") == "text") {
                                                m.text = m.text + strOf(b, "text")
                                            } else if (strOf(b, "type") == "toolCall") {
                                                let args = JsonObject()
                                                match (b.get("arguments")) {
                                                    case Some(av) => args.put("raw", av)
                                                    case None => ()
                                                }
                                                var argsText = "{}"
                                                match (b.get("arguments")) {
                                                    case Some(av) => argsText = jsonTextOf(av)
                                                    case None => ()
                                                }
                                                m.toolCalls.add(ToolCallBlock(strOf(b, "id"), strOf(b, "name"), argsText))
                                            }
                                        case _ => ()
                                    }
                                    i = i + 1
                                }
                            case s: JsonString => m.text = s.getValue()
                            case _ => ()
                        }
                    case None => ()
                }
                if (strOf(o, "stopReason").size > 0) {
                    m.stopReason = strOf(o, "stopReason")
                }
                m.model = strOf(o, "model")
            } else if (r == ToolResultMsg) {
                match (o.get("content")) {
                    case Some(v) =>
                        match (v) {
                            case blocks: JsonArray =>
                                var i = 0
                                while (i < blocks.size()) {
                                    match (blocks[i]) {
                                        case b: JsonObject => m.text = m.text + strOf(b, "text")
                                        case _ => ()
                                    }
                                    i = i + 1
                                }
                            case s: JsonString => m.text = s.getValue()
                            case _ => ()
                        }
                    case None => ()
                }
                m.toolCallId = strOf(o, "toolCallId")
                m.toolName = strOf(o, "toolName")
                m.isError = boolOf(o, "isError", false)
            } else {
                match (o.get("content")) {
                    case Some(v) =>
                        match (v) {
                            case s: JsonString => m.text = s.getValue()
                            case _ => ()
                        }
                    case None => ()
                }
            }
            return Some(m)
    }
}

/** JsonValue -> 一行文本（会话里存参数用）。 */
public func jsonTextOf(v: JsonValue): String {
    return v.toString()
}
