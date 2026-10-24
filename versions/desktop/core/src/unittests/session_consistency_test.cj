package itn_desktop_core.unittests

import std.collection.*
import std.time.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.net.http.*
import stdx.encoding.json.*
import itn_desktop_core.api.buildServer
import itn_desktop_core.session.*
import itn_desktop_core.project.ProjectStore
import itn_desktop_core.db.*
import itn_desktop_core.util.*

@Test
class SessionConsistencyTest {
    func find(rows: ArrayList<JsonObject>, sid: String): ?JsonObject {
        for (row in rows) { if (strOf(row, "sessionId") == sid) { return Some(row) } }
        return None
    }

    func post(server: Server, route: String, body: String): (UInt16, JsonObject) {
        let client = ClientBuilder().readTimeout(Duration.second * 15).build()
        try {
            let request = HttpRequestBuilder().method("POST").url("http://127.0.0.1:" + server.port.toString() + route)
                .header("Content-Type", "application/json").body(body.toArray()).build()
            let response = client.send(request)
            return (response.status, objOf(JsonValue.fromStr(readAllString(response.body))).getOrThrow())
        } finally { client.close() }
    }

    @TestCase
    func emptyCreatedSessionIsListedAndPersistsWithoutAnyEvent(): Unit {
        let dir = freshDir("session-empty-persistence")
        let store = SessionStore(dir)
        let summary = store.create(); let sid = strOf(summary, "sessionId")
        @Expect(sid.size > 0, true); @Expect(intOf(summary, "rowid") > 0, true)
        @Expect(strOf(summary, "title"), "新对话"); @Expect(intOf(summary, "eventCount"), 0)
        @Expect(find(store.list(), sid).isSome(), true)
        @Expect(store.events(sid).size, 0)
        DbHub.reset()
        @Expect(DbHub.open(dir).scalarInt("SELECT COUNT(*) FROM sessions WHERE id = ?", va([tv(sid)])), 1)
        @Expect(find(SessionStore(dir).list(true), sid).isSome(), true)
    }

