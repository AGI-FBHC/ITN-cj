package zhixun_learning

import std.collection.*
import std.core.*
import std.io.*
import stdx.encoding.json.*
import stdx.net.http.*
import stdx.net.tls.*

/** OpenAI 兼容端点的连接信息。Key 只从环境变量读，不落库。 */
class ModelEndpoint {
    let baseUrl: String
    let apiKey: String
    let embeddingModel: String
    let chatModel: String

    init(baseUrl: String, apiKey: String, embeddingModel: String, chatModel: String) {
        this.baseUrl = baseUrl.trimAscii()
        this.apiKey = apiKey
        this.embeddingModel = embeddingModel.trimAscii()
        this.chatModel = chatModel.trimAscii()
    }

    func hasKey(): Bool {
        baseUrl.size > 0 && apiKey.size > 0
    }

    func hasEmbedding(): Bool {
        hasKey() && embeddingModel.size > 0
    }

    func hasChat(): Bool {
        hasKey() && chatModel.size > 0
    }

    func isPlainHttp(): Bool {
        baseUrl.startsWith("http://")
    }

    func url(path: String): String {
        var base = baseUrl
        while (base.size > 0 && base[base.size - 1..base.size] == "/") {
            base = base[0..base.size - 1]
        }
        base + path
    }
}

func modelHostOf(url: String): String {
    let bytes = url.toArray()
    var start: Int64 = 0
    var i: Int64 = 0
    while (i + 2 < bytes.size) {
        if (Int64(bytes[i]) == 58 && Int64(bytes[i + 1]) == 47 && Int64(bytes[i + 2]) == 47) {
            start = i + 3
            break
        }
        i += 1
    }
    var end = bytes.size
    var j = start
    while (j < bytes.size) {
        let value = Int64(bytes[j])
        if (value == 47 || value == 58) {
            end = j
            break
        }
        j += 1
    }
    String.fromUtf8(bytes.slice(start, end - start))
}

func safeUtf8(bytes: Array<UInt8>): String {
    try {
        return String.fromUtf8(bytes)
    } catch (_: Exception) {
        let out = ArrayList<UInt8>()
        var i: Int64 = 0
        while (i < bytes.size) {
            let b = Int64(bytes[i])
            if (b < 128) {
                out.add(bytes[i]); i += 1
            } else if (b >= 194 && b <= 223 && i + 1 < bytes.size &&
                       Int64(bytes[i + 1]) >= 128 && Int64(bytes[i + 1]) <= 191) {
                out.add(bytes[i]); out.add(bytes[i + 1]); i += 2
            } else if (b >= 224 && b <= 239 && i + 2 < bytes.size &&
                       Int64(bytes[i + 1]) >= 128 && Int64(bytes[i + 1]) <= 191 &&
                       Int64(bytes[i + 2]) >= 128 && Int64(bytes[i + 2]) <= 191) {
                out.add(bytes[i]); out.add(bytes[i + 1]); out.add(bytes[i + 2]); i += 3
            } else if (b >= 240 && b <= 244 && i + 3 < bytes.size &&
                       Int64(bytes[i + 1]) >= 128 && Int64(bytes[i + 1]) <= 191 &&
                       Int64(bytes[i + 2]) >= 128 && Int64(bytes[i + 2]) <= 191 &&
                       Int64(bytes[i + 3]) >= 128 && Int64(bytes[i + 3]) <= 191) {
                out.add(bytes[i]); out.add(bytes[i + 1]); out.add(bytes[i + 2]); out.add(bytes[i + 3]); i += 4
            } else {
                out.add(63u8); i += 1
            }
        }
        String.fromUtf8(out.toArray())
    }
}

func readStreamText(input: InputStream): String {
    let out = ArrayList<UInt8>()
    let buffer = Array<UInt8>(8192, repeat: 0)
    while (true) {
        let n = input.read(buffer)
        if (n <= 0) { break }
        var i: Int64 = 0
        while (i < n) {
            out.add(buffer[i])
            i += 1
        }
    }
    if (out.size == 0) { return "" }
    safeUtf8(out.toArray())
}

func briefBody(text: String): String {
    let trimmed = text.trimAscii()
    kbTruncate(trimmed, 300)
}

