package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.agent.citationsFromHits
import itn_desktop_core.agent.citationsUsedFromHits
import itn_desktop_core.agent.referenceTools
import itn_desktop_core.agent.webCitationsFrom
import itn_desktop_core.db.*
import itn_desktop_core.kb.*
import itn_desktop_core.store.*
import itn_desktop_core.tools.ToolRegistry
import itn_desktop_core.tools.ToolBox
import itn_desktop_core.util.*

@Test
class KnowledgeReferenceTest {
    private func request(kbId: String, docPath: String, chunkId: String, headingPath!: String = ""): JsonObject {
        let out = JsonObject()
        out.put("kbId", JsonString(kbId))
        out.put("docPath", JsonString(docPath))
        out.put("chunkId", JsonString(chunkId))
        out.put("headingPath", JsonString(headingPath))
        return out
    }

    private func obj(value: JsonValue): JsonObject { return objOf(value).getOrThrow() }

    private func candidates(body: JsonObject): JsonArray {
        match (body.get("candidates").getOrThrow()) {
            case array: JsonArray => return array
            case _ => throw Exception("Expected candidates array")
        }
    }

    private func register(store: Store, kbId: String, name: String, root: String, count: Int64): Unit {
        ensureDir(root)
        let settings = store.load()
        let kb = KnowledgeBase()
        kb.id = kbId
        kb.name = name
        kb.rootDir = root
        settings.knowledgeBases.add(kb)
        store.save(settings)
        let index = KbIndex()
        index.kbId = kbId
        index.rootDir = root
        var i: Int64 = 0
        while (i < count) {
            let chunk = KbChunk()
            chunk.id = "shared.md#" + i.toString()
            chunk.docPath = "shared.md"
            chunk.docTitle = "同名资料"
            chunk.headingPath = "章节 / " + i.toString()
            chunk.text = name + " · 切片 " + i.toString() + "：引用保留中文快照。"
            index.chunks.add(chunk)
            i += 1
        }
        saveIndex(store.dataDir, kbId, index)
    }

    @TestCase
    func duplicatePathsAndChunkKeysRequireExplicitKb(): Unit {
        let dir = freshDir("reference-duplicates")
        let store = Store(dir)
        // Reverse registration order catches accidental use of the active/first library.
        register(store, "b", "乙库", dir + "/b", 2)
        register(store, "a", "甲库", dir + "/a", 2)
        let result = resolveKnowledgeReference(store, request("", "shared.md", ""))
        @Expect(strOf(result, "status"), "ambiguous")
        let choices = candidates(result)
        @Expect(choices.size(), 2)
        @Expect(strOf(obj(choices[0]), "kbId"), "a")
        @Expect(strOf(obj(choices[1]), "kbId"), "b")
        @Expect(strOf(obj(choices[0]), "referenceId") != strOf(obj(choices[1]), "referenceId"), true)
        @Expect(obj(choices[0]).get("text").isNone(), true)
        @Expect(strOf(obj(choices[0]), "docPath"), "shared.md")
        @Expect(strOf(obj(choices[0]), "docTitle"), "同名资料")
        let again = resolveKnowledgeReference(store, request("", "shared.md", ""))
        @Expect(strOf(obj(candidates(again)[0]), "referenceId"), strOf(obj(choices[0]), "referenceId"))
        @Expect(strOf(resolveKnowledgeReference(store, request("", "", "shared.md#1")), "status"), "ambiguous")
        let explicit = resolveKnowledgeReference(store, request("b", "shared.md", "shared.md#1"))
        @Expect(strOf(explicit, "status"), "found")
        @Expect(strOf(explicit, "kbId"), "b")
        @Expect(strOf(explicit, "text").contains("乙库"), true)
    }

