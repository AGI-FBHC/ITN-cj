package itn_desktop_core.pi_app

import stdx.encoding.json.*
import itn_desktop_core.db.DbHub
import itn_desktop_core.pi.*
import itn_desktop_core.kb.stamp

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
    }
    o.put("sessionId", JsonString(sid))
    o.put("canResume", JsonBool(strOf(o, "status") == "interrupted" || strOf(o, "status") == "cancelled" || strOf(o, "status") == "failed"))
    return o
}
