package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.session.SessionStore
import itn_desktop_core.util.*

public func sessionTools(store: Store): ArrayList<DomainTool> {
    let out = ArrayList<DomainTool>()
    out.add(makeTool("read_session", "读取应用会话", "按会话ID或lumin://thread/链接读取Lumin里的对话记录，和工作目录无关",
        "用户要求阅读或接续Lumin会话时使用本工具。lumin://thread/ID是应用数据库记录，不是文件；不要用find/grep/powershell找会话，不要求用户导出。返回当前分支的用户/助手消息，长会话用nextOffset继续读取。",
        "{\"type\":\"object\",\"properties\":{\"session_id\":{\"type\":\"string\"},\"offset\":{\"type\":\"integer\"},\"limit\":{\"type\":\"integer\"}},\"required\":[\"session_id\"]}", "read", { args: JsonObject =>
            var sid = trimStr(strOf(args, "session_id"))
            if (hasPrefix(sid, "lumin://thread/")) { sid = sid.replace("lumin://thread/", "") }
            if (sid.size == 0 || sid.size > 100) { throw Exception("请提供有效的会话ID或lumin://thread/链接") }
            for (b in sid.toArray()) {
                if (!((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 45 || b == 95)) { throw Exception("会话ID格式不正确") }
            }
            let sessions = SessionStore(store.dataDir)
            let events = sessions.events(sid)
            if (events.size == 0) { throw Exception("本机找不到会话：" + sid + "。请确认链接来自这台设备；不需要在工作目录找文件。") }
            let messages = ArrayList<JsonObject>()
            let toolCounts = HashMap<String, Int64>()
            for (e in events) {
                let kind = strOf(e, "type")
                match (e.get("payload")) {
                    case Some(v) => match (objOf(v)) {
                        case Some(p) =>
                            if (kind == "user/message" || kind == "assistant/message") {
                                let m = JsonObject()
                                m.put("role", JsonString(if (kind == "user/message") { "user" } else { "assistant" }))
                                m.put("at", JsonString(strOf(e, "at")))
                                m.put("text", JsonString(byteSafePrefix(strOf(p, "text"), 12000)))
                                m.put("truncated", JsonBool(strOf(p, "text").size > 12000))
                                messages.add(m)
                            } else if (kind == "tool/call") {
                                let name = strOf(p, "tool")
                                toolCounts[name] = if (toolCounts.contains(name)) { toolCounts[name] + 1 } else { 1 }
                            }
                        case None => ()
                    }
                    case None => ()
                }
            }
            let offset = intOf(args, "offset")
            let limit = if (args.get("limit").isSome()) { intOf(args, "limit") } else { 20 }
            if (offset < 0 || limit < 1 || limit > 40) { throw Exception("分页范围不正确") }
            let page = JsonArray()
            var i = offset
            var bytes: Int64 = 0
            while (i < messages.size && i - offset < limit && bytes < 32000) { page.add(messages[i]); bytes += messages[i].toString().size; i += 1 }
            let data = JsonObject()
            data.put("sessionId", JsonString(sid)); data.put("title", JsonString(sessions.titleOf(sid)))
            data.put("total", JsonInt(messages.size)); data.put("messages", page)
            data.put("nextOffset", JsonInt(if (i < messages.size) { i } else { -1 }))
            let tools = JsonObject(); for ((name, count) in toolCounts) { tools.put(name, JsonInt(count)) }; data.put("toolSummary", tools)
            let result = DomainToolRun(); result.summary = "已读取应用会话「" + sessions.titleOf(sid) + "」，" + page.size().toString() + "/" + messages.size.toString() + " 条消息"
            result.content = data.toString(); result.details = data
            return result
        }))
    return out
}
