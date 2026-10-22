package itn_desktop_core.knowledge

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.llm.LlmClient
import itn_desktop_core.resource.jsonObjectFromModel
import itn_desktop_core.store.*
import itn_desktop_core.util.*

func suggestModel(store: Store): ModelConfig {
    let settings = store.load()
    if (settings.chatModelId.size > 0) {
        match (settings.findModel(settings.chatModelId)) {
            case Some(model) => return model
            case None => ()
        }
    }
    if (settings.models.size > 0) { return settings.models[0] }
    throw Exception("还没有配置对话模型，无法生成连线建议")
}

func suggestPair(a: String, b: String): String {
    return if (a < b) { a + "|" + b } else { b + "|" + a }
}

/** LLM 只提出关系，节点和已有边由仓颉校验。 */
public func suggestKnowledgeLinks(store: Store): JsonObject {
    let ks = KnowledgeStore(store.dataDir)
    let graph = ks.graph()
    let nodes = graph.get("nodes").getOrDefault({ => JsonArray() })
    let nodeArray = match (nodes) { case a: JsonArray => a; case _ => JsonArray() }
    if (nodeArray.size() < 2) { throw Exception("知识网络至少需要两个节点才能建议连线") }

    let existing = HashSet<String>()
    let links = graph.get("links").getOrDefault({ => JsonArray() })
    let linkArray = match (links) { case a: JsonArray => a; case _ => JsonArray() }
    var li = 0
    while (li < linkArray.size()) {
        match (objOf(linkArray[li])) {
            case Some(link) => existing.add(suggestPair(strOf(link, "from"), strOf(link, "to")))
            case None => ()
        }
        li += 1
    }

    let nodeText = StringBuilder()
    var ni = 0
    while (ni < nodeArray.size()) {
        match (objOf(nodeArray[ni])) {
            case Some(node) =>
                nodeText.append("- ")
                nodeText.append(strOf(node, "id"))
                nodeText.append(" | ")
                nodeText.append(strOf(node, "title"))
                nodeText.append(" | ")
                nodeText.append(byteSafePrefix(strOf(node, "definition"), 260))
                nodeText.append("\n")
            case None => ()
        }
        ni += 1
    }
    let prompt = StringBuilder()
    prompt.append("只输出 JSON 对象，不要 Markdown。结构为 {\"suggestions\":[{\"from\":\"节点id\",\"to\":\"节点id\",\"label\":\"关系名\",\"reason\":\"为什么有关联\"}]}。\n")
    prompt.append("最多返回 12 条，只提出概念之间真正有意义的关系；不要编造节点 id，不要提出已有边，不要只根据标题相似。\n")
    prompt.append("节点：\n")
    prompt.append(nodeText.toString())
    prompt.append("\n已有边：")
    prompt.append(linkArray.toString())
    let client = LlmClient(suggestModel(store))
    let reply = client.chat("你是知识图谱编辑，只负责提出保守、可解释的连线建议。", prompt.toString())
    let parsed = match (jsonObjectFromModel(reply)) {
        case Some(value) => value
        case None => throw Exception("模型没有返回可解析的连线建议")
    }
    let out = JsonArray()
    let seen = HashSet<String>()
    let suggestions = parsed.get("suggestions").getOrDefault({ => JsonArray() })
    let list = match (suggestions) { case a: JsonArray => a; case _ => JsonArray() }
    var i = 0
    while (i < list.size() && out.size() < 12) {
        match (objOf(list[i])) {
            case Some(raw) =>
                let from = trimStr(strOf(raw, "from"))
                let to = trimStr(strOf(raw, "to"))
                if (from.size > 0 && to.size > 0 && from != to && !seen.contains(suggestPair(from, to))) {
                    let pair = suggestPair(from, to)
                    seen.add(pair)
                    let item = JsonObject()
                    item.put("id", JsonString("s" + (out.size() + 1).toString()))
                    item.put("from", JsonString(from))
                    item.put("to", JsonString(to))
                    let label = trimStr(strOf(raw, "label"))
                    item.put("label", JsonString(if (label.size > 0) { label } else { "关联" }))
                    item.put("reason", JsonString(byteSafePrefix(strOf(raw, "reason"), 500)))
                    item.put("exists", JsonBool(existing.contains(pair)))
                    out.add(item)
                }
            case None => ()
        }
        i += 1
    }
    let result = JsonObject()
    result.put("suggestions", out)
    result.put("nodes", nodeArray)
    return result
}
