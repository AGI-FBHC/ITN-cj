package itn_desktop_core.resource

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.util.*

/*
 * 渲染：结构化内容 → 可读的 Markdown 产物。
 *
 * 为什么不在"写作"那一步直接让模型写 Markdown：那样质检没法做（判不出章节数、题量、选项唯一性），
 * 也没法返修某一处。所以先要结构（JSON），再由这里渲染成文；渲染是纯函数，可单测、可预测。
 * 出处附录沿用内核既有格式（## 资料来源 + - [n] 《标题》· 小节（路径）），界面与播放器都认得。
 */

func txt(o: JsonObject, key: String): String {
    return trimStr(strOf(o, key))
}

func listOf(o: JsonObject, key: String): ArrayList<String> {
    let out = ArrayList<String>()
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case arr: JsonArray =>
                    var i = 0
                    while (i < arr.size()) {
                        let t = trimStr(strValue(arr[i]))
                        if (t.size > 0) {
                            out.add(t)
                        }
                        i = i + 1
                    }
                case _ => ()
            }
        case None => ()
    }
    return out
}

func objsOf(o: JsonObject, key: String): ArrayList<JsonObject> {
    let out = ArrayList<JsonObject>()
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case arr: JsonArray =>
                    var i = 0
                    while (i < arr.size()) {
                        match (objOf(arr[i])) {
                            case Some(x) => out.add(x)
                            case None => ()
                        }
                        i = i + 1
                    }
                case _ => ()
            }
        case None => ()
    }
    return out
}

/** 出处附录：正文之后统一挂在这里，编号与正文里的 [n] 一一对应。 */
func appendSources(full: StringBuilder, sources: JsonArray): Unit {
    appendSourcesAs(full, sources, true)
}

/**
 * asHeading=false 时用加粗小标题。
 * 放映类产物（演示稿）必须这样：播放器按二级标题分页，用 ## 会把"资料来源"变成一页幻灯片。
 */
func appendSourcesAs(full: StringBuilder, sources: JsonArray, asHeading: Bool): Unit {
    full.append("\n\n---\n\n")
    full.append(if (asHeading) { "## 资料来源" } else { "**资料来源**" })
    full.append("\n\n")
    if (sources.size() == 0) {
        full.append("（本次没有可引用的本机资料：内容属于通用框架，未标注出处。）\n")
        return
    }
    var i = 0
    while (i < sources.size()) {
        match (objOf(sources[i])) {
            case Some(h) =>
                full.append("- [")
                full.append((i + 1).toString())
                full.append("] 《")
                full.append(strOf(h, "docTitle"))
                full.append("》")
                let hp = strOf(h, "headingPath")
                if (hp.size > 0) {
                    full.append(" · ")
                    full.append(hp)
                }
                full.append("（")
                full.append(strOf(h, "docPath"))
                full.append("）\n")
            case None => ()
        }
        i = i + 1
    }
}

/* ---------- 讲义 ---------- */

public func renderLecture(content: JsonObject, sources: JsonArray): String {
    let sb = StringBuilder()
    let title = if (txt(content, "title").size > 0) { txt(content, "title") } else { "定制讲义" }
    sb.append("# ")
    sb.append(title)
    sb.append("\n\n")
    let objective = txt(content, "objective")
    if (objective.size > 0) {
        sb.append("> ")
        sb.append(objective)
        sb.append("\n\n")
    }
    let kps = listOf(content, "objectives")
    if (kps.size > 0) {
        sb.append("**学完这一份，你应该能：**\n\n")
        for (k in kps) {
            sb.append("- ")
            sb.append(k)
            sb.append("\n")
        }
        sb.append("\n")
    }
    let chapters = objsOf(content, "chapters")
    var ci: Int64 = 0
    for (c in chapters) {
        ci = ci + 1
        sb.append("## 第 ")
        sb.append(ci.toString())
        sb.append(" 章 ")
        sb.append(if (txt(c, "title").size > 0) { txt(c, "title") } else { "未命名" })
        sb.append("\n\n")
        let intro = txt(c, "introduction")
        if (intro.size > 0) {
            sb.append(intro)
            sb.append("\n\n")
        }
        for (s in objsOf(c, "sections")) {
            sb.append("### ")
            sb.append(if (txt(s, "title").size > 0) { txt(s, "title") } else { "未命名小节" })
            sb.append("\n\n")
            sb.append(txt(s, "content"))
            sb.append("\n\n")
        }
        let summary = txt(c, "summary")
        if (summary.size > 0) {
            sb.append("**本章小结：**")
            sb.append(summary)
            sb.append("\n\n")
        }
    }
    appendSources(sb, sources)
    return sb.toString()
}

