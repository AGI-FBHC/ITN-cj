package itn_spire

import std.core.*
import std.collection.*
import std.convert.*

/*
 * Emulates CPython json.JSONDecodeError so FastAPI can answer a malformed
 * request body the way routing.py does (fastapi/routing.py, the
 * `except json.JSONDecodeError as e` block):
 *
 *   {"detail":[{"type":"json_invalid","loc":["body",<e.pos>],
 *               "msg":"JSON decode error","input":{},
 *               "ctx":{"error":<e.msg>}}]}
 *
 * `msg` and `pos` are the two values that reach the wire, so both are
 * reproduced from the stdlib decoder's own rules:
 *
 *   decode(s)      = raw_decode(skip_ws(s,0)); end=skip_ws(end);
 *                    end != len(s) -> ("Extra data", end)
 *   raw_decode     = scan_once at idx; StopIteration(idx) -> ("Expecting value", idx)
 *   scan_once      dispatch on first char:  " -> string, { -> object, [ -> array,
 *                    -|digit -> number, t/f/n -> literal prefix, else Expecting value
 *   object loop    key must be ", then :, then a value, then , or }
 *   array loop     value, then , or ]
 *   number         -?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?   — matches greedily and
 *                    STOPS at the first non-matching char (that is why "01" and
 *                    "1." are "Extra data", not "Expecting value")
 *   string         unterminated -> ("Unterminated string starting at", <quote pos>)
 *                    bad \esc -> ("Invalid \\escape", <backslash pos>)
 *                    bad \uHHHH -> ("Invalid \\uXXXX escape", <u pos>)
 *                    raw control char -> ("Invalid control character at", <pos>)
 *
 * Positions are code-point offsets (Python `str` indices), so the scanner walks
 * an Array<Rune> rather than bytes — "Extra data" on '"中文" x' is 5, not 8.
 *
 * Verified against Python 3.9 / fastapi 0.115.6 / pydantic 2.10.4 over the
 * 104-entry battery in tmp_verify/fastapi_ref_presentations.py (`json_errors`).
 */

public struct PyJsonError {
    public let msg: String
    public let pos: Int64
    public init(msg: String, pos: Int64) {
        this.msg = msg
        this.pos = pos
    }
}

private func isPyWs(c: Rune): Bool {
    let v = runeCode(c)
    return v == 0x20 || v == 0x09 || v == 0x0a || v == 0x0d
}

private func isPyDigit(c: Rune): Bool {
    let v = runeCode(c)
    return v >= 0x30 && v <= 0x39
}

private func isPyHex(c: Rune): Bool {
    let v = runeCode(c)
    return (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x46) || (v >= 0x61 && v <= 0x66)
}

class PyJsonScanner {
    let rs: Array<Rune>
    let n: Int64
    var i: Int64

    init(text: String) {
        this.rs = text.toRuneArray()
        this.n = this.rs.size
        this.i = 0
    }

    func err(msg: String, pos: Int64): ?PyJsonError {
        return Some(PyJsonError(msg, pos))
    }

    func at(k: Int64, code: Int64): Bool {
        if (k < 0 || k >= n) {
            return false
        }
        return runeCode(rs[k]) == code
    }

    /* Literal prefix check, byte-for-byte the way CPython memcmp's it. */
    func atWord(word: String): Bool {
        let wr = word.toRuneArray()
        if (i + wr.size > n) {
            return false
        }
        var k: Int64 = 0
        while (k < wr.size) {
            if (runeCode(rs[i + k]) != runeCode(wr[k])) {
                return false
            }
            k += 1
        }
        return true
    }

    func skipWs() {
        while (i < n && isPyWs(rs[i])) {
            i += 1
        }
    }

    /* Whole-document decode. None == json.loads succeeded. */
    func decode(): ?PyJsonError {
        skipWs()
        match (scanValue()) {
            case Some(e) => return Some(e)
            case None => ()
        }
        skipWs()
        if (i != n) {
            return err("Extra data", i)
        }
        return None
    }

    func scanValue(): ?PyJsonError {
        if (i >= n) {
            return err("Expecting value", i)
        }
        let v = runeCode(rs[i])
        if (v == 0x22) {                 /* '"' */
            return scanString()
        }
        if (v == 0x7b) {                 /* '{' */
            return scanObject()
        }
        if (v == 0x5b) {                 /* '[' */
            return scanArray()
        }
        if (v == 0x2d || isPyDigit(rs[i])) {   /* '-' or digit */
            return scanNumber()
        }
        if (v == 0x74) {                 /* 't' */
            if (atWord("true")) {
                i += 4
                return None
            }
            return err("Expecting value", i)
        }
        if (v == 0x66) {                 /* 'f' */
            if (atWord("false")) {
                i += 5
                return None
            }
            return err("Expecting value", i)
        }
        if (v == 0x6e) {                 /* 'n' */
            if (atWord("null")) {
                i += 4
                return None
            }
            return err("Expecting value", i)
        }
        return err("Expecting value", i)
    }

