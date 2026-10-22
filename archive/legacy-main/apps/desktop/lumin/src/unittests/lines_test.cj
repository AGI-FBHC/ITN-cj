package lumin.unittests

import std.collection.*
import std.sync.*
import std.time.*
import lumin.pi.*
import lumin.cli.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 键盘输入与"中途插话"：读键盘线程、行队列、行分类、以及"队列里的行真能被
 * 当成 steering 插进正在跑的那一轮"。
 */

@Test
class LinesTest {
    @TestCase
    func lineQueueCarriesLinesAcrossThreads(): Unit {
        let q = LineQueue()
        q.push("先推一行")
        // 另一个线程往里推：模拟"读键盘的线程"
        spawn {
            var i: Int64 = 0
            while (i < 5) {
                q.push("line-" + i.toString())
                i = i + 1
            }
            q.close()
        }
        var guard: Int64 = 0
        while (!q.isClosed() && guard < 2000) {
            sleep(Duration.millisecond * 5)
            guard = guard + 1
        }
        @Expect(q.isClosed(), true)
        let all = q.drain()
        // 主线程先推的那行在最前，子线程的 5 行在后（各自的顺序不能乱）
        @Expect(all.size, 6)
        @Expect(all[0], "先推一行")
        @Expect(all[1], "line-0")
        @Expect(all[5], "line-4")
        // 取过就空了
        @Expect(q.drain().size, 0)
    }

    @TestCase
    func takeBlockingWaitsAndKeepsTheRestInOrder(): Unit {
        let q = LineQueue()
        q.push("1")
        q.push("2")
        q.push("3")
        // 一次来了多行（粘贴/管道）：先给第一行，其余按原顺序留着
        @Expect(q.takeBlocking(), "1")
        @Expect(q.takeBlocking(), "2")
        @Expect(q.takeBlocking(), "3")
        // 关掉又没货 -> 空串（调用方据此收工），不会卡死
        q.close()
        @Expect(q.takeBlocking(), "")
        // 阻塞等：另一个线程 80ms 后才推，取值要等到它
        let q2 = LineQueue()
        spawn {
            sleep(Duration.millisecond * 80)
            q2.push("迟到的一行")
            q2.close()
        }
        @Expect(q2.takeBlocking(), "迟到的一行")
        @Expect(q2.takeBlocking(), "")
    }

    @TestCase
    func typedLineKindsClassify(): Unit {
        @Expect(typedLineKind(""), "empty")
        @Expect(typedLineKind("   "), "empty")
        @Expect(typedLineKind("/stop"), "stop")
        @Expect(typedLineKind("  /abort  "), "stop")
        @Expect(typedLineKind("/cancel"), "stop")
        @Expect(typedLineKind("/help"), "slash")
        @Expect(typedLineKind("/permissions full"), "slash")
        // 普通句子（包括以斜杠开头的相对路径这种容易误判的）当作插话
        @Expect(typedLineKind("等一下，先别改那个文件"), "ask")
        @Expect(typedLineKind("继续"), "ask")
    }

    @TestCase
    func keyboardLinesFeedTheSteeringInjectionPoint(): Unit {
        let d = freshDir("lines-steer")
        let s = newSession(d, "cwd", "", "")
        let q = LineQueue()
        let skipped = ArrayList<String>()
        let opts = AgentOptions()
        // 这就是 CLI 里挂上去的那个回调：普通提问进 steering，斜杠命令不喂给模型
        opts.getSteering = Some({ =>
            let out = ArrayList<String>()
            for (raw in q.drain()) {
                let kind = typedLineKind(raw)
                if (kind == "ask") {
                    out.add(trimStr(raw))
                } else if (kind == "slash") {
                    skipped.add(trimStr(raw))
                }
            }
            out
        })
        let provider = ScriptedProvider([scriptText("好")])
        let agent = Agent(provider, s, ToolRegistry(), modeChat(), opts)
        // 模拟"模型跑着的时候用户敲了一句"
        q.push("等一下，先说这个")
        let out = agent.prompt("你好", EventStream())
        @Expect(out.ok, true)
        let msgs = s.messagesForModel()
        @Expect(msgs.size, 3)
        @Expect(msgs[0].text, "你好")
        @Expect(msgs[1].text, "等一下，先说这个")
        // 第一次请求就该看到两条 user 消息（插话在请求之前生效）
        @Expect(provider.seenMessageCounts[0], 2)
        // 斜杠命令不会被当成插话喂给模型，只被记下来
        q.push("/permissions full")
        @Expect(agent.prompt("接着说", EventStream()).ok, true)
        @Expect(skipped.size, 1)
        @Expect(skipped[0], "/permissions full")
    }

    @TestCase
    func stopFlagEndsTheRunningTurn(): Unit {
        let d = freshDir("lines-stop")
        let s = newSession(d, "cwd", "", "")
        let opts = AgentOptions()
        let ctl = RunControl()
        let provider = ScriptedProvider([scriptText("我说到一半"), scriptText("第二句")])
        let agent = Agent(provider, s, ToolRegistry(), modeChat(), opts)
        ctl.agent = Some(agent)
        // 跑着的时候用户敲了 /stop：本轮开头注入点就会把它落实
        // （lambda 不能捕获可变变量，所以用个列表当"只做一次"的开关）
        let hits = ArrayList<String>()
        opts.getSteering = Some({ =>
            if (hits.size == 0) {
                hits.add("stop")
                ctl.stop()
            }
            ArrayList<String>()
        })
        let out = agent.prompt("你好", EventStream())
        @Expect(out.ok, false)
        @Expect(out.stopReason, "aborted")
        // 当前这次回复让它说完，所以 turns 仍是 1（不打断 HTTP 流，见 roadmap）
        @Expect(out.turns, 1)
        // abort 不是"坏状态"：下一次 prompt 会自动复位
        @Expect(agent.prompt("再来一次", EventStream()).ok, true)
    }
}
