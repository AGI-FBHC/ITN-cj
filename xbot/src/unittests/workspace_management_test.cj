package xbot.unittests

import std.collection.*
import std.fs.*
import std.posix.*
import stdx.encoding.json.*
import xbot.pi.*
import xbot.cli.*
import xbot.tools.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 项目目录管理这一块：敏感路径拒读、保护目录、信任继承、工作区登记表。
 * 这几条是"模型能不能碰你的东西"的底线，所以断言都在行为上，不看文案。
 */
@Test
class WorkspaceManagementTest {
    @TestCase
    func sensitivePathsAreRefusedByTools(): Unit {
        let ws = Workspace(freshDir("ws-deny"))
        @Assert(ws.writeText("a.md", "x"))
        @Expect(ws.denyReason("a.md"), "")
        @Assert(ws.denyReason(".env.local").size > 0)
        @Assert(ws.denyReason(".env").size > 0)
        @Assert(ws.denyReason("sub/.env.local").size > 0)
        @Assert(ws.denyReason(".git/config").size > 0)
        @Assert(ws.denyReason(".ssh/id_rsa").size > 0)
        @Assert(ws.denyReason("../外面.md").size > 0)
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let r = reg.execute(modeStandard(), "c", "read", strObj("path", ".env.local"))
        @Expect(r.isError, true)
        @Expect(containsSub(r.content, "敏感"), true)
        let r2 = reg.execute(modeStandard(), "c2", "write",
            twoObj("path", ".env.local", "content", "SECRET=1"))
        @Expect(r2.isError, true)
    }

    @TestCase
    func protectedRootsAreRefused(): Unit {
        let root = freshDir("ws-protect")
        let protected = root + "/private"
        Directory.create(protected, recursive: true)
        fsWrite(protected + "/secret.txt", "不该看到")
        let deny = ArrayList<String>()
        deny.add(protected)
        let ws = Workspace(root, deny)
        @Expect(ws.denyReason("private/secret.txt").size > 0, true)
        @Expect(ws.denyReason("ok.md"), "")
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let r = reg.execute(modeStandard(), "c", "read", strObj("path", "private/secret.txt"))
        @Expect(r.isError, true)
        @Expect(containsSub(r.content, "受保护"), true)
    }

    @TestCase
    func trustIsInheritedFromTheNearestAncestor(): Unit {
        let data = freshDir("trust-data")
        let parent = freshDir("trust-parent")
        let child = absPath(parent) + "/child"
        Directory.create(child, recursive: true)
        // 没问过
        @Expect(findTrust(data, child).decided, false)
        // 信任父目录 -> 子目录继承
        setTrust(data, absPath(parent), true, false)
        let d1 = findTrust(data, child)
        @Expect(d1.decided, true)
        @Expect(d1.trusted, true)
        @Expect(d1.source, absPath(parent))
        // 就近否掉子目录
        setTrust(data, child, false, false)
        @Expect(findTrust(data, child).trusted, false)
        @Expect(findTrust(data, child).source, child)
        // 撤销后又继承父目录
        @Expect(clearTrust(data, child), true)
        @Expect(findTrust(data, child).trusted, true)
        // "仅本次"不落盘
        let tmpChild = absPath(parent) + "/tmp-only"
        Directory.create(tmpChild, recursive: true)
        setTrust(data, tmpChild, false, true)
        @Expect(findTrust(data, tmpChild).source, absPath(parent))
    }

    @TestCase
    func workspaceRegistryKeepsNamesAndPaths(): Unit {
        let data = freshDir("wsreg-data")
        let a = freshDir("wsreg-a")
        let b = freshDir("wsreg-b")
        @Expect(registerWorkspace(data, a, "甲"), "甲")
        @Expect(findWorkspace(data, "甲").getOrThrow().path, absPath(a))
        @Expect(findWorkspace(data, absPath(a)).isSome(), true)
        // 同一目录重复登记不新增
        registerWorkspace(data, a, "")
        @Expect(loadWorkspaces(data).size, 1)
        registerWorkspace(data, b, "乙")
        @Expect(loadWorkspaces(data).size, 2)
        // 名字解析 + 没登记过的目录自动登记
        @Expect(resolveWorkspace(data, "甲"), absPath(a))
        let cpath = freshDir("wsreg-c")
        @Expect(resolveWorkspace(data, cpath), absPath(cpath))
        @Expect(findWorkspace(data, defaultWorkspaceName(absPath(cpath))).isSome(), true)
        @Expect(loadWorkspaces(data).size, 3)
        // 移除登记（目录不动）
        @Expect(removeWorkspace(data, "乙"), true)
        @Expect(loadWorkspaces(data).size, 2)
        @Expect(exists(b), true)
    }

    @TestCase
    func pathHelpersBehave(): Unit {
        // 盘符/绝对路径不动，相对路径挂到 root 下
        @Expect(joinPath("D:/a", "b/c.md"), "D:/a/b/c.md")
        @Expect(joinPath("D:/a", "D:/x/y.md"), "D:/x/y.md")
        @Expect(absPath("D:/x"), "D:/x")
        @Expect(absPath("rel/x"), getcwd().toString() + "/rel/x")
        @Expect(defaultWorkspaceName("D:/a/学习笔记/"), "学习笔记")
        @Expect(parentOf("D:/a/b"), "D:/a")
    }
}
