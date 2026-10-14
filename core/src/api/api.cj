package itn_desktop_core.api

import stdx.net.http.*
import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
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

    public func handle(ctx: HttpContext): Unit {
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
                                    fail(ctx, 400, "目录里没有找到 Markdown 或纯文本文件")
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
                                var done: Int64 = 0
                                if (s.embedModelId.size > 0) {
                                    match (s.findModel(s.embedModelId)) {
                                        case Some(embedCfg) =>
                                            done = embedChunks(idx, LlmClient(embedCfg), 16)
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
                                o.put("captioned", JsonInt(captioned))
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
                        ok(ctx, ag.ask(strOf(b, "kbId"), question, strOf(b, "sessionId")))
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

        // ---------- 会话与产物 ----------

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
                Directory.walk(Path(dir), { fi: FileInfo =>
                    if (!fi.isDirectory()) {
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
            let o = JsonObject()
            o.put("artifacts", arr)
            ok(ctx, o)
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
                    ok(ctx, r.toJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/study/wrong" && method == "POST") {
            let d = StudyStore(store.dataDir).load()
            let arr = JsonArray()
            var i = d.quizRecords.size - 1
            while (i >= 0) {
                if (!d.quizRecords[i].correct) {
                    arr.add(d.quizRecords[i].toJson())
                }
                i = i - 1
            }
            let o = JsonObject()
            o.put("records", arr)
            ok(ctx, o)
            return
        }

        // ---------- 学习报告 ----------

        if (path == "/api/study/report" && method == "POST") {
            let d = StudyStore(store.dataDir).load()
            var right: Int64 = 0
            var wrong: Int64 = 0
            for (r in d.quizRecords) {
                if (r.correct) { right = right + 1 } else { wrong = wrong + 1 }
            }
            let o = JsonObject()
            o.put("readChunks", JsonInt(d.progress.readChunks.size))
            o.put("completedChapters", JsonInt(d.progress.completedChapters.size))
            o.put("noteCount", JsonInt(d.notes.size))
            o.put("quizTotal", JsonInt(d.quizRecords.size))
            o.put("quizRight", JsonInt(right))
            o.put("quizWrong", JsonInt(wrong))
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
        "/api/study/wrong",
        "/api/study/report",
        "/api/artifacts/list",
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
