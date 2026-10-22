package sqlite_driver

import std.collection.*

/*
 * SQL 词法分析。
 *
 * 每个 token 都带原文里的字节偏移。这不是为了报错好看, 而是为了修一个具体缺陷:
 * 旧 parser 遇到不认识的词就停下, 由收尾统一报"不支持多语句", 于是写 LIKE 的人被指引
 * 去查分号。有了偏移, 报错才能指向真正错的位置。
 *
 * 关键字不单独设 token 种类: SQLite 里多数关键字是非保留的 (可以当列名), 把它们变成
 * 独立种类会让 parser 到处判"这个位置的 ORDER 是关键字还是列名"。统一按标识符出,
 * 由 parser 按上下文比较文本。
 */
enum TokenKind {
    | TkIdent // 标识符或关键字
    | TkQuotedIdent // "x" / `x` / [x] —— 一定是标识符, 不可能是关键字
    | TkString // 'x'
    | TkBlob // x'FF'
    | TkInteger
    | TkReal
    | TkPunct // 运算符与标点
    | TkParam // ? / ?N / :name / @name / $name
    | TkEof
}

struct Token {
    let kind: TokenKind
    /** 原文文本; 字符串/标识符已去掉引号并处理过转义。 */
    let text: String
    /** 在原 SQL 中的字节偏移。 */
    let pos: Int64
    /**
     * 原文里的原始拼写, 引号标识符**连引号一起**保留; 其余 token 与 text 相同。
     *
     * 窗口名按 token 原文比较，而不是按去除引号后的名称比较。不同引号形式彼此不等价，
     * 因此需要保留原始拼写供窗口名称解析使用。
     */
    let raw: String

    init(kind: TokenKind, text: String, pos: Int64) {
        this.kind = kind
        this.text = text
        this.pos = pos
        this.raw = text
    }

    init(kind: TokenKind, text: String, pos: Int64, raw: String) {
        this.kind = kind
        this.text = text
        this.pos = pos
        this.raw = raw
    }
}

func isKind(t: Token, k: TokenKind): Bool {
    match ((t.kind, k)) {
        case (TkIdent, TkIdent) => true
        case (TkQuotedIdent, TkQuotedIdent) => true
        case (TkString, TkString) => true
        case (TkBlob, TkBlob) => true
        case (TkInteger, TkInteger) => true
        case (TkReal, TkReal) => true
        case (TkPunct, TkPunct) => true
        case (TkParam, TkParam) => true
        case (TkEof, TkEof) => true
        case _ => false
    }
}

/** token 是不是"能当标识符用"的形态。 */
func isIdentLike(t: Token): Bool {
    isKind(t, TokenKind.TkIdent) || isKind(t, TokenKind.TkQuotedIdent)
}

class Lexer {
    private let src: Array<Byte>
    private let text: String
    private var pos: Int64 = 0

    init(sql: String) {
        this.text = sql
        this.src = sql.toArray()
    }

    /** 把整条 SQL 切成 token 列表, 末尾附一个 TkEof。 */
    func tokenize(): ArrayList<Token> {
        let out = ArrayList<Token>()
        while (true) {
            let t = nextToken()
            out.add(t)
            if (isKind(t, TokenKind.TkEof)) {
                break
            }
        }
        out
    }

    private func peekByte(offset: Int64): Int64 {
        let p = pos + offset
        if (p >= src.size) {
            -1
        } else {
            Int64(src[p])
        }
    }

    private func skipWhitespaceAndComments(): Unit {
        while (pos < src.size) {
            let c = Int64(src[pos])
            if (c == 32 || c == 9 || c == 10 || c == 13 || c == 12) {
                pos += 1
                continue
            }
            // 行注释 --
            if (c == 45 && peekByte(1) == 45) {
                pos += 2
                while (pos < src.size && src[pos] != UInt8(b'\n')) {
                    pos += 1
                }
                continue
            }
            // 块注释 /* */ ; 未闭合时按 SQLite 的做法吃到末尾而不报错。
            if (c == 47 && peekByte(1) == 42) {
                pos += 2
                while (pos < src.size) {
                    if (src[pos] == UInt8(b'*') && peekByte(1) == 47) {
                        pos += 2
                        break
                    }
                    pos += 1
                }
                continue
            }
            break
        }
    }

    private func nextToken(): Token {
        skipWhitespaceAndComments()
        if (pos >= src.size) {
            return Token(TokenKind.TkEof, "", pos)
        }
        let start = pos
        let c = Int64(src[pos])

        // x'...' blob 字面量 (要在标识符之前判, 否则 x 会被当成列名)。
        if ((c == 120 || c == 88) && peekByte(1) == 39) {
            return lexBlob(start)
        }
        if (isIdentStart(c)) {
            return lexIdent(start)
        }
        if (c >= 48 && c <= 57) {
            return lexNumber(start)
        }
        if (c == 46 && peekByte(1) >= 48 && peekByte(1) <= 57) {
            return lexNumber(start)
        }
        if (c == 39) {
            return lexString(start)
        }
        if (c == 34) {
            return lexDelimitedIdent(start, 34, 34)
        }
        if (c == 96) {
            return lexDelimitedIdent(start, 96, 96)
        }
        if (c == 91) {
            return lexDelimitedIdent(start, 91, 93)
        }
        if (c == 63 || c == 58 || c == 64 || c == 36) {
            return lexParam(start)
        }
        lexPunct(start)
    }

