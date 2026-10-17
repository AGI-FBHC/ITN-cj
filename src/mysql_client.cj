package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.net.*
import stdx.crypto.digest.*
import std.time.*

/*
 * Minimal MySQL text-protocol client.
 *
 * Scope: notes module CRUD against itn_platform. Supports
 * mysql_native_password and caching_sha2_password (fast auth only),
 * COM_QUERY with text result sets, and CLIENT_DEPRECATE_EOF.
 *
 * Why not std.database.sql: SDK 1.1.3 ships the SQL abstraction
 * (DriverManager/Datasource) but no MySQL driver is registered and the
 * cjpm repository has no MySQL package. This client fills that gap.
 */
public class MySqlError <: Exception {
    public let code: Int64
    public let sqlState: String
    public let messageText: String

    public init(code: Int64, sqlState: String, messageText: String) {
        super(messageText)
        this.code = code
        this.sqlState = sqlState
        this.messageText = messageText
    }
}

public struct MyOk {
    public let affectedRows: Int64
    public let lastInsertId: Int64

    public init(affectedRows: Int64, lastInsertId: Int64) {
        this.affectedRows = affectedRows
        this.lastInsertId = lastInsertId
    }
}

public class MyResultSet {
    public let columns: Array<String>
    public let columnTypes: Array<UInt8>
    public let rows: Array<Array<MyCell>>

    public init(columns: Array<String>, columnTypes: Array<UInt8>, rows: Array<Array<MyCell>>) {
        this.columns = columns
        this.columnTypes = columnTypes
        this.rows = rows
    }
}

public struct MyCell {
    public let isNull: Bool
    public let bytes: Array<Byte>

    public static func nullCell(): MyCell {
        MyCell(true, Array<Byte>(0, repeat: 0))
    }

    public static func of(bytes: Array<Byte>): MyCell {
        MyCell(false, bytes)
    }

    public init(isNull: Bool, bytes: Array<Byte>) {
        this.isNull = isNull
        this.bytes = bytes
    }

    public func text(): String {
        if (isNull) {
            return ""
        }
        return bytesToString(bytes)
    }

    public func isBinary16(): Bool {
        !isNull && bytes.size == 16
    }
}

public class MyConnection {
    private let socket: TcpSocket
    private var sequence: Int64 = 0
    private var lastSentSeq: Int64 = -1
    private var lastRecvSeq: Int64 = -1

    private init(socket: TcpSocket) {
        this.socket = socket
    }

