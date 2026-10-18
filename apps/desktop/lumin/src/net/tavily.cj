package lumin.net

import std.collection.*
import std.io.*
import std.time.*
import stdx.encoding.json.*
import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import lumin.pi.*

/*
 * Tavily 联网检索（工具，risk = external）。
 *
 * 位置：单独一个 lumin.net 包 —— lumin.pi 运行时保持零网络，lumin.tools 只管文件/命令，
 * 要联网的东西都归这里（跟 CLI 里的模型客户端一个道理）。
 *
 * 设计要点：
 *  - 结果带 [W1]/[W2] 编号 + 链接：这正是运行时 citationWarning() 认的格式，
 *    所以"回答里引用的网页编号"能被自检抓到（编造 [W9] 会当场报出来）。
 *  - 没配 Key 就"注册但不可用"：清单里看得见、提示词里不给、调用直接拒（和内核同款做法）。
 *  - 审批层已经把 web_search 归成 kind = web → ask/auto 档下会先问用户（full 档不问）。
 */

public class TavilyConfig {
    public var apiKey: String = ""
    public var endpoint: String = "https://api.tavily.com/search"
    public var maxResults: Int64 = 5
    public var searchDepth: String = "advanced"
    public var includeAnswer: Bool = true
    /** 单次请求超时（秒） */
    public var timeoutSec: Int64 = 30
    public var lastError: String = ""

    public init() {}

    public func ready(): Bool {
        return apiKey.size > 0
    }
}

/** 一次检索的结果：正文（给模型）、结构化（给界面）、以及 answer（Tavily 的摘要，可能为空）。 */
public class SearchOutcome {
    public var content: String = ""
    public var details: JsonValue = JsonNull()
    public var answer: String = ""
    public var count: Int64 = 0
    public var error: String = ""
}

public class WebSearchTool <: Tool {
    private let cfg: TavilyConfig
    /** 诊断用：最近一次检索耗时与条数 */
    public var lastMs: Int64 = 0
    public var lastCount: Int64 = 0

    public init(cfg: TavilyConfig) {
        this.cfg = cfg
    }

    public func spec(): ToolSpec {
        let s = ToolSpec("web_search", "联网搜索", "Search the web for up-to-date public information",
            "Search the public web via Tavily and return numbered results ([W1], [W2] ...) with titles, links and snippets. " +
            "Use it only when the workspace does not answer the question, or when the user asks to look it up online. " +
            "Always cite the links you used.",
            "{\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\",\"description\":\"What to search for\"},\"limit\":{\"type\":\"number\",\"description\":\"Maximum number of results (default 5, max 10)\"}},\"required\":[\"query\"]}",
            "external")
        s.guidelines = [
            "先看工作区里的资料；本地没有、或用户明确要求上网时再用它。",
            "引用联网结果要带链接（用 [W1] 这种编号 + 链接），不要编造编号。"
        ]
        return s
    }

    public func run(callId: String, args: JsonObject): ToolResult {
        let q = trimStr(strOf(args, "query"))
        if (q.size == 0) {
            return ToolResult.err("缺少 query 参数")
        }
        if (!cfg.ready()) {
            return ToolResult.err("没有配置 Tavily 密钥，联网检索不可用（在 .env.local 写 LUMIN_TAVILY_KEY=...）")
        }
        var limit = intOf(args, "limit")
        if (limit <= 0) {
            limit = cfg.maxResults
        }
        if (limit > 10) {
            limit = 10
        }
        let body = JsonObject()
        body.put("query", JsonString(q))
        body.put("max_results", JsonInt(limit))
        body.put("search_depth", JsonString(cfg.searchDepth))
        body.put("include_answer", JsonBool(cfg.includeAnswer))
        let started = nowMillis()
        let (code, text) = postSearch(body)
        lastMs = nowMillis() - started
        if (code != 200) {
            let msg = "联网检索失败：Tavily 返回 " + code.toString() + "：" + byteSafePrefix(trimStr(text), 300)
            cfg.lastError = msg
            return ToolResult.err(msg)
        }
        let outcome = parseTavilyResults(text)
        if (outcome.error.size > 0) {
            return ToolResult.err(outcome.error)
        }
        lastCount = outcome.count
        let head = "联网找到 " + outcome.count.toString() + " 条结果（" + (lastMs / 1000).toString() + "s）：" + q
        return ToolResult.ok(head, outcome.content, outcome.details)
    }

