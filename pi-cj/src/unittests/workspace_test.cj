package pi_cj.unittests

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import pi_cj.pi.*
import pi_cj.tools.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 工作区沙箱：模型给的是相对路径，越界一律拒绝。
 * 这一组是安全底线，写错了就是"模型能读写你整台电脑"。
 */
@Test
class WorkspaceTest {
    @TestCase
    func relativePathsAreNormalized(): Unit {
        @Expect(normalizeRel("a/b.md").getOrThrow(), "a/b.md")
        @Expect(normalizeRel("a\\b.md").getOrThrow(), "a/b.md")
        @Expect(normalizeRel("./a/./b.md").getOrThrow(), "a/b.md")
        @Expect(normalizeRel("a/../b.md").getOrThrow(), "b.md")
        @Expect(normalizeRel(".").getOrThrow(), "")
        @Expect(normalizeRel("").getOrThrow(), "")
        @Expect(normalizeRel("a//b").getOrThrow(), "a/b")
        // 绝对路径被当成相对路径（因此仍然关在工作区里），但盘符与冒号一律拒绝
        @Expect(normalizeRel("/etc/passwd").getOrThrow(), "etc/passwd")
        match (normalizeRel("..")) {
            case Some(_) => @Fail("不该接受 ..")
            case None => ()
        }
        match (normalizeRel("a/../../b")) {
            case Some(_) => @Fail("不该接受越界路径")
            case None => ()
        }
        match (normalizeRel("C:/windows")) {
            case Some(_) => @Fail("不该接受盘符")
            case None => ()
        }
        match (normalizeRel("a/b:c")) {
            case Some(_) => @Fail("不该接受冒号")
            case None => ()
        }
    }

    @TestCase
    func resolveStaysInsideTheWorkspace(): Unit {
        let ws = Workspace("target/test-ws")
        @Expect(ws.resolve("a/b.md").getOrThrow(), "target/test-ws/a/b.md")
        @Expect(ws.resolve("").getOrThrow(), "target/test-ws")
        match (ws.resolve("../x")) {
            case Some(_) => @Fail("越界路径不该解析成功")
            case None => ()
        }
        match (ws.resolve("a/../../../x")) {
            case Some(_) => @Fail("越界路径不该解析成功")
            case None => ()
        }
    }

    @TestCase
    func writingAndReadingRoundTrips(): Unit {
        let ws = Workspace("target/test-ws")
        @Assert(ws.writeText("out/子目录/笔记.md", "第一行\n第二行"))
        @Expect(ws.readText("out/子目录/笔记.md").getOrThrow(), "第一行\n第二行")
        // 覆盖写
        @Assert(ws.writeText("out/子目录/笔记.md", "改过了"))
        @Expect(ws.readText("out/子目录/笔记.md").getOrThrow(), "改过了")
        // 读不到的两种情形：不存在、是目录
        match (ws.readText("out/不存在.md")) {
            case Some(_) => @Fail("不存在的文件不该读到")
            case None => ()
        }
        match (ws.readText("out")) {
            case Some(_) => @Fail("目录不该当文件读")
            case None => ()
        }
        // 越界写必须失败，且外面真的没被写出来
        @Expect(ws.writeText("../../逃出去.md", "x"), false)
        @Expect(exists("../../逃出去.md"), false)
    }

    @TestCase
    func listingAndSearchingSkipNoiseDirectories(): Unit {
        let ws = Workspace("target/test-ws2")
        @Assert(ws.writeText("note.md", "提示词的三要素\n角色 任务 格式"))
        @Assert(ws.writeText("src/main.cj", "main() { }"))
        @Assert(ws.writeText("node_modules/x/y.js", "不该出现"))
        var joined = ""
        for (it in ws.list("", true)) {
            joined = joined + it + "|"
        }
        @Assert(joined.contains("note.md"))
        @Assert(joined.contains("src/main.cj"))
        @Expect(joined.contains("node_modules"), false)
        // 只列子目录时不该带出别的层级
        var top = ""
        for (it in ws.list("src", false)) {
            top = top + it + "|"
        }
        @Assert(top.contains("main.cj"))
        @Expect(top.contains("note.md"), false)
        let hits = ws.search("三要素", "")
        @Expect(hits.size, 1)
        @Assert(hits[0].contains("note.md:1:"))
        let none = ws.search("绝对找不到的字", "")
        @Expect(none.size, 0)
    }

    @TestCase
    func theToolsRefuseToLeaveTheWorkspace(): Unit {
        let ws = Workspace("target/test-ws3")
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        // 越界读被拒
        let r1 = reg.execute(modeStandard(), "read_file", strObj("path", "../../../windows/win.ini"))
        @Expect(r1.ok, false)
        // 越界写被拒
        let r2 = reg.execute(modeStandard(), "write_file", twoObj("path", "../../逃出去2.md", "content", "x"))
        @Expect(r2.ok, false)
        @Expect(exists("../../逃出去2.md"), false)
        // 没开 --allow-exec 时命令工具不可用，也不在提示词里
        @Expect(reg.available("run_command"), false)
        @Assert(reg.unavailableReason("run_command").contains("--allow-exec"))
        @Expect(reg.promptText(modeAgent()).contains("run_command"), false)
        let r3 = reg.execute(modeAgent(), "run_command", strObj("command", "echo hi"))
        @Expect(r3.ok, false)
        // 开了之后才可用
        let reg2 = ToolRegistry()
        registerWorkspaceTools(reg2, ws, true)
        @Assert(reg2.promptText(modeAgent()).contains("run_command"))
    }
}