    public static func connect(host: String, port: UInt16, user: String,
                               password: String, database: String): MyConnection {
        let addr = IPSocketAddress(host, port)
        let socket = TcpSocket(addr)
        /* Constructor only stores the remote address; connect() performs the TCP handshake. */
        socket.connect(timeout: Duration.millisecond * 15000)
        /* Mid-query "read data timeout" flakes on this remote host; 30s covers the
         * slowest matrix queries without hanging a dead connection indefinitely. */
        socket.readTimeout = Duration.millisecond * 30000
        socket.writeTimeout = Duration.millisecond * 30000
        let conn = MyConnection(socket)
        conn.handshake(user, password, database)
        /* Force utf8mb4 for the session so 4-byte runes round-trip.
         * Do not swallow errors — a silent failure leaves the session on utf8mb3. */
        match (conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) =>
                throw MySqlError(0, "HY000", "SET NAMES utf8mb4 returned a result set")
        }
        return conn
    }

    public func close(): Unit {
        try {
            let payload = Array<Byte>(1, repeat: 0x01) /* COM_QUIT */
            writePacket(payload)
            socket.close()
        } catch (_: Exception) {
            try {
                socket.close()
            } catch (_: Exception) {
                ()
            }
        }
    }

    public func query(sql: String): QueryOutcome {
        sequence = 0
        let cmd = ArrayList<Byte>()
        cmd.add(0x03) /* COM_QUERY */
        let sqlBytes = sql.toArray()
        for (b in sqlBytes) {
            cmd.add(b)
        }
        writePacket(cmd.toArray())
        return readQueryResponse()
    }

    /* -------- handshake / auth -------- */

    private func handshake(user: String, password: String, database: String): Unit {
        sequence = 0
        let greeting = readPacket()
        if (greeting.size < 5) {
            throw MySqlError(0, "HY000", "Empty MySQL greeting")
        }
        if (greeting[0] == 0xff) {
            throw parseErr(greeting)
        }
        let scramble = parseGreetingScramble(greeting)
        let plugin = parseGreetingPlugin(greeting)
        let caps = clientCapabilities()
        let response = buildHandshakeResponse(caps, user, password, database, scramble, plugin)
        writePacket(response)
        finishAuth(password, scramble, plugin)
    }

    private func finishAuth(password: String, scramble: Array<Byte>, plugin: String): Unit {
        var currentPlugin = plugin
        var currentScramble = scramble
        var rounds: Int64 = 0
        while (rounds < 5) {
            rounds += 1
            let packet = readPacket()
            if (packet.size == 0) {
                throw MySqlError(0, "HY000", "Empty auth packet")
            }
            let header = packet[0]
            if (header == 0x00) {
                return /* OK */
            }
            if (header == 0xff) {
                throw parseErr(packet)
            }
            if (header == 0xfe && packet.size > 1) {
                /* AuthSwitchRequest */
                var idx: Int64 = 1
                let name = readNullTerminated(packet, idx)
                idx += name.size + 1
                var rest = sliceBytes(packet, idx, packet.size - idx)
                if (rest.size > 0 && rest[rest.size - 1] == 0x00) {
                    rest = sliceBytes(rest, 0, rest.size - 1)
                }
                currentPlugin = name
                currentScramble = rest
                writePacket(authToken(currentPlugin, password, currentScramble))
                continue
            }
            if (header == 0x01) {
                /* AuthMoreData */
                if (packet.size >= 2 && packet[1] == 0x03) {
                    continue /* fast auth success; next packet is OK */
                }
                if (packet.size >= 2 && packet[1] == 0x04) {
                    throw MySqlError(0, "HY000",
                        "caching_sha2_password full authentication is required but this client " +
                        "supports fast auth only. Configure the MySQL user with " +
                        "mysql_native_password, or pre-authenticate the account.")
                }
                continue
            }
            throw MySqlError(0, "HY000", "Unexpected auth packet 0x" + hexByte(header))
        }
        throw MySqlError(0, "HY000", "Authentication did not complete")
    }

    private func clientCapabilities(): UInt32 {
        /* PROTOCOL_41 | SECURE_CONNECTION | CONNECT_WITH_DB | PLUGIN_AUTH | DEPRECATE_EOF */
        0x00000200 | 0x00008000 | 0x00000008 | 0x00080000 | 0x01000000
    }

    private func buildHandshakeResponse(caps: UInt32, user: String, password: String,
                                        database: String, scramble: Array<Byte>,
                                        plugin: String): Array<Byte> {
        let auth = authToken(plugin, password, scramble)
        let out = ArrayList<Byte>()
        appendUInt32(out, caps)
        appendUInt32(out, 0x01000000) /* max packet */
        /* 255 = utf8mb4_0900_ai_ci (MySQL 8 default). 0x21 is utf8mb3 and
         * breaks 4-byte runes with "Illegal mix of collations". */
        out.add(0xff)
        var i: Int64 = 0
        while (i < 23) {
            out.add(0)
            i += 1
        }
        appendNullString(out, user)
        /* CLIENT_SECURE_CONNECTION: 1-byte length then auth response */
        if (auth.size < 251) {
            out.add(UInt8(auth.size))
            for (b in auth) {
                out.add(b)
            }
        } else {
            out.add(0xfc)
            appendUInt16(out, UInt16(auth.size))
            for (b in auth) {
                out.add(b)
            }
        }
        appendNullString(out, database)
        appendNullString(out, plugin)
        return out.toArray()
    }

    private func authToken(plugin: String, password: String, scramble: Array<Byte>): Array<Byte> {
        if (password.isEmpty()) {
            return Array<Byte>(0, repeat: 0)
        }
        if (plugin == "caching_sha2_password") {
            return cachingSha2Token(password, scramble)
        }
        /* default: mysql_native_password */
        return nativePasswordToken(password, scramble)
    }

    /* -------- packets -------- */

    private func writePacket(payload: Array<Byte>): Unit {
        let header = ArrayList<Byte>()
        appendUInt24(header, UInt32(payload.size))
        let seqByte = sequence & 0xff
        lastSentSeq = seqByte
        header.add(int64ToByte(seqByte))
        sequence = (sequence + 1) & 0xff
        var all = header.toArray()
        all = concatBytes(all, payload)
        socket.write(all)
    }

    private func readPacket(): Array<Byte> {
        let header = readExact(4)
        let b0 = byteToInt(header[0]) & 0xff
        let b1 = byteToInt(header[1]) & 0xff
        let b2 = byteToInt(header[2]) & 0xff
        let len = b0 | (b1 << 8) | (b2 << 16)
        lastRecvSeq = byteToInt(header[3])
        /* Next packet we send must be incoming sequence + 1. */
        sequence = (byteToInt(header[3]) + 1) & 0xff
        return readExact(len)
    }

    private func readExact(n: Int64): Array<Byte> {
        let out = Array<Byte>(n, repeat: 0)
        var got: Int64 = 0
        while (got < n) {
            let m = socket.read(out.slice(got, n - got))
            if (m <= 0) {
                throw MySqlError(0, "HY000", "Connection closed by MySQL server")
            }
            got += m
        }
        return out
    }

    /* -------- response parsing -------- */

    private func readQueryResponse(): QueryOutcome {
        let packet = readPacket()
        if (packet.size == 0) {
            throw MySqlError(0, "HY000", "Empty query response")
        }
        let header = packet[0]
        if (header == 0x00) {
            return QueryOutcome.Ok(parseOk(packet))
        }
        if (header == 0xff) {
            throw parseErr(packet)
        }
        if (header == 0xfb) {
            /* LOCAL INFILE — not supported */
            throw MySqlError(0, "HY000", "LOCAL INFILE is not supported")
        }
        let countResult = readLenencIntAt(packet, 0)
        let columnCount = countResult.value
        let columns = ArrayList<String>()
        let types = ArrayList<UInt8>()
        var i: Int64 = 0
        while (i < columnCount) {
            let col = readPacket()
            let parsed = parseColumnDefinition(col)
            columns.add(parsed[0])
            /* parsed[1] is colType as string; parse back to UInt8 */
            match (Int64.tryParse(parsed[1])) {
                case Some(t) =>
                    types.add(UInt8(t))
                case None => types.add(0)
            }
            i += 1
        }
        /* With CLIENT_DEPRECATE_EOF rows follow, terminated by OK. */
        let rows = ArrayList<Array<MyCell>>()
        while (true) {
            let rowPacket = readPacket()
            if (rowPacket.size == 0) {
                continue
            }
            let h = rowPacket[0]
            if (h == 0xfe && rowPacket.size < 9) {
                break /* EOF (older server) */
            }
            /* A real OK packet is >= 7 bytes (header + lenenc affected_rows +
             * lenenc last_insert_id + 2 status + 2 warnings). A 1-column row
             * whose value is the empty string is exactly [0x00] — that used to
             * be eaten as the terminator, which made e.g. the DELETE probe
             * (SELECT output_path ... where output_path='') look row-less. */
            if (h == 0x00 && rowPacket.size >= 7 && rowPacket.size < 9
                && !looksLikeRow(rowPacket)) {
                break /* OK terminator under DEPRECATE_EOF */
            }
            if (h == 0xff) {
                throw parseErr(rowPacket)
            }
            rows.add(parseTextRow(rowPacket, columnCount))
        }
        return QueryOutcome.ResultSet(MyResultSet(columns.toArray(), types.toArray(), rows.toArray()))
    }

    private func looksLikeRow(packet: Array<Byte>): Bool {
        /* OK packet after rows is short and starts with 0x00; a row's first
           cell is a length-encoded string which is rarely a bare 0x00. */
        packet.size >= 5 && (packet[0] != 0x00 || packet[1] != 0x00)
    }

    private func parseOk(packet: Array<Byte>): MyOk {
        var idx: Int64 = 1
        let a = readLenencIntAt(packet, idx)
        let affected = a.value
        idx = a.nextIndex
        let b = readLenencIntAt(packet, idx)
        let lastId = b.value
        return MyOk(affected, lastId)
    }

    private func parseErr(packet: Array<Byte>): MySqlError {
        let b1 = byteToInt(packet[1]) & 0xff
        let b2 = byteToInt(packet[2]) & 0xff
        let code = b1 | (b2 << 8)
        var state = "HY000"
        var msgStart: Int64 = 3
        if (packet.size > 9 && byteToInt(packet[3]) == 35) { /* '#' = 35 */
            state = bytesToString(sliceBytes(packet, 4, 5))
            msgStart = 9
        }
        let msg = bytesToString(sliceBytes(packet, msgStart, packet.size - msgStart))
        return MySqlError(code, state, "seq s=" + lastSentSeq.toString() + " r=" + lastRecvSeq.toString() + " " + msg)
    }

    private func parseColumnDefinition(packet: Array<Byte>): Array<String> {
        var idx: Int64 = 0
        /* catalog, schema, table, org_table */
        var r = readLenencStringAt(packet, idx)
        idx = r.nextIndex
        r = readLenencStringAt(packet, idx)
        idx = r.nextIndex
        r = readLenencStringAt(packet, idx)
        idx = r.nextIndex
        r = readLenencStringAt(packet, idx)
        idx = r.nextIndex
        /* name */
        let name = readLenencStringAt(packet, idx)
        idx = name.nextIndex
        r = readLenencStringAt(packet, idx) /* org_name */
        idx = r.nextIndex
        /* fixed fields length */
        let fl = readLenencIntAt(packet, idx)
        idx = fl.nextIndex
        /* charset(2) column_length(4) type(1) flags(2) decimals(1) filler(2) */
        var colType: UInt8 = 0
        if (idx + 9 <= packet.size) {
            colType = packet[idx + 6]
        }
        let result = ArrayList<String>()
        result.add(bytesToString(name.bytes))
        result.add(colType.toString())
        return result.toArray()
    }

    private func parseTextRow(packet: Array<Byte>, columnCount: Int64): Array<MyCell> {
        let cells = ArrayList<MyCell>()
        var idx: Int64 = 0
        var i: Int64 = 0
        while (i < columnCount) {
            if (idx >= packet.size) {
                cells.add(MyCell.nullCell())
                i += 1
                continue
            }
            if (byteToInt(packet[idx]) == 0xfb) {
                cells.add(MyCell.nullCell())
                idx += 1
                i += 1
                continue
            }
            let cell = readLenencBytesAt(packet, idx)
            cells.add(MyCell.of(cell.bytes))
            idx = cell.nextIndex
            i += 1
        }
        return cells.toArray()
    }

    /* -------- integer / string helpers -------- */

    private func readLenencIntAt(buf: Array<Byte>, start: Int64): LenencResult {
        if (start >= buf.size) {
            return LenencResult(0, start, Array<Byte>(0, repeat: 0))
        }
        let first = byteToInt(buf[start])
        if (first < 0xfb) {
            return LenencResult(first, start + 1, Array<Byte>(0, repeat: 0))
        }
        if (first == 0xfc) {
            let v = byteToInt(buf[start + 1]) | (byteToInt(buf[start + 2]) << 8)
            return LenencResult(v, start + 3, Array<Byte>(0, repeat: 0))
        }
        if (first == 0xfd) {
            let v = byteToInt(buf[start + 1]) | (byteToInt(buf[start + 2]) << 8) |
                (byteToInt(buf[start + 3]) << 16)
            return LenencResult(v, start + 4, Array<Byte>(0, repeat: 0))
        }
        var v: Int64 = 0
        var shift: Int64 = 0
        var i: Int64 = 1
        while (i <= 8) {
            v = v | ((byteToInt(buf[start + i]) & 0xff) << shift)
            shift += 8
            i += 1
        }
        return LenencResult(v, start + 9, Array<Byte>(0, repeat: 0))
    }

    private func readLenencBytesAt(buf: Array<Byte>, start: Int64): LenencResult {
        let len = readLenencIntAt(buf, start)
        let payload = sliceBytes(buf, len.nextIndex, len.value)
        return LenencResult(len.value, len.nextIndex + len.value, payload)
    }

    private func readLenencStringAt(buf: Array<Byte>, start: Int64): LenencResult {
        readLenencBytesAt(buf, start)
    }

    private func readNullTerminated(buf: Array<Byte>, start: Int64): String {
        var end = start
        while (end < buf.size && buf[end] != 0x00) {
            end += 1
        }
        return bytesToString(sliceBytes(buf, start, end - start))
    }
}

