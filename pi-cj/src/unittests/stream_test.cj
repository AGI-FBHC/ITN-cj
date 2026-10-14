package pi_cj.unittests

import std.collection.*
import stdx.encoding.json.*
import pi_cj.pi.*
import std.unittest.*
import std.unittest.testmacro.*

@Test
class EventStreamTest {
    @TestCase
    func pushNotifiesListenersInOrderAndDrainTakesEachEventOnce(): Unit {
        let s = EventStream()
        let seen = ArrayList<String>()
        s.on({ e: PiEvent => seen.add(kindText(e.kind)) })
        s.emit(TurnStart, "t1", 0, "问")
        s.emit(TextDelta, "t1", 1, "答")
        s.emit(TurnEnd, "t1", 1, "答")
        @Expect(seen.size, 3)
        @Expect(seen[0], "turn/start")
        @Expect(seen[1], "text/delta")
        @Expect(seen[2], "turn/end")
        @Expect(s.pendingCount(), 3)
        @Expect(s.drain().size, 3)
        @Expect(s.pendingCount(), 0)
        @Expect(s.drain().size, 0)
        @Expect(s.count, 3)
        @Expect(s.listenerCount(), 1)
    }

    @TestCase
    func eventsCarryTheTurnAndStepTheyBelongTo(): Unit {
        let s = EventStream()
        s.emit(StepStart, "t7", 3, "")
        let e = s.drain()[0]
        @Expect(e.turnId, "t7")
        @Expect(e.step, 3)
        @Assert(e.at.size > 0)
    }

    @TestCase
    func aListenerRegisteredLaterDoesNotGetOldEventsButDrainStillSeesThem(): Unit {
        let s = EventStream()
        s.emit(TurnStart, "t1", 0, "问")
        let seen = ArrayList<String>()
        s.on({ e: PiEvent => seen.add(kindText(e.kind)) })
        @Expect(seen.size, 0)
        @Expect(s.drain().size, 1)
    }

    @TestCase
    func finishAndFailCarryTheTerminalState(): Unit {
        let ok = EventStream()
        ok.finish("最终答案")
        @Expect(ok.isFinished(), true)
        @Expect(orEmpty(ok.result()), "最终答案")
        @Expect(orEmpty(ok.error()), "")

        let bad = EventStream()
        bad.fail("模型炸了")
        @Expect(bad.isFinished(), true)
        @Expect(orEmpty(bad.error()), "模型炸了")
        @Expect(orEmpty(bad.result()), "")
    }

    @TestCase
    func abortIsVisibleToTheProducer(): Unit {
        let s = EventStream()
        @Expect(s.aborted(), false)
        s.abort()
        @Expect(s.aborted(), true)
    }

    @TestCase
    func eventsSerializeToJsonWithOnlyMeaningfulFields(): Unit {
        let e = PiEvent(PiEventKind.ToolResult)
        e.turnId = "t1"
        e.step = 2
        e.tool = "kb_search"
        e.text = "命中 1 条"
        e.ok = false
        let j = e.toJson()
        @Expect(strOf(j, "kind"), "tool/result")
        @Expect(strOf(j, "tool"), "kb_search")
        @Expect(strOf(j, "text"), "命中 1 条")
        @Expect(strOf(j, "turnId"), "t1")
        @Expect(intOf(j, "step"), 2)
        @Expect(boolOf(j, "ok"), false)
        @Expect(hasKey(j, "key"), false)
        @Expect(hasKey(j, "value"), false)
        @Expect(hasKey(j, "kind"), true)
    }
}
