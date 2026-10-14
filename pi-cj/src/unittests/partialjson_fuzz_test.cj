package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 分片无关性（fuzz 风格）：同一段 JSON，无论切成 1 字节一片还是整段一次喂，
 * 解析出的 工具名 / 参数 / 完成态 必须完全一样。
 *
 * 这条能抓到"只在某个分片宽度下才错"的实现，比如：
 *   - 依赖"上一片末尾"的可恢复状态机写错（本实现是每次重扫，天然免疫）
 *   - 半截字符的处理只覆盖了 2 字节切点、没覆盖 3 字节汉字的首字节切点
 */
func payloads(): ArrayList<String> {
    let out = ArrayList<String>()
    out.add("{\"tool\":\"kb_search\",\"args\":{\"query\":\"提示词工程\"}}")
    out.add("{\"tool\":\"kb_search\",\"args\":{}}")
    out.add("{\"tool\":\"calc\",\"args\":{\"expr\":\"(12+8)*3/4\"}}")
    out.add("{\"tool\":\"kb_search\",\"args\":{\"query\":\"x\",\"top_k\":6}}")
    out.add("{\"tool\":\"save_note\",\"args\":{\"title\":\"他说\\\"你好\\\"\",\"text\":\"第一行\\n第二行\"}}")
    out.add("{\"tool\":\"read_chunk\",\"args\":{\"chunk_id\":\"01-基础.md#2\"}}")
    out.add("{\"tool\":\"save_artifact\",\"args\":{\"name\":\"小结.md\",\"content\":\"# 标题 } 里也有花括号\\n正文\"}}")
    out.add("{\"tool\":\"web_search\",\"args\":{\"query\":\"2026 年提示词工程有哪些新做法\",\"limit\":5}}")
    out.add("{\"tool\":\"save_note\",\"args\":{\"ids\":[1,2,3],\"flag\":true,\"ratio\":1.5,\"empty\":null}}")
    out.add("{\"tool\":\"save_artifact\",\"args\":{\"name\":\"小结.md\",\"meta\":{\"tags\":[\"提示词\",\"笔记\"],\"n\":2}}}")
    out.add("{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"kb_search\",\"arguments\":\"{\\\"query\\\":\\\"提示词\\\"}\"}}")
    out.add("好的，我查一下：{\"tool\":\"kb_search\",\"args\":{\"query\":\"中文带空格 和 标点，。\"}}（以上是调用）")
    return out
}

@Test
class PartialJsonFuzzTest {
    @TestCase
    func everyFragmentWidthAgreesWithTheSingleShotParse(): Unit {
        for (raw in payloads()) {
            let whole = PartialJsonParser()
            whole.push(raw)
            @Expect(whole.isComplete(), true)
            var chunk: Int64 = 1
            while (chunk <= 12) {
                let p = PartialJsonParser()
                var events: Int64 = 0
                for (f in fragments(raw, chunk)) {
                    for (e in p.push(f)) {
                        events = events + 1
                    }
                }
                @Assert(events > 0)
                @Expect(p.view().name, whole.view().name)
                @Expect(p.view().nameKnown, true)
                @Expect(p.view().argsJson().toString(), whole.view().argsJson().toString())
                @Expect(p.isComplete(), true)
                chunk = chunk + 1
            }
        }
    }

    @TestCase
    func aTruncatedBufferNeverThrowsAndCompletedArgsNeverChange(): Unit {
        // 不变量：越喂越多时，"已经完整的参数"不会再变；工具名一旦宣布就不会变样。
        // 注意不能断言"没喂完就一定 isComplete == false"——OpenAI 原生形态里，
        // function 对象一闭合、arguments 一整串到手，就是可执行的了，多出来的外层收尾不影响。
        for (raw in payloads()) {
            let whole = PartialJsonParser()
            whole.push(raw)
            let b = raw.toArray()
            var cut: Int64 = 1
            while (cut < b.size) {
                let head = safeUtf8(b, 0, cut)
                let p = PartialJsonParser()
                var events: Int64 = 0
                for (e in p.push(head)) {
                    events = events + 1
                }
                let v = p.view()
                if (v.nameKnown) {
                    @Assert(raw.contains(v.name))
                }
                var i: Int64 = 0
                while (i < v.keys.size) {
                    let k = v.keys[i]
                    @Expect(v.valueOf(k), whole.view().valueOf(k))
                    i = i + 1
                }
                cut = cut + 1
            }
        }
    }

    @TestCase
    func theSameBufferScannedTwiceYieldsNoNewEvents(): Unit {
        let raw = "{\"tool\":\"kb_search\",\"args\":{\"query\":\"提示词\"}}"
        let p = PartialJsonParser()
        for (e in p.push(raw)) {
            let n: Int64 = 0
        }
        // 再喂一个空片段：视图没变，就不该再产生事件
        @Expect(p.push("").size, 0)
        @Expect(p.isComplete(), true)
    }
}