    /*
     * i sits on the opening quote. On success i is just past the closing one.
     * "start" is remembered because an unterminated string is reported at the
     * quote, not at the point scanning stopped.
     */
    func scanString(): ?PyJsonError {
        let start = i
        i += 1
        while (true) {
            if (i >= n) {
                return err("Unterminated string starting at", start)
            }
            let v = runeCode(rs[i])
            if (v == 0x22) {
                i += 1
                return None
            }
            if (v == 0x5c) {             /* backslash */
                if (i + 1 >= n) {
                    return err("Unterminated string starting at", start)
                }
                let ev = runeCode(rs[i + 1])
                if (ev == 0x75) {        /* 'u' — exactly four hex digits */
                    var k = i + 2
                    var bad = false
                    var seen: Int64 = 0
                    while (seen < 4) {
                        if (k >= n || !isPyHex(rs[k])) {
                            bad = true
                            break
                        }
                        k += 1
                        seen += 1
                    }
                    if (bad) {
                        return err("Invalid \\uXXXX escape", i + 1)
                    }
                    i = k
                    continue
                }
                if (ev == 0x22 || ev == 0x5c || ev == 0x2f || ev == 0x62 ||
                    ev == 0x66 || ev == 0x6e || ev == 0x72 || ev == 0x74) {
                    i += 2
                    continue
                }
                return err("Invalid \\escape", i)
            }
            if (v < 0x20) {
                return err("Invalid control character at", i)
            }
            i += 1
        }
        return err("Unterminated string starting at", start)
    }

    /*
     * Greedy JSON number. A rejected fraction/exponent is NOT an error: the
     * match simply ends before it, so "01" -> 0 + Extra data, "1." -> 1 +
     * Extra data, "1e" -> 1 + Extra data — all confirmed by the oracle.
     */
    func scanNumber(): ?PyJsonError {
        let start = i
        if (runeCode(rs[i]) == 0x2d) {
            i += 1
        }
        if (i >= n) {
            return err("Expecting value", start)
        }
        if (runeCode(rs[i]) == 0x30) {   /* '0' may not be followed by more digits */
            i += 1
        } else {
            if (!isPyDigit(rs[i])) {
                return err("Expecting value", start)
            }
            while (i < n && isPyDigit(rs[i])) {
                i += 1
            }
        }
        if (i < n && runeCode(rs[i]) == 0x2e) {    /* '.' */
            let save = i
            i += 1
            if (i >= n || !isPyDigit(rs[i])) {
                i = save
            } else {
                while (i < n && isPyDigit(rs[i])) {
                    i += 1
                }
            }
        }
        if (i < n && (runeCode(rs[i]) == 0x65 || runeCode(rs[i]) == 0x45)) {   /* e E */
            let save = i
            i += 1
            if (i < n && (runeCode(rs[i]) == 0x2b || runeCode(rs[i]) == 0x2d)) {
                i += 1
            }
            if (i >= n || !isPyDigit(rs[i])) {
                i = save
            } else {
                while (i < n && isPyDigit(rs[i])) {
                    i += 1
                }
            }
        }
        return None
    }

    func scanObject(): ?PyJsonError {
        i += 1                     /* '{' */
        skipWs()
        if (i >= n) {
            return err("Expecting property name enclosed in double quotes", i)
        }
        if (runeCode(rs[i]) == 0x7d) {   /* '}' */
            i += 1
            return None
        }
        while (true) {
            skipWs()
            if (i >= n || runeCode(rs[i]) != 0x22) {
                return err("Expecting property name enclosed in double quotes", i)
            }
            match (scanString()) {
                case Some(e) => return Some(e)
                case None => ()
            }
            skipWs()
            if (i >= n || runeCode(rs[i]) != 0x3a) {   /* ':' */
                return err("Expecting ':' delimiter", i)
            }
            i += 1
            skipWs()
            match (scanValue()) {
                case Some(e) => return Some(e)
                case None => ()
            }
            skipWs()
            if (i >= n) {
                return err("Expecting ',' delimiter", i)
            }
            let v = runeCode(rs[i])
            if (v == 0x2c) {           /* ',' */
                i += 1
                continue
            }
            if (v == 0x7d) {           /* '}' */
                i += 1
                return None
            }
            return err("Expecting ',' delimiter", i)
        }
        return err("Expecting property name enclosed in double quotes", i)
    }

    func scanArray(): ?PyJsonError {
        i += 1                     /* '[' */
        skipWs()
        if (i >= n) {
            return err("Expecting value", i)
        }
        if (runeCode(rs[i]) == 0x5d) {   /* ']' */
            i += 1
            return None
        }
        while (true) {
            skipWs()
            match (scanValue()) {
                case Some(e) => return Some(e)
                case None => ()
            }
            skipWs()
            if (i >= n) {
                return err("Expecting ',' delimiter", i)
            }
            let v = runeCode(rs[i])
            if (v == 0x2c) {           /* ',' */
                i += 1
                continue
            }
            if (v == 0x5d) {           /* ']' */
                i += 1
                return None
            }
            return err("Expecting ',' delimiter", i)
        }
        return err("Expecting value", i)
    }
}

/*
 * None when `text` is exactly what json.loads would accept.
 * Used only for request bodies that FastAPI has already declared JSON.
 */
public func pyJsonDecodeError(text: String): ?PyJsonError {
    let sc = PyJsonScanner(text)
    return sc.decode()
}
