package itn_desktop_core.unittests

import std.collection.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import itn_desktop_core.session.SessionEvent
import itn_desktop_core.session.SessionStore
import itn_desktop_core.db.*
import itn_desktop_core.util.*

/*
 * 会话树：分叉 / 切分支 / 退回（真删子树）/ 老数据（没有 parent_id）的兼容。
 *
 * 这是"编辑与分支"的地基：它错了，界面要么显示别的分支的历史，要么整段会话只剩一条
 * 事件。所以每条规矩都在这里钉一遍。
 */
@Test
class SessionTreeTest {
    @TestCase
    func searchAndRevealPreserveDescendants(): Unit {
        let d = freshDir("search-reveal")
        let ss = SessionStore(d)
        let sid = ss.newId()
        appendTurn(ss, sid, "t1", "开场")
        appendTurn(ss, sid, "t2", "暗号 NEEDLE-9527")
        appendTurn(ss, sid, "t3", "命中之后的内容")
        let originalLeaf = ss.leafOf(sid)
        @Expect(ss.revealTurn(sid, "t2"), true)
        @Expect(ss.leafOf(sid), originalLeaf)
        ss.split(sid, "t2")
        appendTurn(ss, sid, "other", "另一条线")
        @Expect(turnCount(ss, sid, "t2"), 0)
        @Expect(ss.search("needle-9527", 10).size() > 0, true)
        @Expect(ss.search("%_", 10).size(), 0)
        @Expect(ss.search("", 10).size(), 0)
        @Expect(ss.revealTurn(sid, "t2"), true)
        @Expect(ss.leafOf(sid), originalLeaf)
        @Expect(turnCount(ss, sid, "t3"), 3)
        @Expect(ss.revealTurn(sid, "missing"), false)
        @Expect(ss.leafOf(sid), originalLeaf)
        appendEvent(ss, sid, "stream", "assistant/delta", "SPLIT-")
        appendEvent(ss, sid, "stream", "assistant/delta", "TOKEN")
        @Expect(ss.search("SPLIT-TOKEN", 10).size(), 1)
    }

    private func appendEvent(ss: SessionStore, sid: String, turn: String, kind: String, text: String): Unit {
        let e = SessionEvent()
        e.sessionId = sid
        e.turnId = turn
        e.kind = kind
        let p = JsonObject()
        if (text.size > 0) {
            p.put("text", JsonString(text))
        }
        e.payload = p
        ss.append(e)
    }

    private func appendTurn(ss: SessionStore, sid: String, turn: String, q: String): Unit {
        appendEvent(ss, sid, turn, "turn/start", "")
        appendEvent(ss, sid, turn, "user/message", q)
        appendEvent(ss, sid, turn, "assistant/message", "答：" + q)
    }

    private func turnCount(ss: SessionStore, sid: String, want: String): Int64 {
        var n: Int64 = 0
        for (e in ss.events(sid)) {
            if (strOf(e, "turnId") == want) {
                n += 1
            }
        }
        return n
    }

    private func rowCount(d: String, sid: String): Int64 {
        return DbHub.open(d).scalarInt("SELECT COUNT(*) FROM session_events WHERE session_id = ?", va([tv(sid)]))
    }

    /** 从某一轮开分支：新的一轮接在分叉点上，原来那条线还在，切得回去。 */
    @TestCase
    func splitCreatesSiblingAndKeepsOldLine(): Unit {
        let d = freshDir("tree-split")
        let ss = SessionStore(d)
        let sid = ss.newId()
        appendTurn(ss, sid, "t1", "第一问")
        appendTurn(ss, sid, "t2", "第二问")
        @Expect(ss.events(sid).size, 6)

        let p = ss.split(sid, "t2")
        @Expect(p > 0, true)
        // 还没发消息：什么都不变 —— 界面上那一轮不能当场消失（找不到切回来的入口）
        @Expect(ss.events(sid).size, 6)

        appendTurn(ss, sid, "t3", "换个问法")
        // 现在只看得到 t1 + t3；t2 那条线还在库里，只是不在当前分支上
        @Expect(ss.events(sid).size, 6)
        @Expect(turnCount(ss, sid, "t2"), 0)
        @Expect(turnCount(ss, sid, "t3"), 3)
        @Expect(rowCount(d, sid), 9)

        // 树信息：t2 / t3 是同一分叉点上的两兄弟，当前活动的是 t3（下标 1）
        let ti = ss.treeInfo(sid)
        let fams = match (ti.get("families")) {
            case Some(a: JsonArray) => a
            case _ => JsonArray()
        }
        @Expect(fams.size(), 1)
        let f = match (fams[0]) {
            case o: JsonObject => o
            case _ => JsonObject()
        }
        @Expect(intOf(f, "count"), 2)
        @Expect(intOf(f, "activeIndex"), 1)

        // 切回 t2 那条线：历史回到 t1 + t2
        @Expect(ss.activateTurn(sid, "t2"), true)
        @Expect(ss.events(sid).size, 6)
        @Expect(turnCount(ss, sid, "t2"), 3)
        @Expect(turnCount(ss, sid, "t3"), 0)
        // 切回去之后树信息里活动的变成 t2（下标 0）
        let ti2 = ss.treeInfo(sid)
        let fams2 = match (ti2.get("families")) {
            case Some(a: JsonArray) => a
            case _ => JsonArray()
        }
        let f2 = match (fams2[0]) {
            case o: JsonObject => o
            case _ => JsonObject()
        }
        @Expect(intOf(f2, "activeIndex"), 0)
    }

