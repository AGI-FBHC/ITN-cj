package zhixun_learning

import std.collection.*
import std.core.*
import std.unittest.*
import std.unittest.testmacro.*

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

@Test
class KbPrimitiveTests {
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
