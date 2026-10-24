package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.learning.LearningStore
import itn_desktop_core.knowledge.KnowledgeStore
import itn_desktop_core.course.CourseStore
import itn_desktop_core.study.StudyStore
import itn_desktop_core.learning.arrOf
import itn_desktop_core.resource.ResourceRequest
import itn_desktop_core.resource.generateResourceWithCancel
import itn_desktop_core.resource.resultJson
import itn_desktop_core.resource.isResourceKind
import itn_desktop_core.util.*
import itn_desktop_core.kb.resolveKnowledgeImage

func learningResult(body: JsonObject, summary: String): DomainToolRun {
    let r = DomainToolRun()
    r.details = body
    r.summary = summary
    r.content = byteSafePrefix(body.toString(), 50000)
    return r
}

/** Product tools; the lumin runtime chooses if and when they are called. */
public func learningTools(store: Store, kbId: String, shouldAbort: () -> Bool, sid: String, turnId: String,
    userText: String, emit: (String, JsonObject) -> Unit): ArrayList<DomainTool> {
    let ls = LearningStore(store.dataDir)
    let out = ArrayList<DomainTool>()
    for (tool in mbtiTools(store, sid, turnId, userText)) { out.add(tool) }
    out.add(makeTool("resolve_knowledge_image", "定位知识库图片", "读取文档配图的实际来源、路径与格式",
        "doc_path 来自知识库文档或切片，source 来自原文 img src 或 Markdown 图片链接。优先定位同库本地配图，返回本地路径或原网络链接及大小；不返回 base64，定位成功不代表已理解图像内容。",
        "{\"type\":\"object\",\"properties\":{\"kb_id\":{\"type\":\"string\"},\"doc_path\":{\"type\":\"string\"},\"source\":{\"type\":\"string\"}},\"required\":[\"doc_path\",\"source\"]}", "read", { args: JsonObject =>
            let id = if (strOf(args,"kb_id").size > 0) { strOf(args,"kb_id") } else { kbId }
            return learningResult(resolveKnowledgeImage(store,id,strOf(args,"doc_path"),strOf(args,"source"),false), "已定位知识库配图")
        }))
    out.add(makeTool("list_knowledge_bases", "查看知识库", "读取知识库名称、稳定标识与索引状态",
        "列出已登记知识库的 id、名称、资料路径和索引数量。改名之前先核对 id，不重新导入。",
        "{\"type\":\"object\",\"properties\":{}}", "read", { args: JsonObject =>
            let o = JsonObject()
            let rows = JsonArray()
            for (kb in store.load().knowledgeBases) { rows.add(kb.toJson()) }
            o.put("knowledgeBases", rows)
            return learningResult(o, "已读取知识库列表")
        }))
    out.add(makeTool("rename_knowledge_base", "重命名知识库", "仅修改显示名称，保留索引和学习进度",
        "仅在本轮用户明确要求将指定知识库改为某个名称时使用。id 从 list_knowledge_bases 获取；name 必须逐字来自本轮用户原话。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"name\":{\"type\":\"string\"}},\"required\":[\"id\",\"name\"]}", "write", { args: JsonObject =>
            let id = strOf(args, "id")
            let name = trimStr(strOf(args, "name"))
            let kb = store.load().findKb(id).getOrThrow()
            var requested = false
            for (word in ["改名", "重命名", "改成", "改为", "名称改", "名字改"]) { if (userText.contains(word)) { requested = true } }
            if (!requested || name.size == 0 || !userText.contains(name) ||
                (!userText.contains(id) && (kb.name.size == 0 || !userText.contains(kb.name)))) {
                throw Exception("请由用户明确指定要改名的知识库和新名称")
            }
            return learningResult(store.renameKb(id, name), "知识库已重命名，索引和学习进度保留")
        }))
    out.add(makeTool("get_learning_context", "读取学习上下文", "目标、偏好、知识网络、资源和真实测验记录",
        "读取当前学习档案、可编辑记忆、知识网络概况（知识点总数与最近节点）、资源列表和首次作答证据。掌握度未知时不得推断分数。回答知识网络/知识点相关询问前先读本工具；节点详情用 read_knowledge_point。",
        "{\"type\":\"object\",\"properties\":{}}", "read", { args: JsonObject =>
            let o = ls.context(kbId)
            o.put("courseTarget",CourseStore(store.dataDir).target(sid))
            o.put("knowledge", KnowledgeStore(store.dataDir).overview(8))
            o.put("resources", ls.resourcesForSession(kbId,sid))
            return learningResult(o, "已读取学习上下文")
        }))
    out.add(makeTool("remember_learning_fact", "记住学习状态", "保存本人明确表达的目标、偏好、阶段或困难",
        "仅记录本轮用户明确表达且有长期价值的学习信息，status 代表用户自述的阶段/困难，不是实测能力。quote 必须逐字来自当前用户消息；可带已有 id 更新。scope=global 用于通用偏好/目标，knowledge_base 只用于当前课程。topic 是稳定主题（如讲解方式/当前阶段），同范围同主题更新旧值。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"kind\":{\"type\":\"string\",\"enum\":[\"preference\",\"goal\",\"fact\",\"status\"]},\"text\":{\"type\":\"string\"},\"quote\":{\"type\":\"string\"},\"scope\":{\"type\":\"string\",\"enum\":[\"global\",\"knowledge_base\"]},\"topic\":{\"type\":\"string\"}},\"required\":[\"kind\",\"text\",\"quote\"]}", "write", { args: JsonObject =>
            let sourceQuote = strOf(args, "quote")
            if (!ls.autoRemember() && !userText.contains("记住") && !userText.contains("remember")) { throw Exception("自动积累记忆已关闭；仅在用户明确要求记住时记录") }
            if (sourceQuote.size == 0 || !userText.contains(sourceQuote)) { throw Exception("记忆必须引用本轮用户的明确原话") }
            let scope = strOf(args, "scope")
            if (scope.size > 0 && scope != "global" && scope != "knowledge_base") { throw Exception("记忆范围无效") }
            if (scope == "knowledge_base" && kbId.size == 0) { throw Exception("当前没有绑定知识库，课程状态需先指定课程") }
            let memoryKb = if (scope == "global") { "" } else { kbId }
            return learningResult(ls.remember(strOf(args, "id"), memoryKb, strOf(args, "kind"), sourceQuote, sourceQuote, sid, turnId, "agent", strOf(args, "topic")), "已记住用户原话，可在学习记忆中编辑或删除")
        }))
    out.add(makeTool("forget_learning_fact", "忘记学习记忆", "按用户要求删除指定记忆",
        "仅当用户明确要求忘记/删除记忆时使用，id 来自 get_learning_context。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}", "write", { args: JsonObject =>
            if (!userText.contains("忘") && !userText.contains("删除") && !userText.contains("forget") && !userText.contains("remove")) { throw Exception("用户本轮没有要求删除记忆") }
            ls.forget(strOf(args, "id"))
            return learningResult(JsonObject(), "已删除这条记忆")
        }))
    out.add(makeTool("read_learning_resource", "读取学习资源", "读取指定资源及历史版本",
        "读取学习资源的结构化内容、Markdown、出处、质检和版本。id 从 get_learning_context 的 resources 取得，version 可省略表示最新。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"version\":{\"type\":\"integer\"}},\"required\":[\"id\"]}", "read", { args: JsonObject =>
            return learningResult(ls.resource(strOf(args, "id"), intOf(args, "version")), "已读取资源")
        }))
    out.add(makeTool("generate_learning_resource", "生成学习资源", "讲义、实操、分阶测试或真实 PPTX",
        "仅在用户需要学习资料或你判断确有教学价值时生成一种资源。kind=ppt 会生成真实可编辑 .pptx，并同时留下应用内预览；不是 Markdown 演讲稿。先确认用途、受众、页数/篇幅和风格，已明确的不要重复问。count 对 quiz 是题量、对 ppt 是目标页数；章节页可能由渲染器自动补充，因此最终页数以 renderedSlides 为准。生成结果是候选，只有用户明确确认后才可调用 save_course_resource 收录。",
        "{\"type\":\"object\",\"properties\":{\"kind\":{\"type\":\"string\",\"enum\":[\"lecture\",\"practice\",\"quiz\",\"ppt\"]},\"topic\":{\"type\":\"string\"},\"detail\":{\"type\":\"string\",\"enum\":[\"concise\",\"balanced\",\"detailed\"]},\"count\":{\"type\":\"integer\"},\"audience\":{\"type\":\"string\"},\"purpose\":{\"type\":\"string\"},\"style\":{\"type\":\"string\"},\"backgroundStyle\":{\"type\":\"string\"},\"language\":{\"type\":\"string\"},\"aspectRatio\":{\"type\":\"string\"}},\"required\":[\"kind\",\"topic\"]}", "write", { args: JsonObject =>
            let req = ResourceRequest()
            req.kind = strOf(args, "kind")
            if (!isResourceKind(req.kind)) { throw Exception("资源类型不支持") }
            req.topic = strOf(args, "topic")
            req.detail = strOf(args, "detail")
            req.count = intOf(args, "count")
            req.kbId = kbId
            req.learningContext = ls.context(kbId).toString()
            req.courseTarget = CourseStore(store.dataDir).target(sid)
            for (key in ["audience", "purpose", "style", "backgroundStyle", "language", "aspectRatio"]) {
                match (args.get(key)) {
                    case Some(v) => req.presentation.put(key, v)
                    case None => ()
                }
            }
            let res = if (req.kind == "ppt") { generatePptLearningResource(store, req, shouldAbort, emit) } else { generateResourceWithCancel(store, req, shouldAbort, emit) }
            let body = resultJson(res)
            body.put("topic", JsonString(req.topic))
            if (strOf(args, "studyChapter").size > 0) { body.put("studyChapter", JsonString(strOf(args, "studyChapter"))) }
            body.put("profileSnapshot", JsonValue.fromStr(req.learningContext))
            if (!res.ok || shouldAbort()) {
                let r = learningResult(body, res.message)
                r.ok = false
                return r
            }
            let saved = ls.saveResource(body, kbId, sid, turnId, "", 0)
            emit("resource/saved", saved)
            let brief = JsonObject()
            for (key in ["id", "version", "kind", "title", "quality", "citations", "artifactPath", "format", "previewPath", "designPath", "requestedSlides", "renderedSlides", "message"]) { brief.put(key, saved.get(key).getOrDefault({ => JsonNull() })) }
            return learningResult(brief, strOf(saved, "message"))
        }))
    out.add(makeTool("revise_learning_resource", "修改学习资源", "根据要求创建新版本，保留旧版本",
        "先读资源，再按用户修改要求重新生成并质检新版本。baseVersion 必须为已读的最新版本；旧版本保留。instruction 写具体修改要求。默认沿用生成时的来源；用户要求更新资料时设 refreshSources=true。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"baseVersion\":{\"type\":\"integer\"},\"kind\":{\"type\":\"string\",\"enum\":[\"lecture\",\"practice\",\"quiz\",\"ppt\"]},\"refreshSources\":{ \"type\":\"boolean\"},\"instruction\":{\"type\":\"string\"}},\"required\":[\"id\",\"baseVersion\",\"instruction\"]}", "write", { args: JsonObject =>
            let id = strOf(args, "id")
            let version = intOf(args, "baseVersion")
            let old = ls.resource(id, 0)
            if (intOf(old, "version") != version) { throw Exception("资源已更新，请先重新读取最新版本") }
            let req = ResourceRequest()
            req.kind = strOf(old, "kind")
            if (req.kind == "legacy") {
                req.kind = strOf(args, "kind")
                if (!isResourceKind(req.kind)) { throw Exception("历史文件没有结构化类型，请按用户要求明确目标 kind=lecture/practice/quiz/ppt") }
            }
            req.topic = if (strOf(old, "topic").size > 0) { strOf(old, "topic") } else { strOf(old, "title") }
            req.kbId = strOf(old, "kbId")
            if (!boolOf(args, "refreshSources")) { req.sourceSnapshots = arrOf(old, "citations") }
            req.learningContext = ls.context(req.kbId).toString()
            req.revision = strOf(args, "instruction") + "\n上一版内容：" + byteSafePrefix(strOf(old, "markdown"), 14000)
            req.courseTarget = CourseStore(store.dataDir).target(sid)
            for (key in ["audience", "purpose", "style", "backgroundStyle", "language", "aspectRatio"]) {
                match (args.get(key)) {
                    case Some(v) => req.presentation.put(key, v)
                    case None => ()
                }
            }
            match (old.get("content")) {
                case Some(v) => match (objOf(v)) {
                    case Some(o) =>
                        let key = if (req.kind == "quiz") { "questions" } else { "slides" }
                        match (o.get(key)) { case Some(a) => match (a) { case xs: JsonArray => req.count = xs.size(); case _ => () }; case None => () }
                    case None => ()
                }
                case None => ()
            }
            let res = if (req.kind == "ppt") { generatePptLearningResource(store, req, shouldAbort, emit) } else { generateResourceWithCancel(store, req, shouldAbort, emit) }
            if (!res.ok || shouldAbort()) {
                let r = learningResult(resultJson(res), res.message)
                r.ok = false
                return r
            }
            let body = resultJson(res)
            body.put("topic", JsonString(req.topic))
            if (strOf(old, "studyChapter").size > 0) { body.put("studyChapter", JsonString(strOf(old, "studyChapter"))) }
            body.put("profileSnapshot", JsonValue.fromStr(req.learningContext))
            let saved = ls.saveResource(body, req.kbId, sid, turnId, id, version)
            emit("resource/saved", saved)
            let brief = JsonObject()
            brief.put("id", JsonString(id))
            brief.put("version", saved.get("version").getOrThrow())
            brief.put("title", saved.get("title").getOrThrow())
            brief.put("artifactPath", saved.get("artifactPath").getOrDefault({ => JsonString("") }))
            brief.put("format", saved.get("format").getOrDefault({ => JsonString("") }))
            brief.put("previewPath", saved.get("previewPath").getOrDefault({ => JsonString("") }))
            brief.put("designPath", saved.get("designPath").getOrDefault({ => JsonString("") }))
            brief.put("requestedSlides", saved.get("requestedSlides").getOrDefault({ => JsonInt(0) }))
            brief.put("renderedSlides", saved.get("renderedSlides").getOrDefault({ => JsonInt(0) }))
            return learningResult(brief, "已创建资源新版本，旧版本保留")
        }))
    return out
}
