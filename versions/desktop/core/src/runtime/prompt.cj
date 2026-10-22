package itn_desktop_core.runtime

import std.collection.*
import stdx.encoding.json.*

/*
 * 系统提示词：按 section 组装（Pi 的做法）。
 * 组装结果既发给模型，也作为一条 system 消息存进会话——回放会话时能看到"当时用的提示词长什么样"。
 *
 * 注意：工具声明**不**在这里（在请求的 tools 字段里，原生 function calling）。
 * 这里只放"有哪些工具"的清单与使用要点，Pi 也是这么分的。
 */

public func buildSystemPrompt(preamble: String, tools: ArrayList<ToolSpec>, skillsText: String, cwd: String): String {
    let sb = StringBuilder()
    if (preamble.size > 0) {
        sb.append(preamble)
        sb.append("\n\n")
    }
    if (tools.size > 0) {
        sb.append("<tools>\n")
        for (t in tools) {
            sb.append("- ")
            sb.append(t.name)
            sb.append(": ")
            sb.append(if (t.snippet.size > 0) { t.snippet } else { t.description })
            sb.append("\n")
        }
        var hasGuide = false
        for (t in tools) {
            if (t.guidelines.size > 0) {
                hasGuide = true
            }
        }
        if (hasGuide) {
            sb.append("\n要点：\n")
            for (t in tools) {
                for (g in t.guidelines) {
                    sb.append("- ")
                    sb.append(g)
                    sb.append("\n")
                }
            }
        }
        sb.append("</tools>")
    }
    if (skillsText.size > 0) {
        sb.append(skillsText)
    }
    if (cwd.size > 0) {
        sb.append("\n\nWorking directory: ")
        sb.append(cwd)
        sb.append("\nAll paths you pass to tools are relative to this working directory. Do not prefix them with it" +
            " (for example pass \"readme.md\", not \"<workspace>/readme.md\").")
        sb.append("\nWhen you create or change a file, tell the user its path relative to this working directory, " +
            "and do not claim the file is somewhere else. .env / .git / .ssh are off limits.")
    }
    return sb.toString()
}

/** 压缩时用的系统提示词（让摘要"能接着干"，而不是复述）。 */
public func compactPrompt(): String {
    return "把下面这段对话压缩成要点摘要：保留结论、决定、涉及的文件路径、未完成事项与用户偏好；" +
        "不要评论、不要客套，直接给摘要。摘要要让后续对话不必回看原文就能接着干。"
}

/** 存进会话的 section 快照。 */
public func promptSections(preamble: String, tools: ArrayList<ToolSpec>, skillsText: String, cwd: String): JsonObject {
    let o = JsonObject()
    o.put("preamble", JsonString(preamble))
    let tl = JsonArray()
    for (t in tools) {
        tl.add(JsonString(t.name + ": " + t.snippet))
    }
    o.put("tools", tl)
    o.put("skills", JsonString(skillsText))
    o.put("cwd", JsonString(cwd))
    return o
}
