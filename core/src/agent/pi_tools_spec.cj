package itn_desktop_core.agent

import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.tools.*
import itn_desktop_core.harvest.*
import itn_desktop_core.util.*

/*
 * 领域工具的"中立定义"。
 *
 * 为什么要有这一层：pi 那个包和内核的 tools 包**同名类型太多**（ToolSpec / ToolResult / Tool / ToolRegistry），
 * 而仓颉里同一个文件同时通配导入两边就会歧义、全限定名又不认。所以拆成两个文件：
 *   - 这个文件只认识内核的工具（import itn_desktop_core.tools.*），把每个工具的"说明书 + 怎么跑"摘成 DomainTool；
 *   - pi_bridge.cj 只认识 pi（import itn_desktop_core.pi.*），把 DomainTool 包成 pi 的 Tool。
 * 两边通过 DomainTool 这个同包内的普通类对接，谁也不用看见对方的同名类型。
 */

/** 一次工具调用的结果，按 pi 的分工拆成三份：给模型的正文 / 给界面的载荷 / 一行摘要。 */
public class DomainToolRun {
    public var ok: Bool = true
    public var summary: String = ""
    public var content: String = ""
    public var details: JsonValue = JsonNull()
}

public class DomainTool {
    public var name: String = ""
    public var label: String = ""
    public var snippet: String = ""
    public var description: String = ""
    public var schema: String = "{\"type\":\"object\",\"properties\":{}}"
    public var risk: String = "read"
    /** 参数进来、结果出去；失败也走 ok=false，不抛。 */
    public var run: (JsonObject) -> DomainToolRun = { args: JsonObject => DomainToolRun() }
}

func textOf(res: ToolResult): String {
    if (!res.ok) {
        return res.summary
    }
    let sb = StringBuilder()
    sb.append(res.summary)
    let body = flattenForModel(res.data)
    if (body.size > 0) {
        sb.append("\n")
        sb.append(body)
    }
    return byteSafePrefix(sb.toString(), 50000)
}

func flattenForModel(v: JsonValue): String {
    match (v) {
        case s: JsonString => return s.getValue()
        case o: JsonObject =>
            let parts = ArrayList<String>()
            // id 必须给：read_chunk 是按 id 取原文的，不给就只能猜（实测模型会连着猜十几轮）
            for (key in ["id", "text", "title", "docTitle", "headingPath", "docPath", "path", "content", "excerpt", "summary"]) {
                match (o.get(key)) {
                    case Some(x) =>
                        let t = strValue(x)
                        if (t.size > 0) {
                            parts.add(key + ": " + t)
                        }
                    case None => ()
                }
            }
            if (parts.size == 0) {
                return o.toString()
            }
            return joinWith(parts, "\n")
        case a: JsonArray =>
            let lines = ArrayList<String>()
            var i = 0
            while (i < a.size()) {
                let piece = flattenForModel(a[i])
                if (piece.size > 0) {
                    lines.add("- " + piece)
                }
                i = i + 1
            }
            return joinWith(lines, "\n")
        case _ => return ""
    }
}

func fromResult(res: ToolResult): DomainToolRun {
    let r = DomainToolRun()
    r.ok = res.ok
    r.summary = res.summary
    r.content = textOf(res)
    r.details = res.data
    return r
}

func makeTool(name: String, label: String, snippet: String, description: String, schema: String, risk: String,
    fn: (JsonObject) -> DomainToolRun): DomainTool {
    let t = DomainTool()
    t.name = name
    t.label = label
    t.snippet = snippet
    t.description = description
    t.schema = schema
    t.risk = risk
    t.run = fn
    return t
}

/**
 * 这一轮的领域工具（参数 schema 是显式的，不再靠"示例 + 猜"）。
 *
 * allowWeb 为 false 时**不生成**联网工具：pi 的注册表里就没有它，提示词里也没有——
 * 与"不静默联网"是同一件事的两面。
 */
public func buildDomainToolDefs(store: Store, kbId: String, allowWeb: Bool): ArrayList<DomainTool> {
    return buildDomainToolDefsWithCancel(store, kbId, allowWeb, { => false })
}

