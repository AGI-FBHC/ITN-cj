package sqlite_driver

import std.convert.*
import std.time.*

/*
 * 日期时间函数: date / time / datetime / julianday / unixepoch / strftime。
 *
 * 全部基于**儒略日** (Julian Day, JD) 的整数/浮点表示, 与 SQLite 的内部做法一致。所有
 * 转换用纯整数算术实现, 不经过系统的日历库: 系统库会带入本地时区与夏令时, 而 SQLite 的
 * 日期函数默认按 UTC 工作 —— 混进本地时区会让同一条 SQL 在不同机器上给出不同结果。
 *
 * 时刻用"自儒略日纪元起的毫秒数" (jdMillis) 表示而不是浮点 JD: 浮点在秒级以下会丢精度
 * (JD 已经是 245 万多, 双精度尾数留给小数部分的位数只够到约 10 微秒), 于是
 * `strftime('%f', ...)` 的毫秒位会漂。只在 julianday() 的返回值上转成浮点。
 *
 * 参数形态: 第一个参数是时间值, 其后是修饰符 ('+1 day' / 'start of month' / 'utc' …)。
 * 无参或第一参为 'now' 时取当前时间。
 */

/** 儒略日 2440587.5 = Unix 纪元 1970-01-01T00:00:00Z。 */
const JD_UNIX_EPOCH_HALF_DAYS: Int64 = 4881175
/** 一天的毫秒数。 */
const MILLIS_PER_DAY: Int64 = 86400000

/** Unix 毫秒 → 儒略日毫秒。 */
func unixMillisToJdMillis(unixMs: Int64): Int64 {
    // JD 0 比 Unix 纪元早 2440587.5 天。
    unixMs + (JD_UNIX_EPOCH_HALF_DAYS * MILLIS_PER_DAY) / 2
}

func jdMillisToUnixMillis(jdMs: Int64): Int64 {
    jdMs - (JD_UNIX_EPOCH_HALF_DAYS * MILLIS_PER_DAY) / 2
}

/** 分解后的日历时刻, 全部 UTC。 */
class CivilTime {
    var year: Int64
    var month: Int64
    var day: Int64
    var hour: Int64
    var minute: Int64
    var second: Int64
    var millis: Int64

    init(year: Int64, month: Int64, day: Int64, hour: Int64, minute: Int64, second: Int64, millis: Int64) {
        this.year = year
        this.month = month
        this.day = day
        this.hour = hour
        this.minute = minute
        this.second = second
        this.millis = millis
    }
}

/**
 * 儒略日毫秒 → 日历。
 *
 * 用 Howard Hinnant 的 civil_from_days 算法: 纯整数, 对负年份 (公元前) 也正确。
 * 常见的"从 1970 起逐年减"写法在公元前会错, 且闰年判定容易漏掉百年规则。
 */
func jdMillisToCivil(jdMs: Int64): CivilTime {
    // 先分出"儒略日整数部分"与"日内毫秒"。JD 的日界在正午, 而日历日界在午夜, 差半天。
    var totalMs = jdMs + MILLIS_PER_DAY / 2
    var days = floorDiv(totalMs, MILLIS_PER_DAY)
    var msOfDay = totalMs - days * MILLIS_PER_DAY
    // days 现在是"自 JD 0 的午夜起的天数"; 转成自 1970-01-01 的天数。
    let z = days - JD_UNIX_EPOCH_HALF_DAYS / 2 - 1
    let (y, m, d) = civilFromDays(z)
    let hour = msOfDay / 3600000
    msOfDay -= hour * 3600000
    let minute = msOfDay / 60000
    msOfDay -= minute * 60000
    let second = msOfDay / 1000
    let millis = msOfDay - second * 1000
    CivilTime(y, m, d, hour, minute, second, millis)
}

/** 日历 → 儒略日毫秒。与 jdMillisToCivil 对偶。 */
func civilToJdMillis(c: CivilTime): Int64 {
    let days = daysFromCivil(c.year, c.month, c.day)
    let dayMs = (days + JD_UNIX_EPOCH_HALF_DAYS / 2 + 1) * MILLIS_PER_DAY
    let timeMs = c.hour * 3600000 + c.minute * 60000 + c.second * 1000 + c.millis
    dayMs + timeMs - MILLIS_PER_DAY / 2
}

