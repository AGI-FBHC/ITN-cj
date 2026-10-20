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
    String.fromUtf8(out.toArray())
}

func briefBody(text: String): String {
    let trimmed = text.trimAscii()
    if (trimmed.size <= 300) { return trimmed }
    trimmed[0..300] + "…"
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
    let out = ArrayList<Array<Float64>>()
    var i: Int64 = 0
    while (i < data.size()) {
        let item = data[i]
        match (item.kind()) {
            case JsonKind.JsObject =>
                let row = item.asObject()
                match (jsonGetArray(row, "embedding")) {
                    case Some(values) =>
                        let vec = Array<Float64>(values.size(), repeat: 0.0)
                        var k: Int64 = 0
                        while (k < values.size()) {
                            match (values[k].kind()) {
                                case JsonKind.JsFloat => vec[k] = values[k].asFloat().getValue()
                                case JsonKind.JsInt => vec[k] = Float64(values[k].asInt().getValue())
                                case _ => vec[k] = 0.0
                            }
                            k += 1
                        }
                        if (vec.size > 0) { out.add(vec) }
                    case None => ()
                }
            case _ => ()
        }
        i += 1
    }
    if (out.size == 0) {
        throw Exception("嵌入接口没有返回任何向量")
    }
    out.toArray()
}

/** 调 /embeddings。provider 不支持时抛出带说明的异常，由调用方决定是否降级。 */
func embedTexts(ep: ModelEndpoint, inputs: Array<String>): Array<Array<Float64>> {
    if (!ep.hasEmbedding()) {
        throw Exception("还没有配置向量模型")
    }
    let list = JsonArrWriter()
    for (input in inputs) { list.addRaw(jsonQuote(input)) }
    let payload = JsonWriter()
    payload.putStr("model", ep.embeddingModel)
    payload.putRaw("input", list.toJson())
    let text = httpPostJson(ep, "/embeddings", payload.toJson(), 2)
    parseEmbeddingArray(text)
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
                let piece = sseDeltaOf(String.fromUtf8(pending.toArray()))
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
        let piece = sseDeltaOf(String.fromUtf8(pending.toArray()))
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