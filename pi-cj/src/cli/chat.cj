package pi_cj.cli

import std.collection.*
import pi_cj.pi.*
import pi_cj.tools.*

/**
 * 命令行对话界面。
 *
 * 配置来源（优先级从高到低）：命令行参数 > 环境变量 > 当前目录的 .env.local > 内置默认。
 * 用文件放 Key 是为了不让密钥出现在命令行里（进程列表能看到）。
 */

/** 事件回调里要改的状态都放这里：类是引用类型，闭包改了外面才看得见。 */
class UiState {
    var printedText = false
    var thinkStarted = false
}

func modeListText(): String {
    var out = ""
    for (m in builtinModes()) {
        if (out.size > 0) {
            out = out + " / "
        }
        out = out + m.name
    }
    return out
}

func printHelp(): Unit {
    println("命令：")
    println("  :mode            看当前模式与全部模式名")
    println("  :mode research   切换模式（plain / standard / research / agent）")
    println("  :tools           看这一模式下给模型的工具，以及为什么有的没给")
    println("  :q               退出")
    println("其它任何输入都当问题发给模型。")
}

func printTools(session: PiSession): Unit {
    println("模式「" + session.mode.title + "」下曝露给模型的工具：")
    let allowed = session.registry.specsOf(session.mode)
    if (allowed.size == 0) {
        println("  （一个都没有：这是纯对话模式）")
    }
    for (s in allowed) {
        println("  " + s.name + "（" + s.risk + "）—— " + s.title)
    }
    println("已注册、但当前模式不给的：")
    var listed = false
    for (s in session.registry.specs()) {
        if (!session.mode.allows(s.name)) {
            listed = true
            println("  " + s.name)
        }
    }
    if (!listed) {
        println("  （无）")
    }
    println("注册了但当下不可用的：")
    var un = false
    for (s in session.registry.specs()) {
        if (!session.registry.available(s.name)) {
            un = true
            println("  " + s.name + "：" + session.registry.unavailableReason(s.name))
        }
    }
    if (!un) {
        println("  （无）")
    }
}

func askOnce(session: PiSession, provider: HttpChatProvider, question: String): Unit {
    let stream = EventStream()
    let ui = UiState()
    stream.on({ e: PiEvent =>
        let k = kindText(e.kind)
        if (k == "think/delta") {
            if (!ui.thinkStarted) {
                ui.thinkStarted = true
                print("\n[思考] ")
            }
            print(e.text)
        } else if (k == "text/delta") {
            if (!ui.printedText) {
                ui.printedText = true
                print("\n")
            }
            print(e.text)
        } else if (k == "tool/call_start") {
            let id = if (e.callId.size > 0) { "（call …" + tailBytes(e.callId, 8) + "）" } else { "" }
            println("\n[工具] 模型决定调用 " + e.tool + id)
        } else if (k == "tool/call_arg") {
            if (e.complete) {
                println("       " + e.key + " = " + preview(e.value, 200))
            }
        } else if (k == "tool/result") {
            let mark = if (e.ok) { "OK" } else { "失败" }
            println("[" + mark + "] " + e.tool + "：" + preview(e.text, 400))
        }
    })
    let out = session.ask(question, provider, stream)
    if (!ui.printedText && out.text.size > 0) {
        println("\n" + out.text)
    }
    println("")
    if (out.ok) {
        println("[完成] 模型轮次 " + out.steps.toString() + "，工具调用 " + out.toolResults.size.toString() +
            " 次，本次请求耗时 " + provider.lastMillis.toString() + " ms，结束原因 " + provider.lastFinish +
            "，用量 输入 " + provider.lastPromptTokens.toString() + " / 输出 " +
            provider.lastCompletionTokens.toString() + " tokens")
    } else {
        println("[失败] " + out.stopReason + "：" + out.error)
    }
    for (w in out.warnings) {
        println("[自检] " + w)
    }
}

