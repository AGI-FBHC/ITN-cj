package zhixun_learning

import std.core.*
import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*

@Test
class TutorAgentTests {
    @TestCase
    func toolSchemaReflectsTavilyAvailability(): Unit {
        let withoutWeb = tutorAgentToolsJson(false)
        let withWeb = tutorAgentToolsJson(true)
        kbPrimitiveCheck(withoutWeb.contains("search_course_material") && !withoutWeb.contains("search_web"),
            "Course retrieval must always be exposed without an unconfigured web tool")
        kbPrimitiveCheck(withWeb.contains("search_course_material") && withWeb.contains("search_web"),
            "Tavily must add the web search tool")
        let parsed = cwJsonObjectFrom("{\"items\":" + withWeb + "}").getOrThrow()
        kbPrimitiveCheck(cwObjectList(parsed, "items").size == 2, "Agent must expose exactly the available tools")
    }

    @TestCase
    func toolArgumentsAreBoundedAndParsedWithoutThrowing(): Unit {
        let empty = tutorAgentParseArgs("")
        kbPrimitiveCheck(tutorAgentArgument(empty, "query") == "", "Empty tool arguments must be safe")
        let parsed = tutorAgentParseArgs("{\"query\":\"网络分层\",\"topK\":9}")
        kbPrimitiveCheck(tutorAgentArgument(parsed, "query") == "网络分层", "Tool query must parse")
        kbPrimitiveCheck(tutorAgentArgumentInt(parsed, "topK", 4) == 9, "Tool integer arguments must parse")
        kbPrimitiveCheck(tutorAgentArgumentInt(tutorAgentParseArgs("not-json"), "topK", 4) == 4,
            "Malformed tool arguments must fall back to a bounded default")
    }

    @TestCase
    func citationsAndTraceKeepStableNumbers(): Unit {
        let citations = ArrayList<KbHit>()
        let hits = ArrayList<KbHit>()
        hits.add(KbHit("chunk-a", "doc-a", "网络体系结构", "分层", "原文一", 0.9))
        hits.add(KbHit("chunk-b", "doc-b", "TCP", "可靠传输", "原文二", 0.8))
        let text = tutorAgentFormatCourseHits(hits, citations)
        kbPrimitiveCheck(text.contains("来源[1]") && text.contains("来源[2]"), "Tool results must expose stable source numbers")
        kbPrimitiveCheck(citations.size == 2, "Every displayed source must become a citation")
        let trace = ArrayList<String>()
        trace.add("检索课程资料：TCP")
        kbPrimitiveCheck(tutorAgentTraceJson(trace) == "[\"检索课程资料：TCP\"]", "Tool trace must round-trip as JSON")
    }

    @TestCase
    func tavilySettingsAndErrorsNeverExposeTheKey(): Unit {
        kbPrimitiveCheck(tavilyClampMaxResults(0) == 1 && tavilyClampMaxResults(99) == 10,
            "Tavily result count must be bounded")
        kbPrimitiveCheck(tavilyValidDepth("advanced") && !tavilyValidDepth("deep"),
            "Only supported Tavily search depths are accepted")
        let secret = "tvly-dev-example-secret-value"
        let scrubbed = tavilyScrubKey("upstream echoed " + secret + " in an error", secret)
        kbPrimitiveCheck(!scrubbed.contains(secret) && scrubbed.contains("***"),
            "Upstream errors must not expose the Tavily key")
        let parsed = cwJsonObjectFrom(tavilyResultsJson(
            "{\"answer\":\"摘要\",\"results\":[{\"title\":\"来源\",\"url\":\"https://example.test\",\"content\":\"正文\",\"score\":0.7}]}"))
            .getOrThrow()
        kbPrimitiveCheck(cwStringList(parsed, "results").size == 0, "Results are object entries, not strings")
        kbPrimitiveCheck(cwObjectList(parsed, "results").size == 1, "Tavily response must normalize its result list")
    }
}
