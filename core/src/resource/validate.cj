package itn_desktop_core.resource

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.util.*

/*
 * 质检：把网页版三条"质量规则"（讲义 / 实操 / 分阶测试）翻译成仓颉，尽量逐条对齐。
 *
 * 一句话原则：**能客观判定的才当规则**。规则判不出来的东西（写得好不好、例子贴不贴切）
 * 不在这里装，交给返修提示词；这里只抓"缺斤短两"和"明显编造"：
 *   讲义：章节数、小节数、正文长度、空小节、模板占位话术、网页噪声、是否有具体示例
 *   实操：步骤数、步骤说明长度、预期结果、验收标准、故障排查、风险等级、是否有明确动作
 *   测试：题量、知识点、关联有效性、三档难度覆盖、题干唯一性、四个互不重复的选项、解析长度、答案分布
 *   演示：页数、每页要点数量、页面标题唯一性、是否给了讲稿
 * 阈值都留了"软化"：少量不足不报，明显缺稿才报——避免脆性失败把一次好生成判死。
 */

/** 中文字数（按字符计）：比字节长度更接近"读起来多长"。 */
func charLen(s: String): Int64 {
    return s.toArray().size
}

/** needle 在 text 里出现几次（切分比手写扫描稳，中文/英文都行）。 */
func countOccur(text: String, needle: String): Int64 {
    if (needle.size == 0 || text.size == 0) {
        return 0
    }
    return text.split(needle).size - 1
}

func strField(o: JsonObject, key: String): String {
    return trimStr(strOf(o, key))
}

