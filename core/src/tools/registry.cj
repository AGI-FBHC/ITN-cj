package itn_desktop_core.tools

import std.collection.*
import std.convert.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.kb.*
import itn_desktop_core.study.*
import itn_desktop_core.util.*

/**
 * Agent 能用的一组工具。
 *
 * 设计取舍（写给接手的人）：
 * - 默认全是**本地能力**：检索自己的资料、按 id 取原文、看有哪些文档、算数、看时间、写笔记、写产物。
 * - 唯一的外部通道是 web_search（Tavily，见 websearch.cj）：本地资料里没有的、或者用户明确说
 *   "上网查一下"的时候才用；没配 API Key / 没启用时这个工具根本不出现在提示词里。
 * - 工具与模型解耦：模型只要能输出一段 JSON，就能调用工具。这样不管供应商支不支持
 *   OpenAI 的 function calling，行为都一致；能支持原生 tool_calls 的服务以后再单独适配。
 * - 每个工具都是纯本地操作，失败就返回 ok=false + 原因，不抛异常、不静默。
 */
public class ToolSpec {
    public var name: String = ""
    public var title: String = ""
    public var usage: String = ""
    public var desc: String = ""
}

/** 工具清单：界面展示与提示词共用同一份定义，避免两边漂移。 */
public func toolCatalog(): ArrayList<ToolSpec> {
    let out = ArrayList<ToolSpec>()

    let a = ToolSpec()
    a.name = "kb_search"
    a.title = "检索知识库"
    a.usage = "{\"query\": \"检索词\", \"top_k\": 6}"
    a.desc = "按语义/关键词检索当前知识库，返回带出处（文档、标题路径、编号）的切片。"
    out.add(a)

    let b = ToolSpec()
    b.name = "list_documents"
    b.title = "列出资料文档"
    b.usage = "{}"
    b.desc = "列出当前知识库里的全部文档标题、路径与切片数量，用来先看「资料里有什么」。"
    out.add(b)

    let c = ToolSpec()
    c.name = "read_chunk"
    c.title = "读取切片原文"
    c.usage = "{\"chunk_id\": \"01-基础.md#2\"}"
    c.desc = "按切片 id 取出完整原文，用于检索结果不够、需要看上下文的时候。"
    out.add(c)

    let d = ToolSpec()
    d.name = "current_time"
    d.title = "看当前时间"
    d.usage = "{}"
    d.desc = "返回本机当前日期与时间，用于「还剩几天」「今天要学什么」这类问题。"
    out.add(d)

    let e = ToolSpec()
    e.name = "calc"
    e.title = "计算"
    e.usage = "{\"expr\": \"(12+8)*3/4\"}"
    e.desc = "四则运算（支持 + - * / % 与括号），用于算课时、算正确率这类算术。"
    out.add(e)

    let f = ToolSpec()
    f.name = "save_note"
    f.title = "写一条笔记"
    f.usage = "{\"title\": \"标题\", \"text\": \"内容\"}"
    f.desc = "把结论存进本机的学习笔记，之后能在「我的笔记」里回看。"
    out.add(f)

    let g = ToolSpec()
    g.name = "save_artifact"
    g.title = "写一份产物"
    g.usage = "{\"name\": \"小结-主题.md\", \"content\": \"Markdown 正文\"}"
    g.desc = "把整理好的 Markdown 写成本地产物文件，出现在「我的资源」里。"
    out.add(g)

    let h = ToolSpec()
    h.name = "web_search"
    h.title = "联网搜索"
    h.usage = "{\"query\": \"2026 年提示词工程有哪些新做法\", \"limit\": 5}"
    h.desc = "用 Tavily 在互联网上搜公开资料（文档、论文、新闻），返回标题、链接和摘要。" +
        "只在本地资料里找不到、或用户明确要求上网查的时候用；引用它给出的信息要带上链接。"
    out.add(h)

    let i = ToolSpec()
    i.name = "web_fetch"
    i.title = "读取网页"
    i.usage = "{\"url\": \"https://example.com/article\"}"
    i.desc = "抓取一个网页的正文并落到本机（数据目录的 webcache 里），返回标题、抓取时间与正文。" +
        "用户贴了一个链接让你读、或者搜索结果里有想细看的页面时用它。" +
        "引用网页内容必须用 [W1]、[W2] 这样单独编号，并写出链接。"
    out.add(i)
    return out
}

/**
 * 给模型看的工具说明。要求它只输出一个 JSON 对象来发起调用。
 *
 * webSearch 为 false（没配 Tavily 密钥，或者用户把开关关了）时不写进提示词：
 * 提示词里列了却调用不起来，模型会反复重试同一个死工具。
 */
