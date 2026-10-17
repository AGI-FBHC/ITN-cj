package itn_spire

import std.core.*
import std.convert.*
import std.time.*

public func nowUtcParts(): TimeParts {
    let dt = DateTime.nowUTC()
    TimeParts(dt.year, dt.monthValue, dt.dayOfMonth, dt.hour, dt.minute, dt.second,
              dt.nanosecond / 1000)
}

/* Unix epoch seconds, used by JWT exp/nbf checks. */
public func nowEpochSeconds(): Int64 {
    DateTime.nowUTC().toUnixTimeStamp().toMilliseconds() / 1000
}

/*
 * Parse a MySQL DATETIME(6) text value ("2026-10-14 12:00:00.123456") or an
 * ISO value with 'T' into parts for JSON serialisation.
 */
public func parseDbDatetime(text: String): TimeParts {
    var cleaned = text
    if (cleaned.contains("T")) {
        cleaned = cleaned.replace("T", " ")
    }
    match (cleaned.indexOf("Z")) {
        case Some(z) => cleaned = cleaned[0..z]
        case None => ()
    }
    var datePart = cleaned
    var timePart = "00:00:00"
    match (cleaned.indexOf(" ")) {
        case Some(sp) =>
            if (sp > 0) {
                datePart = cleaned[0..sp]
                timePart = cleaned[(sp + 1)..cleaned.size]
            }
        case None => ()
    }
    var y: Int64 = 1970
    var mo: Int64 = 1
    var d: Int64 = 1
    let dparts = datePart.split("-")
    if (dparts.size >= 3) {
        y = Int64.tryParse(dparts[0]) ?? 1970
        mo = Int64.tryParse(dparts[1]) ?? 1
        d = Int64.tryParse(dparts[2]) ?? 1
    }
    var h: Int64 = 0
    var mi: Int64 = 0
    var s: Int64 = 0
    var us: Int64 = 0
    var tmain = timePart
    match (timePart.indexOf(".")) {
        case Some(dot) =>
            tmain = timePart[0..dot]
            var frac = timePart[(dot + 1)..timePart.size]
            while (frac.size < 6) {
                frac = frac + "0"
            }
            if (frac.size > 6) {
                frac = frac[0..6]
            }
            us = Int64.tryParse(frac) ?? 0
        case None => ()
    }
    let tparts = tmain.split(":")
    if (tparts.size >= 3) {
        h = Int64.tryParse(tparts[0]) ?? 0
        mi = Int64.tryParse(tparts[1]) ?? 0
        s = Int64.tryParse(tparts[2]) ?? 0
    }
    return TimeParts(y, mo, d, h, mi, s, us)
}

public func isoFromDb(text: String): String {
    isoDatetime(parseDbDatetime(text))
}

/*
 * Python datetime.isoformat() on a naive datetime: microseconds are included
 * only when non-zero, and there is no timezone suffix. Used by course rows.
 */
public func isoNaiveFromDb(text: String): String {
    let p = parseDbDatetime(text)
    var s = pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second)
    if (p.micros != 0) {
        s = s + "." + pad6(p.micros)
    }
    return s
}

/*
 * Python _UTC8 = timezone(timedelta(hours=8)) is a fixed offset with no DST,
 * so UTC+8 wall-clock is just UTC plus eight hours.
 */
private func daysInMonth(year: Int64, month: Int64): Int64 {
    if (month == 2) {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        return if (leap) { 29 } else { 28 }
    }
    if (month == 4 || month == 6 || month == 9 || month == 11) {
        return 30
    }
    return 31
}

public func nowUtc8Parts(): TimeParts {
    let p = nowUtcParts()
    var h = p.hour + 8
    var d = p.day
    var mo = p.month
    var y = p.year
    while (h >= 24) {
        h -= 24
        d += 1
        if (d > daysInMonth(y, mo)) {
            d = 1
            mo += 1
            if (mo > 12) {
                mo = 1
                y += 1
            }
        }
    }
    return TimeParts(y, mo, d, h, p.minute, p.second, p.micros)
}

/*
 * Python datetime.now(_UTC8).isoformat(): timezone-aware, so the offset is
 * always printed, microseconds only when non-zero. Used by learned_meta and
 * progress timestamps — unlike createdAt/updatedAt, which are naive.
 */
public func isoUtc8Now(): String {
    let p = nowUtc8Parts()
    var s = pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second)
    if (p.micros != 0) {
        s = s + "." + pad6(p.micros)
    }
    return s + "+08:00"
}

/*
 * MySQL literal for the UTC+8 wall-clock now. Presentation/resource stores
 * write datetime.now(_UTC8) into DATETIME/TIMESTAMP columns, so the round-trip
 * through the session time zone preserves this literal — matching Python.
 */
public func sqlNowUtc8Literal(): String {
    sqlQuote(mysqlDatetime(nowUtc8Parts()))
}

/*
 * java.time.Instant serialized by Jackson (ISO_INSTANT): UTC with a trailing
 * Z and the fractional second only when non-zero. Used for ApiResponse's
 * `timestamp` field, which is a Java Instant.
 */
public func isoUtcNowZ(): String {
    let p = nowUtcParts()
    var s = pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second)
    if (p.micros != 0) {
        s = s + "." + pad6(p.micros)
    }
    return s + "Z"
}

/*
 * Wrong-answer timestamps follow WrongAnswerStore._iso_utc: naive UTC with a
 * trailing Z, and microseconds omitted when zero (Python datetime.isoformat).
 */
public func isoUtcZFromDb(text: String): String {
    let p = parseDbDatetime(text)
    var s = pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second)
    if (p.micros != 0) {
        s = s + "." + pad6(p.micros)
    }
    return s + "Z"
}
