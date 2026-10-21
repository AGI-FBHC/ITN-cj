package zhixun_learning

import std.collection.*
import std.core.*
import std.env.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*

func kbPrimitiveCheck(condition: Bool, message: String): Unit {
    if (!condition) { throw Exception(message) }
}

func kbPrimitiveRejects(action: () -> Unit): Unit {
    var rejected = false
    try { action() } catch (_: Exception) { rejected = true }
    kbPrimitiveCheck(rejected, "Invalid input must be rejected")
}

func kbPrimitiveRepeated(text: String, count: Int64): String {
    let out = StringBuilder()
    var i: Int64 = 0
    while (i < count) { out.append(text); i += 1 }
    out.toString()
}

func cwStructuredSlidesFixture(kinds: Array<String>): JsonObject {
    let slides = JsonArrWriter()
    var index: Int64 = 0
    while (index < kinds.size) {
        let kind = kinds[index]
        let slide = JsonWriter()
        slide.putStr("title", "第 " + (index + 1).toString() + " 页")
        slide.putStr("kind", kind)
        let points = JsonArrWriter()
        var pointIndex: Int64 = 0
        while (pointIndex < 3) {
            let point = JsonWriter()
            point.putStr("heading", "要点 " + (pointIndex + 1).toString())
            point.putStr("detail", "这是对 " + kind + " 页面的完整说明，学习者可以据此理解概念、方法与应用边界。")
            points.addRaw(point.toJson())
            pointIndex += 1
        }
        slide.putRaw("points", points.toJson())
        slide.putStr("speakerNotes", kbPrimitiveRepeated("请结合本章原文理解这一页的核心概念、操作方法和实际应用。", 4))
        slides.addRaw(slide.toJson())
        index += 1
    }
    let deck = JsonWriter()
    deck.putStr("title", "结构化演示文稿")
    deck.putRaw("slides", slides.toJson())
    cwJsonObjectFrom(deck.toJson()).getOrThrow()
}

func kbPrimitiveAtomCovered(body: String, pieces: Array<KbPiece>, atom: String): Unit {
    let start = body.indexOf(atom).getOrThrow()
    let end = start + atom.size
    var contained = false
    for (piece in pieces) {
        if (piece.startOffset <= start && piece.endOffset >= end) { contained = true }
        kbPrimitiveCheck(!(start < piece.startOffset && piece.startOffset < end), "Chunk starts inside a protected Markdown atom")
        kbPrimitiveCheck(!(start < piece.endOffset && piece.endOffset < end), "Chunk ends inside a protected Markdown atom")
    }
    kbPrimitiveCheck(contained, "A protected Markdown atom was not preserved whole")
}

func kbAuditHasBody(text: String): Bool {
    for (line in kbSourceLines(text.toArray())) {
        let value = line.text.trimAscii()
        if (value.size == 0 || kbHeadingLevel(line.text) > 0 || kbSetextLevel(line.text) > 0) { continue }
        if (value == "***" || value == "---" || value == "___") { continue }
        return true
    }
    false
}

func kbOptionalCorpusAudit(): Unit {
    let directory = match (getVariable("ZHIXUN_TEST_CORPUS")) { case Some(value) => value; case None => return }
    let files = ArrayList<String>()
    kbWalkFiles(directory.replace("\\", "/"), "", files, 0)
    var documents: Int64 = 0
    var chunks: Int64 = 0
    var shortChunks: Int64 = 0
    let issues = JsonArrWriter()
    for (file in files) {
        if (!kbIsSourceDocument(file)) { continue }
        let body = String.fromUtf8(File.readFrom(Path(directory + "/" + file)))
        let pieces = kbChunksFor(file, body, 800, 120)
        kbValidatePieces(body, pieces)
        documents += 1; chunks += pieces.size
        for (piece in pieces) {
            if (kbAuditHasBody(body) && !kbAuditHasBody(piece.text)) {
                let issue = JsonWriter(); issue.putStr("file", file); issue.putInt("start", piece.sourceStart)
                issue.putInt("end", piece.sourceEnd); issue.putStr("kind", "heading-only")
                issues.addRaw(issue.toJson())
            }
            if (piece.charCount() < 120 && pieces.size > 1) { shortChunks += 1 }
        }
        let original = body.toArray()
        for (block in kbBlocks(file, original)) {
            if (!block.indivisible || block.isHeading) { continue }
            var contained = false
            for (piece in pieces) {
                if (piece.sourceStart <= block.start && piece.sourceEnd >= block.end) { contained = true }
                kbPrimitiveCheck(!(block.start < piece.sourceStart && piece.sourceStart < block.end), "Protected source block split: " + file)
                kbPrimitiveCheck(!(block.start < piece.sourceEnd && piece.sourceEnd < block.end), "Protected source block split: " + file)
            }
            kbPrimitiveCheck(contained, "Protected block lost: " + file)
        }
    }
    let report = JsonWriter()
    report.putInt("documents", documents); report.putInt("chunks", chunks); report.putInt("shortChunks", shortChunks)
    report.putRaw("issues", issues.toJson())
    File.writeTo(Path(directory + "/report.json"), report.toJson().toArray())
    println("CORPUS_AUDIT " + documents.toString() + " documents, " + chunks.toString() + " chunks; see report.json")
    kbPrimitiveCheck(issues.toJson() == "[]", "Whole-corpus heading-only chunks found; see corpus audit report")
}

