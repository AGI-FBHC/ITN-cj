package itn_desktop_core.api

import itn_desktop_core.learning.LearningStore
import itn_desktop_core.project.ProjectStore
import itn_desktop_core.agent.learningTools
import itn_desktop_core.pi_tools.DraftStore
import itn_desktop_core.resource.isResourceKind

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
import itn_desktop_core.pi_app.*
import itn_desktop_core.session.*
import itn_desktop_core.study.*
import itn_desktop_core.tools.*
import itn_desktop_core.harvest.*
import std.fs.*
import itn_desktop_core.util.*
import itn_desktop_core.pi.validatedAttachments

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
            o.put("version", JsonString("0.4.8"))
            o.put("build", JsonString("lumin-rebrand-20261015"))
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

        if (path == "/api/models/vision-test" && method == "POST") {
            match (chatModelOf(store)) {
                case Some(cfg) =>
                    let reply = LlmClient(cfg).chatVision(cfg.model, "请读取图片中央的验证码，只输出验证码，不要猜测。", visionProbeImage())
                    let passed = reply.replace(" ", "").replace("-", "").contains("K7P4")
                    let o = JsonObject(); o.put("supported", JsonBool(passed)); o.put("model", JsonString(cfg.model))
                    o.put("reason", JsonString(if (passed) { "当前对话模型已通过图片识别测试" } else { "当前对话模型未通过图片识别测试，请在设置中选择支持图片的模型" }))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请先配置对话模型")
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

        // 导入资料：文件夹原地登记；单独一个文件复制进受管资料目录（连它引用的图片一起）
        if (path == "/api/kb/import" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let src = strOf(b, "path")
                    if (src.size == 0) {
                        fail(ctx, 400, "缺少 path（要导入的文件或文件夹的绝对路径）")
                        return
                    }
                    let kind = strOf(b, "kind")
                    let s = store.load()
                    let base = baseNameOf(src)
                    var id = strOf(b, "id")
                    if (id.size == 0) {
                        // 同一处资料再导入一次：认出来（sourcePath 相同）就用回原来的库，别又建一个
                        for (k in s.knowledgeBases) {
                            if (k.sourcePath.size > 0 && k.sourcePath == src) {
                                id = k.id
                            }
                        }
                    }
                    if (id.size == 0) {
                        // 用"去掉扩展名的文件名"挤英文短名；中文名挤不出来就退到显示名，
                        // 再不行给一个带时间的兜底标识（别把标识挤成像 "md" 这种没意义的碎片）
                        id = slugOf(Path(base).fileNameWithoutExtension)
                        if (id.size == 0) {
                            id = slugOf(strOf(b, "name"))
                        }
                        if (id.size == 0) {
                            id = "kb"
                        }
                        var n = 2
                        var taken = true
                        while (taken) {
                            taken = false
                            match (s.findKb(id)) {
                                case Some(_) => taken = true
                                case None => ()
                            }
                            if (taken) {
                                id = id + "-" + n.toString()
                                n = n + 1
                            }
                        }
                    }
                    let info = importMaterial(store.dataDir, id, src, kind)
                    if (!info.ok) {
                        fail(ctx, 400, info.note)
                        return
                    }
                    var replaced = false
                    var i = 0
                    while (i < s.knowledgeBases.size) {
                        if (s.knowledgeBases[i].id == id) {
                            s.knowledgeBases[i].rootDir = info.rootDir
                            s.knowledgeBases[i].sourcePath = src
                            let given = strOf(b, "name")
                            if (given.size > 0) {
                                s.knowledgeBases[i].name = given
                            } else if (s.knowledgeBases[i].name.size == 0) {
                                s.knowledgeBases[i].name = base
                            }
                            replaced = true
                        }
                        i = i + 1
                    }
                    if (!replaced) {
                        let kb = KnowledgeBase()
                        kb.id = id
                        var nm = strOf(b, "name")
                        if (nm.size == 0) {
                            nm = base
                        }
                        kb.name = nm
                        kb.rootDir = info.rootDir
                        kb.sourcePath = src
                        s.knowledgeBases.add(kb)
                    }
                    store.save(s)
                    let o = settingsJson()
                    let ij = info.toJson()
                    ij.put("id", JsonString(id))
                    o.put("imported", ij)
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

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
                                // 整理好的目录（lumin 整理过就有）：有就按它组织章节
                                let ol = Outline.load(kbDir(store.dataDir, id) + Path.Separator + "outline.json")
                                let idx = chunkAllWith(kb.rootDir, maxChars, ol)
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
                                match (ol) {
                                    case Some(oo) =>
                                        o.put("organizedBy", JsonString(oo.source))
                                        o.put("outlineChapters", JsonInt(oo.chapters.size))
                                    case None => ()
                                }
                                o.put("skippedSummary", JsonString(idx.scan.summary()))
                                o.put("skippedTotal", JsonInt(idx.scan.total()))
                                // 也记一份在库里，方便以后在知识库页面回看
                                DbHub.open(store.dataDir).putKv("meta", "kb-skipped:" + id, idx.scan.summary())
                                DbHub.open(store.dataDir).putKv("meta", "kb-skipped-count:" + id, idx.scan.total().toString())
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

        // 让 lumin 把资料整理成一份教学目录（outline.json）；建索引时会自动按它组织
        if (path == "/api/kb/organize" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    if (id.size == 0) {
                        fail(ctx, 400, "缺少 id")
                        return
                    }
                    if (boolOf(b, "clear")) {
                        ok(ctx, clearOutline(store, id))
                        return
                    }
                    try {
                        let r = organizeKb(store, id)
                        if (boolOf(r, "ok")) {
                            ok(ctx, r)
                        } else {
                            fail(ctx, 400, strOf(r, "message"))
                        }
                    } catch (e: Exception) {
                        fail(ctx, 500, "整理失败：" + e.message)
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
                            // 未纳入的个数也回一个：界面要写"没纳入 N 个文件"，别让它自己数顿号
                            var skippedN: Int64 = 0
                            let skippedRaw = DbHub.open(store.dataDir).getKv("meta", "kb-skipped-count:" + id, "")
                            if (skippedRaw.size > 0) {
                                try {
                                    skippedN = Int64.parse(skippedRaw)
                                } catch (e: Exception) {
                                    skippedN = 0
                                }
                            }
                            o.put("skippedTotal", JsonInt(skippedN))
                            o.put("embedError", JsonString(DbHub.open(store.dataDir).getKv("meta", "kb-embed-error:" + id, "")))
                            // 这个库里到底有什么：按文档聚合（网页版那个知识库详情抽屉里最主要的一块）
                            let docsArr = JsonArray()
                            let docOrder = ArrayList<String>()
                            let docChunks = HashMap<String, Int64>()
                            let docImages = HashMap<String, Int64>()
                            let docTitles = HashMap<String, String>()
                            for (c in idx.chunks) {
                                if (!docChunks.contains(c.docPath)) {
                                    docOrder.add(c.docPath)
                                    docChunks[c.docPath] = 0
                                    docImages[c.docPath] = 0
                                    docTitles[c.docPath] = c.docTitle
                                }
                                docChunks[c.docPath] = docChunks[c.docPath] + 1
                                docImages[c.docPath] = docImages[c.docPath] + c.images.size
                            }
                            // Scan supported sources once; previews remain database snapshots.
                            let sourceSizes = HashMap<String, Int64>()
                            var sourceReadable = false
                            try {
                                if (exists(kb.rootDir)) {
                                    let report = ScanReport()
                                    for (d in scanDocsReport(kb.rootDir, report)) {
                                        sourceSizes[d.relPath] = fileSizeOf(d.fullPath)
                                        if (!docChunks.contains(d.relPath)) {
                                            docOrder.add(d.relPath)
                                            docChunks[d.relPath] = 0
                                            docImages[d.relPath] = 0
                                            docTitles[d.relPath] = d.title
                                        }
                                    }
                                    sourceReadable = true
                                }
                            } catch (_: Exception) { () }
                            for (dp in docOrder) {
                                let one = JsonObject()
                                one.put("path", JsonString(dp))
                                one.put("title", JsonString(docTitles[dp]))
                                one.put("chunks", JsonInt(docChunks[dp]))
                                one.put("images", JsonInt(docImages[dp]))
                                one.put("sizeBytes", JsonInt(if (sourceSizes.contains(dp)) { sourceSizes[dp] } else { -1 }))
                                one.put("preparedAt", JsonString(if (docChunks[dp] > 0) { kb.builtAt } else { "" }))
                                let status = if (!sourceReadable) { "unknown" } else if (!sourceSizes.contains(dp)) {
                                    "missing"
                                } else if (docChunks[dp] == 0) { "pending" } else { "ready" }
                                one.put("status", JsonString(status))
                                docsArr.add(one)
                            }
                            o.put("docs", docsArr)
                            let ol2 = Outline.load(kbDir(store.dataDir, id) + Path.Separator + "outline.json")
                            match (ol2) {
                                case Some(oo) =>
                                    o.put("organizedBy", JsonString(oo.source))
                                    o.put("outlineNote", JsonString(oo.note))
                                    o.put("outlineChapters", JsonInt(oo.chapters.size))
                                    o.put("outlineDocs", JsonInt(oo.docCount()))
                                case None => ()
                            }
                            ok(ctx, o)
                        case None => fail(ctx, 404, "找不到知识库：" + id)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/kb/document" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    let dp = strOf(b, "path")
                    let offset = intOf(b, "offset")
                    var limit: Int64 = 12
                    if (b.get("limit").isSome()) { limit = intOf(b, "limit") }
                    if (offset < 0 || limit < 1 || limit > 24) {
                        fail(ctx, 400, "分页范围不正确")
                        return
                    }
                    if (store.load().findKb(id).isNone()) {
                        fail(ctx, 404, "找不到资料库")
                        return
                    }
                    let chunks = ArrayList<KbChunk>()
                    for (c in loadIndexCached(store.dataDir, id).chunks) {
                        if (c.docPath == dp) { chunks.add(c) }
                    }
                    if (chunks.size == 0) {
                        fail(ctx, 404, "这篇资料还没有准备好的内容")
                        return
                    }
                    let o = JsonObject()
                    o.put("path", JsonString(dp))
                    o.put("title", JsonString(chunks[0].docTitle))
                    o.put("total", JsonInt(chunks.size))
                    o.put("offset", JsonInt(offset))
                    let arr = JsonArray()
                    var i = offset
                    while (i < chunks.size && i - offset < limit) {
                        arr.add(chunkJson(chunks[i], 0.0))
                        i += 1
                    }
                    o.put("nextOffset", JsonInt(if (i < chunks.size) { i } else { -1 }))
                    o.put("chunks", arr)
                    ok(ctx, o)
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
                    // id 为空 = 通用：本机所有知识库一起搜（和对话里的通用模式同一套实现）
                    if (id.size == 0) {
                        let res = ToolRegistry(store).kbSearch("", query, topK)
                        if (!res.ok) {
                            fail(ctx, 400, res.summary)
                            return
                        }
                        let o = JsonObject()
                        o.put("hits", res.data)
                        o.put("mode", JsonString("通用"))
                        o.put("summary", JsonString(res.summary))
                        ok(ctx, o)
                        return
                    }
                    let s = store.load()
                    let idx = loadIndexCached(store.dataDir, id)
                    if (idx.chunks.size == 0) {
                        fail(ctx, 404, "该知识库还没有索引，请先建立索引")
                        return
                    }
                    // 混合检索（与模型侧 kb_search 同一个入口）：向量模型可选，没配就只用关键词那一路
                    var qv: Option<Array<Float64>> = None
                    if (s.embedModelId.size > 0) {
                        match (s.findModel(s.embedModelId)) {
                            case Some(cfg) =>
                                try {
                                    let vecs = LlmClient(cfg).embed([query])
                                    if (vecs.size > 0) {
                                        qv = Some(vecs[0])
                                    }
                                } catch (e: Exception) {
                                    ()
                                }
                            case None => ()
                        }
                    }
                    let (hits, mode) = hybridSearch(idx, query, qv, topK)
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

        // lumin（pi 运行时）跑一轮问答：与 /api/agent/ask 同形，用来同题对照（见 docs/11）
        if (path == "/api/agent/ask-pi" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let question = strOf(b, "question")
                    if (question.size == 0) {
                        fail(ctx, 400, "缺少 question")
                        return
                    }
                    try {
                        ok(ctx, PiAgent(store).askTask(strOf(b, "kbId"), question,
                            strOf(b, "sessionId"), strOf(b, "web"), trimStr(strOf(b, "skill")),
                            Some(workContextOf(store, b))))
                    } catch (e: Exception) {
                        fail(ctx, 500, "问答失败（lumin）：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // 讲义 / 练习册：同样交给 lumin 当一次任务跑，提示词只说"成品是什么、落到哪"。
        // 上一版的 /api/agent/lecture|quiz 是内核写死"先检索 → 拟大纲 → 逐节写作"的流水线，已经删掉：
        // 步骤由模型自己排，这才是 agent；固定步骤是工作流（而且它把"先检索"钉死在了第一步）。
        if (path == "/api/agent/task-pi" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let topic = strOf(b, "topic")
                    if (topic.size == 0) {
                        fail(ctx, 400, "缺少 topic")
                        return
                    }
                    let kind = strOf(b, "kind")
                    if (!isResourceKind(kind)) { fail(ctx, 400, "资源类型不支持"); return }
                    var count: Int64 = 5
                    let reqCount = intOf(b, "count")
                    if (reqCount > 0) { count = reqCount }
                    try {
                        ok(ctx, PiAgent(store).make(kind, strOf(b, "kbId"), topic, count,
                            strOf(b, "sessionId"), strOf(b, "web"), Some(workContextOf(store, b))))
                    } catch (e: Exception) {
                        fail(ctx, 500, "生成失败（lumin）：" + e.message)
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
            // 显示大小：页面缩放与字体大小分开存（两者是两件事：缩放管"多大一块"、字体管"字多大"）
            o.put("uiZoom", JsonString(db.getKv("settings", "ui_zoom", "1")))
            o.put("uiFont", JsonString(db.getKv("settings", "ui_font", "1")))
            // 分栏宽度（会话栏 / 成果面板）：用户拖过就记住，下次打开还是这个宽度
            o.put("uiPanelW", JsonString(db.getKv("settings", "ui_panel_w", "")))
            o.put("uiDockW", JsonString(db.getKv("settings", "ui_dock_w", "")))
            // 让 lumin 动手的那几个开关（默认全关：只问答、不碰本机文件）
            o.put("agentWorkDir", JsonString(db.getKv("settings", "agent_work_dir", "")))
            // 用户没指定时界面要显示"当前用的是哪个目录"，所以默认目录也回给前端
            o.put("defaultWorkDir", JsonString(defaultWorkDir()))
            o.put("agentPerm", JsonString(db.getKv("settings", "agent_perm", "auto")))
            o.put("agentExec", JsonString(db.getKv("settings", "agent_exec", "1")))
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
                    // 页面缩放 0.8~1.6、字体 0.85~1.4：限幅，别让手滑存出个 9 倍放大
                    let zoom = floatValue(match (b.get("uiZoom")) { case Some(z) => z; case None => JsonNull() })
                    if (zoom >= 0.8 && zoom <= 1.6) {
                        db.putKv("settings", "ui_zoom", zoom.toString())
                    }
                    let font = floatValue(match (b.get("uiFont")) { case Some(z) => z; case None => JsonNull() })
                    if (font >= 0.85 && font <= 1.4) {
                        db.putKv("settings", "ui_font", font.toString())
                    }
                    // 分栏宽度：限幅，别让手滑把会话栏拖成整屏
                    let panelW = floatValue(match (b.get("uiPanelW")) { case Some(z) => z; case None => JsonNull() })
                    if (panelW >= 180.0 && panelW <= 520.0) {
                        db.putKv("settings", "ui_panel_w", Int64(panelW).toString())
                    }
                    let dockW = floatValue(match (b.get("uiDockW")) { case Some(z) => z; case None => JsonNull() })
                    if (dockW >= 300.0 && dockW <= 900.0) {
                        db.putKv("settings", "ui_dock_w", Int64(dockW).toString())
                    }
                    let workDir = strOf(b, "agentWorkDir")
                    if (workDir.size > 0) {
                        db.putKv("settings", "agent_work_dir", workDir)
                    }
                    if (boolOf(b, "agentWorkDirClear")) {
                        db.putKv("settings", "agent_work_dir", "")
                    }
                    let perm = strOf(b, "agentPerm")
                    if (perm == "ask" || perm == "auto" || perm == "full") {
                        db.putKv("settings", "agent_perm", perm)
                    }
                    let execPref = strOf(b, "agentExec")
                    if (execPref == "0" || execPref == "1") {
                        db.putKv("settings", "agent_exec", execPref)
                    }
                    let o = JsonObject()
                    o.put("theme", JsonString(db.getKv("settings", "ui_theme", "system")))
                    o.put("sessionRail", JsonString(db.getKv("settings", "ui_session_rail", "1")))
                    o.put("rail", JsonString(db.getKv("settings", "ui_rail", "1")))
                    o.put("uiZoom", JsonString(db.getKv("settings", "ui_zoom", "1")))
                    o.put("uiFont", JsonString(db.getKv("settings", "ui_font", "1")))
                    o.put("uiPanelW", JsonString(db.getKv("settings", "ui_panel_w", "")))
                    o.put("uiDockW", JsonString(db.getKv("settings", "ui_dock_w", "")))
                    o.put("agentWorkDir", JsonString(db.getKv("settings", "agent_work_dir", "")))
                    o.put("defaultWorkDir", JsonString(defaultWorkDir()))
                    o.put("agentPerm", JsonString(db.getKv("settings", "agent_perm", "auto")))
                    o.put("agentExec", JsonString(db.getKv("settings", "agent_exec", "1")))
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
                        boolOf(b, "enabled") || strOf(b, "enabled") == "1", n,
                        strOf(b, "allowHosts"), strOf(b, "blockHosts"))
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

        if (path == "/api/kb/sources" && method == "POST") {
            let o = JsonObject()
            o.put("sources", harvestSources(store.dataDir))
            ok(ctx, o)
            return
        }
        if (method == "POST" && (path == "/api/kb/stage" || path == "/api/kb/ingest" ||
            path == "/api/kb/source/preview" || path == "/api/kb/source/discard" || path == "/api/kb/source/refetch")) {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    try {
                        var o = JsonObject()
                        if (path == "/api/kb/stage") {
                            o = harvestStage(store.dataDir, strOf(b, "kind"), strOf(b, "url"), strOf(b, "ref"))
                        } else if (path == "/api/kb/ingest") {
                            if (!boolOf(b, "confirmed")) { fail(ctx, 400, "请先在界面检查清单并确认并入"); return }
                            o = harvestIngest(store, strOf(b, "kbId"), strOf(b, "id"))
                        } else if (path == "/api/kb/source/preview") {
                            o = harvestPreview(store.dataDir, strOf(b, "id"), strOf(b, "path"))
                        } else if (path == "/api/kb/source/discard") {
                            o = harvestDiscard(store.dataDir, strOf(b, "id"))
                        } else {
                            o = harvestRefetch(store.dataDir, strOf(b, "id"))
                        }
                        ok(ctx, o)
                    } catch (e: Exception) { fail(ctx, 400, e.message) }
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

        // 星云图：所有知识库一屏看完（只读聚合，复用 /api/graph 的每库聚合）
        if (path == "/api/nebula" && method == "POST") {
            try {
                ok(ctx, buildNebula(store.dataDir))
            } catch (e: Exception) {
                fail(ctx, 500, "算不出星云图：" + e.message)
            }
            return
        }

        // 待批准的动作用户确认（界面显示批准卡，用户点四个按钮之一）
        if (path == "/api/agent/approvals" && method == "POST") {
            let o = JsonObject()
            o.put("requests", approvalHub().list())
            o.put("pending", JsonInt(approvalHub().pendingCount()))
            ok(ctx, o)
            return
        }

        if (path == "/api/agent/approvals/answer" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    let decision = strOf(b, "decision")
                    if (id.size == 0 || decision.size == 0) {
                        fail(ctx, 400, "缺少 id 或 decision")
                        return
                    }
                    let hit = approvalHub().answer(id, decision)
                    let o = JsonObject()
                    o.put("ok", JsonBool(hit))
                    o.put("pending", JsonInt(approvalHub().pendingCount()))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // 中途插话：模型跑着的时候又打了一句，插进当前这一轮的下一次模型请求之前
        if (path == "/api/agent/steer" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    let text = trimStr(strOf(b, "text"))
                    if (sid.size == 0 || text.size == 0) {
                        fail(ctx, 400, "缺少 sessionId 或 text")
                        return
                    }
                    sessionHub().pushSteering(sid, text)
                    let o = JsonObject()
                    o.put("queued", JsonBool(true))
                    o.put("pending", JsonInt(sessionHub().pendingSteering(sid)))
                    ok(ctx, o)
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
                    // 手写链路看的是取消标记；lumin 那一轮要直接 abort（它登记在 sessionHub 里）
                    let expected = strOf(b, "turnId")
                    let active = sessionHub().activeTurn(sid)
                    if (expected.size > 0 && expected != active) { fail(ctx, 409, "该轮任务已经结束"); return }
                    if (active.size > 0) { setTaskState(store.dataDir, sid, active, "cancelling") }
                    requestCancel(sid)
                    sessionHub().abort(sid)
                    ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/tools/list" && method == "POST") {
            let db = DbHub.open(store.dataDir)
            let o = JsonObject()
            let arr = Agent(store).toolsJson()
            for (d in buildDomainToolDefs(store, "", true)) {
                if (d.name == "kb_stage" || d.name == "kb_ingest") {
                    let t = JsonObject()
                    t.put("name", JsonString(d.name))
                    t.put("title", JsonString(d.label))
                    t.put("desc", JsonString(d.description))
                    t.put("usage", JsonString(d.schema))
                    t.put("available", JsonBool(webMode(store.dataDir) != "off"))
                    arr.add(t)
                }
            }
            for (d in learningTools(store, "", { => false }, "", "", "", { kind: String, payload: JsonObject => () })) {
                let t = JsonObject()
                t.put("name", JsonString(d.name))
                t.put("title", JsonString(d.label))
                t.put("desc", JsonString(d.description))
                t.put("usage", JsonString(d.schema))
                t.put("available", JsonBool(true))
                arr.add(t)
            }
            // 指定了工作目录才把"本机文件"那几个列出来（与真正发给模型的工具一致）
            let wd = db.getKv("settings", "agent_work_dir", "")
            let perm = db.getKv("settings", "agent_perm", "auto")
            let execOn = db.getKv("settings", "agent_exec", "0") == "1"
            let wt = workspaceToolList(store.dataDir, wd, execOn, perm)
            var wi = 0
            while (wi < wt.size()) {
                arr.add(wt[wi])
                wi = wi + 1
            }
            o.put("tools", arr)
            o.put("agentWorkDir", JsonString(wd))
            ok(ctx, o)
            return
        }

        if (path == "/api/learning/resources" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let o = JsonObject()
                    o.put("resources", LearningStore(store.dataDir).resources(strOf(b, "kbId")))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/learning/resource" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) => try {
                    let ls = LearningStore(store.dataDir)
                    let o = ls.resource(strOf(b, "id"), intOf(b, "version"))
                    o.put("progress", ls.progressOf(strOf(o, "id"), intOf(o, "version"), "complete"))
                    ok(ctx, o)
                } catch (e: Exception) { fail(ctx, 404, e.message) }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/learning/context" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) => ok(ctx, LearningStore(store.dataDir).context(strOf(b, "kbId")))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/learning/memories" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let o = JsonObject()
                    o.put("memories", LearningStore(store.dataDir).memories(strOf(b, "kbId")))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/learning/memory/policy" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let ls = LearningStore(store.dataDir)
                    match (b.get("autoRemember")) {
                        case Some(v) => match (v) {
                            case flag: JsonBool => ls.setAutoRemember(flag.getValue())
                            case _ => fail(ctx, 400, "autoRemember 必须为布尔值"); return
                        }
                        case None => ()
                    }
                    let o = JsonObject()
                    o.put("autoRemember", JsonBool(ls.autoRemember()))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/learning/memory/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) => try {
                    ok(ctx, LearningStore(store.dataDir).remember(strOf(b, "id"), strOf(b, "kbId"), strOf(b, "kind"), strOf(b, "text"), "", "", "", "user"))
                } catch (e: Exception) { fail(ctx, 400, e.message) }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/learning/memory/forget" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) => LearningStore(store.dataDir).forget(strOf(b, "id")); ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/learning/answer" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) => try {
                    ok(ctx, LearningStore(store.dataDir).answer(strOf(b, "id"), intOf(b, "version"), strOf(b, "questionId"), intOf(b, "choice"), strOf(b, "attemptId")))
                } catch (e: Exception) { fail(ctx, 400, e.message) }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/learning/progress" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) => try {
                    ok(ctx, LearningStore(store.dataDir).progress(strOf(b, "id"), intOf(b, "version"), "complete", boolOf(b, "done")))
                } catch (e: Exception) { fail(ctx, 400, e.message) }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // ---------- 会话与产物 ----------

        if (path == "/api/sessions/new" && method == "POST") {
            // 界面点「新建对话」时先开一个会话 id，这样提问前就能把它显示在会话栏里，
            // 生成过程中也能按这个 id 轮询事件做流式输出。
            let ss = SessionStore(store.dataDir)
            let sid = ss.newId()
            let o = JsonObject()
            o.put("sessionId", JsonString(sid))
            // 新建时可以指定项目：会话一出生就归到那个文件夹下
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let pid = strOf(b, "projectId")
                    if (pid.size > 0) {
                        ProjectStore(store.dataDir).bind(sid, pid)
                    }
                    o.put("projectId", JsonString(pid))
                case None => ()
            }
            ok(ctx, o)
            return
        }

        // ---------- 项目（一个项目 = 一个本机文件夹） ----------
        if (path == "/api/projects/list" && method == "POST") {
            let arr = JsonArray()
            for (p in ProjectStore(store.dataDir).list()) {
                arr.add(p.toJson())
            }
            let o = JsonObject()
            o.put("projects", arr)
            ok(ctx, o)
            return
        }
        // 退回到某一轮之前（改一下上一条消息重发）/ 从某一轮分叉出新会话
        if (path == "/api/sessions/rewind" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    let tid = strOf(b, "turnId")
                    if (sid.size == 0 || tid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId / turnId")
                        return
                    }
                    let removed = SessionStore(store.dataDir).rewind(sid, tid)
                    let o = JsonObject()
                    o.put("ok", JsonBool(removed > 0))
                    o.put("removed", JsonInt(removed))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        /* 会话树：这一段里出现过的每一轮（含被放弃的分支），标出父轮次与"当前在哪条" */
        if (path == "/api/sessions/tree" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    let ss = SessionStore(store.dataDir)
                    let arr = JsonArray()
                    for (node in ss.turnTree(sid)) {
                        arr.add(node)
                    }
                    let o = JsonObject()
                    o.put("turns", arr)
                    o.put("leaf", JsonInt(ss.leafOf(sid)))
                    // families：同一分叉点上的几兄弟（界面画 ‹ n/m › 用它）
                    let info = ss.treeInfo(sid)
                    match (info.get("families")) {
                        case Some(f) => o.put("families", f)
                        case None => o.put("families", JsonArray())
                    }
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        /* 切到某条事件（会话树里点某一轮）：不删任何东西，只是换个末端 */
        if (path == "/api/sessions/switch" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    let ss = SessionStore(store.dataDir)
                    // 允许传 eventId（精确）或 turnId（那一条提问所在轮次的第一条）
                    var target = intOf(b, "eventId")
                    let tid = trimStr(strOf(b, "turnId"))
                    if (target <= 0 && tid.size > 0) {
                        target = ss.turnStartEventId(sid, tid)
                    }
                    if (!ss.setLeaf(sid, target)) {
                        fail(ctx, 400, "找不到要切过去的那一条")
                        return
                    }
                    let o = JsonObject()
                    o.put("ok", JsonBool(true))
                    o.put("leaf", JsonInt(ss.leafOf(sid)))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/sessions/branch" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    let tid = strOf(b, "turnId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    let ss = SessionStore(store.dataDir)
                    // turnId 空 = 「从最新的一条分」：整段复制过去（界面 ⋯ 里的新建分支走这条）
                    let nsid = if (tid.size > 0) { ss.branch(sid, tid) } else { ss.branchAll(sid) }
                    // 分支继承原会话的项目归属，但**不**继承上下文缓存：它是新的一段
                    let ps = ProjectStore(store.dataDir)
                    ps.bind(nsid, ps.projectOf(sid))
                    let o = JsonObject()
                    o.put("sessionId", JsonString(nsid))
                    // 名字一起回给界面：新分支可能还没有事件（列表里暂时看不到），
                    // 顶栏那条面包屑得先有名字可显示
                    o.put("title", JsonString(ss.titleOf(nsid)))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // 会话内分支：从某一轮**之前**开一条新线（原线保留，可以用 ‹ n/m › 切回来）
        if (path == "/api/sessions/split" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    let ss = SessionStore(store.dataDir)
                    let o = JsonObject()
                    if (boolOf(b, "cancel")) {
                        ss.cancelSplit(sid)
                        o.put("ok", JsonBool(true))
                        ok(ctx, o)
                        return
                    }
                    let tid = strOf(b, "turnId")
                    if (tid.size == 0) {
                        fail(ctx, 400, "缺少 turnId")
                        return
                    }
                    let pt = ss.split(sid, tid)
                    if (pt < 0) {
                        fail(ctx, 400, "找不到这一轮")
                        return
                    }
                    o.put("ok", JsonBool(true))
                    o.put("parentEventId", JsonInt(pt))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        // 切到某条分支（会话树的"切分支"）：末端 = 那一轮的最后一条事件
        if (path == "/api/sessions/set-active" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    let tid = strOf(b, "turnId")
                    if (sid.size == 0 || tid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId / turnId")
                        return
                    }
                    let done = SessionStore(store.dataDir).activateTurn(sid, tid)
                    let o = JsonObject()
                    o.put("ok", JsonBool(done))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        /* 改动草稿：AI 写过的文件在写之前留了一份原样（列表 / 差异 / 确认保留 / 撤销） */
        if (path == "/api/drafts/list" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    let arr = JsonArray()
                    for (o in DraftStore(store.dataDir).listOpen(sid)) {
                        arr.add(o)
                    }
                    let out = JsonObject()
                    out.put("drafts", arr)
                    ok(ctx, out)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/drafts/diff" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    if (id.size == 0) {
                        fail(ctx, 400, "缺少 id")
                        return
                    }
                    let d = DraftStore(store.dataDir).diffOf(id)
                    if (!boolOf(d, "ok")) {
                        fail(ctx, 404, "找不到这条改动草稿")
                        return
                    }
                    ok(ctx, d)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/drafts/merge" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let out = JsonObject()
                    out.put("ok", JsonBool(DraftStore(store.dataDir).merge(strOf(b, "id"))))
                    ok(ctx, out)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/drafts/discard" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let out = JsonObject()
                    out.put("ok", JsonBool(DraftStore(store.dataDir).discard(strOf(b, "id"))))
                    ok(ctx, out)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/drafts/discard-all" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let ds = DraftStore(store.dataDir)
                    var n: Int64 = 0
                    let ids = match (b.get("ids")) {
                        case Some(v) =>
                            match (v) {
                                case a: JsonArray => a
                                case _ => JsonArray()
                            }
                        case None => JsonArray()
                    }
                    if (ids.size() > 0) {
                        for (i in 0..ids.size()) {
                            let id = match (ids[i]) {
                                case s: JsonString => s.getValue()
                                case _ => ""
                            }
                            if (id.size > 0 && ds.discard(id)) {
                                n += 1
                            }
                        }
                    } else {
                        n = ds.discardAllOf(strOf(b, "sessionId"))
                    }
                    let out = JsonObject()
                    out.put("ok", JsonBool(true))
                    out.put("restored", JsonInt(n))
                    ok(ctx, out)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/projects/pin" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    if (id.size == 0) {
                        fail(ctx, 400, "缺少 id")
                        return
                    }
                    // 没带 pinned 就当作"置顶"（界面上那个菜单项就是置顶）
                    let wantPin = match (b.get("pinned")) {
                        case Some(_) => boolOf(b, "pinned")
                        case None => true
                    }
                    ProjectStore(store.dataDir).setPinned(id, wantPin)
                    ok(ctx, JsonObject())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/projects/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) => try {
                    ok(ctx, ProjectStore(store.dataDir).save(strOf(b, "id"), strOf(b, "name"), strOf(b, "root")).toJson())
                } catch (e: Exception) { fail(ctx, 400, e.message) }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/projects/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    ProjectStore(store.dataDir).remove(strOf(b, "id"))
                    ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }
        if (path == "/api/sessions/bind" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) { fail(ctx, 400, "缺少 sessionId"); return }
                    ProjectStore(store.dataDir).bind(sid, strOf(b, "projectId"))
                    ok(ctx, JsonString("ok"))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
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

        if (path == "/api/sessions/rename" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "sessionId")
                    if (id.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    SessionStore(store.dataDir).rename(id, strOf(b, "title"))
                    let o = JsonObject()
                    o.put("ok", JsonBool(true))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        /**
         * 会话标题：**第一次提问之后**让模型起一次名。
         *
         * 三条规矩（用户定的）：
         *   ① 只做一次 —— 手动改过名字、或已经问过模型了，这里直接回 generated=false；
         *   ② 名字没回来之前，列表/顶栏先用"第一句话 + 省略号"兜着（summary 本来就这么兜）；
         *   ③ 用户后来改写第一条提问也不重新生成 —— 标题是"这段对话的名字"，不是那句话的摘要。
         * 起名失败不进重试：标题只是列表上的一行字，不值得为它反复打扰模型。
         */
        if (path == "/api/sessions/title" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let sid = strOf(b, "sessionId")
                    if (sid.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    let ss = SessionStore(store.dataDir)
                    let o = JsonObject()
                    if (ss.titleReady(sid)) {
                        // 已经有名字：原样回给它，别再生成（"只生成一次"）
                        o.put("generated", JsonBool(false))
                        o.put("title", JsonString(ss.titleOf(sid)))
                        ok(ctx, o)
                        return
                    }
                    let first = ss.firstUserText(sid)
                    if (first.size == 0) {
                        o.put("generated", JsonBool(false))
                        ok(ctx, o)
                        return
                    }
                    match (chatModelOf(store)) {
                        case Some(cfg) =>
                            try {
                                let client = LlmClient(cfg)
                                let sys = "你是会话命名器：读用户的第一句话，给这段对话起一个短名字。"
                                let ask = "用户的第一句话：\n" + first +
                                    "\n\n要求：只输出名字本身，不超过 12 个汉字，不要引号、不要标点、不要解释。"
                                let name = cleanSessionTitle(client.chat(sys, ask))
                                if (name.size > 0) {
                                    ss.rename(sid, name)
                                    // 成了才落"已起名"标记：失败时下一轮还能补一次
                                    ss.markTitleAsked(sid)
                                    o.put("generated", JsonBool(true))
                                    o.put("title", JsonString(name))
                                } else {
                                    o.put("generated", JsonBool(false))
                                }
                            } catch (e: Exception) {
                                o.put("generated", JsonBool(false))
                                o.put("message", JsonString(e.message))
                            }
                        case None => o.put("generated", JsonBool(false))
                    }
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/sessions/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "sessionId")
                    if (id.size == 0) {
                        fail(ctx, 400, "缺少 sessionId")
                        return
                    }
                    if (sessionHub().activeTurn(id).size > 0) { fail(ctx, 409, "请先停止正在运行的任务"); return }
                    SessionStore(store.dataDir).remove(id)
                    let o = JsonObject()
                    o.put("ok", JsonBool(true))
                    ok(ctx, o)
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/sessions/state" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) => ok(ctx, taskState(store.dataDir, strOf(b, "sessionId")))
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
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
                    // sinceId：前端流式轮询只拉增量，不再每次重传整段历史
                    var lastId = intOf(b, "sinceId")
                    for (ev in ss.eventsSince(id, lastId)) {
                        match (ev.get("id")) {
                            case Some(v) => match (v) { case n: JsonInt => lastId = n.getValue(); case _ => () }
                            case None => ()
                        }
                        arr.add(ev)
                    }
                    let o = JsonObject()
                    o.put("events", arr)
                    o.put("lastId", JsonInt(lastId))
                    // 会话树：只在全量拉取时算（轮询带 sinceId，不算这一遍，省一次索引构建）
                    if (intOf(b, "sinceId") <= 0) {
                        o.put("tree", ss.treeInfo(id))
                    }
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

        // 把界面里生成的 Markdown 落成本地产物（例如成长页导出的学习报告）。
        // 复用 ToolRegistry.saveArtifact：它已经有"重名自动加序号、路径净化"的那套语义。
        if (path == "/api/artifacts/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let name = trimStr(strOf(b, "name"))
                    let content = strOf(b, "content")
                    if (name.size == 0 || content.size == 0) {
                        fail(ctx, 400, "缺少 name 或 content")
                        return
                    }
                    try {
                        let r = ToolRegistry(store).saveArtifact(name, content)
                        if (!r.ok) {
                            fail(ctx, 400, r.summary)
                            return
                        }
                        // saveArtifact 的 data 是最终文件路径（可能加了 -2 序号）
                        let p = strValue(r.data)
                        let o = JsonObject()
                        o.put("path", JsonString(p))
                        var finalName = p
                        let slash = p.lastIndexOf(Path.Separator)
                        if (slash != None) {
                            match (slash) {
                                case Some(i) => finalName = String.fromUtf8(p.toArray()[(i + 1)..p.size])
                                case None => ()
                            }
                        }
                        o.put("name", JsonString(finalName))
                        ok(ctx, o)
                    } catch (e: Exception) {
                        fail(ctx, 500, "写产物失败：" + e.message)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

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
            // 学习日历 / 连续打卡：给日期，日历运算在前端做（本地时区才准）
            let dateArr = JsonArray()
            for (day in studyDates(store.dataDir)) {
                dateArr.add(JsonString(day))
            }
            o.put("studyDates", dateArr)

            // 六维：自评（用户填的）+ 实测参考（真实信号推的）。界面画雷达图与写依据都用这一段。
            var kbId = ""
            match (bodyJson(ctx)) {
                case Some(b) => kbId = strOf(b, "kbId")
                case None => ()
            }
            // 闭包里不能改外层 var，所以先收名字再数
            let artNames = ArrayList<String>()
            let artDir = store.dataDir + Path.Separator + "artifacts"
            if (exists(artDir)) {
                try {
                    Directory.walk(Path(artDir), { fi: FileInfo =>
                        if (!fi.isDirectory() && hasSuffix(fi.name, ".md")) {
                            artNames.add(fi.name)
                        }
                        false
                    })
                } catch (e: Exception) {
                    ()
                }
            }
            let artifactCount = Int64(artNames.size)
            let abil = JsonArray()
            var weakestKey = ""
            var weakestGap: Int64 = -1
            for (ev in abilityEvidence(store.dataDir, kbId, d.quizRecords.size, right,
                    Int64(d.progress.readChunks.size), Int64(d.progress.completedChapters.size),
                    Int64(d.notes.size), artifactCount)) {
                let one = JsonObject()
                one.put("key", JsonString(ev.key))
                // scoreOf 没填就是 0；这里用 -1 表示"没填"，界面才不会把 0 分当成"很差"
                let selfRaw = d.profile.scoreOf(ev.key)
                var selfVal: Int64 = selfRaw
                if (selfRaw <= 0) {
                    selfVal = -1
                }
                one.put("self", JsonInt(selfVal))
                one.put("evidence", JsonInt(ev.evidence))
                one.put("basis", JsonString(ev.basis))
                abil.add(one)
                // 最该补的一维：自评与实测都在、且差距最大（或实测最低）
                if (ev.evidence >= 0) {
                    var gap = ev.evidence
                    if (selfVal >= 0) {
                        gap = ev.evidence - selfVal
                    }
                    if (weakestGap < 0 || gap < weakestGap) {
                        weakestGap = gap
                        weakestKey = ev.key
                    }
                }
            }
            o.put("abilities", abil)
            o.put("weakest", JsonString(weakestKey))
            // 按天汇总：成长页画"最近两周"。日历运算在前端做，内核只按已有时间戳分桶
            o.put("trend", trendByDay(store.dataDir))
            o.put("artifactCount", JsonInt(artifactCount))
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
    let allowed = ["index.html", "app.js", "style.css", "workbench.js", "workbench.css", "release.json",
        "logo-mark.png", "logo-light.png", "logo-dark.png"]
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

/**
 * 这一轮"能不能动用户的电脑"：工作目录 + 权限档位（lumin 那三档）+ 要不要放开跑命令。
 *
 * 请求里带了就用请求里的（界面上的那枚 chip 是会话级的选择），没带就跟着设置走。
 * 没指定工作目录 = 模型拿不到本机文件那几个工具 —— 这是默认，也是最安全的默认。
 */
/**
 * 这一轮"能不能动用户的电脑"。
 *
 * 两种模式（对齐用户自己的说法）：
 *   - 常规聊天：整机只读 + 只对**默认工作目录**可写。工作目录外的写直接拒，不问也不批。
 *     所以它的档位被钉死在 ask（沙箱在），界面那枚权限 chip 对它无效。
 *   - Work（指定工作区）：工作目录 = 项目文件夹，档位 = 用户在对话框下面选的（ask/auto/full）；
 *     full 就是"任意目录读写"。
 *
 * 两种模式都默认允许调用终端命令 —— 命令按档位走审批（ask 档每条都会问）。
 * 工作目录不再允许"空"：没设过就用默认目录（用户目录\Documents\Lumin），否则常规聊天
 * 连"把答案写成文件"都做不到。
 */
func workContextOf(store: Store, b: JsonObject): WorkContext {
    let db = DbHub.open(store.dataDir)
    let work = WorkContext()
    work.attachments = validatedAttachments(b.get("attachments"))
    work.dir = db.getKv("settings", "agent_work_dir", "")
    // 会话挂在项目下时，工作目录跟着项目走（项目 = 用户自己选的那个文件夹）
    let projectRoot = ProjectStore(store.dataDir).rootOf(strOf(b, "sessionId"))
    if (projectRoot.size > 0) {
        work.dir = projectRoot
    }
    if (work.dir.size == 0) {
        work.dir = defaultWorkDir()
    }
    // mode 由界面明说（chat / work）；没带就按会话归属推断：没挂项目 = 常规聊天
    let modeReq = trimStr(strOf(b, "mode"))
    work.chatMode = if (modeReq.size > 0) { modeReq != "work" } else { projectRoot.size == 0 }
    let permReq = strOf(b, "perm")
    work.perm = if (work.chatMode) {
        // 常规对话是固定档：整机只读 + 只写默认工作目录。它没有任何可选项，界面也不给开关
        "ask"
    } else if (permReq.size > 0) {
        permReq
    } else {
        // 挂工作区的会话（Work）默认"帮我批准"
        db.getKv("settings", "agent_perm", "auto")
    }
    let execReq = strOf(b, "exec")
    work.allowExec = if (execReq.size > 0) { execReq == "1" } else { db.getKv("settings", "agent_exec", "1") == "1" }
    // 界面上下文：用户正在看哪一章（"这一章"的落点）。只进提示词，不改变工具与流程。
    work.ctxChapter = trimStr(strOf(b, "ctxChapter"))
    return work
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

/**
 * 界面绑定的那个对话模型（没绑就用第一个）。
 *
 * 起名这类"小活儿"与对话共用一个模型：换模型是用户在设置里做的一次选择，
 * 不该出现"对话用 A、起名偷偷用 B"这种第二套状态。
 */
func chatModelOf(store: Store): ?ModelConfig {
    let s = store.load()
    if (s.chatModelId.size > 0) {
        match (s.findModel(s.chatModelId)) {
            case Some(m) => return m
            case None => ()
        }
    }
    if (s.models.size > 0) {
        return s.models[0]
    }
    return None
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
        "/api/models/vision-test",
        "/api/chat",
        "/api/kb/save",
        "/api/kb/import",
        "/api/kb/organize",
        "/api/kb/delete",
        "/api/kb/build",
        "/api/kb/stats",
        "/api/kb/document",
        "/api/kb/search",
        "/api/agent/ask",
        "/api/agent/ask-pi",
        "/api/agent/approvals",
        "/api/agent/approvals/answer",
        "/api/agent/steer",
        "/api/agent/task-pi",
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
        "/api/kb/stage",
        "/api/kb/sources",
        "/api/kb/source/preview",
        "/api/kb/source/discard",
        "/api/kb/source/refetch",
        "/api/kb/ingest",
        "/api/web/cache",
        "/api/web/cache/delete",
        "/api/web/session",
        "/api/graph",
        "/api/nebula",
        "/api/skills/list",
        "/api/skills/read",
        "/api/skills/bind",
        "/api/skills/template",
        "/api/tools/list",
        "/api/learning/resources",
        "/api/learning/resource",
        "/api/learning/context",
        "/api/learning/memories",
        "/api/learning/memory/save",
        "/api/learning/memory/policy",
        "/api/learning/memory/forget",
        "/api/learning/answer",
        "/api/learning/progress",
        "/api/projects/list",
        "/api/projects/save",
        "/api/projects/delete",
        "/api/sessions/bind",
        "/api/sessions/new",
        "/api/sessions/rewind",
        "/api/sessions/branch",
        "/api/sessions/tree",
        "/api/sessions/switch",
        "/api/sessions/split",
        "/api/sessions/set-active",
        "/api/drafts/list",
        "/api/drafts/diff",
        "/api/drafts/merge",
        "/api/drafts/discard",
        "/api/drafts/discard-all",
        "/api/projects/pin",
        "/api/sessions/list",
        "/api/sessions/events",
        "/api/sessions/state",
        "/api/sessions/rename",
        "/api/sessions/title",
        "/api/sessions/delete",
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
        "/api/artifacts/save",
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
    let statics = ["/", "/index.html", "/app.js", "/style.css", "/workbench.js", "/workbench.css", "/release.json",
        "/logo-mark.png", "/logo-light.png", "/logo-dark.png"]
    for (s in statics) {
        server.distributor.register(s, { ctx: HttpContext => serveStatic(ctx, uiDir, s) })
    }
    return server
}