func modelClient(ep: ModelEndpoint, readMinutes: Int64): Client {
    let builder = ClientBuilder()
    if (!ep.isPlainHttp()) {
        // 必须显式给 SNI，否则多数云厂商会以 internal error 拒绝握手；
        // 默认走 HTTP/2，这里锁 HTTP/1.1，长请求更稳。
        var tls = TlsClientConfig()
        tls.serverName = Some(modelHostOf(ep.baseUrl))
        tls.supportedAlpnProtocols = ["http/1.1"]
        builder.tlsConfig(tls)
    }
    builder.readTimeout(Duration.minute * readMinutes).writeTimeout(Duration.minute * readMinutes)
    builder.build()
}

func httpPostJson(ep: ModelEndpoint, path: String, payload: String, readMinutes: Int64): String {
    let url = ep.url(path)
    let client = modelClient(ep, readMinutes)
    try {
        let request = HttpRequestBuilder()
            .method("POST")
            .url(url)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + ep.apiKey)
            .header("Accept", "application/json")
            .body(payload)
            .build()
        let response = client.send(request)
        let text = readStreamText(response.body)
        if (response.status != 200) {
            throw Exception("模型接口返回 " + response.status.toString() + "：" + briefBody(text))
        }
        text
    } finally {
        try { client.close() } catch (_: Exception) {}
    }
}

/** 把嵌入响应解析成向量数组；顺序与输入一致。 */
func parseEmbeddingArray(text: String): Array<Array<Float64>> {
    parseEmbeddingArray(text, -1)
}

func parseEmbeddingArray(text: String, expectedCount: Int64): Array<Array<Float64>> {
    let root = match (jsonParse(text)) {
        case Some(value) => value
        case None => throw Exception("嵌入接口返回的不是合法 JSON")
    }
    let object = match (root.kind()) {
        case JsonKind.JsObject => root.asObject()
        case _ => throw Exception("嵌入接口返回的顶层不是对象")
    }
    let data = match (jsonGetArray(object, "data")) {
        case Some(list) => list
        case None => throw Exception("嵌入接口没有返回 data 数组")
    }
    if (data.size() == 0) { throw Exception("嵌入接口没有返回任何向量") }
    if (expectedCount >= 0 && data.size() != expectedCount) { throw Exception("嵌入向量数量与输入数量不一致") }
    let out = Array<Array<Float64>>(data.size(), repeat: Array<Float64>(0, repeat: 0.0))
    let seen = Array<Bool>(data.size(), repeat: false)
    var dimension: Int64 = -1
    var i: Int64 = 0
    while (i < data.size()) {
        let item = data[i]
        let row = match (item.kind()) {
            case JsonKind.JsObject => item.asObject()
            case _ => throw Exception("嵌入 data 条目不是对象")
        }
        let indexValue = match (row.get("index")) {
            case Some(value) => value
            case None => throw Exception("嵌入向量缺少 index")
        }
        let index = match (indexValue.kind()) {
            case JsonKind.JsInt => indexValue.asInt().getValue()
            case _ => throw Exception("嵌入 index 必须是整数")
        }
        if (index < 0 || index >= data.size() || seen[index]) { throw Exception("嵌入 index 重复或超出输入范围") }
        let values = match (jsonGetArray(row, "embedding")) {
            case Some(value) => value
            case None => throw Exception("嵌入向量缺少 embedding 数组")
        }
        if (values.size() == 0) { throw Exception("嵌入向量为空") }
        if (dimension < 0) { dimension = values.size() }
        if (values.size() != dimension) { throw Exception("同批嵌入向量维度不一致") }
        let vec = Array<Float64>(values.size(), repeat: 0.0)
        var nonzero = false
        var k: Int64 = 0
        while (k < values.size()) {
            let value = match (values[k].kind()) {
                case JsonKind.JsFloat => values[k].asFloat().getValue()
                case JsonKind.JsInt => Float64(values[k].asInt().getValue())
                case _ => throw Exception("嵌入向量包含非数值")
            }
            if (value != value || value > 1.7976931348623157e308 || value < -1.7976931348623157e308) {
                throw Exception("嵌入向量包含非有限数值")
            }
            if (value != 0.0) { nonzero = true }
            vec[k] = value
            k += 1
        }
        if (!nonzero) { throw Exception("嵌入向量不能全为零") }
        out[index] = vec
        seen[index] = true
        i += 1
    }
    for (visited in seen) { if (!visited) { throw Exception("嵌入响应缺少输入的向量") } }
    out
}

