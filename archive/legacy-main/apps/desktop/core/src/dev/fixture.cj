package itn_desktop_core.dev

import std.collection.*
import itn_desktop_core.db.*

/*
 * 开发/自测用的会话数据夹具（--seed-fixture=总事件数）。
 *
 * 为什么放在内核里：项目约定“尽可能全仓颉”——检查脚本原先用 Python 直写 sqlite 文件
 * 来造大批量事件，现在改为内核自带的一个隐藏参数；种子写库走的就是驱动本身，
 * 文件格式/索引/分叉结构都和生产完全一致，也顺带验证了驱动的大批量写入。
 *
 * 只在一个空的 dataDir 上动手：库里已有任何会话就跳过，绝不动真实数据。
 * 生成的形状与 tools/session-list-check.cjs 的期望一一对应（改这里要同步改那边）。
 */

func pad2(n: Int64): String {
    if (n < 10) {
        return "0" + n.toString()
    }
    return n.toString()
}

func seedRow(sid: String, ts: String, kind: String, payload: String): ArrayList<DbValue> {
    let row = ArrayList<DbValue>()
    row.add(tv(sid))
    row.add(tv(ts))
    row.add(tv(kind))
    row.add(tv("t-0"))
    row.add(tv(payload))
    return row
}

public func seedSessionFixture(dataDir: String, totalEvents: Int64): Unit {
    let db = DbHub.open(dataDir)
    if (db.scalarInt("SELECT COUNT(*) FROM sessions", ArrayList<DbValue>()) > 0) {
        println("SEED_SKIP=已有会话，未灌数据")
        return
    }
    let sessionCount: Int64 = 60
    var per: Int64 = totalEvents / sessionCount
    if (per < 20) {
        per = 20
    }
    var i: Int64 = 0
    while (i < sessionCount) {
        let sid = "seed-" + i.toString()
        let created = "2026-10-" + pad2(1 + i % 27) + "T10:00:00+08:00"
        db.run("INSERT INTO sessions (id, created_at, updated_at) VALUES (?,?,?)", va([tv(sid), tv(created), tv(created)]))
        let rows = ArrayList<ArrayList<DbValue>>()
        var k: Int64 = 0
        while (k < per) {
            var kind = "assistant/delta"
            var payload = "{\"text\":\"正文片段 " + i.toString() + "-" + k.toString() + "\"}"
            if (k == 0) {
                kind = "turn/start"
                payload = "{\"kind\":\"" + (if (i % 3 == 0) { "quiz" } else { "ask" }) + "\",\"kbId\":\"\"}"
            } else if (k == 1) {
                kind = "user/message"
                payload = "{\"text\":\"第 " + i.toString() + " 号会话的第一个问题\"}"
            } else if (k == per - 1) {
                kind = "assistant/delta"
                payload = "{\"text\":\"最后一条 " + i.toString() + "\"}"
            } else {
                let m = (k - 2) % 3
                if (m == 1) {
                    kind = "user/message"
                    payload = "{\"text\":\"追问 " + i.toString() + "-" + k.toString() + "\"}"
                } else if (m == 2) {
                    kind = "assistant/message"
                    payload = "{\"text\":\"回答 " + i.toString() + "-" + k.toString() + "\"}"
                }
            }
            rows.add(seedRow(sid, created, kind, payload))
            k += 1
        }
        db.runMany("INSERT INTO session_events (session_id, ts, kind, turn_id, payload, parent_id) VALUES (?,?,?,?,?,NULL)", rows)
        i += 1
    }

    // 一条分叉会话：末端挪到第 100 条事件（parent 为 NULL 时链按行序线性回退，正好验证分支计数）
    let bsid = "seed-branch"
    let bcreated = "2026-10-20T10:00:00+08:00"
    db.run("INSERT INTO sessions (id, created_at, updated_at) VALUES (?,?,?)", va([tv(bsid), tv(bcreated), tv(bcreated)]))
    let brows = ArrayList<ArrayList<DbValue>>()
    var bk: Int64 = 0
    while (bk < per) {
        var kind = "assistant/delta"
        var payload = "{\"text\":\"分叉填充 " + bk.toString() + "\"}"
        if (bk == 0) {
            kind = "turn/start"
            payload = "{\"kind\":\"ask\",\"kbId\":\"\"}"
        } else if (bk == 1) {
            kind = "user/message"
            payload = "{\"text\":\"分叉会话的第一个问题\"}"
        }
        brows.add(seedRow(bsid, bcreated, kind, payload))
        bk += 1
    }
    db.runMany("INSERT INTO session_events (session_id, ts, kind, turn_id, payload, parent_id) VALUES (?,?,?,?,?,NULL)", brows)
    let ids = db.query("SELECT id FROM session_events WHERE session_id = ? ORDER BY id", va([tv(bsid)]))
    if (ids.size >= 100) {
        db.putKv("sessions_meta", "tree:" + bsid, "1")
        db.putKv("sessions_meta", "leaf:" + bsid, ids[99].int(0).toString())
    }
    println("SEED_DONE=" + (sessionCount + 1).toString() + " 段会话 · 每段 " + per.toString() + " 条事件")
}
