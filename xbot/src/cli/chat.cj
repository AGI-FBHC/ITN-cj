package xbot.cli

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import xbot.pi.*
import xbot.tools.*

/*
 * 命令行界面（不做 TUI，定位是"拿来测这个 harness"）。
 *
 * 命令照 Pi 用斜杠：
 *   /help /tools /skills /sessions /new /resume <id> /compact /model <名字> /mode <档> /skill:<名字> /quit
 * 配置：命令行参数 > 环境变量 > 当前目录的 .env.local；Key 不走命令行（进程列表能看到）。
 */

/** 事件回调里要改的状态：类是引用类型，闭包改了外面才看得见。 */
class UiState {
    var thinkOpen = false
    var textOpen = false
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
    println("  /help                    看这份说明")
    println("  /tools                   看当前档位给模型的工具（以及为什么有的没给）")
    println("  /skills                  看扫到哪些 skills")
    println("  /sessions                看这个目录下的会话")
    println("  /workspace               看/管理工作区：list（列出）、add <目录> [名字]、open <名字|目录>、rm <名字>")
    println("  /new                     开一个新会话")
    println("  /resume <id 前缀>         切到某个旧会话（续聊）")
    println("  /compact                 把前面的对话压成摘要（省上下文）")
    println("  /model <名字>             换模型（如 mimo-v2.6-pro）")
    println("  /mode <档位>              换工具集：" + modeListText())
    println("  /skill:<名字> [要求]       强制加载某个 skill 再干活")
    println("  /quit                    退出")
    println("其它任何输入都当问题发给模型。")
}

func printTools(reg: ToolRegistry, mode: Mode): Unit {
    println("工具集「" + mode.title + "」给模型的工具：")
    let allowed = reg.specsOf(mode)
    if (allowed.size == 0) {
        println("  （一个都没有：纯对话）")
    }
    for (s in allowed) {
        println("  " + s.name + "（" + s.risk + "）—— " + s.snippet + "：" + s.label)
    }
    println("注册了但这一档不给的：")
    var any = false
    for (s in reg.allSpecs()) {
        if (!mode.allows(s.name)) {
            any = true
            println("  " + s.name)
        }
    }
    if (!any) {
        println("  （无）")
    }
    var un = false
    for (s in reg.allSpecs()) {
        if (!reg.available(s.name)) {
            un = true
            println("  不可用：" + s.name + "：" + reg.unavailableReason(s.name))
        }
    }
    if (!un) {
        println("  不可用：（无）")
    }
}

func printSkills(skills: ArrayList<Skill>): Unit {
    if (skills.size == 0) {
        println("没扫到 skills。放法：<工作区>/.pi/skills/<名字>/SKILL.md，或 ~/.agents/skills/<名字>/SKILL.md")
        return
    }
    println("扫到 " + skills.size.toString() + " 个 skill：")
    for (s in skills) {
        let flag = if (s.disableModelInvocation) { "（只允许手动 /skill: 触发）" } else { "" }
        println("  " + s.name + flag)
        println("     " + s.description)
        println("     " + s.path)
    }
}

func printWorkspaces(dataDir: String, currentPath: String): Unit {
    let list = loadWorkspaces(dataDir)
    println("当前工作区：" + currentPath)
    if (list.size == 0) {
        println("还没有登记过别的工作区。用 /workspace add <目录> [名字] 加一个（启动时给过的目录会自动登记）")
        return
    }
    println("登记的工作区（" + list.size.toString() + " 个）：")
    for (w in list) {
        let mark = if (w.path == currentPath) { " ←当前" } else { "" }
        let alive = if (exists(w.path)) { "" } else { "（目录已不在）" }
        println("  " + w.name + "  " + w.path + "  会话 " +
            sessionCountOf(dataDir, w.path).toString() + " 个" + alive + mark)
    }
}

/** 会话文件按文件名（内含时间戳）取最新。 */
func latestSession(dataDir: String, cwd: String): String {
    let files = listSessionFiles(dataDir, cwd)
    var best = ""
    for (f in files) {
        if (f > best) {
            best = f
        }
    }
    return best
}

func sessionLabel(path: String): String {
    let s = loadSession(path)
    let nm = s.name()
    let first = s.firstUserText()
    let title = if (nm.size > 0) { nm } else if (first.size > 0) { first } else { "（空会话）" }
    let slash = path.toArray()
    var start: Int64 = path.size - 1
    while (start > 0 && slash[start] != 47 && slash[start] != 92) {
        start = start - 1
    }
    let file = safeUtf8(slash, start + 1, path.size)
    return file + "  " + title
}