@Test
class KbPrimitiveTests {
    @TestCase
    func coursewareEvidenceStaysInsideTheSourceChapter(): Unit {
        let evidence = cwEvidence("第一章 示例", "# 本章正文\n只允许使用这段原文。")
        kbPrimitiveCheck(evidence.contains("本章原文"), "Chapter evidence must identify the source chapter")
        kbPrimitiveCheck(evidence.contains("只允许使用这段原文"), "Chapter evidence lost the source text")
        kbPrimitiveCheck(!evidence.contains("跨章节"), "Courseware generation must not include cross-chapter retrieval")
    }
    @TestCase
    func presentationOutlineRequiresARealNarrativeDeck(): Unit {
        let kinds = ["title", "agenda", "overview", "concept", "code", "comparison", "process", "table", "timeline", "case", "practice", "conclusion"]
        let valid = cwStructuredSlidesFixture(kinds)
        kbPrimitiveCheck(cwSlidesIssues(valid, CW_PRESENTATION_SLIDE_COUNT).size == 0, "A complete structured deck must pass validation")
        let repetitive = cwStructuredSlidesFixture(Array<String>(CW_PRESENTATION_SLIDE_COUNT, repeat: "overview"))
        kbPrimitiveCheck(cwSlidesIssues(repetitive, CW_PRESENTATION_SLIDE_COUNT).size > 0, "A repetitive Markdown-like deck must be rejected")
    }
    @TestCase
    func learnerResourceContainersPreserveQuotedCode(): Unit {
        let text = "{\"guide\":{\"steps\":[{\"code\":\"print(\\\"[中文]\\\")\\n{a: 1}\",\"expectedOutput\":\"值 ] }\"}]}}"
        let guide = lrObject(text, "guide")
        let steps = lrArray(guide, "steps")
        let parsed = jsonArrayFromText(steps)
        kbPrimitiveCheck(parsed.size() == 1, "Escaped brackets must not cut a published resource")
        kbPrimitiveCheck((jsonGetString(parsed[0].asObject(), "code") ?? "") == "print(\"[中文]\")\n{a: 1}", "Resource code lost quoting or Unicode")
        kbPrimitiveCheck(jsonArrayFromText(lrMergeArrays(steps, steps)).size() == 2, "Published guide steps did not merge")
        kbPrimitiveCheck(lrObject(text, "missing").size == 0, "Missing resources must stay unavailable")
    }
    @TestCase
    func coursewareIdentityIgnoresDisplayOrder(): Unit {
        let refs = HashMap<String, String>()
        refs["source-document"] = "stable-chapter"
        refs["stable-chapter"] = "stable-chapter"
        kbPrimitiveCheck(cwLessonSourceId("", "[{\"id\":\"source-document\"}]", refs) == "stable-chapter", "Legacy source must bind to the chapter identity")
        kbPrimitiveCheck(cwLessonSourceId("", "[{\"id\":\"stable-chapter\"}]", refs) == "stable-chapter", "Current source identity must survive reordering")
        kbPrimitiveCheck(cwLessonSourceId("bound-chapter", "[{\"id\":\"other\"}]", refs) == "bound-chapter", "A bound lesson must not be reassigned")
        kbPrimitiveCheck(cwLessonSourceId("", "[]", refs) == "", "Unknown legacy lessons must be retained without guessing a chapter")
    }
    @TestCase
    func sourceCoverageAndProtectedBlocks(): Unit {
        let code = "```python\n# code is not a heading\n" + kbPrimitiveRepeated("print('中文🐱')\n", 60) + "```\n"
        let tex = "$$\n" + kbPrimitiveRepeated("x_{i+1}=x_i+1\\\\\n", 40) + "$$\n"
        let table = "| 名称 | Value |\n| --- | --- |\n" + kbPrimitiveRepeated("| 数据 | 73.25% |\n", 40)
        let image = "![原图](../images/中文%20图片.png)\n\n图 1：完整图注，不能与图片分开。\n"
        let body = String.fromUtf8([239, 187, 191]) + "# 多语言标题\r\n\r\n" +
            kbPrimitiveRepeated("中文和 English と日本語🐱，原文必须完整保留。\n", 25) +
            code + "\n" + tex + "\n" + table + "\n" + image + "\n## 后续章节\n末尾空白也保留。  \n\n"
        let pieces = kbChunksFor("通用资源", body, 200, 40)
        kbValidatePieces(body, pieces)
        kbPrimitiveCheck(pieces.size > 3, "Expected multiple semantic chunks")
        kbPrimitiveCheck(pieces[0].startOffset == 0 && pieces[pieces.size - 1].endOffset == body.size, "Source edges must be covered")
        for (piece in pieces) {
            kbPrimitiveCheck(piece.startOffset == piece.sourceStart && piece.endOffset == piece.sourceEnd, "Offset aliases differ")
            kbPrimitiveCheck(!piece.headingPath.contains("code is not a heading"), "A fenced comment became a heading")
        }
        kbPrimitiveAtomCovered(body, pieces, code)
        kbPrimitiveAtomCovered(body, pieces, tex)
        kbPrimitiveAtomCovered(body, pieces, table)
        kbPrimitiveAtomCovered(body, pieces, image)
        kbOptionalCorpusAudit()
    }

