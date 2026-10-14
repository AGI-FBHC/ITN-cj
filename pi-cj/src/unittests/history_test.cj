package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class HistoryTest {
    @TestCase
    func freezeKeepsTheSnapshotStableWhileWritesWaitInTheQueue(): Unit {
        let h = History()
        h.add("user", "问")
        let snap = h.freeze()
        @Expect(h.isFrozen(), true)
        h.add("assistant", "答")
        // 冻结期间：快照和历史都不动，新消息在队列里等
        @Expect(snap.size(), 1)
        @Expect(h.view().size(), 1)
        @Expect(h.size(), 1)
        @Expect(h.pendingCount(), 1)
        h.thaw()
        @Expect(h.isFrozen(), false)
        @Expect(h.pendingCount(), 0)
        @Expect(h.size(), 2)
        @Expect(h.roleAt(1), "assistant")
        @Expect(h.contentAt(1), "答")
    }

    @TestCase
    func messagesSerializeWithRoleAndContent(): Unit {
        let h = History()
        h.add("tool", "命中 1 条")
        let v = h.view()
        @Expect(v.size(), 1)
        let m = objOf(v[0]).getOrThrow()
        @Expect(strOf(m, "role"), "tool")
        @Expect(strOf(m, "content"), "命中 1 条")
    }

    @TestCase
    func viewTailKeepsOnlyTheMostRecentMessages(): Unit {
        let h = History()
        h.add("user", "1")
        h.add("assistant", "2")
        h.add("user", "3")
        @Expect(h.viewTail(2).size(), 2)
        @Expect(h.viewTail(10).size(), 3)
        @Expect(h.viewTail(0).size(), 0)
        @Expect(h.size(), 3)
    }

    @TestCase
    func anEmptyHistorySerializesToAnEmptyArray(): Unit {
        let h = History()
        @Expect(h.view().size(), 0)
        @Expect(h.size(), 0)
        @Expect(h.pendingCount(), 0)
    }
}