/* ---------- 实操指南 ---------- */

func safetyText(level: String): String {
    if (level == "danger") {
        return "高风险：会改动真实数据/环境，先备份、先在测试环境走一遍"
    }
    if (level == "caution") {
        return "注意：有可能覆盖文件或改变状态"
    }
    return "安全：可放心执行"
}

public func renderPractice(content: JsonObject, sources: JsonArray): String {
    let sb = StringBuilder()
    let title = if (txt(content, "title").size > 0) { txt(content, "title") } else { "实操指南" }
    sb.append("# ")
    sb.append(title)
    sb.append("\n\n")
    let objective = txt(content, "objective")
    if (objective.size > 0) {
        sb.append("**目标：**")
        sb.append(objective)
        sb.append("\n\n")
    }
    let minutes = intOf(content, "estimatedMinutes")
    if (minutes > 0) {
        sb.append("**预计用时：**")
        sb.append(minutes.toString())
        sb.append(" 分钟\n\n")
    }
    let pre = listOf(content, "prerequisites")
    if (pre.size > 0) {
        sb.append("**前置条件**\n\n")
        for (x in pre) {
            sb.append("- ")
            sb.append(x)
            sb.append("\n")
        }
        sb.append("\n")
    }
    let env = listOf(content, "environment")
    if (env.size > 0) {
        sb.append("**环境准备**\n\n")
        for (x in env) {
            sb.append("- ")
            sb.append(x)
            sb.append("\n")
        }
        sb.append("\n")
    }
    var si: Int64 = 0
    for (s in objsOf(content, "steps")) {
        si = si + 1
        sb.append("## 步骤 ")
        sb.append(si.toString())
        sb.append("：")
        sb.append(if (txt(s, "title").size > 0) { txt(s, "title") } else { "未命名步骤" })
        sb.append("\n\n")
        sb.append("**怎么做：**")
        sb.append(txt(s, "instruction"))
        sb.append("\n\n")
        let code = txt(s, "code")
        if (code.size > 0) {
            sb.append("```\n")
            sb.append(code)
            sb.append("\n```\n\n")
        }
        let out = txt(s, "expectedOutput")
        if (out.size > 0) {
            sb.append("**预期结果：**")
            sb.append(out)
            sb.append("\n\n")
        }
        sb.append("**风险等级：**")
        sb.append(safetyText(txt(s, "safety")))
        sb.append("\n\n")
        let warning = txt(s, "warning")
        if (warning.size > 0) {
            sb.append("> 提醒：")
            sb.append(warning)
            sb.append("\n\n")
        }
    }
    let criteria = listOf(content, "acceptanceCriteria")
    if (criteria.size > 0) {
        sb.append("## 验收标准\n\n")
        for (x in criteria) {
            sb.append("- [ ] ")
            sb.append(x)
            sb.append("\n")
        }
        sb.append("\n")
    }
    let checklist = listOf(content, "safetyChecklist")
    if (checklist.size > 0) {
        sb.append("## 安全清单\n\n")
        for (x in checklist) {
            sb.append("- [ ] ")
            sb.append(x)
            sb.append("\n")
        }
        sb.append("\n")
    }
    let notice = txt(content, "safetyNotice")
    if (notice.size > 0) {
        sb.append("> ")
        sb.append(notice)
        sb.append("\n\n")
    }
    let trouble = objsOf(content, "troubleshooting")
    if (trouble.size > 0) {
        sb.append("## 常见问题\n\n")
        for (t in trouble) {
            sb.append("- **")
            sb.append(txt(t, "problem"))
            sb.append("** → ")
            sb.append(txt(t, "solution"))
            sb.append("\n")
        }
        sb.append("\n")
    }
    let challenge = txt(content, "challenge")
    if (challenge.size > 0) {
        sb.append("## 加练\n\n")
        sb.append(challenge)
        sb.append("\n\n")
    }
    appendSources(sb, sources)
    return sb.toString()
}

/* ---------- 分阶测试 ---------- */

