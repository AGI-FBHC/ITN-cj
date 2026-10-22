package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import std.io.*
import stdx.encoding.json.*
import soulsoft_web_http.*

/* Read the whole request body as UTF-8 text. */
public func readBodyText(request: HttpRequest): String {
    let stream = request.body
    let buffer = Array<Byte>(4096, repeat: 0)
    let parts = ArrayList<Byte>()
    try {
        while (true) {
            let n = stream.read(buffer)
            if (n <= 0) {
                break
            }
            var i: Int64 = 0
            while (i < n) {
                parts.add(buffer[i])
                i += 1
            }
        }
    } catch (_: Exception) {
        /* fall through with whatever was read */
    }
    return String.fromUtf8(parts.toArray())
}

public func writeJson(response: HttpResponse, status: UInt16, body: String): Unit {
    response.statusCode = status
    response.contentType = "application/json; charset=utf-8"
    response.write(body)
}

/*
 * Conditional GET helper matching Python _etag_json: the ETag value includes
 * the surrounding quotes, and a matching If-None-Match returns 304 with the
 * same header and an empty body.
 */
public func writeJsonEtag(response: HttpResponse, request: HttpRequest, body: String, prefix: String): Unit {
    let digest = bytesToHex(sha1Bytes(body.toArray()))
    var hash = digest
    if (hash.size > 16) {
        hash = hash[0..16]
    }
    let etag = "\"" + prefix + "-" + hash + "\""
    response.headers.add("ETag", etag)
    match (request.headers.get("If-None-Match")) {
        case Some(v) =>
            if (v.trimAscii() == etag) {
                response.statusCode = 304
                return
            }
        case None => ()
    }
    writeJson(response, 200, body)
}

/* FastAPI HTTPException shape: {"detail": "..."} */
public func writeDetail(response: HttpResponse, status: UInt16, detail: String): Unit {
    writeJson(response, status, "{\"detail\":" + jsonQuote(detail) + "}")
}

/*
 * Exact RequestValidationError response of the agents service
 * (src/agents/app/main.py:44-46):
 *
 *   {"code":"VALIDATION_FAILED","details":exc.errors()}
 *
 * The inner items are pydantic ValidationError.errors() of pydantic 2.10.4:
 * key order type, loc, msg, input, ctx — `ctx` is omitted when the error
 * carries none. `input` is always present (null for a missing query param or
 * a missing body; the parent object for a missing body field).
 * Measured live against FastAPI 0.115.6 / pydantic 2.10.4 on 2026-10-16
 * (tmp_verify/fastapi_ref_422.py).
 *
 * This is the ONLY 422 body shape for model/query validation. FastAPI's
 * HTTPException(422, detail=...) keeps {"detail":"..."} — that is writeDetail.
 */
public func pyErrItem(loc: Array<String>, errType: String, msg: String,
                      inputRawJson: String, ctxRawJson: ?String): String {
    let locArr = JsonArrWriter()
    for (part in loc) {
        locArr.addRaw(jsonQuote(part))
    }
    return pyErrItemLocRaw(locArr.toJson(), errType, msg, inputRawJson, ctxRawJson)
}

/*
 * loc already rendered as a JSON array. Needed for list-item errors, whose
 * loc carries a NUMBER index: ["body","kbRefs",0] (measured — the index is
 * not quoted).
 */
public func pyErrItemLocRaw(locRawJson: String, errType: String, msg: String,
                            inputRawJson: String, ctxRawJson: ?String): String {
    let item = JsonWriter()
    item.putStr("type", errType)
    item.putRaw("loc", locRawJson)
    item.putStr("msg", msg)
    item.putRaw("input", inputRawJson)
    match (ctxRawJson) {
        case Some(ctx) => item.putRaw("ctx", ctx)
        case None => ()
    }
    return item.toJson()
}

/* One envelope for one or many pydantic items (pydantic reports every field). */
public func writeValidation422Many(response: HttpResponse, items: Array<String>): Unit {
    let details = JsonArrWriter()
    for (item in items) {
        details.addRaw(item)
    }
    let obj = JsonWriter()
    obj.putStr("code", "VALIDATION_FAILED")
    obj.putRaw("details", details.toJson())
    writeJson(response, 422, obj.toJson())
}

/* Single-item 422 — shorthand for writeValidation422Many with one entry. */
public func writeValidation422(response: HttpResponse, loc: Array<String>,
                               errType: String, msg: String,
                               inputRawJson: String, ctxRawJson: ?String): Unit {
    writeValidation422Many(response, [pyErrItem(loc, errType, msg, inputRawJson, ctxRawJson)])
}

