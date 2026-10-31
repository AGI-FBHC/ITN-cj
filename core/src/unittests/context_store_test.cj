package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import std.collection.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.runtime_host.*
import itn_desktop_core.session.SessionStore
import itn_desktop_core.session.SessionEvent
import itn_desktop_core.store.Store
import itn_desktop_core.presentation.DesktopJobs

class CaptureContext <: ChatProvider {
    public let seen = ArrayList<Message>()
    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        for (m in ctx.messages) { seen.add(m) }
        let r = ModelReply()
        r.text = "继续回答"
        return r
    }
}

@Test
func hostRestoresToolsAndMoreThanFourTurnsWithoutDuplicatingQuestion(): Unit {
    let dir = freshDir("full-context")
    let host = LuminAgent(Store(dir))
    host.askWithProvider(ScriptedProvider([scriptTool("calc", "{\"expr\":\"7*8\"}"), scriptText("56")]), "", "计算", "stable", "off", "")
    var i = 0
    while (i < 6) {
        host.askWithProvider(ScriptedProvider([scriptText("回答")]), "", "问题" + i.toString(), "stable", "off", "")
        i = i + 1
    }
    let p = CaptureContext()
    host.askWithProvider(p, "", "本轮唯一", "stable", "off", "")
    var current = 0
    var results = 0
    var earliest = false
    for (m in p.seen) {
        if (m.text == "本轮唯一") { current = current + 1 }
        if (m.role == ToolResultMsg) { results = results + 1; @Expect(m.text.contains("56"), true) }
        if (m.text == "计算") { earliest = true }
    }
    @Expect(current, 1)
    @Expect(results, 1)
    @Expect(earliest, true)
    @Expect(strOf(taskState(dir, "stable"), "status"), "completed")
    SessionStore(dir).remove("stable")
    @Expect(restoreContext(dir, "stable", "").size, 0)
}

@Test
func checkpointRepairsInterruptedToolsAndMarksRestartedTask(): Unit {
    let dir = freshDir("interrupted-context")
    let s = newSession(dir, dir, "native", "")
    let m = Message(AssistantMsg)
    m.toolCalls.add(ToolCallBlock("original-id", "calc", "{}"))
    s.appendMessage(m)
    checkpointContext(dir, "sid", s)
    let restored = restoreContext(dir, "sid", "")
    @Expect(restored.size, 2)
    @Expect(restored[1].toolCallId, "original-id")
    @Expect(restored[1].isError, true)
    setTaskState(dir, "sid", "old", "running")
    @Expect(strOf(taskState(dir, "sid"), "status"), "interrupted")
    @Expect(sessionHub().reserve("sid", "new"), true)
    @Expect(sessionHub().reserve("sid", "duplicate"), false)
    sessionHub().release("sid")
}

