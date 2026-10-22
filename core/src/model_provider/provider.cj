package itn_desktop_core.model_provider

import std.collection.*
import std.convert.*
import std.io.*
import std.time.*
import std.sync.*
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
import itn_desktop_core.runtime.ChatProvider
import itn_desktop_core.runtime.StepContext
import itn_desktop_core.runtime.EventStream
import itn_desktop_core.runtime.ModelReply
import itn_desktop_core.runtime.ToolCallBlock
import itn_desktop_core.runtime.ToolSpec
import itn_desktop_core.runtime.Message
import itn_desktop_core.runtime.MsgRole
import itn_desktop_core.runtime.objOf
import itn_desktop_core.runtime.evMessageUpdate
import itn_desktop_core.runtime.deltaThinkingDelta
import itn_desktop_core.runtime.deltaTextDelta
import itn_desktop_core.runtime.deltaToolCallStart
import itn_desktop_core.runtime.deltaToolCallDelta

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
 * 重试：只在尚无实际内容时有限重试；角色/用量帧不是可见增量。
 */
/** 用户按了停止：只在本文件内部用，用来把"读流"这件事干净地掐掉。 */
class AbortedByUser <: Exception {
    public init() {
        super("用户停止")
    }
}
class ReasoningBudgetReached <: Exception {
    public init() { super("reasoning budget reached") }
}

class RequestWatch {
    let lock = Mutex()
    var finished = false
    var aborted = false
    var expired = false
    var lastData = DateTime.now()
    public func touch(): Unit { synchronized(lock) { lastData = DateTime.now() } }
    public func finish(): Unit { synchronized(lock) { finished = true } }
    public func isFinished(): Bool { synchronized(lock) { return finished } }
    public func idleMillis(): Int64 { synchronized(lock) { return (DateTime.now() - lastData).toMilliseconds() } }
    public func stop(user: Bool): Unit { synchronized(lock) { aborted = user; expired = !user } }
    public func wasAborted(): Bool { synchronized(lock) { return aborted } }
    public func timedOut(): Bool { synchronized(lock) { return expired } }
}

