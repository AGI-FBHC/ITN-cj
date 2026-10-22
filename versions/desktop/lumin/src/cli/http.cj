package lumin.cli

import std.collection.*
import std.io.*
import std.sync.*
import std.time.*
import stdx.encoding.json.*
import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import lumin.pi.*

/*
 * OpenAI 兼容的流式提供方（只管一家：OpenAI 格式）。
 *
 * 它把 message_update 事件照 Pi 的名字推出去：
 *   正文增量    -> assistantEvent.type = text_delta
 *   思考增量    -> thinking_delta
 *   工具参数    -> toolcall_delta（半截 JSON 原样推，界面能提前显示"正在调 xx，参数到一半"）
 * 失败不抛：填 stopReason = "error" + errorMessage（与 Pi 的 StreamFn 契约一致），
 * 但网络层会先做 429/5xx 退避重试（这是我们的套餐现实：TokenPlan 会限流）。
 */
public class HttpChatProvider <: ChatProvider {
    private let baseUrl: String
    private let apiKey: String
    private let defaultModel: String
    public var maxAttempts: Int64 = 3
    public var lastMillis: Int64 = 0
    public var lastFinish: String = ""

    public init(baseUrl: String, apiKey: String, model: String) {
        this.baseUrl = trimTrailingSlash(baseUrl)
        this.apiKey = apiKey
        this.defaultModel = model
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
        let hasTools = reply.toolCalls.size > 0
        if (acc.finishReason == "length") {
            reply.stopReason = "length"
        } else if (hasTools) {
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
            sleep(Duration.second * (attempt * 2))
        }
        return lastMsg
    }

    private func oneShot(url: String, payload: JsonValue, onChunk: (JsonObject) -> Unit, state: RetryState): AttemptResult {
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
                .header("Authorization", "Bearer " + apiKey)
                .header("Accept", "text/event-stream")
                .body(payload.toString())
                .build()
            stage = "发送请求"
            let resp = client.send(req)
            stage = "读取状态"
            let st = resp.status
            if (st != 200) {
                let body = preview(readAllStringSafe(resp.body), 400)
                let retryable = st == 429 || st >= 500
                return AttemptResult(false, retryable, "模型接口返回 " + st.toString() + "：" + body)
            }
            stage = "读取响应体"
            let wrapped = { obj: JsonObject =>
                state.emitted = state.emitted + 1
                onChunk(obj)
            }
            readSseChunks(resp.body, wrapped)
            return AttemptResult(true, false, "")
        } catch (e: Exception) {
            return AttemptResult(false, true, "网络层失败（" + stage + "）：" + e.message)
        } finally {
            client.close()
        }
    }
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
        let m = Message(AssistantMsg)
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

func normalizeArgs(text: String): String {
    let t = trimStr(text)
    if (t.size == 0) {
        return "{}"
    }
    try {
        JsonValue.fromStr(t)
        return t
    } catch (e: Exception) {
        // 半截 JSON：用流式解析器补一把
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

    let tc = pickPath(obj, ["choices", "0", "delta", "tool_calls"])
    match (tc) {
        case Some(v) =>
            match (v) {
                case a: JsonArray =>
                    var i: Int64 = 0
                    while (i < a.size()) {
                        let entry = a[i]
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
    let text = trimStr(safeUtf8(line.toArray(), 0, line.size))
    if (!hasPrefix(text, "data:")) {
        return
    }
    let b = text.toArray()
    let data = trimStr(safeUtf8(b, 5, b.size))
    if (data.size == 0 || data == "[DONE]") {
        return
    }
    try {
        let v = JsonValue.fromStr(data)
        match (v) {
            case o: JsonObject => onChunk(o)
            case _ => ()
        }
    } catch (e: Exception) {
        ()
    }
}
