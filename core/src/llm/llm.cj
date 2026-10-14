package itn_desktop_core.llm

import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import std.collection.*
import std.io.*
import std.convert.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.util.*

public class LlmException <: Exception {
    public init(message: String) {
        super(message)
    }
}

func trimTrailingSlash(s: String): String {
    let arr = s.toArray()
    var n = arr.size
    while (n > 0 && arr[n - 1] == 47) {
        n = n - 1
    }
    if (n == arr.size) {
        return s
    }
    return String.fromUtf8(arr[0..n])
}

// 按路径取值：对象按 key，数组按下标（十进制字符串）
public func pick(v: JsonValue, path: Array<String>): ?JsonValue {
    var cur = v
    for (key in path) {
        match (cur) {
            case o: JsonObject =>
                match (o.get(key)) {
                    case Some(nx) => cur = nx
                    case None => return None
                }
            case a: JsonArray =>
                var idx: Int64 = -1
                try {
                    idx = Int64.parse(key)
                } catch (e: Exception) {
                    return None
                }
                if (idx < 0 || idx >= a.size()) {
                    return None
                }
                cur = a[idx]
            case _ => return None
        }
    }
    return Some(cur)
}

public func pickStr(v: JsonValue, path: Array<String>): String {
    match (pick(v, path)) {
        case Some(x) => strValue(x)
        case None => ""
    }
}

public class LlmClient {
    public let cfg: ModelConfig

    public init(cfg: ModelConfig) {
        this.cfg = cfg
    }

    public func endpoint(path: String): String {
        return trimTrailingSlash(cfg.baseUrl) + path
    }

