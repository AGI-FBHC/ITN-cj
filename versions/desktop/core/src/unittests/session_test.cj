package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.runtime.*
import std.unittest.*
import std.unittest.testmacro.*

/*
 * 会话：Pi 的 JSONL + 树。
 * 断言点：文件形状（header + 每行一条 entry）、id/parentId 链、叶子上溯重建上下文、分叉、压缩。
 */
@Test
class SessionTest {
    @TestCase
    func jsonlHasHeaderAndChainedEntries(): Unit {
        let d = freshDir("sess-basic")
        let s = newSession(d, "demo-cwd", "", "")
        let u = Message(UserMsg)
        u.text = "你好"
        let id1 = s.appendMessage(u)
        let a = Message(AssistantMsg)
        a.text = "你好，有什么可以帮你"
        let id2 = s.appendMessage(a)

        @Expect(id1.size, 8)
        @Expect(id2 != id1, true)
        @Expect(s.leafId, id2)

        let text = slurp(s.path)
        let lines = splitLines(text)
        @Expect(lines.size, 3)
        @Expect(containsSub(lines[0], "\"type\":\"session\""), true)
        @Expect(containsSub(lines[0], "\"version\":3"), true)
        @Expect(containsSub(lines[0], "demo-cwd"), true)
        @Expect(containsSub(lines[1], "\"parentId\":null"), true)
        @Expect(containsSub(lines[2], id1), true)
        @Expect(containsSub(lines[2], "\"type\":\"message\""), true)
    }

    @TestCase
    func reloadingRebuildsTheSameBranch(): Unit {
        let d = freshDir("sess-reload")
        let s = newSession(d, "cwd", "", "")
        let u = Message(UserMsg)
        u.text = "问题一"
        s.appendMessage(u)
        let a = Message(AssistantMsg)
        a.text = "回答一"
        s.appendMessage(a)

        let loaded = loadSession(s.path)
        @Expect(loaded.entries.size, 2)
        @Expect(loaded.cwd, "cwd")
        let msgs = loaded.messagesForModel()
        @Expect(msgs.size, 2)
        @Expect(roleName(msgs[0].role), "user")
        @Expect(msgs[0].text, "问题一")
        @Expect(roleName(msgs[1].role), "assistant")
        @Expect(msgs[1].text, "回答一")
        // id 计数器要跳过已用过的，避免新 id 撞车
        let id3 = loaded.appendMessage(Message(UserMsg))
        @Expect(id3 != "00000001", true)
    }

    @TestCase
    func forkingSwitchesTheBranchWithoutLosingHistory(): Unit {
        let d = freshDir("sess-fork")
        let s = newSession(d, "cwd", "", "")
        let u = Message(UserMsg)
        u.text = "原始问题"
        let id1 = s.appendMessage(u)
        let a = Message(AssistantMsg)
        a.text = "原始回答"
        s.appendMessage(a)

        // 回到第一条之后再往下走 = 分叉
        @Expect(s.forkFrom(id1), true)
        let u2 = Message(UserMsg)
        u2.text = "换个方向问"
        s.appendMessage(u2)

        let msgs = s.messagesForModel()
        @Expect(msgs.size, 2)
        @Expect(msgs[0].text, "原始问题")
        @Expect(msgs[1].text, "换个方向问")
        // 原回答还在文件里（只是不在这条分支上）
        @Expect(containsSub(slurp(s.path), "原始回答"), true)
    }

    @TestCase
    func compactionReplacesOlderMessagesWithItsSummary(): Unit {
        let d = freshDir("sess-compact")
        let s = newSession(d, "cwd", "", "")
        let u = Message(UserMsg)
        u.text = "很早以前的问题"
        s.appendMessage(u)
        let a = Message(AssistantMsg)
        a.text = "很早以前的回答"
        let keepId = s.appendMessage(a)
        let u3 = Message(UserMsg)
        u3.text = "最近的问题"
        s.appendMessage(u3)

        s.appendCompaction("之前聊了很早以前的问题，结论是 A。", keepId)
        let msgs = s.messagesForModel()
        @Expect(msgs.size, 3)
        @Expect(roleName(msgs[0].role), "user")
        @Expect(containsSub(msgs[0].text, "摘要"), true)
        @Expect(containsSub(msgs[0].text, "结论是 A"), true)
        @Expect(msgs[1].text, "很早以前的回答")
        @Expect(msgs[2].text, "最近的问题")
        // 原文一个字都没丢（Pi 也是这么保留的）
        @Expect(containsSub(slurp(s.path), "很早以前的问题"), true)
    }

    @TestCase
    func modelChangeAndSessionNameAreRecorded(): Unit {
        let d = freshDir("sess-meta")
        let s = newSession(d, "cwd", "", "")
        s.appendModelChange("mimo-v2.6-pro")
        s.appendSessionInfo("重构提示词")
        let loaded = loadSession(s.path)
        @Expect(loaded.name(), "重构提示词")
        var found = false
        for (e in loaded.entries) {
            if (strOf(e, "type") == "model_change" && strOf(e, "modelId") == "mimo-v2.6-pro") {
                found = true
            }
        }
        @Expect(found, true)
    }

    @TestCase
    func sessionFilesAreSeparatedByWorkingDirectory(): Unit {
        let d = freshDir("sess-list")
        let s1 = newSession(d, "cwd-a", "", "")
        s1.appendMessage(Message(UserMsg))
        let s2 = newSession(d, "cwd-b", "", "")
        s2.appendMessage(Message(UserMsg))
        @Expect(listSessionFiles(d, "cwd-a").size, 1)
        @Expect(listSessionFiles(d, "cwd-b").size, 1)
        @Expect(listSessionFiles(d, "cwd-c").size, 0)
    }

    @TestCase
    func toolResultMessagesKeepTheirCallIdAndErrorFlag(): Unit {
        let d = freshDir("sess-tool")
        let s = newSession(d, "cwd", "", "")
        let a = Message(AssistantMsg)
        a.toolCalls.add(ToolCallBlock("call_x", "read", "{\"path\":\"a.md\"}"))
        a.stopReason = "toolUse"
        s.appendMessage(a)
        let tr = Message(ToolResultMsg)
        tr.toolCallId = "call_x"
        tr.toolName = "read"
        tr.text = "文件内容"
        tr.isError = false
        s.appendMessage(tr)
        let loaded = loadSession(s.path)
        let msgs = loaded.messagesForModel()
        @Expect(msgs.size, 2)
        @Expect(msgs[0].toolCalls.size, 1)
        @Expect(msgs[0].toolCalls[0].name, "read")
        @Expect(msgs[1].toolCallId, "call_x")
        @Expect(msgs[1].text, "文件内容")
    }
}
