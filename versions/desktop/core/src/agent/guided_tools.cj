package itn_desktop_core.agent

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.guided.GuidedStore
import itn_desktop_core.learning.arrOf
import itn_desktop_core.store.Store
import itn_desktop_core.util.*

/*
 * 导学侧栏与 Lumin 共用同一套宿主状态。
 * 这些工具只在会话确实绑定到某个资源版本时出现；写操作都要求用户本轮明确意图，
 * 检查点答案还必须能从用户原话中找到，不能让模型替用户答题。
 */
public func guidedTools(store: Store, sid: String, userText: String): ArrayList<DomainTool> {
    let out = ArrayList<DomainTool>()
    let gs = GuidedStore(store.dataDir)
    if (!gs.isGuided(sid)) {
        return out
    }
    out.add(makeTool("read_guided_lesson", "读取导学上下文", "当前演示页、检查点和学习进度",
        "读取当前导学会话绑定的演示资源、当前页、前后页、章节目录、教学检查点、访问页和已答结果。所有内容由服务端按资源版本重新读取。",
        "{\"type\":\"object\",\"properties\":{\"slide\":{\"type\":\"integer\",\"description\":\"可选：把焦点切到第几页，1 起算\"}}}",
        "read", { args: JsonObject =>
            let slide = intOf(args, "slide")
            let context = if (slide > 0) { gs.focus(sid, slide) } else { gs.context(sid) }
            // focus 返回的是界面上下文，可能含选择题答案；给模型时重新剥离答案。
            return learningResult(gs.agentContext(sid), "已读取当前导学上下文")
        }))
    out.add(makeTool("submit_guided_checkpoint", "提交导学检查点", "核验用户明确选择的选择题答案",
        "把用户明确给出的选择题选项提交给服务端核验。quote 必须逐字来自本轮用户消息，且消息中要出现选项字母或选项原文；模型不得替用户作答。成功结果会写入导学上下文与学习证据。",
        "{\"type\":\"object\",\"properties\":{\"momentId\":{\"type\":\"string\"},\"answerIndex\":{\"type\":\"integer\"},\"quote\":{\"type\":\"string\"}},\"required\":[\"momentId\",\"answerIndex\",\"quote\"]}",
        "write", { args: JsonObject =>
            let momentId = strOf(args, "momentId")
            let answerIndex = intOf(args, "answerIndex")
            let sourceQuote = trimStr(strOf(args, "quote"))
            if (sourceQuote.size == 0 || !userText.contains(sourceQuote)) {
                throw Exception("提交检查点的 quote 必须逐字来自本轮用户消息")
            }
            let moment = gs.moment(sid, momentId)
            let options = arrOf(moment, "options")
            if (answerIndex < 0 || answerIndex >= options.size()) {
                throw Exception("答案选项无效")
            }
            let letters = ["A", "B", "C", "D"]
            let optionText = strValue(options[answerIndex])
            let explicitlyChosen = userText.contains(letters[answerIndex]) || (optionText.size > 0 && userText.contains(optionText))
            if (!explicitlyChosen) {
                throw Exception("用户本轮没有明确选择这个选项")
            }
            return learningResult(gs.checkpoint(sid, momentId, answerIndex), "检查点已由服务端核验并记录")
        }))
    out.add(makeTool("save_guided_note", "保存导学笔记", "把用户要求记录的内容关联到当前页",
        "仅在用户本轮明确要求记笔记/记录时使用。保存后笔记自动带资源、版本、页码和当前页标题来源。quote 应逐字引用用户原话，title 可省略。",
        "{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"text\":{\"type\":\"string\"},\"quote\":{\"type\":\"string\"}},\"required\":[\"text\"]}",
        "write", { args: JsonObject =>
            let text = trimStr(strOf(args, "text"))
            if (text.size == 0) {
                throw Exception("笔记内容不能为空")
            }
            let wantsNote = userText.contains("记笔记") || userText.contains("记下") || userText.contains("记录") || userText.contains("保存")
            if (!wantsNote) {
                throw Exception("用户本轮没有明确要求记笔记")
            }
            let note = gs.saveNote(sid, strOf(args, "title"), text, strOf(args, "quote"))
            return learningResult(note, "笔记已保存，并关联到当前资源、版本与页码")
        }))
    out.add(makeTool("open_guided_lesson", "打开导学页", "返回可直接打开的学习页位置",
        "返回导学资源的本地学习页地址与绑定信息，不会改变资源或会话状态。",
        "{\"type\":\"object\",\"properties\":{}}",
        "read", { args: JsonObject =>
            return learningResult(gs.open(sid), "已返回导学页位置")
        }))
    return out
}
