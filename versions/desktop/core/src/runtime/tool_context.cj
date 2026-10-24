package itn_desktop_core.runtime

import std.collection.*
import stdx.encoding.json.*

// Work on a view of history; the original messages and tool results remain intact.
public func repairToolMessageOrder(messages: ArrayList<Message>): ArrayList<Message> {
    let out = ArrayList<Message>()
    var i: Int64 = 0
    while (i < messages.size) {
        let message = messages[i]
        if (message.role == ToolResultMsg) {
            out.add(historicalToolRecord(message))
            i += 1
            continue
        }
        out.add(message)
        i += 1
        if (message.role != AssistantMsg || !message.hasToolCalls()) { continue }

        let expected = HashSet<String>()
        let received = HashSet<String>()
        let extras = ArrayList<Message>()
        for (call in message.toolCalls) { expected.add(call.id) }
        while (i < messages.size && messages[i].role == ToolResultMsg) {
            let result = messages[i]; i += 1
            if (expected.contains(result.toolCallId) && !received.contains(result.toolCallId)) {
                out.add(result)
                received.add(result.toolCallId)
            } else {
                extras.add(result)
            }
        }
        // Close interrupted exchanges before subsequent user/assistant messages.
        for (call in message.toolCalls) {
            if (received.contains(call.id)) { continue }
            let missing = Message(ToolResultMsg)
            missing.toolCallId = call.id
            missing.toolName = call.name
            missing.isError = true
            missing.text = "上次任务中断，未取得此工具结果。请检查实际状态后再决定是否重试。"
            out.add(missing)
            received.add(call.id)
        }
        for (result in extras) { out.add(historicalToolRecord(result)) }
    }
    return out
}

func historicalToolRecord(result: Message): Message {
    let record = Message(AssistantMsg)
    record.ts = result.ts
    let data = JsonObject()
    data.put("tool", JsonString(result.toolName))
    data.put("callId", JsonString(result.toolCallId))
    data.put("result", JsonString(result.text))
    data.put("isError", JsonBool(result.isError))
    record.text = "历史工具结果（关联调用已从上下文中省略，仅供参考，不是待执行操作）：\n" + data.toString()
    return record
}
