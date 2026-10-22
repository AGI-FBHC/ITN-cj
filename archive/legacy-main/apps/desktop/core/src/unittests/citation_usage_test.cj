package itn_desktop_core.unittests
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.agent.citationsUsedFromHits
import itn_desktop_core.util.*

@Test
func unusedRetrievedCandidatesAreNotAnswerCitations(): Unit {
    let hits = JsonArray()
    for (title in ["first", "second"]) {
        let h = JsonObject(); h.put("docTitle", JsonString(title)); hits.add(h)
    }
    @Expect(citationsUsedFromHits("回答没有采用资料", hits).size(), 0)
    let used = citationsUsedFromHits("依据第二篇[2]，重复引用[2]，无效引用[9]。", hits)
    @Expect(used.size(), 1)
    match (objOf(used[0])) { case Some(o) => @Expect(intOf(o, "index"), 2); case None => @Expect(false, true) }
}
