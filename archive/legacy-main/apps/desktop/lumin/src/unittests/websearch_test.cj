package lumin.unittests

import std.collection.*
import stdx.encoding.json.*
import lumin.net.*
import lumin.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 联网检索（Tavily）：这一组**不联网**，只用固定 JSON 验解析与门禁。
 * 关键约定：结果必须带 [W1]/[W2] 编号 + 链接 —— 运行时 citationWarning() 就是按这个抓"编造编号"的。
 */
@Test
class WebSearchTest {
    @TestCase
    func resultsAreNumberedAndCarryLinks(): Unit {
        let sample = "{\"answer\":\"一句话答案\",\"results\":[{\"title\":\"A\",\"url\":\"https://a.example\",\"content\":\"片段A\",\"score\":0.9},{\"title\":\"B\",\"url\":\"https://b.example\",\"content\":\"片段B\"}]}"
        let out = parseTavilyResults(sample)
        @Expect(out.error, "")
        @Expect(out.count, 2)
        @Assert(containsSub(out.content, "[W1] A"))
        @Assert(containsSub(out.content, "[W2] B"))
        @Assert(containsSub(out.content, "https://b.example"))
        @Assert(containsSub(out.content, "Tavily 摘要：一句话答案"))
        @Expect(arrOf(out.details).getOrThrow().size(), 2)
    }

    @TestCase
    func errorShapesAreReportedNotSwallowed(): Unit {
        let auth = parseTavilyResults("{\"detail\":\"Unauthorized: missing or invalid API key.\"}")
        @Assert(auth.error.contains("Unauthorized"))
        let empty = parseTavilyResults("{\"results\":[]}")
        @Assert(empty.error.size > 0)
        let notJson = parseTavilyResults("<html>502</html>")
        @Assert(notJson.error.size > 0)
    }

    @TestCase
    func withoutAKeyTheToolRefusesInsteadOfCallingOut(): Unit {
        let cfg = TavilyConfig()
        @Expect(cfg.ready(), false)
        let tool = WebSearchTool(cfg)
        let r = tool.run("c1", strObj("query", "随便搜点什么"))
        @Expect(r.isError, true)
        @Assert(containsSub(r.content, "Tavily"))
        // 没给 query 也要拒
        let cfg2 = TavilyConfig()
        cfg2.apiKey = "fake-key-for-shape-check"
        let tool2 = WebSearchTool(cfg2)
        @Expect(tool2.run("c2", JsonObject()).isError, true)
    }

    @TestCase
    func theSpecIsExplicitAndMarkedExternal(): Unit {
        let tool = WebSearchTool(TavilyConfig())
        let s = tool.spec()
        @Expect(s.name, "web_search")
        @Expect(s.risk, "external")
        @Expect(s.isExternal(), true)
        @Assert(containsSub(s.parameters, "\"query\""))
        @Assert(containsSub(s.parameters, "\"required\":[\"query\"]"))
        @Assert(containsSub(s.description, "Tavily"))
    }
}
