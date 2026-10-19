package itn_desktop_core.runtime_host

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.db.DbHub
import itn_desktop_core.session.SessionStore

/** Host checkpoint: native messages, including tool pairs and compacted summaries. */
public func checkpointContext(dataDir: String, sid: String, session: Session): Unit {
    let a = JsonArray()
    for (m in session.messagesForModel()) { a.add(m.toJson()) }
    DbHub.open(dataDir).putKv("sessions_meta", "context:" + sid, a.toString())
}

public func restoreContext(dataDir: String, sid: String, currentTurn: String): ArrayList<Message> {
    let out = ArrayList<Message>()
    let raw = DbHub.open(dataDir).getKv("sessions_meta", "context:" + sid, "")
    if (raw.size > 0) {
        match (JsonValue.fromStr(raw)) {
            case a: JsonArray =>
                var i = 0
                while (i < a.size()) {
                    match (objOf(a[i])) {
                        case Some(o) => match (messageFromJson(o)) { case Some(m) => out.add(m); case None => () }
                        case None => ()
                    }
                    i = i + 1
                }
            case _ => throw Exception("会话上下文格式损坏，保留原数据，请检查")
        }
    } else {
        // Legacy event logs never stored raw tool results; restore all available text honestly.
        for (e in SessionStore(dataDir).events(sid)) {
            if (strOf(e, "turnId") == currentTurn) { continue }
            let k = strOf(e, "type")
            if (k != "user/message" && k != "assistant/message") { continue }
            match (e.get("payload")) {
                case Some(p) => match (objOf(p)) {
                    case Some(o) =>
                        let t = strOf(o, "text")
                        if (t.size > 0) {
                            let m = Message(if (k == "user/message") { UserMsg } else { AssistantMsg })
                            m.text = t
                            out.add(m)
                        }
                    case None => ()
                }
                case None => ()
            }
        }
    }
    // A process may have stopped between an assistant tool call and its result.
    let pending = HashMap<String, String>()
    for (m in out) {
        for (c in m.toolCalls) { pending[c.id] = c.name }
        if (m.role == ToolResultMsg) { pending.remove(m.toolCallId) }
    }
    for ((id, name) in pending) {
        let m = Message(ToolResultMsg)
        m.toolCallId = id
        m.toolName = name
        m.isError = true
        m.text = "上次任务中断，未取得此工具结果。请检查实际状态后再决定是否重试。"
        out.add(m)
    }
    return out
}