public func runChat(args: Array<String>): Int64 {
    let env = loadEnvFile(".env.local")
    var base = cfgValue(env, "PI_CJ_BASE", "https://token-plan-cn.xiaomimimo.com/v1")
    var key = cfgValue(env, "PI_CJ_KEY", "")
    var model = cfgValue(env, "PI_CJ_MODEL", "mimo-v2.6-flash")
    var modeName = cfgValue(env, "PI_CJ_MODE", "standard")
    var wsRoot = cfgValue(env, "PI_CJ_WORKSPACE", ".")
    var allowExec = false
    var once = ""

    match (argValue(args, "--base")) {
        case Some(v) => base = v
        case None => ()
    }
    match (argValue(args, "--key")) {
        case Some(v) => key = v
        case None => ()
    }
    match (argValue(args, "--model")) {
        case Some(v) => model = v
        case None => ()
    }
    match (argValue(args, "--mode")) {
        case Some(v) => modeName = v
        case None => ()
    }
    match (argValue(args, "--workspace")) {
        case Some(v) => wsRoot = v
        case None => ()
    }
    match (argValue(args, "--ask")) {
        case Some(v) => once = v
        case None => ()
    }
    // 中文不要走 argv（Windows 下会让运行时在 main 之前崩）；用文件或标准输入
    match (argValue(args, "--ask-file")) {
        case Some(v) =>
            match (readTextFileSafe(v, 65536)) {
                case Some(t) => once = trimStr(t)
                case None =>
                    println("读不到问题文件：" + v)
                    return 2
            }
        case None => ()
    }
    if (hasFlag(args, "--ask-stdin")) {
        let sb = StringBuilder()
        while (true) {
            var line = ""
            try {
                line = readln()
            } catch (e: Exception) {
                break
            }
            sb.append(line)
            sb.append("\n")
        }
        once = trimStr(sb.toString())
    }
    if (hasFlag(args, "--allow-exec") || envOr("PI_CJ_ALLOW_EXEC", "") == "1") {
        allowExec = true
    }

    if (key.size == 0) {
        println("没有找到 API Key。两种办法：")
        println("  1) 在当前目录建 .env.local，写一行 PI_CJ_KEY=你的key（推荐，文件已在 .gitignore 里）")
        println("  2) 或者先设环境变量再运行")
        println("其它可配项：PI_CJ_BASE / PI_CJ_MODEL / PI_CJ_MODE / PI_CJ_WORKSPACE / PI_CJ_ALLOW_EXEC")
        return 2
    }

    let ws = Workspace(wsRoot)
    let session = PiSession(modeStandard())
    if (!session.switchMode(modeName)) {
        println("没有这个模式：" + modeName + "（可用：" + modeListText() + "）")
        return 2
    }
    registerWorkspaceTools(session.registry, ws, allowExec)
    session.systemPrompt = "你是 ITN 桌面端的本地助教。先看工具返回的事实再回答，不要编造；" +
        "工具没给到的信息就说不知道。回答用中文，简洁，需要时用列表。"

    let provider = HttpChatProvider(base, key, model)

    println("================ pi-cj 对话（真实模型）================")
    println("模型：" + model + "    接口：" + base)
    println("工作区：" + ws.root + "（模型只能在这里读写，命令也只在这里跑）")
    println("模式：" + session.mode.title + "    曝露工具 " +
        session.registry.specsOf(session.mode).size.toString() + " 件    执行命令：" +
        (if (allowExec) { "开" } else { "关（加 --allow-exec 才开）" }))
    println("直接输入问题回车发送；:help 看命令；:q 退出；中文问题也可以直接打（控制台是 UTF-8）")
    println("")

    if (once.size > 0) {
        askOnce(session, provider, once)
        return 0
    }

    while (true) {
        print("> ")
        var line = ""
        try {
            line = readln()
        } catch (e: Exception) {
            // EOF（管道喂完 / Ctrl+Z）就退出，不当成错误
            break
        }
        let t = trimStr(line)
        if (t.size == 0) {
            continue
        }
        if (t == ":q" || t == ":quit" || t == ":exit") {
            break
        }
        if (t == ":h" || t == ":help") {
            printHelp()
            continue
        }
        if (t == ":tools") {
            printTools(session)
            continue
        }
        if (hasPrefix(t, ":mode")) {
            let rest = trimStr(safeUtf8(t.toArray(), 5, t.size))
            if (rest.size == 0) {
                println("当前模式：" + session.mode.title + "（" + modeListText() + "）")
            } else if (session.switchMode(rest)) {
                println("已切到「" + session.mode.title + "」：" + session.mode.description + "；曝露工具 " +
                    session.registry.specsOf(session.mode).size.toString() + " 件")
            } else {
                println("没有这个模式：" + rest + "（可用：" + modeListText() + "）")
            }
            continue
        }
        askOnce(session, provider, t)
    }
    return 0
}
