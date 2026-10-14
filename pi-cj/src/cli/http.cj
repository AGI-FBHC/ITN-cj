package pi_cj.cli

import std.collection.*
import std.io.*
import std.sync.*
import std.time.*
import stdx.encoding.json.*
import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import pi_cj.pi.*

/**
 * 真实模型提供方：OpenAI 兼容的 /chat/completions（流式 SSE）。
 *
 * 它放在 cli 包里、不放进运行时包 —— 这是刻意的分层：
 *   pi_cj.pi     运行时循环：零网络、零文件，可整体搬进 ITN-Desktop
 *   pi_cj.tools  真实工具：文件与命令
 *   pi_cj.cli    模型通信 + 命令行界面（本文件）
 * 换供应商只需要换这个类，主循环一行都不用改。
 *
 * 工具调用的识别支持两种形态：
 *   1. 提示词协议（主路径）：模型把 {"tool":..,"args":..} 当正文吐出来，边收边喂
 *      PartialJsonParser，所以工具名一到齐前端就能显示。
 *   2. 原生 function calling（服务端支持时）：delta.tool_calls[].function.arguments 增量。
 */
public class HttpChatProvider <: ChatProvider {
    private let baseUrl: String
    private let apiKey: String
    private let model: String
    /** 是否把工具以"原生 function calling"（tools 数组）发过去；关掉则退化成提示词协议 */
    private let nativeTools: Bool
    /** 最近一次请求的耗时（毫秒）、结束原因、用量，给界面显示用 */
    public var lastMillis: Int64 = 0
    public var lastFinish: String = ""
    public var lastPromptTokens: Int64 = 0
    public var lastCompletionTokens: Int64 = 0
    /** 最多试几次（第一次 + 两次重试） */
    public var maxAttempts: Int64 = 3

    public init(baseUrl: String, apiKey: String, model: String) {
        this.baseUrl = trimTrailingSlash(baseUrl)
        this.apiKey = apiKey
        this.model = model
        this.nativeTools = true
    }

    public init(baseUrl: String, apiKey: String, model: String, nativeTools: Bool) {
        this.baseUrl = trimTrailingSlash(baseUrl)
        this.apiKey = apiKey
        this.model = model
        this.nativeTools = nativeTools
    }

    public func modelName(): String {
        return model
    }

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        // 支持原生 function calling 时优先用它：模型输出的是结构化 tool_calls，
        // 参数以 arguments 片段流式到达，正好喂我们的 PartialJsonParser。
        // 关掉（或服务端不支持）时才退化成"提示词协议"：把工具清单与 JSON 约定塞进 system。
        let useNative = nativeTools && ctx.toolSpecs.size > 0
        let payload = JsonObject()
        payload.put("model", JsonString(model))
        payload.put("messages", buildMessages(ctx, !useNative))
        payload.put("temperature", JsonFloat(0.3))
        payload.put("stream", JsonBool(true))
        payload.put("max_tokens", JsonInt(4096))
        if (useNative) {
            payload.put("tools", toolsPayload(ctx.toolSpecs))
            payload.put("tool_choice", JsonString("auto"))
        }

        let acc = StreamAcc()
        let parser = PartialJsonParser()
        let started = DateTime.now()
        postSse("/chat/completions", payload, { obj: JsonObject =>
            handleChunk(obj, acc, ctx, stream, parser)
        })
        lastMillis = (DateTime.now() - started).toMilliseconds()
        lastFinish = acc.finishReason
        lastPromptTokens = acc.promptTokens
        lastCompletionTokens = acc.completionTokens

        let reply = ModelReply()
        reply.reasoning = acc.reasoning.toString()
        let text = acc.text.toString()
        reply.raw = text

        // 形态 2：原生 function calling（主路径）。arguments 是流式片段，收齐后按条解析。
        var i: Int64 = 0
        while (i < acc.calls.size) {
            let call = acc.calls[i]
            if (call.name.size > 0) {
                let wrap = PartialJsonParser()
                wrap.push("{\"tool\":\"" + call.name + "\",\"args\":" + argsText(call.args.toString()) + "}")
                let req = ToolRequest()
                req.id = call.id
                req.name = call.name
                req.args = wrap.view().argsJson()
                reply.requests.add(req)
            }
            i = i + 1
        }
        if (reply.requests.size > 0) {
            reply.stopReason = "tool_call"
            return reply
        }

        // 形态 1：正文整体就是一个工具调用
        let candidate = stripFence(text)
        if (startsWithBrace(candidate)) {
            let p = PartialJsonParser()
            p.push(candidate)
            let v = p.view()
            if (v.nameKnown && p.isComplete()) {
                let req = ToolRequest()
                req.name = v.name
                req.args = v.argsJson()
                reply.requests.add(req)
                reply.stopReason = "tool_call"
                return reply
            }
        }

