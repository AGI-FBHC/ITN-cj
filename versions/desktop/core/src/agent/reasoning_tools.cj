package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.session.SessionStore
import itn_desktop_core.reasoning.reasoningState
import itn_desktop_core.reasoning.supportsReasoningMode
import itn_desktop_core.reasoning.effectiveReasoningMode
import itn_desktop_core.util.*

/** 让 API 区分非法显式模式与上游/运行时故障。 */
public class ReasoningModeError <: Exception {
    public init(message: String) { super(message) }
}

/** 与 askTask/make 的对话模型选择顺序相同。 */
public func reasoningModelOf(store: Store): ?ModelConfig {
    let settings = store.load()
    if (settings.chatModelId.size > 0) {
        match (settings.findModel(settings.chatModelId)) {
            case Some(cfg) => return Some(cfg)
            case None => ()
        }
    }
    if (settings.models.size > 0) { return Some(settings.models[0]) }
    return None
}

public func validateReasoningMode(cfg: ModelConfig, mode: String): Unit {
    if (mode.size == 0 || !supportsReasoningMode(cfg, mode)) {
        throw ReasoningModeError("当前对话模型不支持思考模式「" + mode + "」，请从可用档位中选择，或先配置模型的思考协议")
    }
}

/** 显式值必须合法；旧会话值与新模型不兼容时仅本轮回退，不改掉原设置。 */
public func reasoningModeForTurn(store: Store, cfg: ModelConfig, sid: String, requested: String): String {
    if (requested.size > 0) {
        validateReasoningMode(cfg, requested)
        return effectiveReasoningMode(cfg, requested)
    }
    return effectiveReasoningMode(cfg, SessionStore(store.dataDir).reasoningMode(sid))
}

public func sessionReasoningState(store: Store, sid: String): JsonObject {
    let mode = SessionStore(store.dataDir).reasoningMode(sid)
    match (reasoningModelOf(store)) {
        case Some(cfg) => return reasoningState(cfg, mode)
        case None =>
            let state = reasoningState(ModelConfig(), mode)
            state.put("requiresConfiguration", JsonBool(true))
            return state
    }
}

public func setSessionReasoningMode(store: Store, sid: String, mode: String): JsonObject {
    if (trimStr(sid).size == 0) { throw ReasoningModeError("缺少 sessionId，无法保存思考模式") }
    let cfg = reasoningModelOf(store) ?? ModelConfig()
    validateReasoningMode(cfg, mode)
    SessionStore(store.dataDir).setReasoningMode(sid, mode)
    return sessionReasoningState(store, sid)
}

func reasoningToolResult(body: JsonObject, summary: String): DomainToolRun {
    let result = DomainToolRun()
    result.summary = summary
    result.content = body.toString()
    result.details = body
    return result
}

/** 检查原始本轮提问，而非工具参数/历史消息中的自报授权。 */
func reasoningChangeRequested(userText: String): Bool {
    let text = userText.toAsciiLower()
    if (text.contains("不要改") || text.contains("不要设") || text.contains("不要切") || text.contains("不要开") || text.contains("不要关") || text.contains("别改") || text.contains("不用改") || text.contains("不修改") ||
        text.contains("不需要") || text.contains("不必") || text.contains("无需") || text.contains("不想") ||
        text.contains("don't") || text.contains("do not")) { return false }
    let subject = text.contains("思考") || text.contains("推理") || text.contains("reasoning") || text.contains("thinking")
    let action = text.contains("设置") || text.contains("切换") || text.contains("切到") || text.contains("改为") || text.contains("改成") ||
        text.contains("调到") || text.contains("调高") || text.contains("调低") || text.contains("调整") || text.contains("开启") ||
        text.contains("打开") || text.contains("关闭") || text.contains("恢复默认") || text.contains("启用") ||
        text.contains("禁用") || text.contains("设为") || text.contains("set ") || text.contains("switch ") ||
        text.contains("enable ") || text.contains("disable ") || text.contains("turn on ") || text.contains("turn off ")
    let question = text.contains("怎么") || text.contains("如何") || text.contains("是什么") || text.contains("能否自动") ||
        text.contains("解释") || text.contains("介绍") || text.contains("how ") || text.contains("what ")
    return subject && action && !question
}

/** 英文档位必须是完整单词，避免把 higher/maximum/flow 当成 high/max/low。 */
func reasoningModeWord(text: String, word: String): Bool {
    let bytes = text.toArray()
    let target = word.toArray()
    var i: Int64 = 0
    while (i + target.size <= bytes.size) {
        var same = true
        var j: Int64 = 0
        while (j < target.size) {
            if (bytes[i + j] != target[j]) { same = false; break }
            j += 1
        }
        if (same) {
            let before = if (i > 0) { bytes[i - 1] } else { 32u8 }
            let after = if (i + target.size < bytes.size) { bytes[i + target.size] } else { 32u8 }
            let leftWord = (before >= 97 && before <= 122) || (before >= 48 && before <= 57) || before == 95
            let rightWord = (after >= 97 && after <= 122) || (after >= 48 && after <= 57) || after == 95
            if (!leftWord && !rightWord) { return true }
        }
        i += 1
    }
    return false
}

