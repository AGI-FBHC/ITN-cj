package zhixun_learning

import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class PresentationQualityTests {
    @TestCase
    func crowdedVisibleTextRequiresSemanticRepair(): Unit {
        let detail = kbPrimitiveRepeated("不能把整段讲稿塞进小卡片。", 20)
        let point = "{\"heading\":\"核心概念\",\"detail\":" + sqlFreeJsonString(detail) + "}"
        let raw = "{\"slides\":[{\"kind\":\"concept\",\"points\":[" + point + "]}]}"
        kbPrimitiveCheck(cwSlideDensityIssues(cwJsonObjectFrom(raw).getOrThrow()).size > 0,
            "Crowded slide must be sent to the arbitrator rather than shrunk")
    }

    @TestCase
    func slideRepairReceivesTheEntireDeck(): Unit {
        let tail = "COMPLETE_LAST_SLIDE_SENTINEL"
        let original = kbPrimitiveRepeated("这是一份超过旧十二千字节上限的完整演示提纲。", 400) + tail
        let prompt = cwRepairPrompt("slides", ArrayList<String>(), original)
        kbPrimitiveCheck(prompt.contains(tail), "Repair prompt discarded later slides")
    }

    @TestCase
    func configuredEditorialReviewWhenExplicitlyEnabled(): Unit {
        if (envOr("ZHIXUN_PPT_QUALITY_SMOKE", "") != "1") { return }
        let cfg = loadConfig()
        let id = envOr("ZHIXUN_PPT_QUALITY_RESOURCE", "")
        let rows = query(cfg, "SELECT c.content_json,d.content FROM kb_courseware c " +
            "JOIN kb_bundle_docs d ON d.id=c.doc_id WHERE c.id=" + sqlQuote(id) + " AND c.kind='slides' LIMIT 1")
        kbPrimitiveCheck(rows.size == 1, "Quality smoke requires an existing slide resource")
        let issues = cwSlideAgentIssues(slotEndpoint(cfg, loadKbSettings(cfg).chat),
            rows[0].text("content_json"), rows[0].text("content"))
        kbPrimitiveCheck(issues.size <= 4, "Reviewer must return a bounded actionable issue list")
        println("Configured PPT editorial agent responded; issue count: " + issues.size.toString())
    }
}

func sqlFreeJsonString(value: String): String {
    let writer = JsonWriter()
    writer.putStr("v", value)
    let raw = writer.toJson()
    raw[5..raw.size - 1]
}
