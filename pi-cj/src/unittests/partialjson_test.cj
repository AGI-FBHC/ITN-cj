package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 流式解析不完整 JSON（Pi 的 toolcall_delta）。
 *
 * 这一组是整套里最要紧的：它同时守着两个"已经踩过坑"的地方
 *   1. 工具名必须整个字符串到齐才播报（第一版会播报半个名字 "k"）
 *   2. 汉字被分片切断时不能抛异常，也不能解出半个字符
 */
@Test
class PartialJsonTest {
    @TestCase
    func flatFormGrowsFragmentByFragmentAndEndsComplete(): Unit {
        let raw = "{\"tool\":\"kb_search\",\"args\":{\"query\":\"提示词工程\",\"top_k\":6}}"
        let p = PartialJsonParser()
        let events = ArrayList<PiEvent>()
        for (f in fragments(raw, 7)) {
            for (e in p.push(f)) {
                events.add(e)
            }
        }
        @Expect(p.view().name, "kb_search")
        @Expect(p.view().valueOf("query"), "提示词工程")
        @Expect(p.view().valueOf("top_k"), "6")
        @Expect(p.isComplete(), true)
        let kinds = kindsOf(events)
        @Expect(kinds[0], "tool/call_start")
        @Expect(kinds[kinds.size - 1], "tool/call_end")
        @Expect(events[0].tool, "kb_search")
        @Expect(countOf(kinds, "tool/call_start"), 1)
        @Expect(countOf(kinds, "tool/call_end"), 1)
        @Expect(countOf(kinds, "tool/call_arg") > 0, true)
    }

    @TestCase
    func theToolNameIsOnlyAnnouncedOnceItsStringIsClosed(): Unit {
        let raw = "{\"tool\":\"kb_search\",\"args\":{\"query\":\"x\"}}"
        let p = PartialJsonParser()
        var firstAnnounced = ""
        for (f in fragments(raw, 1)) {
            for (e in p.push(f)) {
                if (kindText(e.kind) == "tool/call_start" && firstAnnounced.size == 0) {
                    firstAnnounced = e.tool
                }
            }
        }
        @Expect(firstAnnounced, "kb_search")
    }

    @TestCase
    func everyFragmentWidthAgreesWithTheWhole(): Unit {
        let raw = "{\"tool\":\"web_search\",\"args\":{\"query\":\"提示词工程在 2026 年有哪些新做法与实践案例\",\"limit\":5}}"
        var chunk: Int64 = 1
        while (chunk <= 9) {
            let p = PartialJsonParser()
            var events: Int64 = 0
            for (f in fragments(raw, chunk)) {
                for (e in p.push(f)) {
                    events = events + 1
                }
            }
            @Assert(events > 0)
            @Expect(p.view().name, "web_search")
            @Expect(p.view().valueOf("query"), "提示词工程在 2026 年有哪些新做法与实践案例")
            @Expect(p.view().valueOf("limit"), "5")
            @Expect(p.isComplete(), true)
            @Expect(p.view().argsJson().size(), 2)
            chunk = chunk + 1
        }
    }

