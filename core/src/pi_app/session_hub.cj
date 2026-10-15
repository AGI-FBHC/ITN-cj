package itn_desktop_core.pi_app

import std.collection.*
import std.sync.*
import itn_desktop_core.pi.Agent

/*
 * 跑在后台的那一轮：中途插话（steering）与停止（abort）。
 *
 * 桌面版的对话是"一次 HTTP 请求跑完一轮"，但 harness 的体感要求两件事：
 *   1. 模型跑着的时候你还能打字 —— 这句话要在**下一次模型请求之前**插进去（pi 的 steering）；
 *   2. 能停下 —— 按停止 / Esc 让这一轮在当前这一步收尾。
 * 所以这里维护两份小状态：按会话排队的插话、按会话记的正在跑的 Agent。
 */

public class SessionHub {
    private let lock = Mutex()
    private let steer = HashMap<String, ArrayList<String>>()
    private let running = HashMap<String, Agent>()
    private let activeTurns = HashMap<String, String>()
    /** 这一轮用户按过停止：provider 在流式增量之间读它，读到就收手 */
    private let aborted = HashMap<String, Bool>()

    public init() {}

    public func reserve(sessionId: String, turnId: String): Bool {
        synchronized(lock) {
            if (activeTurns.contains(sessionId)) { return false }
            activeTurns[sessionId] = turnId
            aborted.remove(sessionId)
            return true
        }
    }

    public func activeTurn(sessionId: String): String {
        synchronized(lock) { return activeTurns.get(sessionId).getOrDefault({ => "" }) }
    }

    public func release(sessionId: String): Unit {
        synchronized(lock) { activeTurns.remove(sessionId); running.remove(sessionId) }
    }

    /** 插一句话，等这一轮的下一次模型请求之前注入。 */
    public func pushSteering(sessionId: String, text: String): Unit {
        lock.lock()
        match (steer.get(sessionId)) {
            case Some(list) => list.add(text)
            case None =>
                let list = ArrayList<String>()
                list.add(text)
                steer[sessionId] = list
        }
        lock.unlock()
    }

    public func takeSteering(sessionId: String): ArrayList<String> {
        let out = ArrayList<String>()
        lock.lock()
        match (steer.get(sessionId)) {
            case Some(list) =>
                for (t in list) {
                    out.add(t)
                }
                steer[sessionId] = ArrayList<String>()
            case None => ()
        }
        lock.unlock()
        return out
    }

    public func pendingSteering(sessionId: String): Int64 {
        var n: Int64 = 0
        lock.lock()
        match (steer.get(sessionId)) {
            case Some(list) => n = list.size
            case None => ()
        }
        lock.unlock()
        return n
    }

    public func markRunning(sessionId: String, agent: Agent): Unit {
        lock.lock()
        running[sessionId] = agent
        lock.unlock()
    }

    public func clearRunning(sessionId: String): Unit {
        lock.lock()
        running.remove(sessionId)
        lock.unlock()
    }

    /** 让某一轮停下来；返回是不是真的找到了在跑的那一轮。 */
    public func abort(sessionId: String): Bool {
        var hit = false
        lock.lock()
        aborted[sessionId] = true
        match (running.get(sessionId)) {
            case Some(a) =>
                a.abort()
                hit = true
            case None => ()
        }
        lock.unlock()
        return hit
    }

    /** provider 每个流式增量之间问一句"该停了吗"。 */
    public func isAborted(sessionId: String): Bool {
        var v = false
        lock.lock()
        match (aborted.get(sessionId)) {
            case Some(b) => v = b
            case None => ()
        }
        lock.unlock()
        return v
    }

    /** 新一轮开始时清掉上一次的停止标记。 */
    public func clearAbort(sessionId: String): Unit {
        lock.lock()
        aborted.remove(sessionId)
        lock.unlock()
    }
}

let SESSION_HUB = SessionHub()

public func sessionHub(): SessionHub {
    return SESSION_HUB
}
