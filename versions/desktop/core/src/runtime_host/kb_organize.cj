package itn_desktop_core.runtime_host

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.store.Settings
import itn_desktop_core.store.ModelConfig
import itn_desktop_core.store.Store
import itn_desktop_core.llm.LlmClient
import itn_desktop_core.kb.KbChunk
import itn_desktop_core.kb.Outline
import itn_desktop_core.kb.OutlineChapter
import itn_desktop_core.kb.ScannedDoc
import itn_desktop_core.kb.ScanReport
import itn_desktop_core.kb.scanDocsReport
import itn_desktop_core.kb.kbDir
import itn_desktop_core.util.readTextOr
import itn_desktop_core.util.ensureDir
import itn_desktop_core.kb.stamp
// splitLines / trimStr 用 pi 那份（与 util 同名，两边都导会歧义——踩过的坑）

/*
 * 让 lumin 把一堆资料整理成一份"教学目录"。
 *
 * 为什么要有它：用户随手丢进来的资料常常是散乱的——文件名没规律、一篇长文没有标题层次、
 * 多个文档其实是同一门课的不同章节。靠规则（docs 里那套"第X章 / 一、/ 1.2"）能救一部分，
 * 但救不了"文件名是 1.pdf、2.pdf、新建文档.md"这种。这一层把**判断**交出去：
 * 把资料清单喂给模型，让它给出一份目录计划，之后建索引就按这份计划组织章节。
 *
 * 刻意做成"一次模型调用 + 结构化输出"而不是让模型去读写文件：
 *   - 免去文件工具、工作区信任、并发写这些复杂度；
 *   - 结果由内核自己校验、自己落盘（<数据目录>/kb/<id>/outline.json），失败也不会留下半个文件；
 *   - 模型只要给 JSON，跑得也快（一次请求）。
 */

/** 从一段文本里抠出第一个完整的 JSON 对象（模型爱在前后加解说，这里只认花括号）。 */
func firstJsonObject(text: String): String {
    let b = text.toArray()
    var start = -1
    var i = 0
    while (i < b.size) {
        if (b[i] == 123) {
            start = i
            break
        }
        i = i + 1
    }
    if (start < 0) {
        return ""
    }
    var depth = 0
    var inStr = false
    var esc = false
    var j = start
    while (j < b.size) {
        let c = b[j]
        if (inStr) {
            if (esc) {
                esc = false
            } else if (c == 92) {
                esc = true
            } else if (c == 34) {
                inStr = false
            }
        } else {
            if (c == 34) {
                inStr = true
            } else if (c == 123) {
                depth = depth + 1
            } else if (c == 125) {
                depth = depth - 1
                if (depth == 0) {
                    return String.fromUtf8(b[start..(j + 1)])
                }
            }
        }
        j = j + 1
    }
    return ""
}

/** 资料清单：每篇文档的路径 + 开头几行（够模型判断"这是什么"）。 */
func materialDigest(docs: ArrayList<ScannedDoc>): String {
    let sb = StringBuilder()
    var n = 0
    for (d in docs) {
        if (n >= 80) {
            sb.append("- （还有 " + (docs.size - n).toString() + " 篇，未列出）\n")
            break
        }
        sb.append("- " + d.relPath + "\n")
        let raw = readTextOr(d.fullPath, "")
        let lines = splitLines(raw)
        var shown = 0
        for (line in lines) {
            let t = trimStr(line)
            if (t.size == 0) {
                continue
            }
            sb.append("    " + t + "\n")
            shown = shown + 1
            if (shown >= 6) {
                break
            }
        }
        n = n + 1
    }
    return sb.toString()
}

/**
 * 跑一次整理。
 *
 * 返回 {ok, chapters, docs, note, path} 或 {ok:false, message}。
 * outline 落在 <数据目录>/kb/<id>/outline.json；建索引时 /api/kb/build 会自动读它。
 */
