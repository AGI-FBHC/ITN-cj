package itn_desktop_core.agent

import std.collection.*
import std.convert.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.tools.*
import itn_desktop_core.util.*

/**
 * 技能（Skill）：**使用能力的说明书**，不是代码。
 *
 * 一句话把边界说清：**工具是内核的能力（要升级内核），技能是用法说明（写个 Markdown 就行）**。
 *
 * 目录约定：
 * - 用户的技能：`<dataDir>/skills/<id>/SKILL.md`
 * - 随包内置：由外壳用 `--skills-dir` 指进来（只读，用户改不了）
 *
 * 四条规矩（对齐 docs/09 的提案）：
 * 1. **渐进披露**：启动只把清单（名字/描述/何时用）喂给模型，正文要用 `skill_read` 才读进来。
 * 2. **只编排不执行**：第一版不允许脚本，技能只能引用**内核已注册的工具**；`tools:` 之外一律拒绝并写事件。
 * 3. **要授权的明说**：`requires_consent: web` 的技能在"不联网"档位下直接标成不可用。
 * 4. **失败要说人话**：技能没写清楚就列出来但标原因，不静默吞掉。
 */
public class SkillInfo {
    public var id: String = ""
    public var name: String = ""
    public var title: String = ""
    public var description: String = ""
    public var whenToUse: String = ""
    public var tools: ArrayList<String> = ArrayList<String>()
    public var requiresConsent: String = ""
    public var source: String = "user"      // user | bundled
    public var path: String = ""
    public var available: Bool = true
    public var reason: String = ""
}

/** 内置技能目录（外壳通过 --skills-dir 指进来）。空串表示没有。 */
public var SKILLS_BUNDLED_DIR: String = ""

public func userSkillsDir(dataDir: String): String {
    return dataDir + Path.Separator + "skills"
}

public func skillBodyPath(dir: String, id: String): String {
    return dir + Path.Separator + id + Path.Separator + "SKILL.md"
}

/** 取 frontmatter（--- 开头到下一个 ---）与正文。 */
func splitFrontmatter(raw: String): (String, String) {
    let lines = splitLines(raw)
    if (lines.size == 0) {
        return ("", raw)
    }
    if (trimStr(lines[0]) != "---") {
        return ("", raw)
    }
    let fm = StringBuilder()
    var i = 1
    while (i < lines.size) {
        let l = trimStr(lines[i])
        if (l == "---") {
            i = i + 1
            break
        }
        fm.append(lines[i])
        fm.append("\n")
        i = i + 1
    }
    let body = StringBuilder()
    while (i < lines.size) {
        body.append(lines[i])
        body.append("\n")
        i = i + 1
    }
    return (fm.toString(), body.toString())
}

func fmGet(fm: String, key: String): String {
    for (line in fm.split("\n")) {
        let l = trimStr(line)
        if (hasPrefix(l, key + ":")) {
            let b = l.toArray()
            var v = trimStr(String.fromUtf8(b[(key.size + 1)..b.size]))
            // 去掉两端的引号：YAML 里写 "联网研究" 也很常见
            if (v.size >= 2 && (v.toArray()[0] == 34 || v.toArray()[0] == 39)) {
                let q = v.toArray()[0]
                if (v.toArray()[v.size - 1] == q) {
                    v = String.fromUtf8(v.toArray()[1..(v.size - 1)])
                }
            }
            return v
        }
    }
    return ""
}

/** tools 支持两种写法：`tools: [kb_search, web_fetch]` 或下面跟一串 `- kb_search`。 */
func fmTools(fm: String): ArrayList<String> {
    let out = ArrayList<String>()
    let inline = fmGet(fm, "tools")
    if (inline.size > 0) {
        var t = inline
        if (hasPrefix(t, "[")) {
            t = String.fromUtf8(t.toArray()[1..t.size])
        }
        for (p in t.split(",")) {
            var q = trimStr(p)
            if (hasSuffix(q, "]")) {
                q = String.fromUtf8(q.toArray()[0..(q.size - 1)])
            }
            q = trimStr(q)
            if (q.size > 0) {
                out.add(q)
            }
        }
        if (out.size > 0) {
            return out
        }
    }
    // 列表形态：只在 frontmatter 里、紧跟在 tools: 之后的 - 行
    var inTools = false
    for (line in fm.split("\n")) {
        let l = trimStr(line)
        if (hasPrefix(l, "tools:")) {
            inTools = true
            continue
        }
        if (inTools) {
            if (hasPrefix(l, "- ")) {
                out.add(trimStr(String.fromUtf8(l.toArray()[2..l.size])))
            } else if (l.size > 0) {
                inTools = false
            }
        }
    }
    return out
}

func loadSkillAt(id: String, dir: String, source: String): ?SkillInfo {
    let p = skillBodyPath(dir, id)
    if (!exists(p)) {
        return None
    }
    let raw = readTextOr(p, "")
    let pair = splitFrontmatter(raw)
    let fm = pair[0]
    let info = SkillInfo()
    info.id = id
    info.path = p
    info.source = source
    info.name = fmGet(fm, "name")
    if (info.name.size == 0) {
        info.name = id
    }
    info.title = fmGet(fm, "title")
    if (info.title.size == 0) {
        info.title = info.name
    }
    info.description = fmGet(fm, "description")
    info.whenToUse = fmGet(fm, "when_to_use")
    info.tools = fmTools(fm)
    info.requiresConsent = fmGet(fm, "requires_consent")
    return Some(info)
}

