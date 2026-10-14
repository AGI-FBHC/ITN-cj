package itn_desktop_core.api

import stdx.net.http.*
import std.collection.*
import std.convert.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.db.*
import itn_desktop_core.llm.*
import itn_desktop_core.kb.*
import itn_desktop_core.agent.*
import itn_desktop_core.session.*
import itn_desktop_core.study.*
import itn_desktop_core.tools.*
import std.fs.*
import itn_desktop_core.util.*

public class Api {
    let store: Store

    public init(store: Store) {
        this.store = store
    }

    func send(ctx: HttpContext, status: UInt16, body: JsonValue): Unit {
        ctx.responseBuilder.status(status)
        ctx.responseBuilder.header("Content-Type", "application/json; charset=utf-8")
        ctx.responseBuilder.body(body.toString().toArray())
    }

    func ok(ctx: HttpContext, data: JsonValue): Unit {
        let o = JsonObject()
        o.put("code", JsonInt(0))
        o.put("data", data)
        send(ctx, 200, o)
    }

    func fail(ctx: HttpContext, status: UInt16, message: String): Unit {
        let o = JsonObject()
        o.put("code", JsonInt(1))
        o.put("message", JsonString(message))
        send(ctx, status, o)
    }

    func bodyJson(ctx: HttpContext): ?JsonObject {
        let raw = readAllString(ctx.request.body)
        if (raw.size == 0) {
            return None
        }
        try {
            return objOf(JsonValue.fromStr(raw))
        } catch (e: Exception) {
            return None
        }
    }

    func settingsJson(): JsonObject {
        let s = store.load()
        let o = s.toJson()
        let arr = JsonArray()
        for (m in s.models) {
            arr.add(m.toPublicJson())
        }
        o.put("models", arr)
        // 数据目录：界面要拿它显示"所有东西都存在这个文件夹，可以整体备份"
        o.put("dataDir", JsonString(store.dataDir))
        return o
    }

    func kbStatsJson(b: KnowledgeBase): JsonObject {
        return b.toJson()
    }

    func chunkJson(c: KbChunk, score: Float64): JsonObject {
        let o = JsonObject()
        o.put("score", JsonFloat(score))
        o.put("id", JsonString(c.id))
        o.put("docPath", JsonString(c.docPath))
        o.put("docTitle", JsonString(c.docTitle))
        o.put("headingPath", JsonString(c.headingPath))
        o.put("ordinal", JsonInt(c.ordinal))
        o.put("text", JsonString(c.text))
        o.put("caption", JsonString(c.caption))
        let imgs = JsonArray()
        for (i in c.images) {
            imgs.add(JsonString(i))
        }
        o.put("images", imgs)
        return o
    }

    /**
     * 所有路由的统一入口。
     *
     * 任何未预期的异常都在这里转成带原因的 JSON —— 框架默认只回一句
     * "Internal Server Error"，用户在界面上看到它完全无从下手
     * （本轮就踩过：数据目录残留锁文件，界面只显示 HTTP 500）。
     */
    public func handle(ctx: HttpContext): Unit {
        try {
            route(ctx)
        } catch (e: Exception) {
            // 这条日志是排障的命根子：只回一个 500 而不说话，前端和日志两边都看不出原因
            println("[api] " + ctx.request.method + " " + ctx.request.url.path + " 失败：" + e.message)
            try {
                fail(ctx, 500, describeFailure(e.message))
            } catch (_: Exception) {
                ()
            }
        }
    }