    private func postSearch(body: JsonValue): (Int64, String) {
        let url = cfg.endpoint
        var tls = TlsClientConfig()
        tls.serverName = Some(hostOfUrl(url))
        tls.supportedAlpnProtocols = ["http/1.1"]
        let client = ClientBuilder()
            .tlsConfig(tls)
            .readTimeout(Duration.second * cfg.timeoutSec)
            .writeTimeout(Duration.second * cfg.timeoutSec)
            .build()
        try {
            let req = HttpRequestBuilder()
                .method("POST")
                .url(url)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + cfg.apiKey)
                .header("Accept", "application/json")
                .body(body.toString())
                .build()
            let resp = client.send(req)
            let st = resp.status
            return (Int64(st), readAllText(resp.body))
        } catch (e: Exception) {
            return (0, "网络层失败：" + e.message)
        } finally {
            client.close()
        }
    }
}

func hostOfUrl(url: String): String {
    let b = url.toArray()
    var i: Int64 = 0
    while (i + 2 < b.size) {
        if (b[i] == 58 && b[i + 1] == 47 && b[i + 2] == 47) {
            i = i + 3
            break
        }
        i = i + 1
    }
    let start = i
    var end = b.size
    var j = i
    while (j < b.size) {
        if (b[j] == 47 || b[j] == 58) {
            end = j
            break
        }
        j = j + 1
    }
    return safeUtf8(b, start, end)
}

/** 整包读完再解码（分片解码会把汉字切断）。 */
func readAllText(input: InputStream): String {
    let raw = ArrayList<UInt8>()
    let buf = Array<UInt8>(4096, repeat: 0)
    while (true) {
        let n = input.read(buf)
        if (n <= 0) {
            break
        }
        var i = 0
        while (i < n) {
            raw.add(buf[i])
            i = i + 1
        }
    }
    return safeUtf8(raw.toArray(), 0, raw.size)
}

/**
 * 解析 Tavily 的返回。独立成纯函数：测试里可以拿固定 JSON 断言，不必联网。
 * 编号从 1 开始，写成 [W1]/[W2]，与运行时 citationWarning 的约定一致。
 */
public func parseTavilyResults(text: String): SearchOutcome {
    let out = SearchOutcome()
    let t = trimStr(text)
    if (t.size == 0) {
        out.error = "Tavily 返回了空内容"
        return out
    }
    var root: JsonObject = JsonObject()
    try {
        match (JsonValue.fromStr(t)) {
            case o: JsonObject => root = o
            case _ =>
                out.error = "Tavily 返回的不是 JSON：" + byteSafePrefix(t, 200)
                return out
        }
    } catch (e: Exception) {
        out.error = "解析 Tavily 返回失败：" + e.message
        return out
    }
    // 有的错误以 detail.error 形式回来
    let detailErr = strOf(root, "detail")
    if (detailErr.size > 0) {
        out.error = "Tavily 报错：" + byteSafePrefix(detailErr, 200)
        return out
    }
    out.answer = strOf(root, "answer")
    let arr = JsonArray()
    let sb = StringBuilder()
    if (out.answer.size > 0) {
        sb.append("Tavily 摘要：")
        sb.append(out.answer)
        sb.append("\n\n")
    }
    match (root.get("results")) {
        case Some(v) =>
            match (v) {
                case list: JsonArray =>
                    var i: Int64 = 0
                    while (i < list.size()) {
                        match (list[i]) {
                            case o: JsonObject =>
                                let title = strOf(o, "title")
                                let url = strOf(o, "url")
                                let snip = strOf(o, "content")
                                sb.append("[W")
                                sb.append((i + 1).toString())
                                sb.append("] ")
                                sb.append(title)
                                sb.append("\n    链接：")
                                sb.append(url)
                                sb.append("\n    摘要：")
                                sb.append(byteSafePrefix(snip, 600))
                                sb.append("\n\n")
                                let item = JsonObject()
                                item.put("title", JsonString(title))
                                item.put("url", JsonString(url))
                                item.put("snippet", JsonString(byteSafePrefix(snip, 600)))
                                item.put("score", JsonFloat(floatOf(o, "score")))
                                arr.add(item)
                                out.count = out.count + 1
                            case _ => ()
                        }
                        i = i + 1
                    }
                case _ => ()
            }
        case None => ()
    }
    out.content = sb.toString()
    out.details = arr
    if (out.count == 0) {
        out.error = "Tavily 没返回结果（换个说法再试，或确认关键词）"
    }
    return out
}

/** 取浮点（取不到给 0.0）。 */
func floatOf(o: JsonObject, key: String): Float64 {
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case f: JsonFloat => return f.getValue()
                case j: JsonInt => return Float64(j.getValue())
                case _ => return 0.0
            }
        case None => return 0.0
    }
}
