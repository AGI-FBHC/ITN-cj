package pi_cj

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import pi_cj.cli.*

/**
 * 走路演示：把运行时能干的四件事依次跑一遍，输出全部事件。
 * 这不是单元测试（断言在 src/unittests/），是给人看"事件流长什么样"的。
 */

func describe(e: PiEvent): String {
    match (e.kind) {
        case TurnStart => return "用户：" + e.text
        case TextDelta => return "正文增量：" + e.text
        case ThinkDelta => return "思考增量：" + e.text
        case ToolCallStart => return "模型要调工具：" + e.tool
        case ToolCallArg =>
            if (e.complete) {
                return "参数到齐：" + e.key + " = " + e.value
            }
            return "参数在到达：" + e.key + "（已收到 " + e.value.size.toString() + " 字节：" + e.value + "）"
        case ToolCallEnd => return e.tool + " 的参数收齐，可以执行"
        case PiEventKind.ToolResult => return e.tool + " 结果：" + e.text
        case TurnEnd => return "一轮结束：ok=" + e.ok.toString() + " stopReason=" + e.value
        case _ => return ""
    }
}

func dumpEvents(prefix: String, events: ArrayList<PiEvent>): Unit {
    for (e in events) {
        let line = describe(e)
        if (line.size > 0) {
            println(prefix + "[" + kindText(e.kind) + "] " + line)
        }
    }
}

func demoPartialParsing(): Unit {
    println("—— 1. 流式解析：工具参数边到边解析（Pi 的 toolcall_delta）——")
    let parser = PartialJsonParser()
    let pieces = [
        "{\"tool\":\"web_search\",\"args\":{\"query\":\"提示词工程在 2026 年有哪些新做法",
        "与实践案例\",\"limit\":5}}"
    ]
    for (p in pieces) {
        for (e in parser.push(p)) {
            let line = describe(e)
            if (line.size > 0) {
                println("   [" + kindText(e.kind) + "] " + line)
            }
        }
    }
    println("   参数收齐后：" + parser.view().argsJson().toString())
    println("")
}

func demoStandardTurn(): Unit {
    println("—— 2. 标准模式跑一轮（只有本机工具，联网工具没配密钥不出现）——")
    let session = PiSession(modeStandard())
    let kb = KbSearchTool()
    session.register(kb)
    session.register(SaveNoteTool())
    session.register(WebSearchTool())
    session.registry.markUnavailable("web_search", "没有配置 Tavily 密钥")
    println("   提示词里曝露给模型的工具：")
    for (s in session.registry.specsOf(session.mode)) {
        println("     - " + s.name + "（" + s.risk + "）")
    }
    let provider = ScriptedProvider([
        scriptTool("kb_search", "{\"query\":\"提示词的三要素\"}"),
        scriptText("提示词的三要素是角色、任务、格式 [1]。")
    ])
    let stream = EventStream()
    stream.on({ e: PiEvent =>
        let line = describe(e)
        if (line.size > 0) {
            println("     [" + kindText(e.kind) + "] " + line)
        }
    })
    let out = session.ask("提示词怎么写？", provider, stream)
    println("   最终回答：" + out.text)
    println("   模型轮数 " + out.steps.toString() + "，事件数 " + stream.count.toString() +
        "，stopReason=" + out.stopReason + "，历史 " + session.history.size().toString() + " 条")
    println("")
}

func demoResearchTurn(): Unit {
    println("—— 3. 研究模式：联网工具出现，回答里的网页引用会被自检 ——")
    let session = PiSession(modeResearch())
    let web = WebSearchTool()
    session.register(KbSearchTool())
    session.register(web)
    let names = ArrayList<String>()
    for (s in session.registry.specsOf(session.mode)) {
        names.add(s.name)
    }
    var hasWeb = false
    for (n in names) {
        if (n == "web_search") {
            hasWeb = true
        }
    }
    println("   这一模式可见工具 " + names.size.toString() + " 个，含 web_search=" + hasWeb.toString())
    println("   web_search 被标记为 external（审批门的判据）：" +
        session.registry.isExternal("web_search").toString())
    let provider = ScriptedProvider([
        scriptTool("web_search", "{\"query\":\"2026 提示词工程新做法\",\"limit\":5}"),
        scriptText("公开资料里 [W1] 提到结构化提示，[W2] 提到自动评估，另外 [W9] 也说过类似的话。")
    ])
    let stream = EventStream()
    let out = session.ask("上网看看 2026 年的新做法", provider, stream)
    println("   回答：" + out.text)
    println("   工具调用次数：" + web.calls.toString())
    var warns = 0
    for (w in out.warnings) {
        warns = warns + 1
        println("   自检警告 " + warns.toString() + "：" + w)
    }
    if (warns == 0) {
        println("   自检警告：无")
    }
    println("")
}

func demoGuards(): Unit {
    println("—— 4. 护栏：模式白名单 + 最大轮数 + 可中止 ——")
    let plain = PiSession(modePlain())
    plain.register(KbSearchTool())
    let p1 = ScriptedProvider([
        scriptTool("kb_search", "{\"query\":\"x\"}"),
        scriptText("不查资料，我直接回答。")
    ])
    let s1 = EventStream()
    let o1 = plain.ask("你好", p1, s1)
    println("   极简模式（不给工具）里模型仍想调工具 -> 被拒：" +
        (o1.toolResults.size > 0).toString() + "，回答=" + o1.text)

    let session = PiSession(modeStandard())
    session.register(KbSearchTool())
    session.config.maxSteps = 2
    let p2 = ScriptedProvider([
        scriptTool("kb_search", "{\"query\":\"a\"}"),
        scriptTool("kb_search", "{\"query\":\"b\"}")
    ])
    let s2 = EventStream()
    let o2 = session.ask("一直查下去", p2, s2)
    println("   模型反复调工具、maxSteps=2 -> ok=" + o2.ok.toString() +
        " stopReason=" + o2.stopReason + " 说明=" + o2.error)

    let s3 = EventStream()
    s3.on({ e: PiEvent =>
        if (kindText(e.kind) == "tool/result") {
            s3.abort()
        }
    })
    let session3 = PiSession(modeStandard())
    session3.register(KbSearchTool())
    session3.config.maxSteps = 4
    let p3 = ScriptedProvider([
        scriptTool("kb_search", "{\"query\":\"a\"}"),
        scriptText("本该继续，但被中止了")
    ])
    let o3 = session3.ask("试试中止", p3, s3)
    println("   收到工具结果后请求中止 -> ok=" + o3.ok.toString() + " stopReason=" + o3.stopReason)
    println("")
}

func runDemo(): Int64 {
    println("================ pi-cj 走路演示 ================")
    println("版本：" + piVersion() + "（Pi-Agent 风格实现，不是 Pi 源码移植）")
    println("")
    demoPartialParsing()
    demoStandardTurn()
    demoResearchTurn()
    demoGuards()
    println("================ 演示结束 ================")
    return 0
}

/**
 * 入口：
 *   pi-cj-demo.exe            走路演示（离线：假模型 + 假工具，不联网不读写文件）
 *   pi-cj-demo.exe demo       同上
 *   pi-cj-demo.exe chat ...   真实模型对话（配置见 scripts/chat.ps1 或 .env.local）
 */
main(args: Array<String>): Int64 {
    for (a in args) {
        if (a == "chat" || a == "ask") {
            return runChat(args)
        }
    }
    return runDemo()
}