func scanSkillDir(dir: String, source: String, out: ArrayList<SkillInfo>): Unit {
    if (!exists(dir)) {
        return
    }
    try {
        Directory.walk(Path(dir), { fi: FileInfo =>
            if (fi.isDirectory()) {
                match (loadSkillAt(fi.name, dir, source)) {
                    case Some(info) => out.add(info)
                    case None => ()
                }
                false   // 技能目录不往下递归：一层一个技能
            } else {
                false
            }
        })
    } catch (e: Exception) {
        ()
    }
}

/** 列出全部技能：用户的在前，内置的在后；重名以用户为准。 */
public func listSkills(dataDir: String, webAllowed: Bool): ArrayList<SkillInfo> {
    let out = ArrayList<SkillInfo>()
    scanSkillDir(userSkillsDir(dataDir), "user", out)
    if (SKILLS_BUNDLED_DIR.size > 0) {
        let extra = ArrayList<SkillInfo>()
        scanSkillDir(SKILLS_BUNDLED_DIR, "bundled", extra)
        for (s in extra) {
            var dup = false
            for (t in out) {
                if (t.id == s.id) {
                    dup = true
                }
            }
            if (!dup) {
                out.add(s)
            }
        }
    }
    for (s in out) {
        // 要授权的技能在"不联网"档位下不可用：界面标出来，别让它点了没反应
        if (s.requiresConsent.split("web").size > 1 && !webAllowed) {
            s.available = false
            s.reason = "这个技能要用网络，而当前是「不联网」"
        }
        if (s.tools.size == 0) {
            s.available = false
            if (s.reason.size == 0) {
                s.reason = "技能没有声明 tools（只能引用内核已注册的工具）"
            }
        }
    }
    return out
}

public func findSkill(dataDir: String, id: String, webAllowed: Bool): ?SkillInfo {
    for (s in listSkills(dataDir, webAllowed)) {
        if (s.id == id || s.name == id || s.title == id) {
            return Some(s)
        }
    }
    return None
}

/** 读技能正文（渐进披露的第二步）。返回 (info, body)。 */
public func readSkill(dataDir: String, id: String, webAllowed: Bool): ?(SkillInfo, String) {
    match (findSkill(dataDir, id, webAllowed)) {
        case Some(info) =>
            let raw = readTextOr(info.path, "")
            let body = splitFrontmatter(raw)[1]
            return Some((info, body))
        case None => return None
    }
}

public func skillJson(s: SkillInfo): JsonObject {
    let o = JsonObject()
    o.put("id", JsonString(s.id))
    o.put("name", JsonString(s.name))
    o.put("title", JsonString(s.title))
    o.put("description", JsonString(s.description))
    o.put("whenToUse", JsonString(s.whenToUse))
    let ts = JsonArray()
    for (t in s.tools) {
        ts.add(JsonString(t))
    }
    o.put("tools", ts)
    o.put("requiresConsent", JsonString(s.requiresConsent))
    o.put("source", JsonString(s.source))
    o.put("path", JsonString(s.path))
    o.put("available", JsonBool(s.available))
    o.put("reason", JsonString(s.reason))
    return o
}

/** 给模型看的技能清单：只有"名字 + 什么时候用"，正文要用 skill_read 才读。 */
public func skillPrompt(dataDir: String, webAllowed: Bool): String {
    let list = listSkills(dataDir, webAllowed)
    let usable = ArrayList<SkillInfo>()
    for (s in list) {
        if (s.available) {
            usable.add(s)
        }
    }
    if (usable.size == 0) {
        return ""
    }
    let sb = StringBuilder()
    sb.append("\n可用技能（需要时先用 skill_read 读它的正文，再按里面的步骤做）：\n")
    for (s in usable) {
        sb.append("- ")
        sb.append(s.id)
        sb.append("：")
        sb.append(s.title)
        if (s.description.size > 0) {
            sb.append("——")
            sb.append(s.description)
        }
        if (s.whenToUse.size > 0) {
            sb.append("（什么时候用：")
            sb.append(s.whenToUse)
            sb.append("）")
        }
        if (s.tools.size > 0) {
            sb.append("，可用工具：")
            sb.append(joinWith(s.tools, "/"))
        }
        sb.append("\n")
    }
    return sb.toString()
}

/** 写一个模板技能（设置页那个"新建示例技能"用它），已存在就不动。 */
public func writeTemplateSkill(dataDir: String, id: String): String {
    let dir = userSkillsDir(dataDir) + Path.Separator + id
    ensureDir(dir)
    let p = dir + Path.Separator + "SKILL.md"
    if (exists(p)) {
        return p
    }
    let body = "---\n" +
        "name: " + id + "\n" +
        "title: 示例技能\n" +
        "description: 一句话说清这个技能是干什么的\n" +
        "when_to_use: 用户说要「按这个流程做」的时候\n" +
        "tools: [kb_search, save_note]\n" +
        "requires_consent:\n" +
        "---\n\n" +
        "# 示例技能\n\n" +
        "把步骤写成人能看懂的话，模型会照着做。允许出现的工具只有上面 tools 里列的那些。\n\n" +
        "1. 先用 kb_search 把相关资料找出来，把命中的切片编号记下来。\n" +
        "2. 按资料给出结论，每条结论后面标 [编号]。\n" +
        "3. 需要留痕就用 save_note 写一条笔记。\n"
    writeText(p, body)
    return p
}
