package itn_desktop_core.pi_app

import std.collection.*
import std.convert.*
import std.time.*
import std.sync.*
import stdx.encoding.json.*
// pi 与内核有同名符号（Agent 尤其明显），所以这里通配 pi，内核侧一律具名导入
import itn_desktop_core.pi.*
import itn_desktop_core.pi_provider.*
import itn_desktop_core.store.Settings
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.store.Store
import itn_desktop_core.session.SessionEvent
import itn_desktop_core.session.SessionStore
import itn_desktop_core.agent.DomainTool
import itn_desktop_core.agent.ToolRecord
import itn_desktop_core.agent.buildDomainToolDefs
import itn_desktop_core.agent.buildDomainToolDefsWithCancel
import itn_desktop_core.agent.piRegistryOf
import itn_desktop_core.agent.piModeOf
import itn_desktop_core.agent.readSkill
import itn_desktop_core.agent.SkillInfo
import itn_desktop_core.agent.skillPrompt
import itn_desktop_core.agent.citationsFromHits
import itn_desktop_core.agent.citationReportWeb
import itn_desktop_core.agent.webCitationsFrom
import itn_desktop_core.tools.effectiveWebMode
import itn_desktop_core.tools.webSearchReady
import itn_desktop_core.pi_tools.Workspace
import itn_desktop_core.pi_tools.registerWorkspaceTools
import itn_desktop_core.lumin_cli.Approver
import itn_desktop_core.lumin_cli.permissionModeText
import itn_desktop_core.lumin_cli.classifyTool
// strOf / objOf / intOf / boolOf / byteSafePrefix 用 pi 包自带的那份（与 util 同名，通配 pi 已经带进来）：
// 两个包的同名函数同时具名导入会歧义，这是踩过的坑
import itn_desktop_core.kb.stamp

func usableHostSkill(dataDir: String, id: String, web: Bool): ?(SkillInfo, String) {
    match (readSkill(dataDir, id, web)) {
        case Some(pair) => if (pair[0].available) { return Some(pair) }
        case None => ()
    }
    return None
}

// The host skill allowlist is a product rule, kept outside lumin's runtime.
class HostSkillScope {
    let lock = Mutex()
    var id = ""
    var tools = ArrayList<String>()
    public func install(info: SkillInfo): Unit {
        synchronized(lock) { id = info.id; tools = info.tools }
    }
    public func check(dataDir: String, name: String, args: JsonObject, allowWeb: Bool): String {
        synchronized(lock) {
            if (id.size > 0 && !tools.contains(name)) { return "技能「" + id + "」未允许工具 " + name }
            if (name == "skill_read") {
                match (usableHostSkill(dataDir, strOf(args, "id"), allowWeb)) {
                    case Some(pair) => id = pair[0].id; tools = pair[0].tools
                    case None => return "技能不存在或在当前联网权限下不可用"
                }
            }
            return ""
        }
    }
}

class ActivityClock {
    var lastMillis: Int64 = 0
    public func ready(): Bool {
        let now = DateTime.now().toUnixTimeStamp().toMilliseconds()
        if (now - lastMillis < 1000) { return false }
        lastMillis = now
        return true
    }
}

/*
 * 用 lumin（pi 运行时）跑一轮问答。
 *
 * 与 agent.cj 里那套手写循环的区别（也是接它的理由）：
 *   - **原生 function calling**：工具清单按 OpenAI 的 tools 形状发给服务端，工具结果按 tool_call_id 回填；
 *     手写那套是"提示词协议"，模型得按格式吐一行 JSON（MiMo 不认，会吐 XML）。
 *   - 并行工具调用、半截 JSON 边到边解析、上下文超限自动压缩都在运行时里。
 *   - 事件名是 pi 的（agent_start、turn_start、message_xxx、tool_execution_xxx），这里**翻译成界面已经在用的那几个**
 *     （turn/start、assistant/delta、tool/call、tool/result…），所以前端一行都不用改。
 *
 * 领域能力（知识库检索、联网策略、技能白名单、引用自检）一点没变——它们现在是"工具"，
 * 由运行时按需调用，运行时本身仍然零网络、零文件 IO。
 */

/**
 * 正文分段器。
 *
 * 一轮里模型可能说好几段话（调工具前的讲解、拿到结果后的正文）。时间线要全留着，
 * 但"这一轮的答案"只取最后一次工具调用之后那段。包成类是因为仓颉的闭包捕获不了 var ——
 * 事件回调要能"重置"缓冲区，只能让它捕获一个可变对象。
 */