public enum QueryOutcome {
    Ok(MyOk) | ResultSet(MyResultSet)
}

/* -------- free functions used above -------- */

/* Numeric widen/narrow via constructors — `as Int64`/`as Byte` always yield None. */
private func byteToInt(b: Byte): Int64 {
    Int64(b)
}

private func byteToUInt8(b: Byte): UInt8 {
    UInt8(Int64(b))
}

private func int64ToByte(v: Int64): Byte {
    UInt8(v)
}

/* Result holder for lenenc parsing. */
private struct LenencResult {
    public let value: Int64
    public let nextIndex: Int64
    public let bytes: Array<Byte>

    public init(value: Int64, nextIndex: Int64, bytes: Array<Byte>) {
        this.value = value
        this.nextIndex = nextIndex
        this.bytes = bytes
    }
}

public func bytesToString(bytes: Array<Byte>): String {
    try {
        return String.fromUtf8(bytes)
    } catch (_: Exception) {
        /* keep handlers alive on non-UTF-8 bytes */
        var s = ""
        for (b in bytes) {
            let v = byteToInt(b) & 0xff
            if (v >= 32 && v < 127) {
                s = s + hexDigitChar(b)
            } else {
                s = s + "?"
            }
        }
        return s
    }
}

public func sliceBytes(buf: Array<Byte>, start: Int64, count: Int64): Array<Byte> {
    if (start < 0 || count <= 0 || start >= buf.size) {
        return Array<Byte>(0, repeat: 0)
    }
    let end = if (start + count > buf.size) { buf.size } else { start + count }
    return buf.slice(start, end - start)
}