/* ---- measured pydantic item shorthands (tmp_verify/fastapi_ref_422.py) ---- */

/* missing — input is the parent object for a body field, null for a query param. */
public func pyMissing(loc: Array<String>, parentRawJson: String): String {
    pyErrItem(loc, "missing", "Field required", parentRawJson, None)
}

public func pyStringType(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "string_type", "Input should be a valid string", inputRawJson, None)
}

public func pyStringTooShort(loc: Array<String>, inputRawJson: String, minLen: Int64): String {
    pyErrItem(loc, "string_too_short",
              "String should have at least " + minLen.toString() +
                  (if (minLen == 1) { " character" } else { " characters" }),
              inputRawJson, Some("{\"min_length\":" + minLen.toString() + "}"))
}

public func pyStringTooLong(loc: Array<String>, inputRawJson: String, maxLen: Int64): String {
    pyErrItem(loc, "string_too_long",
              "String should have at most " + maxLen.toString() +
                  (if (maxLen == 1) { " character" } else { " characters" }),
              inputRawJson, Some("{\"max_length\":" + maxLen.toString() + "}"))
}

/* literal_error — `expected` is the pydantic ctx.expected text, e.g. "'a' or 'b'". */
public func pyLiteral(loc: Array<String>, inputRawJson: String, expected: String): String {
    pyErrItem(loc, "literal_error", "Input should be " + expected,
              inputRawJson, Some("{\"expected\":" + jsonQuote(expected) + "}"))
}

public func pyIntParsing(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "int_parsing",
              "Input should be a valid integer, unable to parse string as an integer",
              inputRawJson, None)
}

public func pyIntType(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "int_type", "Input should be a valid integer", inputRawJson, None)
}

public func pyBoolParsing(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "bool_parsing",
              "Input should be a valid boolean, unable to interpret input",
              inputRawJson, None)
}

public func pyBoolType(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "bool_type", "Input should be a valid boolean", inputRawJson, None)
}

public func pyListType(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "list_type", "Input should be a valid list", inputRawJson, None)
}

/*
 * too_long for a list constraint (max_length on List[...]). Measured ctx has
 * three keys, including the observed length, and the msg ends with it.
 */
public func pyListTooLong(loc: Array<String>, inputRawJson: String,
                          maxLen: Int64, actualLen: Int64): String {
    pyErrItem(loc, "too_long",
              "List should have at most " + maxLen.toString() +
                  " items after validation, not " + actualLen.toString(),
              inputRawJson, Some("{\"field_type\":\"List\"," +
                                 "\"max_length\":" + maxLen.toString() +
                                 ",\"actual_length\":" + actualLen.toString() + "}"))
}

public func pyGe(loc: Array<String>, inputRawJson: String, ge: Int64): String {
    pyErrItem(loc, "greater_than_equal",
              "Input should be greater than or equal to " + ge.toString(),
              inputRawJson, Some("{\"ge\":" + ge.toString() + "}"))
}

public func pyLe(loc: Array<String>, inputRawJson: String, le: Int64): String {
    pyErrItem(loc, "less_than_equal",
              "Input should be less than or equal to " + le.toString(),
              inputRawJson, Some("{\"le\":" + le.toString() + "}"))
}

/* uuid_parsing — `err` is the uuid crate diagnostic (also ctx.error). */
public func pyUuidParsing(loc: Array<String>, inputRawJson: String, err: String): String {
    pyErrItem(loc, "uuid_parsing", "Input should be a valid UUID, " + err,
              inputRawJson, Some("{\"error\":" + jsonQuote(err) + "}"))
}

/* uuid_type — UUID got a JSON value that is not a string at all. No ctx. */
public func pyUuidType(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "uuid_type",
              "UUID input should be a string, bytes or UUID object",
              inputRawJson, None)
}

/* int_from_float — a fractional number where an int is required. No ctx. */
public func pyIntFromFloat(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "int_from_float",
              "Input should be a valid integer, got a number with a fractional part",
              inputRawJson, None)
}

/*
 * string_pattern_mismatch — Field(pattern=...). `pattern` is the raw regex.
 * pydantic-core formats the msg with SINGLE quotes around the raw pattern
 * (measured: "String should match pattern '^#[0-9a-fA-F]{6}$'"), while ctx
 * still carries the pattern as a JSON string.
 */
