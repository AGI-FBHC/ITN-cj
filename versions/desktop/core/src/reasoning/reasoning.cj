package itn_desktop_core.reasoning

import stdx.encoding.json.*
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.util.*

/** Gateway compatibility is an explicit capability, not a guess from a model alias. */
public func validReasoningProfile(profile: String): Bool {
    return ["auto", "none", "deepseek", "mimo", "qwen-budget", "openai"].contains(profile)
}

func endpointHost(url: String): String {
    let parts = url.toAsciiLower().split("://")
    if (parts.size != 2) { return "" }
    return parts[1].split("/")[0].split(":")[0]
}

public func reasoningProfile(cfg: ModelConfig): String {
    if (cfg.reasoningProfile != "auto" && cfg.reasoningProfile.size > 0) {
        return if (validReasoningProfile(cfg.reasoningProfile)) { cfg.reasoningProfile } else { "none" }
    }
    let host = endpointHost(cfg.baseUrl)
    let model = cfg.model.toAsciiLower()
    if (host == "api.deepseek.com" && (model == "deepseek-flash" || model.contains("deepseek-v4"))) { return "deepseek" }
    if ((host == "api.xiaomimimo.com" || host == "api.mimo.xiaomi.com" || host == "token-plan-cn.xiaomimimo.com") && model.contains("mimo")) { return "mimo" }
    if ((host == "dashscope.aliyuncs.com" || host == "dashscope-intl.aliyuncs.com" || host == "dashscope-us.aliyuncs.com") && model.contains("qwen3")) { return "qwen-budget" }
    if (host == "api.openai.com" && (hasPrefix(model, "gpt-5") || hasPrefix(model, "gpt-6") || hasPrefix(model, "o3") || hasPrefix(model, "o4") || model == "o1")) { return "openai" }
    return "none"
}

func needsResponses(cfg: ModelConfig): Bool {
    let name = cfg.model.toAsciiLower()
    return name.contains("gpt-6") || name.contains("gpt-5.6")
}

func qwenThinkingOnly(cfg: ModelConfig): Bool {
    let name = cfg.model.toAsciiLower()
    return name.contains("thinking") || name.contains("qwen3.7-plus") || name.contains("qwen3.8-2.4t") || name.contains("qwen3.8-max-preview")
}

public func supportsReasoningMode(cfg: ModelConfig, mode: String): Bool {
    if (mode == "default") { return true }
    let profile = reasoningProfile(cfg)
    if (profile == "deepseek") { return ["off", "low", "high", "max"].contains(mode) }
    if (profile == "mimo") { return ["off", "on"].contains(mode) }
    if (profile == "qwen-budget") { return ["low", "medium", "high"].contains(mode) || (mode == "off" && !qwenThinkingOnly(cfg)) }
    if (profile == "openai") {
        // These models require a Responses tool loop; this provider uses Chat Completions.
        if (needsResponses(cfg)) { return false }
        let name = cfg.model.toAsciiLower()
        if (name.contains("chat-latest")) { return false }
        if (name.contains("gpt-5-pro")) { return mode == "high" }
        if (mode == "off") { return hasPrefix(name, "gpt-5.") }
        if (mode == "max") { return hasPrefix(name, "gpt-5.2") || hasPrefix(name, "gpt-5.3") || hasPrefix(name, "gpt-5.4") || hasPrefix(name, "gpt-5.5") }
        return ["low", "medium", "high"].contains(mode)
    }
    return false
}

public func effectiveReasoningMode(cfg: ModelConfig, mode: String): String {
    return if (supportsReasoningMode(cfg, mode)) { mode } else { "default" }
}

public func copyReasoningConfig(cfg: ModelConfig, mode: String): ModelConfig {
    let snapshot = ModelConfig.fromJson(cfg.toJson())
    snapshot.reasoningMode = effectiveReasoningMode(snapshot, mode)
    return snapshot
}

public func reasoningState(cfg: ModelConfig, mode: String): JsonObject {
    let out = JsonObject()
    let options = JsonArray()
    for ((id, label) in [("default", "默认"), ("off", "关闭"), ("on", "开启"), ("low", "轻度"), ("medium", "标准"), ("high", "深度"), ("max", "极深")]) {
        if (supportsReasoningMode(cfg, id)) {
            let option = JsonObject()
            option.put("id", JsonString(id)); option.put("label", JsonString(label)); options.add(option)
        }
    }
    let profile = reasoningProfile(cfg)
    out.put("modelId", JsonString(cfg.id))
    out.put("profile", JsonString(profile))
    out.put("mode", JsonString(if (mode.size > 0) { mode } else { "default" }))
    out.put("effectiveMode", JsonString(effectiveReasoningMode(cfg, mode)))
    out.put("supported", JsonBool(options.size() > 1))
    out.put("requiresConfiguration", JsonBool(profile == "none" && cfg.reasoningProfile != "none" && cfg.model.size > 0))
    out.put("options", options)
    if (profile == "openai" && needsResponses(cfg)) { out.put("reason", JsonString("该模型的思考与工具调用需要 Responses 接口")) }
    if (mode.size > 0 && !supportsReasoningMode(cfg, mode)) { out.put("notice", JsonString("当前模型不支持已保存的档位，本次使用默认模式")) }
    return out
}

public func passReasoningHistory(cfg: ModelConfig): Bool {
    let profile = reasoningProfile(cfg)
    return profile == "deepseek" || profile == "mimo" || profile == "qwen-budget" || cfg.model.toAsciiLower().contains("mimo")
}

/** Shared by the chat tool loop and fixed sub-agent pipelines. Thinking is not verbosity. */
public func applyReasoningParameters(payload: JsonObject, cfg: ModelConfig, mode: String, outputLimit: Int64): Unit {
    let profile = reasoningProfile(cfg)
    let selected = effectiveReasoningMode(cfg, mode)
    var limit = outputLimit
    if (profile == "none") { payload.put("temperature", JsonFloat(0.3)) }
    if (selected != "default") {
        if (profile == "deepseek" || profile == "mimo") {
            let thinking = JsonObject()
            thinking.put("type", JsonString(if (selected == "off") { "disabled" } else { "enabled" }))
            payload.put("thinking", thinking)
            if (profile == "deepseek" && selected != "off") { payload.put("reasoning_effort", JsonString(selected)) }
        } else if (profile == "qwen-budget") {
            payload.put("enable_thinking", JsonBool(selected != "off"))
            if (selected != "off") {
                let budget: Int64 = if (selected == "low") { 2048 } else if (selected == "medium") { 8192 } else { 16384 }
                payload.put("thinking_budget", JsonInt(budget))
                limit = maxOf(limit, budget + 8192)
            }
        } else if (profile == "openai") {
            payload.put("reasoning_effort", JsonString(if (selected == "off") { "none" } else if (selected == "max") { "xhigh" } else { selected }))
        }
        if (selected != "off") {
            limit = maxOf(limit, if (selected == "low") { 16384 } else if (selected == "max") { 65536 } else { 32768 })
        }
    }
    if (profile != "none") {
        let streamOptions = JsonObject(); streamOptions.put("include_usage", JsonBool(true)); payload.put("stream_options", streamOptions)
    }
    if (limit > 0) { payload.put(if (profile == "openai") { "max_completion_tokens" } else { "max_tokens" }, JsonInt(limit)) }
}

func maxOf(a: Int64, b: Int64): Int64 { return if (a > b) { a } else { b } }
