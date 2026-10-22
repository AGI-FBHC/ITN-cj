package lumin.pi

import std.collection.*
import std.fs.*
import stdx.encoding.json.*

/*
 * Skills：照 Agent Skills 规范（agentskills.io 那套，Codex / Pi 都在用）。
 *
 * 一个 skill = 一个目录，里面有 SKILL.md，开头是 frontmatter：
 *   ---
 *   name: pdf-tools
 *   description: Extract text and tables from PDF files. Use when reading or converting PDFs.
 *   disable-model-invocation: true     # 可选：只允许用户显式触发
 *   ---
 *
 * 装载策略是 Pi 的关键设计：启动时只把 name / description / location 播给模型（省上下文），
 * 正文等模型判断"这个任务用得上"时再用 read 工具去读。description 写得好不好直接决定命中率。
 */

public class Skill {
    public var name: String = ""
    public var description: String = ""
    /** SKILL.md 的路径（给模型去 read） */
    public var path: String = ""
    public var disableModelInvocation: Bool = false
}

const MAX_NAME_LENGTH: Int64 = 64
const MAX_DESCRIPTION_LENGTH: Int64 = 1024
const MAX_SKILL_DEPTH: Int64 = 4

/** 从若干根目录里扫描 skills（同名以先出现的为准）。 */
public func loadSkills(roots: ArrayList<String>): ArrayList<Skill> {
    let out = ArrayList<Skill>()
    for (root in roots) {
        scanSkillDir(root, 0, out)
    }
    return out
}

func scanSkillDir(dir: String, depth: Int64, out: ArrayList<Skill>): Unit {
    if (depth > MAX_SKILL_DEPTH || !exists(dir)) {
        return
    }
    let skillFile = dir + "/SKILL.md"
    if (exists(skillFile)) {
        match (parseSkill(dir, skillFile)) {
            case Some(s) => out.add(s)
            case None => ()
        }
        return
    }
    let names = ArrayList<String>()
    try {
        Directory.walk(Path(dir), { fi: FileInfo =>
            if (fi.isDirectory()) {
                let nm = fi.name
                let nb = nm.toArray()
                if (nb.size > 0 && nb[0] != 46 && nm != "node_modules" && nm != "target" && nm != "dist") {
                    names.add(nm)
                }
            }
            true
        })
    } catch (e: Exception) {
        ()
    }
    for (nm in names) {
        scanSkillDir(dir + "/" + nm, depth + 1, out)
    }
}

func parseSkill(dir: String, path: String): ?Skill {
    var text = ""
    try {
        text = safeUtf8(File.readFrom(path), 0, 64 * 1024)
    } catch (e: Exception) {
        return None
    }
    let lines = splitLines(text)
    var i: Int64 = 0
    // 找 frontmatter 起始
    while (i < lines.size && trimStr(lines[i]).size == 0) {
        i = i + 1
    }
    if (i >= lines.size || trimStr(lines[i]) != "---") {
        return None
    }
    i = i + 1
    let s = Skill()
    s.path = path
    var closed = false
    while (i < lines.size) {
        let t = trimStr(lines[i])
        if (t == "---") {
            closed = true
            break
        }
        let c = indexOfSub(t, ":")
        if (c > 0) {
            let k = trimStr(safeUtf8(t.toArray(), 0, c))
            let v = trimStr(safeUtf8(t.toArray(), c + 1, t.size))
            if (k == "name") {
                s.name = v
            } else if (k == "description") {
                s.description = v
            } else if (k == "disable-model-invocation") {
                s.disableModelInvocation = (v == "true")
            }
        }
        i = i + 1
    }
    if (!closed || s.name.size == 0 || s.name.size > MAX_NAME_LENGTH) {
        return None
    }
    if (s.description.size == 0 || s.description.size > MAX_DESCRIPTION_LENGTH) {
        return None
    }
    if (!exists(dir)) {
        return None
    }
    return s
}

/** 播给模型的那段（形状与 Pi 一致，模型是照着 location 去 read 的）。 */
public func formatSkillsForPrompt(skills: ArrayList<Skill>): String {
    let sb = StringBuilder()
    var n = 0
    for (s in skills) {
        if (s.disableModelInvocation) {
            continue
        }
        n = n + 1
    }
    if (n == 0) {
        return ""
    }
    sb.append("\n\nThe following skills provide specialized instructions for specific tasks.")
    sb.append("\nUse the read tool to load a skill's file when the task matches its description.")
    sb.append("\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.")
    sb.append("\n\n<available_skills>")
    for (s in skills) {
        if (s.disableModelInvocation) {
            continue
        }
        sb.append("\n  <skill>")
        sb.append("\n    <name>" + escapeXml(s.name) + "</name>")
        sb.append("\n    <description>" + escapeXml(s.description) + "</description>")
        sb.append("\n    <location>" + escapeXml(s.path) + "</location>")
        sb.append("\n  </skill>")
    }
    sb.append("\n</available_skills>")
    return sb.toString()
}

public func findSkill(skills: ArrayList<Skill>, name: String): ?Skill {
    for (s in skills) {
        if (s.name == name) {
            return Some(s)
        }
    }
    return None
}

func escapeXml(s: String): String {
    var out = ""
    let b = s.toArray()
    var i = 0
    while (i < b.size) {
        let c = b[i]
        if (c == 38) {
            out = out + "&amp;"
        } else if (c == 60) {
            out = out + "&lt;"
        } else if (c == 62) {
            out = out + "&gt;"
        } else if (c == 34) {
            out = out + "&quot;"
        } else if (c < 128) {
            out = out + String.fromUtf8(b[i..i + 1])
        } else {
            let n = utf8CharLen(c)
            var j = i + n
            if (j > b.size) {
                j = b.size
            }
            out = out + String.fromUtf8(b[i..j])
            i = j
            continue
        }
        i = i + 1
    }
    return out
}
