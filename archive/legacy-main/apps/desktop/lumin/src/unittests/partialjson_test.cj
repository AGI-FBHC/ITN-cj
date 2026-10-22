package lumin.unittests

import std.collection.*
import stdx.encoding.json.*
import lumin.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 流式解析"没写完的 JSON"：现在只用来把服务端给的半截 arguments 补全（Pi 的 toolcall_delta 由
 * 提供方按原样片段推，不再走这里的事件）。所以断言只针对"视图"。
 */
@Test
class PartialJsonTest {
    @TestCase
    func flatFormGrowsFragmentByFragment(): Unit {
        let raw = "{\"tool\":\"read\",\"args\":{\"path\":\"note.md\",\"limit\":20}}"
        let p = PartialJsonParser()
        let b = raw.toArray()
        var i: Int64 = 0
        while (i < b.size) {
            var j = i + 5
            if (j > b.size) {
                j = b.size
            }
            while (j < b.size && (b[j] & 192) == 128) {
                j = j + 1
            }
            p.push(String.fromUtf8(b[i..j]))
            i = j
        }
        @Expect(p.view().name, "read")
        @Expect(p.view().valueOf("path"), "note.md")
        @Expect(p.view().valueOf("limit"), "20")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func everyFragmentWidthAgreesWithTheWhole(): Unit {
        let raw = "{\"tool\":\"grep\",\"args\":{\"pattern\":\"提示词工程\",\"ignoreCase\":true}}"
        let whole = PartialJsonParser()
        whole.push(raw)
        var chunk: Int64 = 1
        while (chunk <= 9) {
            let p = PartialJsonParser()
            let b = raw.toArray()
            var i: Int64 = 0
            while (i < b.size) {
                var j = i + chunk
                if (j > b.size) {
                    j = b.size
                }
                while (j < b.size && (b[j] & 192) == 128) {
                    j = j + 1
                }
                p.push(String.fromUtf8(b[i..j]))
                i = j
            }
            @Expect(p.view().name, whole.view().name)
            @Expect(p.view().valueOf("pattern"), "提示词工程")
            @Expect(p.view().argsJson().toString(), whole.view().argsJson().toString())
            chunk = chunk + 1
        }
    }

    @TestCase
    func aTruncatedBufferStillYieldsWhateverIsComplete(): Unit {
        let raw = "{\"tool\":\"read\",\"args\":{\"path\":\"note.md\",\"limit\":20}}"
        let b = raw.toArray()
        var cut: Int64 = 1
        while (cut < b.size) {
            let head = safeUtf8(b, 0, cut)
            let p = PartialJsonParser()
            p.push(head)
            let v = p.view()
            if (v.nameKnown) {
                @Assert(containsSub(raw, v.name))
            }
            // 已经完整的参数不会再变
            var i: Int64 = 0
            while (i < v.keys.size) {
                @Expect(v.valueOf(v.keys[i]), wholeValueOf(raw, v.keys[i]))
                i = i + 1
            }
            cut = cut + 1
        }
    }

    func wholeValueOf(raw: String, key: String): String {
        let p = PartialJsonParser()
        p.push(raw)
        return p.view().valueOf(key)
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
    func escapedQuotesAndNestedObjectsSurvive(): Unit {
        let p = PartialJsonParser()
        p.push("{\"tool\":\"edit\",\"args\":{\"oldText\":\"他说\\\"你好\\\"\",\"meta\":{\"a\":1}}}")
        @Expect(p.view().valueOf("oldText"), "他说\"你好\"")
        @Expect(p.view().valueOf("meta"), "{\"a\":1}")
        @Expect(p.isComplete(), true)
    }

    @TestCase
    func openAiNativeArgumentsShapeIsAlsoUnderstood(): Unit {
        // 原生 function calling 的 arguments 是"字符串里再套一层 JSON"
        let inner = "{\\\"path\\\":\\\"note.md\\\"}"
        let p = PartialJsonParser()
        p.push("{\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"" + inner + "\"}}")
        @Expect(p.view().name, "read")
        @Expect(p.view().valueOf("path"), "note.md")
        @Expect(p.isComplete(), true)
    }
}
