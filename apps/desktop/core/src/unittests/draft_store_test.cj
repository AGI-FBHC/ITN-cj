package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*
import itn_desktop_core.pi_tools.DraftStore
import itn_desktop_core.util.*

/*
 * 改动草稿：AI 写的每个文件都留一份原样，用户能看差异、能一键还原。
 * 这条链断在哪一环，用户就会遇到"文件被改了却退不回去"。
 */
@Test
class DraftStoreTest {
    /** 基本链：留样 → 改动 → 差异看得到 → 撤销写回原样 / 确认保留则保持新内容。 */
    @TestCase
    func discardRestoresOldContentAndMergeKeepsIt(): Unit {
        let d = freshDir("draft-basic")
        let file = d + "/note.md"
        writeText(file, "旧内容\n第二行\n")
        let ds = DraftStore(d, "s1", "t1")
        let id = ds.record("note.md", file, Some("旧内容\n第二行\n"), 2, 2)
        @Expect(id.size > 0, true)

        writeText(file, "新内容\n")
        let diff = ds.diffOf(id)
        @Expect(strOf(diff, "path"), "note.md")
        @Expect(strOf(diff, "before").contains("旧内容"), true)
        @Expect(strOf(diff, "after").contains("新内容"), true)

        @Expect(ds.discard(id), true)
        @Expect(readTextOr(file, "").contains("旧内容"), true)
        @Expect(ds.listOpen("s1").size, 0)
        // 已经收摊的草稿不能再撤销
        @Expect(ds.discard(id), false)

        let id2 = ds.record("note.md", file, Some(readTextOr(file, "")), 1, 1)
        writeText(file, "改完就保留\n")
        @Expect(ds.merge(id2), true)
        @Expect(readTextOr(file, "").contains("改完就保留"), true)
        @Expect(ds.listOpen("s1").size, 0)
    }

    /** 新建的文件：撤销 = 把它删掉（不要留下一个"看起来是用户自己建的"空壳）。 */
    @TestCase
    func discardOfNewFileRemovesIt(): Unit {
        let d = freshDir("draft-new")
        let file = d + "/fresh.md"
        let ds = DraftStore(d, "s2", "t2")
        let id = ds.record("fresh.md", file, None, 3, 0)
        writeText(file, "全新的\n")
        @Expect(exists(file), true)
        @Expect(ds.discard(id), true)
        @Expect(exists(file), false)
    }

    /** 全部撤销：这段会话里所有未确认的改动一起还原（文件卡上那个"全部撤销"）。 */
    @TestCase
    func discardAllRevertsEveryOpenDraft(): Unit {
        let d = freshDir("draft-all")
        let ds = DraftStore(d, "s3", "t3")
        let a = d + "/a.md"
        let b = d + "/b.md"
        writeText(a, "A 旧")
        writeText(b, "B 旧")
        ds.record("a.md", a, Some("A 旧"), 1, 1)
        ds.record("b.md", b, Some("B 旧"), 1, 1)
        writeText(a, "A 新")
        writeText(b, "B 新")
        @Expect(ds.discardAllOf("s3"), 2)
        @Expect(readTextOr(a, ""), "A 旧")
        @Expect(readTextOr(b, ""), "B 旧")
    }
}