public func pyPatternMismatch(loc: Array<String>, inputRawJson: String,
                              pattern: String): String {
    pyErrItem(loc, "string_pattern_mismatch",
              "String should match pattern '" + pattern + "'",
              inputRawJson, Some("{\"pattern\":" + jsonQuote(pattern) + "}"))
}

/* List-element string_type — loc carries the numeric element index. */
public func pyListStringType(bodyKey: String, index: Int64, inputRawJson: String): String {
    let locArr = JsonArrWriter()
    locArr.addRaw(jsonQuote("body"))
    locArr.addRaw(jsonQuote(bodyKey))
    locArr.addRaw(index.toString())
    pyErrItemLocRaw(locArr.toJson(), "string_type",
                    "Input should be a valid string", inputRawJson, None)
}

/* dict_type — a `dict[...]` field got a non-object (or an explicit null). */
public func pyDictType(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "dict_type", "Input should be a valid dictionary", inputRawJson, None)
}

/* float_parsing — a string that Python float() cannot read. No ctx. */
public func pyFloatParsing(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "float_parsing",
              "Input should be a valid number, unable to parse string as a number",
              inputRawJson, None)
}

/* float_type — a dict/float field got a non-number. No ctx. */
public func pyFloatType(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "float_type", "Input should be a valid number", inputRawJson, None)
}

/*
 * A dict-value failure at ["body", <bodyKey>, <dictKey>]. Measured for
 * self_assessments: {"k": "x"} -> float_parsing at ["body","selfAssessments","k"],
 * {"k": null} -> float_type at the same loc. The dict key is a QUOTED string,
 * unlike a list index.
 */
public func pyDictValueType(bodyKey: String, dictKey: String, errType: String,
                            msg: String, inputRawJson: String): String {
    let locArr = JsonArrWriter()
    locArr.addRaw(jsonQuote("body"))
    locArr.addRaw(jsonQuote(bodyKey))
    locArr.addRaw(jsonQuote(dictKey))
    pyErrItemLocRaw(locArr.toJson(), errType, msg, inputRawJson, None)
}

/* model_attributes_type — body is not a JSON object. */
public func pyModelAttributesType(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "model_attributes_type",
              "Input should be a valid dictionary or object to extract fields from",
              inputRawJson, None)
}

/*
 * PydanticCustomError("blank_title", "title must not be blank") — the custom
 * type becomes the item's `type`, empty ctx means no ctx key at all.
 */
public func pyBlankTitle(loc: Array<String>, inputRawJson: String): String {
    pyErrItem(loc, "blank_title", "title must not be blank", inputRawJson, None)
}

/* Path-UUID parser emitting the agents-service validation envelope above. */
public func parsePathUuidValidated(ctx: HttpContext, name: String): ?Array<Byte> {
    var text = ""
    match (routeParam(ctx.request, name)) {
        case Some(t) => text = t
        case None => ()
    }
    match (uuidParse(text)) {
        case Some(bytes) => return Some(bytes)
        case None =>
            match (uuidParseError(text)) {
                case Some(detail) =>
                    writeValidation422(ctx.response, ["path", name], "uuid_parsing",
                                       "Input should be a valid UUID, " + detail,
                                       jsonQuote(text),
                                       Some("{\"error\":" + jsonQuote(detail) + "}"))
                case None =>
                    writeValidation422(ctx.response, ["path", name], "uuid_parsing",
                                       "Input should be a valid UUID",
                                       jsonQuote(text),
                                       Some("{\"error\":\"Invalid UUID\"}"))
            }
            return None
    }
}

/*
 * Historical name for writeValidation422. The `{"detail":[...]}` wrapper it
 * once emitted is FastAPI's DEFAULT handler; the agents service replaces it
 * with {"code":"VALIDATION_FAILED","details":[...]} (main.py:44-46). Kept as
 * an alias so existing call sites stay one-line.
 */
public func writeFastApi422(response: HttpResponse, loc: Array<String>,
                            errType: String, msg: String,
                            inputRawJson: String, ctxRawJson: ?String): Unit {
    writeValidation422(response, loc, errType, msg, inputRawJson, ctxRawJson)
}

/*
 * fastapi/routing.py: `except json.JSONDecodeError as e` around
 * `await request.json()` — the body never reaches pydantic. Routing raises
 * RequestValidationError with a json_invalid item, so the agents-service
 * handler wraps it the same way as any other validation error. `input` is
 * always the empty object — routing.py hard-codes `input={}`.
 */
