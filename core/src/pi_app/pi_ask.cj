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
                return askWithProvider(OpenAiChatProvider(cfg), kbId, question, sessionIdIn, webModeIn, skillIdIn)
        }
    }

    /** 一轮问答（用给定的 provider）。返回形状与 /api/agent/ask 完全一致：界面与自检脚本可以同题对照。 */
    public func askWithProvider(provider: ChatProvider, kbId: String, question: String, sessionIdIn: String,
        webModeIn: String, skillIdIn: String): JsonObject {
        let sessions = SessionStore(store.dataDir)
        var sessionId = sessionIdIn
        if (sessionId.size == 0) {
            sessionId = sessions.newId()
        }
        let turnId = sessions.newTurnId()
        // 事件回调是 lambda：它只能捕获不可变变量（仓颉的规矩），所以这里留一份只读副本
        let sid = sessionId
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
        log("step/start", stepPayload(1, "retrieve"))

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
        let defs = buildDomainToolDefs(store, kbId, allowWeb)
        let records = ArrayList<ToolRecord>()
        let registry = piRegistryOf(defs, records)
        let mode = piModeOf(defs, "desktop")

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
        let agent = Agent(provider, session, registry, mode, opts)
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
            if (kind == "turn_start") {
                log("step/start", stepPayload(2, "model"))
                return
            }
            if (kind == "turn_end") {
                log("step/end", stepPayload(2, "model"))
                return
            }
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
        log("step/end", stepPayload(1, "retrieve"))

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
        log("step/start", stepPayload(100, "citation_check"))
        let vp = JsonObject()
        vp.put("report", report)
        vp.put("citations", cites)
        log("validation", vp)
        log("step/end", stepPayload(100, "citation_check"))

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