    func postJson(path: String, payload: JsonValue): JsonValue {
        let url = endpoint(path)
        // 必须显式设置 SNI：仓颉的 HTTP 客户端不会自动把请求域名带入 TLS 握手，
        // 缺少 SNI 时多数云厂商会直接以 internal error 拒绝握手。
        var tls = TlsClientConfig()
        tls.serverName = Some(hostOf(url))
        // 默认走 HTTP/2，长生成请求在部分服务端会被提前断开；实测 HTTP/1.1 稳定。
        tls.supportedAlpnProtocols = ["http/1.1"]
        // 默认读写超时只有十几秒，真实模型写一整节内容远超这个时间；
        // mock 是瞬时返回的，这个差异只有在真实模型上才会暴露。
        let client = ClientBuilder()
            .tlsConfig(tls)
            .readTimeout(Duration.minute * 10)
            .writeTimeout(Duration.minute * 10)
            .build()
        try {
            let req = HttpRequestBuilder()
                .method("POST")
                .url(url)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + cfg.apiKey)
                .header("Accept", "application/json")
                .body(payload.toString())
                .readTimeout(Duration.minute * 10)
                .build()
            let resp = client.send(req)
            let text = readAllString(resp.body)
            let status = resp.status
            if (status != 200) {
                throw LlmException("模型接口返回 " + status.toString() + "：" + text)
            }
            return JsonValue.fromStr(text)
        } catch (e: LlmException) {
            throw e
        } catch (e: Exception) {
            throw LlmException("请求模型失败：" + e.message)
        } finally {
            client.close()
        }
    }

    /** 流式请求：逐块读取 SSE，累积正文后返回。
        长生成如果用非流式，服务端不刷新响应体会让单次读阻塞过久而被断开；
        改流式后数据持续到达，读不再长时间阻塞。 */
    /** 不带回调的流式请求：只为兼容旧调用点。 */
    func postStream(path: String, payload: JsonValue): String {
        return postStream(path, payload, { piece: String => () })
    }

    /**
     * 流式请求。每收到一段正文就回调一次 onDelta，界面靠它做"打字机"输出。
     * 之所以要回调而不是等整段返回：真模型一段几千字要等几十秒，用户看不到任何进展。
     */
    func postStream(path: String, payload: JsonValue, onDelta: (String) -> Unit): String {
        let url = endpoint(path)
        var tls = TlsClientConfig()
        tls.serverName = Some(hostOf(url))
        tls.supportedAlpnProtocols = ["http/1.1"]
        let client = ClientBuilder()
            .tlsConfig(tls)
            .readTimeout(Duration.minute * 10)
            .writeTimeout(Duration.minute * 10)
            .build()
        var stage = "构造请求"
        try {
            let req = HttpRequestBuilder()
                .method("POST")
                .url(url)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + cfg.apiKey)
                .header("Accept", "text/event-stream")
                .body(payload.toString())
                .build()
            stage = "发送请求"
            let resp = client.send(req)
            stage = "读取状态"
            let st = resp.status
            if (st != 200) {
                throw LlmException("模型接口返回 " + st.toString() + "：" + readAllString(resp.body))
            }
            stage = "读取响应体"
            return readSse(resp.body, onDelta)
        } catch (e: LlmException) {
            throw e
        } catch (e: Exception) {
            throw LlmException("请求模型失败（" + stage + " 阶段）：" + e.message)
        } finally {
            client.close()
        }
    }

    public func modelName(): String {
        if (cfg.model.size > 0) {
            return cfg.model
        }
        return cfg.name
    }

    /** 纯文本对话，非流式，返回助手正文。 */
    public func chat(systemPrompt: String, userPrompt: String): String {
        let msgs = JsonArray()
        if (systemPrompt.size > 0) {
            let sys = JsonObject()
            sys.put("role", JsonString("system"))
            sys.put("content", JsonString(systemPrompt))
            msgs.add(sys)
        }
        let usr = JsonObject()
        usr.put("role", JsonString("user"))
        usr.put("content", JsonString(userPrompt))
        msgs.add(usr)
        return chatMessages(msgs)
    }

    public func chatMessages(messages: JsonArray): String {
        return chatMessagesStream(messages, { piece: String => () })
    }

    /** 带增量回调的多轮对话：messages 可以含历史轮次与工具结果。 */
    public func chatMessagesStream(messages: JsonArray, onDelta: (String) -> Unit): String {
        let payload = JsonObject()
        payload.put("model", JsonString(modelName()))
        payload.put("messages", messages)
        payload.put("temperature", JsonFloat(0.3))
        payload.put("stream", JsonBool(true))
        let content = postStream("/chat/completions", payload, onDelta)
        if (content.size == 0) {
            throw LlmException("模型返回内容为空")
        }
        return content
    }

    /** 单轮对话的流式版本。 */
    public func chatStream(systemPrompt: String, userPrompt: String, onDelta: (String) -> Unit): String {
        let msgs = JsonArray()
        if (systemPrompt.size > 0) {
            let sys = JsonObject()
            sys.put("role", JsonString("system"))
            sys.put("content", JsonString(systemPrompt))
            msgs.add(sys)
        }
        let usr = JsonObject()
        usr.put("role", JsonString("user"))
        usr.put("content", JsonString(userPrompt))
        msgs.add(usr)
        return chatMessagesStream(msgs, onDelta)
    }

    /** 多模态对话：一张图加一段提示词，返回模型描述。 */
    public func chatVision(model: String, prompt: String, imageDataUrl: String): String {
        let textPart = JsonObject()
        textPart.put("type", JsonString("text"))
        textPart.put("text", JsonString(prompt))
        let urlObj = JsonObject()
        urlObj.put("url", JsonString(imageDataUrl))
        let imgPart = JsonObject()
        imgPart.put("type", JsonString("image_url"))
        imgPart.put("image_url", urlObj)
        let contentArr = JsonArray()
        contentArr.add(textPart)
        contentArr.add(imgPart)
        let usr = JsonObject()
        usr.put("role", JsonString("user"))
        usr.put("content", contentArr)
        let msgs = JsonArray()
        msgs.add(usr)
        let payload = JsonObject()
        payload.put("model", JsonString(model))
        payload.put("messages", msgs)
        return postStream("/chat/completions", payload)
    }

    /** 向量化。返回与输入等长的向量数组。 */
    public func embed(inputs: Array<String>): Array<Array<Float64>> {
        let name = if (cfg.embeddingModel.size > 0) { cfg.embeddingModel } else { cfg.model }
        let arr = JsonArray()
        for (s in inputs) {
            arr.add(JsonString(s))
        }
        let payload = JsonObject()
        payload.put("model", JsonString(name))
        payload.put("input", arr)
        var result: JsonValue = JsonNull()
        try {
            result = postJson("/embeddings", payload)
        } catch (e: LlmException) {
            // 不少对话类服务不提供向量接口，这里给出明确指引而不是抛原始 HTML
            throw LlmException(e.message + "；若返回 404，说明该服务未提供 /embeddings 接口，请为「向量」用途单独绑定一个支持向量化的模型")
        }
        let out = ArrayList<Array<Float64>>()
        match (pick(result, ["data"])) {
            case Some(dv) =>
                match (dv) {
                    case da: JsonArray =>
                        var i = 0
                        while (i < da.size()) {
                            match (pick(da[i], ["embedding"])) {
                                case Some(ev) =>
                                    match (ev) {
                                        case ea: JsonArray =>
                                            let vec = Array<Float64>(ea.size(), repeat: 0.0)
                                            var k = 0
                                            while (k < ea.size()) {
                                                match (ea[k]) {
                                                    case f: JsonFloat => vec[k] = f.getValue()
                                                    case j: JsonInt => vec[k] = Float64(j.getValue())
                                                    case _ => vec[k] = 0.0
                                                }
                                                k = k + 1
                                            }
                                            out.add(vec)
                                        case _ => ()
                                    }
                                case None => ()
                            }
                            i = i + 1
                        }
                    case _ => ()
                }
            case None => ()
        }
        if (out.size != inputs.size) {
            throw LlmException("向量数量与输入不一致")
        }
        return out.toArray()
    }

    /** 连通性自检：发一条最小请求。 */
    public func selfTest(): String {
        let reply = chat("你是一个连通性测试助手。", "只回复两个字：可用")
        return reply
    }
}

