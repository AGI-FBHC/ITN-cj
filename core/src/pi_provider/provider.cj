package itn_desktop_core.pi_provider

import std.collection.*
import std.convert.*
import std.io.*
import std.time.*
import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import stdx.encoding.json.*
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.util.trimStr
import itn_desktop_core.util.hasPrefix
import itn_desktop_core.util.byteSafePrefix
import itn_desktop_core.util.readAllString
import itn_desktop_core.llm.pick
import itn_desktop_core.llm.pickStr
import itn_desktop_core.pi.ChatProvider
import itn_desktop_core.pi.StepContext
import itn_desktop_core.pi.EventStream
import itn_desktop_core.pi.ModelReply
import itn_desktop_core.pi.ToolCallBlock
import itn_desktop_core.pi.ToolSpec
import itn_desktop_core.pi.Message
import itn_desktop_core.pi.MsgRole
import itn_desktop_core.pi.objOf
import itn_desktop_core.pi.PartialJsonParser
import itn_desktop_core.pi.evMessageUpdate
import itn_desktop_core.pi.deltaThinkingDelta
import itn_desktop_core.pi.deltaTextDelta
import itn_desktop_core.pi.deltaToolCallStart
import itn_desktop_core.pi.deltaToolCallDelta

/**
 * 模型通信层：把内核已有的 OpenAI 兼容调用接到 pi-cj 的 `ChatProvider` 上。
 *
 * 为什么单独一个包、还用"逐个具名 import"：pi 那个包里有一批和 util 同名的工具函数
 * （`hasPrefix`/`byteSafePrefix`/`intOf`…），两边都 `.*` 通配导入会撞成歧义。
 * 具名导入既避开歧义，也把"这个文件到底依赖 pi 的什么"写在明面上。
 *
 * 契约照 Pi（也是 pi-cj 的约定）：
 *  - 自己把 `text_delta` / `thinking_delta` / `toolcall_delta` 推进事件流；
 *  - **失败不抛**：填 `stopReason="error"` + `errorMessage`，由主循环转成一轮失败；
 *  - 工具参数是半截 JSON 流式到达，边到边解析，最后塞进 `ToolCallBlock.argsJson`。
 *
 * 重试：只在"一个事件都还没推出去"时重试 429/5xx（推过一半再重试会让正文重复）。
 */
/** 用户按了停止：只在本文件内部用，用来把"读流"这件事干净地掐掉。 */
class AbortedByUser <: Exception {
    public init() {
        super("用户停止")
    }
}

public class OpenAiChatProvider <: ChatProvider {
    private let baseUrl: String
    private let apiKey: String
    private let defaultModel: String
    public var maxAttempts: Int64 = 3
    /** 上一次请求耗时（毫秒），给界面显示"模型用了多久"。 */
    public var lastMillis: Int64 = 0
    public var lastFinish: String = ""
    /**
     * "要不要停下"的钩子（界面上按了停止就返回 true）。
     *
     * 为什么放在 provider 里：pi 的 abort 只在"下一轮请求之前"生效，而一次长回答往往就一轮 ——
     * 那样停止按钮等于摆设。这里在**流式增量之间**问一句，用户按了就走。
     * 已经吐出去的正文保留（界面照样能看到），只是不再继续读、也不再开下一轮。
     */
    public var shouldAbort: ?() -> Bool = None

    public init(cfg: ModelConfig) {
        var base = cfg.baseUrl
        while (base.size > 0 && base.toArray()[base.size - 1] == 47) {
            base = String.fromUtf8(base.toArray()[0..(base.size - 1)])
        }
        this.baseUrl = base
        this.apiKey = cfg.apiKey
        this.defaultModel = cfg.model
    }

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        let model = if (ctx.model.size > 0) { ctx.model } else { defaultModel }
        let payload = JsonObject()
        payload.put("model", JsonString(model))
        let msgs = JsonArray()
        if (ctx.system.size > 0) {
            let sys = JsonObject()
            sys.put("role", JsonString("system"))
            sys.put("content", JsonString(ctx.system))
            msgs.add(sys)
        }
        for (m in ctx.messages) {
            msgs.add(m.toChatJson())
        }
        payload.put("messages", msgs)
        payload.put("temperature", JsonFloat(0.3))
        payload.put("stream", JsonBool(true))
        payload.put("max_tokens", JsonInt(8192))
        if (ctx.tools.size > 0) {
            payload.put("tools", toolsPayload(ctx.tools))
            payload.put("tool_choice", JsonString("auto"))
        }

        let acc = StreamAcc()
        let started = DateTime.now()
        let err = postSse("/chat/completions", payload, { obj: JsonObject => handleChunk(obj, acc, stream) })
        lastMillis = (DateTime.now() - started).toMilliseconds()
        lastFinish = acc.finishReason

