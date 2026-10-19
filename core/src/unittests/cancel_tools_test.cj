package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import std.time.*
import std.fs.*
import stdx.net.http.*
import stdx.encoding.json.*
import itn_desktop_core.tools.fetchPageWithCancel
import itn_desktop_core.tools.WebSearchClient
import itn_desktop_core.pi_app.ApprovalHub
import itn_desktop_core.pi_app.PiAgent
import itn_desktop_core.pi_app.sessionHub
import itn_desktop_core.pi.ScriptedProvider
import itn_desktop_core.pi.scriptTool
import itn_desktop_core.pi.scriptText
import itn_desktop_core.pi.boolOf
import itn_desktop_core.pi.strOf
import itn_desktop_core.pi.objOf
import itn_desktop_core.store.Store
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.llm.LlmClient
import itn_desktop_core.util.readAllString

func slowToolServer(): Server {
    let server = ServerBuilder().addr("127.0.0.1").port(0).build()
    server.distributor.register("/slow", { ctx: HttpContext =>
        readAllString(ctx.request.body)
        sleep(Duration.second * 3)
        ctx.responseBuilder.status(200)
        ctx.responseBuilder.header("Content-Type", "text/plain")
        ctx.responseBuilder.body("should not be cached after cancel".toArray())
    })
    spawn { server.serve() }
    sleep(Duration.millisecond * 150)
    return server
}

@Test
func cancelClosesAStalledWebFetchWithoutCaching(): Unit {
    let server = slowToolServer()
    let dir = freshDir("cancel-fetch")
    let started = DateTime.now()
    var cancelled = false
    try {
        fetchPageWithCancel(dir, "http://127.0.0.1:" + server.port.toString() + "/slow",
            { => (DateTime.now() - started).toMilliseconds() > 250 })
    } catch (e: Exception) { cancelled = e.message.contains("取消") }
    @Expect(cancelled, true)
    @Expect((DateTime.now() - started).toMilliseconds() < 2000, true)
    @Expect(exists(dir + "/webcache"), false)
    server.close()
}

@Test
func cancelClosesAStalledEmbeddingRequest(): Unit {
    let server = ServerBuilder().addr("127.0.0.1").port(0).build()
    server.distributor.register("/v1/embeddings", { ctx: HttpContext =>
        readAllString(ctx.request.body)
        sleep(Duration.second * 3)
        ctx.responseBuilder.status(200)
        ctx.responseBuilder.body("{}".toArray())
    })
    spawn { server.serve() }
    sleep(Duration.millisecond * 150)
    let cfg = ModelConfig()
    cfg.baseUrl = "http://127.0.0.1:" + server.port.toString() + "/v1"
    cfg.model = "test"
    let client = LlmClient(cfg)
    let started = DateTime.now()
    client.shouldAbort = { => (DateTime.now() - started).toMilliseconds() > 250 }
    var cancelled = false
    try { client.embed(["test"]) } catch (e: Exception) { cancelled = e.message.contains("取消") }
    @Expect(cancelled, true)
    @Expect((DateTime.now() - started).toMilliseconds() < 2000, true)
    server.close()
}

@Test
func cancelClosesAStalledSearch(): Unit {
    let server = slowToolServer()
    let client = WebSearchClient("local-test-key")
    client.endpoint = "http://127.0.0.1:" + server.port.toString() + "/slow"
    let started = DateTime.now()
    client.shouldAbort = { => (DateTime.now() - started).toMilliseconds() > 250 }
    var cancelled = false
    try { client.search("a query", 2) } catch (e: Exception) { cancelled = e.message.contains("取消") }
    @Expect(cancelled, true)
    @Expect((DateTime.now() - started).toMilliseconds() < 2000, true)
    server.close()
}

@Test
func cancelReleasesAnApprovalWait(): Unit {
    let hub = ApprovalHub()
    let started = DateTime.now()
    let answer = hub.askWithCancel("web", "example.test", "test", "web_fetch",
        { => (DateTime.now() - started).toMilliseconds() > 250 })
    @Expect(answer, "n")
    @Expect(hub.pendingCount(), 0)
    @Expect((DateTime.now() - started).toMilliseconds() < 1500, true)
}

@Test
func approvalRequestsStayScopedToTheirSessions(): Unit {
    let hub = ApprovalHub()
    hub.waitSec = 5
    let first = spawn {
        hub.askWithCancelFor("file-read", "notes.md", "读取学习资料", "read", "sid-a", { => false })
    }
    let second = spawn {
        hub.askWithCancelFor("file-write", "draft.md", "保存学习笔记", "write", "sid-b", { => false })
    }
    var waited: Int64 = 0
    while ((hub.pendingCountFor("sid-a") < 1 || hub.pendingCountFor("sid-b") < 1) && waited < 100) {
        sleep(Duration.millisecond * 20)
        waited += 1
    }
    @Expect(hub.pendingCount(), 2)
    @Expect(hub.pendingCountFor("sid-a"), 1)
    @Expect(hub.pendingCountFor("sid-b"), 1)
    @Expect(hub.pendingCountFor("sid-other"), 0)

    let listA = hub.listFor("sid-a")
    let listB = hub.listFor("sid-b")
    @Expect(listA.size(), 1)
    @Expect(listB.size(), 1)
    @Expect(hub.listFor("sid-other").size(), 0)
    let requestA = objOf(listA[0]).getOrThrow()
    let requestB = objOf(listB[0]).getOrThrow()
    @Expect(strOf(requestA, "sessionId"), "sid-a")
    @Expect(strOf(requestA, "kind"), "file-read")
    @Expect(strOf(requestB, "sessionId"), "sid-b")
    @Expect(strOf(requestB, "kind"), "file-write")

    @Expect(hub.answer(strOf(requestA, "id"), "once"), true)
    @Expect(hub.answer(strOf(requestB, "id"), "deny"), true)
    @Expect(first.get(), "y")
    @Expect(second.get(), "n")
    @Expect(hub.pendingCount(), 0)
}

@Test
func cancellingTheLuminTurnStopsTheActualToolAndNextModelCall(): Unit {
    let server = slowToolServer()
    let dir = freshDir("cancel-agent-tool")
    let sid = "cancel-tool-turn"
    PiAgent(Store(dir)).askWithProvider(ScriptedProvider([scriptText("previous completed answer")]),
        "", "previous question", sid, "off", "")
    let model = ScriptedProvider([
        scriptTool("web_fetch", "{\"url\":\"http://127.0.0.1:" + server.port.toString() + "/slow\"}"),
        scriptText("must not run after stop")
    ])
    let canceller = spawn { sleep(Duration.millisecond * 350); sessionHub().abort(sid) }
    let started = DateTime.now()
    let result = PiAgent(Store(dir)).askWithProvider(model, "", "read a page", sid, "auto", "")
    canceller.get()
    @Expect(boolOf(result, "ok", true), false)
    @Expect(strOf(result, "answer"), "")
    @Expect(model.remaining(), 1)
    @Expect((DateTime.now() - started).toMilliseconds() < 2000, true)
    server.close()
}