public func organizeKb(store: Store, kbId: String): JsonObject {
    let out = JsonObject()
    let cfg = store.load()
    match (cfg.findKb(kbId)) {
        case None =>
            out.put("ok", JsonBool(false))
            out.put("message", JsonString("找不到知识库：" + kbId))
            return out
        case Some(kb) =>
            if (kb.rootDir.size == 0) {
                out.put("ok", JsonBool(false))
                out.put("message", JsonString("这个知识库还没有资料目录"))
                return out
            }
            var model: ?ModelConfig = None
            if (cfg.chatModelId.size > 0) {
                model = cfg.findModel(cfg.chatModelId)
            }
            if (model.isNone() && cfg.models.size > 0) {
                model = Some(cfg.models[0])
            }
            match (model) {
                case None =>
                    out.put("ok", JsonBool(false))
                    out.put("message", JsonString("没有可用的对话模型，请先在设置里配置"))
                    return out
                case Some(mc) =>
                    let docs = scanDocsReport(kb.rootDir, ScanReport())
                    if (docs.size == 0) {
                        out.put("ok", JsonBool(false))
                        out.put("message", JsonString("这个目录里没有可读的资料"))
                        return out
                    }
                    let system = "你在帮一位老师把散落的课程资料整理成一份教学目录。只输出 JSON，不要解说。"
                    let user = "资料清单（路径 + 每篇开头几行）：\n" + materialDigest(docs) +
                        "\n\n把这些资料组织成一份教学目录，输出 JSON，形状严格如下：\n" +
                        "{\"note\":\"一句话说明你的组织思路\",\"chapters\":[{\"name\":\"第一章 名称\",\"docs\":[\"相对路径1\",\"相对路径2\"]}]}\n" +
                        "要求：\n" +
                        "1. 章节名用中文、能看出讲什么，按教学顺序排；同一门课的文档放同一章。\n" +
                        "2. docs 里只能出现清单里给过的相对路径，一篇文档只放一次（别漏、别编）。\n" +
                        "3. 资料太少或确实只有一篇时，也照上面的形状给一章。"
                    var reply = ""
                    try {
                        reply = LlmClient(mc).chat(system, user)
                    } catch (e: Exception) {
                        out.put("ok", JsonBool(false))
                        out.put("message", JsonString("整理失败：" + e.message))
                        return out
                    }
                    let raw = firstJsonObject(reply)
                    if (raw.size == 0) {
                        out.put("ok", JsonBool(false))
                        out.put("message", JsonString("模型没有给出可解析的 JSON（可以重试一次）"))
                        return out
                    }
                    var parsed = Outline()
                    try {
                        parsed = Outline.fromJson(JsonValue.fromStr(raw))
                    } catch (e: Exception) {
                        out.put("ok", JsonBool(false))
                        out.put("message", JsonString("解析目录失败：" + e.message))
                        return out
                    }
                    // 校验：路径必须是清单里出现过的、每篇只能出现一次
                    let known = HashSet<String>()
                    for (d in docs) {
                        known.add(d.relPath)
                    }
                    let used = HashSet<String>()
                    let chapters = ArrayList<OutlineChapter>()
                    var dropped = 0
                    for (c in parsed.chapters) {
                        let cc = OutlineChapter()
                        cc.name = c.name
                        for (p in c.docs) {
                            if (known.contains(p) && !used.contains(p)) {
                                cc.docs.add(p)
                                used.add(p)
                            } else {
                                dropped = dropped + 1
                            }
                        }
                        if (cc.docs.size > 0) {
                            chapters.add(cc)
                        }
                    }
                    // 模型漏掉的文档：接在最后一章，不丢资料
                    let missed = ArrayList<String>()
                    for (d in docs) {
                        if (!used.contains(d.relPath)) {
                            missed.add(d.relPath)
                        }
                    }
                    if (missed.size > 0) {
                        let tail = OutlineChapter()
                        tail.name = "其他资料"
                        for (p in missed) {
                            tail.docs.add(p)
                        }
                        chapters.add(tail)
                    }
                    if (chapters.size == 0) {
                        out.put("ok", JsonBool(false))
                        out.put("message", JsonString("模型给的目录里没有一个有效章节"))
                        return out
                    }
                    let ol = Outline()
                    ol.source = "lumin"
                    ol.note = parsed.note
                    if (ol.note.size == 0) {
                        ol.note = "由 lumin 整理"
                    }
                    ol.chapters = chapters
                    let path = kbDir(store.dataDir, kbId) + "/outline.json"
                    ensureDir(kbDir(store.dataDir, kbId))
                    ol.save(path)
                    out.put("ok", JsonBool(true))
                    out.put("chapters", JsonInt(chapters.size))
                    out.put("docs", JsonInt(ol.docCount()))
                    out.put("note", JsonString(ol.note))
                    out.put("dropped", JsonInt(dropped))
                    out.put("missing", JsonInt(missed.size))
                    out.put("organizedAt", JsonString(stamp()))
                    out.put("path", JsonString(path))
                    return out
            }
    }
}

/** 丢掉整理结果（回到"按材料自己的标题分章"）。 */
public func clearOutline(store: Store, kbId: String): JsonObject {
    let out = JsonObject()
    let path = kbDir(store.dataDir, kbId) + "/outline.json"
    var removed = false
    try {
        if (exists(path)) {
            remove(path)
            removed = true
        }
    } catch (e: Exception) {
        ()
    }
    out.put("ok", JsonBool(true))
    out.put("removed", JsonBool(removed))
    return out
}