    @TestCase
    func aLongArgumentReportsPartialValuesBeforeItCompletes(): Unit {
        let raw = "{\"tool\":\"web_search\",\"args\":{\"query\":\"提示词工程在 2026 年有哪些新的做法与实践案例\"}}"
        let p = PartialJsonParser()
        var partial = 0
        var complete = 0
        for (f in fragments(raw, 3)) {
            for (e in p.push(f)) {
                if (kindText(e.kind) == "tool/call_arg") {
                    if (e.complete) {
                        complete = complete + 1
                    } else {
                        partial = partial + 1
                    }
                }
            }
        }
        @Expect(partial > 0, true)
        @Expect(complete, 1)
        @Expect(p.view().valueOf("query"), "提示词工程在 2026 年有哪些新的做法与实践案例")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func openAiNativeFormIsUnwrappedAndParsed(): Unit {
        let raw = "{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"kb_search\",\"arguments\":\"{\\\"query\\\":\\\"提示词\\\",\\\"top_k\\\":6}\"}}"
        let p = PartialJsonParser()
        var events: Int64 = 0
        for (f in fragments(raw, 6)) {
            for (e in p.push(f)) {
                events = events + 1
            }
        }
        @Assert(events > 0)
        @Expect(p.view().name, "kb_search")
        @Expect(p.view().valueOf("query"), "提示词")
        @Expect(p.view().valueOf("top_k"), "6")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func escapedQuotesInsideAValueSurvive(): Unit {
        let raw = "{\"tool\":\"save_note\",\"args\":{\"title\":\"他说\\\"你好\\\"\"}}"
        let p = PartialJsonParser()
        var events: Int64 = 0
        for (f in fragments(raw, 4)) {
            for (e in p.push(f)) {
                events = events + 1
            }
        }
        @Assert(events > 0)
        @Expect(p.view().valueOf("title"), "他说\"你好\"")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func aNestedObjectArgumentIsKeptAsJsonText(): Unit {
        let raw = "{\"tool\":\"save_note\",\"args\":{\"meta\":{\"a\":1},\"title\":\"t\"}}"
        let p = PartialJsonParser()
        var events: Int64 = 0
        for (f in fragments(raw, 5)) {
            for (e in p.push(f)) {
                events = events + 1
            }
        }
        @Assert(events > 0)
        @Expect(p.view().valueOf("title"), "t")
        @Expect(p.view().valueOf("meta"), "{\"a\":1}")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func anIncompleteCallIsNeverReportedAsComplete(): Unit {
        let raw = "{\"tool\":\"kb_search\",\"args\":{\"query\":\"提示词\""
        let p = PartialJsonParser()
        for (f in fragments(raw, 5)) {
            for (e in p.push(f)) {
                @Expect(kindText(e.kind) == "tool/call_end", false)
            }
        }
        @Expect(p.isComplete(), false)
        @Expect(p.view().name, "kb_search")
        @Expect(p.view().valueOf("query"), "提示词")
        @Expect(p.view().valueOf("top_k"), "")
    }

    @TestCase
    func textAroundTheJsonIsIgnored(): Unit {
        let raw = "好的，我来查一下：{\"tool\":\"kb_search\",\"args\":{\"query\":\"x\"}}（以上是调用）"
        let p = PartialJsonParser()
        for (f in fragments(raw, 9)) {
            for (e in p.push(f)) {
                let n: Int64 = 0
            }
        }
        @Expect(p.view().name, "kb_search")
        @Expect(p.view().valueOf("query"), "x")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func byteSafeDecodingNeverSplitsACharacter(): Unit {
        let raw = "{\"query\":\"提示词工程\"}"
        let b = raw.toArray()
        var k: Int64 = 0
        while (k <= b.size) {
            let head = safeUtf8(b, 0, k)
            @Assert(head.size <= k)
            @Assert(isPrefix(head, raw))
            k = k + 1
        }
    }

    @TestCase
    func aHalfArrivedCharacterIsPickedUpByTheNextFragment(): Unit {
        // 传输层"丢掉半截字符、剩下的字节下次再来"时，解析器最终必须拿到完整值
        let raw = "{\"tool\":\"kb_search\",\"args\":{\"query\":\"提示词工程\"}}"
        let b = raw.toArray()
        let p = PartialJsonParser()
        var i: Int64 = 0
        var chunk: Int64 = 1
        while (i < b.size) {
            let head = safeUtf8(b, i, i + chunk)
            let used = head.size
            for (e in p.push(head)) {
                let n: Int64 = 0
            }
            i = i + used
            if (used == 0) {
                chunk = chunk + 1
            }
        }
        @Expect(p.view().name, "kb_search")
        @Expect(p.view().valueOf("query"), "提示词工程")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func nothingHappensBeforeAnyJsonArrives(): Unit {
        let p = PartialJsonParser()
        @Expect(p.push("").size, 0)
        @Expect(p.push("好的").size, 0)
        @Expect(p.view().name, "")
        @Expect(p.view().nameKnown, false)
        @Expect(p.isComplete(), false)
        @Expect(p.rawText(), "好的")
    }
}
