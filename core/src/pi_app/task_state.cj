package itn_desktop_core.pi_app

import stdx.encoding.json.*
import itn_desktop_core.db.DbHub
import itn_desktop_core.pi.*
import itn_desktop_core.kb.stamp
import itn_desktop_core.session.SessionStore
import itn_desktop_core.session.SessionEvent

public func setTaskState(dataDir: String, sid: String, turnId: String, status: String): Unit {
    let o = JsonObject()
    o.put("sessionId", JsonString(sid))
    o.put("turnId", JsonString(turnId))
    o.put("status", JsonString(status))
    o.put("updatedAt", JsonString(stamp()))
    DbHub.open(dataDir).putKv("sessions_meta", "state:" + sid, o.toString())
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