// ---------- 流式响应解析 ----------

func handleSseLine(line: String, out: StringBuilder, onDelta: (String) -> Unit): Unit {
    if (!hasPrefix(line, "data:")) {
        return
    }
    let b = line.toArray()
    let data = trimStr(String.fromUtf8(b[5..b.size]))
    if (data.size == 0 || data == "[DONE]") {
        return
    }
    try {
        let v = JsonValue.fromStr(data)
        // 多数服务端用 delta.content 增量；也有服务端对流式请求仍回整体 message.content
        var piece = pickStr(v, ["choices", "0", "delta", "content"])
        if (piece.size == 0) {
            piece = pickStr(v, ["choices", "0", "message", "content"])
        }
        out.append(piece)
        if (piece.size > 0) {
            onDelta(piece)
        }
    } catch (e: Exception) {
        // 单行解析失败不影响整体
        ()
    }
}

func readSse(input: InputStream): String {
    return readSse(input, { piece: String => () })
}

func readSse(input: InputStream, onDelta: (String) -> Unit): String {
    let out = StringBuilder()
    // 整包字节先攒着：以前是每读一段就 String.fromUtf8(一段)，
    // 一旦某个汉字被切在两次 read 中间就直接抛 Invalid utf8。
    let raw = ArrayList<UInt8>()
    let buf = Array<UInt8>(4096, repeat: 0)
    var pending = ArrayList<UInt8>()
    while (true) {
        let n = input.read(buf)
        if (n <= 0) {
            break
        }
        var ri = 0
        while (ri < n) {
            raw.add(buf[ri])
            ri = ri + 1
        }
        var i = 0
        while (i < n) {
            if (buf[i] == 10) {
                handleSseLine(trimStr(String.fromUtf8(pending.toArray())), out, onDelta)
                pending = ArrayList<UInt8>()
            } else {
                pending.add(buf[i])
            }
            i = i + 1
        }
    }
    if (pending.size > 0) {
        handleSseLine(trimStr(String.fromUtf8(pending.toArray())), out, onDelta)
    }
    if (out.toString().size > 0) {
        return out.toString()
    }
    // 服务端忽略了 stream 参数，直接回了完整 JSON
    try {
        let v = JsonValue.fromStr(trimStr(String.fromUtf8(raw.toArray())))
        var content = pickStr(v, ["choices", "0", "message", "content"])
        if (content.size == 0) {
            content = pickStr(v, ["choices", "0", "delta", "content"])
        }
        return content
    } catch (e: Exception) {
        return out.toString()
    }
}

// ---------- 端点诊断 ----------
// 不同服务端的 TLS 配置差异较大，这里逐个尝试常见的协商参数，
// 报告哪种组合能完成握手。分类只依据"是否拿到 HTTP 响应"，不判断业务是否成功。

func hostOf(url: String): String {
    let b = url.toArray()
    var i = 0
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
    return String.fromUtf8(b[start..end])
}

func tryTlsMode(url: String, apiKey: String, mode: String): String {
    try {
        var tls = TlsClientConfig()
        if (mode == "TLS1.2") {
            tls.supportedVersions = [TlsVersion.V1_2]
        } else if (mode == "TLS1.3") {
            tls.supportedVersions = [TlsVersion.V1_3]
        } else if (mode == "安全级别1") {
            tls.securityLevel = 1
        } else if (mode == "安全级别0") {
            tls.securityLevel = 0
        } else if (mode == "ALPN http/1.1") {
            tls.supportedAlpnProtocols = ["http/1.1"]
        } else if (mode == "TLS1.2+级别1") {
            tls.supportedVersions = [TlsVersion.V1_2]
            tls.securityLevel = 1
        } else if (mode == "指定SNI") {
            tls.serverName = Some(hostOf(url))
        } else if (mode == "指定SNI+TLS1.2") {
            tls.serverName = Some(hostOf(url))
            tls.supportedVersions = [TlsVersion.V1_2]
        } else if (mode == "指定SNI+级别1") {
            tls.serverName = Some(hostOf(url))
            tls.securityLevel = 1
        }
        let client = ClientBuilder().tlsConfig(tls).build()
        try {
            let req = HttpRequestBuilder()
                .method("POST")
                .url(url)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + apiKey)
                .body("{}")
                .build()
            let resp = client.send(req)
            let st = resp.status
            return "HTTP " + st.toString()
        } finally {
            client.close()
        }
    } catch (e: Exception) {
        return "失败：" + e.message
    }
}

public func tlsProbe(url: String, apiKey: String): JsonArray {
    let modes = ["默认", "指定SNI", "指定SNI+TLS1.2", "指定SNI+级别1", "ALPN http/1.1", "安全级别0"]
    let out = JsonArray()
    for (m in modes) {
        let o = JsonObject()
        o.put("mode", JsonString(m))
        o.put("result", JsonString(tryTlsMode(url, apiKey, m)))
        out.add(o)
    }
    return out
}
