package itn_desktop_core.unittests

import std.collection.*
import std.time.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import stdx.net.http.*
import itn_desktop_core.api.buildServer
import itn_desktop_core.db.*
import itn_desktop_core.project.ProjectStore
import itn_desktop_core.runtime.*
import itn_desktop_core.runtime_host.*
import itn_desktop_core.session.*
import itn_desktop_core.store.Store
import itn_desktop_core.util.readAllString

class BranchContextCapture <: ChatProvider {
    public let seen = ArrayList<Message>()
    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        for (message in ctx.messages) { seen.add(message) }
        let result = ModelReply(); result.text = "分支继续完成"
        return result
    }
}

/** Native HTTP + real host/session storage; fixtures never open the user's database. */
@Test
class BranchBackendTest {
    func post(server: Server, route: String, body: JsonObject): (UInt16, JsonObject) {
        let client = ClientBuilder().readTimeout(Duration.second * 20).build()
        try {
            let request = HttpRequestBuilder().method("POST")
                .url("http://127.0.0.1:" + server.port.toString() + route)
                .header("Content-Type", "application/json").body(body.toString().toArray()).build()
            let response = client.send(request)
            return (response.status, objOf(JsonValue.fromStr(readAllString(response.body))).getOrThrow())
        } finally { client.close() }
    }

    func body(sid: String, turn!: String = ""): JsonObject {
        let value = JsonObject(); value.put("sessionId", JsonString(sid))
        if (turn.size > 0) { value.put("turnId", JsonString(turn)) }
        return value
    }

    func branchedId(response: (UInt16, JsonObject)): String {
        @Expect(response[0], 200)
        return strOf(objOf(response[1].get("data").getOrThrow()).getOrThrow(), "sessionId")
    }

    func firstTurn(dir: String, sid: String): String {
        for (event in SessionStore(dir).events(sid)) {
            if (strOf(event, "type") == "turn/start") { return strOf(event, "turnId") }
        }
        throw Exception("missing first turn")
    }

    func eventTexts(store: SessionStore, sid: String): String {
        let result = JsonArray(); for (event in store.events(sid)) { result.add(event) }
        return result.toString()
    }