class AnswerSeg {
    public var buf = StringBuilder()

    public func reset(): Unit {
        buf = StringBuilder()
    }

    public func text(): String {
        return buf.toString()
    }
}

/** 分类结果的临时存放：审批层的 nextLine 是个无参回调，靠它把"正在问什么"带过去。 */
public class ApprovalPrompt {
    public var kind: String = ""
    public var value: String = ""
    public var detail: String = ""
    public var tool: String = ""

    public init() {}
}

/* 事件里那三个小载荷（与 agent.cj 里的形状逐字一致，界面靠它渲染步骤与轮次） */
func kindPayload(kind: String, kbId: String): JsonObject {
    let o = JsonObject()
    o.put("kind", JsonString(kind))
    o.put("kbId", JsonString(kbId))
    return o
}

func endPayload(ok: Bool, message: String): JsonObject {
    let o = JsonObject()
    o.put("ok", JsonBool(ok))
    if (message.size > 0) {
        o.put("message", JsonString(message))
    }
    return o
}

func stepPayload(index: Int64, name: String): JsonObject {
    let o = JsonObject()
    o.put("index", JsonInt(index))
    o.put("name", JsonString(name))
    return o
}

/**
 * 这一轮能不能动用户的电脑：工作目录 + 权限档位（就是 lumin 那三档）+ 要不要放开跑命令。
 *
 * 默认（不传）什么都不给：只有知识库检索、联网、技能那几个领域工具，
 * 模型碰不到本机文件 —— "一切默认都是 agent 判断"说的是**要不要联网/检索**，
 * 而"能不能改你的文件"这种事必须用户先点头（见设置里的开关）。
 */
public class WorkContext {
    public var dir: String = ""
    /** ask / auto / full —— 与 lumin 的权限档位同名同义 */
    public var perm: String = "ask"
    public var allowExec: Bool = false
    /** 测试用：非空就不等界面点，直接当回答（y/s/a/n） */
    public var autoAnswer: String = ""

    public init() {}
}

public class PiAgent {
    private let store: Store

    public init(store: Store) {
        this.store = store
    }

    /**
     * 一轮问答（真模型）。
     *
     * 只负责"取模型配置 → 建 provider"，剩下的交给 askWithProvider——
     * 这样测试可以塞一个 ScriptedProvider 进来，离线把整条链路（工具桥接、事件翻译、引用自检）跑一遍。
     */
    public func ask(kbId: String, question: String, sessionIdIn: String, webModeIn: String, skillIdIn: String): JsonObject {
        return askTask(kbId, question, sessionIdIn, webModeIn, skillIdIn, None)
    }

    /** 桌面版走这条：除了问答参数，还带上"能不能动本机文件"（工作目录 + 权限档位）。 */
    public func askTask(kbId: String, question: String, sessionIdIn: String, webModeIn: String, skillIdIn: String,
        work: ?WorkContext): JsonObject {
        let cfgSettings = store.load()
        var model: ?ModelConfig = None
        if (cfgSettings.chatModelId.size > 0) {
            model = cfgSettings.findModel(cfgSettings.chatModelId)
        }
        if (model.isNone() && cfgSettings.models.size > 0) {
            model = Some(cfgSettings.models[0])
        }
        match (model) {
            case None =>
                let sessions0 = SessionStore(store.dataDir)
                var sessionId0 = sessionIdIn
                if (sessionId0.size == 0) {
                    sessionId0 = sessions0.newId()
                }
                let e = SessionEvent()
                e.sessionId = sessionId0
                e.turnId = sessions0.newTurnId()
                e.kind = "turn/end"
                e.payload = endPayload(false, "没有可用的对话模型")
                sessions0.append(e)
                let out0 = JsonObject()
                out0.put("sessionId", JsonString(sessionId0))
                out0.put("ok", JsonBool(false))
                out0.put("message", JsonString("没有可用的对话模型，请先在设置里配置"))
                return out0
            case Some(cfg) =>
                let prov = OpenAiChatProvider(cfg)
                let sidForAbort = sessionIdIn
                // 界面按了停止 → provider 在下一个增量处收手（不然一轮长回答"停不下来"）
                prov.shouldAbort = Some({ => sessionHub().isAborted(sidForAbort) })
                return askFull(prov, kbId, question, sessionIdIn, webModeIn, skillIdIn, work)
        }
    }