/** 向下取整的整除 (对负数也向下), 仓颉的 / 是向零截断。 */
func floorDiv(a: Int64, b: Int64): Int64 {
    let q = a / b
    if ((a % b != 0) && ((a < 0) != (b < 0))) {
        return q - 1
    }
    q
}

/**
 * 自 1970-01-01 的天数 → (年, 月, 日)。
 *
 * 算法把纪元移到 0000-03-01 (三月为年首), 这样闰日落在年末, 月长序列变得规整,
 * 于是"第几天属于第几月"可以用一个线性公式算出来, 不需要查表也不需要特判二月。
 */
func civilFromDays(z0: Int64): (Int64, Int64, Int64) {
    var z = z0
    z += 719468
    let era = floorDiv(z, 146097)
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = if (mp < 10) {
        mp + 3
    } else {
        mp - 9
    }
    (if (m <= 2) {
            y + 1
        } else {
            y
        }, m, d)
}

/** (年, 月, 日) → 自 1970-01-01 的天数。civilFromDays 的逆。 */
func daysFromCivil(year: Int64, month: Int64, day: Int64): Int64 {
    let y = if (month <= 2) {
        year - 1
    } else {
        year
    }
    let era = floorDiv(y, 400)
    let yoe = y - era * 400
    let mp = if (month > 2) {
        month - 3
    } else {
        month + 9
    }
    let doy = (153 * mp + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    era * 146097 + doe - 719468
}

/** 星期几: 0 = 周日 (与 strftime %w 一致)。 */
func dayOfWeekFrom(jdMs: Int64): Int64 {
    let days = floorDiv(jdMs + MILLIS_PER_DAY / 2, MILLIS_PER_DAY)
    // JD 0 的午夜是周一, 故 +1 让周日为 0。
    let w = (days + 1) % 7
    if (w < 0) {
        w + 7
    } else {
        w
    }
}

/** 一年中的第几天, 1 起。 */
func dayOfYearFrom(c: CivilTime): Int64 {
    daysFromCivil(c.year, c.month, c.day) - daysFromCivil(c.year, 1, 1) + 1
}

/*
 * 函数入口。
 */
func evalDateFunction(f: FuncExpr, args: Array<SqliteValue>, lower: String): SqliteValue {
    // strftime 的第一参是格式串, 时间值从第二参起。
    let formatArg = if (lower == "strftime") {
        if (args.size < 1) {
            throw SqliteRuntimeException("sql", "strftime() requires a format string")
        }
        match (args[0]) {
            case SNull => return SqliteValue.SNull
            case _ => valueToText(args[0])
        }
    } else {
        ""
    }
    let firstTimeArg = if (lower == "strftime") {
        1
    } else {
        0
    }
    let parsed = parseTimeArguments(args, firstTimeArg)
    let jdMs = match (parsed) {
        case None => return SqliteValue.SNull
        case Some(v) => v
    }
    match (lower) {
        case "date" => SqliteValue.SText(formatDatePart(jdMsToCivilChecked(jdMs)))
        case "time" => SqliteValue.SText(formatTimePart(jdMsToCivilChecked(jdMs)))
        case "datetime" =>
            let c = jdMsToCivilChecked(jdMs)
            SqliteValue.SText("${formatDatePart(c)} ${formatTimePart(c)}")
        case "julianday" => SqliteValue.SReal(Float64(jdMs) / Float64(MILLIS_PER_DAY))
        case "unixepoch" => SqliteValue.SInt(floorDiv(jdMillisToUnixMillis(jdMs), 1000))
        case "strftime" => SqliteValue.SText(applyStrftime(formatArg, jdMs))
        case _ => throw SqliteRuntimeException("sql", "no such function: ${f.name}")
    }
}

func jdMsToCivilChecked(jdMs: Int64): CivilTime {
    jdMillisToCivil(jdMs)
}

/**
 * 解析时间参数与修饰符。
 *
 * 返回 None 表示时间值无法解析 —— SQLite 在这种情况下返回 NULL 而不是报错, 于是
 * `date('not a date')` 是 NULL。照做: 报错会让一条含脏数据的查询整体失败。
 */
func parseTimeArguments(args: Array<SqliteValue>, from: Int64): Option<Int64> {
    var jdMs = if (from >= args.size) {
        // 无时间参数: 取当前时间。
        currentJdMillis()
    } else {
        match (args[from]) {
            case SNull => return None
            case _ => match (parseTimeValue(args[from])) {
                case None => return None
                case Some(v) => v
            }
        }
    }
    for (i in (from + 1)..args.size) {
        match (args[i]) {
            case SNull => return None
            case _ => ()
        }
        match (applyModifier(jdMs, valueToText(args[i]))) {
            case None => return None
            case Some(v) => jdMs = v
        }
    }
    Some(jdMs)
}

func currentJdMillis(): Int64 {
    unixMillisToJdMillis(DateTime.now().toUnixTimeStamp().toMilliseconds())
}

/**
 * 解析一个时间值。
 *
 * 接受的形态:
 *   'now'                         当前时间
 *   'YYYY-MM-DD'                  日期
 *   'YYYY-MM-DD HH:MM[:SS[.SSS]]' 日期时间 (分隔符可为空格或 'T')
 *   'HH:MM[:SS[.SSS]]'            当日时间 (日期取 2000-01-01, 与 SQLite 一致)
 *   数值                          儒略日
 *
 * 数值一律按儒略日解释而不是 Unix 时间戳 —— 这是 SQLite 的规则, 想按 Unix 秒解释要用
 * 'unixepoch' 修饰符。把大整数猜成 Unix 时间戳会让 julianday(2451545) 给出错值。
 */
func parseTimeValue(v: SqliteValue): Option<Int64> {
    match (v) {
        case SInt(i) => return Some(i * MILLIS_PER_DAY)
        case SReal(f) => return Some(Int64(f * Float64(MILLIS_PER_DAY)))
        case _ => ()
    }
    let text = valueToText(v).trimAscii()
    if (text.toAsciiLower() == "now") {
        return Some(currentJdMillis())
    }
    // 纯数字文本也当儒略日。
    if (let Some(num) <- textToNumber(text)) {
        return match (num) {
            case SInt(i) => Some(i * MILLIS_PER_DAY)
            case SReal(f) => Some(Int64(f * Float64(MILLIS_PER_DAY)))
            case _ => None
        }
    }
    parseDateTimeText(text)
}

/** 解析 ISO 风格的日期时间文本。 */
func parseDateTimeText(text: String): Option<Int64> {
    let bytes = text.toArray()
    // 纯时间形态: 以 HH: 开头且没有 '-'。
    if (text.size >= 3 && bytes[2] == UInt8(b':')) {
        let c = CivilTime(2000, 1, 1, 0, 0, 0, 0)
        if (!parseTimeInto(text, 0, c)) {
            return None
        }
        return Some(civilToJdMillis(c))
    }
    if (text.size < 10) {
        return None
    }
    // YYYY-MM-DD
    if (bytes[4] != UInt8(b'-') || bytes[7] != UInt8(b'-')) {
        return None
    }
    let year = parseFixedDigits(text, 0, 4)
    let month = parseFixedDigits(text, 5, 2)
    let day = parseFixedDigits(text, 8, 2)
    if (year < 0 || month < 1 || month > 12 || day < 1 || day > 31) {
        return None
    }
    let c = CivilTime(year, month, day, 0, 0, 0, 0)
    if (text.size == 10) {
        return Some(civilToJdMillis(c))
    }
    // 分隔符必须是空格或 T。
    let sep = bytes[10]
    if (sep != UInt8(b' ') && sep != UInt8(b'T') && sep != UInt8(b't')) {
        return None
    }
    if (!parseTimeInto(text, 11, c)) {
        return None
    }
    Some(civilToJdMillis(c))
}

/**
 * 从 offset 处解析 HH:MM[:SS[.fff]][Z|±HH:MM] 填进 c。
 *
 * 时区偏移要减掉转成 UTC: 带偏移的文本不换算会让存进去的时刻偏几个小时, 且无任何提示。
 */
func parseTimeInto(text: String, offset: Int64, c: CivilTime): Bool {
    let bytes = text.toArray()
    if (offset + 5 > text.size) {
        return false
    }
    if (bytes[offset + 2] != UInt8(b':')) {
        return false
    }
    let hour = parseFixedDigits(text, offset, 2)
    let minute = parseFixedDigits(text, offset + 3, 2)
    if (hour < 0 || hour > 24 || minute < 0 || minute > 59) {
        return false
    }
    c.hour = hour
    c.minute = minute
    var pos = offset + 5
    if (pos < text.size && bytes[pos] == UInt8(b':')) {
        if (pos + 3 > text.size) {
            return false
        }
        let second = parseFixedDigits(text, pos + 1, 2)
        if (second < 0 || second > 59) {
            return false
        }
        c.second = second
        pos += 3
        if (pos < text.size && bytes[pos] == UInt8(b'.')) {
            pos += 1
            var scale = 100
            var ms = 0
            while (pos < text.size && bytes[pos] >= UInt8(b'0') && bytes[pos] <= UInt8(b'9')) {
                if (scale >= 1) {
                    ms += Int64(bytes[pos] - UInt8(b'0')) * scale
                    scale /= 10
                }
                pos += 1
            }
            c.millis = ms
        }
    }
    if (pos >= text.size) {
        return true
    }
    // 时区。
    if (bytes[pos] == UInt8(b'Z') || bytes[pos] == UInt8(b'z')) {
        return pos + 1 == text.size
    }
    if (bytes[pos] != UInt8(b'+') && bytes[pos] != UInt8(b'-') && bytes[pos] != UInt8(b' ')) {
        return false
    }
    if (bytes[pos] == UInt8(b' ')) {
        // 尾随空格允许。
        return true
    }
    let negative = bytes[pos] == UInt8(b'-')
    pos += 1
    if (pos + 2 > text.size) {
        return false
    }
    let offsetHour = parseFixedDigits(text, pos, 2)
    if (offsetHour < 0) {
        return false
    }
    pos += 2
    var offsetMinute = 0
    if (pos < text.size && bytes[pos] == UInt8(b':')) {
        if (pos + 3 > text.size) {
            return false
        }
        offsetMinute = parseFixedDigits(text, pos + 1, 2)
        if (offsetMinute < 0) {
            return false
        }
    }
    var totalMinutes = offsetHour * 60 + offsetMinute
    if (!negative) {
        totalMinutes = -totalMinutes
    }
    // 偏移作用在分钟上, 可能跨日; 由 civilToJdMillis 的算术自然处理。
    c.minute += totalMinutes
    true
}

/** 定长十进制解析; 非数字返回 -1。 */
func parseFixedDigits(text: String, offset: Int64, count: Int64): Int64 {
    if (offset + count > text.size) {
        return -1
    }
    let bytes = text.toArray()
    var acc = 0
    for (i in offset..(offset + count)) {
        let b = bytes[i]
        if (b < UInt8(b'0') || b > UInt8(b'9')) {
            return -1
        }
        acc = acc * 10 + Int64(b - UInt8(b'0'))
    }
    acc
}

/**
 * 修饰符。
 *
 * 支持: ±N days/hours/minutes/seconds/months/years, start of day/month/year,
 * weekday N, unixepoch, julianday, utc, localtime。
 *
 * 月与年的加减不能换算成固定天数 —— '+1 month' 从 1月31日出发应到 2月28日 (SQLite 实际
 * 会给 3月3日, 因为它先加月再规范化; 这里照它的行为做, 保持一致比"更合理"重要)。
 */
func applyModifier(jdMs: Int64, raw: String): Option<Int64> {
    let mod = raw.trimAscii().toAsciiLower()
    if (mod.isEmpty()) {
        return None
    }
    if (mod == "unixepoch") {
        // 把先前按儒略日解释的数值改按 Unix 秒解释。
        let asSeconds = jdMs / MILLIS_PER_DAY
        return Some(unixMillisToJdMillis(asSeconds * 1000))
    }
    if (mod == "julianday") {
        return Some(jdMs)
    }
    if (mod == "utc" || mod == "localtime") {
        // 本驱动全程 UTC, 两者都是空操作。不报错: 上层常无条件附加 'utc'。
        return Some(jdMs)
    }
    if (mod.startsWith("start of ")) {
        let unit = mod[9..mod.size].trimAscii()
        let c = jdMillisToCivil(jdMs)
        c.hour = 0
        c.minute = 0
        c.second = 0
        c.millis = 0
        match (unit) {
            case "day" => ()
            case "month" => c.day = 1
            case "year" =>
                c.month = 1
                c.day = 1
            case _ => return None
        }
        return Some(civilToJdMillis(c))
    }
    if (mod.startsWith("weekday ")) {
        let target = try {
            Int64.parse(mod[8..mod.size].trimAscii())
        } catch (_: Exception) {
            return None
        }
        if (target < 0 || target > 6) {
            return None
        }
        // 前进到下一个该星期几 (今天就是则不动) —— SQLite 的语义。
        let current = dayOfWeekFrom(jdMs)
        var delta = target - current
        if (delta < 0) {
            delta += 7
        }
        return Some(jdMs + delta * MILLIS_PER_DAY)
    }
    parseOffsetModifier(jdMs, mod)
}

/** ±N unit 形态的修饰符。 */
func parseOffsetModifier(jdMs: Int64, mod: String): Option<Int64> {
    // 拆成数值与单位。
    var pos = 0
    let bytes = mod.toArray()
    if (pos < bytes.size && (bytes[pos] == UInt8(b'+') || bytes[pos] == UInt8(b'-'))) {
        pos += 1
    }
    var sawDigit = false
    while (pos < bytes.size && bytes[pos] >= UInt8(b'0') && bytes[pos] <= UInt8(b'9')) {
        pos += 1
        sawDigit = true
    }
    if (pos < bytes.size && bytes[pos] == UInt8(b'.')) {
        pos += 1
        while (pos < bytes.size && bytes[pos] >= UInt8(b'0') && bytes[pos] <= UInt8(b'9')) {
            pos += 1
            sawDigit = true
        }
    }
    if (!sawDigit) {
        return None
    }
    let amountText = mod[0..pos]
    let unit = mod[pos..mod.size].trimAscii()
    let amount = try {
        Float64.parse(amountText)
    } catch (_: Exception) {
        return None
    }
    match (normalizeTimeUnit(unit)) {
        case "day" => Some(jdMs + Int64(amount * Float64(MILLIS_PER_DAY)))
        case "hour" => Some(jdMs + Int64(amount * 3600000.0))
        case "minute" => Some(jdMs + Int64(amount * 60000.0))
        case "second" => Some(jdMs + Int64(amount * 1000.0))
        case "month" => Some(addMonths(jdMs, Int64(amount)))
        case "year" => Some(addMonths(jdMs, Int64(amount) * 12))
        case _ => None
    }
}

func normalizeTimeUnit(unit: String): String {
    match (unit) {
        case "day" | "days" => "day"
        case "hour" | "hours" => "hour"
        case "minute" | "minutes" => "minute"
        case "second" | "seconds" => "second"
        case "month" | "months" => "month"
        case "year" | "years" => "year"
        case _ => ""
    }
}

/**
 * 加月份。
 *
 * 先加到 (年, 月), 再让 civilToJdMillis 规范化溢出的日 —— 1月31日 + 1月 变成 "2月31日",
 * daysFromCivil 会把它算成 3月3日 (2月只有 28 天时)。这正是 SQLite 的行为。
 */
func addMonths(jdMs: Int64, months: Int64): Int64 {
    let c = jdMillisToCivil(jdMs)
    var totalMonths = c.year * 12 + (c.month - 1) + months
    c.year = floorDiv(totalMonths, 12)
    c.month = totalMonths - c.year * 12 + 1
    civilToJdMillis(c)
}

/*
 * strftime 格式化。
 */

/**
 * 支持的转换符: %d %e %f %F %H %I %j %J %k %l %m %M %p %P %s %S %T %u %w %W %y %Y %%。
 *
 * 未知转换符原样输出 (含 %), 与 SQLite 一致 —— 报错会让一个拼错的格式串使整条查询失败,
 * 而原样输出能在结果里直接看出拼错了什么。
 */
func applyStrftime(format: String, jdMs: Int64): String {
    let c = jdMillisToCivil(jdMs)
    let runes = toRuneArray(format)
    let sb = StringBuilder()
    var i = 0
    while (i < runes.size) {
        if (runes[i] != r'%') {
            sb.append(runes[i])
            i += 1
            continue
        }
        i += 1
        if (i >= runes.size) {
            sb.append(r'%')
            break
        }
        let conv = runes[i]
        i += 1
        sb.append(strftimeOne(conv, c, jdMs))
    }
    sb.toString()
}

func strftimeOne(conv: Rune, c: CivilTime, jdMs: Int64): String {
    match (conv) {
        case r'%' => "%"
        case r'd' => padLeftZeros(c.day, 2)
        case r'e' => "${c.day}"
        // %f 是"秒.毫秒", 三位小数; SQLite 给的是 SS.SSS。
        case r'f' => "${padLeftZeros(c.second, 2)}.${padLeftZeros(c.millis, 3)}"
        case r'F' => formatDatePart(c)
        case r'H' => padLeftZeros(c.hour, 2)
        case r'I' => padLeftZeros(hour12Of(c.hour), 2)
        case r'j' => padLeftZeros(dayOfYearFrom(c), 3)
        case r'J' => formatReal(Float64(jdMs) / Float64(MILLIS_PER_DAY))
        case r'k' => "${c.hour}"
        case r'l' => "${hour12Of(c.hour)}"
        case r'm' => padLeftZeros(c.month, 2)
        case r'M' => padLeftZeros(c.minute, 2)
        case r'p' =>
            if (c.hour < 12) {
                "AM"
            } else {
                "PM"
            }
        case r'P' =>
            if (c.hour < 12) {
                "am"
            } else {
                "pm"
            }
        case r's' => "${floorDiv(jdMillisToUnixMillis(jdMs), 1000)}"
        case r'S' => padLeftZeros(c.second, 2)
        case r'T' => formatTimePart(c)
        // %u 是 ISO 星期 (1 = 周一, 7 = 周日); %w 是 0 = 周日。两者差一位, 混用会错一天。
        case r'u' =>
            let w = dayOfWeekFrom(jdMs)
            "${if (w == 0) { 7 } else { w }}"
        case r'w' => "${dayOfWeekFrom(jdMs)}"
        case r'W' => padLeftZeros(weekOfYear(c, jdMs), 2)
        case r'y' =>
            let y = c.year % 100
            padLeftZeros(if (y < 0) {
                y + 100
            } else {
                y
            }, 2)
        case r'Y' => "${c.year}"
        case _ => "%${conv}"
    }
}

func hour12Of(hour: Int64): Int64 {
    let h = hour % 12
    if (h == 0) {
        12
    } else {
        h
    }
}

/** %W: 以周日为周首、第一个周日之前算第 0 周。 */
func weekOfYear(c: CivilTime, jdMs: Int64): Int64 {
    let doy = dayOfYearFrom(c)
    let dow = dayOfWeekFrom(jdMs)
    (doy + 6 - dow) / 7
}

func formatDatePart(c: CivilTime): String {
    // 年份补到 4 位; 负年份保留符号。
    let yearText = if (c.year < 0) {
        "-${padLeftZeros(-c.year, 4)}"
    } else {
        padLeftZeros(c.year, 4)
    }
    "${yearText}-${padLeftZeros(c.month, 2)}-${padLeftZeros(c.day, 2)}"
}

func formatTimePart(c: CivilTime): String {
    "${padLeftZeros(c.hour, 2)}:${padLeftZeros(c.minute, 2)}:${padLeftZeros(c.second, 2)}"
}

/** DateTime → SQLite 惯用文本，保留 DateTime 自带时区下的本地字段。 */
public func formatDateTimeForSqlite(dt: DateTime): String {
    dt.format("yyyy-MM-dd HH:mm:ss")
}
