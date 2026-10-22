package zhixun_learning

import std.collection.*
import std.core.*
import stdx.encoding.json.*
import stdx.net.http.*

/**
 * Tavily 联网检索配置。
 *
 * 密钥复用模型槽位的 encryptSecret / decryptSecret 加密落库，页面只回显尾号；
 * 任何可能带出密钥的文本（尤其是上游错误响应）都要先过 tavilyScrubKey。
 */
class TavilySettings {
    let enabled: Bool
    let cipher: String
    let hint: String
    let maxResults: Int64
    let searchDepth: String

    init(enabled: Bool, cipher: String, hint: String, maxResults: Int64, searchDepth: String) {
        this.enabled = enabled
        this.cipher = cipher
        this.hint = hint
        this.maxResults = maxResults
        this.searchDepth = searchDepth
    }
}

let tavilySearchUrl = "https://api.tavily.com/search"

/** 条数上限 1–10，越界时收敛到最近边界。 */
func tavilyClampMaxResults(raw: Int64): Int64 {
    if (raw < 1) { return 1 }
    if (raw > 10) { return 10 }
    raw
}

func tavilyValidDepth(raw: String): Bool {
    let value = raw.trimAscii().toAsciiLower()
    value == "basic" || value == "advanced"
}

func tavilyNormalizeDepth(raw: String): String {
    if (raw.trimAscii().toAsciiLower() == "advanced") { return "advanced" }
    "basic"
}

func loadTavilySettings(cfg: Config): TavilySettings {
    let rows = query(cfg,
        "SELECT tavily_enabled,tavily_api_key_cipher,tavily_api_key_hint,tavily_max_results,tavily_search_depth " +
        "FROM kb_settings WHERE id=1")
    if (rows.size == 0) { return TavilySettings(false, "", "", 5, "basic") }
    let row = rows[0]
    let stored = row.int("tavily_max_results")
    TavilySettings(
        row.int("tavily_enabled") == 1,
        if (row.isNull("tavily_api_key_cipher")) { "" } else { row.text("tavily_api_key_cipher") },
        row.text("tavily_api_key_hint"),
        if (stored < 1) { 5 } else if (stored > 10) { 10 } else { stored },
        tavilyNormalizeDepth(row.text("tavily_search_depth"))
    )
}

/** 环境变量只作兜底，管理端保存的密文优先。 */
func tavilyEnvKey(): String {
    envOr("TAVILY_API_KEY", "")
}

func resolveTavilyKey(cfg: Config, settings: TavilySettings): String {
    if (settings.cipher.size > 0) {
        match (decryptSecret(cfg.authSecret, settings.cipher)) {
            case Some(value) => return value
            case None => ()
        }
    }
    tavilyEnvKey()
}

/** 管理端读取用：只有开关、尾号和参数，永远没有明文密钥。 */
func tavilySettingsJson(cfg: Config, settings: TavilySettings): String {
    let out = JsonWriter()
    out.putBool("enabled", settings.enabled)
    out.putStr("keyHint", settings.hint)
    out.putBool("keyConfigured", resolveTavilyKey(cfg, settings).size > 0)
    out.putInt("maxResults", settings.maxResults)
    out.putStr("searchDepth", settings.searchDepth)
    out.toJson()
}

/** 上游响应或异常文本里若混进密钥，替换掉再外传。 */
func tavilyScrubKey(text: String, key: String): String {
    if (key.size < 8) { return text }
    var out = text
    var guard = 0
    while (guard < 8) {
        match (out.indexOf(key)) {
            case Some(index) => out = out[0..index] + "***" + out[(index + key.size)..out.size]
            case None => guard = 8
        }
        guard += 1
    }
    out
}

func tavilyPostSearch(key: String, payload: String): String {
    let client = modelClient(ModelEndpoint(tavilySearchUrl, key, "", ""), 2)
    try {
        let request = HttpRequestBuilder()
            .method("POST")
            .url(tavilySearchUrl)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .body(payload)
            .build()
        let response = client.send(request)
        let text = readStreamText(response.body)
        if (response.status != 200) {
            throw Exception("Tavily 接口返回 " + response.status.toString() + "：" +
                tavilyScrubKey(briefBody(text), key))
        }
        text
    } finally {
        try { client.close() } catch (_: Exception) {}
    }
}

