package itn_desktop_core.runtime

import std.collection.*
import std.env.*
import std.fs.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.util.trimStr
import itn_desktop_core.util.hasSuffix

/*
 * 演示用的模型侧录制/回放。
 *
 * 只固定“模型说了什么”，不固定工具结果：回放时工具仍在本机真实执行。
 * 这样断网也能演示，但不会把一场现场操作变成播放录像。
 *
 * 开关（环境变量，默认关闭）：
 *   LUMIN_AGENT_RECORD=<目录或 .jsonl>   录制每次模型请求
 *   LUMIN_AGENT_REPLAY=<.jsonl>          按顺序回放
 *   LUMIN_AGENT_REPLAY_STRICT=1          请求与素材不匹配时直接失败（默认宽容并继续）
 */

/** 一次 respond 的旁路捕获。lambda 只捕获这个不可变对象，避免多轮监听串数据。 */
class EventCapture {
    public var active: Bool = false
    public let events = ArrayList<AgentEvent>()
    public func feed(e: AgentEvent): Unit {
        if (active) {
            events.add(e)
        }
    }
}

func envText(name: String): String {
    return match (getVariable(name)) {
        case Some(v) => trimStr(v)
        case None => ""
    }
}

/** 稳定但不加密的短哈希：只用来判断两次请求的系统提示词是否相同。 */
func shortHash(text: String): String {
    var h: Int64 = 0
    for (b in text.toArray()) {
        h = (h * 31 + Int64(b)) % 1000000007
    }
    if (h < 0) { h = h + 1000000007 }
    return h.toString()
}

func recordingPath(dirOrFile: String): String {
    if (hasSuffix(dirOrFile, ".jsonl")) {
        return dirOrFile
    }
    let dir = if (dirOrFile.size == 0) { "." } else { dirOrFile }
    if (!exists(dir)) {
        try { Directory.create(dir, recursive: true) } catch (e: Exception) { () }
    }
    let stamp = DateTime.now().toUnixTimeStamp().toMilliseconds().toString()
    return dir + "/agent-" + stamp + ".jsonl"
}

func toolNamesJson(tools: ArrayList<ToolSpec>): JsonArray {
    let arr = JsonArray()
    for (t in tools) {
        arr.add(JsonString(t.name))
    }
    return arr
}

func replyJson(reply: ModelReply): JsonObject {
    let o = JsonObject()
    o.put("text", JsonString(reply.text))
    o.put("thinking", JsonString(reply.thinking))
    o.put("stopReason", JsonString(reply.stopReason))
    o.put("errorMessage", JsonString(reply.errorMessage))
    o.put("usageIn", JsonInt(reply.usageIn))
    o.put("usageOut", JsonInt(reply.usageOut))
    o.put("usageReasoning", JsonInt(reply.usageReasoning))
    let calls = JsonArray()
    for (c in reply.toolCalls) {
        let co = JsonObject()
        co.put("id", JsonString(c.id))
        co.put("name", JsonString(c.name))
        co.put("argsJson", JsonString(c.argsJson))
        calls.add(co)
    }
    o.put("toolCalls", calls)
    return o
}

func replyFromJson(o: JsonObject): ModelReply {
    let r = ModelReply()
    r.text = strOf(o, "text")
    r.thinking = strOf(o, "thinking")
    r.stopReason = strOf(o, "stopReason")
    if (r.stopReason.size == 0) { r.stopReason = "stop" }
    r.errorMessage = strOf(o, "errorMessage")
    r.usageIn = intOf(o, "usageIn")
    r.usageOut = intOf(o, "usageOut")
    r.usageReasoning = intOf(o, "usageReasoning")
    match (o.get("toolCalls")) {
        case Some(v) =>
            match (arrOf(v)) {
                case Some(arr) =>
                    var i: Int64 = 0
                    while (i < arr.size()) {
                        match (objOf(arr[i])) {
                            case Some(co) =>
                                r.toolCalls.add(ToolCallBlock(strOf(co, "id"), strOf(co, "name"), strOf(co, "argsJson")))
                            case None => ()
                        }
                        i = i + 1
                    }
                case None => ()
            }
        case None => ()
    }
    return r
}

/** 录制用的 provider 装饰器：旁路记录事件与最终 reply，然后原样返回。 */
public class RecordingProvider <: ChatProvider {
    private let inner: ChatProvider
    private let path: String
    private let records = ArrayList<String>()

    public init(inner: ChatProvider, path: String) {
        this.inner = inner
        this.path = path
    }

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        let cap = EventCapture()
        stream.on({ e: AgentEvent => cap.feed(e) })
        cap.active = true
        let reply = inner.respond(ctx, stream)
        cap.active = false
        let rec = JsonObject()
        rec.put("v", JsonInt(1))
        let req = JsonObject()
        req.put("turn", JsonInt(ctx.turn))
        req.put("purpose", JsonString(ctx.purpose))
        req.put("model", JsonString(ctx.model))
        req.put("toolNames", toolNamesJson(ctx.tools))
        req.put("systemHash", JsonString(shortHash(ctx.system)))
        req.put("messageCount", JsonInt(ctx.messages.size))
        rec.put("request", req)
        let events = JsonArray()
        for (e in cap.events) {
            events.add(e.toJson())
        }
        rec.put("events", events)
        rec.put("reply", replyJson(reply))
        records.add(rec.toString())
        try {
            File.writeTo(path, joinLines(records).toArray())
        } catch (e: Exception) {
            // 录制失败不能影响正常对话。
        }
        return reply
    }
}

func joinLines(lines: ArrayList<String>): String {
    let sb = StringBuilder()
    var i: Int64 = 0
    while (i < lines.size) {
        if (i > 0) { sb.append("\n") }
        sb.append(lines[i])
        i = i + 1
    }
    return sb.toString()
}

