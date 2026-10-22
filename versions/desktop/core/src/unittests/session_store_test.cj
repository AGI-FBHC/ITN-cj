package itn_desktop_core.unittests

import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.session.SessionEvent
import itn_desktop_core.session.cleanSessionTitle
import itn_desktop_core.session.SessionStore
import itn_desktop_core.util.*

/*
 * 内核会话仓库（SQLite 那份）：列表标题、删除、一次性起名、整段分支。
 *
 * 断言点：默认标题取首个提问；重命名覆盖默认标题并进列表；删除后事件、摘要、标题覆盖一起清掉。
 */
@Test
class SessionStoreTest {
    @TestCase
    func renameOverridesTitleAndRemoveDropsTheSession(): Unit {
        let d = freshDir("store-sess")
        let ss = SessionStore(d)
        let sid = ss.newId()
        let ev = SessionEvent()
        ev.sessionId = sid
        ev.kind = "user/message"
        let payload = JsonObject()
        payload.put("text", JsonString("一个用来当默认标题的长问题"))
        ev.payload = payload
        ss.append(ev)

        // 默认标题 = 首个提问
        @Expect(strOf(ss.summary(sid), "title"), "一个用来当默认标题的长问题")

        // 重命名覆盖默认标题；列表里读的是覆盖后的名字
        ss.rename(sid, "我改的名字")
        @Expect(strOf(ss.summary(sid), "title"), "我改的名字")
        var listed = ""
        for (sm in ss.list()) {
            if (strOf(sm, "sessionId") == sid) {
                listed = strOf(sm, "title")
            }
        }
        @Expect(listed, "我改的名字")

        // 清空名字 = 回到默认标题
        ss.rename(sid, "  ")
        @Expect(strOf(ss.summary(sid), "title"), "一个用来当默认标题的长问题")

        // 删除：事件与摘要都清掉，列表里不再出现
        ss.rename(sid, "待删除")
        ss.remove(sid)
        @Expect(ss.events(sid).size, 0)
        var stillThere = false
        for (sm in ss.list()) {
            if (strOf(sm, "sessionId") == sid) {
                stillThere = true
            }
        }
        @Expect(stillThere, false)
    }

    /** 起名只做一次：问过之后改写第一条提问也不再问；手动改过名字同样不再问。 */
    @TestCase
    func titleIsAskedOnlyOnce(): Unit {
        let d = freshDir("store-title")
        let ss = SessionStore(d)
        let sid = ss.newId()
        let ev = SessionEvent()
        ev.sessionId = sid
        ev.kind = "user/message"
        let payload = JsonObject()
        payload.put("text", JsonString("帮我把这一章的习题整理成一份练习册"))
        ev.payload = payload
        ss.append(ev)

        // 还没问过：列表先用第一句话兜着
        @Expect(ss.titleReady(sid), false)
        @Expect(ss.firstUserText(sid), "帮我把这一章的习题整理成一份练习册")
        @Expect(strOf(ss.summary(sid), "title"), "帮我把这一章的习题整理成一份练习册")

        // 问过一次（哪怕模型失败）就不再问
        ss.markTitleAsked(sid)
        @Expect(ss.titleReady(sid), true)

        // 名字回来了：写进 title 覆盖
        ss.rename(sid, "习题整理")
        @Expect(strOf(ss.summary(sid), "title"), "习题整理")
        @Expect(ss.titleReady(sid), true)

        // 删掉这段会话，"问过"的标记跟着走：会话没了就不该留下它的痕迹
        ss.remove(sid)
        @Expect(ss.titleReady(sid), false)
    }

