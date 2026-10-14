package pi_cj.pi

import std.collection.*
import stdx.encoding.json.*

/**
 * 三个示例工具：形状与内核 tools/registry.cj 里的真工具一致，只是把"读知识库 / 写笔记 / 联网"
 * 换成了内存里的假数据。
 *
 * 两个用途：一是给 main.cj 的演示和单元测试当夹具；二是给"接内核"的人一个照抄的模板
 * （真工具就是把 run() 里的假数据换成 store 调用，其余不变）。
 */

/** 本机检索：read。 */
public class KbSearchTool <: Tool {
    /** 被问过的检索词，测试用断言 */
    public let queries = ArrayList<String>()

    public init() {}

    public func spec(): ToolSpec {
        return ToolSpec("kb_search", "检索知识库", "{\"query\": \"检索词\", \"top_k\": 6}",
            "按语义/关键词检索当前知识库，返回带出处（文档、标题路径、编号）的切片。", "read")
    }

    public func run(args: JsonObject): ToolResult {
        let q = strOf(args, "query")
        queries.add(q)
        let arr = JsonArray()
        let o = JsonObject()
        o.put("chunk_id", JsonString("01-基础.md#2"))
        o.put("title", JsonString("提示词的三个要素"))
        o.put("text", JsonString("关于「" + q + "」的本地切片：角色、任务、格式是提示词的三要素。"))
        arr.add(o)
        return ToolResult.good("本地命中 1 条切片（" + q + "）", arr)
    }
}

/** 写笔记：write。 */
public class SaveNoteTool <: Tool {
    public var saved: Int64 = 0

    public init() {}

    public func spec(): ToolSpec {
        return ToolSpec("save_note", "写一条笔记", "{\"title\": \"标题\", \"text\": \"内容\"}",
            "把结论存进本机的学习笔记，之后能在「我的笔记」里回看。", "write")
    }

    public func run(args: JsonObject): ToolResult {
        saved = saved + 1
        return ToolResult.good("已写入笔记：" + strOf(args, "title"), JsonNull())
    }
}

/** 联网检索：external。没配密钥时用 registry.markUnavailable 让它不出现在提示词里。 */
public class WebSearchTool <: Tool {
    public var calls: Int64 = 0

    public init() {}

    public func spec(): ToolSpec {
        return ToolSpec("web_search", "联网搜索", "{\"query\": \"检索词\", \"limit\": 5}",
            "用 Tavily 在互联网上搜公开资料，返回标题、链接与摘要。", "external")
    }

    public func run(args: JsonObject): ToolResult {
        calls = calls + 1
        let q = strOf(args, "query")
        let arr = JsonArray()
        var i: Int64 = 0
        while (i < 3) {
            let o = JsonObject()
            o.put("title", JsonString("网页结果 " + (i + 1).toString()))
            o.put("url", JsonString("https://example.com/" + (i + 1).toString()))
            o.put("content", JsonString("关于「" + q + "」的公开资料摘要"))
            arr.add(o)
            i = i + 1
        }
        return ToolResult.good("联网检索到 3 条结果（" + q + "）", arr)
    }
}