public func writeJsonInvalid422(response: HttpResponse, err: PyJsonError): Unit {
    /* loc carries a NUMBER offset — ["body", 2], index not quoted. Same rule
     * as list-item indices (see pyErrItemLocRaw); going through
     * writeValidation422 would quote it as "2". */
    let locRaw = "[\"body\"," + err.pos.toString() + "]"
    writeValidation422Many(response, [
        pyErrItemLocRaw(locRaw, "json_invalid", "JSON decode error", "{}",
                        Some("{\"error\":" + jsonQuote(err.msg) + "}"))])
}

/*
 * uuid crate error text used as both `msg` suffix and `ctx.error`.
 *
 * Acceptance, message and position all come from measurement against FastAPI
 * 0.115.6 / pydantic 2.10.4 (tmp_verify/fastapi_ref_presentations.py plus the
 * crafted-input probes recorded in the body below). Returns None exactly when
 * FastAPI's UUID path converter accepts the string — uuidParse() gates on
 * this so the accept path and the reject path can never disagree.
 *
 * Two coordinate systems: character positions are 1-based over the ORIGINAL
 * input except for the crate's 32/36/38/45 length classes, which report them
 * inside the stripped string. Do not "simplify" this to one rule.
 */
public func uuidParseError(input: String): ?String {
    let origLen = input.size
    var s = input
    var base: Int64 = 0        /* chars stripped from the FRONT */
    var removed: Int64 = 0     /* chars stripped in total */
    if (s.startsWith("urn:uuid:")) {
        s = s[9..s.size]
        base = 9
        removed = 9
    } else {
        if (s.size >= 2 && s.startsWith("{") && s.endsWith("}")) {
            s = s[1..(s.size - 1)]
            base = 1
            removed = 2
        }
    }

    /*
     * The crate parses four length classes directly — 32 (simple),
     * 36 (hyphenated), 38 (braced), 45 (URN) — and reports character
     * positions inside the stripped string for them; every other length
     * falls through to a generic path that reports positions over the
     * ORIGINAL string. Both spellings were measured against FastAPI
     * 0.115.6 / pydantic 2.10.4:
     *   len 45 "urn:uuid:zzzz..."      -> `z` at 1   (stripped)
     *   len 47 "urn:uuid:{0000...}"    -> `{` at 10  (original)
     *   len 47 "{urn:uuid:0000...}"    -> `u` at 2   (original)
     *   len 38 "{...0000z}"            -> `z` at 36  (stripped)
     */
    let dispatch = (origLen == 32 || origLen == 36 || origLen == 38 || origLen == 45)

    let rs = s.toRuneArray()
    var i: Int64 = 0
    while (i < rs.size) {
        let ch = rs[i]
        let ok = (runeCode(ch) >= 0x30 && runeCode(ch) <= 0x39) ||
                 (runeCode(ch) >= 0x41 && runeCode(ch) <= 0x46) ||
                 (runeCode(ch) >= 0x61 && runeCode(ch) <= 0x66) ||
                 (runeCode(ch) == 0x2d)
        if (!ok) {
            var at = base + i + 1
            if (dispatch) {
                at = i + 1
            }
            return Some("invalid character: expected an optional prefix of `urn:uuid:` " +
                        "followed by [0-9a-fA-F-], found `" + ch.toString() + "` at " +
                        at.toString())
        }
        i += 1
    }

    /*
     * Shape. Anything that had a prefix/brace stripped goes down the
     * hyphenated path even when it then contains no '-', which is why
     * "urn:uuid:"+32 hex is "invalid group count: expected 5, found 1"
     * rather than a valid simple UUID, while a bare 36-char hex run is
     * "invalid length: ... found 36". Measured both ways.
     */
    if (removed > 0 || s.contains("-")) {
        let groups = s.split("-")
        if (groups.size != 5) {
            return Some("invalid group count: expected 5, found " + groups.size.toString())
        }
        let expected = [8, 4, 4, 4, 12]
        var g: Int64 = 0
        while (g < 5) {
            let n = groups[g].size
            if (n != expected[g]) {
                /*
                 * Group 4's reported length is measured from the ORIGINAL
                 * string (start offset 24 comes from the stripped one) —
                 * the crate's prefix accounting leaks here:
                 *   "{00000000-0000-0000-0000-00000000000}" 37 -> found 13
                 *   "urn:uuid:00000000-0000-0000-0000-00000000000" 44 -> found 20
                 *   "00000000-0000-0000-0000-0000000000000" 37 -> found 13
                 * Groups 0..3 report the stripped length (verified for
                 * both a braced and an URN input). Groups 0..3 are checked
                 * first, so group 4 only ever fails with all four of them
                 * already at their expected widths — offset 24.
                 */
                var shown = n
                if (g == 4) {
                    shown = origLen - 24
                }
                return Some("invalid group length in group " + g.toString() +
                            ": expected " + expected[g].toString() + ", found " +
                            shown.toString())
            }
            g += 1
        }
        return None
    }
    if (s.size != 32) {
        return Some("invalid length: expected length 32 for simple format, found " +
                    s.size.toString())
    }
    return None
}

