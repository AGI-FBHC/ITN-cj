package itn_desktop_core.runtime_host

import stdx.encoding.json.*
import std.time.*
import itn_desktop_core.db.DbHub
import itn_desktop_core.runtime.*
import itn_desktop_core.kb.stamp
import itn_desktop_core.session.SessionStore
import itn_desktop_core.session.SessionEvent

public func setTaskState(dataDir: String, sid: String, turnId: String, status: String): Unit {
    let db = DbHub.open(dataDir)
    let prevRaw = db.getKv("sessions_meta", "state:" + sid, "{}")
    let previous = match (JsonValue.fromStr(prevRaw)) { case o: JsonObject => o; case _ => JsonObject() }
    let o = JsonObject()
    o.put("sessionId", JsonString(sid))
    o.put("turnId", JsonString(turnId))
    o.put("status", JsonString(status))
    o.put("updatedAt", JsonString(stamp()))
    // 开始时间跟着**同一 turn**走：cancelling/completed 等后续状态保留 running 的快照；
    // 新 turn 必须重新计时，不能沿用上一轮的开始时间。
    var started = ""
    var startedMs: Int64 = 0
    let sameTurn = strOf(previous, "turnId") == turnId
    if (sameTurn) {
        match (previous.get("startedAt")) { case Some(v) => match (v) { case t: JsonString => started = t.getValue(); case _ => () }; case None => () }
        match (previous.get("startedMs")) { case Some(v) => match (v) { case n: JsonInt => startedMs = n.getValue(); case _ => () }; case None => () }
    }
    if (status == "running" && started.size == 0) { started = stamp(); startedMs = DateTime.now().toUnixTimeStamp().toMilliseconds() }
    if (started.size > 0) { o.put("startedAt", JsonString(started)) }
    if (startedMs > 0) { o.put("startedMs", JsonInt(startedMs)) }
    db.putKv("sessions_meta", "state:" + sid, o.toString())
}

public func taskState(dataDir: String, sid: String): JsonObject {
    let raw = DbHub.open(dataDir).getKv("sessions_meta", "state:" + sid, "{}")
    let o = objOf(JsonValue.fromStr(raw)).getOrDefault({ => JsonObject() })
    let status = strOf(o, "status")
    if ((status == "running" || status == "cancelling") && sessionHub().activeTurn(sid).size == 0) {
        setTaskState(dataDir, sid, strOf(o, "turnId"), "interrupted")
        o.put("status", JsonString("interrupted"))
        let ev = SessionEvent()
        ev.sessionId = sid
        ev.turnId = strOf(o, "turnId")
        ev.kind = "turn/end"
        ev.payload.put("ok", JsonBool(false))
        ev.payload.put("message", JsonString("上次任务因应用退出而中断，已有成果保留，可以继续任务"))
        SessionStore(dataDir).append(ev)
    }
    o.put("sessionId", JsonString(sid))
    o.put("canResume", JsonBool(strOf(o, "status") == "interrupted" || strOf(o, "status") == "cancelled" || strOf(o, "status") == "failed"))
    return o
}