    /** 真正的路由分发。 */
    func route(ctx: HttpContext): Unit {
        let path = ctx.request.url.path
        let method = ctx.request.method

        if (path == "/health" && method == "GET") {
            let o = JsonObject()
            o.put("status", JsonString("ok"))
            o.put("service", JsonString("itn-desktop-core"))
            o.put("cangjie", JsonString("1.2.0"))
            ok(ctx, o)
            return
        }

        if (path == "/api/settings" && method == "GET") {
            ok(ctx, settingsJson())
            return
        }

        if (path == "/api/models/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let s = store.load()
                    let incoming = ModelConfig.fromJson(b)
                    if (incoming.id.size == 0) {
                        fail(ctx, 400, "缺少 id")
                        return
                    }
                    var replaced = false
                    var i = 0
                    while (i < s.models.size) {
                        if (s.models[i].id == incoming.id) {
                            if (incoming.apiKey.size == 0) {
                                incoming.apiKey = s.models[i].apiKey
                            }
                            s.models[i] = incoming
                            replaced = true
                        }
                        i = i + 1
                    }
                    if (!replaced) {
                        s.models.add(incoming)
                    }
                    store.save(s)
                    ok(ctx, settingsJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/models/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    let s = store.load()
                    let kept = ArrayList<ModelConfig>()
                    for (m in s.models) {
                        if (m.id != id) {
                            kept.add(m)
                        }
                    }
                    s.models = kept
                    if (s.chatModelId == id) { s.chatModelId = "" }
                    if (s.embedModelId == id) { s.embedModelId = "" }
                    if (s.chunkModelId == id) { s.chunkModelId = "" }
                    store.save(s)
                    ok(ctx, settingsJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/models/roles" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let s = store.load()
                    s.chatModelId = strOf(b, "chatModelId")
                    s.embedModelId = strOf(b, "embedModelId")
                    s.chunkModelId = strOf(b, "chunkModelId")
                    store.save(s)
                    ok(ctx, settingsJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/models/test" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    match (store.load().findModel(id)) {
                        case Some(cfg) =>
                            try {
                                LlmClient(cfg).selfTest()
                                ok(ctx, JsonString("连通"))
                            } catch (e: Exception) {
                                fail(ctx, 502, "连接失败：" + e.message)
                            }
                        case None => fail(ctx, 404, "找不到模型配置：" + id)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/chat" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let s = store.load()
                    let requested = strOf(b, "modelId")
                    let effectiveId = if (requested.size > 0) { requested } else { s.chatModelId }
                    if (effectiveId.size == 0) {
                        fail(ctx, 400, "没有指定对话模型，请先在设置里配置")
                        return
                    }
                    match (s.findModel(effectiveId)) {
                        case Some(cfg) =>
                            // 不加捕获会让异常直接变成不透明的 500，用户看不到原因
                            try {
                                let reply = LlmClient(cfg).chat(strOf(b, "system"), strOf(b, "user"))
                                let o = JsonObject()
                                o.put("reply", JsonString(reply))
                                o.put("modelId", JsonString(effectiveId))
                                ok(ctx, o)
                            } catch (e: Exception) {
                                fail(ctx, 502, "模型调用失败：" + e.message)
                            }
                        case None => fail(ctx, 404, "找不到模型配置：" + effectiveId)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/models/diagnose" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    match (store.load().findModel(strOf(b, "id"))) {
                        case Some(cfg) =>
                            let o = JsonObject()
                            o.put("endpoint", JsonString(cfg.baseUrl))
                            o.put("attempts", tlsProbe(LlmClient(cfg).endpoint("/chat/completions"), cfg.apiKey))
                            ok(ctx, o)
                        case None => fail(ctx, 404, "找不到模型配置")
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 知识库 ----------

        if (path == "/api/kb/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    if (id.size == 0) {
                        fail(ctx, 400, "缺少 id")
                        return
                    }
                    let s = store.load()
                    var replaced = false
                    var i = 0
                    while (i < s.knowledgeBases.size) {
                        if (s.knowledgeBases[i].id == id) {
                            s.knowledgeBases[i].name = strOf(b, "name")
                            s.knowledgeBases[i].rootDir = strOf(b, "rootDir")
                            replaced = true
                        }
                        i = i + 1
                    }
                    if (!replaced) {
                        let kb = KnowledgeBase()
                        kb.id = id
                        kb.name = strOf(b, "name")
                        kb.rootDir = strOf(b, "rootDir")
                        s.knowledgeBases.add(kb)
                    }
                    store.save(s)
                    ok(ctx, settingsJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/kb/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    let s = store.load()
                    let kept = ArrayList<KnowledgeBase>()
                    for (kb in s.knowledgeBases) {
                        if (kb.id != id) {
                            kept.add(kb)
                        }
                    }
                    s.knowledgeBases = kept
                    store.save(s)
                    ok(ctx, settingsJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/kb/build" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    let s = store.load()
                    match (s.findKb(id)) {
                        case Some(kb) =>
                            if (kb.rootDir.size == 0) {
                                fail(ctx, 400, "知识库未设置目录")
                                return
                            }
                            var maxChars: Int64 = 1200
                            let requested = intOf(b, "maxChars")
                            if (requested > 0) { maxChars = requested }
                            try {
                                let idx = chunkAll(kb.rootDir, maxChars)
                                if (idx.chunks.size == 0) {
                                    var why = "目录里没有找到可读的文件（支持 Markdown / 文本 / CSV / HTML / 日志 / JSON）"
                                    if (idx.scan.total() > 0) {
                                        why = why + "；这个目录里被跳过的是：" + idx.scan.summary()
                                    }
                                    fail(ctx, 400, why)
                                    return
                                }
                                var captioned: Int64 = 0
                                if (s.chunkModelId.size > 0) {
                                    match (s.findModel(s.chunkModelId)) {
                                        case Some(cc) =>
                                            let vm = if (cc.visionModel.size > 0) { cc.visionModel } else { cc.model }
                                            captioned = captionChunks(kb.rootDir, idx, LlmClient(cc), vm)
                                        case None => ()
                                    }
                                }
                                // 向量模型可选：没配就只做关键词可检索的索引
                                // 向量模型可选：没配就只做关键词可检索的索引。
                                // 配了但服务端不提供 /embeddings（例如 MiMo TokenPlan）时也一样：
                                // 这是"少了一种检索方式"，不是"这次索引失败"——整库照样落盘，
                                // 只把原因带回去，让界面用琥珀色说清楚。
                                var done: Int64 = 0
                                var embedError = ""
                                if (s.embedModelId.size > 0) {
                                    match (s.findModel(s.embedModelId)) {
                                        case Some(embedCfg) =>
                                            try {
                                                done = embedChunks(idx, LlmClient(embedCfg), 16)
                                            } catch (e: Exception) {
                                                embedError = e.message
                                                done = 0
                                            }
                                        case None => ()
                                    }
                                }
                                idx.kbId = id
                                idx.builtAt = stamp()
                                saveIndex(store.dataDir, id, idx)
                                putIndexCache(store.dataDir, id, idx)
                                kb.docCount = idx.docCount()
                                kb.chunkCount = idx.chunks.size
                                kb.imageCount = idx.imageCount()
                                kb.builtAt = idx.builtAt
                                store.save(s)
                                let o = kb.toJson()
                                o.put("embedded", JsonInt(done))
                                o.put("embedError", JsonString(embedError))
                                o.put("captioned", JsonInt(captioned))
                                // 这次扫描跳过了什么，一并回给界面
                                o.put("skipped", idx.scan.toJson())
                                o.put("skippedSummary", JsonString(idx.scan.summary()))
                                o.put("skippedTotal", JsonInt(idx.scan.total()))
                                // 也记一份在库里，方便以后在知识库页面回看
                                DbHub.open(store.dataDir).putKv("meta", "kb-skipped:" + id, idx.scan.summary())
                                DbHub.open(store.dataDir).putKv("meta", "kb-embed-error:" + id, embedError)
                                ok(ctx, o)
                            } catch (e: Exception) {
                                fail(ctx, 500, "建立索引失败：" + e.message)
                            }
                        case None => fail(ctx, 404, "找不到知识库：" + id)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/kb/stats" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    let s = store.load()
                    match (s.findKb(id)) {
                        case Some(kb) =>
                            let idx = loadIndexCached(store.dataDir, id)
                            let o = kb.toJson()
                            o.put("loadedChunks", JsonInt(idx.chunks.size))
                            o.put("skippedSummary", JsonString(DbHub.open(store.dataDir).getKv("meta", "kb-skipped:" + id, "")))
                            o.put("embedError", JsonString(DbHub.open(store.dataDir).getKv("meta", "kb-embed-error:" + id, "")))
                            ok(ctx, o)
                        case None => fail(ctx, 404, "找不到知识库：" + id)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/kb/search" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    let query = strOf(b, "query")
                    if (query.size == 0) {
                        fail(ctx, 400, "缺少 query")
                        return
                    }
                    var topK: Int64 = 5
                    let reqK = intOf(b, "topK")
                    if (reqK > 0) { topK = reqK }
                    let s = store.load()
                    let idx = loadIndexCached(store.dataDir, id)
                    if (idx.chunks.size == 0) {
                        fail(ctx, 404, "该知识库还没有索引，请先建立索引")
                        return
                    }
                    // 向量模型可选，未配置时退回关键词检索
                    var hits = ArrayList<SearchHit>()
                    var mode = "关键词"
                    if (s.embedModelId.size > 0) {
                        match (s.findModel(s.embedModelId)) {
                            case Some(cfg) =>
                                try {
                                    let qv = LlmClient(cfg).embed([query])
                                    hits = search(idx, qv[0], topK)
                                    mode = "向量"
                                } catch (e: Exception) {
                                    hits = keywordSearch(idx, query, topK)
                                    mode = "关键词"
                                }
                            case None =>
                                hits = keywordSearch(idx, query, topK)
                        }
                    } else {
                        hits = keywordSearch(idx, query, topK)
                    }
                    let arr = JsonArray()
                    for (h in hits) {
                        arr.add(chunkJson(h.chunk, h.score))
                    }
                    let o = JsonObject()
                    o.put("hits", arr)
                    o.put("mode", JsonString(mode))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }


        // ---------- Agent ----------

        if (path == "/api/agent/ask" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let question = strOf(b, "question")
                    if (question.size == 0) {
                        fail(ctx, 400, "缺少 question")
                        return
                    }
                    let ag = Agent(store)
                    try {
                        // web：本次请求的联网档位（""=跟着设置走），会话级开关也在这里落地
                        ok(ctx, ag.askWeb(strOf(b, "kbId"), question, strOf(b, "sessionId"),
                            strOf(b, "web"), trimStr(strOf(b, "skill"))))
                    } catch (e: Exception) {
                        fail(ctx, 500, "问答失败：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/agent/lecture" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let topic = strOf(b, "topic")
                    if (topic.size == 0) {
                        fail(ctx, 400, "缺少 topic")
                        return
                    }
                    let ag = Agent(store)
                    try {
                        ok(ctx, ag.lecture(strOf(b, "kbId"), topic, strOf(b, "sessionId")))
                    } catch (e: Exception) {
                        fail(ctx, 500, "生成讲义失败：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/agent/quiz" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let topic = strOf(b, "topic")
                    if (topic.size == 0) {
                        fail(ctx, 400, "缺少 topic")
                        return
                    }
                    var count: Int64 = 5
                    let reqCount = intOf(b, "count")
                    if (reqCount > 0) { count = reqCount }
                    let ag = Agent(store)
                    try {
                        ok(ctx, ag.quiz(strOf(b, "kbId"), topic, count, strOf(b, "sessionId")))
                    } catch (e: Exception) {
                        fail(ctx, 500, "生成练习失败：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 界面偏好 ----------
        // 存进那张一直空着的 settings 键值表。
        // 为什么不放 localStorage：内核端口每次启动都不同，浏览器把不同端口当不同站点，
        // localStorage 根本活不过一次重启。界面偏好必须跟着数据目录走。
        if (path == "/api/prefs/get" && method == "POST") {
            let db = DbHub.open(store.dataDir)
            let o = JsonObject()
            o.put("theme", JsonString(db.getKv("settings", "ui_theme", "system")))
            o.put("sessionRail", JsonString(db.getKv("settings", "ui_session_rail", "1")))
            o.put("rail", JsonString(db.getKv("settings", "ui_rail", "1")))
            ok(ctx, o)
            return
        }

        if (path == "/api/prefs/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let db = DbHub.open(store.dataDir)
                    let theme = strOf(b, "theme")
                    if (theme == "light" || theme == "dark" || theme == "system") {
                        db.putKv("settings", "ui_theme", theme)
                    }
                    let rail = strOf(b, "sessionRail")
                    if (rail == "0" || rail == "1") {
                        db.putKv("settings", "ui_session_rail", rail)
                    }
                    // 图标侧栏的显隐（Ctrl+Shift+S）也要记住：它和"对话页要不要会话栏"是两件事
                    let railPref = strOf(b, "rail")
                    if (railPref == "0" || railPref == "1") {
                        db.putKv("settings", "ui_rail", railPref)
                    }
                    let o = JsonObject()
                    o.put("theme", JsonString(db.getKv("settings", "ui_theme", "system")))
                    o.put("sessionRail", JsonString(db.getKv("settings", "ui_session_rail", "1")))
                    o.put("rail", JsonString(db.getKv("settings", "ui_rail", "1")))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 联网搜索（Tavily） ----------
        // 和模型配置并列的一类"外部服务"：密钥只写进本机数据库，读回来只给掩码，
        // 不给前端回传完整密钥。enabled 用 "0"/"1" 字符串，和界面偏好保持同一种约定。
        if (path == "/api/websearch/get" && method == "POST") {
            ok(ctx, webSearchJson(store.dataDir))
            return
        }

        if (path == "/api/websearch/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    var n: Int64 = 0
                    let r = intOf(b, "results")
                    if (r > 0) {
                        n = r
                    } else {
                        n = webSearchResults(store.dataDir)
                    }
                    // 留空 = 保留原密钥；要真的删掉得显式说 clearKey=1（否则用户永远清不掉一把填错的密钥）
                    if (strOf(b, "clearKey") == "1") {
                        DbHub.open(store.dataDir).delKv(WEB_SEARCH_TABLE, "web_search_key")
                    }
                    // enabled 既可能是 JSON 布尔也可能是 "0"/"1" 字符串，两种都认
                    saveWebSearch(store.dataDir, strOf(b, "apiKey"),
                        boolOf(b, "enabled") || strOf(b, "enabled") == "1", n)
                    let m = strOf(b, "mode")
                    if (m == "off" || m == "auto" || m == "always") {
                        saveWebMode(store.dataDir, m)
                    }
                    ok(ctx, webSearchJson(store.dataDir))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/websearch/test" && method == "POST") {
            // 允许"还没保存就先试一下"：请求里带了 apiKey 就先用它
            match (bodyJson(ctx)) {
                case Some(b) =>
                    var key = trimStr(strOf(b, "apiKey"))
                    if (key.size == 0) {
                        key = webSearchKey(store.dataDir)
                    }
                    if (key.size == 0) {
                        fail(ctx, 400, "还没有填 Tavily API Key")
                        return
                    }
                    var q = trimStr(strOf(b, "query"))
                    if (q.size == 0) {
                        q = "Tavily 联网搜索连通性测试"
                    }
                    var limit: Int64 = 3
                    let rq = intOf(b, "results")
                    if (rq > 0) {
                        limit = rq
                    }
                    try {
                        let hits = WebSearchClient(key).search(q, limit)
                        let o = JsonObject()
                        o.put("ok", JsonBool(true))
                        o.put("count", JsonInt(hits.size()))
                        o.put("first", JsonString(pickStr(hits[0], ["title"])))
                        o.put("url", JsonString(pickStr(hits[0], ["url"])))
                        ok(ctx, o)
                    } catch (e: Exception) {
                        // 502：上游（Tavily）的问题，不是本机的问题
                        fail(ctx, 502, e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 联网抓取（web_fetch 的手动入口 + 缓存审计） ----------
        if (path == "/api/web/fetch" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let url = trimStr(strOf(b, "url"))
                    if (url.size == 0) {
                        fail(ctx, 400, "缺少 url")
                        return
                    }
                    try {
                        ok(ctx, fetchPage(store.dataDir, url))
                    } catch (e: Exception) {
                        fail(ctx, 502, e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/web/cache" && method == "POST") {
            // mode 给的是"这段会话实际用哪一档"：会话里改过就是会话的，否则是全局设置。
            // 界面靠它把输入区那个 chip 画对，所以不能只回全局。
            var sid = ""
            match (bodyJson(ctx)) {
                case Some(b) => sid = strOf(b, "sessionId")
                case None => ()
            }
            let o = JsonObject()
            o.put("pages", listWebCache(store.dataDir))
            o.put("dir", JsonString(webCacheDir(store.dataDir)))
            o.put("mode", JsonString(effectiveWebMode(store.dataDir, sid, "")))
            o.put("globalMode", JsonString(webMode(store.dataDir)))
            ok(ctx, o)
            return
        }

        if (path == "/api/web/cache/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let name = strOf(b, "name")
                    if (deleteWebCache(store.dataDir, name)) {
                        ok(ctx, JsonString("ok"))
                    } else {
                        fail(ctx, 404, "找不到这一页缓存：" + name)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/web/session" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    saveSessionWebMode(store.dataDir, sid, trimStr(strOf(b, "mode")))
                    let o = JsonObject()
                    o.put("mode", JsonString(effectiveWebMode(store.dataDir, sid, "")))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 技能（Skill）：写个 Markdown 就多一种"用法说明书" ----------
        if (path == "/api/skills/list" && method == "POST") {
            var sid = ""
            match (bodyJson(ctx)) {
                case Some(b) => sid = strOf(b, "sessionId")
                case None => ()
            }
            let db = DbHub.open(store.dataDir)
            let webAllowed = webMode(store.dataDir) != "off"
            let bound = if (sid.size > 0) { db.getKv("meta", "skill:" + sid, "") } else { "" }
            let arr = JsonArray()
            for (s in listSkills(store.dataDir, webAllowed)) {
                arr.add(skillJson(s))
            }
            let o = JsonObject()
            o.put("skills", arr)
            o.put("bound", JsonString(bound))
            o.put("userDir", JsonString(userSkillsDir(store.dataDir)))
            o.put("bundledDir", JsonString(SKILLS_BUNDLED_DIR))
            ok(ctx, o)
            return
        }

        if (path == "/api/skills/read" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    match (readSkill(store.dataDir, id, webMode(store.dataDir) != "off")) {
                        case Some(pair) =>
                            let o = skillJson(pair[0])
                            o.put("body", JsonString(pair[1]))
                            ok(ctx, o)
                        case None => fail(ctx, 404, "没有这个技能：" + id)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/skills/bind" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    let id = trimStr(strOf(b, "skill"))
                    // 空串 = 解除绑定（回到"让模型自己挑"）
                    DbHub.open(store.dataDir).putKv("meta", "skill:" + sid, id)
                    let o = JsonObject()
                    o.put("bound", JsonString(id))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/skills/template" && method == "POST") {
            let dir = userSkillsDir(store.dataDir)
            ensureDir(dir)
            let p = writeTemplateSkill(store.dataDir, "_template")
            let o = JsonObject()
            o.put("path", JsonString(p))
            ok(ctx, o)
            return
        }

        // ---------- 学习网络图（只读聚合） ----------
        // 前端不拼 N 个接口：一次给它"节点 + 连边 + 统计 + 折叠了多少"。
        if (path == "/api/graph" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    // 不指定就取登记的第一个知识库：界面没选库时也画得出图
                    var kb = strOf(b, "kbId")
                    if (kb.size == 0) {
                        let cfg = store.load()
                        if (cfg.knowledgeBases.size > 0) {
                            kb = cfg.knowledgeBases[0].id
                        }
                    }
                    try {
                        ok(ctx, buildGraph(store.dataDir, kb))
                    } catch (e: Exception) {
                        fail(ctx, 500, "算不出学习网络：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/agent/cancel" && method == "POST") {
            // 置一个取消标记：正在跑的那一轮会在下一段流式增量处停下来
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    requestCancel(sid)
                    ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/tools/list" && method == "POST") {
            let o = JsonObject()
            o.put("tools", Agent(store).toolsJson())
            ok(ctx, o)
            return
        }

        // ---------- 会话与产物 ----------

        if (path == "/api/sessions/new" && method == "POST") {
            // 界面点「新建对话」时先开一个会话 id，这样提问前就能把它显示在会话栏里，
            // 生成过程中也能按这个 id 轮询事件做流式输出。
            let ss = SessionStore(store.dataDir)
            let o = JsonObject()
            o.put("sessionId", JsonString(ss.newId()))
            ok(ctx, o)
            return
        }

        if (path == "/api/sessions/list" && method == "POST") {
            let ss = SessionStore(store.dataDir)
            let arr = JsonArray()
            for (sm in ss.list()) {
                arr.add(sm)
            }
            let o = JsonObject()
            o.put("sessions", arr)
            ok(ctx, o)
            return
        }

        if (path == "/api/sessions/events" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "sessionId")
                    if (id.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    let ss = SessionStore(store.dataDir)
                    let arr = JsonArray()
                    for (ev in ss.events(id)) {
                        arr.add(ev)
                    }
                    let o = JsonObject()
                    o.put("events", arr)
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/artifacts/list" && method == "POST") {
            let dir = store.dataDir + Path.Separator + "artifacts"
            ensureDir(dir)
            let arr = JsonArray()
            try {
                let pdb = DbHub.open(store.dataDir)
                Directory.walk(Path(dir), { fi: FileInfo =>
                    if (!fi.isDirectory()) {
                        let o = JsonObject()
                        o.put("name", JsonString(fi.name))
                        o.put("path", JsonString(dir + Path.Separator + fi.name))
                        o.put("size", JsonInt(fi.size))
                        // 播放进度存在 meta 键值表里，形如 "3|12|2026-10-14T..."
                        let raw = pdb.getKv("meta", "artprog:" + fi.name, "")
                        let parts = raw.split("|")
                        o.put("page", JsonInt(kvInt(parts, 0)))
                        o.put("pageCount", JsonInt(kvInt(parts, 1)))
                        o.put("progressAt", JsonString(kvStr(parts, 2)))
                        arr.add(o)
                    }
                    true
                })
            } catch (e: Exception) {
                ()
            }
            let o = JsonObject()
            o.put("artifacts", arr)
            ok(ctx, o)
            return
        }

        // ---------- 学习者档案 ----------

        if (path == "/api/artifacts/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let name = strOf(b, "name")
                    if (name.size == 0) {
                        fail(ctx, 400, "缺少 name")
                        return
                    }
                    // sanitizeName 会把分隔符等换成下划线；换完与原名不同，说明名字里有不该有的字符
                    if (sanitizeName(name) != name) {
                        fail(ctx, 400, "产物名不合法：" + name)
                        return
                    }
                    let full = store.dataDir + Path.Separator + "artifacts" + Path.Separator + name
                    if (!exists(full)) {
                        fail(ctx, 404, "找不到产物：" + name)
                        return
                    }
                    try {
                        remove(full)
                        // 播放进度也一起清掉，免得换个同名文件时"续播"到不该有的页码
                        DbHub.open(store.dataDir).putKv("meta", "artprog:" + name, "")
                        ok(ctx, JsonString("ok"))
                    } catch (e: Exception) {
                        fail(ctx, 500, "删除失败：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/artifacts/rename" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let name = strOf(b, "name")
                    var newName = trimStr(strOf(b, "newName"))
                    if (name.size == 0 || newName.size == 0) {
                        fail(ctx, 400, "缺少 name 或 newName")
                        return
                    }
                    // 没写扩展名就补 .md（产物本来就是 Markdown）
                    let nb = newName.toArray()
                    if (nb.size < 3 || nb[nb.size - 3] != 46 || nb[nb.size - 2] != 109 || nb[nb.size - 1] != 100) {
                        newName = newName + ".md"
                    }
                    if (sanitizeName(name) != name || sanitizeName(newName) != newName) {
                        fail(ctx, 400, "产物名不合法")
                        return
                    }
                    let dir = store.dataDir + Path.Separator + "artifacts"
                    let from = dir + Path.Separator + name
                    let to = dir + Path.Separator + newName
                    if (!exists(from)) {
                        fail(ctx, 404, "找不到产物：" + name)
                        return
                    }
                    if (exists(to)) {
                        fail(ctx, 400, "已经有同名产物：" + newName)
                        return
                    }
                    try {
                        // 这版标准库没有 File.copy，按字节读写
                        let bytes = File.readFrom(from)
                        File.writeTo(to, bytes)
                        remove(from)
                        // 播放进度跟着改名走
                        let kv = DbHub.open(store.dataDir)
                        let prog = kv.getKv("meta", "artprog:" + name, "")
                        if (prog.size > 0) {
                            kv.putKv("meta", "artprog:" + newName, prog)
                            kv.putKv("meta", "artprog:" + name, "")
                        }
                        ok(ctx, JsonString(newName))
                    } catch (e: Exception) {
                        fail(ctx, 500, "改名失败：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 数据与备份 ----------

        if (path == "/api/maintenance/status" && method == "POST") {
            let dir = store.dataDir + Path.Separator + "backups"
            ensureDir(dir)
            let arr = JsonArray()
            try {
                Directory.walk(Path(dir), { fi: FileInfo =>
                    if (!fi.isDirectory() && hasSuffix(fi.name, ".db")) {
                        let o = JsonObject()
                        o.put("name", JsonString(fi.name))
                        o.put("path", JsonString(dir + Path.Separator + fi.name))
                        o.put("size", JsonInt(fi.size))
                        arr.add(o)
                    }
                    true
                })
            } catch (e: Exception) {
                ()
            }
            let dbPath = store.dataDir + Path.Separator + "itn.db"
            let o = JsonObject()
            o.put("dataDir", JsonString(store.dataDir))
            o.put("dbPath", JsonString(dbPath))
            o.put("dbSize", JsonInt(fileSizeOf(dbPath)))
            o.put("backupDir", JsonString(dir))
            o.put("backups", arr)
            ok(ctx, o)
            return
        }

        if (path == "/api/maintenance/backup" && method == "POST") {
            let dir = store.dataDir + Path.Separator + "backups"
            ensureDir(dir)
            let src = store.dataDir + Path.Separator + "itn.db"
            if (!exists(src)) {
                fail(ctx, 404, "找不到数据库文件：" + src)
                return
            }
            var name = "itn-" + fileStamp() + ".db"
            var n = 2
            while (exists(dir + Path.Separator + name)) {
                name = "itn-" + fileStamp() + "-" + n.toString() + ".db"
                n = n + 1
            }
            let dst = dir + Path.Separator + name
            try {
                File.writeTo(dst, File.readFrom(src))
                // 数据库旁边若还有回滚日志，也一起带上：只拷主文件的话，
                // 那一瞬间的状态可能是不完整的，带上 journal 才回得去。
                let jrn = src + "-journal"
                if (exists(jrn)) {
                    File.writeTo(dst + "-journal", File.readFrom(jrn))
                }
            } catch (e: Exception) {
                fail(ctx, 500, "复制数据库失败：" + e.message)
                return
            }
            var rows: Int64 = -1
            try {
                rows = verifyBackup(dst)
            } catch (e: Exception) {
                // 拷出来打不开：删掉副本，让用户稍后重试（多半是刚好撞上一次写入）
                try {
                    remove(dst)
                } catch (_: Exception) {
                    ()
                }
                if (exists(dst + "-journal")) {
                    try {
                        remove(dst + "-journal")
                    } catch (_: Exception) {
                        ()
                    }
                }
                fail(ctx, 500, "备份校验没通过（可能正好撞上一次写入）：" + e.message + "。稍后再试即可。")
                return
            }
            let o = JsonObject()
            o.put("name", JsonString(name))
            o.put("path", JsonString(dst))
            o.put("size", JsonInt(fileSizeOf(dst)))
            o.put("at", JsonString(nowStamp()))
            o.put("verified", JsonBool(true))
            o.put("rows", JsonInt(rows))
            ok(ctx, o)
            return
        }

        if (path == "/api/maintenance/backups/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let name = strOf(b, "name")
                    if (name.size == 0 || sanitizeName(name) != name || !hasSuffix(name, ".db")) {
                        fail(ctx, 400, "备份名不合法：" + name)
                        return
                    }
                    let full = store.dataDir + Path.Separator + "backups" + Path.Separator + name
                    if (!exists(full)) {
                        fail(ctx, 404, "找不到备份：" + name)
                        return
                    }
                    try {
                        remove(full)
                        if (exists(full + "-journal")) {
                            remove(full + "-journal")
                        }
                        ok(ctx, JsonString("ok"))
                    } catch (e: Exception) {
                        fail(ctx, 500, "删除备份失败：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 课件播放进度 ----------

        if (path == "/api/artifacts/progress" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let name = strOf(b, "name")
                    if (name.size == 0) {
                        fail(ctx, 400, "缺少 name")
                        return
                    }
                    let parts = DbHub.open(store.dataDir).getKv("meta", "artprog:" + name, "").split("|")
                    let o = JsonObject()
                    o.put("name", JsonString(name))
                    o.put("page", JsonInt(kvInt(parts, 0)))
                    o.put("pageCount", JsonInt(kvInt(parts, 1)))
                    o.put("progressAt", JsonString(kvStr(parts, 2)))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/artifacts/progress/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let name = strOf(b, "name")
                    if (name.size == 0) {
                        fail(ctx, 400, "缺少 name")
                        return
                    }
                    var page: Int64 = 0
                    let reqPage = intOf(b, "page")
                    if (reqPage > 0) {
                        page = reqPage
                    }
                    var total: Int64 = 0
                    let reqTotal = intOf(b, "pageCount")
                    if (reqTotal > 0) {
                        total = reqTotal
                    }
                    DbHub.open(store.dataDir).putKv("meta", "artprog:" + name,
                        page.toString() + "|" + total.toString() + "|" + nowStamp())
                    ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 学习者档案 ----------

        if (path == "/api/profile/get" && method == "POST") {
            let d = StudyStore(store.dataDir).load()
            ok(ctx, d.profile.toJson())
            return
        }

        if (path == "/api/profile/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let ss = StudyStore(store.dataDir)
                    let d = ss.load()
                    d.profile.nickname = strOf(b, "nickname")
                    d.profile.goal = strOf(b, "goal")
                    let wh = intOf(b, "weeklyHours")
                    if (wh > 0) { d.profile.weeklyHours = wh }
                    d.profile.preferredFormats = strArrayOf(b, "preferredFormats")
                    match (b.get("selfScores")) {
                        case Some(sv) =>
                            match (objOf(sv)) {
                                case Some(so) =>
                                    for ((k, val) in so.getFields()) {
                                        d.profile.setScore(k, intValue(val))
                                    }
                                case None => ()
                            }
                        case None => ()
                    }
                    d.profile.updatedAt = nowStamp()
                    ss.save(d)
                    ok(ctx, d.profile.toJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 学习：知识网络与章节 ----------

        if (path == "/api/study/tree" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let kbId = strOf(b, "kbId")
                    let idx = loadIndexCached(store.dataDir, kbId)
                    if (idx.chunks.size == 0) {
                        fail(ctx, 404, "知识库还没有索引，请先建立索引")
                        return
                    }
                    let sd = StudyStore(store.dataDir).load()
                    let o = JsonObject()
                    o.put("chapters", buildChapterTree(idx, sd.progress, kbId))
                    o.put("chunkCount", JsonInt(idx.chunks.size))
                    o.put("docCount", JsonInt(idx.docCount()))
                    o.put("imageCount", JsonInt(idx.imageCount()))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/study/chapter" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let kbId = strOf(b, "kbId")
                    let chapter = strOf(b, "chapter")
                    let idx = loadIndexCached(store.dataDir, kbId)
                    let sd = StudyStore(store.dataDir).load()
                    let o = JsonObject()
                    o.put("chunks", chunksOfChapter(idx, sd.progress, kbId, chapter))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/study/read" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let ss = StudyStore(store.dataDir)
                    let sd = ss.load()
                    sd.progress.markRead(strOf(b, "kbId") + "|" + strOf(b, "chunkId"), nowStamp())
                    let chapter = strOf(b, "chapter")
                    if (boolOf(b, "chapterDone")) {
                        sd.progress.markChapterDone(strOf(b, "kbId") + "|" + chapter)
                    }
                    ss.save(sd)
                    ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/study/quiz/generate" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let kbId = strOf(b, "kbId")
                    let chapter = strOf(b, "chapter")
                    var count: Int64 = 5
                    let reqCount = intOf(b, "count")
                    if (reqCount > 0) { count = reqCount }
                    let s = store.load()
                    if (s.chatModelId.size == 0) {
                        fail(ctx, 400, "没有可用的对话模型，请先在设置里配置")
                        return
                    }
                    match (s.findModel(s.chatModelId)) {
                        case Some(cfg) =>
                            let idx = loadIndexCached(store.dataDir, kbId)
                            let sd = StudyStore(store.dataDir).load()
                            let chunks = chunksOfChapter(idx, sd.progress, kbId, chapter)
                            if (chunks.size() == 0) {
                                fail(ctx, 404, "该章节没有可出题的内容")
                                return
                            }
                            let material = contextFromChunks(chunks, 8)
                            let system = "你是教培测评设计者。只依据给定资料出题，题目必须能在资料里找到依据。"
                            let user = "依据下面的资料，为「" + chapter + "」出 " + count.toString() + " 道单选题。只输出一个 JSON 数组，不要任何解释、不要代码围栏。格式：[{\"question\":\"题干\",\"options\":[\"选项1\",\"选项2\",\"选项3\",\"选项4\"],\"answerIndex\":0,\"explain\":\"解析\",\"source\":\"对应章节\"}]\n\n资料：\n" + material
                            try {
                                let reply = LlmClient(cfg).chat(system, user)
                                let jsonArr = extractJsonArray(reply)
                                if (jsonArr.size == 0) {
                                    fail(ctx, 502, "模型没有返回可解析的题目")
                                    return
                                }
                                let o = JsonObject()
                                o.put("questions", JsonValue.fromStr(jsonArr))
                                ok(ctx, o)
                            } catch (e: Exception) {
                                fail(ctx, 502, "出题失败：" + e.message)
                            }
                        case None => fail(ctx, 404, "找不到模型配置")
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // 按章节的答题统计：学习单元要靠它显示"这一章练过多少、对了几道"
        if (path == "/api/study/quiz/stats" && method == "POST") {
            let grouped = ArrayList<JsonObject>()
            let keys = ArrayList<String>()
            for (r in DbHub.open(store.dataDir).querySql("SELECT kb_id, chapter, correct FROM quiz_records")) {
                let key = r.text(0) + "|" + r.text(1)
                var found = -1
                var i = 0
                while (i < keys.size) {
                    if (keys[i] == key) {
                        found = i
                    }
                    i = i + 1
                }
                if (found < 0) {
                    let o = JsonObject()
                    o.put("kbId", JsonString(r.text(0)))
                    o.put("chapter", JsonString(r.text(1)))
                    o.put("total", JsonInt(0))
                    o.put("right", JsonInt(0))
                    o.put("wrong", JsonInt(0))
                    keys.add(key)
                    grouped.add(o)
                    found = grouped.size - 1
                }
                let g = grouped[found]
                g.put("total", JsonInt(intOf(g, "total") + 1))
                if (r.text(2) == "1" || r.text(2) == "true" || r.text(2) == "TRUE") {
                    g.put("right", JsonInt(intOf(g, "right") + 1))
                } else {
                    g.put("wrong", JsonInt(intOf(g, "wrong") + 1))
                }
            }
            let arr = JsonArray()
            for (g in grouped) {
                arr.add(g)
            }
            let o = JsonObject()
            o.put("chapters", arr)
            ok(ctx, o)
            return
        }

        // ---------- 笔记 ----------

        if (path == "/api/study/notes/list" && method == "POST") {
            let d = StudyStore(store.dataDir).load()
            let arr = JsonArray()
            var i = d.notes.size - 1
            while (i >= 0) {
                arr.add(d.notes[i].toJson())
                i = i - 1
            }
            let o = JsonObject()
            o.put("notes", arr)
            ok(ctx, o)
            return
        }

        if (path == "/api/study/notes/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let ss = StudyStore(store.dataDir)
                    let d = ss.load()
                    let id = strOf(b, "id")
                    var found = false
                    for (n in d.notes) {
                        if (n.id == id && id.size > 0) {
                            n.title = strOf(b, "title")
                            n.text = strOf(b, "text")
                            found = true
                        }
                    }
                    if (!found) {
                        let n = StudyNote()
                        n.id = "n" + nowStamp() + d.notes.size.toString()
                        n.kbId = strOf(b, "kbId")
                        n.chapter = strOf(b, "chapter")
                        n.title = strOf(b, "title")
                        n.text = strOf(b, "text")
                        n.createdAt = nowStamp()
                        d.notes.add(n)
                    }
                    ss.save(d)
                    ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/study/notes/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let ss = StudyStore(store.dataDir)
                    let d = ss.load()
                    let id = strOf(b, "id")
                    let kept = ArrayList<StudyNote>()
                    for (n in d.notes) {
                        if (n.id != id) {
                            kept.add(n)
                        }
                    }
                    d.notes = kept
                    ss.save(d)
                    ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 答题与错题 ----------

        if (path == "/api/study/quiz/submit" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let ss = StudyStore(store.dataDir)
                    let d = ss.load()
                    let r = QuizRecord()
                    r.id = "q" + nowStamp() + d.quizRecords.size.toString()
                    r.kbId = strOf(b, "kbId")
                    r.chapter = strOf(b, "chapter")
                    r.question = strOf(b, "question")
                    r.myAnswer = strOf(b, "myAnswer")
                    r.reference = strOf(b, "reference")
                    r.correct = boolOf(b, "correct")
                    r.createdAt = nowStamp()
                    d.quizRecords.add(r)
                    ss.save(d)
                    // 存下原始题目（选项 / 正确项 / 解析）：以后"重做"才能给出一模一样的题，
                    // 而不是只能让用户对着参考答案自评
                    let origin = JsonObject()
                    match (b.get("options")) {
                        case Some(ov) =>
                            match (arrOf(ov)) {
                                case Some(oa) => origin.put("options", oa)
                                case None => ()
                            }
                        case None => ()
                    }
                    origin.put("answerIndex", JsonInt(intOf(b, "answerIndex")))
                    origin.put("explain", JsonString(strOf(b, "explain")))
                    origin.put("source", JsonString(strOf(b, "source")))
                    if (origin.get("options").isSome()) {
                        DbHub.open(store.dataDir).putKv("meta", "quiz-q:" + r.id, origin.toString())
                    }
                    ok(ctx, r.toJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/study/wrong" && method == "POST") {
            let d = StudyStore(store.dataDir).load()
            let db = DbHub.open(store.dataDir)
            let nowMs = DateTime.now().toUnixTimeStamp().toMilliseconds()
            let arr = JsonArray()
            var i = d.quizRecords.size - 1
            while (i >= 0) {
                if (!d.quizRecords[i].correct) {
                    let r = d.quizRecords[i]
                    let ro = r.toJson()
                    attachReviewState(db, ro, r.id, nowMs)
                    arr.add(ro)
                }
                i = i - 1
            }
            let o = JsonObject()
            o.put("records", arr)
            ok(ctx, o)
            return
        }

        // 复习一条错题：correct 表示这次重做对不对（推进/重置复习曲线），mastered 是显式掌握开关
        if (path == "/api/study/wrong/review" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    if (id.size == 0) {
                        fail(ctx, 400, "缺少 id")
                        return
                    }
                    let db = DbHub.open(store.dataDir)
                    let key = "quiz-review:" + id
                    let parts = db.getKv("meta", key, "").split("|")
                    var reviews = kvInt(parts, 0)
                    var lastMs = kvInt(parts, 1)
                    var mastered = kvInt(parts, 2) == 1
                    let nowMs = DateTime.now().toUnixTimeStamp().toMilliseconds()
                    var hasCorrect = false
                    var correctVal = false
                    match (b.get("correct")) {
                        case Some(v) =>
                            match (boolValueOf(v)) {
                                case Some(x) =>
                                    hasCorrect = true
                                    correctVal = x
                                case None => ()
                            }
                        case None => ()
                    }
                    if (hasCorrect) {
                        if (correctVal) {
                            reviews = reviews + 1
                        } else {
                            // 又答错了：回到"当天就要复习"
                            reviews = 0
                        }
                        lastMs = nowMs
                    }
                    match (b.get("mastered")) {
                        case Some(v) =>
                            match (boolValueOf(v)) {
                                case Some(x) => mastered = x
                                case None => ()
                            }
                        case None => ()
                    }
                    db.putKv("meta", key,
                        reviews.toString() + "|" + lastMs.toString() + "|" + (if (mastered) { "1" } else { "0" }))
                    let o = JsonObject()
                    o.put("id", JsonString(id))
                    attachReviewState(db, o, id, nowMs)
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 学习报告 ----------

        if (path == "/api/study/report" && method == "POST") {
            let d = StudyStore(store.dataDir).load()
            let rd = DbHub.open(store.dataDir)
            let rNow = DateTime.now().toUnixTimeStamp().toMilliseconds()
            var dueCount: Int64 = 0
            var right: Int64 = 0
            var wrong: Int64 = 0
            for (r in d.quizRecords) {
                if (r.correct) {
                    right = right + 1
                } else {
                    wrong = wrong + 1
                    let pts = rd.getKv("meta", "quiz-review:" + r.id, "").split("|")
                    let rev = kvInt(pts, 0)
                    let last = kvInt(pts, 1)
                    let mas = kvInt(pts, 2) == 1
                    if (!mas && (rev == 0 || rNow >= last + reviewIntervalMs(rev))) {
                        dueCount = dueCount + 1
                    }
                }
            }
            let o = JsonObject()
            o.put("readChunks", JsonInt(d.progress.readChunks.size))
            o.put("completedChapters", JsonInt(d.progress.completedChapters.size))
            o.put("noteCount", JsonInt(d.notes.size))
            o.put("quizTotal", JsonInt(d.quizRecords.size))
            o.put("quizRight", JsonInt(right))
            o.put("quizWrong", JsonInt(wrong))
        o.put("wrongDue", JsonInt(dueCount))
            o.put("profile", d.profile.toJson())
            ok(ctx, o)
            return
        }

        if (path == "/api/artifacts/read" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let name = strOf(b, "name")
                    // 只允许读取产物目录下的白名单文件名，避免路径穿越
                    if (sanitizeName(name) != name) {
                        fail(ctx, 400, "非法的产物名")
                        return
                    }
                    let full = store.dataDir + Path.Separator + "artifacts" + Path.Separator + name
                    if (!exists(full)) {
                        fail(ctx, 404, "找不到该产物")
                        return
                    }
                    let o = JsonObject()
                    o.put("name", JsonString(name))
                    o.put("content", JsonString(String.fromUtf8(File.readFrom(full))))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        fail(ctx, 404, "未知接口：" + method + " " + path)
    }
}

func contentTypeOf(name: String): String {
    let n = name
    let b = n.toArray()
    var dot = -1
    var i = 0
    while (i < b.size) {
        if (b[i] == 46) { dot = i }
        i = i + 1
    }
    if (dot < 0) { return "application/octet-stream" }
    let ext = String.fromUtf8(b[(dot + 1)..b.size])
    if (ext == "html") { return "text/html; charset=utf-8" }
    if (ext == "js") { return "application/javascript; charset=utf-8" }
    if (ext == "css") { return "text/css; charset=utf-8" }
    if (ext == "svg") { return "image/svg+xml" }
    if (ext == "json") { return "application/json; charset=utf-8" }
    return "application/octet-stream"
}

func serveStatic(ctx: HttpContext, uiDir: String, rel: String): Unit {
    let name = if (rel == "/") { "index.html" } else { String.fromUtf8(rel.toArray()[1..rel.toArray().size]) }
    // 只允许白名单文件名，避免路径穿越
    let allowed = ["index.html", "app.js", "style.css"]
    var ok = false
    for (a in allowed) {
        if (a == name) { ok = true }
    }
    if (!ok) {
        ctx.responseBuilder.status(404)
        ctx.responseBuilder.body("not found".toArray())
        return
    }
    let full = uiDir + Path.Separator + name
    if (!exists(full)) {
        ctx.responseBuilder.status(404)
        ctx.responseBuilder.body(("missing static file: " + name).toArray())
        return
    }
    ctx.responseBuilder.status(200)
    ctx.responseBuilder.header("Content-Type", contentTypeOf(name))
    ctx.responseBuilder.body(File.readFrom(full))
}

/**
 * 把异常信息翻译成用户能照做的提示。
 *
 * 数据库被占用是本产品最可能碰到的"看不懂的错"：驱动用锁文件做跨进程互斥，
 * 上一次进程被强杀就会留下锁文件，之后每个要读库的请求都会 busy。
 */
/** 文件名安全的时间戳：20261014-110804。用不了就退回毫秒数。 */
func fileStamp(): String {
    let raw = nowStamp()
    let b = raw.toArray()
    let out = ArrayList<UInt8>()
    var i = 0
    while (i < b.size) {
        let c = b[i]
        if (c >= 48 && c <= 57) {
            out.add(c)
        } else if (c == 84) {
            out.add(45)   // 'T' -> '-'
        }
        i = i + 1
    }
    let s = String.fromUtf8(out.toArray())
    if (s.size >= 15 && s.toArray()[8] == 45) {
        return String.fromUtf8(s.toArray()[0..15])
    }
    return if (s.size > 0) { s } else { "backup" }
}

func fileSizeOf(path: String): Int64 {
    try {
        let f = File(path, OpenMode.Read)
        let n = f.length
        f.close()
        return n
    } catch (e: Exception) {
        return 0
    }
}

/**
 * 校验一份备份能不能真的打开。
 *
 * 只做文件复制是不够的：拷的瞬间如果正好有一次写入，拷出来可能是不一致的。
 * 这里的做法是把副本当数据库打开、数一下 meta 表的行数——能打开、能查询，才算这份备份可用。
 * 副本有独立的 -cjflock，不会和主库互相干扰。
 */
func verifyBackup(path: String): Int64 {
    let db = Db.openFile(path)
    try {
        return db.scalarInt("SELECT COUNT(*) FROM meta", ArrayList<DbValue>())
    } finally {
        db.close()
    }
}

func boolValueOf(v: JsonValue): ?Bool {
    match (v) {
        case jb: JsonBool => return Some(jb.getValue())
        case _ => return None
    }
}

/**
 * 间隔复习的节奏（毫秒）。
 *
 * 没错过的题当天就该复习；答对一次之后，隔 1 / 3 / 7 / 16 / 35 天再出现。
 * 这是错题本里唯一"算法"，单独写在一处，界面不再重复这套规则。
 */
/** 把一条错题记录附上复习状态（存在 meta 键值表里，不动表结构，老数据目录也能直接用）。 */
func describeFailure(message: String): String {
    if (message.split("cjflock").size > 1 || message.split("database is locked").size > 1) {
        return "本地数据库被另一个进程占用，无法读写：" + message +
            "。请先关闭所有 ITN-Desktop 窗口与内核进程再重试；确认没有进程在运行后，删除数据目录里的 itn.db-cjflock 即可恢复（该文件只是锁标记，删掉不影响数据）。"
    }
    return message
}

public func buildServer(dataDir: String, uiDir: String): Server {
    let server = ServerBuilder().addr("127.0.0.1").port(0).build()
    let api = Api(Store(dataDir))
    // 默认分发器按精确路径匹配，所有路由必须显式注册
    let routes = [
        "/health",
        "/api/settings",
        "/api/models/save",
        "/api/models/delete",
        "/api/models/roles",
        "/api/models/test",
        "/api/models/diagnose",
        "/api/chat",
        "/api/kb/save",
        "/api/kb/delete",
        "/api/kb/build",
        "/api/kb/stats",
        "/api/kb/search",
        "/api/agent/ask",
        "/api/agent/lecture",
        "/api/agent/quiz",
        "/api/maintenance/status",
        "/api/maintenance/backup",
        "/api/maintenance/backups/delete",
        "/api/agent/cancel",
        "/api/prefs/get",
        "/api/prefs/save",
        // 联网搜索（Tavily）：新增接口一定要在这里登记，否则分发器按精确路径匹配会直接 404
        "/api/websearch/get",
        "/api/websearch/save",
        "/api/websearch/test",
        "/api/web/fetch",
        "/api/web/cache",
        "/api/web/cache/delete",
        "/api/web/session",
        "/api/graph",
        "/api/skills/list",
        "/api/skills/read",
        "/api/skills/bind",
        "/api/skills/template",
        "/api/tools/list",
        "/api/sessions/new",
        "/api/sessions/list",
        "/api/sessions/events",
        "/api/profile/get",
        "/api/profile/save",
        "/api/study/tree",
        "/api/study/chapter",
        "/api/study/read",
        "/api/study/notes/list",
        "/api/study/notes/save",
        "/api/study/notes/delete",
        "/api/study/quiz/generate",
        "/api/study/quiz/submit",
        "/api/study/quiz/stats",
        "/api/study/wrong",
        "/api/study/wrong/review",
        "/api/study/report",
        "/api/artifacts/list",
        "/api/artifacts/delete",
        "/api/artifacts/rename",
        "/api/artifacts/progress",
        "/api/artifacts/progress/save",
        "/api/artifacts/read"
    ]
    for (r in routes) {
        server.distributor.register(r, { ctx: HttpContext => api.handle(ctx) })
    }
    // 界面由内核托管，外壳与界面同源，避免跨域
    let statics = ["/", "/index.html", "/app.js", "/style.css"]
    for (s in statics) {
        server.distributor.register(s, { ctx: HttpContext => serveStatic(ctx, uiDir, s) })
    }
    return server
}