public func buildDomainToolDefsWithCancel(store: Store, kbId: String, allowWeb: Bool,
    shouldAbort: () -> Bool): ArrayList<DomainTool> {
    let box = ToolBox(store)
    box.shouldAbort = shouldAbort
    let tools = ToolRegistry(store)
    tools.shouldAbort = shouldAbort
    let out = ArrayList<DomainTool>()

    out.add(makeTool("kb_search", "检索知识库", "按语义/关键词检索当前知识库",
        "检索当前知识库，返回带出处（文档、标题路径、编号）的切片。回答时用 [编号] 引用它们。",
        "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"description\":\"检索词\"},\"top_k\":{\"type\":\"integer\",\"description\":\"返回条数，默认 6\"}},\"required\":[\"query\"]}",
        "read",
        { args: JsonObject =>
            var topK: Int64 = 6
            let k = intOf(args, "top_k")
            if (k > 0) {
                topK = k
            }
            return fromResult(tools.kbSearch(kbId, strOf(args, "query"), topK))
        }))

    out.add(makeTool("list_documents", "列出资料文档", "当前知识库有哪些文档",
        "列出当前知识库里的文档标题、路径与切片数量。", "{\"type\":\"object\",\"properties\":{}}", "read",
        { args: JsonObject => fromResult(box.listDocuments(kbId)) }))

    out.add(makeTool("read_chunk", "读取切片原文", "按 id 取切片全文",
        "按切片 id 取出完整原文，用于检索结果不够、需要看上下文的时候。",
        "{\"type\":\"object\",\"properties\":{\"chunk_id\":{\"type\":\"string\"}},\"required\":[\"chunk_id\"]}", "read",
        { args: JsonObject => fromResult(box.readChunk(kbId, strOf(args, "chunk_id"))) }))

    out.add(makeTool("current_time", "看当前时间", "本机当前日期与时间",
        "返回本机当前日期与时间。", "{\"type\":\"object\",\"properties\":{}}", "read",
        { args: JsonObject => fromResult(box.currentTime()) }))

    out.add(makeTool("calc", "计算", "四则运算",
        "四则运算（支持 + - * / % 与括号）。",
        "{\"type\":\"object\",\"properties\":{\"expr\":{\"type\":\"string\"}},\"required\":[\"expr\"]}", "read",
        { args: JsonObject => fromResult(box.calc(strOf(args, "expr"))) }))

    out.add(makeTool("save_note", "写一条笔记", "把结论存进本机笔记",
        "把结论存进本机的学习笔记，之后能在「我的笔记」里回看。",
        "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"text\":{\"type\":\"string\"}},\"required\":[\"title\",\"text\"]}",
        "write",
        { args: JsonObject =>
            return fromResult(box.saveNote(kbId, "", strOf(args, "title"), strOf(args, "text")))
        }))

    out.add(makeTool("save_artifact", "写一份产物", "把 Markdown 写成本地产物",
        "把整理好的 Markdown 写成本地产物文件，出现在「我的资源」里。",
        "{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}},\"required\":[\"name\",\"content\"]}",
        "write",
        { args: JsonObject =>
            return fromResult(tools.saveArtifact(strOf(args, "name"), strOf(args, "content")))
        }))

    out.add(makeTool("skill_read", "读技能正文", "按 id 读技能的用法说明",
        "按 id 读取一个技能的正文（这件事该怎么做），然后照着里面的步骤、用它声明的工具去做。",
        "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}", "read",
        { args: JsonObject =>
            let id = strOf(args, "id")
            match (readSkill(store.dataDir, id, allowWeb)) {
                case Some(pair) =>
                    let info = pair[0]
                    let r = DomainToolRun()
                    r.ok = true
                    r.summary = "已读取技能「" + info.title + "」（允许的工具：" + joinWith(info.tools, "/") + "）"
                    r.content = r.summary + "\n" + byteSafePrefix(pair[1], 6000)
                    let o = JsonObject()
                    o.put("id", JsonString(info.id))
                    o.put("title", JsonString(info.title))
                    let ts = JsonArray()
                    for (x in info.tools) {
                        ts.add(JsonString(x))
                    }
                    o.put("tools", ts)
                    r.details = o
                    return r
                case None =>
                    let r = DomainToolRun()
                    r.ok = false
                    r.summary = "没有这个技能：" + id
                    r.content = r.summary
                    return r
            }
        }))

    if (allowWeb) {
        out.add(makeTool("kb_stage", "暂存知识资料", "抓取网页或 GitHub 仓库，只进暂存区",
            "将公开网页或 GitHub 仓库暂存到本机，返回真实来源和文件清单。暂存不会进入知识库索引；只能请用户在领域知识库页面确认并入。",
            "{\"type\":\"object\",\"properties\":{\"kind\":{\"type\":\"string\",\"enum\":[\"url\",\"repo\"]},\"url\":{\"type\":\"string\"},\"ref\":{\"type\":\"string\"}},\"required\":[\"kind\",\"url\"]}", "external",
            { args: JsonObject =>
                let r = DomainToolRun()
                try {
                    r.details = harvestStage(store.dataDir, strOf(args, "kind"), strOf(args, "url"), strOf(args, "ref"))
                    r.summary = "已暂存，尚未进索引。请到领域知识库 → 收集资料检查并确认并入。"
                    r.content = r.summary + "\n" + r.details.toString()
                } catch (e: Exception) { r.ok = false; r.summary = e.message; r.content = e.message }
                return r
            }))
        out.add(makeTool("kb_ingest", "请求并入确认", "提示用户检查并入，模型不能自行确认",
            "返回界面确认指引，不执行并入。只有用户在领域知识库页面检查真实文件清单并点击确认并入，才能改变知识库。",
            "{\"type\":\"object\",\"properties\":{\"id\":{\"type\":\"string\"}},\"required\":[\"id\"]}", "read",
            { args: JsonObject =>
                let r = DomainToolRun()
                let o = JsonObject()
                o.put("id", JsonString(strOf(args, "id")))
                o.put("requiresConfirmation", JsonBool(true))
                r.details = o
                r.summary = "尚未并入。请用户在领域知识库 → 收集资料检查清单，选择目标库，再点确认并入。"
                r.content = r.summary
                return r
            }))
        out.add(makeTool("web_search", "联网搜索", "用 Tavily 搜公开资料",
            "用 Tavily 在互联网上搜公开资料，返回标题、链接与摘要。只在本地资料里找不到、或用户明确要求上网查的时候用。",
            "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"},\"limit\":{\"type\":\"integer\",\"description\":\"返回条数，默认 5\"}},\"required\":[\"query\"]}",
            "external",
            { args: JsonObject => fromResult(box.webSearch(strOf(args, "query"), intOf(args, "limit"))) }))
        out.add(makeTool("web_fetch", "读取网页", "抓网页正文并落本机",
            "抓取一个网页的正文并落到本机（数据目录的 webcache），返回标题、抓取时间与正文；引用网页用 [W1]、[W2] 单独编号并写出链接。",
            "{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\"}},\"required\":[\"url\"]}", "external",
            { args: JsonObject => fromResult(box.webFetch(strOf(args, "url"))) }))
    }
    return out
}
