package itn_desktop_core.course

import std.collection.*
import std.convert.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.kb.stamp
import itn_desktop_core.util.*

/*
 * 学习活跃度：沿用已有 learning_events / course_events，不新建表。
 * 只统计真实学习动作；撤销完成、生成资源、打开页面和模型调用都不制造活跃。
 */
class ActivityBucket {
    let date: String
    var quiz: Int64 = 0
    var node: Int64 = 0
    var completion: Int64 = 0
    init(date: String) { this.date = date }
    func total(): Int64 { return quiz + node + completion }
    func json(): JsonObject {
        let o = JsonObject()
        o.put("date", JsonString(date))
        o.put("count", JsonInt(total()))
        o.put("quiz", JsonInt(quiz))
        o.put("node", JsonInt(node))
        o.put("completion", JsonInt(completion))
        return o
    }
}

func twoDigits(n: Int64): String { return if (n < 10) { "0" + n.toString() } else { n.toString() } }

func activityDateParts(s: String): Array<Int64> {
    let b = s.toArray()
    if (b.size < 10) { return [0, 0, 0] }
    let y = try { Int64.parse(String.fromUtf8(b[0..4])) } catch (e: Exception) { 0 }
    let m = try { Int64.parse(String.fromUtf8(b[5..7])) } catch (e: Exception) { 0 }
    let d = try { Int64.parse(String.fromUtf8(b[8..10])) } catch (e: Exception) { 0 }
    return [y, m, d]
}

/* 公历日期与序数互转，避免依赖平台时区 API。日期只使用本地日期字符串。 */
func civilOrdinal(yIn: Int64, m: Int64, d: Int64): Int64 {
    let y = if (m <= 2) { yIn - 1 } else { yIn }
    let era = (if (y >= 0) { y } else { y - 399 }) / 400
    let yoe = y - era * 400
    let mp = if (m > 2) { m - 3 } else { m + 9 }
    let doy = (153 * mp + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
}

func civilDate(zIn: Int64): Array<Int64> {
    let z = zIn + 719468
    let era = (if (z >= 0) { z } else { z - 146096 }) / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    var y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp + if (mp < 10) { 3 } else { -9 }
    if (m <= 2) { y += 1 }
    return [y, m, d]
}

func activityOrdinal(date: String): Int64 {
    let p = activityDateParts(date)
    if (p[0] == 0 || p[1] == 0 || p[2] == 0) { return -1000000000 }
    return civilOrdinal(p[0], p[1], p[2])
}

func activityDate(ordinal: Int64): String {
    let p = civilDate(ordinal)
    return p[0].toString() + "-" + twoDigits(p[1]) + "-" + twoDigits(p[2])
}

/** 测试与界面共用的日期偏移工具：输入 YYYY-MM-DD，返回偏移后的本地日期。 */
public func activityDateAdd(date: String, days: Int64): String { return activityDate(activityOrdinal(date) + days) }

func bucketOf(days: HashMap<String, ActivityBucket>, date: String): ActivityBucket {
    match (days.get(date)) {
        case Some(b) => return b
        case None =>
            let b = ActivityBucket(date)
            days[date] = b
            return b
    }
}

func bucketCount(days: HashMap<String, ActivityBucket>, date: String): Int64 {
    match (days.get(date)) { case Some(b) => return b.total(); case None => return 0 }
}

func eventDate(raw: String): String {
    let b = raw.toArray()
    if (b.size < 10) { return "" }
    return String.fromUtf8(b[0..10])
}

/** 当前周周一向前 52 周，共 53 周；只汇总到今天。 */
func activityWindow(today: String): (String, String, Int64, Int64) {
    let todayOrd = activityOrdinal(today)
    let weekday = ((todayOrd + 3) % 7 + 7) % 7 // 1970-01-01 是周四；Monday=0
    let startOrd = todayOrd - weekday - 52 * 7
    return (activityDate(startOrd), today, startOrd, todayOrd)
}

/** 仓颉侧唯一聚合：report 与 Lumin 工具都读这一份。 */
public func courseActivity(dataDir: String, kb: String): JsonObject {
    let now = stamp()
    let today = eventDate(now)
    let (from, to, startOrd, todayOrd) = activityWindow(today)
    let days = HashMap<String, ActivityBucket>()
    let db = DbHub.open(dataDir)

    let completionSeen = HashSet<String>()
    for (r in db.query("SELECT id,kind,resource_id,version,item_key,payload,at FROM learning_events WHERE kb_id=? AND at>=? ORDER BY at", va([tv(kb), tv(from)]))) {
        let date = eventDate(r.text(6))
        if (date.size == 0 || date < from || date > to) { continue }
        let kind = r.text(1)
        if (kind == "quiz") {
            bucketOf(days, date).quiz += 1
        } else if (kind == "completion") {
            let payload = try { courseJson(r.text(5)) } catch (e: Exception) { JsonObject() }
            if (!boolOf(payload, "done")) { continue }
            let key = date + "|" + r.text(2) + "|" + r.text(3) + "|" + r.text(4)
            if (!completionSeen.contains(key)) { completionSeen.add(key); bucketOf(days, date).completion += 1 }
        }
    }

    let nodeSeen = HashSet<String>()
    for (r in db.query("SELECT node_id,body,at FROM course_events WHERE kb_id=? AND at>=? ORDER BY at", va([tv(kb), tv(from)]))) {
        let date = eventDate(r.text(2))
        if (date.size == 0 || date < from || date > to) { continue }
        let body = try { courseJson(r.text(1)) } catch (e: Exception) { JsonObject() }
        if (strOf(body, "kind") != "node-complete" || !boolOf(body, "done")) { continue }
        let key = date + "|" + r.text(0)
        if (!nodeSeen.contains(key)) { nodeSeen.add(key); bucketOf(days, date).node += 1 }
    }

    var activeDays: Int64 = 0
    var total: Int64 = 0
    var longest: Int64 = 0
    var run: Int64 = 0
    var cursor = startOrd
    while (cursor <= todayOrd) {
        let count = bucketCount(days, activityDate(cursor))
        if (count > 0) {
            activeDays += 1
            total += count
            run += 1
            if (run > longest) { longest = run }
        } else {
            run = 0
        }
        cursor += 1
    }

    var current: Int64 = 0
    cursor = todayOrd
    if (bucketCount(days, activityDate(cursor)) == 0) { cursor -= 1 }
    while (cursor >= startOrd && bucketCount(days, activityDate(cursor)) > 0) {
        current += 1
        cursor -= 1
    }

    let dates = ArrayList<String>()
    for ((date, _) in days) { dates.add(date) }
    var i: Int64 = 0
    while (i < dates.size) {
        var j: Int64 = 0
        while (j + 1 < dates.size - i) {
            if (dates[j] > dates[j + 1]) { let t = dates[j]; dates[j] = dates[j + 1]; dates[j + 1] = t }
            j += 1
        }
        i += 1
    }
    let rows = JsonArray()
    i = 0
    while (i < dates.size) {
        let b = days[dates[i]]
        rows.add(b.json())
        i += 1
    }

    let out = JsonObject()
    out.put("from", JsonString(from))
    out.put("to", JsonString(to))
    out.put("total", JsonInt(total))
    out.put("activeDays", JsonInt(activeDays))
    out.put("currentStreak", JsonInt(current))
    out.put("longestStreak", JsonInt(longest))
    out.put("days", rows)
    return out
}