public func toolPrompt(webSearch: Bool, webFetch: Bool): String {
    let sb = StringBuilder()
    sb.append("你可以调用以下工具来获取事实（不要凭空猜）：\n")
    for (t in toolCatalog()) {
        if (t.name == "web_search" && !webSearch) {
            continue
        }
        if (t.name == "web_fetch" && !webFetch) {
            continue
        }
        sb.append("- ")
        sb.append(t.name)
        sb.append("：")
        sb.append(t.desc)
        sb.append(" 参数示例 ")
        sb.append(t.usage)
        sb.append("\n")
    }
    sb.append("\n需要调用工具时，**只输出一行 JSON**（不要写别的文字、不要加代码围栏）：\n")
    sb.append("{\"tool\":\"工具名\",\"args\":{...}}\n")
    sb.append("拿到工具结果后，再基于结果给出最终回答。不需要调用工具时，直接回答问题。\n")
    return sb.toString()
}

/* ---------- 一个够用的四则运算求值器（不引入外部依赖） ---------- */

class Calc {
    let src: Array<UInt8>
    var pos: Int64 = 0
    public var err: String = ""

    init(text: String) {
        this.src = text.toArray()
    }

    func skip(): Unit {
        while (pos < src.size && (src[pos] == 32 || src[pos] == 9)) {
            pos = pos + 1
        }
    }

    func peek(): UInt8 {
        skip()
        if (pos < src.size) {
            return src[pos]
        }
        return 0
    }

    func expr(): Float64 {
        var v = term()
        while (err.size == 0) {
            let c = peek()
            if (c == 43) {
                pos = pos + 1
                v = v + term()
            } else if (c == 45) {
                pos = pos + 1
                v = v - term()
            } else {
                break
            }
        }
        return v
    }

    func term(): Float64 {
        var v = unary()
        while (err.size == 0) {
            let c = peek()
            if (c == 42) {
                pos = pos + 1
                v = v * unary()
            } else if (c == 47) {
                pos = pos + 1
                let d = unary()
                if (d == 0.0) {
                    err = "除数不能为零"
                    return 0.0
                }
                v = v / d
            } else if (c == 37) {
                pos = pos + 1
                let d = unary()
                if (d == 0.0) {
                    err = "取余的除数不能为零"
                    return 0.0
                }
                // 仓颉的 Float64 没有 % 运算符，这里按整数取余处理，够用即可
                v = v - Float64(Int64(v / d)) * d
            } else {
                break
            }
        }
        return v
    }

    func unary(): Float64 {
        let c = peek()
        if (c == 45) {
            pos = pos + 1
            return 0.0 - unary()
        }
        if (c == 43) {
            pos = pos + 1
            return unary()
        }
        return primary()
    }

    func primary(): Float64 {
        let c = peek()
        if (c == 40) {
            pos = pos + 1
            let v = expr()
            if (peek() != 41) {
                err = "括号不配对"
                return 0.0
            }
            pos = pos + 1
            return v
        }
        return number()
    }

    func number(): Float64 {
        skip()
        let start = pos
        var dot = false
        while (pos < src.size) {
            let c = src[pos]
            if (c >= 48 && c <= 57) {
                pos = pos + 1
            } else if (c == 46 && !dot) {
                dot = true
                pos = pos + 1
            } else {
                break
            }
        }
        if (pos == start) {
            err = "表达式里有无法识别的字符"
            return 0.0
        }
        let t = String.fromUtf8(src[start..pos])
        try {
            return Float64.parse(t)
        } catch (e: Exception) {
            err = "无法解析数字：" + t
            return 0.0
        }
    }

    public func done(): Bool {
        skip()
        return pos >= src.size
    }

    public func value(): Float64 {
        let v = expr()
        if (err.size == 0 && !done()) {
            err = "表达式没写完，剩下的部分看不懂"
        }
        return v
    }
}

/* ---------- 工具执行 ---------- */

public class ToolBox {
    public let store: Store

    public init(store: Store) {
        this.store = store
    }

    func fail(name: String, why: String): ToolResult {
        let r = ToolResult()
        r.name = name
        r.ok = false
        r.summary = why
        return r
    }

    public func listDocuments(kbId: String): ToolResult {
        let idx = loadIndexCached(store.dataDir, kbId)
        if (idx.chunks.size == 0) {
            return fail("list_documents", "当前知识库还没有索引")
        }
        let paths = ArrayList<String>()
        let titles = ArrayList<String>()
        let counts = ArrayList<Int64>()
        for (c in idx.chunks) {
            var found = -1
            var i = 0
            while (i < paths.size) {
                if (paths[i] == c.docPath) {
                    found = i
                }
                i = i + 1
            }
            if (found < 0) {
                paths.add(c.docPath)
                titles.add(c.docTitle)
                counts.add(1)
            } else {
                counts[found] = counts[found] + 1
            }
        }
        let arr = JsonArray()
        var i = 0
        while (i < paths.size) {
            let o = JsonObject()
            o.put("docPath", JsonString(paths[i]))
            o.put("docTitle", JsonString(titles[i]))
            o.put("chunkCount", JsonInt(counts[i]))
            arr.add(o)
            i = i + 1
        }
        let r = ToolResult()
        r.name = "list_documents"
        r.data = arr
        r.summary = "共 " + paths.size.toString() + " 篇文档"
        return r
    }

