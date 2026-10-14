package xbot

import std.collection.*
import stdx.encoding.json.*
import xbot.pi.*
import xbot.cli.*

/*
 * 入口：
 *   xbot-demo.exe            离线走路演示（脚本模型 + 假工具，不联网不读写文件）
 *   xbot-demo.exe chat ...   真实模型对话（见 scripts/chat.ps1）
 */

func describe(e: PiEvent): String {
    let t = kindText(e.kind)
    if (t == "message_update") {
        let dt = e.deltaType()
        if (dt == deltaTextDelta()) {
            return "正文增量：" + e.delta()
        }
        if (dt == deltaThinkingDelta()) {
            return "思考增量：" + e.delta()
        }
        if (dt == deltaToolCallStart()) {
            return "模型开始发工具调用"
        }
        if (dt == deltaToolCallDelta()) {
            return "工具参数增量：" + e.delta()
        }
        return dt
    }
    if (t == "message_start" || t == "message_end") {
        match (e.messageJson()) {
            case Some(m) => return strOf(m, "role")
            case None => return ""
        }
    }
    if (t == "tool_execution_start") {
        return e.toolName() + " 参数 " + e.str("args")
    }
    if (t == "tool_execution_end") {
        return e.toolName() + "（" + (if (e.isError()) { "失败" } else { "成功" }) + "，" +
            e.num("durationMs").toString() + "ms）：" + e.str("summary")
    }
    if (t == "turn_start") {
        return "第 " + e.num("index").toString() + " 轮"
    }
    if (t == "turn_end") {
        return "这一轮结束"
    }
    if (t == "agent_end") {
        return e.str("stopReason")
    }
    return ""
}

func demoRegistry(): ToolRegistry {
    let reg = ToolRegistry()
    let spec = ToolSpec("echo", "回显", "Echo the text back",
        "把 text 原样回显，用来演示工具调用链路。",
        "{\"type\":\"object\",\"properties\":{\"text\":{\"type\":\"string\",\"description\":\"要回显的文字\"}},\"required\":[\"text\"]}",
        "read")
    reg.add(FuncTool(spec, { callId: String, args: JsonObject =>
        let text = strOf(args, "text")
        ToolResult.ok("回显 " + text, "echo 工具返回：" + text, JsonNull())
    }))
    return reg
}

func runDemo(): Int64 {
    println("================ xbot 走路演示 ================")
    println("循环与事件名照 Pi：agent_start / turn_start / message_* / tool_execution_* / agent_end")
    println("")
    let session = newSession("target/demo-data", "demo-workspace", "", "")
    let provider = ScriptedProvider([
        scriptTool("echo", "{\"text\":\"你好，这是回显\"}"),
        scriptText("工具已经回显了那句话。")
    ])
    let demoMode = Mode("demo", "演示", "只给一个假工具")
    demoMode.allow(["echo"])
    let opts = AgentOptions()
    opts.model = "scripted-model"
    let agent = Agent(provider, session, demoRegistry(), demoMode, opts)
    agent.preamble = "你是演示用的助手。"
    let stream = EventStream()
    stream.on({ e: PiEvent =>
        let d = describe(e)
        if (d.size > 0) {
            println("  [" + kindText(e.kind) + "] " + d)
        }
    })
    let out = agent.prompt("帮我回显一句你好", stream)
    println("")
    println("结果：" + (if (out.ok) { "成功" } else { "失败：" + out.error }) + "，轮次 " + out.turns.toString() +
        "，工具调用 " + out.toolResults.size.toString() + " 次")
    println("会话文件：" + session.path)
    println("会话里的 entry：" + session.entries.size.toString() + " 条")
    println("从会话重建给模型的消息：" + session.messagesForModel().size.toString() + " 条" +
        "（这就是续聊/分叉用的那条分支）")
    println("")
    println("================ 演示结束 ================")
    return 0
}

main(args: Array<String>): Int64 {
    for (a in args) {
        if (a == "chat" || a == "ask") {
            return runChat(args)
        }
    }
    return runDemo()
}
