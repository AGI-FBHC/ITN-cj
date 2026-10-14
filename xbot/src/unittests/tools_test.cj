package xbot.unittests

import std.collection.*
import std.regex.*
import stdx.encoding.json.*
import xbot.pi.*
import xbot.tools.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 真实工具：名字与参数对齐 Pi，行为也要对得上。
 * 沙箱那几条是安全底线：越界一律拒，命令要先开 --allow-exec。
 */
@Test
class ToolsTest {
    @TestCase
    func readReturnsWholeFileAndSlice(): Unit {
        let d = freshDir("tools-read")
        let ws = Workspace(d)
        @Assert(ws.writeText("a.md", "第一行\n第二行\n第三行\n"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let whole = reg.execute(modeStandard(), "c1", "read", strObj("path", "a.md"))
        @Expect(whole.isError, false)
        @Expect(containsSub(whole.content, "第三行"), true)
        // offset/limit：1-indexed
        let args = JsonObject()
        args.put("path", JsonString("a.md"))
        args.put("offset", JsonInt(2))
        args.put("limit", JsonInt(1))
        let slice = reg.execute(modeStandard(), "c2", "read", args)
        @Expect(containsSub(slice.content, "第二行"), true)
        @Expect(containsSub(slice.content, "第三行"), false)
        @Expect(containsSub(slice.content, "第 2-2 行"), true)
    }

    @TestCase
    func readWithoutPathFails(): Unit {
        let ws = Workspace(freshDir("tools-nopath"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let r = reg.execute(modeStandard(), "c", "read", JsonObject())
        @Expect(r.isError, true)
        @Expect(containsSub(r.content, "path"), true)
    }

    @TestCase
    func writeThenReadRoundTrips(): Unit {
        let ws = Workspace(freshDir("tools-write"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let w = reg.execute(modeStandard(), "c", "write",
            twoObj("path", "深/目录/笔记.md", "content", "内容一"))
        @Expect(w.isError, false)
        @Expect(ws.readText("深/目录/笔记.md").getOrThrow(), "内容一")
    }

    @TestCase
    func editReplacesUniquelyAndCanDoSeveralInOneCall(): Unit {
        let ws = Workspace(freshDir("tools-edit"))
        @Assert(ws.writeText("x.md", "alpha\nbeta\ngamma\n"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        // 一次改两处（Pi 的 edits[]）
        let e1 = JsonObject()
        e1.put("oldText", JsonString("alpha"))
        e1.put("newText", JsonString("ALPHA"))
        let e2 = JsonObject()
        e2.put("oldText", JsonString("gamma"))
        e2.put("newText", JsonString("GAMMA"))
        let edits = JsonArray()
        edits.add(e1)
        edits.add(e2)
        let args = JsonObject()
        args.put("path", JsonString("x.md"))
        args.put("edits", edits)
        let r = reg.execute(modeStandard(), "c", "edit", args)
        @Expect(r.isError, false)
        @Expect(ws.readText("x.md").getOrThrow(), "ALPHA\nbeta\nGAMMA\n")
    }

    @TestCase
    func editRefusesMissingOrAmbiguousText(): Unit {
        let ws = Workspace(freshDir("tools-edit2"))
        @Assert(ws.writeText("x.md", "same\nsame\n"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let miss = reg.execute(modeStandard(), "c", "edit", strObj("path", "x.md"))
        @Expect(miss.isError, true)
        @Expect(containsSub(miss.content, "edits"), true)
        // 唯一性：oldText 出现两次必须拒
        let e1 = JsonObject()
        e1.put("oldText", JsonString("same"))
        e1.put("newText", JsonString("other"))
        let edits = JsonArray()
        edits.add(e1)
        let args = JsonObject()
        args.put("path", JsonString("x.md"))
        args.put("edits", edits)
        let amb = reg.execute(modeStandard(), "c2", "edit", args)
        @Expect(amb.isError, true)
        @Expect(containsSub(amb.content, "不唯一"), true)
        @Expect(ws.readText("x.md").getOrThrow(), "same\nsame\n")
    }

    @TestCase
    func lsListsOneLevelWithDirectoryMarkers(): Unit {
        let ws = Workspace(freshDir("tools-ls"))
        @Assert(ws.writeText("a.md", "x"))
        @Assert(ws.writeText("sub/b.md", "y"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let r = reg.execute(modeStandard(), "c", "ls", JsonObject())
        @Expect(r.isError, false)
        @Expect(containsSub(r.content, "a.md"), true)
        @Expect(containsSub(r.content, "sub/"), true)
        @Expect(containsSub(r.content, "b.md"), false)
    }

    @TestCase
    func findMatchesByGlob(): Unit {
        let ws = Workspace(freshDir("tools-find"))
        @Assert(ws.writeText("a.md", "x"))
        @Assert(ws.writeText("src/b.cj", "y"))
        @Assert(ws.writeText("src/deep/c.cj", "z"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let md = reg.execute(modeStandard(), "c", "find", strObj("pattern", "**/*.md"))
        @Expect(containsSub(md.content, "a.md"), true)
        let cj = reg.execute(modeStandard(), "c2", "find", strObj("pattern", "**/*.cj"))
        @Expect(cj.isError, false)
        @Expect(containsSub(cj.content, "src/b.cj"), true)
        @Expect(containsSub(cj.content, "src/deep/c.cj"), true)
        let none = reg.execute(modeStandard(), "c3", "find", strObj("pattern", "*.py"))
        @Expect(none.isError, true)
    }

    @TestCase
    func grepSupportsRegexLiteralIgnoreCaseAndGlob(): Unit {
        let ws = Workspace(freshDir("tools-grep"))
        @Assert(ws.writeText("a.md", "提示词工程\nPrompt Engineering\n"))
        @Assert(ws.writeText("b.txt", "prompt engineering\n"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        // 正则
        let re = reg.execute(modeStandard(), "c", "grep", strObj("pattern", "提示.*工程"))
        @Expect(re.isError, false)
        @Expect(containsSub(re.content, "a.md:1"), true)
        // ignoreCase + glob 过滤
        let args = JsonObject()
        args.put("pattern", JsonString("prompt"))
        args.put("ignoreCase", JsonBool(true))
        args.put("glob", JsonString("**/*.txt"))
        let ic = reg.execute(modeStandard(), "c2", "grep", args)
        @Expect(ic.isError, false)
        @Expect(containsSub(ic.content, "b.txt"), true)
        @Expect(containsSub(ic.content, "a.md"), false)
        // literal 关掉正则
        let args2 = JsonObject()
        args2.put("pattern", JsonString("提示.*工程"))
        args2.put("literal", JsonBool(true))
        let lit = reg.execute(modeStandard(), "c3", "grep", args2)
        @Expect(lit.isError, true)
    }

    @TestCase
    func everyPathEscapeIsRefused(): Unit {
        let ws = Workspace(freshDir("tools-sandbox"))
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let bad = reg.execute(modeStandard(), "c", "read", strObj("path", "../../windows/win.ini"))
        @Expect(bad.isError, true)
        @Expect(containsSub(bad.content, "越出工作区"), true)
        let bad2 = reg.execute(modeStandard(), "c2", "write",
            twoObj("path", "../逃出去.md", "content", "x"))
        @Expect(bad2.isError, true)
        let bad3 = reg.execute(modeStandard(), "c3", "read", strObj("path", "C:/windows/win.ini"))
        @Expect(bad3.isError, true)
        // 路径归一化本身
        @Expect(normalizeRel("a/../../b").isNone(), true)
        @Expect(normalizeRel("a/./b").getOrThrow(), "a/b")
        @Expect(normalizeRel("a\\b").getOrThrow(), "a/b")
    }

    @TestCase
    func commandToolIsGatedBehindAllowExec(): Unit {
        let ws = Workspace(freshDir("tools-exec"))
        let off = ToolRegistry()
        registerWorkspaceTools(off, ws, false)
        @Expect(off.available("powershell"), false)
        @Expect(exposes(off, modeAgent(), "powershell"), false)
        let r = off.execute(modeAgent(), "c", "powershell", strObj("command", "Write-Output hi"))
        @Expect(r.isError, true)
        @Expect(containsSub(r.content, "不可用"), true)
        let on = ToolRegistry()
        registerWorkspaceTools(on, ws, true)
        @Expect(on.available("powershell"), true)
        @Expect(on.specsOf(modeAgent()).size, 7)
        @Expect(on.specsOf(modeStandard()).size, 6)
    }

    @TestCase
    func powershellActuallyRunsAndReportsExitCode(): Unit {
        let ws = Workspace(freshDir("tools-exec2"))
        let r = ws.runPowerShell("Write-Output '你好 world'", "", 10)
        @Expect(r.code, 0)
        @Expect(containsSub(r.out, "world"), true)
        // 中文输出不能乱码（命令前插了 UTF-8 输出编码设置）
        @Expect(containsSub(r.out, "你好"), true)
        let bad = ws.runPowerShell("exit 3", "", 10)
        @Expect(bad.code, 3)
    }

    @TestCase
    func commandTimeoutKillsTheChildAndReports(): Unit {
        let ws = Workspace(freshDir("tools-timeout"))
        // ping 6 次大约 5 秒；给它 1 秒超时
        let r = ws.runPowerShell("ping -n 6 127.0.0.1", "", 1)
        @Expect(r.timedOut, true)
        @Assert(r.wallMs < 4000)
        @Expect(containsSub(r.err, "超过"), true)
        // 正常命令带超时也要能跑完并拿到退出码
        let ok = ws.runPowerShell("Write-Output ok", "", 10)
        @Expect(ok.timedOut, false)
        @Expect(ok.code, 0)
        @Expect(containsSub(ok.out, "ok"), true)
    }

    @TestCase
    func truncationIsByteSafeAndExplainsItself(): Unit {
        let sb = StringBuilder()
        var i = 0
        while (i < 10) {
            sb.append("中文一行\n")
            i = i + 1
        }
        let t = truncateHead(sb.toString(), 3, 1024 * 1024)
        @Expect(t.truncated, true)
        @Expect(containsSub(t.content, "还有 7 行"), true)
        @Assert(isPrefix("中文一行\n中文一行\n中文一行", t.content))
        // 字节上限：不能切出半个汉字
        let t2 = truncateHead(sb.toString(), 1000, 20)
        @Expect(t2.truncated, true)
        @Expect(t2.content.size > 20, true)
        // 尾巴是说明文字，前面那段必须还是原文的前缀（证明没把汉字切坏）
        let cutAt = indexOfSub(t2.content, "\n...")
        @Assert(cutAt > 0)
        @Assert(isPrefix(safeUtf8(t2.content.toArray(), 0, cutAt), sb.toString()))
        @Expect(formatSize(2048), "2KB")
    }

    @TestCase
    func globToRegexHandlesDoubleStarAndQuestion(): Unit {
        let r1 = Regex(globToRegex("**/*.md"))
        @Expect(r1.matches("a.md"), true)
        @Expect(r1.matches("src/a.md"), true)
        @Expect(r1.matches("src/deep/a.md"), true)
        @Expect(r1.matches("a.txt"), false)
        let r2 = Regex(globToRegex("src/*.cj"))
        @Expect(r2.matches("src/a.cj"), true)
        @Expect(r2.matches("src/sub/a.cj"), false)
        let r3 = Regex(globToRegex("a?.md"))
        @Expect(r3.matches("ab.md"), true)
        @Expect(r3.matches("abc.md"), false)
    }
}
