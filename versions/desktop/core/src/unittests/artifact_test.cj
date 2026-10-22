package itn_desktop_core.unittests

import std.fs.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.store.Store
import itn_desktop_core.tools.ToolRegistry

@Test
func artifactSaveHonorsArtifactsDirectory(): Unit {
    let dir = freshDir("artifact-save-dir")
    let reg = ToolRegistry(Store(dir))
    let draft = reg.saveArtifact("模型候选.md", "# 候选")
    let final = reg.saveArtifactTo("artifacts", "报告.md", "# 报告")
    let draftPath = match (draft.data) { case s: JsonString => s.getValue(); case _ => "" }
    let finalPath = match (final.data) { case s: JsonString => s.getValue(); case _ => "" }
    @Expect(draft.ok, true)
    @Expect(final.ok, true)
    @Expect(draftPath.contains("drafts"), true)
    @Expect(finalPath.contains("artifacts"), true)
    @Expect(exists(draftPath), true)
    @Expect(exists(finalPath), true)
    @Expect(exists(dir + "/drafts/报告.md"), false)
}