/** 调 /embeddings。provider 不支持时抛出带说明的异常，由调用方决定是否降级。 */
func embedTexts(ep: ModelEndpoint, inputs: Array<String>): Array<Array<Float64>> {
    if (!ep.hasEmbedding()) {
        throw Exception("还没有配置向量模型")
    }
    if (inputs.size == 0) { throw Exception("嵌入输入不能为空") }
    let list = JsonArrWriter()
    for (input in inputs) { list.addRaw(jsonQuote(input)) }
    let payload = JsonWriter()
    payload.putStr("model", ep.embeddingModel)
    payload.putRaw("input", list.toJson())
    let text = httpPostJson(ep, "/embeddings", payload.toJson(), 2)
    parseEmbeddingArray(text, inputs.size)
}

/** Only bare JSON or one complete JSON Markdown fence is accepted. */
func kbParseChatJson(content: String): JsonObject {
    var text = content.trimAscii()
    if (text.startsWith("```")) {
        let newline = match (text.indexOf("\n")) {
            case Some(index) => index
            case None => throw Exception("模型 JSON 代码围栏不完整")
        }
        let label = text[3..newline].trimAscii().toAsciiLower()
        if (label.size > 0 && label != "json") { throw Exception("模型返回的代码围栏不是 JSON") }
        if (!text.endsWith("```")) { throw Exception("模型 JSON 代码围栏未闭合") }
        text = text[newline + 1..text.size - 3].trimAscii()
    }
    let value = match (jsonParse(text)) {
        case Some(parsed) => parsed
        case None => throw Exception("模型没有返回有效 JSON 对象：" + briefBody(text))
    }
    match (value.kind()) {
        case JsonKind.JsObject => value.asObject()
        case _ => throw Exception("模型 JSON 顶层必须是对象")
    }
}

/** A real non-streaming JSON conversation without provider-specific response_format. */
func kbChatJson(ep: ModelEndpoint, system: String, user: String): JsonObject {
    if (!ep.hasChat()) { throw Exception("还没有配置对话模型") }
    let messages = JsonArrWriter()
    let systemMessage = JsonWriter()
    systemMessage.putStr("role", "system")
    systemMessage.putStr("content", system + "\n只返回一个合法 JSON 对象，不要解释。")
    messages.addRaw(systemMessage.toJson())
    let userMessage = JsonWriter()
    userMessage.putStr("role", "user")
    userMessage.putStr("content", user)
    messages.addRaw(userMessage.toJson())
    let payload = JsonWriter()
    payload.putStr("model", ep.chatModel)
    payload.putRaw("messages", messages.toJson())
    payload.putBool("stream", false)
    let response = match (jsonParse(httpPostJson(ep, "/chat/completions", payload.toJson(), 3))) {
        case Some(value) => value
        case None => throw Exception("模型接口响应不是有效 JSON")
    }
    let root = match (response.kind()) {
        case JsonKind.JsObject => response.asObject()
        case _ => throw Exception("模型接口响应顶层必须是对象")
    }
    let choices = match (jsonGetArray(root, "choices")) {
        case Some(value) => value
        case None => throw Exception("模型接口响应缺少 choices")
    }
    if (choices.size() == 0) { throw Exception("模型接口返回空 choices") }
    let first = match (choices[0].kind()) {
        case JsonKind.JsObject => choices[0].asObject()
        case _ => throw Exception("模型 choices 结构不正确")
    }
    let message = match (jsonGetObject(first, "message")) {
        case Some(value) => value
        case None => throw Exception("模型接口响应缺少 message")
    }
    let content = match (message.get("content")) {
        case Some(value) => match (value.kind()) {
            case JsonKind.JsString => value.asString().getValue()
            case _ => throw Exception("模型 message.content 必须是字符串")
        }
        case None => throw Exception("模型接口响应缺少 content")
    }
    kbParseChatJson(content)
}