func objsIn(o: JsonObject, key: String): ArrayList<JsonObject> {
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

func strListIn(o: JsonObject, key: String): ArrayList<String> {
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

func countOf(items: ArrayList<JsonObject>): Int64 {
    return items.size
}

/* ---------- 讲义 ---------- */

/** 模板占位话术：这些词一多，说明模型在凑字数而不是写内容。 */
func isBoilerplate(text: String): Bool {
    for (p in ["梳理主要机制", "结合一个典型案例", "掌握关键方法", "建立整体认知", "回顾本讲义的关键结论"]) {
        if (text.contains(p)) {
            return true
        }
    }
    return false
}

/** 网页噪声：抓回来的网页正文里常见的导航/署名/按钮文字。 */
func webNoiseHits(text: String): Int64 {
    if (text.size == 0) {
        return 0
    }
    var n: Int64 = 0
    let low = text.toAsciiLower()
    for (m in ["登录/注册", "关注作者", "控制台", "建议反馈", "社区首页", "skip to content", "you signed in",
        "reload to refresh", "copy path", "blame", "download raw file", "qq群", "公众号", "人浏览", "举报",
        "discord", "whatsapp", "相关推荐"]) {
        n = n + countOccur(low, m.toAsciiLower())
    }
    return n
}

public func lectureIssues(content: JsonObject, detail: String): ArrayList<String> {
    let issues = ArrayList<String>()
    let chapters = objsIn(content, "chapters")
    var sections = ArrayList<JsonObject>()
    for (c in chapters) {
        for (s in objsIn(c, "sections")) {
            sections.add(s)
        }
    }
    if (chapters.size == 0 && sections.size == 0) {
        issues.add("没有章节内容（模型可能没返回结构化讲义）")
        return issues
    }
    let texts = ArrayList<String>()
    for (s in sections) {
        texts.add(strField(s, "content"))
    }
    var total: Int64 = 0
    for (t in texts) {
        total = total + charLen(t)
    }
    if (chapters.size < detailMinChapters(detail)) {
        issues.add("章节不足（当前 " + chapters.size.toString() + " 章）")
    }
    let minSections = detailMinSections(detail)
    if (sections.size < minSections - 1) {
        issues.add("小节不足（当前 " + sections.size.toString() + " 节，至少 " + minSections.toString() + " 节）")
    }
    let minChars = detailMinChars(detail)
    if (total < minChars * 6 / 10) {
        issues.add("正文过短（当前 " + total.toString() + " 字，期望 " + minChars.toString() + " 字）")
    }
    var shortSections: Int64 = 0
    for (t in texts) {
        if (charLen(t) < 100) {
            shortSections = shortSections + 1
        }
    }
    if (shortSections > 0 && texts.size > 0 && shortSections * 2 > texts.size) {
        issues.add("有 " + shortSections.toString() + " 个小节少于 100 字")
    }
    var boiler: Int64 = 0
    for (t in texts) {
        if (isBoilerplate(t)) {
            boiler = boiler + 1
        }
    }
    if (boiler >= 3) {
        issues.add("包含 " + boiler.toString() + " 处模板占位话术")
    }
    var noise: Int64 = 0
    for (t in texts) {
        noise = noise + webNoiseHits(t)
    }
    for (s in sections) {
        noise = noise + webNoiseHits(strField(s, "title"))
    }
    if (noise >= 2) {
        issues.add("正文含有 " + noise.toString() + " 处网页模板或署名噪声")
    }
    // 具体性：至少提到三类"看得见的东西"（示例、输入输出、步骤、边界、验证…）
    var signals: Int64 = 0
    for (w in ["例如", "示例", "输入", "输出", "步骤", "流程", "代码", "配置", "错误", "限制", "边界", "验证"]) {
        var hit = false
        for (t in texts) {
            if (t.contains(w)) {
                hit = true
            }
        }
        if (hit) {
            signals = signals + 1
        }
    }
    if (signals < 3) {
        issues.add("缺少具体示例、过程、边界或验证方法")
    }
    return issues
}

/* ---------- 实操指南 ---------- */

public func practiceIssues(content: JsonObject): ArrayList<String> {
    let issues = ArrayList<String>()
    let steps = objsIn(content, "steps")
    if (steps.size == 0) {
        issues.add("没有可执行步骤（模型可能没返回结构化实操指南）")
        return issues
    }
    if (steps.size < 3) {
        issues.add("可执行步骤不足（当前 " + steps.size.toString() + " 步，至少 3 步）")
    }
    var short: Int64 = 0
    var missingOut: Int64 = 0
    var badSafety: Int64 = 0
    for (s in steps) {
        if (charLen(strField(s, "instruction")) < 90) {
            short = short + 1
        }
        if (charLen(strField(s, "expectedOutput")) < 10) {
            missingOut = missingOut + 1
        }
        let lv = strField(s, "safety")
        if (lv != "safe" && lv != "caution" && lv != "danger") {
            badSafety = badSafety + 1
        }
    }
    if (short > 0 && short * 2 > steps.size) {
        issues.add("有 " + short.toString() + " 个步骤说明过短")
    }
    if (missingOut > 0 && missingOut * 2 > steps.size) {
        issues.add("有 " + missingOut.toString() + " 个步骤缺少具体预期结果")
    }
    if (badSafety > 0) {
        issues.add("有 " + badSafety.toString() + " 个步骤缺少有效风险等级（safe/caution/danger）")
    }
    if (strListIn(content, "acceptanceCriteria").size < 2) {
        issues.add("可客观判定的验收标准不足 2 条")
    }
    if (objsIn(content, "troubleshooting").size < 1) {
        issues.add("故障排查不足 1 条")
    }
    var concrete = ""
    for (s in steps) {
        concrete = concrete + strField(s, "instruction") + " " + strField(s, "code") + " "
    }
    var acted = false
    for (w in ["输入", "执行", "点击", "运行", "保存", "输出", "检查", "打开", "填写", "对比"]) {
        if (concrete.contains(w)) {
            acted = true
        }
    }
    if (!acted) {
        issues.add("步骤缺少明确操作动作")
    }
    return issues
}

/* ---------- 分阶测试 ---------- */

func correctIndexIn(q: JsonObject): Int64 {
    match (q.get("correctIndex")) {
        case Some(v) =>
            match (v) {
                case j: JsonInt => return j.getValue()
                // 模型偶尔会写 "0"（字符串）或 1.0：这两种都当无效，逼它返修成整数
                case _ => return -1
            }
        case None => return -1
    }
}

public func quizIssues(content: JsonObject, expected: Int64): ArrayList<String> {
    let issues = ArrayList<String>()
    let kps = objsIn(content, "knowledgePoints")
    let questions = objsIn(content, "questions")
    if (questions.size == 0) {
        issues.add("没有题目（模型可能没返回结构化测试）")
        return issues
    }
    if (questions.size != expected) {
        issues.add("题量不正确（当前 " + questions.size.toString() + " 题，应为 " + expected.toString() + " 题）")
    }
    if (kps.size < 1) {
        issues.add("缺少明确知识点")
    }
    let kpIds = HashSet<String>()
    for (k in kps) {
        let id = strField(k, "id")
        if (id.size > 0) {
            kpIds.add(id)
        }
    }
    var badLinks: Int64 = 0
    for (q in questions) {
        if (!kpIds.contains(strField(q, "knowledgePointId"))) {
            badLinks = badLinks + 1
        }
    }
    if (badLinks > 0) {
        issues.add("有 " + badLinks.toString() + " 题没有关联有效知识点")
    }
    var hasEasy = false
    var hasMedium = false
    var hasHard = false
    for (q in questions) {
        let d = strField(q, "difficulty")
        if (d == "easy") {
            hasEasy = true
        } else if (d == "medium") {
            hasMedium = true
        } else if (d == "hard") {
            hasHard = true
        }
    }
    let missing = ArrayList<String>()
    if (!hasEasy) {
        missing.add("easy")
    }
    if (!hasMedium) {
        missing.add("medium")
    }
    if (!hasHard) {
        missing.add("hard")
    }
    // 题量少于 3 时不可能覆盖三档难度：这条规则只在题量够的时候生效
    if (missing.size > 0 && expected >= 3) {
        issues.add("难度覆盖不完整：" + joinWith(missing, "、"))
    }
    let stems = HashSet<String>()
    var dupStem: Int64 = 0
    var shortStem: Int64 = 0
    var badOptions: Int64 = 0
    var shortExplain: Int64 = 0
    var counts = Array<Int64>(4, repeat: 0)
    var invalidIndex: Int64 = 0
    for (q in questions) {
        let stem = strField(q, "stem")
        if (stems.contains(stem)) {
            dupStem = dupStem + 1
        }
        stems.add(stem)
        if (charLen(stem) < 12) {
            shortStem = shortStem + 1
        }
        let opts = strListIn(q, "options")
        let uniq = HashSet<String>()
        for (o in opts) {
            uniq.add(o)
        }
        if (opts.size != 4 || uniq.size != 4) {
            badOptions = badOptions + 1
        }
        if (charLen(strField(q, "explanation")) < 30) {
            shortExplain = shortExplain + 1
        }
        let ci = correctIndexIn(q)
        if (ci < 0 || ci > 3) {
            invalidIndex = invalidIndex + 1
        } else {
            counts[ci] = counts[ci] + 1
        }
    }
    if (dupStem > 0 || shortStem > 0) {
        issues.add("存在重复或信息不足的题干（重复 " + dupStem.toString() + "，过短 " + shortStem.toString() + "）")
    }
    if (badOptions > 0) {
        issues.add("有 " + badOptions.toString() + " 题未提供 4 个互不重复的选项")
    }
    if (shortExplain > 0) {
        issues.add("有 " + shortExplain.toString() + " 题解析过短")
    }
    if (invalidIndex > 0) {
        issues.add("存在无效正确答案索引")
    } else {
        var maxCount: Int64 = 0
        for (c in counts) {
            if (c > maxCount) {
                maxCount = c
            }
        }
        let limit = (questions.size + 1) / 2 + 1
        if (maxCount > limit && questions.size >= 3) {
            issues.add("正确答案位置分布过度集中（某一位置 " + maxCount.toString() + " 题）")
        }
    }
    return issues
}

/* ---------- 演示稿 ---------- */

public func pptIssues(content: JsonObject, expected: Int64): ArrayList<String> {
    let issues = ArrayList<String>()
    let slides = objsIn(content, "slides")
    if (slides.size == 0) {
        issues.add("没有幻灯片（模型可能没返回结构化演示稿）")
        return issues
    }
    if (slides.size != expected) {
        issues.add("页数不正确（当前 " + slides.size.toString() + " 页，应为 " + expected.toString() + " 页）")
    }
    var titles = HashSet<String>()
    var dupTitle: Int64 = 0
    var emptyBullets: Int64 = 0
    var manyBullets: Int64 = 0
    var noNote: Int64 = 0
    for (s in slides) {
        let t = strField(s, "title")
        if (titles.contains(t)) {
            dupTitle = dupTitle + 1
        }
        titles.add(t)
        let bullets = strListIn(s, "bullets")
        if (bullets.size == 0) {
            emptyBullets = emptyBullets + 1
        }
        if (bullets.size > 6) {
            manyBullets = manyBullets + 1
        }
        if (charLen(strField(s, "speakerNote")) < 10) {
            noNote = noNote + 1
        }
    }
    if (dupTitle > 0) {
        issues.add("有 " + dupTitle.toString() + " 页标题重复")
    }
    if (emptyBullets > 0) {
        issues.add("有 " + emptyBullets.toString() + " 页没有要点")
    }
    if (manyBullets > 0) {
        issues.add("有 " + manyBullets.toString() + " 页要点超过 6 条（一页放不下）")
    }
    if (noNote > 0 && noNote * 2 > slides.size) {
        issues.add("有 " + noNote.toString() + " 页缺少讲稿")
    }
    return issues
}

/* ---------- 统一入口 + 引用自检 ---------- */

public func qualityIssues(kind: String, content: JsonObject, detail: String, expected: Int64): ArrayList<String> {
    if (kind == "practice") {
        return practiceIssues(content)
    }
    if (kind == "quiz") {
        return quizIssues(content, expected)
    }
    if (kind == "ppt") {
        return pptIssues(content, expected)
    }
    return lectureIssues(content, detail)
}

/**
 * 引用自检：越界编号是"硬伤"（引用了不存在的资料），覆盖太低是"软伤"。
 *
 * 越界必须返修——那是编造出处的直接证据。覆盖低只提醒，不返修：
 * 有的资源本来就该以方法论为主，逼着每段都挂引用只会让模型硬凑。
 */
public func citationIssues(markdown: String, sourceCount: Int64): ArrayList<String> {
    let issues = ArrayList<String>()
    var outOfRange: Int64 = 0
    var paragraphs: Int64 = 0
    var cited: Int64 = 0
    for (block in markdown.split("\n\n")) {
        let t = trimStr(block)
        if (t.size == 0 || t.toArray()[0] == 35) {
            continue
        }
        paragraphs = paragraphs + 1
        let marks = scanCitationNumbers(t)
        if (marks.size > 0) {
            cited = cited + 1
        }
        for (m in marks) {
            if (m > sourceCount) {
                outOfRange = outOfRange + 1
            }
        }
    }
    if (outOfRange > 0) {
        issues.add("有 " + outOfRange.toString() + " 处引用了不存在的资料来源编号")
    }
    if (paragraphs >= 6 && cited * 5 < paragraphs) {
        issues.add("正文几乎没有标注出处（" + cited.toString() + "/" + paragraphs.toString() + " 段）")
    }
    return issues
}

/** 扫出正文里的 [n]（本机资料编号）。[Wn] 是网络来源，单独一套，这里不算。 */
public func scanCitationNumbers(text: String): ArrayList<Int64> {
    let out = ArrayList<Int64>()
    let b = text.toArray()
    var i = 0
    while (i < b.size) {
        if (b[i] == 91) {
            // '[' 后面紧跟数字、再跟 ']'
            var j = i + 1
            var num: Int64 = 0
            var digits: Int64 = 0
            while (j < b.size && b[j] >= 48 && b[j] <= 57) {
                num = num * 10 + Int64(b[j] - 48)
                digits = digits + 1
                j = j + 1
            }
            if (digits > 0 && j < b.size && b[j] == 93) {
                out.add(num)
                i = j + 1
                continue
            }
        }
        i = i + 1
    }
    return out
}