    /** 一轮问答（用给定的 provider）。返回形状与 /api/agent/ask 完全一致：界面与自检脚本可以同题对照。 */
    public func askWithProvider(provider: ChatProvider, kbId: String, question: String, sessionIdIn: String,
        webModeIn: String, skillIdIn: String): JsonObject {
        return askFull(provider, kbId, question, sessionIdIn, webModeIn, skillIdIn, None)
    }

    /** 带工作区的那一版：给了 WorkContext 就会注册 read/write/edit/ls/find/grep（+ 可选 powershell），
        并挂上审批阀门 —— 写工作区外 / 跑命令 / 联网都要先问。 */
    public func askFull(provider: ChatProvider, kbId: String, question: String, sessionIdIn: String,
        webModeIn: String, skillIdIn: String, work: ?WorkContext): JsonObject {
        return runFull(provider, kbId, question, sessionIdIn, webModeIn, skillIdIn, work, "", "")
    }

    /**
     * 同一个生成任务（讲义 / 练习册）：也交给 lumin 当一次任务跑。
     *
     * 与问答的差别只有两处 —— 提示词说了"成品是什么、落到哪"，以及"没落盘时内核兜底"。
     * 刻意不写"先检索 → 拟大纲 → 逐节写作"：那是上一版网页端的工作流，写进代码就等于把 agent 的手脚绑住。
     * 要不要查资料、查几次、先写哪一节，都是模型自己的事（这就是"动态步骤"）。
     * 兜底只在模型压根没认 function calling 时生效，savedBy 会把"谁写的"如实告诉界面。
     */
    public func make(kind: String, kbId: String, topic: String, count: Int64, sessionIdIn: String,
        webModeIn: String, work: ?WorkContext): JsonObject {
        let cfgSettings = store.load()
        var model: ?ModelConfig = None
        if (cfgSettings.chatModelId.size > 0) {
            model = cfgSettings.findModel(cfgSettings.chatModelId)
        }
        if (model.isNone() && cfgSettings.models.size > 0) {
            model = Some(cfgSettings.models[0])
        }
        match (model) {
            case None =>
                let out0 = JsonObject()
                out0.put("sessionId", JsonString(sessionIdIn))
                out0.put("ok", JsonBool(false))
                out0.put("message", JsonString("没有可用的对话模型，请先在设置里配置"))
                return out0
            case Some(cfg) =>
                let prov = OpenAiChatProvider(cfg)
                let sidForAbort = sessionIdIn
                prov.shouldAbort = Some({ => sessionHub().isAborted(sidForAbort) })
                return runFull(prov, kbId, taskBrief(kind, topic, count), sessionIdIn, webModeIn, "", work,
                    kind, topic)
        }
    }

