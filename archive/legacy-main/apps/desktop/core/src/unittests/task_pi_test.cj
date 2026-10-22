package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*
import itn_desktop_core.pi_app.PiAgent
import itn_desktop_core.pi_app.WorkContext
import itn_desktop_core.store.*
import itn_desktop_core.session.SessionStore
import itn_desktop_core.kb.*

/*
 * 产物任务（讲义 / 练习册）的离线自测。
 *
 * 验的是这条链路的三个约定（都是真机踩过才定下来的）：
 *   1) 提示词里没有"先检索"的规矩 —— 步骤由模型自己排，内核不写死；
 *   2) 模型自己调 save_artifact 落了盘，产物路径必须能从工具记录里回给界面：
 *      parallel 模式下工具是多线程跑的，记录表并发写会丢（丢过一次，界面于是以为没落盘）；
 *   3) "这一轮的答案"只取**最后一次工具调用之后**那段：模型查资料时说的"让我看看…"
 *      不能和正文糊在一起（真机上那段讲解被当成讲义存过）。
 */

@Test
func lectureTaskKeepsTheArtifactSavedByTheModel(): Unit {
    let dataDir = freshDir("task-pi-data")
    let root = freshDir("task-pi-kb")
    setupTaskKb(root, dataDir, "t")
    let store = Store(dataDir)
    let provider = ScriptedProvider([
        scriptTool("save_artifact", "{\"name\":\"讲义-测试.md\",\"content\":\"# 讲义\\n\\n正文 [1]\\n\"}"),
        scriptText("讲义写好了，文件名是 讲义-测试.md。")
    ])
    let out = PiAgent(store).runFull(provider, "t", "把「测试」做成一份讲义。", "", "off", "", None, "lecture", "测试")

    @Expect(boolOf(out, "ok", false), true)
    @Expect(strOf(out, "savedBy"), "model")
    let p = strOf(out, "artifactPath")
    @Expect(p.size > 0, true)
    @Expect(exists(p), true)
    // 答案 = 最后一段（工具调用之后那句），不含"过程"
    @Expect(strOf(out, "answer"), "讲义写好了，文件名是 讲义-测试.md。")

    // 事件形状：这一轮标成讲义，且**没有**内核编的 step/* 事件
    let sessionId = strOf(out, "sessionId")
    var kinds = ArrayList<String>()
    var kindOfTurn = ""
    for (e in SessionStore(dataDir).events(sessionId)) {
        let k = strOf(e, "type")
        kinds.add(k)
        if (k == "turn/start") {
            kindOfTurn = strOf(jsonOf(e.get("payload")), "kind")
        }
    }
    @Expect(kindOfTurn, "lecture")
    @Expect(kinds.contains("tool/call"), true)
    @Expect(kinds.contains("step/start"), false)
    @Expect(kinds.contains("step/end"), false)
}

@Test
func lectureTaskFallsBackToTheKernelWhenTheModelCannotCallTools(): Unit {
    let dataDir = freshDir("task-pi-fb-data")
    let root = freshDir("task-pi-fb-kb")
    setupTaskKb(root, dataDir, "t")
    let store = Store(dataDir)
    // 不认 function calling 的模型：只会吐正文。内核必须把正文落成产物，否则用户看不到东西。
    let provider = ScriptedProvider([scriptText("# 讲义\n\n这一段就是正文。\n")])
    let out = PiAgent(store).runFull(provider, "t", "把「兜底」做成一份讲义。", "", "off", "", None, "lecture", "兜底")

    @Expect(strOf(out, "savedBy"), "kernel")
    let p = strOf(out, "artifactPath")
    @Expect(p.size > 0, true)
    @Expect(slurp(p).contains("这一段就是正文"), true)
    // 文件名跟着主题走，用户能在「我的资源」里一眼认出来
    @Expect(p.contains("讲义-兜底"), true)
}

/*
 * 对话链路：界面上的"正在看什么"要进提示词（"这一章"不用再反问是哪一章），
 * 思考段要按时序记成 assistant/thinking（界面据此画"已思考 N 秒"，证明是模型先想再动手）。
 */
@Test
func chatCarriesUiContextAndThinkingTimeline(): Unit {
    let dataDir = freshDir("chat-ctx-data")
    let root = freshDir("chat-ctx-kb")
    setupTaskKb(root, dataDir, "t")
    let store = Store(dataDir)
    let step = scriptTool("save_note", "{\"title\":\"小结\",\"text\":\"这一章讲上下文工程 [1]\"}")
    step.thinking = "用户问的是正在学的这一章，先想清楚再动手。"
    let provider = ScriptedProvider([step, scriptText("已经把小结记进笔记了 [1]。")])
    let work = WorkContext()
    work.ctxChapter = "第九章 上下文工程"
    let out = PiAgent(store).runFull(provider, "t", "这一章的核心结论是什么？", "", "off", "", Some(work), "", "")

    @Expect(boolOf(out, "ok", false), true)
    // ① 上下文进了提示词：模型不用再反问"哪一章"
    @Expect(provider.seenSystems[0].contains("第九章 上下文工程"), true)

    // ② 会话里先记思考、再记工具：时间线是"想 → 动手"，不是写死的步骤
    let sessionId = strOf(out, "sessionId")
    var thinkAt: Int64 = -1
    var toolAt: Int64 = -1
    var i: Int64 = 0
    for (e in SessionStore(dataDir).events(sessionId)) {
        let k = strOf(e, "type")
        if (k == "assistant/thinking" && thinkAt < 0) {
            thinkAt = i
        }
        if (k == "tool/call" && toolAt < 0) {
            toolAt = i
        }
        i = i + 1
    }
    @Expect(thinkAt >= 0, true)
    @Expect(toolAt > thinkAt, true)
}

/** 一份最小知识库：一篇 md + 索引 + 登记。 */
func setupTaskKb(root: String, dataDir: String, kbId: String): Unit {
    File.writeTo(root + "/01.md", ("# 提示词工程\n\n## 基本概念\n\n" +
        "提示词是交给模型的输入指令，把任务、约束与输出格式写清楚，模型的表现会更稳定。\n").toArray())
    let idx = chunkAll(root, 1200)
    idx.kbId = kbId
    saveIndex(dataDir, kbId, idx)
    let s = Settings()
    let kb = KnowledgeBase()
    kb.id = kbId
    kb.name = "任务自测库"
    kb.rootDir = root
    s.knowledgeBases.add(kb)
    Store(dataDir).save(s)
}

func jsonOf(v: ?JsonValue): JsonObject {
    match (v) {
        case Some(x) =>
            match (x) {
                case o: JsonObject => return o
                case _ => return JsonObject()
            }
        case None => return JsonObject()
    }
}
