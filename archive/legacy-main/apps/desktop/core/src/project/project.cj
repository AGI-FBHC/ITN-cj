package itn_desktop_core.project

import std.collection.*
import std.random.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*

/*
 * 项目 = 一个本机文件夹（对齐 Codex 的"一个项目一个文件夹"）。
 *
 * 为什么要有它：会话原来是按知识库分组的，而知识库只是"一份资料"，
 * 拿它当组织单元既解释不通也不好用。项目回答的是"我在哪个文件夹里干活"：
 *   - 会话挂在项目下，侧栏按项目分组；
 *   - 项目文件夹同时就是那一段会话的工作目录（lumin 在里面读写文件）；
 *   - 检索范围跟项目无关：永远是本机全部知识库。
 *
 * 存储：项目清单放 settings 键值表（一张 JSON 数组），会话归属放 sessions_meta
 * 的 project:<会话id>。都不改表结构，老数据目录直接能用。
 */

public class Project {
    public var id: String = ""
    public var name: String = ""
    public var root: String = ""
    /** 置顶：侧栏里排在最前面（对齐 Codex 的"置顶项目"）。 */
    public var pinned: Bool = false

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("name", JsonString(name))
        o.put("root", JsonString(root))
        o.put("pinned", JsonBool(pinned))
        return o
    }
}

/** 去掉结尾的分隔符：同一个目录写成 "D:\x" 和 "D:\x\" 时要认成同一个。 */
func trimTrailingSlash(p: String): String {
    var s = trimStr(p)
    while (s.size > 1) {
        let last = s.toArray()[s.size - 1]
        if (last == 47 || last == 92) {
            s = String.fromUtf8(s.toArray()[0..(s.size - 1)])
        } else {
            break
        }
    }
    return s
}

/** 目录名（当项目名用）。 */
func baseNameOf(p: String): String {
    let parts = p.replace("\\", "/").split("/")
    var i = parts.size - 1
    while (i >= 0) {
        if (parts[i].size > 0) {
            return parts[i]
        }
        i = i - 1
    }
    return p
}

public class ProjectStore {
    public let dataDir: String

    public init(dataDir: String) {
        this.dataDir = dataDir
    }

    private func db(): Db {
        return DbHub.open(dataDir)
    }

    public func list(): ArrayList<Project> {
        let out = ArrayList<Project>()
        let raw = db().getKv("settings", "projects_json", "")
        if (raw.size == 0) {
            return out
        }
        try {
            match (JsonValue.fromStr(raw)) {
                case a: JsonArray =>
                    var i = 0
                    while (i < a.size()) {
                        match (objOf(a[i])) {
                            case Some(o) =>
                                let p = Project()
                                p.id = strOf(o, "id")
                                p.name = strOf(o, "name")
                                p.root = strOf(o, "root")
                                p.pinned = boolOf(o, "pinned")
                                if (p.id.size > 0) {
                                    out.add(p)
                                }
                            case None => ()
                        }
                        i = i + 1
                    }
                case _ => ()
            }
        } catch (e: Exception) {
            ()
        }
        return out
    }

    private func persist(items: ArrayList<Project>): Unit {
        let a = JsonArray()
        for (p in items) {
            a.add(p.toJson())
        }
        db().putKv("settings", "projects_json", a.toString())
    }

    public func find(id: String): ?Project {
        if (id.size == 0) {
            return None
        }
        for (p in list()) {
            if (p.id == id) {
                return Some(p)
            }
        }
        return None
    }

    /** 置顶/取消置顶。 */
    public func setPinned(id: String, pinned: Bool): Unit {
        let items = list()
        for (p in items) {
            if (p.id == id) {
                p.pinned = pinned
            }
        }
        persist(items)
    }

    /** 新建或更新一个项目；同一个文件夹不会登记两次。 */
    public func save(idIn: String, nameIn: String, rootIn: String): Project {
        let root = trimTrailingSlash(rootIn)
        if (root.size == 0) {
            throw Exception("先选一个文件夹")
        }
        let items = list()
        var target: ?Project = None
        for (p in items) {
            if ((idIn.size > 0 && p.id == idIn) || (idIn.size == 0 && p.root == root)) {
                target = Some(p)
            }
        }
        match (target) {
            case Some(p) =>
                if (trimStr(nameIn).size > 0) {
                    p.name = trimStr(nameIn)
                }
                p.root = root
                persist(items)
                return p
            case None =>
                let p = Project()
                p.id = "p" + Random().nextUInt64().toString()
                p.root = root
                p.name = if (trimStr(nameIn).size > 0) { trimStr(nameIn) } else { baseNameOf(root) }
                items.add(p)
                persist(items)
                return p
        }
    }

    /** 删项目不动会话与文件：只是不再分组，那些会话回到"未归档"。 */
    public func remove(id: String): Unit {
        let keep = ArrayList<Project>()
        for (p in list()) {
            if (p.id != id) {
                keep.add(p)
            }
        }
        persist(keep)
    }

    public func projectOf(sessionId: String): String {
        if (sessionId.size == 0) {
            return ""
        }
        return db().getKv("sessions_meta", "project:" + sessionId, "")
    }

    public func bind(sessionId: String, projectId: String): Unit {
        if (sessionId.size == 0) {
            return
        }
        db().putKv("sessions_meta", "project:" + sessionId, projectId)
    }

    /** 这一段会话的工作目录；没有项目就返回空串（调用方退回全局设置）。 */
    public func rootOf(sessionId: String): String {
        match (find(projectOf(sessionId))) {
            case Some(p) => return p.root
            case None => return ""
        }
    }
}