    @TestCase
    func exactChunkUsesDocumentOffsetBeyondFirstTwoPages(): Unit {
        let dir = freshDir("reference-pages")
        let store = Store(dir)
        register(store, "many", "分页库", dir + "/docs", 31)
        // Global ord is deliberately unrelated to this document's position.
        DbHub.open(dir).run("UPDATE chunks SET ord = ord * 3 + 100 WHERE kb_id = ?", va([tv("many")]))
        let result = resolveKnowledgeReference(store, request("many", "./shared.md", "shared.md#29"))
        @Expect(strOf(result, "status"), "found")
        @Expect(strOf(result, "chunkId"), "shared.md#29")
        @Expect(strOf(result, "headingPath"), "章节 / 29")
        @Expect(strOf(result, "text").contains("切片 29"), true)
        @Expect(intOf(result, "offset"), 29)
        @Expect(intOf(result, "pageOffset"), 24)
        @Expect(intOf(result, "pageSize"), 12)
        @Expect(intOf(result, "totalChunks"), 31)
        @Expect(intOf(result, "ordinal"), 187)
        let heading = resolveKnowledgeReference(store, request("many", "shared.md", "", headingPath: "章节 / 27"))
        @Expect(intOf(heading, "offset"), 27)
        @Expect(strOf(resolveKnowledgeReference(store, request("many", "shared.md", "missing#29")), "status"), "missing")
        @Expect(strOf(resolveKnowledgeReference(store, request("many", "other.md", "shared.md#29")), "status"), "missing")
        @Expect(strOf(resolveKnowledgeReference(store, request("many", "shared.md", "shared.md#29", headingPath: "章节 / 2")), "status"), "missing")
    }

    @TestCase
    func deletedSourceStillResolvesIndexWithoutReadingArbitraryFiles(): Unit {
        let dir = freshDir("reference-deleted-source")
        let store = Store(dir)
        let root = dir + "/docs"
        register(store, "indexed", "已索引库", root, 1)
        writeText(root + "/shared.md", "原文件里未索引的内容不得冒充引用")
        let before = resolveKnowledgeReference(store, request("indexed", "shared.md", ""))
        @Expect(boolOf(before, "sourceExists"), true)
        @Expect(strOf(before, "text").contains("未索引的内容"), false)
        remove(Path(root + "/shared.md"))
        let after = resolveKnowledgeReference(store, request("indexed", "shared.md", ""))
        @Expect(strOf(after, "status"), "found")
        @Expect(boolOf(after, "sourceExists"), false)
        @Expect(strOf(after, "text"), strOf(before, "text"))
        @Expect(strOf(after, "absolutePath"), strOf(before, "absolutePath"))
        @Expect(strOf(after, "absolutePath").replace("\\", "/"), canonicalize(root).toString().replace("\\", "/") + "/shared.md")
        writeText(root + "/unindexed.md", "不属于索引，不能读取")
        @Expect(strOf(resolveKnowledgeReference(store, request("indexed", "unindexed.md", "")), "status"), "missing")
        DbHub.open(dir).run("DELETE FROM chunks WHERE kb_id = ?", va([tv("indexed")]))
        @Expect(strOf(resolveKnowledgeReference(store, request("indexed", "shared.md", "")), "status"), "missing")
    }

    @TestCase
    func invalidOrEscapingPathsAndUnknownLibrariesNeverFallback(): Unit {
        let dir = freshDir("reference-invalid")
        let store = Store(dir)
        register(store, "known", "登记库", dir + "/docs", 1)
        for (args in [JsonObject(), request("known", "", ""), request("", "", "", headingPath: "章节 / 0")]) {
            @Expect(strOf(resolveKnowledgeReference(store, args), "reason"), "invalid_input")
        }
        let badType = JsonObject()
        badType.put("docPath", JsonInt(7))
        @Expect(strOf(resolveKnowledgeReference(store, badType), "reason"), "invalid_input")
        for (path in ["../shared.md", "nested/../../shared.md", "/shared.md", "C:\\shared.md", "\\\\server\\share\\shared.md", "shared.md:stream", "shared.md.", "shared.md ", "NUL.txt"]) {
            @Expect(strOf(resolveKnowledgeReference(store, request("known", path, "")), "reason"), "unsafe_path")
        }
        @Expect(strOf(resolveKnowledgeReference(store, request("unknown", "shared.md", "")), "reason"), "unknown_kb")
        @Expect(strOf(resolveKnowledgeReference(store, request("known", "nested/../shared.md", "")), "status"), "found")
        // A stored index row with a hostile path is not a filesystem access grant.
        DbHub.open(dir).run("UPDATE chunks SET doc_path = ? WHERE kb_id = ?", va([tv("../outside.md"), tv("known")]))
        @Expect(strOf(resolveKnowledgeReference(store, request("known", "", "shared.md#0")), "reason"), "unsafe_path")
    }