    /** 真正跑一轮：问答与产物任务共用这一条链路，区别只在 taskKind（""=问答）。 */
    public func runFull(provider: ChatProvider, kbId: String, question: String, sessionIdIn: String,
        webModeIn: String, skillIdIn: String, work: ?WorkContext, taskKind: String,
        taskTitle: String): JsonObject {
        let sessions = SessionStore(store.dataDir)
        var sessionId = sessionIdIn
        if (sessionId.size == 0) {
            sessionId = sessions.newId()
        }
        let turnId = sessions.newTurnId()
        // 事件回调是 lambda：它只能捕获不可变变量（仓颉的规矩），所以这里留一份只读副本
        let sid = sessionId
        // Bind cancellation after the actual session id exists, including API-created sessions.
        match (provider) {
            case p: OpenAiChatProvider => p.shouldAbort = Some({ => sessionHub().isAborted(sid) })
            case _ => ()
        }
        sessionHub().clearAbort(sid)
        let out = JsonObject()
        out.put("sessionId", JsonString(sid))

        func log(kind: String, payload: JsonObject): Unit {
            let e = SessionEvent()
            e.sessionId = sid
            e.turnId = turnId
            e.kind = kind
            e.payload = payload
            sessions.append(e)
        }

        log("turn/start", kindPayload(if (taskKind.size > 0) { taskKind } else { "ask" }, kbId))
        let up = JsonObject()
        up.put("text", JsonString(question))
        log("user/message", up)

        let cfgSettings = store.load()

        // ---- 联网策略（与手写那条链路同一套判断，不另立规矩）----
        let wmode = effectiveWebMode(store.dataDir, sessionId, webModeIn)
        let allowWeb = wmode != "off"
        let skillScope = HostSkillScope()
        if (skillIdIn.size > 0) {
            match (usableHostSkill(store.dataDir, skillIdIn, allowWeb)) {
                case Some(pair) =>
                    skillScope.install(pair[0])
                    let sp = JsonObject()
                    sp.put("id", JsonString(pair[0].id))
                    log("skill/read", sp)
                case None =>
                    let sp = JsonObject()
                    sp.put("id", JsonString(skillIdIn))
                    log("skill/unavailable", sp)
                    log("turn/end", endPayload(false, "技能不存在或当前权限不允许使用"))
                    out.put("ok", JsonBool(false))
                    out.put("message", JsonString("技能不存在或当前权限不允许使用"))
                    return out
            }
        }
        let pp = JsonObject()
        pp.put("mode", JsonString(wmode))
        pp.put("webSearch", JsonBool(allowWeb && webSearchReady(store.dataDir)))
        pp.put("webFetch", JsonBool(allowWeb))
        pp.put("engine", JsonString("lumin"))
        log("web/policy", pp)

        // ---- 工具 ----
        // 默认只给领域工具（检索/联网/技能/笔记/产物）：模型碰不到本机文件。
        // 用户在设置里指定了工作目录之后，才把 read/write/edit/ls/find/grep（可选 powershell）挂上。
        let defs = buildDomainToolDefsWithCancel(store, kbId, allowWeb, { => sessionHub().isAborted(sid) })
        let records = ArrayList<ToolRecord>()
        let registry = piRegistryOf(defs, records)
        let mode = piModeOf(defs, "desktop")
        var ws: ?Workspace = None
        var perm = "ask"
        match (work) {
            case Some(w) =>
                perm = if (w.perm.size > 0) { w.perm } else { "ask" }
                if (w.dir.size > 0) {
                    // 两条红线跟着 lumin：模型自己在用的配置、本应用的数据目录
                    let denyRoots = ArrayList<String>()
                    denyRoots.add(store.dataDir)
                    let denyFiles = ArrayList<String>()
                    denyFiles.add(".env.local")
                    denyFiles.add(".env")
                    let w0 = Workspace(w.dir, denyRoots, denyFiles, perm)
                    registerWorkspaceTools(registry, w0, w.allowExec && perm != "ask")
                    let names = ArrayList<String>()
                    names.add("read")
                    names.add("write")
                    names.add("edit")
                    names.add("ls")
                    names.add("find")
                    names.add("grep")
                    if (w.allowExec && perm != "ask") {
                        names.add("powershell")
                    }
                    for (nm in names) {
                        mode.allow([nm])
                    }
                    ws = Some(w0)
                }
            case None => ()
        }

        // ---- 会话：历史先灌进去，本轮提问由 prompt() 注入 ----
        let cwd = if (kbId.size > 0) { kbRootOf(cfgSettings, kbId, store.dataDir) } else { store.dataDir }
        let session = newSession(store.dataDir, cwd, "pi-" + sessionId, "")
        for (h in historyMessages(sessions, sessionId)) {
            let m = Message(if (strOf(h, "role") == "user") { UserMsg } else { AssistantMsg })
            m.text = strOf(h, "text")
            session.appendMessage(m)
        }

        let opts = AgentOptions()
        opts.maxTurns = 24
        opts.toolExecution = "parallel"
        opts.autoCompactBytes = 120000
        // 模型跑着的时候用户又打字：在"下一次模型请求之前"插进去（pi 的 steering）
        let sidForSteer = sid
        opts.getSteering = Some({ => sessionHub().takeSteering(sidForSteer) })
        let agent = Agent(provider, session, registry, mode, opts)
        match (ws) {
            case Some(w0) =>
                agent.workspaceRoot = w0.root
                // 审批阀门：分类 → 决策 → 审计。桌面版只把"取一行输入"换成"等界面点按钮"，
                // lumin 那套（四答、记住规则、批了把目录记进沙箱白名单）原样复用。
                let approver = Approver(store.dataDir, perm)
                approver.ws = Some(w0)
                match (work) {
                    case Some(w1) =>
                        if (w1.autoAnswer.size > 0) {
                            approver.autoAnswer = w1.autoAnswer
                        }
                    case None => ()
                }
                let holder = ApprovalPrompt()
                approver.nextLine = Some({ =>
                    approvalHub().askWithCancel(holder.kind, holder.value, holder.detail, holder.tool,
                        { => sessionHub().isAborted(sid) })
                })
                opts.beforeToolCall = Some({ callId: String, name: String, args: JsonObject =>
                    let cls = classifyTool(name, args, w0.root)
                    holder.kind = cls[0]
                    holder.value = cls[1]
                    holder.detail = cls[2]
                    holder.tool = name
                    approver.checkTool(agent, name, args)
                })
            case None => ()
        }
        // 登记"正在跑"，让 /api/agent/cancel 找得到它，也让插话有地方落
        sessionHub().markRunning(sid, agent)
        // 这一段是"身份 + 语言 + 纪律"，**不写流程**。
        // Compose the host's skill guard with lumin's permission gate; neither replaces the other.
        let permissionGate = opts.beforeToolCall
        opts.beforeToolCall = Some({ callId: String, name: String, args: JsonObject =>
            if (sessionHub().isAborted(sid)) { return "已取消" }
            let denied = skillScope.check(store.dataDir, name, args, allowWeb)
            if (denied.size > 0) {
                let sp = JsonObject()
                sp.put("tool", JsonString(name))
                sp.put("reason", JsonString(denied))
                log("tool/denied", sp)
                return denied
            }
            if (name == "skill_read") {
                let sp = JsonObject()
                sp.put("id", JsonString(strOf(args, "id")))
                log("skill/read", sp)
            }
            return match (permissionGate) {
                case Some(gate) => gate(callId, name, args)
                case None => ""
            }
        })

        // 上一版那句 "Answer with the local knowledge base…" 是把"先检索"写进了提示词：
        // 结果每问一句，模型第一件事就是 kb_search。工具是可选的，用不用、用几次由它按问题判断。
        var preamble = "你是 ITN-Desktop 里的学习助手，跑在用户自己的电脑上。回答一律用中文；" +
            "思考过程也用中文（代码、报错原文、专有名词保留英文即可）。不要复述这段设定。\n" +
            "手上的工具是可选的：要不要查知识库、要不要联网、查几次，由你按问题自己判断 —— " +
            "既不要为了显得勤奋每次都去检索，也不要明明有资料可查却凭印象作答。" +
            "拿不准的事实先核实，核实不到就直接说不知道。\n" +
            "用到本机资料里的内容时按 [1]、[2] 标注出处，用到网上抓来的页面时按 [W1]、[W2] 标注并写出链接。" +
            "回答简短，列表能说清就用列表；不要客套话，也不要把过程复述一遍。"
        if (taskKind.size > 0) {
            preamble = preamble + "\n这是一次产物生成任务：成品要写完整，最后用 save_artifact 落盘，" +
                "再用一两句话告诉用户文件名。"
        }
        match (usableHostSkill(store.dataDir, skillIdIn, allowWeb)) {
            case Some(pair) =>
                preamble = preamble + "\n\n## Skill: " + pair[0].title + "\n" + byteSafePrefix(pair[1], 6000)
            case None => ()
        }
        // Advertise metadata only. The model loads a skill body through skill_read as needed.
        agent.preamble = preamble + skillPrompt(store.dataDir, allowWeb)

        // ---- 事件翻译 + 正文累积 ----
        let stream = EventStream()
        // 时间线要留住每一段正文；但"这一轮的答案/产物"只该取**最后一次工具调用之后**那段 ——
        // 否则模型查资料时的"让我看看…"讲解会和正文糊在一起（实测被当成讲义存了下来）。
        let answerBuf = StringBuilder()
        let seg = AnswerSeg()
        let activityClock = ActivityClock()
        stream.on({ e: PiEvent =>
            let kind = kindText(e.kind)
            // turn 边界 = 一次模型请求，事件流里已经有了（turn_start/turn_end）；
            // 这里不再额外记"步骤"——这是 agent，步骤由它自己决定，不该由我们编。
            if (kind == "tool_execution_start") {
                // 又调了一次工具：刚才那段是过程，不计入最终答案
                seg.reset()
                let p = JsonObject()
                p.put("tool", JsonString(strOf(e.payload, "toolName")))
                p.put("callId", JsonString(strOf(e.payload, "toolCallId")))
                log("tool/call", p)
                return
            }
            if (kind == "tool_execution_end") {
                let p = JsonObject()
                p.put("tool", JsonString(strOf(e.payload, "toolName")))
                p.put("callId", JsonString(strOf(e.payload, "toolCallId")))
                p.put("ok", JsonBool(!boolOf(e.payload, "isError", false)))
                p.put("summary", JsonString(strOf(e.payload, "summary")))
                log("tool/result", p)
                return
            }
            if (kind == "message_update") {
                match (objOf(match (e.payload.get("assistantEvent")) { case Some(av) => av; case None => JsonNull() })) {
                    case Some(ae) =>
                        if (strOf(ae, "type") == "thinking_delta" && activityClock.ready()) {
                            let dp = JsonObject()
                            dp.put("phase", JsonString("thinking"))
                            log("assistant/activity", dp)
                        } else if (strOf(ae, "type") == "text_delta") {
                            let t = strOf(ae, "delta")
                            if (t.size > 0) {
                                answerBuf.append(t)
                                seg.buf.append(t)
                                let dp = JsonObject()
                                dp.put("text", JsonString(t))
                                log("assistant/delta", dp)
                            }
                        }
                    case None => ()
                }
                return
            }
            ()
        })

        let outcome = agent.prompt(question, stream)
        sessionHub().clearRunning(sid)

        // 没有流式增量时（例如服务端一次性返回），退回会话里最后一条 assistant 正文
        var answer = answerBuf.toString()
        if (answer.size == 0) {
            let msgs = session.messagesForModel()
            var i = msgs.size - 1
            while (i >= 0) {
                if (msgs[i].role == UserMsg) { break }
                if (msgs[i].role == AssistantMsg && msgs[i].text.size > 0) {
                    answer = msgs[i].text
                    break
                }
                i = i - 1
            }
        }
        if (answer.size == 0 && outcome.ok) {
            answer = "（这一轮没有拿到可用的回答，可以换个问法，或检查模型配置）"
        } else {
            let tail = seg.text()
            if (tail.size > 0) {
                answer = tail
            }
        }
        let ap = JsonObject()
        ap.put("text", JsonString(answer))
        if (answer.size > 0) { log("assistant/message", ap) }

        // ---- 引用自检：命中来自 kb_search 的工具记录（结构化载荷），与手写链路同一套算法 ----
        var hits = JsonArray()
        let webSources = ArrayList<JsonObject>()
        var wi = 0
        for (r in records) {
            if (r.name == "kb_search" && r.ok) {
                match (r.details) {
                    case a: JsonArray =>
                        if (hits.size() == 0) {
                            hits = a
                        }
                    case _ => ()
                }
            }
            if ((r.name == "web_fetch" || r.name == "web_search") && r.ok) {
                wi = wi + 1
                let src = JsonObject()
                src.put("index", JsonInt(wi))
                src.put("title", JsonString(r.summary))
                src.put("url", JsonString(""))
                src.put("fetchedAt", JsonString(stamp()))
                webSources.add(src)
            }
        }
        // ---- 产物：模型自己调 save_artifact 落了盘，就从工具记录里取路径 ----
        var artifactPath = ""
        for (r in records) {
            if (r.name == "save_artifact" && r.ok) {
                match (r.details) {
                    case sv: JsonString => artifactPath = sv.getValue()
                    case _ => ()
                }
            }
        }
        var savedBy = if (artifactPath.size > 0) { "model" } else { "" }
        if (artifactPath.size == 0 && taskKind.size > 0 && outcome.ok && answer.size > 0) {
            // 兜底：模型这一轮没自己落盘（有些服务不认 function calling），
            // 内核把正文写成产物，免得用户看到"生成好了"却什么都没有。
            let p0 = saveArtifactVia(defs, artifactNameOf(taskKind, taskTitle), answer)
            if (p0.size > 0) {
                artifactPath = p0
                savedBy = "kernel"
            }
        }
        let report = citationReportWeb(answer, hits.size(), webSources.size)
        let cites = citationsFromHits(hits)
        let webCites = webCitationsFrom(answer, webSources)
        var wci = 0
        while (wci < webCites.size()) {
            cites.add(webCites[wci])
            wci = wci + 1
        }
        let vp = JsonObject()
        vp.put("report", report)
        vp.put("citations", cites)
        log("validation", vp)

        let okk = outcome.ok
        log("turn/end", endPayload(okk, outcome.error))
        out.put("ok", JsonBool(okk))
        out.put("answer", JsonString(answer))
        out.put("citations", cites)
        out.put("citationReport", report)
        out.put("webMode", JsonString(wmode))
        out.put("turns", JsonInt(outcome.turns))
        out.put("stopReason", JsonString(outcome.stopReason))
        out.put("artifactPath", JsonString(artifactPath))
        out.put("savedBy", JsonString(savedBy))
        if (!okk) {
            out.put("message", JsonString(if (outcome.error.size > 0) { outcome.error } else { "这一轮没有跑完" }))
        }
        return out
    }
}