/** 回放 provider：按第 N 次请求读第 N 条素材，推回录制时的事件与 reply。 */
public class ReplayProvider <: ChatProvider {
    private let path: String
    private let strict: Bool
    private let records = ArrayList<JsonObject>()
    private var cursor: Int64 = 0
    public var onAudit: ?(String, JsonObject) -> Unit = None
    public var shouldAbort: ?() -> Bool = None

    public init(path: String, strict: Bool) {
        this.path = path
        this.strict = strict
        try {
            let text = String.fromUtf8(File.readFrom(path))
            for (line in text.split("\n")) {
                let t = trimStr(line)
                if (t.size == 0) { continue }
                try {
                    match (JsonValue.fromStr(t)) {
                        case o: JsonObject => records.add(o)
                        case _ => ()
                    }
                } catch (e: Exception) { () }
            }
        } catch (e: Exception) { () }
    }

    public func available(): Int64 { return records.size }

    private func aborted(): Bool {
        return match (shouldAbort) {
            case Some(f) => f()
            case None => false
        }
    }

    private func errorReply(message: String): ModelReply {
        let r = ModelReply()
        r.stopReason = "error"
        r.errorMessage = message
        return r
    }

    private func sameRequest(rec: JsonObject, ctx: StepContext): String {
        let reqValue = match (rec.get("request")) {
            case Some(v) => v
            case None => JsonNull()
        }
        let req = match (objOf(reqValue)) {
            case Some(o) => o
            case None => return "素材缺少 request"
        }
        if (intOf(req, "turn") != ctx.turn) {
            return "轮次不匹配（素材 " + intOf(req, "turn").toString() + "，当前 " + ctx.turn.toString() + "）"
        }
        let want = ArrayList<String>()
        for (t in ctx.tools) { want.add(t.name) }
        let got = ArrayList<String>()
        match (req.get("toolNames")) {
            case Some(v) =>
                match (arrOf(v)) {
                    case Some(arr) =>
                        var j: Int64 = 0
                        while (j < arr.size()) {
                            match (arr[j]) {
                                case s: JsonString => got.add(s.getValue())
                                case _ => ()
                            }
                            j = j + 1
                        }
                    case None => ()
                }
            case None => ()
        }
        if (got.size != want.size) {
            return "工具数量不匹配（素材 " + got.size.toString() + "，当前 " + want.size.toString() + "）"
        }
        var i: Int64 = 0
        while (i < want.size) {
            if (got[i] != want[i]) {
                return "工具不匹配（素材 " + got[i] + "，当前 " + want[i] + "）"
            }
            i = i + 1
        }
        return ""
    }

    public func respond(ctx: StepContext, stream: EventStream): ModelReply {
        if (aborted()) {
            return errorReply("已取消")
        }
        if (cursor >= records.size) {
            return errorReply("回放素材不完整：第 " + (cursor + 1).toString() + " 次模型请求没有对应记录。请录制更长的脚本。")
        }
        let rec = records[cursor]
        cursor = cursor + 1
        let mismatch = sameRequest(rec, ctx)
        if (mismatch.size > 0 && strict) {
            return errorReply("回放素材与当前请求不匹配：" + mismatch)
        }
        match (onAudit) {
            case Some(f) =>
                let a = JsonObject()
                a.put("requestedModel", JsonString(ctx.model))
                a.put("turn", JsonInt(ctx.turn))
                a.put("purpose", JsonString(ctx.purpose))
                a.put("messageCount", JsonInt(ctx.messages.size))
                a.put("toolCount", JsonInt(ctx.tools.size))
                a.put("replay", JsonBool(true))
                if (mismatch.size > 0) { a.put("replayWarning", JsonString(mismatch)) }
                f("model/request", a)
            case None => ()
        }
        match (rec.get("events")) {
            case Some(v) =>
                match (arrOf(v)) {
                    case Some(arr) =>
                        var i: Int64 = 0
                        while (i < arr.size()) {
                            match (objOf(arr[i])) {
                                case Some(eo) =>
                                    match (eventFromJson(eo)) {
                                        case Some(e) => stream.push(e)
                                        case None => ()
                                    }
                                case None => ()
                            }
                            i = i + 1
                        }
                    case None => ()
                }
            case None => ()
        }
        let replyValue = match (rec.get("reply")) {
            case Some(v) => v
            case None => JsonNull()
        }
        let reply = match (objOf(replyValue)) {
            case Some(ro) => replyFromJson(ro)
            case None => errorReply("回放素材缺少 reply")
        }
        match (onAudit) {
            case Some(f) =>
                let a = JsonObject()
                a.put("finishReason", JsonString(reply.stopReason))
                a.put("replay", JsonBool(true))
                f("model/response", a)
            case None => ()
        }
        return reply
    }
}

/**
 * 按环境变量决定用哪个 provider。
 * 未开启时原样返回，生产路径零变化。
 */
public func wrapProviderForDemo(inner: ChatProvider, dataDir: String, sessionId: String,
    abort: ?() -> Bool): ChatProvider {
    let recordTo = envText("LUMIN_AGENT_RECORD")
    if (recordTo.size > 0) {
        let path = recordingPath(recordTo)
        return RecordingProvider(inner, path)
    }
    let replayFrom = envText("LUMIN_AGENT_REPLAY")
    if (replayFrom.size > 0) {
        let strict = envText("LUMIN_AGENT_REPLAY_STRICT") == "1"
        let p = ReplayProvider(replayFrom, strict)
        p.shouldAbort = abort
        return p
    }
    return inner
}
