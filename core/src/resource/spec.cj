package itn_desktop_core.resource

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.util.*

/*
 * 四种学习资源（与网页版后端的 resource_types 对齐）：ppt / lecture / practice / quiz。
 *
 * 为什么单独抽一层：网页版那四种资源是"角色分工 + 证据落地 + 质检返修"生成出来的，
 * 不是让模型一口气写一大段 Markdown。桌面版要的是同一套**能力契约**——
 *   - 每种资源有自己的**结构化内容形状**（JSON），不是自由文本；
 *   - 每种资源有**可判定的质检规则**（章节数/步骤数/题量/难度覆盖/选项唯一/引用编号…）；
 *   - 不达标就**定向返修**，返修还不行就如实报问题，不假装成功。
 * 这一段只放"契约"，生成流程在 generate.cj，质检在 validate.cj，渲染在 render.cj。
 */

public class ResourceKind {
    public var id: String = ""
    public var label: String = ""
    /** 产物文件名的前缀（界面按前缀认类型：讲义 / 练习 …） */
    public var prefix: String = ""
    public var note: String = ""

    public init(id: String, label: String, prefix: String, note: String) {
        this.id = id
        this.label = label
        this.prefix = prefix
        this.note = note
    }
}

/** 四种资源，顺序即界面上的顺序。 */
public func resourceKinds(): ArrayList<ResourceKind> {
    let out = ArrayList<ResourceKind>()
    out.add(ResourceKind("lecture", "定制讲义", "讲义", "分章分节的长文，逐节引用资料"))
    out.add(ResourceKind("practice", "实操指南", "实操", "可执行步骤 + 验收标准 + 故障排查"))
    out.add(ResourceKind("quiz", "分阶测试", "练习", "知识点 + 易/中/难三档选择题"))
    out.add(ResourceKind("ppt", "演示稿", "演示", "一页一个要点，能直接进播放器"))
    return out
}

public func isResourceKind(id: String): Bool {
    for (k in resourceKinds()) {
        if (k.id == id) {
            return true
        }
    }
    return false
}

public func findKind(id: String): ?ResourceKind {
    for (k in resourceKinds()) {
        if (k.id == id) {
            return Some(k)
        }
    }
    return None
}

public func labelOf(id: String): String {
    match (findKind(id)) {
        case Some(k) => return k.label
        case None => return id
    }
}

public func prefixOf(id: String): String {
    match (findKind(id)) {
        case Some(k) => return k.prefix
        case None => return "资源"
    }
}

/** 详细程度：与后端的 concise / balanced / detailed 三档对齐。 */
public func normalizeDetail(detail: String): String {
    if (detail == "concise" || detail == "detailed") {
        return detail
    }
    return "balanced"
}

public func detailMinChars(detail: String): Int64 {
    let d = normalizeDetail(detail)
    if (d == "concise") {
        return 1300
    }
    if (d == "detailed") {
        return 2400
    }
    return 1800
}

public func detailMinSections(detail: String): Int64 {
    let d = normalizeDetail(detail)
    if (d == "concise") {
        return 4
    }
    if (d == "detailed") {
        return 6
    }
    return 5
}

public func detailMinChapters(detail: String): Int64 {
    return 2
}

/** 题量的合理区间：太多会拖长生成时间，太少覆盖不了三档难度。 */
public func normalizeCount(kind: String, count: Int64): Int64 {
    var c = count
    if (c <= 0) {
        c = if (kind == "ppt") { 8 } else if (kind == "quiz") { 6 } else { 0 }
    }
    if (kind == "quiz") {
        if (c < 3) {
            c = 3
        }
        if (c > 20) {
            c = 20
        }

    }
    if (kind == "ppt") {
        if (c < 4) {
            c = 4
        }
        if (c > 24) {
            c = 24
        }
    }
    return c
}

/** 给 /api/resource/kinds：界面据此画"生成什么"的菜单。 */
public func kindsJson(): JsonArray {
    let arr = JsonArray()
    for (k in resourceKinds()) {
        let o = JsonObject()
        o.put("id", JsonString(k.id))
        o.put("label", JsonString(k.label))
        o.put("prefix", JsonString(k.prefix))
        o.put("note", JsonString(k.note))
        arr.add(o)
    }
    return arr
}
