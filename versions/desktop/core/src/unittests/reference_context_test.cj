package itn_desktop_core.unittests

import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.agent.DomainToolRun
import itn_desktop_core.runtime_host.TurnReferenceIndex
import itn_desktop_core.util.*

@Test
class ReferenceContextTest {
    @TestCase
    func modelAndRendererShareNumbersAcrossSearchesAndLibraries(): Unit {
        let index = TurnReferenceIndex()
        let first = DomainToolRun(); first.details = JsonValue.fromStr("[{\"kbId\":\"alpha\",\"docPath\":\"same.md\",\"id\":\"same.md#0\",\"text\":\"Alpha\"}]")
        let second = DomainToolRun(); second.details = JsonValue.fromStr("[{\"kbId\":\"beta\",\"docPath\":\"same.md\",\"id\":\"same.md#0\",\"text\":\"Beta\"}]")
        index.annotate("kb_search", first); index.annotate("kb_search", second)
        @Expect(first.content.contains("[1]"), true)
        @Expect(second.content.contains("[2]"), true)
        @Expect(index.localSources().size(), 2)
        @Expect(strOf(objOf(index.localSources()[1]).getOrThrow(), "kbId"), "beta")
        index.annotate("kb_search", first)
        @Expect(index.localSources().size(), 2)
    }

    @TestCase
    func webSearchEntriesAndFetchKeepActualUrlsAndStableSeparateNumbers(): Unit {
        let index = TurnReferenceIndex()
        let search = DomainToolRun(); search.details = JsonValue.fromStr("[{\"url\":\"https://example.com/a\",\"title\":\"A\",\"content\":\"First\"},{\"url\":\"https://example.com/b\",\"title\":\"B\",\"content\":\"Second\"}]")
        index.annotate("web_search", search)
        @Expect(search.content.contains("[W1]"), true)
        @Expect(search.content.contains("[W2]"), true)
        let fetch = DomainToolRun(); fetch.details = JsonValue.fromStr("{\"url\":\"https://example.com/a\",\"title\":\"A\",\"text\":\"Fetched content\"}")
        index.annotate("web_fetch", fetch)
        @Expect(fetch.content.contains("[W1]"), true)
        @Expect(index.webSources().size, 2)
        @Expect(strOf(index.webSources()[1], "url"), "https://example.com/b")
        @Expect(index.localSources().size(), 0)
    }
}