/**
 * 任务简报：只说"成品是什么样、最后落到哪"，不说"先干什么后干什么"。
 * 步骤由模型自己排 —— 这才是 agent；固定步骤是工作流，上一版的形状。
 */
func taskBrief(kind: String, topic: String, count: Int64): String {
    if (kind == "quiz") {
        return "按「" + topic + "」出一份练习册：" + count.toString() + " 道题，覆盖不同的考点。" +
            "每题给出题干、选项（或填空位）、参考答案与一句解析。" +
            "资料以当前知识库为准，需要就去查；资料没讲到的地方明说，不要编。" +
            "写完后用 save_artifact 落盘，文件名用「练习册-" + topic + ".md」。"
    }
    return "把「" + topic + "」做成一份讲义，写成 Markdown：" +
        "概念、为什么、怎么做各讲清楚，配例子，用小标题分段。" +
        "资料以当前知识库为准，需要就去查；资料没讲到的地方明说，不要编。" +
        "写完后用 save_artifact 落盘，文件名用「讲义-" + topic + ".md」。"
}

/** 产物的文件名（内核兜底落盘时用；模型自己落盘时按提示词里的名字）。 */
func artifactNameOf(kind: String, topic: String): String {
    return (if (kind == "quiz") { "练习册-" } else { "讲义-" }) + topic + ".md"
}

