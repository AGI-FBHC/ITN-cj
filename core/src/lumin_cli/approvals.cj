package itn_desktop_core.lumin_cli

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.pi.*
import itn_desktop_core.pi_tools.*

/*
 * Human in the loop：审批层。
 *
 * 设计要点（不是随手一个 y/N）：
 *   1. **按"动作"授权**，不是按工具名：路径前缀 / 命令首词 / 联网。所以"允许写 D:\notes 下面"是一条规则，
 *      而不是"永远允许 write"。
 *   2. **四种回答**：允许一次 / 本次会话都允许 / 总是允许（记住）/ 拒绝。记住的进 <dataDir>/approvals.json，
 *      下次启动直接命中，不再打扰你 —— 这就是"帮我批准"档要的体感。
 *   3. **档位决定问多少**（照 Codex 三档）：
 *        ask  请求批准    —— 编辑外部文件 / 跑命令 / 联网：每次都问
 *        auto 帮我批准    —— 只有"检测到的风险"才问（危险命令、写工作区外、联网）；普通命令直接放行
 *        full 完全访问权限 —— 不问（但仍然审计，并且仍然不交出模型自己在用的 Key）
 *
 *   读不走审批、也不受沙箱限制：**沙箱只隔离写**（读整机是刻意放开的，见 workspace.cj 的 denyReasonRead）。
 *   所以这里只处理三类动作：写工作区外、跑命令、联网。
 *   4. **可审计**：每次决定都打印一行，并往会话里写一条 custom entry（不进模型上下文）。
 *   5. **可脚本化**：full 档 / --permissions full 就是不问；测试里用 autoAnswer 注入回答。
 */

public class ApprovalRule {
    public var kind: String = ""
    public var value: String = ""
}

/** Windows 上真会毁东西的命令首词（故意保守：假阳性只是多问一次）。 */
func dangerousHead(head: String): Bool {
    let h = head.toAsciiLower()
    return h == "del" || h == "erase" || h == "rd" || h == "rmdir" || h == "format" || h == "diskpart" ||
        h == "reg" || h == "regedit" || h == "takeown" || h == "icacls" || h == "taskkill" ||
        h == "shutdown" || h == "wmic" || h == "bcdedit" || h == "rm" || h == "sudo" || h == "curl" ||
        h == "invoke-webrequest" || h == "iwr"
}

public class Approver {
    public var mode: String = "ask"
    /** 测试用：非空就不读键盘，直接拿它当回答 */
    public var autoAnswer: String = ""
    public let rules = ArrayList<ApprovalRule>()
    public let sessionAllows = ArrayList<String>()
    public var allowCount: Int64 = 0
    public var denyCount: Int64 = 0
    public var askCount: Int64 = 0
    /**
     * 取一行用户输入。CLI 里必须挂上（走读键盘线程的队列），
     * 否则审批提示会直接 readln()，跟那个线程抢 stdin。不挂就退回 readln（测试/其他宿主用）。
     */
    public var nextLine: ?() -> String = None
    /**
     * 放行一次"写工作区外"之后，要把那个目录记进工作区的白名单 ——
     * 否则会出现"用户批了、沙箱还是拒"的自相矛盾（沙箱在 ask 档拦越界写）。
     */
    public var ws: ?Workspace = None
    private var dataDir: String = ""

    public init(dataDir: String, mode: String) {
        this.dataDir = dataDir
        this.mode = mode
        loadRules()
    }

    func ruleKey(kind: String, value: String): String {
        return kind + ":" + value
    }

    func approvalsFile(): String {
        return dataDir + "/approvals.json"
    }

