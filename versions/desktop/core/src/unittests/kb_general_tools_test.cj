package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.kb.*
import itn_desktop_core.store.*
import itn_desktop_core.tools.*
import itn_desktop_core.util.*

/*
 * 通用模式的资料工具：会话没绑定知识库（kbId 为空）时，
 * list_documents / read_chunk 必须和 kb_search 一样"看全部已建索引的库"。
 *
 * 实测踩过的坑（2026-10-16 08:36）：list_documents 拿空 id 去 loadIndex 得到 0 个切片，
 * 报"当前知识库还没有索引" —— 而同一轮的 kb_search 明明命中了 8 个切片，模型自己都看出矛盾。
 * 这条钉子防止它再犯。
 */
@Test
class KbGeneralToolsTest {
    private func jsonArr(v: ?JsonValue): JsonArray {
        match (v) {
            case Some(x) =>
                match (x) {
                    case a: JsonArray => return a
                    case _ => return JsonArray()
                }
            case None => return JsonArray()
        }
    }

    private func jsonObj(v: ?JsonValue): JsonObject {
        match (v) {
            case Some(x) =>
                match (x) {
                    case o: JsonObject => return o
                    case _ => return JsonObject()
                }
            case None => return JsonObject()
        }
    }

    /** 铺一个库：一篇 md + 索引 + 登记。返回索引（要拿切片 id）。 */
    private func mkKb(dataDir: String, kbId: String, name: String, docFile: String, docTitle: String, body: String): KbIndex {
        let root = freshDir("kbgen-" + kbId)
        writeText(root + "/" + docFile, "# " + docTitle + "\n\n## 小节\n\n" + body + "\n")
        let idx = chunkAll(root, 1200)
        idx.kbId = kbId
        saveIndex(dataDir, kbId, idx)
        return idx
    }

    @TestCase
    func generalModeCoversEveryIndexedKb(): Unit {
        let dataDir = freshDir("kb-general")
        // 两个库的文件名刻意不同：切片 id 是"路径#序号"，同名文件会撞 id（跨库撞名时通用模式取第一个，见 readChunkAnywhere 的注释）
        let a = mkKb(dataDir, "kbA", "甲库", "甲.md", "甲文档", "甲库的正文讲提示词与工具调用，够长一点以便切片。")
        let b = mkKb(dataDir, "kbB", "乙库", "乙.md", "乙文档", "乙库的正文讲检索与向量，也写长一点以便切片。")
        @Expect(a.chunks.size > 0, true)

        let s = Settings()
        let k1 = KnowledgeBase()
        k1.id = "kbA"
        k1.name = "甲库"
        s.knowledgeBases.add(k1)
        let k2 = KnowledgeBase()
        k2.id = "kbB"
        k2.name = "乙库"
        s.knowledgeBases.add(k2)
        Store(dataDir).save(s)

        let box = ToolBox(Store(dataDir))
        let r = box.listDocuments("")
        @Expect(r.ok, true)
        let arr = jsonArr(r.data)
        @Expect(arr.size(), 2)
        var titles = ""
        var ti = 0
        while (ti < arr.size()) {
            titles = titles + strOf(jsonObj(Some(arr[ti])), "docTitle") + "|"
            ti = ti + 1
        }
        // 出处写法与 kb_search 一致：标题带《库名》
        @Expect(titles.contains("《甲库》甲文档"), true)
        @Expect(titles.contains("《乙库》乙文档"), true)

        // read_chunk 在通用模式也要找得到（id 来自 kb_search，没绑库时不能"找不到切片"）
        let cid = b.chunks[0].id
        let rc = box.readChunk("", cid)
        @Expect(rc.ok, true)
        @Expect(strOf(jsonObj(rc.data), "kbId"), "kbB")
        @Expect(strOf(jsonObj(rc.data), "text").size > 0, true)
    }

    /** 一个库都没建索引时，报错要说人话（别再说"当前知识库还没有索引"）。 */
    @TestCase
    func generalModeWithoutAnyIndexSaysSo(): Unit {
        let dataDir = freshDir("kb-general-empty")
        let s = Settings()
        let k1 = KnowledgeBase()
        k1.id = "kbEmpty"
        k1.name = "空库"
        s.knowledgeBases.add(k1)
        Store(dataDir).save(s)
        let r = ToolBox(Store(dataDir)).listDocuments("")
        @Expect(r.ok, false)
        @Expect(r.summary.contains("本机还没有建过索引的知识库"), true)
    }
}