    /** 退回某一轮 = 真删这一轮及其后代；别的分支不受影响（老实现按 id 删会顺手带走兄弟线）。 */
    @TestCase
    func rewindDeletesOnlyThatSubtree(): Unit {
        let d = freshDir("tree-rewind")
        let ss = SessionStore(d)
        let sid = ss.newId()
        appendTurn(ss, sid, "t1", "第一问")
        appendTurn(ss, sid, "t2", "第二问")
        ss.split(sid, "t2")
        appendTurn(ss, sid, "t3", "换个问法")
        @Expect(rowCount(d, sid), 9)

        let removed = ss.rewind(sid, "t2")
        @Expect(removed, 3)
        // 库里剩下 t1 与 t3（6 条）：被删的只有 t2
        @Expect(rowCount(d, sid), 6)
        // 末端挪回 t1 之末：当前分支是 t1
        @Expect(ss.events(sid).size, 3)
        @Expect(turnCount(ss, sid, "t2"), 0)
        // t3 还在库里，能再发一轮并保留分叉关系
        ss.split(sid, "t3")
        appendTurn(ss, sid, "t4", "再换个问法")
        @Expect(ss.events(sid).size, 6)
    }

    /** 老数据（parent_id 全空）仍然是一条线：不能因为读不到父就只剩最后一条事件。 */
    @TestCase
    func legacyRowsWithoutParentStayLinear(): Unit {
        let d = freshDir("tree-legacy")
        let ss = SessionStore(d)
        let sid = ss.newId()
        appendTurn(ss, sid, "t1", "老一问")
        appendTurn(ss, sid, "t2", "老二问")
        // 模拟升级前的库：所有事件的 parent_id 都是空的（列表读列会得 0，当成根）
        DbHub.open(d).run("UPDATE session_events SET parent_id = NULL WHERE session_id = ?", va([tv(sid)]))
        @Expect(ss.events(sid).size, 6)

        // 而且还能正常分叉：分叉点要按"上一条事件"的线性回退算，不能算成根
        let p = ss.split(sid, "t2")
        @Expect(p > 0, true)
        appendTurn(ss, sid, "t3", "新问法")
        @Expect(ss.events(sid).size, 6)
        @Expect(turnCount(ss, sid, "t1"), 3)
        @Expect(turnCount(ss, sid, "t2"), 0)
        @Expect(turnCount(ss, sid, "t3"), 3)
    }

    /** 新会话分叉（界面"从这里开分支"）：把分叉那一轮**也**带过去，原会话一字不动。 */
    @TestCase
    func branchCarriesTurnItself(): Unit {
        let d = freshDir("tree-branch-turn")
        let ss = SessionStore(d)
        let sid = ss.newId()
        appendTurn(ss, sid, "t1", "第一问")
        appendTurn(ss, sid, "t2", "第二问")

        let copy = ss.branch(sid, "t1")
        @Expect(copy != sid, true)
        @Expect(ss.events(copy).size, 3)          // 只到 t1 为止，且含 t1
        @Expect(turnCount(ss, copy, "t1"), 3)
        @Expect(turnCount(ss, copy, "t2"), 0)

        let copy2 = ss.branch(sid, "t2")
        @Expect(ss.events(copy2).size, 6)         // 到 t2 为止 = 全部历史
        @Expect(turnCount(ss, copy2, "t2"), 3)

        // 原会话一字不动
        @Expect(ss.events(sid).size, 6)
        @Expect(turnCount(ss, sid, "t1"), 3)
    }

    /** 整段带走（branchAll）copy 的是**当前分支**，不把别的分支也拖过去。 */
    @TestCase
    func branchAllCopiesActiveLineOnly(): Unit {
        let d = freshDir("tree-branchall")
        let ss = SessionStore(d)
        let sid = ss.newId()
        appendTurn(ss, sid, "t1", "第一问")
        appendTurn(ss, sid, "t2", "第二问")
        ss.split(sid, "t2")
        appendTurn(ss, sid, "t3", "换个问法")

        let copy = ss.branchAll(sid)
        @Expect(copy != sid, true)
        @Expect(ss.events(copy).size, 6)
        @Expect(turnCount(ss, copy, "t2"), 0)
        @Expect(turnCount(ss, copy, "t3"), 3)
    }
}
