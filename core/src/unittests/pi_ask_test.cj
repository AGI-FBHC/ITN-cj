package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*
import itn_desktop_core.pi_app.PiAgent
import itn_desktop_core.store.*
import itn_desktop_core.session.SessionStore
import itn_desktop_core.kb.*
// strOf / intOf / objOf 用 pi 那份（与 util 同名，两边都通配会歧义——踩过）

/*
 * lumin 问答链路（P3 后半 + P4）的离线自测。
 *
 * 用 ScriptedProvider "播放"一次模型请求：先要一次工具调用（kb_search），再给正文。
 * 整条链路都可以在离网环境里验：工具桥接（DomainTool → pi Tool）→ 真的执行了内核的检索 →
 * 工具结果回灌 → 事件翻译成界面认的那几个 → 引用自检算出 citations。
 */

func jsonObjOf(v: ?JsonValue): JsonObject {
    match (v) {
        case Some(x) =>
            match (x) {
                case o: JsonObject => return o
                case _ => return JsonObject()
            }
        case None => return JsonObject()
    }
}

func jsonArrOf(v: ?JsonValue): JsonArray {
    match (v) {
        case Some(x) =>
            match (x) {
                case a: JsonArray => return a
                case _ => return JsonArray()
            }
        case None => return JsonArray()
    }
}

/** 铺一份最小的知识库：一篇 md + 建好的索引 + 登记。 */
func setupKb(root: String, dataDir: String, kbId: String): Unit {
    File.writeTo(root + "/01.md", ("# 提示词工程\n\n## 基本概念\n\n" +
        "提示词是交给模型的输入指令，把任务、约束与输出格式写清楚，模型的表现会更稳定。\n").toArray())
    let idx = chunkAll(root, 1200)
    idx.kbId = kbId
    saveIndex(dataDir, kbId, idx)
    let s = Settings()
    let kb = KnowledgeBase()
    kb.id = kbId
    kb.name = "自测库"
    kb.rootDir = root
    s.knowledgeBases.add(kb)
    Store(dataDir).save(s)
}

@Test
func piAgentRunsDomainToolsThroughTheBridge(): Unit {
    let dataDir = freshDir("pi-ask-data")
    let root = freshDir("pi-ask-kb")
    setupKb(root, dataDir, "t")
    let store = Store(dataDir)
    let provider = ScriptedProvider([
        scriptTool("kb_search", "{\"query\":\"提示词\",\"top_k\":3}"),
        scriptText("提示词是交给模型的输入指令，把任务、约束与输出格式写清楚 [1]。")
    ])
    let out = PiAgent(store).askWithProvider(provider, "t", "提示词是什么", "", "off", "")

    let okVal = match (out.get("ok")) { case Some(v) => match (v) { case b: JsonBool => b.getValue(); case _ => false }; case None => false }
    @Expect(okVal, true)
    let answer = strOf(out, "answer")
    @Expect(answer.contains("[1]"), true)
    let cites = jsonArrOf(out.get("citations"))
    @Expect(cites.size(), 1)
    @Expect(strOf(jsonObjOf(Some(cites[0])), "docTitle"), "提示词工程")
    let report = jsonObjOf(out.get("citationReport"))
    @Expect(intOf(report, "paragraphs") >= 1, true)

    // 事件形状：界面（KIND_LABEL / turnsFromEvents / renderToolRows）读的就是这些名字
    let sessionId = strOf(out, "sessionId")
    let kinds = ArrayList<String>()
    var toolSummary = ""
    for (e in SessionStore(dataDir).events(sessionId)) {
        kinds.add(strOf(e, "type"))
        if (strOf(e, "type") == "tool/result") {
            toolSummary = strOf(jsonObjOf(e.get("payload")), "summary")
        }
    }
    for (want in ["turn/start", "user/message", "tool/call", "tool/result", "assistant/delta", "assistant/message", "validation", "turn/end"]) {
        @Expect(kinds.contains(want), true)
    }
    // 工具真的执行了：summary 是检索结果那句话
    @Expect(toolSummary.contains("命中"), true)
}

@Test
func switchingWebOffRemovesWebTools(): Unit {
    let dataDir = freshDir("pi-ask-off-data")
    let root = freshDir("pi-ask-off-kb")
    setupKb(root, dataDir, "t")
    let store = Store(dataDir)
    // 领域工具 10 个，其中 web_search / web_fetch 两个联网工具在"不联网"时压根不该生成
    let off = ScriptedProvider([scriptText("好的。")])
    PiAgent(store).askWithProvider(off, "t", "在吗", "", "off", "")
    @Expect(off.seenToolCounts[0], 8)
    let auto = ScriptedProvider([scriptText("好的。")])
    PiAgent(store).askWithProvider(auto, "t", "在吗", "", "auto", "")
    @Expect(auto.seenToolCounts[0], 12)
}
