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
        let client = ClientBuilder().tlsConfig(tls).build()
        try {
            let req = HttpRequestBuilder()
                .method("POST")
                .url(url)
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + cfg.apiKey)
                .header("Accept", "application/json")
                .body(payload.toString())
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
        let payload = JsonObject()
        payload.put("model", JsonString(modelName()))
        payload.put("messages", messages)
        payload.put("temperature", JsonFloat(0.3))
        let result = postJson("/chat/completions", payload)
        let content = pickStr(result, ["choices", "0", "message", "content"])
        if (content.size == 0) {
            throw LlmException("模型返回内容为空：" + result.toString())
        }
        return content
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
        let result = postJson("/chat/completions", payload)
        return pickStr(result, ["choices", "0", "message", "content"])
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