        let reply = ModelReply()
        if (err.size > 0) {
            reply.stopReason = "error"
            reply.errorMessage = err
            return reply
        }
        reply.text = acc.text.toString()
        reply.thinking = acc.reasoning.toString()
        reply.usageIn = acc.promptTokens
        reply.usageOut = acc.completionTokens
        for (call in acc.calls) {
            if (call.name.size > 0) {
                reply.toolCalls.add(ToolCallBlock(call.id, call.name, normalizeArgs(call.args.toString())))
            }
        }
        if (acc.finishReason == "length") {
            reply.stopReason = "length"
        } else if (reply.toolCalls.size > 0) {
            reply.stopReason = "toolUse"
        } else {
            reply.stopReason = "stop"
        }
        return reply
    }

    private func postSse(path: String, payload: JsonValue, onChunk: (JsonObject) -> Unit): String {
        let url = baseUrl + path
        let state = RetryState()
        var attempt: Int64 = 0
        var lastMsg = ""
        while (attempt < maxAttempts) {
            attempt = attempt + 1
            let r = oneShot(url, payload, onChunk, state)
            if (r.ok) {
                return ""
            }
            lastMsg = r.msg
            if (!r.retryable || state.emitted > 0 || attempt >= maxAttempts) {
                break
            }
            // 套餐限流会回 429：退避重试，但只在还没推过事件时
            sleep(Duration.second * (attempt * 2))
        }
        return lastMsg
    }

    private func oneShot(url: String, payload: JsonValue, onChunk: (JsonObject) -> Unit, state: RetryState): AttemptResult {
        var tls = TlsClientConfig()
        tls.serverName = Some(hostOfUrl(url))
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
                .header("Authorization", "Bearer " + apiKey)
                .header("Accept", "text/event-stream")
                .body(payload.toString())
                .build()
            stage = "发送请求"
            let resp = client.send(req)
            stage = "读取状态"
            let st = resp.status
            if (st != 200) {
                let body = byteSafePrefix(readAllString(resp.body), 400)
                let retryable = st == 429 || st >= 500
                return AttemptResult(false, retryable, "模型接口返回 " + st.toString() + "：" + body)
            }
            stage = "读取响应体"
            readSseChunks(resp.body, { obj: JsonObject =>
                match (shouldAbort) {
                    case Some(f) =>
                        if (f()) {
                            throw AbortedByUser()
                        }
                    case None => ()
                }
                state.emitted = state.emitted + 1
                onChunk(obj)
            })
            return AttemptResult(true, false, "")
        } catch (e: AbortedByUser) {
            return AttemptResult(true, false, "")
        } catch (e: Exception) {
            return AttemptResult(false, true, "网络层失败（" + stage + "）：" + e.message)
        } finally {
            client.close()
        }
    }
}