func printSessions(dataDir: String, cwd: String): Unit {
    let files = listSessionFiles(dataDir, cwd)
    if (files.size == 0) {
        println("这个目录下还没有会话。")
        return
    }
    println("会话（按文件名排序，新的在后）：")
    var sorted = ArrayList<String>()
    for (f in files) {
        var inserted = false
        var i = 0
        while (i < sorted.size) {
            if (f < sorted[i]) {
                sorted.add("")
                var j = sorted.size - 1
                while (j > i) {
                    sorted[j] = sorted[j - 1]
                    j = j - 1
                }
                sorted[i] = f
                inserted = true
                break
            }
            i = i + 1
        }
        if (!inserted) {
            sorted.add(f)
        }
    }
    var k = sorted.size - 1
    while (k >= 0) {
        println("  " + sessionLabel(sorted[k]))
        k = k - 1
    }
}

/* ---------- 事件打印 ---------- */

func attachPrinter(stream: EventStream, wsRoot: String): UiState {
    let ui = UiState()
    stream.on({ e: PiEvent =>
        let t = kindText(e.kind)
        if (t == "message_update") {
            let dt = e.deltaType()
            let d = e.delta()
            if (dt == deltaThinkingDelta()) {
                if (!ui.thinkOpen) {
                    ui.thinkOpen = true
                    print("\n[思考] ")
                }
                print(d)
            } else if (dt == deltaTextDelta()) {
                if (ui.thinkOpen) {
                    ui.thinkOpen = false
                    print("\n")
                }
                print(d)
                ui.textOpen = true
            } else if (dt == deltaToolCallStart()) {
                print("\n[工具] 模型决定调用：" + e.partialToolName())
            } else if (dt == deltaToolCallDelta()) {
                print(".")
            }
        } else if (t == "tool_execution_start") {
            ui.thinkOpen = false
            ui.textOpen = false
            let nm = e.toolName()
            println("\n[执行] " + nm + "  参数 " + preview(e.str("args"), 200))
            // 写/改文件时把绝对路径打出来 —— 用户最需要的就是"文件到底在哪"
            if (nm == "write" || nm == "edit") {
                let rel = pathFromArgs(e.str("args"))
                if (rel.size > 0) {
                    println("       → 文件绝对路径：" + joinPath(wsRoot, rel))
                }
            }
        } else if (t == "tool_execution_end") {
            let mark = if (e.isError()) { "失败" } else { "完成" }
            println("[" + mark + "] " + e.toolName() + "：" + preview(e.str("summary"), 300) + "（" +
                e.num("durationMs").toString() + "ms）")
        } else if (t == "turn_end") {
            println("")
        }
    })
    return ui
}

/** 从工具参数 JSON 里取 path（拿不到就空串）。 */
func pathFromArgs(argsJson: String): String {
    let t = trimStr(argsJson)
    if (t.size == 0) {
        return ""
    }
    try {
        match (JsonValue.fromStr(t)) {
            case o: JsonObject => return strOf(o, "path")
            case _ => return ""
        }
    } catch (e: Exception) {
        return ""
    }
}

/* ---------- 一轮对话 ---------- */

func runOnce(agent: Agent, text: String, wsRoot: String): Unit {
    let stream = EventStream()
    attachPrinter(stream, wsRoot)
    let compactBefore = agent.compactCount
    let out = agent.prompt(text, stream)
    if (agent.compactCount > compactBefore) {
        println("[上下文] " + agent.lastCompactNote)
    }
    println("")
    if (out.ok) {
        println("[完成] 轮次 " + out.turns.toString() + "，工具 " + out.toolResults.size.toString() +
            " 次，用量 " + out.usageIn.toString() + "/" + out.usageOut.toString() + " tokens")
    } else {
        println("[失败] " + out.stopReason + "：" + out.error)
    }
    for (w in out.warnings) {
        println("[注意] " + w)
    }
}

func pickSession(dataDir: String, cwd: String, continueLast: Bool, sessionId: String): Session {
    if (continueLast || sessionId.size > 0) {
        let files = listSessionFiles(dataDir, cwd)
        var best = ""
        var k = 0
        while (k < files.size) {
            let f = files[k]
            if (sessionId.size == 0 || containsSub(f, sessionId)) {
                if (f > best) {
                    best = f
                }
            }
            k = k + 1
        }
        if (best.size > 0) {
            let s = loadSession(best)
            if (s.entries.size > 0) {
                return s
            }
        }
        println("没找到可续的会话，开个新的。")
    }
    return newSession(dataDir, cwd, "", "")
}

