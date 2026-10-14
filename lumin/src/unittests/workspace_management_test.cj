package lumin.unittests

import std.collection.*
import std.fs.*
import std.posix.*
import stdx.encoding.json.*
import lumin.pi.*
import lumin.cli.*
import lumin.tools.*
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
    func fullPermissionReachesOutsideButNeverTheKey(): Unit {
        let root = freshDir("perm-root")
        let outside = freshDir("perm-outside")
        fsWrite(outside + "/note.txt", "外面的文件")
        fsWrite(root + "/.env.local", "LUMIN_KEY=secret")
        let denyRoots = ArrayList<String>()
        let denyFiles = ArrayList<String>()
        denyFiles.add(absPath(root + "/.env.local"))
        let ask = Workspace(root, denyRoots, denyFiles, "ask")
        let full = Workspace(root, denyRoots, denyFiles, "full")
        let regAsk = ToolRegistry()
        registerWorkspaceTools(regAsk, ask, false)
        let regFull = ToolRegistry()
        registerWorkspaceTools(regFull, full, false)
        let absNote = absPath(outside) + "/note.txt"
        // ask 档：越界被拒
        @Expect(regAsk.execute(modeStandard(), "c", "read", strObj("path", absNote)).isError, true)
        // full 档：外面也能读
        let r = regFull.execute(modeStandard(), "c2", "read", strObj("path", absNote))
        @Expect(r.isError, false)
        @Expect(containsSub(r.content, "外面的文件"), true)
        // 但模型自己在用的配置（含 Key）任何档位都不给
        let r2 = regFull.execute(modeStandard(), "c3", "read", strObj("path", ".env.local"))
        @Expect(r2.isError, true)
        @Expect(containsSub(r2.content, "配置文件"), true)
        // 沙箱开关跟着档位走
        @Expect(ask.sandboxed(), true)
        @Expect(full.sandboxed(), false)
    }

    @TestCase
    func permissionTiersAreListedAndRemembered(): Unit {
        let data = freshDir("perm-data")
        let ms = builtinPermissionModes()
        @Expect(ms.size, 3)
        @Expect(ms[0].name, "ask")
        @Expect(ms[1].name, "auto")
        @Expect(ms[2].name, "full")
        @Expect(containsSub(ms[2].description, "不受限制"), true)
        @Expect(findPermissionMode("full").isSome(), true)
        @Expect(findPermissionMode("nope").isNone(), true)
        // 默认没设置
        @Expect(loadPermissionSetting(data), "")
        savePermissionSetting(data, "full")
        @Expect(loadPermissionSetting(data), "full")
        savePermissionSetting(data, "auto")
        @Expect(loadPermissionSetting(data), "auto")
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
        // "." 与 "x/." 都要归一化掉（提示里别出现 D:\...\lumin/. ）
        @Expect(absPath("."), getcwd().toString())
        @Expect(absPath("./"), getcwd().toString())
        @Expect(absPath("sub/."), getcwd().toString() + "/sub")
        @Expect(defaultWorkspaceName("D:/a/学习笔记/"), "学习笔记")
        @Expect(parentOf("D:/a/b"), "D:/a")
    }
}