    /** 整段分支：事件一条不少地复制过去，原会话一动不动。 */
    @TestCase
    func branchAllCopiesEverything(): Unit {
        let d = freshDir("store-branchall")
        let ss = SessionStore(d)
        let sid = ss.newId()
        for (k in ["turn/start", "user/message", "assistant/message"]) {
            let ev = SessionEvent()
            ev.sessionId = sid
            ev.turnId = "t1"
            ev.kind = k
            ev.payload = JsonObject()
            ss.append(ev)
        }
        let copy = ss.branchAll(sid)
        @Expect(copy != sid, true)
        @Expect(ss.events(copy).size, 3)
        @Expect(ss.events(sid).size, 3)
        // 复制的是同一段内容：最新一段的标题也一样
        @Expect(strOf(ss.summary(copy), "lastType"), "assistant/message")
    }

    /** 模型给的"名字"要清成一行短标题：剥解释、剥引号、剥尾标点、砍到 24 字节。 */
    @TestCase
    func generatedTitleIsCleaned(): Unit {
        @Expect(cleanSessionTitle("“上下文工程入门”。\n因为用户问的是……"), "上下文工程入门")
        @Expect(cleanSessionTitle("标题：RAG 检索增强生成"), "RAG 检索增强生成")
        @Expect(cleanSessionTitle("  \"复习计划\"  "), "复习计划")
        @Expect(cleanSessionTitle(""), "")
        @Expect(cleanSessionTitle("   "), "")
        // 太长就砍到 24 字节（中文 8 字），不会切出半个汉字
        let long = cleanSessionTitle("这是一个非常非常非常冗长的会话名字已经超过二十四个字节了")
        @Expect(long.size <= 24, true)
        @Expect(long.size > 0, true)
    }
}


/** 列表聚合：标题/kind 取每个会话的**第一条**（不是最后一条），事件计数覆盖全部事件。 */
@Test
class SessionListAggregationTest {
    @TestCase
    func listReadsTheFirstEventPerKindAndCountsEverything(): Unit {
        let d = freshDir("store-list-firsts")
        let ss = SessionStore(d)
        let a = ss.newId()
        let b = ss.newId()
        let p1 = JsonObject(); p1.put("kind", JsonString("ask")); p1.put("kbId", JsonString("kb1"))
        let p2 = JsonObject(); p2.put("text", JsonString("第一个问题"))
        let p3 = JsonObject(); p3.put("text", JsonString("第一个回答"))
        let p4 = JsonObject(); p4.put("kind", JsonString("quiz")); p4.put("kbId", JsonString("kb9"))
        let p5 = JsonObject(); p5.put("text", JsonString("第二个问题"))
        let p6 = JsonObject(); p6.put("text", JsonString("另一个会话的问题"))
        let e1 = SessionEvent(); e1.sessionId = a; e1.kind = "turn/start"; e1.payload = p1; ss.append(e1)
        let e2 = SessionEvent(); e2.sessionId = a; e2.kind = "user/message"; e2.payload = p2; ss.append(e2)
        let e3 = SessionEvent(); e3.sessionId = a; e3.kind = "assistant/message"; e3.payload = p3; ss.append(e3)
        let e4 = SessionEvent(); e4.sessionId = a; e4.kind = "turn/start"; e4.payload = p4; ss.append(e4)
        let e5 = SessionEvent(); e5.sessionId = a; e5.kind = "user/message"; e5.payload = p5; ss.append(e5)
        let e6 = SessionEvent(); e6.sessionId = b; e6.kind = "user/message"; e6.payload = p6; ss.append(e6)
        var seenA = 0
        var seenB = 0
        for (sm in ss.list()) {
            let sid = strOf(sm, "sessionId")
            if (sid == a) {
                seenA = seenA + 1
                @Expect(strOf(sm, "title"), "第一个问题")
                @Expect(strOf(sm, "kind"), "ask")
                @Expect(strOf(sm, "kbId"), "kb1")
                @Expect(intOf(sm, "eventCount"), 5)
            }
            if (sid == b) {
                seenB = seenB + 1
                @Expect(strOf(sm, "title"), "另一个会话的问题")
                @Expect(strOf(sm, "kind"), "")
                @Expect(intOf(sm, "eventCount"), 1)
            }
        }
        @Expect(seenA, 1)
        @Expect(seenB, 1)
    }
}
