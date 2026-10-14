package itn_desktop_core.pi_app

import std.collection.*
import std.sync.*
import std.time.*
import stdx.encoding.json.*
import itn_desktop_core.pi.strOf
import itn_desktop_core.pi.intOf
import itn_desktop_core.pi.objOf
import itn_desktop_core.pi.boolOf
import itn_desktop_core.kb.stamp

/*
 * 审批通道：把 lumin 的审批层（它读键盘）接到桌面界面上（界面点按钮）。
 *
 * 为什么要有它：lumin 的审批策略（按动作分类、四种回答、记住规则、批了就把目录记进沙箱白名单）
 * 已经在 CLI 里验证过了，桌面版不该另写一套。它的 `Approver.nextLine` 本来就是一个"取一行输入"的钩子，
 * 这里把它换成"登记一条待批请求 → 阻塞等界面回答"。
 *
 * 阻塞是必要的：审批发生在工具线程里，工具必须等用户点完再决定跑不跑。
 * 超时（默认 15 分钟）按拒绝处理 —— 宁可让模型改道，也不让线程永久挂着。
 */

public class ApprovalRequest {
    public var id: String = ""
    public var kind: String = ""
    public var value: String = ""
    public var detail: String = ""
    public var tool: String = ""
    /** "" = 还没答；once / session / always / deny / timeout */
    public var decision: String = ""
    public var at: String = ""

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("kind", JsonString(kind))
        o.put("value", JsonString(value))
        o.put("detail", JsonString(detail))
        o.put("tool", JsonString(tool))
        o.put("decision", JsonString(decision))
        o.put("at", JsonString(at))
        return o
    }
}

/** 界面上的四答 → lumin 审批层认的四个字母。 */
public func decisionLetter(decision: String): String {
    if (decision == "once") {
        return "y"
    }
    if (decision == "session") {
        return "s"
    }
    if (decision == "always") {
        return "a"
    }
    return "n"
}

public class ApprovalHub {
    private let lock = Mutex()
    private let items = ArrayList<ApprovalRequest>()
    private var seq: Int64 = 0
    /** 等用户点多久算超时（秒） */
    public var waitSec: Int64 = 900

    public init() {}

    private func nowMs(): Int64 {
        return DateTime.now().toUnixTimeStamp().toMilliseconds()
    }

    /**
     * 登记一条待批请求并阻塞等界面回答。返回 y / s / a / n 之一。
     *
     * 只在"真的要问"的时候才会被调到（分类为空、档位是 full、命中已记住的规则，审批层自己就放行了）。
     */
    public func ask(kind: String, value: String, detail: String, tool: String): String {
        lock.lock()
        seq = seq + 1
        let req = ApprovalRequest()
        req.id = "ap" + seq.toString()
        req.kind = kind
        req.value = value
        req.detail = detail
        req.tool = tool
        req.at = stamp()
        items.add(req)
        lock.unlock()

        let deadline = nowMs() + waitSec * 1000
        while (nowMs() < deadline) {
            var d = ""
            lock.lock()
            for (it in items) {
                if (it.id == req.id) {
                    d = it.decision
                }
            }
            lock.unlock()
            if (d.size > 0) {
                return decisionLetter(d)
            }
            sleep(Duration.millisecond * 120)
        }
        lock.lock()
        for (it in items) {
            if (it.id == req.id && it.decision.size == 0) {
                it.decision = "timeout"
            }
        }
        lock.unlock()
        return "n"
    }

    /** 给界面轮询：最近 20 条（含已决的，便于显示"刚批准了什么"）。 */
    public func list(): JsonArray {
        let arr = JsonArray()
        lock.lock()
        var i = items.size - 20
        if (i < 0) {
            i = 0
        }
        while (i < items.size) {
            arr.add(items[i].toJson())
            i = i + 1
        }
        lock.unlock()
        return arr
    }

    public func answer(id: String, decision: String): Bool {
        var found = false
        lock.lock()
        for (it in items) {
            if (it.id == id && it.decision.size == 0) {
                it.decision = decision
                found = true
            }
        }
        lock.unlock()
        return found
    }

    /** 有没有还没人答的（界面据此决定要不要显示批准卡）。 */
    public func pendingCount(): Int64 {
        var n: Int64 = 0
        lock.lock()
        for (it in items) {
            if (it.decision.size == 0) {
                n = n + 1
            }
        }
        lock.unlock()
        return n
    }
}

let APPROVAL_HUB = ApprovalHub()

public func approvalHub(): ApprovalHub {
    return APPROVAL_HUB
}
