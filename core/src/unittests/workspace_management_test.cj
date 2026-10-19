package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import std.posix.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import itn_desktop_core.lumin_cli.*
import itn_desktop_core.workspace_tools.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 项目目录管理这一块：读写策略、红线名单、保护目录、信任继承、工作区登记表。
 * 这几条是"模型能不能碰你的东西"的底线，所以断言都在行为上，不看文案。
 *
 * 策略（2026-10-14 改）：**沙箱只隔离写，不隔离读**。
 *   读：整台机器都能读；只有两条红线 —— 模型自己在用的配置（含 API Key）、CLI 数据目录。
 *   写：ask 档只写工作区（越界要批准后才行）；工作区内的敏感段（.env/.git/.ssh）照旧拒。
 */
@Test
class WorkspaceManagementTest {
    @TestCase
    func sensitivePathsAreRefusedByTools(): Unit {
        let ws = Workspace(freshDir("ws-deny"))
        @Assert(ws.writeText("a.md", "x"))
        @Expect(ws.denyReason("a.md"), "")
        // 写：工作区内的敏感段照旧拒
        @Assert(ws.denyReason(".env.local").size > 0)
        @Assert(ws.denyReason(".env").size > 0)
        @Assert(ws.denyReason("sub/.env.local").size > 0)
        @Assert(ws.denyReason(".git/config").size > 0)
        @Assert(ws.denyReason(".ssh/id_rsa").size > 0)
        // 写：越界（ask 档）没过批准就是"需要批准"，不是"永远不行"
        @Assert(ws.denyReason("../外面.md").size > 0)
        @Expect(containsSub(ws.denyReason("../外面.md"), "批准"), true)
        // 读：沙箱不管读，敏感段不再拦
        @Expect(ws.denyReasonRead(".env.local"), "")
        @Expect(ws.denyReasonRead("sub/.env.local"), "")
        @Expect(ws.denyReasonRead("../外面.md"), "")
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let r = reg.execute(modeStandard(), "c", "write",
            twoObj("path", ".env.local", "content", "SECRET=1"))
        @Expect(r.isError, true)
        @Expect(containsSub(r.content, "敏感"), true)
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
        // ask 档：**读**照旧能出工作区（沙箱只隔离写）
        let rAsk = regAsk.execute(modeStandard(), "c", "read", strObj("path", absNote))
        @Expect(rAsk.isError, false)
        @Expect(containsSub(rAsk.content, "外面的文件"), true)
        @Expect(containsSub(rAsk.summary, "工作区外"), true)
        // ask 档：**写**越界要先批准
        let outDir = absPath(outside)
        let w1 = regAsk.execute(modeStandard(), "cw", "write",
            twoObj("path", outDir + "/new.md", "content", "hello"))
        @Expect(w1.isError, true)
        @Expect(containsSub(w1.content, "批准"), true)
        @Expect(exists(outDir + "/new.md"), false)
        // 批准（模拟审批层放行一次）之后才真能落盘
        ask.allowWriteAt(outDir)
        let w2 = regAsk.execute(modeStandard(), "cw2", "write",
            twoObj("path", outDir + "/new.md", "content", "hello"))
        @Expect(w2.isError, false)
        @Expect(exists(outDir + "/new.md"), true)
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
    func dotsCannotBypassTheRedLine(): Unit {
        let root = freshDir("dots-root")
        let rootAbs = absPath(root)
        fsWrite(root + "/.env.local", "LUMIN_KEY=secret")
        let denyFiles = ArrayList<String>()
        denyFiles.add(rootAbs + "/.env.local")
        let ws = Workspace(root, ArrayList<String>(), denyFiles, "full")
        // 直接点名：拒
        @Assert(ws.denyReasonRead(".env.local").size > 0)
        // 用 . 和 .. 绕：折叠之后还是同一个文件，照样拒
        @Assert(ws.denyReasonRead(rootAbs + "/./.env.local").size > 0)
        @Assert(ws.denyReasonRead(rootAbs + "/sub/../.env.local").size > 0)
        // 工具那层也拒（不能只在内部函数上正确）
        let reg = ToolRegistry()
        registerWorkspaceTools(reg, ws, false)
        let r = reg.execute(modeStandard(), "c", "read",
            strObj("path", rootAbs + "/sub/../.env.local"))
        @Expect(r.isError, true)
        @Expect(containsSub(r.content, "配置文件"), true)
        // 同一层目录里别的文件不受影响
        fsWrite(root + "/note.md", "普通文件")
        @Expect(ws.denyReasonRead("note.md"), "")
        @Expect(reg.execute(modeStandard(), "c2", "read", strObj("path", "note.md")).isError, false)
    }

    @TestCase
    func approvalClassificationUsesCollapsedPaths(): Unit {
        let rootAbs = absPath(freshDir("cls-root"))
        let rootNorm = collapseDots(rootAbs)
        // 工作区内：不用问
        let (k0, _, _) = classifyTool("write", strObj("path", "a.md"), rootAbs)
        @Expect(k0, "")
        let (k1, _, _) = classifyTool("write", strObj("path", "sub/../a.md"), rootAbs)
        @Expect(k1, "")
        // ../ 出去：必须判成 path-outside
        //（踩过：原来用字符串前缀比，ws/../outside 会被误判成"里面" → 该问的不问，工具层却又拒）
        let (kind, value, _) = classifyTool("write", strObj("path", "../outside/x.md"), rootAbs)
        @Expect(kind, "path-outside")
        @Expect(value, parentOf(rootNorm) + "/outside")
        // 绝对路径出去也一样
        let (k3, _, _) = classifyTool("write", strObj("path", "D:/not-here/x.md"), rootAbs)
        @Expect(k3, "path-outside")
        // 读不参与审批（读不设限）
        let (k4, _, _) = classifyTool("read", strObj("path", "C:/windows/win.ini"), rootAbs)
        @Expect(k4, "")
    }

    @TestCase
    func guidedFileApprovalClassifiesWorkspaceReadsAndWrites(): Unit {
        let rootAbs = absPath(freshDir("guided-cls-root"))
        let (readKind, readValue, _) = classifyGuidedTool("read", strObj("path", "notes.md"), rootAbs)
        @Expect(readKind, "file-read")
        @Expect(readValue, "notes.md")
        let (lsKind, lsValue, _) = classifyGuidedTool("ls", JsonObject(), rootAbs)
        @Expect(lsKind, "file-read")
        @Expect(lsValue, ".")
        let grepArgs = strObj("pattern", "Agent")
        grepArgs.put("path", JsonString("notes"))
        let (grepKind, grepValue, grepDetail) = classifyGuidedTool("grep", grepArgs, rootAbs)
        @Expect(grepKind, "file-read")
        @Expect(grepValue, "notes")
        @Expect(containsSub(grepDetail, "Agent"), true)
        let (writeKind, writeValue, _) = classifyGuidedTool("write", strObj("path", "draft.md"), rootAbs)
        @Expect(writeKind, "file-write")
        @Expect(writeValue, "draft.md")
        let (editKind, editValue, _) = classifyGuidedTool("edit", strObj("path", "draft.md"), rootAbs)
        @Expect(editKind, "file-write")
        @Expect(editValue, "draft.md")
        // 工作区外的写仍保留更严重的 path-outside 分类。
        let (outsideKind, _, _) = classifyGuidedTool("write", strObj("path", "../outside.md"), rootAbs)
        @Expect(outsideKind, "path-outside")
    }

    @TestCase
    func guidedFileApprovalCannotBeBypassedByFullPermission(): Unit {
        let denied = Approver(freshDir("guided-appr-deny"), "full")
        denied.requireFileApproval = true
        denied.autoAnswer = "n"
        let denial = denied.decide("file-read", "notes.md", "读取学习资料")
        @Expect(containsSub(denial, "拒绝"), true)
        @Expect(denied.askCount, 1)
        @Expect(denied.denyCount, 1)
        @Expect(denied.allowCount, 0)

        let allowed = Approver(freshDir("guided-appr-allow"), "full")
        allowed.requireFileApproval = true
        allowed.autoAnswer = "y"
        @Expect(allowed.decide("file-write", "draft.md", "保存学习笔记"), "")
        @Expect(allowed.askCount, 1)
        @Expect(allowed.allowCount, 1)
        @Expect(allowed.denyCount, 0)
    }

    @TestCase
    func approvingAnOutsideWriteActuallyUnlocksTheSandbox(): Unit {
        let data = freshDir("appr-data")
        let ws = Workspace(freshDir("appr-ws"), ArrayList<String>(), ArrayList<String>(), "ask")
        let outside = absPath(freshDir("appr-out"))
        let file = outside + "/出新文件.md"
        // 没批准：写不进去
        @Assert(ws.denyReason(file).size > 0)
        // 审批层批准一次 -> 副作用登记进沙箱白名单 -> 真能写
        let ap = Approver(data, "ask")
        ap.ws = Some(ws)
        ap.applyApproval("path-outside", outside)
        @Expect(ws.denyReason(file), "")
        @Assert(ws.writeText(file, "批过了就能写"))
        @Expect(exists(file), true)
        // 登记的是目录前缀：同一层里的别的文件也放行
        @Expect(ws.denyReason(outside + "/另一个.md"), "")
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