/** 流式对话：每收到一段正文回调一次，返回完整文本。 */
func chatStreamText(ep: ModelEndpoint, messagesJson: String, temperature: Float64, onDelta: (String) -> Unit): String {
    if (!ep.hasChat()) {
        throw Exception("还没有配置对话模型")
    }
    let payload = JsonWriter()
    payload.putStr("model", ep.chatModel)
    payload.putRaw("messages", messagesJson)
    payload.putFloat("temperature", temperature)
    payload.putBool("stream", true)
    let url = ep.url("/chat/completions")
    let client = modelClient(ep, 10)
    try {
        let request = HttpRequestBuilder()
            .method("POST")
            .url(url)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + ep.apiKey)
            .header("Accept", "text/event-stream")
            .body(payload.toJson())
            .build()
        let response = client.send(request)
        if (response.status != 200) {
            let body = readStreamText(response.body)
            throw Exception("模型接口返回 " + response.status.toString() + "：" + briefBody(body))
        }
        readSseStream(response.body, onDelta)
    } finally {
        try { client.close() } catch (_: Exception) {}
    }
}

func sseDeltaOf(line: String): String {
    let trimmed = line.trimAscii()
    if (!trimmed.startsWith("data:")) { return "" }
    let data = trimmed[5..trimmed.size].trimAscii()
    if (data.size == 0 || data == "[DONE]") { return "" }
    let root = match (jsonParse(data)) {
        case Some(value) => value
        case None => return ""
    }
    let object = match (root.kind()) {
        case JsonKind.JsObject => root.asObject()
        case _ => return ""
    }
    let choices = match (jsonGetArray(object, "choices")) {
        case Some(list) => list
        case None => return ""
    }
    if (choices.size() == 0) { return "" }
    let first = choices[0]
    match (first.kind()) {
        case JsonKind.JsObject => ()
        case _ => return ""
    }
    let choice = first.asObject()
    let delta = match (jsonGetObject(choice, "delta")) {
        case Some(value) => value
        case None => return ""
    }
    jsonGetString(delta, "content") ?? ""
}

func readSseStream(input: InputStream, onDelta: (String) -> Unit): String {
    let text = StringBuilder()
    let pending = ArrayList<UInt8>()
    let buffer = Array<UInt8>(4096, repeat: 0)
    while (true) {
        let n = input.read(buffer)
        if (n <= 0) { break }
        var i: Int64 = 0
        while (i < n) {
            if (Int64(buffer[i]) == 10) {
                let piece = sseDeltaOf(safeUtf8(pending.toArray()))
                if (piece.size > 0) {
                    text.append(piece)
                    onDelta(piece)
                }
                pending.clear()
            } else {
                pending.add(buffer[i])
            }
            i += 1
        }
    }
    if (pending.size > 0) {
        let piece = sseDeltaOf(safeUtf8(pending.toArray()))
        if (piece.size > 0) {
            text.append(piece)
            onDelta(piece)
        }
    }
    text.toString()
}

/** 语音合成连通性检查：只关心 HTTP 状态，不解析音频。 */
func ttsCheck(ep: ModelEndpoint, voice: String, text: String, speechPath: String): Int64 {
    let payload = JsonWriter()
    payload.putStr("model", ep.chatModel)
    payload.putStr("voice", if (voice.size == 0) { "alloy" } else { voice })
    payload.putStr("input", text)
    payload.putStr("response_format", "mp3")
    let pathValue = if (speechPath.size == 0) { "/audio/speech" } else if (speechPath.startsWith("/")) { speechPath } else { "/" + speechPath }
    let url = ep.url(pathValue)
    let client = modelClient(ep, 2)
    try {
        let request = HttpRequestBuilder()
            .method("POST")
            .url(url)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + ep.apiKey)
            .body(payload.toJson())
            .build()
        let response = client.send(request)
        // 读掉响应体，避免连接挂住。
        let drained = readStreamText(response.body)
        if (response.status != 200) {
            throw Exception(url + " 返回 " + response.status.toString() + "：" + briefBody(drained))
        }
        Int64(response.status)
    } finally {
        try { client.close() } catch (_: Exception) {}
    }
}
/* ---------- 带工具调用的对话（非流式） ---------- */

class ToolCall {
    let id: String
    let name: String
    let arguments: String

    init(id: String, name: String, arguments: String) {
        this.id = id
        this.name = name
        this.arguments = arguments
    }
}

class ChatTurn {
    let content: String
    let calls: ArrayList<ToolCall>

    init(content: String, calls: ArrayList<ToolCall>) {
        this.content = content
        this.calls = calls
    }
}