    @TestCase
    func newApiReturnsPersistedSummaryAndRejectsUnknownProjectWithoutCreatingOrphans(): Unit {
        let dir = freshDir("session-create-api")
        let projects = ProjectStore(dir)
        let project = projects.save("", "项目甲", dir + Path.Separator + "workspace")
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 100)
        try {
            let invalid = post(server, "/api/sessions/new", "{\"projectId\":\"missing\"}")
            @Expect(invalid[0], 400)
            @Expect(DbHub.open(dir).scalarInt("SELECT COUNT(*) FROM sessions", ArrayList<DbValue>()), 0)
            let created = post(server, "/api/sessions/new", "{\"projectId\":\"" + project.id + "\"}")
            @Expect(created[0], 200)
            let body = objOf(created[1].get("data").getOrThrow()).getOrThrow()
            let summary = objOf(body.get("session").getOrThrow()).getOrThrow()
            let sid = strOf(body, "sessionId")
            @Expect(strOf(summary, "sessionId"), sid)
            @Expect(strOf(summary, "projectId"), project.id)
            @Expect(strOf(summary, "kind"), "work")
            @Expect(intOf(summary, "rowid") > 0, true)
            @Expect(strOf(summary, "lastAt").size > 0, true)
            let listed = find(SessionStore(dir).list(true), sid).getOrThrow()
            @Expect(strOf(listed, "projectId"), project.id)
            @Expect(strOf(listed, "kind"), "work")
            @Expect(intOf(listed, "rowid"), intOf(summary, "rowid"))
        } finally { server.close() }
    }

    @TestCase
    func forcedReadIncludesCreateRenameBindAndDeleteDespiteWarmCache(): Unit {
        let dir = freshDir("session-read-after-write")
        let store = SessionStore(dir)
        let first = strOf(store.create(), "sessionId")
        store.list(false)
        store.rename(first, "马上可见的新标题")
        let next = strOf(store.create(), "sessionId")
        ProjectStore(dir).bind(next, "project-test")
        store.list(false)
        let rows = store.list(true)
        @Expect(strOf(find(rows, first).getOrThrow(), "title"), "马上可见的新标题")
        @Expect(strOf(find(rows, next).getOrThrow(), "projectId"), "project-test")
        store.remove(first)
        @Expect(find(store.list(true), first).isNone(), true)
        @Expect(find(store.list(true), next).isSome(), true)
    }

    @TestCase
    func equalTimestampsUseCreationOrderNotRandomSessionIds(): Unit {
        let dir = freshDir("session-order-tie")
        let store = SessionStore(dir)
        let first = strOf(store.create(), "sessionId")
        let second = strOf(store.create(), "sessionId")
        DbHub.open(dir).run("UPDATE sessions SET updated_at = ?", va([tv("2026-10-23T20:00:00+08:00")]))
        let rows = store.list(true)
        @Expect(rows.size, 2)
        @Expect(strOf(rows[0], "sessionId"), second)
        @Expect(strOf(rows[1], "sessionId"), first)
        @Expect(intOf(rows[0], "rowid") > intOf(rows[1], "rowid"), true)
    }

    @TestCase
    func newBranchUsesItsCreationActivityInsteadOfCopiedOldEventTime(): Unit {
        let dir = freshDir("session-branch-activity")
        let store = SessionStore(dir)
        let first = strOf(store.create(), "sessionId")
        let event = SessionEvent(); event.sessionId = first; event.at = "2020-01-01T00:00:00+08:00"
        event.kind = "user/message"; event.payload.put("text", JsonString("历史问题")); store.append(event)
        let branch = store.branchAll(first)
        let rows = store.list(true)
        @Expect(strOf(rows[0], "sessionId"), branch)
        @Expect(strOf(rows[0], "lastAt") != event.at, true)
        @Expect(intOf(rows[0], "eventCount"), 1)
    }

    @TestCase
    func backgroundTokensAndLateNamingDoNotDisplaceNewChatButCompletedAnswerDoes(): Unit {
        let dir = freshDir("session-stable-live-order")
        let store = SessionStore(dir)
        let first = strOf(store.create(), "sessionId")
        let next = strOf(store.create(), "sessionId")
        let db = DbHub.open(dir)
        db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", va([tv("2026-10-23T12:00:00+08:00"), tv(first)]))
        db.run("UPDATE sessions SET updated_at = ? WHERE id = ?", va([tv("2026-10-23T12:01:00+08:00"), tv(next)]))
        let token = SessionEvent(); token.sessionId = first; token.kind = "assistant/delta"; token.at = "2026-10-23T12:02:00+08:00"
        token.payload.put("text", JsonString("还在输出")); store.append(token)
        @Expect(strOf(store.list(true)[0], "sessionId"), next)
        store.rename(first, "模型稍后返回的标题")
        @Expect(strOf(store.list(true)[0], "sessionId"), next)
        let completed = SessionEvent(); completed.sessionId = first; completed.kind = "assistant/message"; completed.at = "2026-10-23T12:03:00+08:00"
        completed.payload.put("text", JsonString("已经回答完成")); store.append(completed)
        @Expect(strOf(store.list(true)[0], "sessionId"), first)
    }

    @TestCase
    func concurrentFreshReadersCannotLoseSuccessfullyCreatedSessions(): Unit {
        let dir = freshDir("session-list-single-flight")
        let store = SessionStore(dir)
        store.create(); store.list(true)
        let runs = Array(12, { _: Int64 => spawn {
            let sid = strOf(store.create(), "sessionId")
            if (find(store.list(true), sid).isNone()) { throw Exception("新会话在强制列表中丢失") }
            return sid
        } })
        let ids = HashSet<String>()
        for (run in runs) { ids.add(run.get()) }
        @Expect(ids.size, 12)
        let rows = store.list(true)
        @Expect(rows.size, 13)
        for (sid in ids) { @Expect(find(rows, sid).isSome(), true) }
    }

    @TestCase
    func forcedApiReadReturnsNewRowEvenWhenPassiveListWasAlreadyCached(): Unit {
        let dir = freshDir("session-forced-list-api")
        let server = buildServer(dir, dir + "/ui"); spawn { server.serve() }
        sleep(Duration.millisecond * 100)
        try {
            post(server, "/api/sessions/list", "{}")
            let created = post(server, "/api/sessions/new", "{}")
            let sid = strOf(objOf(created[1].get("data").getOrThrow()).getOrThrow(), "sessionId")
            let fresh = post(server, "/api/sessions/list", "{\"force\":true}")
            let body = objOf(fresh[1].get("data").getOrThrow()).getOrThrow()
            let serialized = body.get("sessions").getOrThrow().toString()
            @Expect(serialized.contains(sid), true)
            @Expect(serialized.contains("新对话"), true)
        } finally { server.close() }
    }
}