    public func readChunk(kbId: String, chunkId: String): ToolResult {
        let idx = loadIndexCached(store.dataDir, kbId)
        for (c in idx.chunks) {
            if (c.id == chunkId) {
                let o = JsonObject()
                o.put("id", JsonString(c.id))
                o.put("docTitle", JsonString(c.docTitle))
                o.put("docPath", JsonString(c.docPath))
                o.put("headingPath", JsonString(c.headingPath))
                o.put("text", JsonString(c.text))
                o.put("caption", JsonString(c.caption))
                let r = ToolResult()
                r.name = "read_chunk"
                r.data = o
                r.summary = "读到切片 " + c.id + "（" + c.text.size.toString() + " 字）"
                return r
            }
        }
        return fail("read_chunk", "找不到切片：" + chunkId)
    }

    public func calc(expr: String): ToolResult {
        if (expr.size == 0) {
            return fail("calc", "缺少表达式")
        }
        let c = Calc(expr)
        let v = c.value()
        if (c.err.size > 0) {
            return fail("calc", c.err)
        }
        let o = JsonObject()
        o.put("expr", JsonString(expr))
        o.put("value", JsonFloat(v))
        let r = ToolResult()
        r.name = "calc"
        r.data = o
        r.summary = expr + " = " + v.toString()
        return r
    }

    public func currentTime(): ToolResult {
        let o = JsonObject()
        o.put("now", JsonString(nowStamp()))
        let r = ToolResult()
        r.name = "current_time"
        r.data = o
        r.summary = "当前时间 " + nowStamp()
        return r
    }

    public func saveNote(kbId: String, chapter: String, title: String, text: String): ToolResult {
        if (text.size == 0) {
            return fail("save_note", "笔记内容为空")
        }
        let ss = StudyStore(store.dataDir)
        let d = ss.load()
        let n = StudyNote()
        n.id = "n" + nowStamp() + d.notes.size.toString()
        n.kbId = kbId
        n.chapter = chapter
        n.title = title
        n.text = text
        n.createdAt = nowStamp()
        d.notes.add(n)
        ss.save(d)
        let o = JsonObject()
        o.put("id", JsonString(n.id))
        o.put("title", JsonString(title))
        let r = ToolResult()
        r.name = "save_note"
        r.data = o
        r.summary = "已写入笔记：" + title
        return r
    }

    /**
     * 联网搜索（Tavily）。
     *
     * 没配密钥 / 没启用时返回 ok=false 而不是抛异常：界面上这个工具本来就标着"不可用"，
     * 真的走到这里说明是模型自己越界调用了，如实告诉它原因即可。
     */
    public func webSearch(query: String, limit: Int64): ToolResult {
        if (!webSearchReady(store.dataDir)) {
            return fail("web_search", "联网搜索还没启用（设置 → 模型与接口 → 联网搜索，填 Tavily API Key 并打开开关）")
        }
        if (query.size == 0) {
            return fail("web_search", "缺少搜索词 query")
        }
        var n = limit
        if (n <= 0) {
            n = webSearchResults(store.dataDir)
        }
        try {
            let hits = WebSearchClient(webSearchKey(store.dataDir)).search(query, n)
            let r = ToolResult()
            r.name = "web_search"
            r.data = hits
            r.summary = "联网搜索「" + query + "」命中 " + hits.size().toString() + " 条（来源 Tavily）"
            return r
        } catch (e: Exception) {
            return fail("web_search", e.message)
        }
    }

    /**
     * 抓一个网页：正文落 <数据目录>/webcache，同时把正文回给模型。
     *
     * 和 web_search 不同，这个不需要任何 Key——"用户贴一个链接让 agent 读"本身就完整可用。
     */
    public func webFetch(url: String): ToolResult {
        if (url.size == 0) {
            return fail("web_fetch", "缺少 url")
        }
        try {
            let page = fetchPage(store.dataDir, trimStr(url))
            let r = ToolResult()
            r.name = "web_fetch"
            r.data = page
            r.summary = "已读取网页《" + strOf(page, "title") + "》（抓取于 " + strOf(page, "fetchedAt") +
                "，落本机：" + strOf(page, "path") + "）"
            return r
        } catch (e: Exception) {
            return fail("web_fetch", e.message)
        }
    }

    public func saveArtifact(name: String, content: String): ToolResult {
        if (content.size == 0) {
            return fail("save_artifact", "产物内容为空")
        }
        let dir = store.dataDir + "\\artifacts"
        ensureDir(dir)
        let p = dir + "\\" + sanitizeName(name)
        writeText(p, content)
        let o = JsonObject()
        o.put("path", JsonString(p))
        let r = ToolResult()
        r.name = "save_artifact"
        r.data = o
        r.summary = "已写出产物 " + sanitizeName(name) + "（" + content.size.toString() + " 字）"
        return r
    }
}