    func loadRules(): Unit {
        var text = ""
        try {
            text = safeUtf8(File.readFrom(approvalsFile()), 0, 1024 * 1024)
        } catch (e: Exception) {
            return
        }
        let t = trimStr(text)
        if (t.size == 0) {
            return
        }
        try {
            match (JsonValue.fromStr(t)) {
                case root: JsonObject =>
                    match (root.get("rules")) {
                        case Some(v) =>
                            match (v) {
                                case arr: JsonArray =>
                                    var i: Int64 = 0
                                    while (i < arr.size()) {
                                        match (arr[i]) {
                                            case o: JsonObject =>
                                                let r = ApprovalRule()
                                                r.kind = strOf(o, "kind")
                                                r.value = strOf(o, "value")
                                                if (r.kind.size > 0) {
                                                    rules.add(r)
                                                }
                                            case _ => ()
                                        }
                                        i = i + 1
                                    }
                                case _ => ()
                            }
                        case None => ()
                    }
                case _ => ()
            }
        } catch (e: Exception) {
            ()
        }
    }

    public func saveRules(): Unit {
        let arr = JsonArray()
        for (r in rules) {
            let o = JsonObject()
            o.put("kind", JsonString(r.kind))
            o.put("value", JsonString(r.value))
            arr.add(o)
        }
        let root = JsonObject()
        root.put("rules", arr)
        if (!exists(dataDir)) {
            try {
                Directory.create(dataDir, recursive: true)
            } catch (e: Exception) {
                return
            }
        }
        try {
            File.writeTo(approvalsFile(), root.toString().toArray())
        } catch (e: Exception) {
            ()
        }
    }

    public func clearRules(): Unit {
        rules.clear()
        saveRules()
    }

    /** 命中记住的规则（路径按前缀、命令按首词）。 */
    func allowedByRule(kind: String, value: String): Bool {
        for (r in rules) {
            if (r.kind != kind) {
                continue
            }
            if (kind == "path-outside") {
                if (hasPrefix(value, r.value) || hasPrefix(r.value, value)) {
                    return true
                }
            } else if (value == r.value || hasPrefix(value, r.value)) {
                return true
            }
        }
        return false
    }

    func risky(kind: String): Bool {
        return kind == "command-dangerous" || kind == "path-outside" || kind == "web"
    }

    func describe(kind: String, value: String): String {
        if (kind == "command" || kind == "command-dangerous") {
            return "跑命令：" + value
        }
        if (kind == "path-outside") {
            return "写工作区外的目录：" + value
        }
        if (kind == "web") {
            return "联网：" + value
        }
        return kind + " " + value
    }

    /**
     * 决策：返回 "" = 放行；非空 = 拒绝理由（会被当成工具错误结果回灌给模型）。
     * 每一步都会记进统计；会话由调用方负责落 custom entry。
     */
    public func decide(kind: String, value: String, detail: String): String {
        if (kind.size == 0) {
            return ""
        }
        if (mode == "full") {
            allowCount = allowCount + 1
            return ""
        }
        if (allowedByRule(kind, value)) {
            allowCount = allowCount + 1
            return ""
        }
        let key = ruleKey(kind, value)
        for (s in sessionAllows) {
            if (s == key) {
                allowCount = allowCount + 1
                return ""
            }
        }
        if (mode == "auto" && !risky(kind)) {
            allowCount = allowCount + 1
            return ""
        }
        askCount = askCount + 1
        let ans = prompt(kind, value, detail)
        if (ans == "y") {
            allowCount = allowCount + 1
            return ""
        }
        if (ans == "s") {
            sessionAllows.add(key)
            allowCount = allowCount + 1
            return ""
        }
        if (ans == "a") {
            let r = ApprovalRule()
            r.kind = kind
            r.value = value
            rules.add(r)
            saveRules()
            allowCount = allowCount + 1
            return ""
        }
        denyCount = denyCount + 1
        return "用户拒绝了这一步（" + describe(kind, value) + "）"
    }