    @TestCase
    func plainTextOverlapAndValidationFailures(): Unit {
        let body = "  " + kbPrimitiveRepeated("Mixed 中文🐱 sentence。", 90) + "\n\n  "
        let pieces = kbChunksFor("No headings", body, 200, 40)
        kbValidatePieces(body, pieces)
        kbPrimitiveCheck(pieces.size > 1 && pieces[1].startOffset < pieces[0].endOffset, "Ordinary text should overlap")
        kbPrimitiveRejects({ => kbValidatePieces("abc", [KbPiece("", "a", 0, 1), KbPiece("", "c", 2, 3)]) })
        kbPrimitiveRejects({ => kbValidatePieces("abc", [KbPiece("", "abd", 0, 3)]) })
        kbPrimitiveRejects({ => kbValidatePieces("中文", [KbPiece("", "中", 0, 2), KbPiece("", "文", 2, 6)]) })
        kbPrimitiveRejects({ => kbValidatePieces("abc", Array<KbPiece>(0, repeat: KbPiece("", ""))) })
        kbValidatePieces("", Array<KbPiece>(0, repeat: KbPiece("", "")))
    }

    @TestCase
    func strictEmbeddingParsingAndCosineDimensions(): Unit {
        let vectors = parseEmbeddingArray("{\"data\":[{\"index\":1,\"embedding\":[3,4]},{\"index\":0,\"embedding\":[1,2]}]}", 2)
        kbPrimitiveCheck(vectors.size == 2 && vectors[0][0] == 1.0 && vectors[1][1] == 4.0, "Embedding index reordering failed")
        for (invalid in [
            "{\"data\":[{\"index\":0,\"embedding\":[1]}]}",
            "{\"data\":[{\"index\":0,\"embedding\":[1]},{\"index\":0,\"embedding\":[2]}]}",
            "{\"data\":[{\"index\":0,\"embedding\":[1]},{\"index\":1,\"embedding\":[2,3]}]}",
            "{\"data\":[{\"index\":0,\"embedding\":[0]},{\"index\":1,\"embedding\":[2]}]}",
            "{\"data\":[{\"index\":0,\"embedding\":[\"1\"]},{\"index\":1,\"embedding\":[2]}]}",
            "{\"data\":[{\"embedding\":[1]},{\"index\":1,\"embedding\":[2]}]}",
            "{\"data\":[{\"index\":0,\"embedding\":[1e9999]},{\"index\":1,\"embedding\":[2]}]}"
        ]) { kbPrimitiveRejects({ => let _value = parseEmbeddingArray(invalid, 2) }) }
        kbPrimitiveRejects({ => let _value = kbQuantizedCosine([1.0, 0.0], [255]) })
    }

