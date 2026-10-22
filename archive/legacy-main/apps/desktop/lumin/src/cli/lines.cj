package lumin.cli

import std.collection.*
import std.sync.*
import std.time.*
import lumin.pi.*

/*
 * 键盘输入与"中途插话"。
 *
 * 问题：行式 REPL 是阻塞的 —— 一轮跑完之前不读键盘，所以用户在模型干活时敲的话只能干等。
 * 做法（照 Pi 的 steering）：**单独开一个线程读键盘**，读到的行先进队列；
 *   1. 主循环闲着的时候从队列取 —— 就是普通提问；
 *   2. 模型跑着的时候，运行时的 getSteering 回调（每个 turn 开头被调用）把队列里的行
 *      当成 steering 消息插进去 —— 这就是"中途插话"，不用等这一轮结束。
 * 斜杠命令在跑的时候不能立刻执行（改档位/换工作区会跟正在进行的这一轮打架），
 * 所以先记下来，等这一轮结束再按原顺序执行。
 * 取消（/stop）走 Agent.abort()，运行时在"当前这次回复结束之后"生效 ——
 * 也就是说已经在流的那句话会让它说完（不打断 HTTP 流，见 docs/roadmap.md）。
 */

/** 跨线程的行队列（读键盘的线程写，主循环读）。 */
public class LineQueue {
    private let m = Mutex()
    private var items = ArrayList<String>()
    private var closed = false

    public init() {}

    public func push(line: String): Unit {
        m.lock()
        try {
            items.add(line)
        } finally {
            m.unlock()
        }
    }

    /** 读到 EOF（比如管道输入跑完）就关掉，主循环发现队列空了就会收工。 */
    public func close(): Unit {
        m.lock()
        try {
            closed = true
        } finally {
            m.unlock()
        }
    }

    /** 取走当前排队的全部行（不阻塞，顺序不变）。 */
    public func drain(): ArrayList<String> {
        let out = ArrayList<String>()
        m.lock()
        try {
            for (t in items) {
                out.add(t)
            }
            items = ArrayList<String>()
        } finally {
            m.unlock()
        }
        return out
    }

    /**
     * 阻塞取一行（没有就 25ms 轮询；队列关了又没货就返回空串）。
     * 审批提示（y/s/a/n）必须走这里 —— 它以前直接 readln()，会跟读键盘的线程抢同一个 stdin。
     * 一次来了多行（粘贴、管道）时，把剩下的按原顺序塞回队尾，一行都不丢。
     */
    public func takeBlocking(): String {
        var out = ""
        var done = false
        while (!done) {
            let got = drain()
            if (got.size > 0) {
                // 一次可能来了好几行（粘贴 / 管道）：剩下的按原顺序塞回队尾，一行都不丢。
                // 注意是**正序** push（push 是加到末尾）—— 倒着推会把顺序颠倒，这条被单测逮到过。
                var i: Int64 = 1
                while (i < got.size) {
                    push(got[i])
                    i = i + 1
                }
                out = got[0]
                done = true
            } else if (isClosed()) {
                done = true
            } else {
                sleep(Duration.millisecond * 25)
            }
        }
        return out
    }

    public func isClosed(): Bool {
        var c = false
        m.lock()
        try {
            c = closed
        } finally {
            m.unlock()
        }
        return c
    }
}

/** 读键盘的线程体：EOF 就关队列（等价于用户结束输入）。 */
public func readStdinLoop(q: LineQueue): Unit {
    while (true) {
        var line = ""
        try {
            line = readln()
        } catch (e: Exception) {
            q.close()
            return
        }
        q.push(line)
    }
}

/**
 * 键盘行分类：
 *   empty  空行
 *   stop   取消当前这一轮（/stop /abort /cancel）
 *   slash  斜杠命令（跑着的时候要等这一轮结束）
 *   ask    普通提问（跑着的时候当成插话插进去）
 */
public func typedLineKind(t: String): String {
    let s = trimStr(t)
    if (s.size == 0) {
        return "empty"
    }
    if (s == "/stop" || s == "/abort" || s == "/cancel") {
        return "stop"
    }
    if (hasPrefix(s, "/")) {
        return "slash"
    }
    return "ask"
}

/** 给"跑着的时候"用的取消开关（lambda 不能捕获可变变量，所以用一个对象兜住）。 */
public class RunControl {
    public var agent: ?Agent = None

    public init() {}

    public func stop(): Unit {
        match (agent) {
            case Some(a) => a.abort()
            case None => ()
        }
    }
}