public class OpenAiChatProvider <: ChatProvider {
    private let baseUrl: String
    private let apiKey: String
    private let defaultModel: String
    public var maxAttempts: Int64 = 3
    public var maxOutputTokens: Int64 = 8192
    /** A client-side byte budget for MiMo's reasoning-only phase; 0 disables recovery. */
    public var maxReasoningBytes: Int64 = 24000
    /**
     * Idle, not total generation time. Continuous responses may run longer.
     * 上游在长上下文时首包可能要一分多钟（实测 39K token 的请求约 90s 才回第一段内容），
     * 原来的 90s 上限会把这种慢请求直接掐断；放宽到 5 分钟，用户随时可以点停止。
     */
    public var idleTimeoutMillis: Int64 = 300000
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
    /** Metadata only; credentials and tool output never enter this callback. */
    public var onAudit: ?(String, JsonObject) -> Unit = None

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
        return respondWithLimit(ctx, stream, maxOutputTokens, true)
    }

    /**
     * "一次成文"（资源 JSON / 逐节正文）的调用：正文流被截断时 respond() 会保留半截不重发，
     * 但一次成文的半截没有意义 —— 宁可把上限抬到 32768（MiMo 顺带关掉思考）完整重来一次。
     * 只有真的截断（finishReason=length）才重发，正常路径的代价为零。
     */
    public func respondForWriting(ctx: StepContext, stream: EventStream): ModelReply {
        let reply = respondWithLimit(ctx, stream, maxOutputTokens, true)
        if (reply.stopReason != "length" || maxOutputTokens >= 32768) {
            return reply
        }
        let model = if (ctx.model.size > 0) { ctx.model } else { defaultModel }
        let audit = JsonObject()
        audit.put("reason", JsonString("text_truncated"))
        audit.put("nextMaxTokens", JsonInt(32768))
        if (model.toAsciiLower().contains("mimo")) {
            audit.put("recoveryThinking", JsonString("disabled"))
        }
        match (onAudit) { case Some(f) => f("model/retry", audit); case None => () }
        return respondWithLimit(ctx, stream, 32768, false)
    }

    private func respondWithLimit(ctx: StepContext, stream: EventStream, outputLimit: Int64, canRecover: Bool): ModelReply {
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
            let serialized = m.toChatJson()
            if (model.toAsciiLower().contains("mimo") && m.role == MsgRole.AssistantMsg && m.toolCalls.size > 0 && m.thinking.size > 0) {
                serialized.put("reasoning_content",JsonString(m.thinking))
            }
            msgs.add(serialized)
        }
        payload.put("messages", msgs)
        payload.put("temperature", JsonFloat(0.3))
        payload.put("stream", JsonBool(true))
        payload.put("max_tokens", JsonInt(outputLimit))
        if (!canRecover && model.toAsciiLower().contains("mimo")) {
            // MiMo counts reasoning against the output budget. A recovery attempt must reach output.
            let thinking = JsonObject(); thinking.put("type",JsonString("disabled")); payload.put("thinking",thinking)
        }
        if (ctx.tools.size > 0) {
            payload.put("tools", toolsPayload(ctx.tools))
            payload.put("tool_choice", JsonString("auto"))
        }

        let requestAudit = JsonObject()
        requestAudit.put("requestedModel", JsonString(model))
        requestAudit.put("maxOutputTokens", JsonInt(outputLimit))
        requestAudit.put("messageCount", JsonInt(msgs.size()))
        requestAudit.put("turn", JsonInt(ctx.turn))
        var latestUser = ""
        var resultCount: Int64 = 0
        for (m in ctx.messages) {
            if (m.role == MsgRole.UserMsg) { latestUser = m.text }
            if (m.role == MsgRole.ToolResultMsg) { resultCount += 1 }
        }
        requestAudit.put("latestUser", JsonString(byteSafePrefix(latestUser, 1200)))
        requestAudit.put("toolResultCount", JsonInt(resultCount))
        match (onAudit) { case Some(f) => f("model/request", requestAudit); case None => () }

        let acc = StreamAcc()
        let started = DateTime.now()
        let err = postSse("/chat/completions", payload, { obj: JsonObject =>
            handleChunk(obj, acc, stream)
            if (canRecover && model.toAsciiLower().contains("mimo") && maxReasoningBytes > 0 && acc.reasoningBytes > maxReasoningBytes && acc.calls.size == 0 && acc.text.toString().size == 0) {
                acc.reasoningLimited = true; acc.finishReason = "reasoning_budget"
                throw ReasoningBudgetReached()
            }
        })
        lastMillis = (DateTime.now() - started).toMilliseconds()
        lastFinish = acc.finishReason
        let responseAudit = JsonObject()
        responseAudit.put("requestedModel", JsonString(model))
        responseAudit.put("responseModel", JsonString(acc.responseModel))
        responseAudit.put("responseId", JsonString(acc.responseId))
        responseAudit.put("finishReason", JsonString(acc.finishReason))
        responseAudit.put("failed", JsonBool(err.size > 0 || abortRequested()))
        match (onAudit) { case Some(f) => f("model/response", responseAudit); case None => () }

        let reply = ModelReply()
        // Failure still checkpoints the partial answer; it must remain in the next context.
        reply.text = acc.text.toString()
        reply.thinking = acc.reasoning.toString()
        reply.usageIn = acc.promptTokens
        reply.usageOut = acc.completionTokens
        if (abortRequested()) {
            reply.stopReason = "aborted"
            reply.errorMessage = "已取消"
            return reply
        }
        if (err.size > 0 && !acc.reasoningLimited) {
            reply.stopReason = "error"
            reply.errorMessage = err
            return reply
        }
        if (acc.reasoningLimited || (acc.finishReason == "length" && (acc.calls.size > 0 || acc.reasoning.toString().size > 0))) {
            // Retrying a text stream would duplicate visible content. Only retry a pure tool input.
            if (canRecover && outputLimit < 32768 && trimStr(acc.text.toString()).size == 0) {
                let audit = JsonObject()
                audit.put("reason",JsonString(if (acc.calls.size > 0) { "tool_arguments_truncated" } else { "reasoning_budget_exhausted" })); audit.put("nextMaxTokens",JsonInt(32768))
                if (model.toAsciiLower().contains("mimo")) { audit.put("recoveryThinking",JsonString("disabled")) }
                match (onAudit) { case Some(f) => f("model/retry",audit); case None => () }
                return respondWithLimit(ctx,stream,32768,false)
            }
            reply.stopReason = "error"
            reply.errorMessage = "模型输出达到上限，工具参数被截断，未执行任何工具。请缩小文件内容或分段生成后重试。"
            return reply
        }
        for (call in acc.calls) {
            if (call.name.size > 0) {
                let args = trimStr(call.args.toString())
                if (!validToolArguments(args)) {
                    reply.toolCalls.clear()
                    reply.stopReason = "error"
                    reply.errorMessage = "模型返回的 " + call.name + " 参数不是完整的 JSON 对象，未执行工具。请重试。"
                    return reply
                }
                reply.toolCalls.add(ToolCallBlock(call.id, call.name, args))
            }
        }
        if (trimStr(reply.text).size == 0 && reply.toolCalls.size == 0) {
            reply.stopReason = "error"
            reply.errorMessage = "模型未返回可用正文，请重试或检查模型服务"
        } else if (acc.finishReason == "length") {
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
            if (abortRequested()) { return "" }
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
            let audit = JsonObject()
            audit.put("reason", JsonString("network_retry"))
            audit.put("attempt", JsonInt(attempt + 1))
            audit.put("maxAttempts", JsonInt(maxAttempts))
            audit.put("delayMs", JsonInt(attempt * 2000))
            match (onAudit) { case Some(f) => f("model/retry", audit); case None => () }
            for (_ in 0..(attempt * 20)) {
                if (abortRequested()) { return "" }
                sleep(Duration.millisecond * 100)
            }
        }
        if (lastMsg.contains("模型连接中断") && state.emitted == 0 && attempt > 1) {
            return "模型连接中断，尝试 " + attempt.toString() + " 次后仍未恢复，请稍后重试。详情：" + lastMsg
        }
        return lastMsg
    }

    private func abortRequested(): Bool {
        return match (shouldAbort) { case Some(f) => f(); case None => false }
    }

    private func oneShot(url: String, payload: JsonValue, onChunk: (JsonObject) -> Unit, state: RetryState): AttemptResult {
        var tls = TlsClientConfig()
        tls.serverName = Some(hostOfUrl(url))
        tls.supportedAlpnProtocols = ["http/1.1"]
        let client = ClientBuilder()
            .tlsConfig(tls)
            // 传输层超时必须大于上面的语义空闲上限：否则会在 watch 判定"长时间无数据"
            // 之前先抛底层 Read body timeout（实测：90s 读超时把刚开始到达的正文掐断）。
            .readTimeout(Duration.minute * 10)
            .writeTimeout(Duration.minute * 10)
            .build()
        let watch = RequestWatch()
        let idleLimit = idleTimeoutMillis
        // Closing the request's client interrupts send/read even when no SSE delta arrives.
        let watcher = spawn {
            while (!watch.isFinished()) {
                sleep(Duration.millisecond * 100)
                if (watch.isFinished()) { break }
                let cancelled = abortRequested()
                if (cancelled || watch.idleMillis() >= idleLimit) {
                    watch.stop(cancelled)
                    client.close()
                    break
                }
            }
        }
        var stage = "构造请求"
        let completion = [false]
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
            let done = readSseChunks(resp.body, { obj: JsonObject =>
                watch.touch()
                match (shouldAbort) {
                    case Some(f) =>
                        if (f()) {
                            throw AbortedByUser()
                        }
                    case None => ()
                }
                if (hasAssistantContent(obj)) { state.emitted += 1 }
                if (pickStr(obj, ["choices", "0", "finish_reason"]).size > 0) { completion[0] = true }
                onChunk(obj)
            })
            if (watch.timedOut()) { return AttemptResult(false, false, "模型长时间未返回数据，请重试或检查模型服务") }
            if (!done && !completion[0]) { return AttemptResult(false, true, "模型连接中断：响应在完成前结束，已收到的内容已保留。") }
            return AttemptResult(true, false, "")
        } catch (e: AbortedByUser) {
            return AttemptResult(true, false, "")
        } catch (e: Exception) {
            if (watch.wasAborted()) { return AttemptResult(true, false, "") }
            if (watch.timedOut()) { return AttemptResult(false, false, "模型长时间未返回数据，请重试或检查模型服务") }
            if (completion[0]) { return AttemptResult(true, false, "") }
            return AttemptResult(false, true, "模型连接中断（" + stage + "），已收到的内容已保留。详情：" + e.message)
        } finally {
            watch.finish()
            client.close()
            watcher.get()
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
    var responseModel = ""
    var responseId = ""
    var promptTokens: Int64 = 0
    var completionTokens: Int64 = 0
    var reasoningBytes: Int64 = 0
    var reasoningLimited = false

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

/** Partial JSON belongs to previews; execution accepts only complete objects. */
func validToolArguments(text: String): Bool {
    let t = trimStr(text)
    if (t.size == 0) {
        return false
    }
    try {
        return JsonValue.fromStr(t) is JsonObject
    } catch (e: Exception) {
        ()
    }
    return false
}

func handleChunk(obj: JsonObject, acc: StreamAcc, stream: EventStream): Unit {
    let responseModel = pickStr(obj, ["model"])
    let responseId = pickStr(obj, ["id"])
    if (responseModel.size > 0) { acc.responseModel = responseModel }
    if (responseId.size > 0) { acc.responseId = responseId }
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
        acc.reasoningBytes += think.size
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

func hasAssistantContent(obj: JsonObject): Bool {
    for (field in ["content", "reasoning_content"]) {
        if (pickStr(obj, ["choices", "0", "delta", field]).size > 0 ||
            pickStr(obj, ["choices", "0", "message", field]).size > 0) { return true }
    }
    match (pick(obj, ["choices", "0", "delta", "tool_calls"])) {
        case Some(a: JsonArray) =>
            var i: Int64 = 0
            while (i < a.size()) {
                match (objOf(a[i])) {
                    case Some(call) =>
                        if (pickStr(call, ["function", "name"]).size > 0 || pickStr(call, ["function", "arguments"]).size > 0) { return true }
                    case None => ()
                }
                i += 1
            }
        case _ => ()
    }
    return false
}

func readSseChunks(input: InputStream, onChunk: (JsonObject) -> Unit): Bool {
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
                if (dispatchSseLine(pending, onChunk)) { return true }
                pending = ArrayList<UInt8>()
            } else {
                pending.add(buf[i])
            }
            i = i + 1
        }
    }
    if (pending.size > 0) {
        return dispatchSseLine(pending, onChunk)
    }
    return false
}

func dispatchSseLine(line: ArrayList<UInt8>, onChunk: (JsonObject) -> Unit): Bool {
    let text = trimStr(safeUtf8Prefix(line.toArray()))
    if (!hasPrefix(text, "data:")) {
        return false
    }
    let b = text.toArray()
    let data = trimStr(safeUtf8Prefix(b[5..b.size]))
    if (data == "[DONE]") { return true }
    if (data.size == 0) { return false }
    var decoded: ?JsonObject = None
    try { decoded = objOf(JsonValue.fromStr(data)) } catch(e: Exception) { return false }
    // Callback cancellation/recovery must reach the request owner, never the JSON parse catch.
    match (decoded) { case Some(o) => onChunk(o); case None => () }
    return false
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