@Test
func taskFeedKeepsOneTruthAndLuminCanListButNotCancelItselfOrIgnoreConsent(): Unit {
    let dir = freshDir("task-feed")
    let desktopId = DesktopJobs(dir).queueExtract("C:\\输入\\示例.docx", "")
    let sid = "task-feed-session"
    @Expect(sessionHub().reserve(sid, "turn-old"), true)
    setTaskState(dir, sid, "turn-old", "running")
    let oldStarted = intOf(taskState(dir, sid), "startedMs")
    sleep(Duration.millisecond * 20)
    setTaskState(dir, sid, "turn-old", "completed")
    sessionHub().release(sid)
    @Expect(sessionHub().reserve(sid, "turn-new"), true)
    setTaskState(dir, sid, "turn-new", "running")
    let fresh = taskState(dir, sid)
    @Expect(strOf(fresh, "turnId"), "turn-new")
    @Expect(intOf(fresh, "startedMs") > oldStarted, true)
    let feed = TaskFeed(Store(dir))
    let active = feed.active()
    var sawChat = false
    var sawDesktop = false
    var ai: Int64 = 0
    while (ai < active.size()) {
        let row = objOf(active[ai]).getOrThrow(); ai += 1
        if (strOf(row, "kind") == "chat") { sawChat = true }
        if (strOf(row, "kind") == "extract") {
            sawDesktop = true
            @Expect(strOf(objOf(row.get("link").getOrThrow()).getOrThrow(), "page"), "resources")
        }
    }
    @Expect(sawChat, true)
    @Expect(sawDesktop, true)

    var listTool = false
    var deniedWithoutIntent = false
    var deniedSelfCancel = false
    for (t in taskTools(Store(dir), sid, "看看现在有哪些任务")) {
        if (t.name == "list_activity_tasks") { listTool = true }
        if (t.name == "cancel_activity_task") {
            let id = JsonObject()
            id.put("id", JsonString("desktop:" + desktopId))
            try { t.run(id) } catch (e: Exception) { deniedWithoutIntent = true }
        }
    }
    for (t in taskTools(Store(dir), sid, "停止这个任务")) {
        if (t.name == "cancel_activity_task") {
            let id = JsonObject()
            id.put("id", JsonString("turn:" + sid + ":turn-new"))
            try { t.run(id) } catch (e: Exception) { deniedSelfCancel = true }
        }
    }
    @Expect(listTool, true)
    @Expect(deniedWithoutIntent, true)
    @Expect(deniedSelfCancel, true)

    sessionHub().release(sid)
    let listed = feed.list()
    var interrupted = false
    let recent = match (listed.get("recent")) { case Some(v) => match (v) { case a: JsonArray => a; case _ => JsonArray() }; case None => JsonArray() }
    var ri: Int64 = 0
    while (ri < recent.size()) {
        let row = objOf(recent[ri]).getOrThrow(); ri += 1
        if (strOf(row, "id") == "turn:" + sid + ":turn-new" && strOf(row, "status") == "interrupted") { interrupted = true }
    }
    @Expect(interrupted, true)
}

@Test
func taskFeedKeepsOneRecentTurnPerSessionAndHidesActiveOnes(): Unit {
    let dir = freshDir("task-feed-dedupe")
    let sessions = SessionStore(dir)
    func appendEnd(sid: String, turn: String): Unit {
        let e = SessionEvent()
        e.sessionId = sid
        e.turnId = turn
        e.kind = "turn/end"
        e.payload.put("ok", JsonBool(true))
        sessions.append(e)
    }
    appendEnd("s-a", "t-old")
    appendEnd("s-a", "t-new")
    appendEnd("s-b", "t-b")
    let feed = TaskFeed(Store(dir))
    let recent = feed.recent()
    var aCount: Int64 = 0
    var sawANew = false
    var sawBOld = false
    var i: Int64 = 0
    while (i < recent.size()) {
        let row = objOf(recent[i]).getOrThrow(); i += 1
        let id = strOf(row, "id")
        if (id.startsWith("turn:s-a:")) {
            aCount += 1
            if (id.contains(":t-new")) { sawANew = true }
        }
        if (id == "turn:s-b:t-b") { sawBOld = true }
    }
    @Expect(aCount, 1)
    @Expect(sawANew, true)
    @Expect(sawBOld, true)

    // 同一会话新一轮在跑时，不再把上一轮同时列进“最近完成”。
    @Expect(sessionHub().reserve("s-b", "t-b2"), true)
    setTaskState(dir, "s-b", "t-b2", "running")
    let activeRecent = feed.recent()
    var sawBActiveDuplicate = false
    var j: Int64 = 0
    while (j < activeRecent.size()) {
        let row = objOf(activeRecent[j]).getOrThrow(); j += 1
        if (strOf(row, "id") == "turn:s-b:t-b") { sawBActiveDuplicate = true }
    }
    @Expect(sawBActiveDuplicate, false)
    sessionHub().release("s-b")
}