    @TestCase
    func unregisteredIndexIsNotAReferenceSource(): Unit {
        let dir = freshDir("reference-unregistered")
        let store = Store(dir)
        register(store, "removed", "移除库", dir + "/docs", 1)
        DbHub.open(dir).run("DELETE FROM knowledge_bases WHERE id = ?", va([tv("removed")]))
        @Expect(strOf(resolveKnowledgeReference(store, request("", "shared.md", "")), "status"), "missing")
        @Expect(strOf(resolveKnowledgeReference(store, request("removed", "shared.md", "")), "reason"), "unknown_kb")
    }

    @TestCase
    func equivalentToolReturnsFullMetadataAndDoesNotMutateIndex(): Unit {
        let dir = freshDir("reference-tool")
        let store = Store(dir)
        register(store, "tool", "工具库", dir + "/docs", 2)
        let tools = referenceTools(store)
        @Assert(tools.size, 1)
        @Expect(tools[0].name, "resolve_knowledge_reference")
        @Expect(tools[0].risk, "read")
        let args = request("tool", "shared.md", "shared.md#1")
        let direct = resolveKnowledgeReference(store, args)
        let result = tools[0].run(args)
        @Expect(result.ok, true)
        let body = obj(result.details)
        for (key in ["status", "kbId", "docPath", "docTitle", "headingPath", "chunkId", "text", "absolutePath", "referenceId"]) {
            @Expect(strOf(body, key), strOf(direct, key))
        }
        @Expect(result.content.contains("base64"), false)
        @Expect(body.get("dataUrl").isNone(), true)
        @Expect(DbHub.open(dir).scalarInt("SELECT COUNT(*) FROM chunks", ArrayList<DbValue>()), 2)
        @Expect(DbHub.open(dir).getKv("meta", "migrated_kb_tool", ""), "")
    }

    @TestCase
    func retrievalAndCitationsKeepPreciseSourceAndSnapshot(): Unit {
        let dir = freshDir("reference-citation-metadata")
        let store = Store(dir)
        register(store, "single", "单库", dir + "/docs", 1)
        let search = ToolRegistry(store).kbSearch("single", "引用 中文快照", 2)
        @Expect(search.ok, true)
        match (search.data) {
            case hits: JsonArray =>
                @Assert(hits.size() > 0, true)
                let hit = obj(hits[0])
                @Expect(strOf(hit, "kbId"), "single")
                @Expect(strOf(hit, "chunkId"), "shared.md#0")
                let cites = citationsFromHits(hits)
                let citation = obj(cites[0])
                @Expect(strOf(citation, "kbId"), "single")
                @Expect(strOf(citation, "chunkId"), "shared.md#0")
                @Expect(strOf(citation, "text"), strOf(hit, "text"))
                @Expect(citationsUsedFromHits("回答[1]。", hits).size(), 1)
            case _ => @Expect(false, true)
        }
        let read = ToolBox(store).readChunk("single", "shared.md#0")
        @Expect(strOf(obj(read.data), "kbId"), "single")
        @Expect(strOf(obj(read.data), "chunkId"), "shared.md#0")
        let oldHit = JsonObject()
        oldHit.put("id", JsonString("old.md#3"))
        oldHit.put("text", JsonString("历史正文"))
        let oldHits = JsonArray(); oldHits.add(oldHit)
        @Expect(strOf(obj(citationsFromHits(oldHits)[0]), "chunkId"), "old.md#3")
    }

    @TestCase
    func webCitationRetainsActualUrlAndCachedText(): Unit {
        let source = JsonObject()
        source.put("index", JsonInt(1))
        source.put("title", JsonString("网页正文"))
        source.put("url", JsonString("https://example.com/article?q=中文"))
        source.put("path", JsonString("C:/cache/article.md"))
        source.put("text", JsonString("已抓取网页正文"))
        source.put("fetchedAt", JsonString("2026-10-24T12:00:00+08:00"))
        let sources = ArrayList<JsonObject>(); sources.add(source)
        let citation = obj(webCitationsFrom("来源[W1]", sources)[0])
        @Expect(strOf(citation, "docPath"), strOf(source, "url"))
        @Expect(strOf(citation, "url"), strOf(source, "url"))
        @Expect(strOf(citation, "text"), strOf(source, "text"))
        @Expect(strOf(citation, "path"), strOf(source, "path"))
    }
}