/** 用户原文必须恰好指明一个目标档位；“思考深度”这样的主题词不构成 high 授权。 */
func reasoningTargetMatches(userText: String, mode: String): Bool {
    let text = userText.toAsciiLower()
    let explicitDepth = text.contains("轻度") || text.contains("低档") || text.contains("标准") || text.contains("均衡") ||
        text.contains("深度思考") || text.contains("深度模式") || text.contains("极深") || text.contains("最高") ||
        reasoningModeWord(text, "low") || reasoningModeWord(text, "medium") || reasoningModeWord(text, "high") || reasoningModeWord(text, "max")
    let targets = [
        ("default", text.contains("默认") || text.contains("跟随") || reasoningModeWord(text, "default")),
        ("off", text.contains("关闭") || text.contains("禁用") || reasoningModeWord(text, "off") || reasoningModeWord(text, "disable")),
        ("on", !explicitDepth && (text.contains("开启") || text.contains("启用") || text.contains("打开") || reasoningModeWord(text, "on") || reasoningModeWord(text, "enable"))),
        ("low", text.contains("轻度") || text.contains("低档") || reasoningModeWord(text, "low")),
        ("medium", text.contains("标准") || text.contains("均衡") || reasoningModeWord(text, "medium")),
        ("high", text.contains("深度模式") || text.contains("深度思考") || text.contains("切到深度") ||
            text.contains("设为深度") || text.contains("设置为深度") || text.contains("切换为深度") ||
            text.contains("切换到深度") || text.contains("改为深度") || text.contains("改成深度") ||
            text.contains("调到深度") || reasoningModeWord(text, "high")),
        ("max", text.contains("极深") || text.contains("最高") || reasoningModeWord(text, "max"))
    ]
    var count: Int64 = 0
    var selected = ""
    for ((id, mentioned) in targets) {
        if (mentioned) { count += 1; selected = id }
    }
    return count == 1 && selected == mode
}

/** 只保存当前会话的下一轮模式；闭包不持有可变 provider。 */
public func reasoningTools(store: Store, sid: String, userText: String, runningMode!: String = "default"): ArrayList<DomainTool> {
    let tools = ArrayList<DomainTool>()
    tools.add(makeTool("get_reasoning_mode", "查看思考模式", "当前模型支持的思考档位和会话下一轮设置",
        "只读查看当前对话模型、思考协议、支持档位及会话设置。mode 是已保存模式，effectiveMode 是当前模型实际可用模式；不支持旧设置时回退 default。",
        "{\"type\":\"object\",\"properties\":{}}", "read", { _: JsonObject =>
            let state = sessionReasoningState(store, sid)
            state.put("currentMode", JsonString(runningMode))
            return reasoningToolResult(state, "已读取思考模式；本轮模式已固定")
        }))
    tools.add(makeTool("set_reasoning_mode", "设置思考模式", "用户明确要求后修改当前会话下一轮的思考档位",
        "仅在用户本轮明确要求修改思考/推理模式，并明确选择与 mode 一致的目标档位后调用。关闭只能设 off，开启只能设 on；只说调整思考深度或目标不明确时，请让用户从 get_reasoning_mode 的可用档位中选择，不猜测或自行提档。confirmed=true 表示用户已明确要求。只改下一轮，本轮及其子任务保持已固定模式；不能修改模型协议。",
        "{\"type\":\"object\",\"properties\":{\"mode\":{\"type\":\"string\"},\"confirmed\":{\"type\":\"boolean\"}},\"required\":[\"mode\",\"confirmed\"]}", "write", { args: JsonObject =>
            if (!reasoningChangeRequested(userText) || !boolOf(args, "confirmed")) {
                throw ReasoningModeError("用户本轮尚未明确要求修改思考模式；请先询问用户，不得自行提高思考深度")
            }
            let mode = strOf(args, "mode")
            if (!reasoningTargetMatches(userText, mode)) {
                throw ReasoningModeError("用户原文未明确选择与「" + mode + "」一致的目标档位；请让用户从可用档位中选择，不得自行提档")
            }
            let state = setSessionReasoningMode(store, sid, mode)
            state.put("currentMode", JsonString(runningMode))
            state.put("appliesTo", JsonString("nextTurn"))
            state.put("message", JsonString("已保存，将在下一轮生效；本轮及已启动的子任务保持原思考模式"))
            return reasoningToolResult(state, "思考模式已保存，下一轮生效；本轮模式保持不变")
        }))
    return tools
}