func difficultyText(d: String): String {
    if (d == "hard") {
        return "难"
    }
    if (d == "medium") {
        return "中"
    }
    return "易"
}

/** 选择题渲染成"题干 + 选项 + 答案 + 解析"，错题本与重做流程都认这个形状。 */
public func renderQuiz(content: JsonObject, sources: JsonArray): String {
    let sb = StringBuilder()
    let title = if (txt(content, "title").size > 0) { txt(content, "title") } else { "分阶测试" }
    sb.append("# ")
    sb.append(title)
    sb.append("\n\n")
    let kps = objsOf(content, "knowledgePoints")
    if (kps.size > 0) {
        sb.append("**覆盖的知识点**\n\n")
        for (k in kps) {
            sb.append("- ")
            sb.append(txt(k, "name"))
            let desc = txt(k, "description")
            if (desc.size > 0) {
                sb.append("：")
                sb.append(desc)
            }
            sb.append("\n")
        }
        sb.append("\n")
    }
    var qi: Int64 = 0
    for (q in objsOf(content, "questions")) {
        qi = qi + 1
        sb.append("### 第 ")
        sb.append(qi.toString())
        sb.append(" 题（")
        sb.append(difficultyText(txt(q, "difficulty")))
        sb.append("）\n\n")
        sb.append(txt(q, "stem"))
        sb.append("\n\n")
        let opts = listOf(q, "options")
        var oi = 0
        while (oi < opts.size) {
            sb.append("- ")
            sb.append(letterAt(oi))
            sb.append(". ")
            sb.append(opts[oi])
            sb.append("\n")
            oi = oi + 1
        }
        sb.append("\n")
        let ci = correctIndexOf(q)
        sb.append("**答案：**")
        if (ci >= 0 && ci < opts.size) {
            sb.append(letterAt(ci))
        } else {
            sb.append("—")
        }
        sb.append("\n\n")
        sb.append("**解析：**")
        sb.append(txt(q, "explanation"))
        sb.append("\n\n")
    }
    appendSources(sb, sources)
    return sb.toString()
}

func letterAt(i: Int64): String {
    let letters: Array<String> = ["A", "B", "C", "D"]
    if (i < 0 || i >= letters.size) {
        return "?"
    }
    return letters[i]
}

func correctIndexOf(q: JsonObject): Int64 {
    match (q.get("correctIndex")) {
        case Some(v) =>
            match (v) {
                case j: JsonInt => return j.getValue()
                case _ => return -1
            }
        case None => return -1
    }
}

/* ---------- 演示稿 ---------- */

/**
 * 演示稿渲染成"幻灯片 Markdown"：一级标题是主题，二级标题是一页，要点是列表项。
 * 桌面播放器按二级标题分页（与既有产物一致），所以这里必须保持这个约定。
 */
public func renderPpt(content: JsonObject, sources: JsonArray): String {
    let sb = StringBuilder()
    let title = if (txt(content, "title").size > 0) { txt(content, "title") } else { "演示稿" }
    sb.append("# ")
    sb.append(title)
    sb.append("\n\n")
    let subtitle = txt(content, "subtitle")
    if (subtitle.size > 0) {
        sb.append("> ")
        sb.append(subtitle)
        sb.append("\n\n")
    }
    let slides = objsOf(content, "slides")
    var i = 0
    while (i < slides.size) {
        let s = slides[i]
        sb.append("## ")
        sb.append(if (txt(s, "title").size > 0) { txt(s, "title") } else { "第 " + (i + 1).toString() + " 页" })
        sb.append("\n\n")
        for (b in listOf(s, "bullets")) {
            sb.append("- ")
            sb.append(b)
            sb.append("\n")
        }
        sb.append("\n")
        let note = txt(s, "speakerNote")
        if (note.size > 0) {
            sb.append("> 讲稿：")
            sb.append(note)
            sb.append("\n\n")
        }
        i = i + 1
    }
    appendSourcesAs(sb, sources, false)
    return sb.toString()
}

public func renderResource(kind: String, content: JsonObject, sources: JsonArray): String {
    if (kind == "practice") {
        return renderPractice(content, sources)
    }
    if (kind == "quiz") {
        return renderQuiz(content, sources)
    }
    if (kind == "ppt") {
        return renderPpt(content, sources)
    }
    return renderLecture(content, sources)
}