public func writeInternalError(response: HttpResponse): Unit {
    let obj = JsonWriter()
    obj.putStr("code", "INTERNAL_ERROR")
    obj.putStr("message", "Internal server error")
    try {
        writeJson(response, 500, obj.toJson())
    } catch (_: Exception) {
        /*
         * Response already started — e.g. writeJson set statusCode then
         * response.write threw because the client went away. Setting status
         * again raises "cannot be modified because the response has already
         * started", so swallow: the socket is already broken and a 500 body
         * can no longer be delivered.
         */
    }
}

/*
 * Call sites pass a local reason for debugging; clients always receive the
 * generic INTERNAL_ERROR body so SQL / connection details never leak.
 */
public func writeInternalDebug(response: HttpResponse, _why: String): Unit {
    writeInternalError(response)
}

/* Extract "Bearer <token>" from the Authorization header. */
public func bearerToken(request: HttpRequest): ?String {
    var auth = ""
    match (request.headers.get("Authorization")) {
        case Some(a) => auth = a
        case None => return None
    }
    let parts = auth.split(" ")
    if (parts.size < 2) {
        return None
    }
    let scheme = parts[0].toAsciiLower()
    if (scheme != "bearer") {
        return None
    }
    let token = parts[1].trimAscii()
    if (token.size == 0) {
        return None
    }
    return Some(token)
}

/*
 * Resolve the caller identity using the same rules as
 * src/agents/app/security.py require_user_principal.
 *
 * NOTE: this is the /v1 face. Python's require_user_principal verifies the JWT
 * signature only (security.py:80-94) — no session lookup, no active check — so
 * the /v1 routes keep this function unchanged. The /api/v1 face uses
 * requireUserApi below.
 */
public func requireUser(request: HttpRequest, response: HttpResponse, secret: ?String): ?Array<Byte> {
    match (secret) {
        case None =>
            writeDetail(response, 503, "User authentication is not configured")
            return None
        case Some(sec) =>
            match (bearerToken(request)) {
                case None =>
                    writeDetail(response, 401, "Bearer token required")
                    return None
                case Some(token) =>
                    match (jwtVerify(token, sec)) {
                        case None =>
                            writeDetail(response, 401, "Invalid or expired token")
                            return None
                        case Some(principal) =>
                            return Some(principal.userId)
                    }
            }
    }
}

/*
 * /api/v1 face: JWT signature + a live user_sessions row + an active user.
 *
 * Mirrors src/backend/.../security/JwtAuthenticationFilter.java:
 *   jwtService.parse(token);
 *   session = sessionRepository.findByTokenHash(sha256(token));
 *   if (session != null && session.isValidAt(now) && session.getUser().isActive())
 *       authenticate(session.getUser());
 *   — anything else leaves the request unauthenticated → 401.
 *
 * UserSession.isValidAt(instant) is `revokedAt == null && expiresAt.isAfter(instant)`.
 * token_hash is SHA-256 of the raw bearer token as lowercase hex, 64 chars
 * (HashingSupport.sha256 → HexFormat.of().formatHex).
 *
 * The authenticated identity is the SESSION's user, matching Java — it
 * authenticates session.getUser(), not the JWT sub. They agree in practice
 * because the token hash identifies the login session that issued this token.
 *
 * All three failure modes (bad signature, no live session, inactive user) are
 * 401 "Invalid or expired token": Java's filter simply declines to
 * authenticate, and Spring Security answers 401 for all of them. The 1007
 * ACCOUNT_DISABLED code is a login-flow error, not a filter error.
 */
public func requireUserApi(request: HttpRequest, response: HttpResponse, cfg: AppConfig): ?Array<Byte> {
    match (cfg.jwtSecret) {
        case None =>
            writeDetail(response, 503, "User authentication is not configured")
            return None
        case Some(sec) =>
            match (bearerToken(request)) {
                case None =>
                    writeDetail(response, 401, "Bearer token required")
                    return None
                case Some(token) =>
                    match (jwtVerify(token, sec)) {
                        case None =>
                            writeDetail(response, 401, "Invalid or expired token")
                            return None
                        case Some(_) =>
                            match (activeSessionUser(cfg, token)) {
                                case None =>
                                    writeDetail(response, 401, "Invalid or expired token")
                                    return None
                                case Some(userId) =>
                                    return Some(userId)
                            }
                    }
            }
    }
}

