package web.service
import std.unicode.*

import std.net.*
import std.collection.ArrayList
import std.convert.*
import stdx.net.tls.*
import stdx.encoding.base64.toBase64String
import web.config.MailConfig

public interface VerificationMailer {
    func send(recipient: String, code: String, purpose: String, ttlSeconds: Int64): Unit
}

public class VerificationMailService <: VerificationMailer {
    private let config: MailConfig
    public init(config: MailConfig) { this.config = config }
    public func send(recipient: String, code: String, purpose: String, ttlSeconds: Int64): Unit {
        config.validate()
        if (recipient.contains("\r") || recipient.contains("\n")) {
            throw IllegalArgumentException("Invalid email address")
        }
        let tcp = connectedTcp()
        try {
            tcp.readTimeout = Some(Duration.second * 10)
            tcp.writeTimeout = Some(Duration.second * 10)
            if (config.port != 465) {
                expect(tcp, 220)
                command(tcp, "EHLO localhost", 250)
                command(tcp, "STARTTLS", 220)
            }
            var settings = TlsClientConfig()
            settings.serverName = Some(config.host)
            let tls = TlsSocket.client(tcp, clientConfig: settings)
            try {
                tls.handshake(timeout: Some(Duration.second * 10))
                if (config.port == 465) { expect(tls, 220) }
                command(tls, "EHLO localhost", 250)
                command(tls, "AUTH LOGIN", 334)
                command(tls, toBase64String(config.username.toArray()), 334)
                command(tls, toBase64String(config.getPassword().toArray()), 235)
                command(tls, "MAIL FROM:<${config.from}>", 250)
                command(tls, "RCPT TO:<${recipient}>", 250)
                command(tls, "DATA", 354)
                tls.write(message(recipient, code, purpose, ttlSeconds).toArray())
                expect(tls, 250)
                // DATA acceptance is the delivery result; QUIT errors must not invalidate it.
                try { command(tls, "QUIT", 221) } catch (_: Exception) { () }
            } finally { tls.close() }
        } finally { tcp.close() }
    }
    private func connectedTcp(): TcpSocket {
        let addresses = IPAddress.resolve(config.host)
        for (address in addresses) {
            let socket = TcpSocket(address.toString(), config.port)
            try {
                socket.connect(timeout: Some(Duration.second * 10))
                return socket
            } catch (_: Exception) { socket.close() }
        }
        throw Exception("Unable to connect to SMTP server")
    }
    public func message(recipient: String, code: String, purpose: String, ttlSeconds: Int64): String {
        let operation = match (purpose) {
            case "REGISTER" => "注册"
            case "PASSWORD_RESET" => "重置密码"
            case _ => "身份验证"
        }
        let subject = "=?UTF-8?B?" + toBase64String((config.subjectPrefix.trim() + " " + operation + "验证码").toArray()) + "?="
        let name = "=?UTF-8?B?" + toBase64String(config.fromName.toArray()) + "?="
        let text = "您的${operation}验证码是：${code}。验证码将在 ${ttlSeconds / 60} 分钟后失效，请勿泄露给他人。"
        let encoded = toBase64String(text.toArray()).toArray()
        var body = ""
        var offset = 0
        while (offset < encoded.size) {
            let size = min(76, encoded.size - offset)
            body += String.fromUtf8(encoded.slice(offset, size)) + "\r\n"
            offset += size
        }
        return "From: ${name} <${config.from}>\r\nTo: <${recipient}>\r\nSubject: ${subject}\r\n" +
            "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n" +
            "Content-Transfer-Encoding: base64\r\n\r\n" + body + ".\r\n"
    }
    private static func command(socket: StreamingSocket, text: String, expected: Int64): Unit {
        socket.write((text + "\r\n").toArray())
        expect(socket, expected)
    }
    private static func expect(socket: StreamingSocket, expected: Int64): Unit {
        for (_ in 0..100) {
            let line = readLine(socket).toArray()
            if (line.size < 4) { throw Exception("Invalid SMTP reply") }
            let status = Int64.parse(String.fromUtf8(line.slice(0, 3)))
            if (status != expected) { throw Exception("SMTP rejected operation with status ${status}") }
            if (line[3] == 32) { return }
            if (line[3] != 45) { throw Exception("Invalid SMTP continuation") }
        }
        throw Exception("SMTP reply too long")
    }
    private static func readLine(socket: StreamingSocket): String {
        let bytes = ArrayList<UInt8>()
        let buffer = [0u8]
        while (bytes.size < 4096) {
            if (socket.read(buffer) == 0) { throw Exception("SMTP connection closed") }
            if (buffer[0] == 10) { return String.fromUtf8(bytes.toArray()).trim() }
            bytes.add(buffer[0])
        }
        throw Exception("SMTP line too long")
    }
}
