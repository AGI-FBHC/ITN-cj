package itn_desktop_core.pi_app

import std.collection.*
import std.convert.*
import std.time.*
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
import itn_desktop_core.agent.piRegistryOf
import itn_desktop_core.agent.piModeOf
import itn_desktop_core.agent.readSkill
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
        let sessions = SessionStore(store.dataDir)
        var sessionId = sessionIdIn
        if (sessionId.size == 0) {
            sessionId = sessions.newId()
        }
        let turnId = sessions.newTurnId()
        // 事件回调是 lambda：它只能捕获不可变变量（仓颉的规矩），所以这里留一份只读副本
        let sid = sessionId
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

        log("turn/start", kindPayload("ask", kbId))
        let up = JsonObject()
        up.put("text", JsonString(question))
        log("user/message", up)

        let cfgSettings = store.load()

        // ---- 联网策略（与手写那条链路同一套判断，不另立规矩）----
        let wmode = effectiveWebMode(store.dataDir, sessionId, webModeIn)
        let allowWeb = wmode != "off"
        let pp = JsonObject()
        pp.put("mode", JsonString(wmode))
        pp.put("webSearch", JsonBool(allowWeb && webSearchReady(store.dataDir)))
        pp.put("webFetch", JsonBool(allowWeb))
        pp.put("engine", JsonString("lumin"))
        log("web/policy", pp)

        // ---- 工具 ----
        // 默认只给领域工具（检索/联网/技能/笔记/产物）：模型碰不到本机文件。
        // 用户在设置里指定了工作目录之后，才把 read/write/edit/ls/find/grep（可选 powershell）挂上。
        let defs = buildDomainToolDefs(store, kbId, allowWeb)
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
                    approvalHub().ask(holder.kind, holder.value, holder.detail, holder.tool)
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
        var preamble = "You are the study assistant of ITN-Desktop. Answer with the local knowledge base; " +
            "cite the material you used as [1], [2] … and web pages as [W1]. If the material does not cover it, say so."
        match (readSkill(store.dataDir, skillIdIn, allowWeb)) {
            case Some(pair) =>
                preamble = preamble + "\n\n## Skill: " + pair[0].title + "\n" + byteSafePrefix(pair[1], 6000)
            case None => ()
        }
        agent.preamble = preamble

        // ---- 事件翻译 + 正文累积 ----
        let stream = EventStream()
        let answerBuf = StringBuilder()
        stream.on({ e: PiEvent =>
            let kind = kindText(e.kind)
            // turn 边界 = 一次模型请求，事件流里已经有了（turn_start/turn_end）；
            // 这里不再额外记"步骤"——这是 agent，步骤由它自己决定，不该由我们编。
            if (kind == "tool_execution_start") {
                let p = JsonObject()
                p.put("tool", JsonString(strOf(e.payload, "toolName")))
                p.put("callId", JsonString(strOf(e.payload, "callId")))
                log("tool/call", p)
                return
            }
            if (kind == "tool_execution_end") {
                let p = JsonObject()
                p.put("tool", JsonString(strOf(e.payload, "toolName")))
                p.put("callId", JsonString(strOf(e.payload, "callId")))
                p.put("ok", JsonBool(!boolOf(e.payload, "isError", false)))
                p.put("summary", JsonString(strOf(e.payload, "summary")))
                log("tool/result", p)
                return
            }
            if (kind == "message_update") {
                match (objOf(match (e.payload.get("assistantEvent")) { case Some(av) => av; case None => JsonNull() })) {
                    case Some(ae) =>
                        if (strOf(ae, "type") == "text_delta") {
                            let t = strOf(ae, "delta")
                            if (t.size > 0) {
                                answerBuf.append(t)
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
                if (msgs[i].role == AssistantMsg && msgs[i].text.size > 0) {
                    answer = msgs[i].text
                    break
                }
                i = i - 1
            }
        }
        if (answer.size == 0) {
            answer = "（这一轮没有拿到可用的回答，可以换个问法，或检查模型配置）"
        }
        let ap = JsonObject()
        ap.put("text", JsonString(answer))
        log("assistant/message", ap)

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
        if (!okk) {
            out.put("message", JsonString(if (outcome.error.size > 0) { outcome.error } else { "这一轮没有跑完" }))
        }
        return out
    }
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
