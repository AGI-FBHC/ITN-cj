package zhixun_learning

import std.collection.*
import std.convert.*
import std.core.*
import std.net.*
import stdx.crypto.crypto.SecureRandom
import stdx.encoding.base64.toBase64String
import stdx.net.tls.*

func verificationCode(): String {
    let random = SecureRandom()
    var result = ""
    while (result.toArray().size < 6) {
        let value = random.nextBytes(1)[0]
        if (value < 250) {
            result += String.fromUtf8([48u8 + value % 10])
        }
    }
    result
}

func normalizeEmail(value: String): String {
    let bytes = value.toArray()
    var start: Int64 = 0
    var end = bytes.size
    while (start < end && Int64(bytes[start]) <= 32) { start += 1 }
    while (end > start && Int64(bytes[end - 1]) <= 32) { end -= 1 }
    let trimmed = String.fromUtf8(bytes.slice(start, end - start))
    trimmed.toAsciiLower()
}

func validEmail(value: String): Bool {
    let bytes = value.toArray()
    if (bytes.size > 254) { return false }
    var atCount: Int64 = 0
    for (byte in bytes) {
        if (byte <= 32 || byte >= 127) { return false }
        if (byte == 64) { atCount += 1 }
    }
    if (atCount != 1) { return false }
    let at = value.indexOf("@")
    let dot = value.lastIndexOf(".")
    match (at) {
        case Some(position) => position > 0 && position < value.size - 3 &&
            match (dot) {
                case Some(dotPosition) => dotPosition > position + 1 && dotPosition < value.size - 1
                case None => false
            }
        case None => false
    }
}

func sendVerificationEmail(cfg: Config, recipient: String, code: String, ttlSeconds: Int64): Unit {
    sendVerificationEmail(cfg, recipient, code, ttlSeconds, "LOGIN")
}

func sendVerificationEmail(cfg: Config, recipient: String, code: String, ttlSeconds: Int64, purpose: String): Unit {
    if (cfg.smtpHost.size == 0 || cfg.smtpUser.size == 0 || cfg.smtpPassword.size == 0 || cfg.emailFrom.size == 0) {
        throw Exception("SMTP configuration is incomplete")
    }
    let tcp = connectSmtp(cfg)
    try {
        tcp.readTimeout = Some(Duration.second * 12)
        tcp.writeTimeout = Some(Duration.second * 12)
        if (cfg.smtpPort != 465) {
            expectSmtp(tcp, 220)
            commandSmtp(tcp, "EHLO localhost", 250)
            commandSmtp(tcp, "STARTTLS", 220)
        }
        var settings = TlsClientConfig()
        settings.serverName = Some(cfg.smtpHost)
        let tls = TlsSocket.client(tcp, clientConfig: settings)
        try {
            tls.handshake(timeout: Some(Duration.second * 12))
            if (cfg.smtpPort == 465) { expectSmtp(tls, 220) }
            commandSmtp(tls, "EHLO localhost", 250)
            commandSmtp(tls, "AUTH LOGIN", 334)
            commandSmtp(tls, toBase64String(cfg.smtpUser.toArray()), 334)
            commandSmtp(tls, toBase64String(cfg.smtpPassword.toArray()), 235)
            commandSmtp(tls, "MAIL FROM:<${cfg.emailFrom}>", 250)
            commandSmtp(tls, "RCPT TO:<${recipient}>", 250)
            commandSmtp(tls, "DATA", 354)
            tls.write(emailMessage(cfg, recipient, code, ttlSeconds, purpose).toArray())
            expectSmtp(tls, 250)
            try { commandSmtp(tls, "QUIT", 221) } catch (_: Exception) {}
        } finally {
            tls.close()
        }
    } finally {
        tcp.close()
    }
}

func connectSmtp(cfg: Config): TcpSocket {
    let addresses = IPAddress.resolve(cfg.smtpHost)
    for (address in addresses) {
        let socket = TcpSocket(address.toString(), cfg.smtpPort)
        try {
            socket.connect(timeout: Some(Duration.second * 12))
            return socket
        } catch (_: Exception) {
            socket.close()
        }
    }
    throw Exception("Unable to connect to SMTP server")
}

func emailMessage(cfg: Config, recipient: String, code: String, ttlSeconds: Int64): String {
    emailMessage(cfg, recipient, code, ttlSeconds, "LOGIN")
}

func emailMessage(cfg: Config, recipient: String, code: String, ttlSeconds: Int64, purpose: String): String {
    let resetting = purpose == PASSWORD_RESET_PURPOSE
    let label = if (resetting) { "密码重置" } else { "登录" }
    let subject = "=?UTF-8?B?" + toBase64String((cfg.subjectPrefix + " " + label + "验证码").toArray()) + "?="
    let name = "=?UTF-8?B?" + toBase64String(cfg.emailFromName.toArray()) + "?="
    let text = "您的${label}验证码是：${code}。验证码将在 ${ttlSeconds / 60} 分钟后失效，请勿泄露给他人。" +
        (if (resetting) { "若非本人操作，请忽略此邮件，您的密码不会改变。" } else { "" })
    let encoded = toBase64String(text.toArray()).toArray()
    var body = ""
    var offset: Int64 = 0
    while (offset < encoded.size) {
        let size = minInt(76, encoded.size - offset)
        body += String.fromUtf8(encoded.slice(offset, size)) + "\r\n"
        offset += size
    }
    "From: ${name} <${cfg.emailFrom}>\r\nTo: <${recipient}>\r\nSubject: ${subject}\r\n" +
        "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n" +
        "Content-Transfer-Encoding: base64\r\n\r\n" + body + ".\r\n"
}

func commandSmtp(socket: StreamingSocket, text: String, expected: Int64): Unit {
    socket.write((text + "\r\n").toArray())
    expectSmtp(socket, expected)
}

func expectSmtp(socket: StreamingSocket, expected: Int64): Unit {
    for (_ in 0..100) {
        let line = readSmtpLine(socket).toArray()
        if (line.size < 4) { throw Exception("Invalid SMTP reply") }
        let status = Int64.parse(String.fromUtf8(line.slice(0, 3)))
        if (status != expected) { throw Exception("SMTP rejected operation with status ${status}") }
        if (line[3] == 32) { return }
        if (line[3] != 45) { throw Exception("Invalid SMTP continuation") }
    }
    throw Exception("SMTP reply too long")
}

func readSmtpLine(socket: StreamingSocket): String {
    let bytes = ArrayList<UInt8>()
    let buffer = [0u8]
    while (bytes.size < 4096) {
        if (socket.read(buffer) == 0) { throw Exception("SMTP connection closed") }
        if (buffer[0] == 10) { return String.fromUtf8(bytes.toArray()).trimAscii() }
        bytes.add(buffer[0])
    }
    throw Exception("SMTP line too long")
}

func minInt(a: Int64, b: Int64): Int64 {
    if (a < b) { a } else { b }
}