/*
 * Look up the session row for this bearer token and return its user_id when
 * the session is live and the user is active. The WHERE clause mirrors
 * UserSession.isValidAt (revoked_at IS NULL AND expires_at > now) joined with
 * User.isActive (u.active = 1).
 *
 * Both expires_at and NOW(6) are session-clock timestamps (the column is
 * timestamp(6)), so the comparison needs no timezone shift.
 */
private func activeSessionUser(cfg: AppConfig, token: String): ?Array<Byte> {
    let tokenHash = bytesToHex(sha256Bytes(token.toArray()))
    match (openDb(cfg)) {
        case None => return None
        case Some(conn) =>
            let sql = "SELECT s.user_id FROM user_sessions s" +
                " JOIN users u ON u.id = s.user_id" +
                " WHERE s.token_hash=" + sqlQuote(tokenHash) +
                " AND s.revoked_at IS NULL" +
                " AND s.expires_at > NOW(6)" +
                " AND u.active=1 LIMIT 1"
            var out: ?Array<Byte> = None
            match (conn.query(sql)) {
                case QueryOutcome.Ok(_) => ()
                case QueryOutcome.ResultSet(rs) =>
                    if (!rs.rows.isEmpty()) {
                        out = Some(rs.rows[0][0].bytes)
                    }
            }
            conn.close()
            return out
    }
}

public func routeParam(request: HttpRequest, name: String): ?String {
    request.routeValues.get(name)
}

public func queryParam(request: HttpRequest, name: String): ?String {
    request.query.get(name)
}

/* Field alias helper matching the Python AliasChoices behaviour. */
public func fieldByAlias(obj: JsonObject, snake: String, camel: String): ?JsonValue {
    match (obj.get(snake)) {
        case Some(v) => return Some(v)
        case None => return obj.get(camel)
    }
}

public func strField(obj: JsonObject, snake: String, camel: String): ?String {
    match (fieldByAlias(obj, snake, camel)) {
        case None => return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsString => return Some(v.asString().getValue())
                case _ => return None
            }
    }
}

public func intField(obj: JsonObject, snake: String, camel: String): ?Int64 {
    match (fieldByAlias(obj, snake, camel)) {
        case None => return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsInt => return Some(v.asInt().getValue())
                case JsonKind.JsString => return Int64.tryParse(v.asString().getValue())
                case _ => return None
            }
    }
}

public func stringArrayField(obj: JsonObject, snake: String, camel: String): ?Array<String> {
    match (fieldByAlias(obj, snake, camel)) {
        case None => return None
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsArray =>
                    let arr = v.asArray()
                    let out = ArrayList<String>()
                    var i: Int64 = 0
                    while (i < arr.size()) {
                        match (arr.get(i)) {
                            case Some(item) =>
                                match (item.kind()) {
                                    case JsonKind.JsString => out.add(item.asString().getValue())
                                    case _ => ()
                                }
                            case None => ()
                        }
                        i += 1
                    }
                    return Some(out.toArray())
                case _ => return None
            }
    }
}

/* Three-state outcome for optional UUID fields: absent / null / valid-or-invalid. */
public enum UuidFieldKind {
    Missing | Present | Invalid
}

public struct UuidFieldResult {
    public let kind: UuidFieldKind
    public let value: ?Array<Byte>

    public init(kind: UuidFieldKind, value: ?Array<Byte>) {
        this.kind = kind
        this.value = value
    }
}

public func uuidField(obj: JsonObject, snake: String, camel: String): UuidFieldResult {
    match (fieldByAlias(obj, snake, camel)) {
        case None => return UuidFieldResult(UuidFieldKind.Missing, None)
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsNull => return UuidFieldResult(UuidFieldKind.Present, None)
                case JsonKind.JsString =>
                    let text = v.asString().getValue()
                    match (uuidParse(text)) {
                        case None => return UuidFieldResult(UuidFieldKind.Invalid, None)
                        case Some(bytes) => return UuidFieldResult(UuidFieldKind.Present, Some(bytes))
                    }
                case _ => return UuidFieldResult(UuidFieldKind.Invalid, None)
            }
    }
}
