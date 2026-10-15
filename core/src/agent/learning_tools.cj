package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.learning.LearningStore
import itn_desktop_core.learning.arrOf
import itn_desktop_core.resource.ResourceRequest
import itn_desktop_core.resource.generateResourceWithCancel
import itn_desktop_core.resource.resultJson
import itn_desktop_core.resource.isResourceKind
import itn_desktop_core.util.*

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
    out.add(makeTool("get_learning_context", "读取学习上下文", "目标、偏好、资源和真实测验记录",
        "读取当前学习档案、可编辑记忆、资源列表和首次作答证据。掌握度未知时不得推断分数。",
        "{\"type\":\"object\",\"properties\":{}}", "read", { args: JsonObject =>
            let o = ls.context(kbId)
            o.put("resources", ls.resources(kbId))
            return learningResult(o, "已读取学习上下文")
        }))
    out.add(makeTool("remember_learning_fact", "记住学习偏好", "保存本人明确表达的目标、偏好或事实",
        "仅记录本轮用户明确表达且有长期价值的学习偏好、目标或事实，不记录猜测、敏感信息、模型自评掌握度。quote 必须逐字来自当前用户消息；可带已有 id 更新。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"kind\":{\"type\":\"string\",\"enum\":[\"preference\",\"goal\",\"fact\"]},\"text\":{\"type\":\"string\"},\"quote\":{\"type\":\"string\"}},\"required\":[\"kind\",\"text\",\"quote\"]}", "write", { args: JsonObject =>
            let sourceQuote = strOf(args, "quote")
            if (!ls.autoRemember() && !userText.contains("记住") && !userText.contains("remember")) { throw Exception("自动积累记忆已关闭；仅在用户明确要求记住时记录") }
            if (sourceQuote.size == 0 || !userText.contains(sourceQuote)) { throw Exception("记忆必须引用本轮用户的明确原话") }
            return learningResult(ls.remember(strOf(args, "id"), kbId, strOf(args, "kind"), sourceQuote, sourceQuote, sid, turnId, "agent"), "已记住用户原话，可在学习记忆中编辑或删除")
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
    out.add(makeTool("generate_learning_resource", "生成学习资源", "讲义、实操、分阶测试或在线演示",
        "仅在用户需要学习资料或你判断确有教学价值时生成一种资源。kind=lecture/practice/quiz/ppt；count 为题量或页数。内部执行结构化生成、质检和有限返修，失败如实返回，不要声称生成成功。返回稳定资源 id 和版本，可在工作台预览、作答或播放。",
        "{\"type\":\"object\",\"properties\":{\"kind\":{\"type\":\"string\",\"enum\":[\"lecture\",\"practice\",\"quiz\",\"ppt\"]},\"topic\":{\"type\":\"string\"},\"detail\":{\"type\":\"string\",\"enum\":[\"concise\",\"balanced\",\"detailed\"]},\"count\":{\"type\":\"integer\"}},\"required\":[\"kind\",\"topic\"]}", "write", { args: JsonObject =>
            let req = ResourceRequest()
            req.kind = strOf(args, "kind")
            if (!isResourceKind(req.kind)) { throw Exception("资源类型不支持") }
            req.topic = strOf(args, "topic")
            req.detail = strOf(args, "detail")
            req.count = intOf(args, "count")
            req.kbId = kbId
            req.learningContext = ls.context(kbId).toString()
            let res = generateResourceWithCancel(store, req, shouldAbort, emit)
            let body = resultJson(res)
            body.put("topic", JsonString(req.topic))
            body.put("profileSnapshot", JsonValue.fromStr(req.learningContext))
            if (!res.ok || shouldAbort()) {
                let r = learningResult(body, res.message)
                r.ok = false
                return r
            }
            let saved = ls.saveResource(body, kbId, sid, turnId, "", 0)
            emit("resource/saved", saved)
            let brief = JsonObject()
            for (key in ["id", "version", "kind", "title", "quality", "citations", "artifactPath", "message"]) { brief.put(key, saved.get(key).getOrDefault({ => JsonNull() })) }
            return learningResult(brief, res.message)
        }))
    out.add(makeTool("revise_learning_resource", "修改学习资源", "根据要求创建新版本，保留旧版本",
        "先读资源，再按用户修改要求重新生成并质检新版本。baseVersion 必须为已读的最新版本；旧版本保留。instruction 写具体修改要求。默认沿用生成时的来源；用户要求更新资料时设 refreshSources=true。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"},\"baseVersion\":{\"type\":\"integer\"},\"refreshSources\":{ \"type\":\"boolean\"},\"instruction\":{\"type\":\"string\"}},\"required\":[\"id\",\"baseVersion\",\"instruction\"]}", "write", { args: JsonObject =>
            let id = strOf(args, "id")
            let version = intOf(args, "baseVersion")
            let old = ls.resource(id, 0)
            if (intOf(old, "version") != version) { throw Exception("资源已更新，请先重新读取最新版本") }
            let req = ResourceRequest()
            req.kind = strOf(old, "kind")
            req.topic = if (strOf(old, "topic").size > 0) { strOf(old, "topic") } else { strOf(old, "title") }
            req.kbId = strOf(old, "kbId")
            if (!boolOf(args, "refreshSources")) { req.sourceSnapshots = arrOf(old, "citations") }
            req.learningContext = ls.context(req.kbId).toString()
            req.revision = strOf(args, "instruction") + "\n上一版内容：" + byteSafePrefix(strOf(old, "markdown"), 14000)
            match (old.get("content")) {
                case Some(v) => match (objOf(v)) {
                    case Some(o) =>
                        let key = if (req.kind == "quiz") { "questions" } else { "slides" }
                        match (o.get(key)) { case Some(a) => match (a) { case xs: JsonArray => req.count = xs.size(); case _ => () }; case None => () }
                    case None => ()
                }
                case None => ()
            }
            let res = generateResourceWithCancel(store, req, shouldAbort, emit)
            if (!res.ok || shouldAbort()) { let r = learningResult(resultJson(res), res.message); r.ok = false; return r }
            let body = resultJson(res)
            body.put("topic", JsonString(req.topic))
            body.put("profileSnapshot", JsonValue.fromStr(req.learningContext))
            let saved = ls.saveResource(body, req.kbId, sid, turnId, id, version)
            emit("resource/saved", saved)
            let brief = JsonObject()
            brief.put("id", JsonString(id))
            brief.put("version", saved.get("version").getOrThrow())
            brief.put("title", saved.get("title").getOrThrow())
            return learningResult(brief, "已创建资源新版本，旧版本保留")
        }))
    return out
}
