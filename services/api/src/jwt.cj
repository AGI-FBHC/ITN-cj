package itn_spire

import std.core.*
import stdx.encoding.base64.*
import stdx.encoding.json.*
import stdx.crypto.digest.*

public struct JwtPrincipal {
    public let userId: Array<Byte>
    public let subject: String

    public init(userId: Array<Byte>, subject: String) {
        this.userId = userId
        this.subject = subject
    }
}

public func jwtVerify(token: String, secret: String): ?JwtPrincipal {
    let parts = token.trimAscii().split(".")
    if (parts.size != 3) {
        return None
    }
    var headerJson = ""
    match (b64UrlDecodeToString(parts[0])) {
        case Some(h) => headerJson = h
        case None => return None
    }
    var payloadJson = ""
    match (b64UrlDecodeToString(parts[1])) {
        case Some(p) => payloadJson = p
        case None => return None
    }
    var sig: Array<Byte> = Array<Byte>(0, repeat: 0)
    match (b64UrlDecode(parts[2])) {
        case Some(s) => sig = s
        case None => return None
    }
    var alg = ""
    match (jwtAlg(headerJson)) {
        case Some(a) => alg = a
        case None => return None
    }
    let signingInput = parts[0] + "." + parts[1]
    var expect: Array<Byte> = Array<Byte>(0, repeat: 0)
    match (hmacSign(alg, secret, signingInput)) {
        case Some(e) => expect = e
        case None => return None
    }
    if (!hmacEqual(sig, expect)) {
        return None
    }
    var payload: JsonValue = jnull()
    match (jsonParse(payloadJson)) {
        case Some(p) => payload = p
        case None => return None
    }
    match (payload.kind()) {
        case JsonKind.JsObject =>
            let obj = payload.asObject()
            if (!jwtClaimsValid(obj)) {
                return None
            }
            var sub = ""
            match (jsonGetString(obj, "sub")) {
                case Some(s) => sub = s
                case None => return None
            }
            var userId: Array<Byte> = Array<Byte>(0, repeat: 0)
            match (uuidParse(sub)) {
                case Some(u) => userId = u
                case None => return None
            }
            return Some(JwtPrincipal(userId, sub))
        case _ => return None
    }
}

private func jwtAlg(headerJson: String): ?String {
    var value: JsonValue = jnull()
    match (jsonParse(headerJson)) {
        case Some(v) => value = v
        case None => return None
    }
    match (value.kind()) {
        case JsonKind.JsObject =>
            var alg = ""
            match (jsonGetString(value.asObject(), "alg")) {
                case Some(a) => alg = a
                case None => return None
            }
            if (alg == "HS256" || alg == "HS384" || alg == "HS512") {
                return Some(alg)
            }
            return None
        case _ => return None
    }
}

private func jwtClaimsValid(obj: JsonObject): Bool {
    let nowSec = nowEpochSeconds()
    match (jsonGetInt(obj, "exp")) {
        case Some(exp) =>
            if (nowSec > exp) {
                return false
            }
        case None => return false
    }
    match (jsonGetInt(obj, "nbf")) {
        case Some(nbf) =>
            if (nowSec + 30 < nbf) {
                return false
            }
        case None => ()
    }
    return true
}

private func hmacSign(alg: String, secret: String, signingInput: String): ?Array<Byte> {
    let key = secret.toArray()
    let data = signingInput.toArray()
    try {
        if (alg == "HS256") {
            let mac = HMAC(key, HashType.SHA256)
            mac.write(data)
            return Some(mac.finish())
        }
        if (alg == "HS384") {
            let mac = HMAC(key, HashType.SHA384)
            mac.write(data)
            return Some(mac.finish())
        }
        if (alg == "HS512") {
            let mac = HMAC(key, HashType.SHA512)
            mac.write(data)
            return Some(mac.finish())
        }
    } catch (_: Exception) {
        return None
    }
    return None
}

private func hmacEqual(a: Array<Byte>, b: Array<Byte>): Bool {
    if (a.size != b.size) {
        return false
    }
    var diff: UInt8 = 0
    var i: Int64 = 0
    while (i < a.size) {
        match (a[i] as UInt8) {
            case Some(av) =>
                match (b[i] as UInt8) {
                    case Some(bv) => diff = diff | (av ^ bv)
                    case None => ()
                }
            case None => ()
        }
        i += 1
    }
    return diff == 0
}

public func b64UrlDecode(text: String): ?Array<Byte> {
    var s = text.replace("-", "+").replace("_", "/")
    let mod = s.size % 4
    if (mod == 1) {
        return None
    }
    if (mod == 2) {
        s = s + "=="
    } else if (mod == 3) {
        s = s + "="
    }
    try {
        return fromBase64String(s)
    } catch (_: Exception) {
        return None
    }
}

public func b64UrlDecodeToString(text: String): ?String {
    var bytes: Array<Byte> = Array<Byte>(0, repeat: 0)
    match (b64UrlDecode(text)) {
        case Some(b) => bytes = b
        case None => return None
    }
    try {
        return Some(String.fromUtf8(bytes))
    } catch (_: Exception) {
        return None
    }
}

public func b64UrlEncode(data: Array<Byte>): String {
    let raw = toBase64String(data)
    return raw.replace("+", "-").replace("/", "_").replace("=", "")
}