public func concatBytes(a: Array<Byte>, b: Array<Byte>): Array<Byte> {
    let out = ArrayList<Byte>()
    for (x in a) {
        out.add(x)
    }
    for (x in b) {
        out.add(x)
    }
    return out.toArray()
}

public func appendUInt16(out: ArrayList<Byte>, v: UInt16): Unit {
    out.add(int64ToByte(byteToIntFromUInt16(v) & 0xff))
    out.add(int64ToByte((byteToIntFromUInt16(v) >> 8) & 0xff))
}

public func appendUInt24(out: ArrayList<Byte>, v: UInt32): Unit {
    out.add(int64ToByte(byteToIntFromUInt32(v) & 0xff))
    out.add(int64ToByte((byteToIntFromUInt32(v) >> 8) & 0xff))
    out.add(int64ToByte((byteToIntFromUInt32(v) >> 16) & 0xff))
}

public func appendUInt32(out: ArrayList<Byte>, v: UInt32): Unit {
    out.add(int64ToByte(byteToIntFromUInt32(v) & 0xff))
    out.add(int64ToByte((byteToIntFromUInt32(v) >> 8) & 0xff))
    out.add(int64ToByte((byteToIntFromUInt32(v) >> 16) & 0xff))
    out.add(int64ToByte((byteToIntFromUInt32(v) >> 24) & 0xff))
}