/**
 * 借领域工具自己那份 save_artifact 落盘。
 *
 * 为什么不直接引内核的 ToolRegistry：pi 那个包也有同名类型，两边同时通配导入会歧义（踩过）。
 * defs 本来就在手上，找回来调一次，谁也不用看见对方。
 */
func saveArtifactVia(defs: ArrayList<DomainTool>, name: String, content: String): String {
    for (d in defs) {
        if (d.name == "save_artifact") {
            let args = JsonObject()
            args.put("name", JsonString(name))
            args.put("content", JsonString(content))
            let r = d.run(args)
            if (!r.ok) {
                return ""
            }
            match (r.details) {
                case sv: JsonString => return sv.getValue()
                case _ => return ""
            }
        }
    }
    return ""
}

/** 从事件里取最近几条 user/assistant 消息，灌进 pi 的会话做多轮上下文。 */
func historyMessages(sessions: SessionStore, sessionId: String): ArrayList<JsonObject> {
    let all = ArrayList<JsonObject>()
    for (e in sessions.events(sessionId)) {
        let kind = strOf(e, "type")
        if (kind != "user/message" && kind != "assistant/message") {
            continue
        }
        var text = ""
        match (e.get("payload")) {
            case Some(pv) =>
                match (objOf(pv)) {
                    case Some(po) => text = strOf(po, "text")
                    case None => ()
                }
            case None => ()
        }
        if (text.size == 0) {
            continue
        }
        let m = JsonObject()
        m.put("role", JsonString(if (kind == "user/message") { "user" } else { "assistant" }))
        m.put("text", JsonString(text))
        all.add(m)
    }
    // 只留最后 8 条（4 轮），免得每次请求都背着整段历史
    let out = ArrayList<JsonObject>()
    var start = all.size - 8
    if (start < 0) {
        start = 0
    }
    var i = start
    while (i < all.size) {
        out.add(all[i])
        i = i + 1
    }
    return out
}

/** 这个知识库的资料目录（给 pi 会话当工作目录用；没有就退回数据目录）。 */
func kbRootOf(cfg: Settings, kbId: String, dataDir: String): String {
    match (cfg.findKb(kbId)) {
        case Some(kb) =>
            if (kb.rootDir.size > 0) {
                return kb.rootDir
            }
            return dataDir
        case None => return dataDir
    }
}
