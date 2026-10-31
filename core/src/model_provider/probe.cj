package itn_desktop_core.model_provider

import std.collection.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.runtime.*

/*
 * 工具调用能力探测：给设置页的“测试工具调用”和演示预检脚本用。
 *
 * 连通测试只能证明“能聊天”；原生 function calling 是另一项能力。
 * 这里发一个最小请求，要求模型调用探测工具，再看 reply 里有没有 toolCalls。
 * 请求不进用户会话，也不计费到用户的用量统计里（它是诊断请求）。
 */

public func probeToolCalling(cfg: ModelConfig): JsonObject {
    let out = JsonObject()
    out.put("model", JsonString(cfg.model))
    if (cfg.model.size == 0) {
        out.put("ok", JsonBool(false))
        out.put("reason", JsonString("这个配置没有填写对话模型"))
        return out
    }
    let started = DateTime.now()
    let sawToolDelta = [false]
    try {
        let spec = ToolSpec("lumin_probe", "探测工具", "Probe",
            "调用它并传入 value=ok。",
            "{\"type\":\"object\",\"properties\":{\"value\":{\"type\":\"string\"}},\"required\":[\"value\"]}",
            "read")
        let ctx = StepContext()
        ctx.model = cfg.model
        ctx.system = "你是工具调用能力探测器。只调用给定的工具，不要解释，不要输出别的文字。"
        ctx.tools.add(spec)
        let um = Message(UserMsg)
        um.text = "请调用 lumin_probe，参数 value=ok"
        ctx.messages.add(um)

        let stream = EventStream()
        stream.on({ e: AgentEvent =>
            if (kindText(e.kind) == "message_update" && e.deltaType() == "toolcall_delta") {
                sawToolDelta[0] = true
            }
        })
        let reply = OpenAiChatProvider(cfg).respond(ctx, stream)
        let names = ArrayList<String>()
        var found = false
        for (c in reply.toolCalls) {
            names.add(c.name)
            if (c.name == "lumin_probe") { found = true }
        }
        let ok = found && reply.stopReason != "error"
        out.put("ok", JsonBool(ok))
        out.put("streamingToolCalls", JsonBool(sawToolDelta[0]))
        out.put("latencyMs", JsonInt((DateTime.now() - started).toMilliseconds()))
        let arr = JsonArray()
        for (n in names) { arr.add(JsonString(n)) }
        out.put("toolCalls", arr)
        if (!ok) {
            let reason = if (reply.stopReason == "error" && reply.errorMessage.size > 0) {
                reply.errorMessage
            } else {
                "模型没有返回 lumin_probe 工具调用（可能不支持原生 function calling）"
            }
            out.put("reason", JsonString(reason))
        }
    } catch (e: Exception) {
        out.put("ok", JsonBool(false))
        out.put("latencyMs", JsonInt((DateTime.now() - started).toMilliseconds()))
        out.put("reason", JsonString("探测失败：" + e.message))
    }
    return out
}