/**
 * 真正的一次联网检索，返回 {answer, results:[{title,url,content,score}]}。
 * 未启用、缺密钥、查询为空或超长都在发请求前直接拒绝。
 */
func tavilySearchJson(cfg: Config, settings: TavilySettings, queryText: String, requestedMax: Int64): String {
    if (!settings.enabled) { throw Exception("联网检索还没有在管理端启用") }
    tavilySearchWithKey(resolveTavilyKey(cfg, settings), settings, queryText, requestedMax)
}

/** 与 tavilySearchJson 同一路径，但允许传入页面上刚填、还没保存的密钥。 */
func tavilySearchWithKey(key: String, settings: TavilySettings, queryText: String, requestedMax: Int64): String {
    if (key.size == 0) { throw Exception("还没有配置 Tavily 密钥") }
    let text = queryText.trimAscii()
    if (text.size == 0) { throw Exception("检索内容不能为空") }
    if (charCount(text) > 500) { throw Exception("检索内容最多 500 字") }
    let max = tavilyClampMaxResults(if (requestedMax < 1) { settings.maxResults } else { requestedMax })
    let payload = JsonWriter()
    payload.putStr("api_key", key)
    payload.putStr("query", text)
    payload.putStr("search_depth", settings.searchDepth)
    payload.putInt("max_results", max)
    payload.putBool("include_answer", true)
    tavilyResultsJson(tavilyPostSearch(key, payload.toJson()))
}

/** Tavily 响应收敛成固定契约：字段缺失给空串，不把 null 传下去。 */
func tavilyResultsJson(raw: String): String {
    let parsed = match (jsonParse(raw)) {
        case Some(value) => value
        case None => throw Exception("Tavily 返回内容不是合法 JSON")
    }
    if (!isJsObject(parsed)) { throw Exception("Tavily 返回内容不是 JSON 对象") }
    let body = parsed.asObject()
    let out = JsonWriter()
    out.putStr("answer", jsonGetString(body, "answer") ?? "")
    let items = JsonArrWriter()
    match (jsonGetArray(body, "results")) {
        case Some(values) =>
            var i: Int64 = 0
            while (i < values.size()) {
                let value = values[i]
                if (isJsObject(value)) {
                    let entry = value.asObject()
                    let one = JsonWriter()
                    one.putStr("title", jsonGetString(entry, "title") ?? "")
                    one.putStr("url", jsonGetString(entry, "url") ?? "")
                    one.putStr("content", jsonGetString(entry, "content") ?? "")
                    one.putFloat("score", jsonGetFloat(entry, "score") ?? 0.0)
                    items.addRaw(one.toJson())
                }
                i += 1
            }
        case None => ()
    }
    out.putRaw("results", items.toJson())
    out.toJson()
}

/**
 * 给系统提示词用的纯文本块：联网摘要 + 前五条标题、链接和截断摘要。
 * 检索失败直接抛异常，由调用方决定是降级回答还是把错误交给用户。
 */
func tavilySearchContextText(cfg: Config, settings: TavilySettings, queryText: String, requestedMax: Int64): String {
    let parsed = match (jsonParse(tavilySearchJson(cfg, settings, queryText, requestedMax))) {
        case Some(value) => if (isJsObject(value)) { value.asObject() } else { JsonObject() }
        case None => JsonObject()
    }
    var out = ""
    let answer = jsonGetString(parsed, "answer") ?? ""
    if (answer.size > 0) { out = "联网摘要：" + kbTruncate(answer, 600) }
    match (jsonGetArray(parsed, "results")) {
        case Some(values) =>
            var index: Int64 = 1
            var i: Int64 = 0
            while (i < values.size()) {
                let value = values[i]
                if (isJsObject(value) && index <= 5) {
                    let entry = value.asObject()
                    out = out + "\n" + index.toString() + ". " + (jsonGetString(entry, "title") ?? "") +
                        "（" + (jsonGetString(entry, "url") ?? "") + "）：" +
                        kbTruncate(jsonGetString(entry, "content") ?? "", 400)
                    index += 1
                }
                i += 1
            }
        case None => ()
    }
    out
}