func hostOfUrl(url: String): String {
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

class RetryState {
    var emitted: Int64 = 0
}

class AttemptResult {
    let ok: Bool
    let retryable: Bool
    let msg: String

    init(ok: Bool, retryable: Bool, msg: String) {
        this.ok = ok
        this.retryable = retryable
        this.msg = msg
    }
}

/** 服务端流式回的一条 tool_call（按 index 对齐）。 */
class NativeCall {
    var id = ""
    var name = ""
    let args = StringBuilder()
}

class StreamAcc {
    let text = StringBuilder()
    let reasoning = StringBuilder()
    let calls = ArrayList<NativeCall>()
    var finishReason = ""
    var promptTokens: Int64 = 0
    var completionTokens: Int64 = 0

    func callAt(idx: Int64): NativeCall {
        while (calls.size <= idx) {
            calls.add(NativeCall())
        }
        return calls[idx]
    }

    func partial(): Message {
        let m = Message(MsgRole.AssistantMsg)
        m.text = text.toString()
        m.thinking = reasoning.toString()
        for (c in calls) {
            if (c.name.size > 0) {
                m.toolCalls.add(ToolCallBlock(c.id, c.name, c.args.toString()))
            }
        }
        return m
    }
}

func toolsPayload(specs: ArrayList<ToolSpec>): JsonArray {
    let arr = JsonArray()
    for (s in specs) {
        let fn = JsonObject()
        fn.put("name", JsonString(s.name))
        fn.put("description", JsonString(s.description))
        fn.put("parameters", s.parametersJson())
        let t = JsonObject()
        t.put("type", JsonString("function"))
        t.put("function", fn)
        arr.add(t)
    }
    return arr
}

/** 半截 JSON 用流式解析器补一把；实在解析不出就给 {}。 */
func normalizeArgs(text: String): String {
    let t = trimStr(text)
    if (t.size == 0) {
        return "{}"
    }
    try {
        JsonValue.fromStr(t)
        return t
    } catch (e: Exception) {
        ()
    }
    let p = PartialJsonParser()
    p.push(t)
    return p.view().argsJson().toString()
}

func handleChunk(obj: JsonObject, acc: StreamAcc, stream: EventStream): Unit {
    let fr = pickStr(obj, ["choices", "0", "finish_reason"])
    if (fr.size > 0) {
        acc.finishReason = fr
    }
    acc.promptTokens = pickInt(obj, ["usage", "prompt_tokens"], acc.promptTokens)
    acc.completionTokens = pickInt(obj, ["usage", "completion_tokens"], acc.completionTokens)

    var think = pickStr(obj, ["choices", "0", "delta", "reasoning_content"])
    if (think.size == 0) {
        think = pickStr(obj, ["choices", "0", "message", "reasoning_content"])
    }
    if (think.size > 0) {
        acc.reasoning.append(think)
        stream.push(evMessageUpdate(deltaThinkingDelta(), think, acc.partial()))
    }

    var content = pickStr(obj, ["choices", "0", "delta", "content"])
    if (content.size == 0) {
        content = pickStr(obj, ["choices", "0", "message", "content"])
    }
    if (content.size > 0) {
        acc.text.append(content)
        stream.push(evMessageUpdate(deltaTextDelta(), content, acc.partial()))
    }

    match (pick(obj, ["choices", "0", "delta", "tool_calls"])) {
        case Some(v) =>
            match (v) {
                case a: JsonArray =>
                    var i: Int64 = 0
                    while (i < a.size()) {
                        // 数组元素是 JsonValue：先当对象看，不是对象就跳过这一条
                        let entry = match (objOf(a[i])) {
                            case Some(eo) => eo
                            case None => JsonObject()
                        }
                        let idx = pickInt(entry, ["index"], i)
                        let call = acc.callAt(idx)
                        let cid = pickStr(entry, ["id"])
                        if (cid.size > 0) {
                            call.id = cid
                        }
                        let nm = pickStr(entry, ["function", "name"])
                        if (nm.size > 0 && nm != call.name) {
                            call.name = nm
                            stream.push(evMessageUpdate(deltaToolCallStart(), "", acc.partial()))
                        }
                        let ar = pickStr(entry, ["function", "arguments"])
                        if (ar.size > 0) {
                            call.args.append(ar)
                            stream.push(evMessageUpdate(deltaToolCallDelta(), ar, acc.partial()))
                        }
                        i = i + 1
                    }
                case _ => ()
            }
        case None => ()
    }
}

func pickInt(o: JsonObject, path: Array<String>, fallback: Int64): Int64 {
    match (pick(o, path)) {
        case Some(v) =>
            match (v) {
                case i: JsonInt => i.getValue()
                case _ =>
                    try {
                        return Int64.parse(trimStr(v.toString().replace("\"", "")))
                    } catch (e: Exception) {
                        return fallback
                    }
            }
        case None => return fallback
    }
}

/* ---------- SSE ---------- */

func readSseChunks(input: InputStream, onChunk: (JsonObject) -> Unit): Unit {
    let buf = Array<UInt8>(4096, repeat: 0)
    var pending = ArrayList<UInt8>()
    while (true) {
        let n = input.read(buf)
        if (n <= 0) {
            break
        }
        var i = 0
        while (i < n) {
            if (buf[i] == 10) {
                dispatchSseLine(pending, onChunk)
                pending = ArrayList<UInt8>()
            } else {
                pending.add(buf[i])
            }
            i = i + 1
        }
    }
    if (pending.size > 0) {
        dispatchSseLine(pending, onChunk)
    }
}

func dispatchSseLine(line: ArrayList<UInt8>, onChunk: (JsonObject) -> Unit): Unit {
    let text = trimStr(safeUtf8Prefix(line.toArray()))
    if (!hasPrefix(text, "data:")) {
        return
    }
    let b = text.toArray()
    let data = trimStr(safeUtf8Prefix(b[5..b.size]))
    if (data.size == 0 || data == "[DONE]") {
        return
    }
    try {
        match (JsonValue.fromStr(data)) {
            case o: JsonObject => onChunk(o)
            case _ => ()
        }
    } catch (e: Exception) {
        ()
    }
}

/**
 * 字节 → 字符串，**去掉结尾那个可能被切断的半个字**。
 *
 * SSE 是一行一行来的，一行的字节可能不完整（只可能是结尾被切断）；直接 fromUtf8 会抛
 * "Invalid utf8 byte sequence"——这正是内核里踩过的那个坑的同类。
 */
func safeUtf8Prefix(bytes: Array<UInt8>): String {
    var n = bytes.size
    var cut = 0
    while (cut < 3 && n > 0) {
        let c = Int64(bytes[n - 1])
        if (c < 0x80) {
            break
        }
        if (c >= 0xC0) {
            // 起始字节：看它声明的长度够不够
            var need: Int64 = 2
            if (c >= 0xF0) {
                need = 4
            } else if (c >= 0xE0) {
                need = 3
            }
            if (cut + 1 < need) {
                n = n - 1
            }
            break
        }
        // 续延字节：往回找起始字节
        cut = cut + 1
        n = n - 1
    }
    if (n == 0) {
        return ""
    }
    return String.fromUtf8(bytes[0..n])
}
