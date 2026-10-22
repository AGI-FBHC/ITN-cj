package itn_desktop_core.agent

import std.collection.*
import std.sync.*
import itn_desktop_core.llm.*

/**
 * 取消例外：从流式回调里抛出来，一路穿过 llm 的流式读取，让 ask / lecture / quiz 能当场停手。
 *
 * 为什么继承 LlmException：postStream 对 LlmException 是"原样重抛"，对其他异常会包成
 * 「请求模型失败（读取响应体 阶段）」；继承它才能保证"用户取消"不会被误报成网络错误。
 */
public class CancelException <: LlmException {
    public init() {
        super("用户取消了这次生成")
    }
}

/*
 * 取消登记表。
 *
 * 生成过程（问答的模型调用、讲义逐节写作、练习册出题）会在每一步之间检查这里；
 * 用户点「停止」就是往这里置一个标记。
 *
 * 键用会话 id：一次生成对应一个会话，界面天然知道该取消谁，也不需要额外的任务表。
 * 用 Mutex 护住：写事件的是生成线程，置标记的是处理 /api/agent/cancel 的那个线程。
 */
let cancelLock = Mutex()
let cancelFlags = HashMap<String, Bool>()

public func requestCancel(key: String): Unit {
    cancelLock.lock()
    try {
        cancelFlags[key] = true
    } finally {
        cancelLock.unlock()
    }
}

public func isCancelled(key: String): Bool {
    cancelLock.lock()
    try {
        match (cancelFlags.get(key)) {
            case Some(v) => return v
            case None => return false
        }
    } finally {
        cancelLock.unlock()
    }
}

/** 每一轮开始前先清一次：上一次的取消不能影响下一次生成。 */
public func clearCancel(key: String): Unit {
    cancelLock.lock()
    try {
        cancelFlags[key] = false
    } finally {
        cancelLock.unlock()
    }
}