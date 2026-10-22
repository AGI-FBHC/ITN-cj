package zhixun_learning

import std.core.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class CoursewareReferenceTests {
    @TestCase
    func chapterSourceIsVerbatimAndHasNoInventedBibliography(): Unit {
        let original = "# Fixture\n\nOriginal chapter text."
        let refs = cwChapterReference("doc-a", "bundle-a", "Fixture", "chapter.md", original)
        let source = cwJsonObjectFrom(cwRawObjectItems(refs)[0]).getOrThrow()
        @Expect(cwField(source, "excerpt"), original)
        @Expect(cwField(source, "kind"), "chapter-original")
        @Expect(cwField(source, "url"), "")
        @Expect(cwField(source, "author"), "")
        @Expect(cwChapterReference("missing", "bundle-a", "Title only", "", ""), "[]")
    }

    @TestCase
    func proseCompactsButCodeAndIndicesSurvive(): Unit {
        let refs = cwChapterReference("doc-a", "bundle-a", "Fixture", "chapter.md", "Original text")
        @Expect(cwNormalizeCoursewareCitations("甲。[1]乙。[1][1]丙。[4]", refs), "甲。乙。丙。 [1]")
        @Expect(cwNormalizeCoursewareCitations("甲。[1]乙。[4]", "[]"), "甲。乙。")
        let protected = "```js\narr[1]; // [4]\n```\n\n`arr[1]` [1](https://example.test) [doc][1]\n\narr[1] = [1];"
        @Expect(cwNormalizeCoursewareCitations(protected, refs), protected)
    }

    @TestCase
    func attachPreservesEscapesAndReplacesModelSources(): Unit {
        let refs = cwChapterReference("doc-a", "bundle-a", "Fixture", "chapter.md", "Original text")
        let raw = "{\"sections\":[{\"heading\":\"Title\",\"body\":\"甲。[1]乙。[1]\"}],\"code\":\"C:\\\\tmp\\narr[1]\",\"references\":[],\"sources\":[]}"
        let result = cwAttachReferences(raw, refs)
        let parsed = cwJsonObjectFrom(result).getOrThrow()
        @Expect(cwField(parsed, "code"), "C:\\tmp\narr[1]")
        @Expect(lrArray(result, "references"), refs)
        @Expect(lrArray(result, "sources"), refs)
        @Expect(cwField(cwObjectList(parsed, "sections")[0], "body"), "甲。乙。 [1]")
    }
}