    private func isIdentStart(c: Int64): Bool {
        // 允许 128 以上的字节直接进标识符: UTF-8 的多字节序列在 SQLite 里可以当标识符,
        // 而按字节判定就够 —— 我们只需切分, 不需理解字符。
        (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95 || c >= 128
    }

    private func isIdentPart(c: Int64): Bool {
        isIdentStart(c) || (c >= 48 && c <= 57) || c == 36
    }

    private func lexIdent(start: Int64): Token {
        while (pos < src.size && isIdentPart(Int64(src[pos]))) {
            pos += 1
        }
        Token(TokenKind.TkIdent, sliceText(start, pos), start)
    }

    /** 引号标识符。SQLite 里 "" / `` / [] 三种都合法; [] 内部不支持转义。 */
    private func lexDelimitedIdent(start: Int64, open: Int64, close: Int64): Token {
        pos += 1
        let sb = StringBuilder()
        while (true) {
            if (pos >= src.size) {
                throw SqliteSyntaxException("unterminated quoted identifier", start)
            }
            let c = Int64(src[pos])
            if (c == close) {
                // "" 是转义的一个引号 (仅当开闭同字符时成立)。
                if (open == close && peekByte(1) == close) {
                    sb.append(byteToString(src[pos]))
                    pos += 2
                    continue
                }
                pos += 1
                break
            }
            sb.append(byteToString(src[pos]))
            pos += 1
        }
        Token(TokenKind.TkQuotedIdent, sb.toString(), start, sliceText(start, pos))
    }

    private func lexString(start: Int64): Token {
        pos += 1
        let sb = StringBuilder()
        while (true) {
            if (pos >= src.size) {
                throw SqliteSyntaxException("unterminated string literal", start)
            }
            let c = Int64(src[pos])
            if (c == 39) {
                if (peekByte(1) == 39) {
                    // '' 是转义的单引号。SQL 里没有反斜杠转义 —— 加上它会让
                    // 'C:\path\' 这类字面量被吃掉结尾引号。
                    sb.append("'")
                    pos += 2
                    continue
                }
                pos += 1
                break
            }
            sb.append(byteToString(src[pos]))
            pos += 1
        }
        Token(TokenKind.TkString, sb.toString(), start)
    }

    private func lexBlob(start: Int64): Token {
        pos += 2
        let sb = StringBuilder()
        while (true) {
            if (pos >= src.size) {
                throw SqliteSyntaxException("unterminated blob literal", start)
            }
            let c = Int64(src[pos])
            if (c == 39) {
                pos += 1
                break
            }
            if (!isHexDigit(c)) {
                throw SqliteSyntaxException("blob literals may contain only hex digits", pos)
            }
            sb.append(byteToString(src[pos]))
            pos += 1
        }
        let hex = sb.toString()
        if (hex.size % 2 != 0) {
            throw SqliteSyntaxException("blob literal must have an even number of hex digits", start)
        }
        Token(TokenKind.TkBlob, hex, start)
    }

    private func lexNumber(start: Int64): Token {
        // 十六进制整数 0x...
        if (Int64(src[pos]) == 48 && (peekByte(1) == 120 || peekByte(1) == 88)) {
            pos += 2
            let hexStart = pos
            while (pos < src.size && isHexDigit(Int64(src[pos]))) {
                pos += 1
            }
            if (pos == hexStart) {
                throw SqliteSyntaxException("hex integer literal has no digits", start)
            }
            return Token(TokenKind.TkInteger, sliceText(start, pos), start)
        }
        var isReal = false
        while (pos < src.size && Int64(src[pos]) >= 48 && Int64(src[pos]) <= 57) {
            pos += 1
        }
        if (pos < src.size && Int64(src[pos]) == 46) {
            isReal = true
            pos += 1
            while (pos < src.size && Int64(src[pos]) >= 48 && Int64(src[pos]) <= 57) {
                pos += 1
            }
        }
        if (pos < src.size && (Int64(src[pos]) == 101 || Int64(src[pos]) == 69)) {
            let save = pos
            pos += 1
            if (pos < src.size && (Int64(src[pos]) == 43 || Int64(src[pos]) == 45)) {
                pos += 1
            }
            var digits = 0
            while (pos < src.size && Int64(src[pos]) >= 48 && Int64(src[pos]) <= 57) {
                pos += 1
                digits += 1
            }
            if (digits == 0) {
                // 不是指数, 而是紧跟的标识符 (如 1e 后面接别的) —— 回退。
                pos = save
            } else {
                isReal = true
            }
        }
        let kind = if (isReal) {
            TokenKind.TkReal
        } else {
            TokenKind.TkInteger
        }
        Token(kind, sliceText(start, pos), start)
    }

    private func lexParam(start: Int64): Token {
        let lead = Int64(src[pos])
        pos += 1
        if (lead == 63) {
            // ?N 形式
            while (pos < src.size && Int64(src[pos]) >= 48 && Int64(src[pos]) <= 57) {
                pos += 1
            }
            return Token(TokenKind.TkParam, sliceText(start, pos), start)
        }
        while (pos < src.size && isIdentPart(Int64(src[pos]))) {
            pos += 1
        }
        if (pos == start + 1) {
            throw SqliteSyntaxException("named parameter has no name after '${byteToString(src[start])}'", start)
        }
        Token(TokenKind.TkParam, sliceText(start, pos), start)
    }

    /**
     * 按字节比较一个 ASCII 运算符字面量。
     *
     * 不能再用 `sliceText(pos, pos + 2/3)` 解码后再比: SQL 里「标点紧跟多字节字符」
     * 是极常见的写法 (`INSERT INTO t (name) VALUES ('中文')` 里的 `(` 紧跟 `'中文'`)，
     * 而按固定字节数切出来的 slice 会落在字符中间，`String.fromUtf8` 直接抛
     * `Invalid utf8 byte sequence`——于是整条含中文的 INSERT / CREATE / length()
     * 都解析不了，报错却只指向词法器，与真正的原因(中文)毫无关系。
     */
    private func matchAsciiBytes(at: Int64, lit: String): Bool {
        let bs = lit.toArray()
        if (at + Int64(bs.size) > src.size) {
            return false
        }
        var i = 0
        while (i < bs.size) {
            if (src[at + Int64(i)] != bs[i]) {
                return false
            }
            i += 1
        }
        true
    }

    private func lexPunct(start: Int64): Token {
        // JSON 箭头是三字符/双字符运算符，必须在普通双字符运算符前识别。
        if (matchAsciiBytes(pos, "->>")) {
            pos += 3
            return Token(TokenKind.TkPunct, "->>", start)
        }
        // 双字符运算符优先。
        for (op in ["<=", ">=", "<>", "==", "!=", "||", "<<", ">>", "->"]) {
            if (matchAsciiBytes(pos, op)) {
                pos += 2
                return Token(TokenKind.TkPunct, op, start)
            }
        }
        let c = Int64(src[pos])
        // 单字节标点: 只在确认是 ASCII 之后再切片, 保证不会切到字符中间。
        if (c < 128) {
            let one = sliceText(pos, pos + 1)
            if ("+-*/%(),.;<>=~&|".contains(one)) {
                pos += 1
                return Token(TokenKind.TkPunct, one, start)
            }
        }
        if (c == 33) {
            throw SqliteSyntaxException("'!' must be part of '!='", start)
        }
        throw SqliteSyntaxException("unrecognized character '${describeAt(pos)}'", start)
    }

    /** 报错信息要能显示中文; 整条字符解码失败时退回字节值, 报错路径自身不再抛异常。 */
    private func describeAt(at: Int64): String {
        if (at >= src.size) {
            return "<eof>"
        }
        let lead = Int64(src[at])
        var len: Int64 = 1
        if (lead >= 240) {
            len = 4
        } else if (lead >= 224) {
            len = 3
        } else if (lead >= 192) {
            len = 2
        }
        if (at + len <= src.size) {
            try {
                return String.fromUtf8(src[at..at + len])
            } catch (e: Exception) {
                ()
            }
        }
        "<byte ${lead}>"
    }

    private func sliceText(from: Int64, to: Int64): String {
        String.fromUtf8(src[from..to])
    }
}

func isHexDigit(c: Int64): Bool {
    (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
}

func byteToString(b: Byte): String {
    let one = Array<Byte>(1, repeat: b)
    // 单字节可能是 UTF-8 多字节序列的一部分, 直接解会抛。unsafe 的
    // fromUtf8Unchecked 在这里是正确选择: 逐字节拼回去时整体序列仍是合法 UTF-8,
    // 只有中间态不合法, 而 StringBuilder 不校验中间态。
    unsafe {
        String.fromUtf8Unchecked(one)
    }
}

/** 十六进制文本转字节数组, 供 blob 字面量使用。 */
func hexToBytes(hex: String): Array<Byte> {
    let bs = hex.toArray()
    let out = Array<Byte>(bs.size / 2, repeat: 0)
    for (i in 0..out.size) {
        out[i] = UInt8(hexDigitValue(Int64(bs[i * 2])) * 16 + hexDigitValue(Int64(bs[i * 2 + 1])))
    }
    out
}

func hexDigitValue(c: Int64): Int64 {
    if (c >= 48 && c <= 57) {
        return c - 48
    }
    if (c >= 97 && c <= 102) {
        return c - 97 + 10
    }
    if (c >= 65 && c <= 70) {
        return c - 65 + 10
    }
    throw SqliteSyntaxException("invalid hex digit", 0)
}