/* ---------- 入口 ---------- */

public func runChat(args: Array<String>): Int64 {
    let env = loadEnvFile(".env.local")
    var base = cfgValue(env, "XBOT_BASE", "https://token-plan-cn.xiaomimimo.com/v1")
    var key = cfgValue(env, "XBOT_KEY", "")
    var model = cfgValue(env, "XBOT_MODEL", "mimo-v2.6-flash")
    var modeName = cfgValue(env, "XBOT_MODE", "standard")
    var wsRoot = cfgValue(env, "XBOT_WORKSPACE", "")   // 空 = 启动目录（Pi 的 cwd 语义）
    var dataDir = cfgValue(env, "XBOT_DATA", homeDir() + "/.xbot")
    var allowExec = false
    var once = ""
    var continueLast = false
    var sessionId = ""

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
    match (argValue(args, "--data-dir")) {
        case Some(v) => dataDir = v
        case None => ()
    }
    match (argValue(args, "--session-id")) {
        case Some(v) => sessionId = v
        case None => ()
    }
    match (argValue(args, "--ask")) {
        case Some(v) => once = v
        case None => ()
    }
    match (argValue(args, "--ask-file")) {
        case Some(v) =>
            match (readTextFileSafe(v, 256 * 1024)) {
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
    if (hasFlag(args, "--continue")) {
        continueLast = true
    }
    if (hasFlag(args, "--allow-exec") || envOr("XBOT_ALLOW_EXEC", "") == "1") {
        allowExec = true
    }

    if (key.size == 0) {
        println("没有找到 API Key。两种办法：")
        println("  1) 在当前目录建 .env.local，写一行 XBOT_KEY=你的key（推荐，文件已在 .gitignore 里）")
        println("  2) 或者先设环境变量再运行")
        println("其它可配项：XBOT_BASE / XBOT_MODEL / XBOT_MODE / XBOT_WORKSPACE / XBOT_DATA / XBOT_ALLOW_EXEC")
        return 2
    }

    // --workspace 既可以是登记过的名字，也可以是目录；用过的目录会自动登记
    let wsPath = resolveWorkspace(dataDir, wsRoot)

    // ---- 项目信任（照 Pi 的 project trust；我们的 trust 还决定"给不给工具"）----
    var trust = TrustDecision()
    if (hasFlag(args, "--trust")) {
        trust.trusted = true
        trust.decided = true
        trust.source = "--trust"
        setTrust(dataDir, wsPath, true, false)
    } else if (hasFlag(args, "--no-trust")) {
        trust.trusted = false
        trust.decided = true
        trust.source = "--no-trust"
        setTrust(dataDir, wsPath, false, false)
    } else {
        trust = findTrust(dataDir, wsPath)
        if (!trust.decided && once.size == 0) {
            // 交互式才问；--ask-file 这种一次性调用不打断，默认不信任
            trust = askTrust(wsPath)
            setTrust(dataDir, wsPath, trust.trusted, trust.sessionOnly)
        }
        if (!trust.decided) {
            trust.trusted = false
            trust.source = wsPath + "（没问过，按不信任处理）"
        }
    }

    let denyRoots = ArrayList<String>()
    denyRoots.add(dataDir)
    var ws = Workspace(wsPath, denyRoots)
    var mode = match (findMode(modeName)) {
        case Some(m) => m
        case None =>
            println("没有这个档位：" + modeName + "（可用：" + modeListText() + "）")
            return 2
    }
    if (!trust.trusted) {
        println("")
        println("这个目录还没被信任：" + wsPath)
        println("（依据：" + trust.source + "）所以这次只给纯对话 —— 工具一个都不给。")
        println("要放开：重启加 --trust，或者对话里用 /trust on（会记住）。")
        mode = modeChat()
    }


    let roots = ArrayList<String>()
    roots.add(ws.root + "/.pi/skills")
    roots.add(ws.root + "/.agents/skills")
    roots.add(dataDir + "/skills")
    roots.add(homeDir() + "/.agents/skills")
    let skills = loadSkills(roots)

    var reg = ToolRegistry()
    if (trust.trusted) {
        registerWorkspaceTools(reg, ws, allowExec)
    }

    var session = pickSession(dataDir, ws.root, continueLast, sessionId)
    let provider = HttpChatProvider(base, key, model)
    let opts = AgentOptions()
    opts.model = model
    let agent = Agent(provider, session, reg, mode, opts)
    agent.preamble = "You are XBot, a coding assistant running on the user's machine. Answer in Chinese. " +
        "Use the tools to check facts instead of guessing; say so when you do not know. " +
        "Keep answers short; use lists when they help."
    agent.skillsText = formatSkillsForPrompt(skills)

    println("================ XBot（Pi 风格 harness）================")
    println("模型：" + model + "    接口：" + base)
    println("工作区：" + ws.root + "   （这就是模型能读写、跑命令的目录；绝对路径）")
    println("信任：  " + (if (trust.trusted) { "已信任" } else { "未信任（只给纯对话）" }) + "  依据： " +
        trust.source)
    println("会话：" + session.path)
    println("（/workspace 管工作区；/trust 管信任；/help 看全部命令）")
    println("工具集：" + mode.title + "（" + reg.specsOf(mode).size.toString() + " 件）    命令执行：" +
        (if (allowExec) { "开" } else { "关（加 --allow-exec 才开）" }) + "    skills：" +
        skills.size.toString() + " 个")
    println("直接打字提问；/help 看命令；/quit 退出")
    if (once.size > 0) {
        runOnce(agent, once, ws.root)
        return 0
    }

    while (true) {
        print("\n> ")
        var line = ""
        try {
            line = readln()
        } catch (e: Exception) {
            break
        }
        let t = trimStr(line)
        if (t.size == 0) {
            continue
        }
        if (t == "/quit" || t == "/q" || t == "/exit") {
            break
        }
        if (t == "/help" || t == "/h") {
            printHelp()
            continue
        }
        if (t == "/tools") {
            printTools(reg, agent.mode)
            continue
        }
        if (t == "/skills") {
            printSkills(skills)
            continue
        }
        if (t == "/sessions") {
            printSessions(dataDir, ws.root)
            continue
        }
        if (t == "/new") {
            agent.session = newSession(dataDir, ws.root, "", "")
            println("新会话：" + agent.session.path)
            continue
        }
        if (hasPrefix(t, "/resume")) {
            let rest = trimStr(safeUtf8(t.toArray(), 7, t.size))
            let p = pickSession(dataDir, ws.root, true, rest)
            if (p.entries.size == 0) {
                println("没找到匹配的会话：" + rest)
            } else {
                agent.session = p
                println("切到会话：" + p.path + "（" + p.entries.size.toString() + " 条记录）")
            }
            continue
        }
        if (hasPrefix(t, "/workspace") || hasPrefix(t, "/ws")) {
            let cut = if (hasPrefix(t, "/workspace")) { 10 } else { 3 }
            let rest = trimStr(safeUtf8(t.toArray(), cut, t.size))
            if (rest.size == 0 || rest == "list" || rest == "ls") {
                printWorkspaces(dataDir, ws.root)
            } else if (hasPrefix(rest, "add")) {
                let arg = trimStr(safeUtf8(rest.toArray(), 3, rest.size))
                if (arg.size == 0) {
                    println("用法：/workspace add <目录> [名字]")
                } else {
                    var p1 = arg
                    var n1 = ""
                    let sp = indexOfSub(arg, " ")
                    if (sp > 0) {
                        p1 = safeUtf8(arg.toArray(), 0, sp)
                        n1 = trimStr(safeUtf8(arg.toArray(), sp + 1, arg.size))
                    }
                    let nm = registerWorkspace(dataDir, p1, n1)
                    println("已登记工作区「" + nm + "」-> " + absPath(p1))
                }
            } else if (hasPrefix(rest, "open") || hasPrefix(rest, "use")) {
                let arg = trimStr(safeUtf8(rest.toArray(), 4, rest.size))
                if (arg.size == 0) {
                    println("用法：/workspace open <名字|目录>")
                } else {
                    let newPath = resolveWorkspace(dataDir, arg)
                    if (!exists(newPath)) {
                        println("这个目录不存在：" + newPath)
                    } else {
                        ws = Workspace(newPath, denyRoots)
                        let reg2 = ToolRegistry()
                        registerWorkspaceTools(reg2, ws, allowExec)
                        reg = reg2
                        agent.registry = reg2
                        agent.session = pickSession(dataDir, ws.root, true, "")
                        println("已切到工作区：" + ws.root)
                        println("  工具 " + reg.specsOf(agent.mode).size.toString() + " 件；当前会话 " +
                            agent.session.path)
                    }
                }
            } else if (hasPrefix(rest, "rm") || hasPrefix(rest, "remove")) {
                let arg = trimStr(safeUtf8(rest.toArray(), 2, rest.size))
                if (removeWorkspace(dataDir, arg)) {
                    println("已取消登记：" + arg + "（目录本身没删）")
                } else {
                    println("没有登记过这个名字：" + arg)
                }
            } else {
                println("用法：/workspace [list | add <目录> [名字] | open <名字|目录> | rm <名字>]")
            }
            continue
        }
        if (hasPrefix(t, "/trust")) {
            let rest = trimStr(safeUtf8(t.toArray(), 6, t.size))
            if (rest.size == 0) {
                let now = findTrust(dataDir, ws.root)
                println("当前目录：" + ws.root)
                if (now.decided) {
                    println("信任状态：" + (if (now.trusted) { "已信任" } else { "不信任" }) + "  依据：" + now.source)
                } else {
                    println("信任状态：没问过（按不信任处理）")
                }
                println("用法：/trust on | /trust off | /trust clear")
            } else if (rest == "on" || rest == "off") {
                let yes = (rest == "on")
                setTrust(dataDir, ws.root, yes, false)
                trust.trusted = yes
                trust.decided = true
                trust.source = ws.root
                reg = ToolRegistry()
                if (yes) {
                    registerWorkspaceTools(reg, ws, allowExec)
                    println("已信任并记住：" + ws.root + "；工具 " + reg.specsOf(agent.mode).size.toString() + " 件")
                } else {
                    agent.mode = modeChat()
                    println("已设为不信任：" + ws.root + "；工具全部关掉（当前档位改成纯对话）")
                }
                agent.registry = reg
            } else if (rest == "clear") {
                if (clearTrust(dataDir, ws.root)) {
                    println("已撤销信任记录：" + ws.root + "（下次启动会重新问）")
                } else {
                    println("这个目录本来就没记录。")
                }
            } else {
                println("用法：/trust on | /trust off | /trust clear")
            }
            continue
        }
        if (t == "/compact") {
            agent.compact(2, EventStream())
            println(agent.lastCompactNote)
            continue
        }
        if (hasPrefix(t, "/mode")) {
            let rest = trimStr(safeUtf8(t.toArray(), 5, t.size))
            if (rest.size == 0) {
                println("当前档位：" + agent.mode.title + "（" + modeListText() + "）")
            } else {
                match (findMode(rest)) {
                    case Some(m2) =>
                        agent.mode = m2
                        println("已切到「" + m2.title + "」：" + m2.description + "；工具 " +
                            reg.specsOf(m2).size.toString() + " 件")
                    case None => println("没有这个档位：" + rest + "（可用：" + modeListText() + "）")
                }
            }
            continue
        }
        if (hasPrefix(t, "/model")) {
            let rest = trimStr(safeUtf8(t.toArray(), 6, t.size))
            if (rest.size == 0) {
                println("当前模型：" + opts.model)
            } else {
                opts.model = rest
                agent.session.appendModelChange(rest)
                println("已切到模型：" + rest)
            }
            continue
        }
        if (hasPrefix(t, "/skill:")) {
            let rest = trimStr(safeUtf8(t.toArray(), 7, t.size))
            var namePart = rest
            var argPart = ""
            let sp = indexOfSub(rest, " ")
            if (sp > 0) {
                namePart = safeUtf8(rest.toArray(), 0, sp)
                argPart = trimStr(safeUtf8(rest.toArray(), sp + 1, rest.size))
            }
            match (findSkill(skills, namePart)) {
                case Some(sk) =>
                    match (readTextFileSafe(sk.path, 256 * 1024)) {
                        case Some(body) =>
                            var promptText = "按这个 skill 的说明做事：\n\n" + body
                            if (argPart.size > 0) {
                                promptText = promptText + "\n\n用户要求：" + argPart
                            }
                            println("[skill] 已加载 " + sk.name + "（" + body.size.toString() + " 字节）")
                            runOnce(agent, promptText, ws.root)
                        case None => println("读不到 " + sk.path)
                    }
                case None =>
                    println("没有这个 skill：" + namePart + "（用 /skills 看有哪些）")
            }
            continue
        }
        runOnce(agent, t, ws.root)
    }
    return 0
}
