package xbot.cli

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import xbot.pi.*

/*
 * 项目信任（照 Pi 的 project trust）：
 *
 *   <dataDir>/trust.json = { "<规范化目录>": true|false }
 *   判断时**从当前目录往上找最近的祖先决定**（Pi 的 findNearestTrustEntry 语义）——
 *   信任了父目录，子目录跟着信任；"只信任这一次"不落盘。
 *
 * 和 Pi 的差别：Pi 的 trust 管的是"要不要加载项目里的 settings/extensions"（可执行代码），
 * 工具本身用进程的系统权限；我们这里 trust 还顺带决定**给不给工具**（不信任 = 纯对话），
 * 因为我们没有进程级沙箱，这是更保守的默认。
 */

/** 信任表里的一条：目录 -> 是否信任。 */
public class TrustEntry {
    public var path: String = ""
    public var trusted: Bool = false
}

public class TrustDecision {
    /** 是否信任 */
    public var trusted: Bool = false
    /** 依据哪个目录/参数得出的结论（给界面显示） */
    public var source: String = ""
    /** 有没有明确的决定（false 表示"问过但用户没记住"或"从没问过"） */
    public var decided: Bool = false
    /** 这次是"仅本次" */
    public var sessionOnly: Bool = false
}

func trustFile(dataDir: String): String {
    return dataDir + "/trust.json"
}

/** 取父目录（到根为止）。 */
public func parentOf(path: String): String {
    let p = trimStr(path)
    let b = p.toArray()
    var end = b.size
    while (end > 0 && (b[end - 1] == 47 || b[end - 1] == 92)) {
        end = end - 1
    }
    var i = end
    while (i > 0) {
        if (b[i - 1] == 47 || b[i - 1] == 92) {
            let parent = safeUtf8(b, 0, i - 1)
            if (parent.size == 0) {
                return safeUtf8(b, 0, i)
            }
            return parent
        }
        i = i - 1
    }
    return p
}

public func loadTrust(dataDir: String): ArrayList<TrustEntry> {
    let out = ArrayList<TrustEntry>()
    var text = ""
    try {
        text = safeUtf8(File.readFrom(trustFile(dataDir)), 0, 1024 * 1024)
    } catch (e: Exception) {
        return out
    }
    let t = trimStr(text)
    if (t.size == 0) {
        return out
    }
    try {
        match (JsonValue.fromStr(t)) {
            case root: JsonObject =>
                for ((k, v) in root.getFields()) {
                    match (v) {
                        case b: JsonBool =>
                            let e = TrustEntry()
                            e.path = k
                            e.trusted = b.getValue()
                            out.add(e)
                        case _ => ()
                    }
                }
            case _ => ()
        }
    } catch (e: Exception) {
        ()
    }
    return out
}

public func saveTrust(dataDir: String, list: ArrayList<TrustEntry>): Unit {
    let root = JsonObject()
    for (e in list) {
        root.put(e.path, JsonBool(e.trusted))
    }
    if (!exists(dataDir)) {
        try {
            Directory.create(dataDir, recursive: true)
        } catch (e: Exception) {
            return
        }
    }
    try {
        File.writeTo(trustFile(dataDir), root.toString().toArray())
    } catch (e: Exception) {
        ()
    }
}

/** 向上找最近的祖先决定（Pi 的语义）。 */
public func findTrust(dataDir: String, path: String): TrustDecision {
    let d = TrustDecision()
    let list = loadTrust(dataDir)
    var cur = absPath(path)
    var guard: Int64 = 0
    while (cur.size > 0 && guard < 200) {
        guard = guard + 1
        for (e in list) {
            if (e.path == cur) {
                d.trusted = e.trusted
                d.source = cur
                d.decided = true
                return d
            }
        }
        let up = parentOf(cur)
        if (up == cur) {
            break
        }
        cur = up
    }
    return d
}

/** 记录决定（sessionOnly 不落盘）。 */
public func setTrust(dataDir: String, path: String, trusted: Bool, sessionOnly: Bool): Unit {
    if (sessionOnly) {
        return
    }
    let full = absPath(path)
    let list = loadTrust(dataDir)
    let keep = ArrayList<TrustEntry>()
    for (e in list) {
        if (e.path != full) {
            keep.add(e)
        }
    }
    let e = TrustEntry()
    e.path = full
    e.trusted = trusted
    keep.add(e)
    saveTrust(dataDir, keep)
}

/** 撤销某目录的决定（回到"没问过"）。 */
public func clearTrust(dataDir: String, path: String): Bool {
    let full = absPath(path)
    let list = loadTrust(dataDir)
    let keep = ArrayList<TrustEntry>()
    var removed = false
    for (e in list) {
        if (e.path == full) {
            removed = true
        } else {
            keep.add(e)
        }
    }
    if (removed) {
        saveTrust(dataDir, keep)
    }
    return removed
}

/** 交互式问一次（Pi 的 prompt 也是这个意思，只是它能给更多选项）。 */
public func askTrust(path: String): TrustDecision {
    let d = TrustDecision()
    println("")
    println("信任这个目录吗？")
    println("  " + path)
    println("信任之后：模型可以在这个目录里读写文件、按工具集跑命令（这是它的工作区）。")
    println("  1) 信任并记住")
    println("  2) 只信任这一次")
    println("  3) 不信任（这次只给纯对话）")
    print("选 1/2/3 [默认 3]: ")
    var line = ""
    try {
        line = readln()
    } catch (e: Exception) {
        line = ""
    }
    let t = trimStr(line)
    if (t == "1") {
        d.trusted = true
        d.decided = true
        d.source = path
    } else if (t == "2") {
        d.trusted = true
        d.decided = true
        d.sessionOnly = true
        d.source = path + "（仅本次）"
    } else {
        d.trusted = false
        d.decided = true
        d.source = path
    }
    return d
}