private func byteToIntFromUInt16(v: UInt16): Int64 {
    Int64(v)
}

private func byteToIntFromUInt32(v: UInt32): Int64 {
    Int64(v)
}

public func appendNullString(out: ArrayList<Byte>, s: String): Unit {
    for (b in s.toArray()) {
        out.add(b)
    }
    out.add(0)
}

public func hexByte(b: Byte): String {
    let digits = "0123456789abcdef"
    let v = byteToInt(b)
    var out = ""
    out = out + hexDigitChar(digits[(v >> 4) & 0x0f])
    out = out + hexDigitChar(digits[v & 0x0f])
    return out
}

private func hexDigitChar(b: Byte): String {
    let arr = Array<Byte>(1, repeat: 0)
    arr[0] = b
    String.fromUtf8(arr)
}

/* -------- auth tokens -------- */

public func nativePasswordToken(password: String, scramble: Array<Byte>): Array<Byte> {
    let p = password.toArray()
    let stage1 = sha1Bytes(p)
    let stage2 = sha1Bytes(stage1)
    let stage3 = sha1Bytes(concatBytes(scramble, stage2))
    return xorBytes(stage1, stage3)
}

public func cachingSha2Token(password: String, scramble: Array<Byte>): Array<Byte> {
    let p = password.toArray()
    let stage1 = sha256Bytes(p)
    let stage2 = sha256Bytes(stage1)
    let stage3 = sha256Bytes(concatBytes(stage2, scramble))
    return xorBytes(stage1, stage3)
}

