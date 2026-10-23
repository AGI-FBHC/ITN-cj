package itn_desktop_core.runtime_host

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.db.DbHub
import itn_desktop_core.session.SessionStore

/** Host checkpoint: native messages, including tool pairs and compacted summaries. */
public func checkpointContext(dataDir: String, sid: String, session: Session): Unit {
    let a = JsonArray()
    for (m in repairToolMessageOrder(session.messagesForModel())) { a.add(m.toJson()) }
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
        return restoreEventContext(dataDir, sid, currentTurn)
    }
    return repairToolMessageOrder(out)
}

/** Copy only the selected ancestry, never the parent's later checkpoint wholesale. */
public func checkpointBranchContext(dataDir: String, parentSid: String, branchSid: String): Unit {
    let sessions = SessionStore(dataDir)
    let parentEvents = sessions.events(parentSid)
    let branchEvents = sessions.events(branchSid)
    let allowed = HashSet<String>()
    for (event in branchEvents) { allowed.add(strOf(event, "turnId")) }
    let questions = ArrayList<(String, String)>()
    for (event in parentEvents) {
        if (strOf(event, "type") == "user/message") {
            let payload = objOf(event.get("payload").getOrThrow()).getOrThrow()
            questions.add((strOf(event, "turnId"), strOf(payload, "text")))
        }
    }
    let copied = ArrayList<Message>(); let seen = HashSet<String>()
    let native = restoreContext(dataDir, parentSid, "")
    var sameAncestry = parentEvents.size == branchEvents.size
    if (sameAncestry) {
        for (i in 0..parentEvents.size) {
            if (strOf(parentEvents[i], "turnId") != strOf(branchEvents[i], "turnId")) { sameAncestry = false }
        }
    }
    // A whole current branch may keep its compacted summary. An earlier fork
    // must never inherit a summary that also describes its parent's future.
    var complete = true
    var index: Int64 = 0; var turn = ""
    for (message in native) {
        if (!sameAncestry && hasPrefix(message.text, "（以下是本次会话更早内容的摘要）\n")) { complete = false }
        if (message.role == UserMsg && index < questions.size && message.text == questions[index][1]) {
            turn = questions[index][0]; seen.add(turn); index += 1
        }
        if (turn.size > 0 && allowed.contains(turn)) { copied.add(message) }
    }
    // A compacted checkpoint or another active ancestry cannot represent missing
    // older turns. Rebuild that exact branch from its own persisted event records.
    for (event in branchEvents) {
        if (strOf(event, "type") == "user/message" && !seen.contains(strOf(event, "turnId"))) { complete = false }
    }
    let messages = if (sameAncestry) { native } else if (complete) {
        repairToolMessageOrder(copied)
    } else { restoreEventContext(dataDir, branchSid, "") }
    let checkpoint = JsonArray(); for (message in messages) { checkpoint.add(message.toJson()) }
    DbHub.open(dataDir).putKv("sessions_meta", "context:" + branchSid, checkpoint.toString())
}

/** Legacy/compacted branches retain real recorded arguments, results and thinking. */
func restoreEventContext(dataDir: String, sid: String, currentTurn: String): ArrayList<Message> {
    let out = ArrayList<Message>()
    var pending = Message(AssistantMsg)
    for (event in SessionStore(dataDir).events(sid)) {
        if (currentTurn.size > 0 && strOf(event, "turnId") == currentTurn) { continue }
        let kind = strOf(event, "type")
        let payload = objOf(event.get("payload").getOrThrow()).getOrThrow()
        if (kind == "tool/call") {
            let args = match (payload.get("args")) { case Some(value) => value.toString(); case None => "{}" }
            pending.toolCalls.add(ToolCallBlock(strOf(payload, "callId"), strOf(payload, "tool"), args))
            continue
        }
        if (kind == "assistant/thinking") { pending.thinking += strOf(payload, "text"); continue }
        if (kind != "tool/result" && kind != "user/message" && kind != "assistant/message") { continue }
        if (pending.hasToolCalls()) {
            out.add(pending); pending = Message(AssistantMsg)
        }
        if (kind == "tool/result") {
            let message = Message(ToolResultMsg)
            message.toolCallId = strOf(payload, "callId"); message.toolName = strOf(payload, "tool")
            message.isError = !boolOf(payload, "ok", false)
            // Old logs have summaries/details rather than the raw model result.
            // Keep them explicitly labelled instead of inventing a tool response.
            let record = JsonObject(); record.put("summary", JsonString(strOf(payload, "summary")))
            match (payload.get("details")) { case Some(value) => record.put("details", value); case None => () }
            message.text = "历史工具记录：" + record.toString()
            out.add(message)
        } else {
            if (kind == "user/message") { pending = Message(AssistantMsg) }
            let text = strOf(payload, "text")
            if (text.size > 0) {
                let message = Message(if (kind == "user/message") { UserMsg } else { AssistantMsg })
                message.text = text
                if (kind == "user/message") { message.attachments = validatedAttachments(payload.get("attachments")) }
                else { message.thinking = pending.thinking; pending = Message(AssistantMsg) }
                out.add(message)
            }
        }
    }
    if (pending.hasToolCalls()) { out.add(pending) }
    return repairToolMessageOrder(out)
}