    @TestCase
    func invalidTargetsNeverCreateOrphanSessions(): Unit {
        let dir = freshDir("branch-api-invalid"); let sessions = SessionStore(dir)
        let sid = strOf(sessions.create(), "sessionId")
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 100)
        try {
            let before = DbHub.open(dir).scalarInt("SELECT COUNT(*) FROM sessions", ArrayList<DbValue>())
            @Expect(post(server, "/api/sessions/branch", body("missing-source"))[0], 404)
            @Expect(post(server, "/api/sessions/branch", body(sid, turn: "missing-turn"))[0], 404)
            @Expect(post(server, "/api/sessions/branch", body("   "))[0], 400)
            @Expect(DbHub.open(dir).scalarInt("SELECT COUNT(*) FROM sessions", ArrayList<DbValue>()), before)
            let emptyBranch = branchedId(post(server, "/api/sessions/branch", body(sid)))
            @Expect(emptyBranch != sid, true)
            @Expect(sessions.events(emptyBranch).size, 0)
        } finally { server.close() }
    }

    @TestCase
    func earlierBranchContinuesWithToolsWithoutFutureTurnsOrParentChanges(): Unit {
        let dir = freshDir("branch-api-earlier"); let sessions = SessionStore(dir)
        let sid = strOf(sessions.create(), "sessionId"); let host = LuminAgent(Store(dir))
        let calculation = scriptTool("calc", "{\"expr\":\"7*8\"}")
        calculation.thinking = "先算乘积，再确认结果"
        let original = host.askWithProvider(ScriptedProvider([
            calculation, scriptText("首轮结果56")]), "", "首轮计算", sid, "off", "")
        @Expect(boolOf(original, "ok", false), true)
        let first = firstTurn(dir, sid)
        host.askWithProvider(ScriptedProvider([scriptText("后续秘密答案")]), "", "后续秘密问题", sid, "off", "")
        let before = eventTexts(sessions, sid)
        let parentContext = DbHub.open(dir).getKv("sessions_meta", "context:" + sid, "")
        sessions.setReasoningMode(sid, "high")
        let projects = ProjectStore(dir)
        let project = projects.save("", "分支项目", dir + "/workspace"); projects.bind(sid, project.id)
        DbHub.open(dir).putKv("sessions_meta", "resource:" + sid, "{\"resourceId\":\"course-a\",\"resourceVersion\":1}")
        let binding = JsonObject(); binding.put("sessionId", JsonString(sid)); binding.put("resourceId", JsonString("course-a"))
        DbHub.open(dir).putKv("sessions_meta", "guided:" + sid, binding.toString())
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 100)
        try {
            let child = branchedId(post(server, "/api/sessions/branch", body(sid, turn: first)))
            @Expect(projects.projectOf(child), project.id)
            @Expect(projects.rootOf(child), projects.rootOf(sid))
            @Expect(sessions.reasoningMode(child), "high")
            @Expect(strOf(taskState(dir, child), "status"), "")
            let inherited = objOf(JsonValue.fromStr(DbHub.open(dir).getKv("sessions_meta", "guided:" + child, "{}"))).getOrThrow()
            @Expect(strOf(inherited, "sessionId"), child)
            @Expect(strOf(inherited, "resourceId"), "course-a")
            // Remove the synthetic label before executing: no resource fixture is
            // needed to prove that its independent metadata was copied correctly.
            DbHub.open(dir).delKv("sessions_meta", "guided:" + child)
            DbHub.open(dir).delKv("sessions_meta", "resource:" + child)
            let provider = BranchContextCapture()
            let continued = host.askWithProvider(provider, "", "分支追问", child, "off", "")
            @Expect(boolOf(continued, "ok", false), true)
            var toolCalls = 0; var toolResults = 0; var firstUsers = 0; var currentUsers = 0
            var previousWasCall = false
            for (message in provider.seen) {
                @Expect(message.text.contains("后续秘密"), false)
                if (message.text == "首轮计算") { firstUsers += 1 }
                if (message.text == "分支追问") { currentUsers += 1 }
                if (message.hasToolCalls()) {
                    toolCalls += 1; previousWasCall = true
                    @Expect(message.thinking, calculation.thinking)
                }
                else if (message.role == ToolResultMsg) {
                    toolResults += 1; @Expect(previousWasCall, true)
                    @Expect(message.text.contains("56"), true)
                } else { previousWasCall = false }
            }
            @Expect(toolCalls, 1); @Expect(toolResults, 1)
            @Expect(firstUsers, 1); @Expect(currentUsers, 1)
            @Expect(eventTexts(sessions, sid), before)
            @Expect(DbHub.open(dir).getKv("sessions_meta", "context:" + sid, ""), parentContext)
            sessions.setReasoningMode(child, "low"); @Expect(sessions.reasoningMode(sid), "high")
            DbHub.open(dir).delKv("sessions_meta", "guided:" + sid)
            DbHub.open(dir).delKv("sessions_meta", "resource:" + sid)
            let whole = branchedId(post(server, "/api/sessions/branch", body(sid)))
            let wholeProvider = BranchContextCapture()
            @Expect(boolOf(host.askWithProvider(wholeProvider, "", "整段分支追问", whole, "off", ""), "ok", false), true)
            var hasFuture = false; var hasTools = false
            for (message in wholeProvider.seen) {
                if (message.text == "后续秘密问题") { hasFuture = true }
                if (message.role == ToolResultMsg) { hasTools = true }
            }
            @Expect(hasFuture, true); @Expect(hasTools, true)
            @Expect(eventTexts(sessions, sid), before)
        } finally { server.close() }
    }

    @TestCase
    func compactedRepeatedQuestionsCannotLeakLaterFactsIntoEarlierBranch(): Unit {
        let dir = freshDir("branch-compacted-repeat"); let sessions = SessionStore(dir)
        let sid = strOf(sessions.create(), "sessionId"); let host = LuminAgent(Store(dir))
        host.askWithProvider(ScriptedProvider([scriptText("早先回答")]), "", "相同问题", sid, "off", "")
        let first = firstTurn(dir, sid)
        host.askWithProvider(ScriptedProvider([scriptText("后来才有的秘密")]), "", "相同问题", sid, "off", "")
        let native = newSession(dir, dir, "compacted", "")
        let summary = Message(UserMsg); summary.text = "（以下是本次会话更早内容的摘要）\n后来才有的秘密"
        native.appendMessage(summary)
        let recent = Message(UserMsg); recent.text = "相同问题"; native.appendMessage(recent)
        let response = Message(AssistantMsg); response.text = "后来才有的秘密"; native.appendMessage(response)
        checkpointContext(dir, sid, native)
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 100)
        try {
            let child = branchedId(post(server, "/api/sessions/branch", body(sid, turn: first)))
            let restored = restoreContext(dir, child, "")
            @Expect(restored.size, 2)
            @Expect(restored[0].text, "相同问题")
            @Expect(restored[1].text, "早先回答")
            for (message in restored) { @Expect(message.text.contains("后来才有的秘密"), false) }
        } finally { server.close() }
    }

    @TestCase
    func runningLatestTurnCannotBeBranchedButFinishedAncestorCan(): Unit {
        let dir = freshDir("branch-api-running"); let sessions = SessionStore(dir)
        let sid = strOf(sessions.create(), "sessionId")
        let host = LuminAgent(Store(dir))
        host.askWithProvider(ScriptedProvider([scriptText("已完成轮次")]), "", "早先问题", sid, "off", "")
        let first = firstTurn(dir, sid)
        @Expect(sessionHub().reserve(sid, "inflight"), true)
        setTaskState(dir, sid, "inflight", "running")
        let event = SessionEvent(); event.sessionId = sid; event.turnId = "inflight"
        event.kind = "user/message"; event.payload.put("text", JsonString("尚未完成问题")); sessions.append(event)
        let before = eventTexts(sessions, sid)
        let count = DbHub.open(dir).scalarInt("SELECT COUNT(*) FROM sessions", ArrayList<DbValue>())
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 100)
        try {
            @Expect(post(server, "/api/sessions/branch", body(sid))[0], 409)
            @Expect(post(server, "/api/sessions/branch", body(sid, turn: "inflight"))[0], 409)
            @Expect(DbHub.open(dir).scalarInt("SELECT COUNT(*) FROM sessions", ArrayList<DbValue>()), count)
            let child = branchedId(post(server, "/api/sessions/branch", body(sid, turn: first)))
            @Expect(eventTexts(sessions, child).contains("尚未完成问题"), false)
            @Expect(sessionHub().activeTurn(sid), "inflight")
            @Expect(eventTexts(sessions, sid), before)
            for (route in ["/api/sessions/rewind", "/api/sessions/split", "/api/sessions/set-active", "/api/sessions/switch"]) {
                @Expect(post(server, route, body(sid, turn: first))[0], 409)
                @Expect(eventTexts(sessions, sid), before)
            }
        } finally { sessionHub().release(sid); server.close() }
    }

    @TestCase
    func missingNativeCheckpointStillRestoresRecordedToolPairs(): Unit {
        let dir = freshDir("branch-legacy-tools"); let sessions = SessionStore(dir)
        let sid = strOf(sessions.create(), "sessionId"); let host = LuminAgent(Store(dir))
        let calculation = scriptTool("calc", "{\"expr\":\"7*8\"}"); calculation.thinking = "核对计算"
        host.askWithProvider(ScriptedProvider([calculation, scriptText("56")]), "", "计算", sid, "off", "")
        DbHub.open(dir).delKv("sessions_meta", "context:" + sid)
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 100)
        try {
            let child = branchedId(post(server, "/api/sessions/branch", body(sid)))
            let restored = restoreContext(dir, child, "")
            var calls = 0; var results = 0
            for (message in restored) {
                if (message.hasToolCalls()) {
                    calls += 1; @Expect(message.toolCalls[0].argsJson.contains("7*8"), true)
                    @Expect(message.thinking, calculation.thinking)
                }
                if (message.role == ToolResultMsg) {
                    results += 1; @Expect(message.text.contains("56"), true)
                    @Expect(message.isError, false)
                }
            }
            @Expect(calls, 1); @Expect(results, 1)
        } finally { server.close() }
    }

    @TestCase
    func nativeCheckpointRoundTripsThinkingAndToolArguments(): Unit {
        let dir = freshDir("branch-thinking-checkpoint")
        let native = newSession(dir, dir, "thinking", "")
        let user = Message(UserMsg); user.text = "请计算"; native.appendMessage(user)
        let call = Message(AssistantMsg); call.thinking = "先算乘积，再确认结果"
        call.toolCalls.add(ToolCallBlock("reasoned-calc", "calc", "{\"expr\":\"7*8\"}")); native.appendMessage(call)
        let result = Message(ToolResultMsg); result.toolCallId = "reasoned-calc"; result.toolName = "calc"
        result.text = "56"; native.appendMessage(result)
        checkpointContext(dir, "parent", native)
        let restored = restoreContext(dir, "parent", "")
        @Expect(restored.size, 3)
        @Expect(restored[1].thinking, call.thinking)
        @Expect(restored[1].toolCalls[0].argsJson.contains("7*8"), true)
        @Expect(restored[2].toolCallId, "reasoned-calc")
    }
}