/**
 * 一次非流式对话，允许模型返回 tool_calls。
 * Agent 循环需要完整的工具调用列表，流式反而更难解析，所以这里用非流式。
 */
func chatWithTools(ep: ModelEndpoint, messagesJson: String, toolsJson: String): ChatTurn {
    let payload = JsonWriter()
    payload.putStr("model", ep.chatModel)
    payload.putRaw("messages", messagesJson)
    payload.putRaw("tools", toolsJson)
    payload.putStr("tool_choice", "auto")
    payload.putBool("stream", false)
    let text = httpPostJson(ep, "/chat/completions", payload.toJson(), 3)
    let root = match (jsonParse(text)) {
        case Some(value) => value
        case None => throw Exception("模型返回的不是合法 JSON")
    }
    let object = match (root.kind()) {
        case JsonKind.JsObject => root.asObject()
        case _ => throw Exception("模型返回的顶层不是对象")
    }
    let choices = match (jsonGetArray(object, "choices")) {
        case Some(list) => list
        case None => throw Exception("模型返回缺少 choices")
    }
    if (choices.size() == 0) { throw Exception("模型返回了空的 choices") }
    let first = choices[0]
    let choice = match (first.kind()) {
        case JsonKind.JsObject => first.asObject()
        case _ => throw Exception("choices 结构不正确")
    }
    let message = match (jsonGetObject(choice, "message")) {
        case Some(value) => value
        case None => throw Exception("模型返回缺少 message")
    }
    let content = jsonGetString(message, "content") ?? ""
    let calls = ArrayList<ToolCall>()
    match (jsonGetArray(message, "tool_calls")) {
        case Some(list) =>
            var i: Int64 = 0
            while (i < list.size()) {
                let item = list[i]
                match (item.kind()) {
                    case JsonKind.JsObject =>
                        let call = item.asObject()
                        let id = jsonGetString(call, "id") ?? ""
                        var name = ""
                        var arguments = ""
                        match (jsonGetObject(call, "function")) {
                            case Some(function) =>
                                name = jsonGetString(function, "name") ?? ""
                                arguments = jsonGetString(function, "arguments") ?? ""
                            case None => ()
                        }
                        if (id.size > 0 && name.size > 0) { calls.add(ToolCall(id, name, arguments)) }
                    case _ => ()
                }
                i += 1
            }
        case None => ()
    }
    ChatTurn(content, calls)
}

/** 非流式纯文本对话：结构化内容（JSON）生成用，避免 SSE 解析干扰。 */
func chatPlain(ep: ModelEndpoint, systemPrompt: String, userPrompt: String, temperature: Float64): String {
    if (!ep.hasChat()) { throw Exception("还没有配置对话模型") }
    let messages = JsonArrWriter()
    let systemPart = JsonWriter()
    systemPart.putStr("role", "system")
    systemPart.putStr("content", systemPrompt)
    messages.addRaw(systemPart.toJson())
    let userPart = JsonWriter()
    userPart.putStr("role", "user")
    userPart.putStr("content", userPrompt)
    messages.addRaw(userPart.toJson())
    let payload = JsonWriter()
    payload.putStr("model", ep.chatModel)
    payload.putRaw("messages", messages.toJson())
    payload.putFloat("temperature", temperature)
    payload.putBool("stream", false)
    let text = httpPostJson(ep, "/chat/completions", payload.toJson(), 3)
    let root = match (jsonParse(text)) {
        case Some(value) => value
        case None => throw Exception("模型返回的不是合法 JSON")
    }
    let object = match (root.kind()) {
        case JsonKind.JsObject => root.asObject()
        case _ => throw Exception("模型返回的顶层不是对象")
    }
    let choices = match (jsonGetArray(object, "choices")) {
        case Some(list) => list
        case None => throw Exception("模型返回缺少 choices")
    }
    if (choices.size() == 0) { throw Exception("模型返回了空的 choices") }
    let first = choices[0]
    let choice = match (first.kind()) {
        case JsonKind.JsObject => first.asObject()
        case _ => throw Exception("choices 结构不正确")
    }
    let message = match (jsonGetObject(choice, "message")) {
        case Some(value) => value
        case None => throw Exception("模型返回缺少 message")
    }
    jsonGetString(message, "content") ?? ""
}
