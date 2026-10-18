package sqlite_driver

import std.collection.*

/*
 * LIKE 与 GLOB 的模式匹配。
 *
 * 两者的差别不只是通配符不同:
 *   LIKE  `%` 任意串、`_` 任意单字符, **大小写不敏感** (仅 ASCII), 可带 ESCAPE
 *   GLOB  `*` 任意串、`?` 任意单字符、`[abc]` 字符组, **大小写敏感**, 无 ESCAPE
 * 把 LIKE 做成大小写敏感是最容易犯的错, 且症状是"漏行"而不是报错。
 *
 * 实现按**字符** (Rune) 而不是字节匹配: `_` 要匹配一个完整的多字节字符, 按字节会把
 * 一个汉字当成三个字符。
 */
func evalLike(ctx: EvalContext, e: LikeExpr): SqliteValue {
    let target = evalExpr(ctx, e.target)
    let pattern = evalExpr(ctx, e.pattern)
    match ((target, pattern)) {
        case (SNull, _) => return SqliteValue.SNull
        case (_, SNull) => return SqliteValue.SNull
        case _ => ()
    }
    var escape: Option<Rune> = None
    if (let Some(escExpr) <- e.escape) {
        let escVal = evalExpr(ctx, escExpr)
        match (escVal) {
            case SNull => return SqliteValue.SNull
            case _ =>
                let text = valueToText(escVal)
                let runes = toRuneArray(text)
                if (runes.size != 1) {
                    throw SqliteRuntimeException("sql", "ESCAPE expression must be a single character")
                }
                escape = Some(runes[0])
        }
    }
    let subject = valueToText(target)
    let pat = valueToText(pattern)
    let matched = if (e.glob) {
        globMatch(toRuneArray(subject), 0, toRuneArray(pat), 0)
    } else {
        likeMatch(toRuneArray(lowerAscii(subject)), 0, toRuneArray(lowerAscii(pat)), 0, escape)
    }
    boolToValue(if (e.negated) {
        !matched
    } else {
        matched
    })
}

/** ASCII 范围内转小写。LIKE 的大小写不敏感在 SQLite 里只覆盖 ASCII。 */
func lowerAscii(s: String): String {
    s.toAsciiLower()
}

func toRuneArray(s: String): Array<Rune> {
    let list = ArrayList<Rune>()
    for (r in s.runes()) {
        list.add(r)
    }
    list.toArray()
}

/**
 * LIKE 匹配。
 *
 * 递归回溯而不是 DP: 模式串通常很短, 而 DP 要按 subject 长度分配矩阵。`%` 处的回溯用
 * 循环展开, 避免 `%%%%%a` 这类模式在长字符串上退化成指数时间。
 */
func likeMatch(subject: Array<Rune>, si: Int64, pattern: Array<Rune>, pi: Int64, escape: Option<Rune>): Bool {
    var s = si
    var p = pi
    // 记住最近一个 `%` 的位置, 失配时回到它并让它多吃一个字符 —— 这把回溯变成 O(n*m)。
    var starP = -1
    var starS = 0
    while (s < subject.size) {
        if (p < pattern.size) {
            let pc = pattern[p]
            var literal = false
            var pcActual = pc
            if (let Some(esc) <- escape) {
                if (pc == esc && p + 1 < pattern.size) {
                    literal = true
                    pcActual = pattern[p + 1]
                }
            }
            if (!literal && pc == r'%') {
                starP = p
                starS = s
                p += 1
                continue
            }
            if (!literal && pc == r'_') {
                s += 1
                p += 1
                continue
            }
            if (pcActual == subject[s]) {
                p += if (literal) {
                    2
                } else {
                    1
                }
                s += 1
                continue
            }
        }
        if (starP >= 0) {
            starS += 1
            s = starS
            p = starP + 1
            continue
        }
        return false
    }
    // subject 用完: 模式剩下的必须全是 `%`。
    while (p < pattern.size && pattern[p] == r'%') {
        p += 1
    }
    p == pattern.size
}

/**
 * GLOB 匹配。通配符是 `*` `?` 与 `[...]` 字符组 (支持 `!` 取反与 `a-z` 区间)。
 */
func globMatch(subject: Array<Rune>, si: Int64, pattern: Array<Rune>, pi: Int64): Bool {
    var s = si
    var p = pi
    var starP = -1
    var starS = 0
    while (s < subject.size) {
        if (p < pattern.size) {
            let pc = pattern[p]
            if (pc == r'*') {
                starP = p
                starS = s
                p += 1
                continue
            }
            if (pc == r'?') {
                s += 1
                p += 1
                continue
            }
            if (pc == r'[') {
                let end = findClassEnd(pattern, p)
                if (end > 0 && matchCharClass(pattern, p + 1, end, subject[s])) {
                    s += 1
                    p = end + 1
                    continue
                }
                if (end > 0) {
                    // 字符组不匹配, 走回溯。
                    if (starP >= 0) {
                        starS += 1
                        s = starS
                        p = starP + 1
                        continue
                    }
                    return false
                }
                // 没有闭合的 `]`: `[` 当普通字符。
            }
            if (pc == subject[s]) {
                s += 1
                p += 1
                continue
            }
        }
        if (starP >= 0) {
            starS += 1
            s = starS
            p = starP + 1
            continue
        }
        return false
    }
    while (p < pattern.size && pattern[p] == r'*') {
        p += 1
    }
    p == pattern.size
}

/** 找字符组的闭合 `]` 位置; 找不到返回 -1。首位的 `]` 是字面量, 不算闭合。 */
func findClassEnd(pattern: Array<Rune>, openAt: Int64): Int64 {
    var i = openAt + 1
    if (i < pattern.size && pattern[i] == r'!') {
        i += 1
    }
    if (i < pattern.size && pattern[i] == r']') {
        i += 1
    }
    while (i < pattern.size) {
        if (pattern[i] == r']') {
            return i
        }
        i += 1
    }
    -1
}

func matchCharClass(pattern: Array<Rune>, from: Int64, to: Int64, c: Rune): Bool {
    var i = from
    var negate = false
    if (i < to && pattern[i] == r'!') {
        negate = true
        i += 1
    }
    var found = false
    while (i < to) {
        // 区间 a-z: 中间的 `-` 且两侧都有字符时才是区间。
        if (i + 2 < to && pattern[i + 1] == r'-') {
            if (c >= pattern[i] && c <= pattern[i + 2]) {
                found = true
            }
            i += 3
            continue
        }
        if (pattern[i] == c) {
            found = true
        }
        i += 1
    }
    if (negate) {
        !found
    } else {
        found
    }
}