    @TestCase
    func nestedHeadingsStayWithTheirContent(): Unit {
        let body = "# 功能清单\n\n## 已实现功能\n\n### 工作流功能\n\n#### 完整工作流\n- 搜索论文\n- 分析内容\n- 生成引用\n\n#### 简化工作流\n- 搜索加分析\n- 展示结果\n\n### 前端功能\n\n#### 界面\n- 响应式设计\n- 参数配置\n"
        let pieces = kbChunksFor("通用资源", body, 800, 120)
        kbPrimitiveCheck(pieces.size == 1, "Small nested sections must be packed, not indexed as headings only")
        kbPrimitiveCheck(pieces[0].text == body, "Packing changed the original source")
        let large = body + "\n" + kbPrimitiveRepeated("另一段完整正文，包含独立的解释和例子。\n", 150)
        for (piece in kbChunksFor("通用资源", large, 200, 40)) {
            kbPrimitiveCheck(kbHasChunkBody(piece.text), "A heading-only retrieval chunk was emitted")
        }
        let code = "```text\n" + kbPrimitiveRepeated("这是必须保持完整的保护块。\n", 80) + "```\n"
        let separators = "# 开始\n\n正文说明。\n" + code + "\n---\n\n" + code + "\n\n## 结束标题\n\n"
        let guarded = kbChunksFor("通用资源", separators, 800, 120)
        for (piece in guarded) {
            kbPrimitiveCheck(kbHasChunkBody(piece.text), "Separator, blank or trailing heading became a retrieval slice")
        }
        kbValidatePieces(separators, guarded)
        let item = "- 一条较长的列表项，" + kbPrimitiveRepeated("同一条内容及补充说明不能在中间切开。", 12) + "\n  这仍然是该条内容的补充。\n"
        let list = "# 连贯列表\n\n" + kbPrimitiveRepeated(item, 12)
        let listPieces = kbChunksFor("通用资源", list, 800, 120)
        for (piece in listPieces) {
            kbPrimitiveCheck(!piece.text.startsWith("同一条") && !piece.text.startsWith("  这仍然"), "A list item was split in the middle")
        }
        for (block in kbBlocks("通用资源", list.toArray())) {
            if (!block.indivisible || block.isHeading) { continue }
            for (piece in listPieces) {
                kbPrimitiveCheck(!(block.start < piece.sourceStart && piece.sourceStart < block.end), "List item start was split")
                kbPrimitiveCheck(!(block.start < piece.sourceEnd && piece.sourceEnd < block.end), "List item end was split")
            }
        }
    }

    @TestCase
    func unicodeSourceNormalization(): Unit {
        kbPrimitiveCheck(kbDecodeSourceText([255,254,45,78,61,216,49,220,13,0,10,0]) == "中🐱\r\n", "UTF-16LE lost characters")
        kbPrimitiveCheck(kbDecodeSourceText([254,255,78,45,216,61,220,49]) == "中🐱", "UTF-16BE lost characters")
        kbPrimitiveCheck(kbDecodeSourceText("原文 UTF-8".toArray()) == "原文 UTF-8", "UTF-8 source changed")
        kbPrimitiveRejects({ => let _value = kbDecodeSourceText([255,254,0]) })
        kbPrimitiveRejects({ => let _value = kbDecodeSourceText([255,254,0,216,65,0]) })
    }

    @TestCase
    func strictJsonAndSvgValidation(): Unit {
        let object = kbParseChatJson("```json\n{\"title\":\"多语言中文🐱\"}\n```")
        kbPrimitiveCheck((jsonGetString(object, "title") ?? "") == "多语言中文🐱", "JSON fence parsing lost Unicode")
        kbPrimitiveRejects({ => let _value = kbParseChatJson("说明\n{\"ok\":true}") })
        kbPrimitiveRejects({ => let _value = kbParseChatJson("[]") })
        kbPrimitiveCheck(briefBody(kbPrimitiveRepeated("中🐱", 200)).size <= 303, "Error truncation exceeds its byte budget")
        let root = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 128 128\">"
        let safe = kbValidateLogoSvg(root + "<circle cx=\"64\" cy=\"64\" r=\"24\" fill=\"#7c3aed\"/></svg>")
        kbPrimitiveCheck(safe.contains("#7c3aed"), "Safe shape rejected")
        for (invalidSvg in [
            root + "<script>alert(1)</script></svg>",
            root + "<circle r=\"1\" onclick=\"alert(1)\"/></svg>",
            root + "<image href=\"https://example.org/a.png\"/></svg>",
            root + "<foreignObject><div>bad</div></foreignObject></svg>",
            root + "<circle fill=\"url(https://example.org/a)\" r=\"1\"/></svg>",
            root + "<title>&entity;</title><circle r=\"1\"/></svg>",
            root + "<g><circle r=\"1\"/></svg>",
            root + "<circle r=\"1\" style=\"fill:red\"/></svg>"
        ]) { kbPrimitiveRejects({ => let _value = kbValidateLogoSvg(invalidSvg) }) }
    }
}
