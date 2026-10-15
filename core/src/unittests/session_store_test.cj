package itn_desktop_core.unittests

import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.session.SessionEvent
import itn_desktop_core.session.SessionStore
import itn_desktop_core.util.*

/*
 * 内核会话仓库（SQLite 那份）：列表标题与删除。
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
}