    func prompt(kind: String, value: String, detail: String): String {
        println("")
        println("-- 需要你批准 ------------------------------------------")
        println("   动作：" + describe(kind, value))
        if (detail.size > 0) {
            println("   详情：" + preview(detail, 200))
        }
        println("   档位：" + permissionModeText(mode) +
            "（ask 档对「编辑外部文件 / 跑命令 / 联网」始终问；auto 档只对风险操作问）")
        print("   [y] 允许一次  [s] 本次会话都允许  [a] 总是允许（记住）  [n] 拒绝 > ")
        var line = ""
        if (autoAnswer.size > 0) {
            line = autoAnswer
            println(line + "   （测试注入的回答）")
        } else {
            match (nextLine) {
                case Some(f) => line = f()
                case None =>
                    try {
                        line = readln()
                    } catch (e: Exception) {
                        line = ""
                    }
            }
        }
        let t = trimStr(line)
        if (t == "y") {
            return "y"
        }
        if (t == "s") {
            return "s"
        }
        if (t == "a") {
            return "a"
        }
        return "n"
    }

    /**
     * 批准之后要落实的副作用。目前只有一条：把"写工作区外"的那个目录登记进沙箱白名单 ——
     * 否则会出现"用户批了、沙箱还是拒"的自相矛盾。（单独一个方法是为了能单测。）
     */
    public func applyApproval(kind: String, value: String): Unit {
        if (kind != "path-outside") {
            return
        }
        match (ws) {
            case Some(w) => w.allowWriteAt(value)
            case None => ()
        }
    }

    /**
     * 工具调用入口：分类 -> 决策 -> 审计（打印 + 会话里写 custom entry）。
     * 返回 "" = 放行；非空 = 拒绝理由。放在 Approver 里是为了让挂到 Agent 上的 lambda
     * 只捕获一个不可变对象（仓颉不允许 lambda 捕获可变变量）。
     */
    public func checkTool(agent: Agent, name: String, args: JsonObject): String {
        let (kind, value, detail) = classifyTool(name, args, agent.workspaceRoot)
        if (kind.size == 0) {
            return ""
        }
        let denial = decide(kind, value, detail)
        if (denial.size == 0) {
            applyApproval(kind, value)
        }
        let o = JsonObject()
        o.put("tool", JsonString(name))
        o.put("kind", JsonString(kind))
        o.put("value", JsonString(value))
        o.put("decision", JsonString(if (denial.size == 0) { "allow" } else { "deny" }))
        agent.session.appendCustom("lumin.approval", o)
        if (denial.size == 0) {
            println("   [审批] 放行 " + kind + "：" + preview(value, 80))
        } else {
            println("   [审批] 拒绝 " + kind + "：" + preview(value, 80))
        }
        return denial
    }
}

/** 把一次工具调用分类成审批动作：(kind, value, detail)；kind 为空 = 不用问。 */
public func classifyTool(name: String, args: JsonObject, wsRoot: String): (String, String, String) {
    // （下面是实现，checkTool 也走它）

    if (name == "powershell") {
        let cmd = trimStr(strOf(args, "command"))
        let head = firstWord(cmd)
        if (dangerousHead(head)) {
            return ("command-dangerous", head, cmd)
        }
        return ("command", head, cmd)
    }
    if (name == "write" || name == "edit") {
        let rel = strOf(args, "path")
        // 先归一化工作区根、再折叠 . 与 ..，最后才比前缀：
        //   ws/../outside/x.md 是**外面**，字符串前缀会把它误判成里面
        //（踩过：模型写 ../outside/x.md 时审批层说"不用问"，工具层却按越界拒了 → 用户看不到该看到的提问）
        let rootNorm = collapseDots(wsRoot)
        let full = collapseDots(joinPath(rootNorm, rel))
        let inside = full == rootNorm || hasPrefix(full, rootNorm + "/")
        if (!inside) {
            return ("path-outside", parentOf(full), rel)
        }
        return ("", "", "")
    }
    if (name == "web_search" || name == "web_fetch" || name == "kb_stage") {
        let url = strOf(args, "url")
        let q = strOf(args, "query")
        let key = if (url.size > 0) { url } else { firstWord(q) }
        return ("web", key, if (url.size > 0) { url } else { q })
    }
    return ("", "", "")
}

func firstWord(s: String): String {
    let b = s.toArray()
    var i: Int64 = 0
    while (i < b.size && !(b[i] == 32 || b[i] == 9)) {
        i = i + 1
    }
    return safeUtf8(b, 0, i)
}