public func sha1Bytes(data: Array<Byte>): Array<Byte> {
    let digest = SHA1()
    digest.write(data)
    return digest.finish()
}

public func sha256Bytes(data: Array<Byte>): Array<Byte> {
    let digest = SHA256()
    digest.write(data)
    return digest.finish()
}

public func xorBytes(a: Array<Byte>, b: Array<Byte>): Array<Byte> {
    let n = if (a.size < b.size) { a.size } else { b.size }
    let out = Array<Byte>(n, repeat: 0)
    var i: Int64 = 0
    while (i < n) {
        let av = byteToInt(a[i])
        let bv = byteToInt(b[i])
        out[i] = int64ToByte(av ^ bv)
        i += 1
    }
    return out
}

/* -------- greeting parse -------- */

private func parseGreetingScramble(packet: Array<Byte>): Array<Byte> {
    /* protocol 10: 1 protocol, 1 version\0, 4 thread, 8 auth-part-1, 1 filler */
    var idx: Int64 = 1
    while (idx < packet.size && byteToInt(packet[idx]) != 0x00) {
        idx += 1
    }
    idx += 1 /* version */
    idx += 4 /* thread id */
    let part1 = sliceBytes(packet, idx, 8)
    idx += 8 + 1 /* auth plugin data part 1 + filler */
    var capabilityLower: Int64 = 0
    if (idx + 2 <= packet.size) {
        capabilityLower = byteToInt(packet[idx]) | (byteToInt(packet[idx + 1]) << 8)
    }
    var part2 = Array<Byte>(0, repeat: 0)
    if ((capabilityLower & 0x0008) != 0) {
        /* CLIENT_SECURE_CONNECTION present in lower flags */
        idx += 2 /* charset */
        idx += 2 /* status */
        idx += 2 /* capability upper */
        idx += 1 /* auth plugin data length */
        idx += 10 /* reserved */
        let part2Len = if (packet.size > idx && byteToInt(packet[idx - 11]) > 8) {
            byteToInt(packet[idx - 11]) - 8
        } else {
            13
        }
        let want = if (part2Len > 12) { 12 } else { part2Len }
        part2 = sliceBytes(packet, idx, want)
        /* strip trailing NUL */
        var n = part2.size
        while (n > 0 && byteToInt(part2[n - 1]) == 0x00) {
            n -= 1
        }
        part2 = sliceBytes(part2, 0, n)
    }
    return concatBytes(part1, part2)
}

private func parseGreetingPlugin(packet: Array<Byte>): String {
    /* best-effort: plugin name is a NUL-terminated string near the end */
    var start = packet.size
    while (start > 0 && packet[start - 1] == 0x00) {
        start -= 1
    }
    while (start > 0 && packet[start - 1] != 0x00) {
        start -= 1
    }
    let name = bytesToString(sliceBytes(packet, start, packet.size - start))
    if (name == "caching_sha2_password" || name == "mysql_native_password" ||
        name == "mysql_clear_password") {
        return name
    }
    return "mysql_native_password"
}