        reply.text = text
        if (acc.suppressText && text.size > 0) {
            // 正文以 { 开头时把增量压住了（怕闪出一段 JSON）；既然最终判定不是工具调用，
            // 就得整段补一次，否则回答会被吞掉。
            emitPiece(stream, ctx, TextDelta, text)
        }
        return reply
    }

    private func buildMessages(ctx: StepContext, includeProtocol: Bool): JsonArray {
        let arr = JsonArray()
        var sysText = ctx.system
        if (includeProtocol && ctx.tools.size > 0) {
            if (sysText.size > 0) {
                sysText = sysText + "\n\n" + ctx.tools
            } else {
                sysText = ctx.tools
            }
        }
        if (sysText.size > 0) {
            let sys = JsonObject()
            sys.put("role", JsonString("system"))
            sys.put("content", JsonString(sysText))
            arr.add(sys)
        }
        var i: Int64 = 0
        while (i < ctx.messages.size()) {
            arr.add(ctx.messages[i])
            i = i + 1
        }
        return arr
    }

    /**
     * 发一次流式请求，带**退避重试**。
     *
     * TokenPlan 这类套餐有速率限制（实测会回 429 Request rate limited），
     * 没有重试的话用户看到的就是一句"请求失败"。规则：
     *   - 429 / 5xx / 网络层失败 -> 可重试，等 2s、4s、6s
     *   - 只有在"一个事件都还没推出去"时才敢重试，否则正文会重复
     */
    private func postSse(path: String, payload: JsonValue, onChunk: (JsonObject) -> Unit): Unit {
        let url = baseUrl + path
        let state = RetryState()
        var attempt: Int64 = 0
        var lastMsg = ""
        while (attempt < maxAttempts) {
            attempt = attempt + 1
            let r = oneShot(url, payload, onChunk, state)
            if (r.ok) {
                return
            }
            lastMsg = r.msg
            if (!r.retryable || state.emitted > 0 || attempt >= maxAttempts) {
                break
            }
            sleep(Duration.second * (attempt * 2))
        }
        throw PiException("请求模型失败：" + lastMsg)
    }

    private func oneShot(url: String, payload: JsonValue, onChunk: (JsonObject) -> Unit,
                         state: RetryState): AttemptResult {
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

/** 重试状态：记"已经推出过几个事件"（推过就不能重试，否则正文会重复）。 */
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

/** 把工具定义转成 OpenAI 的 tools 数组。参数 schema 从 argsExample 推出来（够用即可）。 */
func toolsPayload(specs: ArrayList<ToolSpec>): JsonArray {
    let arr = JsonArray()
    for (s in specs) {
        let fn = JsonObject()
        fn.put("name", JsonString(s.name))
        fn.put("description", JsonString(s.desc + " 参数示例 " + s.usage))
        fn.put("parameters", schemaOf(s.usage))
        let t = JsonObject()
        t.put("type", JsonString("function"))
        t.put("function", fn)
        arr.add(t)
    }
    return arr
}

/** 由参数示例推一个宽松 schema：字段名与类型给出来，additionalProperties 放开。 */
func schemaOf(usage: String): JsonObject {
    let schema = JsonObject()
    schema.put("type", JsonString("object"))
    let props = JsonObject()
    let required = JsonArray()
    try {
        let v = JsonValue.fromStr(trimStr(usage))
        match (v) {
            case o: JsonObject =>
                for ((k, val) in o.getFields()) {
                    let p = JsonObject()
                    p.put("type", JsonString(jsonTypeName(val)))
                    props.put(k, p)
                    required.add(JsonString(k))
                }
            case _ => ()
        }
    } catch (e: Exception) {
        ()
    }
    schema.put("properties", props)
    if (required.size() > 0) {
        schema.put("required", required)
    }
    schema.put("additionalProperties", JsonBool(true))
    return schema
}

func jsonTypeName(v: JsonValue): String {
    match (v) {
        case s: JsonString => return "string"
        case i: JsonInt => return "integer"
        case f: JsonFloat => return "number"
        case b: JsonBool => return "boolean"
        case a: JsonArray => return "array"
        case o: JsonObject => return "object"
        case _ => return "string"
    }
}

/** SSE 解析出来的东西。用类而不是闭包捕获的局部变量：类是引用类型，回调里改字段外面才看得见。 */
/** 服务端流式回的一条 tool_call（按 index 对齐）。 */
class NativeCall {
    var id = ""
    var name = ""
    let args = StringBuilder()
    /** 每条调用配一个解析器：并行调用时共用一个会把参数串味 */
    let parser = PartialJsonParser()
}

class StreamAcc {
    let text = StringBuilder()
    let reasoning = StringBuilder()
    let calls = ArrayList<NativeCall>()
    var finishReason = ""

    /** 按 index 取（不够就补齐）：服务端不保证 index 连续，也不保证按顺序到。 */
    func callAt(idx: Int64): NativeCall {
        while (calls.size <= idx) {
            calls.add(NativeCall())
        }
        return calls[idx]
    }
    var sawContent = false
    var leadingBrace = false
    var suppressText = false
    var chunks: Int64 = 0
    var promptTokens: Int64 = 0
    var completionTokens: Int64 = 0
}

/** 取整数（取不到就用 dflt）。 */
func pickInt(v: JsonValue, path: Array<String>, dflt: Int64): Int64 {
    match (pickPath(v, path)) {
        case Some(x) =>
            match (x) {
                case j: JsonInt => return j.getValue()
                case _ => return dflt
            }
        case None => return dflt
    }
}

func argsText(s: String): String {
    let t = trimStr(s)
    if (t.size == 0) {
        return "{}"
    }
    return t
}

func emitPiece(stream: EventStream, ctx: StepContext, kind: PiEventKind, text: String): Unit {
    let e = PiEvent(kind)
    e.turnId = ctx.turnId
    e.step = ctx.step
    e.text = text
    stream.push(e)
}

func handleChunk(obj: JsonObject, acc: StreamAcc, ctx: StepContext, stream: EventStream, parser: PartialJsonParser): Unit {
    acc.chunks = acc.chunks + 1
    let fr = pickStr(obj, ["choices", "0", "finish_reason"])
    if (fr.size > 0) {
        acc.finishReason = fr
    }

    // 用量（最后一帧单独回，choices 是空数组，别当成错误）
    let pt = pickPath(obj, ["usage", "prompt_tokens"])
    match (pt) {
        case Some(v) =>
            match (v) {
                case j: JsonInt => acc.promptTokens = j.getValue()
                case _ => ()
            }
        case None => ()
    }
    let ct = pickPath(obj, ["usage", "completion_tokens"])
    match (ct) {
        case Some(v) =>
            match (v) {
                case j: JsonInt => acc.completionTokens = j.getValue()
                case _ => ()
            }
        case None => ()
    }

    // 原生 function calling：模型可能一次要调多个工具，数组里按 index 区分。
    // 第一个片段带 id 与函数名，后面的片段只带 arguments（半截 JSON）。
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
                            let e = PiEvent(ToolCallStart)
                            e.turnId = ctx.turnId
                            e.step = ctx.step
                            e.tool = nm
                            e.callId = call.id
                            stream.push(e)
                        }
                        let ar = pickStr(entry, ["function", "arguments"])
                        if (ar.size > 0) {
                            call.args.append(ar)
                            // 参数是"半截 JSON"到达的：喂流式解析器，参数一完整就能显示（toolcall_delta 的用处）
                            for (e in call.parser.push(ar)) {
                                e.turnId = ctx.turnId
                                e.step = ctx.step
                                e.tool = call.name
                                e.callId = call.id
                                stream.push(e)
                            }
                        }
                        i = i + 1
                    }
                case _ => ()
            }
        case None => ()
    }

    // 思考增量（有的供应商单独回 reasoning_content）
    var think = pickStr(obj, ["choices", "0", "delta", "reasoning_content"])
    if (think.size == 0) {
        think = pickStr(obj, ["choices", "0", "message", "reasoning_content"])
    }
    if (think.size > 0) {
        acc.reasoning.append(think)
        emitPiece(stream, ctx, ThinkDelta, think)
    }

    // 正文增量（也有服务端对流式请求仍回 message.content）
    var content = pickStr(obj, ["choices", "0", "delta", "content"])
    if (content.size == 0) {
        content = pickStr(obj, ["choices", "0", "message", "content"])
    }
    if (content.size > 0) {
        acc.text.append(content)
        if (!acc.sawContent) {
            let head = trimStr(acc.text.toString())
            if (head.size > 0) {
                acc.sawContent = true
                acc.leadingBrace = startsWithBrace(head)
                acc.suppressText = acc.leadingBrace
            }
        }
        // 边到边喂流式解析器：工具名一到齐就能播报
        for (e in parser.push(content)) {
            e.turnId = ctx.turnId
            e.step = ctx.step
            stream.push(e)
        }
        if (!acc.suppressText) {
            emitPiece(stream, ctx, TextDelta, content)
        }
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
    // 单行解析失败不影响整轮（当噪声忽略，不要当成回答）
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
