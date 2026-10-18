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
 * Z. The fraction is the 9-digit nanosecond count with a trailing "000"
 * group removed repeatedly — not "as many digits as are non-zero". So
 * micros 123000 prints ".123Z", not ".123000Z"; micros 123450 prints
 * ".123450Z". Used for ApiResponse's `timestamp` field.
 */
private func isoInstantFraction(micros: Int64): String {
    if (micros == 0) {
        return ""
    }
    /* pad6(micros) is the 9-digit nanos with its trailing "000" already off */
    var f = pad6(micros)
    while (f.size >= 3 && f[(f.size - 3)..f.size] == "000") {
        f = f[0..(f.size - 3)]
    }
    return "." + f
}

public func isoUtcNowZ(): String {
    let p = nowUtcParts()
    return pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second) +
        isoInstantFraction(p.micros) + "Z"
}

/*
 * ISO_INSTANT for a Java Instant column read back out of MySQL. Same
 * group-of-3 fraction rule as isoUtcNowZ. Used by the Spring Boot read
 * contracts — ProfileResponse/LearnerResponse createdAt+updatedAt,
 * TimelineItem.occurredAt, DailySummary.generatedAt.
 *
 * The text MUST already be UTC. MySQL renders timestamp(6) columns in the
 * session time zone (SYSTEM = UTC+08:00 on this host), while java.time.Instant
 * is an absolute instant and ISO_INSTANT prints UTC — so pass the value
 * through shiftTimestampText first. See dbUtcOffsetMicros.
 */
public func isoInstantFromDb(text: String): String {
    let p = parseDbDatetime(text)
    return pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second) +
        isoInstantFraction(p.micros) + "Z"
}

/*
 * ISO_LOCAL_DATE_TIME — what Jackson writes for a field declared as a
 * formatted String built with DateTimeFormatter.ISO_LOCAL_DATE_TIME
 * (QuizSummary.createdAt). Seconds are always printed; the fraction is
 * omitted when nanos == 0 and otherwise has ALL trailing zeros stripped
 * (micros 123450 -> ".12345", micros 1 -> ".000001"). No zone suffix.
 */
public func isoLocalDatetimeFromDb(text: String): String {
    let p = parseDbDatetime(text)
    var s = pad4(p.year) + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" +
        pad2(p.hour) + ":" + pad2(p.minute) + ":" + pad2(p.second)
    if (p.micros != 0) {
        var f = pad6(p.micros)
        while (f.size > 1 && f[(f.size - 1)..f.size] == "0") {
            f = f[0..(f.size - 1)]
        }
        s = s + "." + f
    }
    return s
}

/*
 * Wrong-answer timestamps follow WrongAnswerStore._iso_utc: naive UTC with a
 * trailing Z, and microseconds omitted when zero (Python datetime.isoformat).
 * Not ISO_INSTANT — Python pads the fraction to six digits, Java strips
 * trailing zero groups. Keep these two apart.
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

/* ===================================================================
 * Civil-date arithmetic for the Spring Boot read contracts.
 *
 * LocalDate is a y/m/d with no zone; ChronoUnit.DAYS.between is just the
 * difference of epoch days. The conversion is Howard Hinnant's
 * days_from_civil / civil_from_days, exact for year >= 0.
 * =================================================================== */

public struct CivilDate {
    public let year: Int64
    public let month: Int64
    public let day: Int64

    public init(year: Int64, month: Int64, day: Int64) {
        this.year = year
        this.month = month
        this.day = day
    }
}

public func epochDayFromDate(d: CivilDate): Int64 {
    var y = d.year
    if (d.month <= 2) {
        y = y - 1
    }
    let era = y / 400
    let yoe = y - era * 400
    let mp = if (d.month > 2) { d.month - 3 } else { d.month + 9 }
    let doy = (153 * mp + 2) / 5 + d.day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
}

public func dateFromEpochDay(z0: Int64): CivilDate {
    let z = z0 + 719468
    let era = z / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = if (mp < 10) { mp + 3 } else { mp - 9 }
    return CivilDate(if (m <= 2) { y + 1 } else { y }, m, d)
}

public func addDays(d: CivilDate, n: Int64): CivilDate {
    dateFromEpochDay(epochDayFromDate(d) + n)
}

/* ChronoUnit.DAYS.between(a, b) == b.toEpochDay() - a.toEpochDay(). */
public func daysBetween(a: CivilDate, b: CivilDate): Int64 {
    epochDayFromDate(b) - epochDayFromDate(a)
}

/* DateTimeFormatter.ISO_LOCAL_DATE — "yyyy-MM-dd". */
public func dateIsoText(d: CivilDate): String {
    pad4(d.year) + "-" + pad2(d.month) + "-" + pad2(d.day)
}

public func nowUtcDate(): CivilDate {
    let p = nowUtcParts()
    CivilDate(p.year, p.month, p.day)
}

/* LocalDate.now(ZoneId.of("Asia/Shanghai")) — a fixed +08:00, no DST. */
public func nowUtc8Date(): CivilDate {
    let p = nowUtc8Parts()
    CivilDate(p.year, p.month, p.day)
}

public func timePartsToEpochMicros(p: TimeParts): Int64 {
    epochDayFromDate(CivilDate(p.year, p.month, p.day)) * 86400000000 +
        p.hour * 3600000000 + p.minute * 60000000 + p.second * 1000000 + p.micros
}

/* Exact for |us| below ~106751 days from the epoch — far beyond this schema. */
public func epochMicrosToTimeParts(us: Int64): TimeParts {
    var day = us / 86400000000
    var rem = us - day * 86400000000
    if (rem < 0) {
        /* floor the day so the remainder is non-negative */
        day = day - 1
        rem = rem + 86400000000
    }
    let d = dateFromEpochDay(day)
    let h = rem / 3600000000
    rem = rem - h * 3600000000
    let mi = rem / 60000000
    rem = rem - mi * 60000000
    let s = rem / 1000000
    let micros = rem - s * 1000000
    return TimeParts(d.year, d.month, d.day, h, mi, s, micros)
}

/*
 * Move a timestamp(6) text value from the session time zone to UTC.
 *
 * MySQL renders timestamp(6) columns in the session time zone; java.time.Instant
 * is absolute and ISO_INSTANT prints UTC. `offsetMicros` is
 * NOW(6) - UTC_TIMESTAMP(6) for the session (see dbUtcOffsetMicros), so a
 * session at UTC+08:00 yields +28800000000 and this subtracts eight hours.
 *
 * DATETIME columns are a naked wall clock and must NOT go through here.
 */
public func shiftTimestampText(text: String, offsetMicros: Int64): String {
    let p = parseDbDatetime(text)
    mysqlDatetime(epochMicrosToTimeParts(timePartsToEpochMicros(p) - offsetMicros))
}
