package itn_desktop_core.tools

import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.llm.*
import itn_desktop_core.util.*

/**
 * 联网搜索：Tavily。
 *
 * 为什么是 Tavily：网页版（仓库里的 src/agents）用的就是它——web_search_tool.py 调的是
 * TavilyClient.search(search_depth="advanced")，密钥放在 TAVILY_API_KEY。桌面版把同一套
 * 做法搬过来，只是内核是仓颉、没有 Python 客户端，所以直接打 https://api.tavily.com/search。
 *
 * 这是"可选能力"：没配密钥时 web_search 不交给模型，工具清单里也标成不可用——
 * 免得模型对着一个永远失败的工具反复试。
 */
public class WebSearchException <: Exception {
    public init(message: String) {
        super(message)
    }
}

/** Tavily 的固定入口。留成函数是为了 SNI 与 URL 永远对得上，不会被改歪。 */
func tavilyUrl(): String {
    return "https://api.tavily.com/search"
}

func tavilyHost(): String {
    return "api.tavily.com"
}

public class WebSearchClient {
    public let apiKey: String

    public init(apiKey: String) {
        this.apiKey = apiKey
    }

    /** 搜一次。返回 [{title,url,content}]，失败抛 WebSearchException（带上游原因）。 */
    public func search(query: String, limit: Int64): JsonArray {
        if (apiKey.size == 0) {
            throw WebSearchException("没有配置 Tavily API Key")
        }
        if (query.size == 0) {
            throw WebSearchException("搜索词为空")
        }
        var n = limit
        if (n <= 0) {
            n = 5
        }
        if (n > 10) {
            n = 10
        }
        let payload = JsonObject()
        payload.put("api_key", JsonString(apiKey))
        payload.put("query", JsonString(query))
        payload.put("search_depth", JsonString("advanced"))
        payload.put("max_results", JsonInt(n))
        payload.put("include_answer", JsonBool(false))
        let text = post(payload)
        var root = JsonValue.fromStr(text)
        let out = JsonArray()
        match (pick(root, ["results"])) {
            case Some(v) =>
                match (arrOf(v)) {
                    case Some(items) =>
                        var i = 0
                        while (i < items.size()) {
                            let it = items[i]
                            let o = JsonObject()
                            o.put("title", JsonString(pickStr(it, ["title"])))
                            o.put("url", JsonString(pickStr(it, ["url"])))
                            // 单条正文限长：搜索结果是要塞进提示词的，不截会把上下文顶爆
                            o.put("content", JsonString(byteSafePrefix(pickStr(it, ["content"]), 700)))
                            out.add(o)
                            i = i + 1
                        }
                    case None => ()
                }
            case None => ()
        }
        if (out.size() == 0) {
            throw WebSearchException("接口没有返回结果（原样返回：" + byteSafePrefix(text, 200) + "）")
        }
        return out
    }

    func post(payload: JsonObject): String {
        // 和模型调用同样的两个坑：SNI 必须显式给，HTTP/2 在部分服务端会被提前断开
        var tls = TlsClientConfig()
        tls.serverName = Some(tavilyHost())
        tls.supportedAlpnProtocols = ["http/1.1"]
        let client = ClientBuilder()
            .tlsConfig(tls)
            .readTimeout(Duration.minute * 2)
            .writeTimeout(Duration.minute * 2)
            .build()
        try {
            let req = HttpRequestBuilder()
                .method("POST")
                .url(tavilyUrl())
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .body(payload.toString())
                .build()
            let resp = client.send(req)
            let text = readAllString(resp.body)
            let status = resp.status
            if (status != 200) {
                throw WebSearchException("联网搜索接口返回 " + status.toString() + "：" + byteSafePrefix(text, 300))
            }
            return text
        } catch (e: WebSearchException) {
            throw e
        } catch (e: Exception) {
            throw WebSearchException("请求 Tavily 失败：" + e.message)
        } finally {
            client.close()
        }
    }
}

/* ---------- 配置的存放 ---------- */

/**
 * 联网搜索的配置放在 settings 键值表里（和界面偏好同一张表）。
 *
 * 不放进模型配置：它不是一个"模型"，而是给 Agent 用的一条外部通道；
 * 也不放 localStorage 或前端：密钥必须只落在本机数据库里。
 */
public let WEB_SEARCH_TABLE = "settings"

public func webSearchKey(dataDir: String): String {
    let db = DbHub.open(dataDir)
    return trimStr(db.getKv(WEB_SEARCH_TABLE, "web_search_key", ""))
}

public func webSearchEnabled(dataDir: String): Bool {
    let db = DbHub.open(dataDir)
    return db.getKv(WEB_SEARCH_TABLE, "web_search_enabled", "0") == "1"
}

public func webSearchResults(dataDir: String): Int64 {
    let db = DbHub.open(dataDir)
    var n: Int64 = 5
    try {
        n = Int64.parse(db.getKv(WEB_SEARCH_TABLE, "web_search_results", "5"))
    } catch (e: Exception) {
        n = 5
    }
    if (n <= 0 || n > 10) {
        n = 5
    }
    return n
}

/** 联网搜索是否可用：启用 + 有密钥。 */
public func webSearchReady(dataDir: String): Bool {
    return webSearchEnabled(dataDir) && webSearchKey(dataDir).size > 0
}

public func saveWebSearch(dataDir: String, apiKey: String, enabled: Bool, results: Int64): Unit {
    let db = DbHub.open(dataDir)
    let k = trimStr(apiKey)
    if (k.size > 0) {
        db.putKv(WEB_SEARCH_TABLE, "web_search_key", k)
    }
    db.putKv(WEB_SEARCH_TABLE, "web_search_enabled", if (enabled) { "1" } else { "0" })
    var n = results
    if (n <= 0 || n > 10) {
        n = 5
    }
    db.putKv(WEB_SEARCH_TABLE, "web_search_results", n.toString())
}

/** 只露头尾，用于界面回显：接口永不回传完整密钥。 */
public func webSearchKeyHint(key: String): String {
    if (key.size <= 8) {
        return if (key.size > 0) { "已设置" } else { "" }
    }
    let b = key.toArray()
    return String.fromUtf8(b[0..4]) + "…" + String.fromUtf8(b[(b.size - 4)..])
}

/** 界面用的那一段 JSON。 */
public func webSearchJson(dataDir: String): JsonObject {
    let key = webSearchKey(dataDir)
    let o = JsonObject()
    o.put("provider", JsonString("tavily"))
    o.put("enabled", JsonBool(webSearchEnabled(dataDir)))
    o.put("hasKey", JsonBool(key.size > 0))
    o.put("keyHint", JsonString(webSearchKeyHint(key)))
    o.put("results", JsonInt(webSearchResults(dataDir)))
    return o
}
