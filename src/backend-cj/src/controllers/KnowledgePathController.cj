package web.controllers

import std.convert.*
import std.env.getVariables
import std.fs.*
import std.net.*
import std.time.*
import std.unicode.*
import stdx.net.http.ClientBuilder
import stdx.net.http.HttpRequestBuilder
import stdx.net.tls.TlsClientConfig
import soulsoft_web_http.*
import web.config.*
import web.domain.User
import web.exception.*
import web.service.*

public class KnowledgePathController {
    private let access: AccountAccessService
    private let paths: KnowledgePathService
    private let content: RagContentService
    private let figures: RagFigureService
    private let assetDirectory: String
    public init(database: DatabaseConfig, auth: AuthConfig) {
        access = AccountAccessService(database, auth)
        paths = KnowledgePathService(database)
        content = RagContentService(database)
        figures = RagFigureService(database)
        var folder = "../backend/data/knowledge-base/figures"
        for ((key, value) in getVariables()) { if (key == "RAG_ASSET_DIR" && !value.trim().isEmpty()) { folder = value } }
        assetDirectory = folder
    }
    public func path(context: HttpContext): Unit { handle(context, true, { user => paths.path(user.getOrThrow()) }) }
    public func graph(context: HttpContext): Unit { handle(context, true, { _ => paths.graph() }) }
    public func search(context: HttpContext): Unit { handle(context, true, { _ => paths.search(context.request.query.get("q").getOrDefault({ => "" })) }) }
    public func category(context: HttpContext): Unit { handle(context, false, { _ => content.category(routeNumber(context, "categoryId")) }) }
    public func chunks(context: HttpContext, categoryMode: Bool): Unit {
        handle(context, false, { _ => content.chunks(
            if (categoryMode) { Some(routeNumber(context, "categoryId")) } else { None },
            if (categoryMode) { None } else { Some(required(context, "q")) },
            number(context.request.query.get("page"), 0), number(context.request.query.get("size"), 20)) })
    }
    public func chunk(context: HttpContext, ragflowMode: Bool): Unit {
        handle(context, false, { _ => if (ragflowMode) { content.ragflow(parameter(context, "ragflowChunkId")) }
            else { content.chunk(routeNumber(context, "chunkId")) } })
    }
    public func document(context: HttpContext, codeMode: Bool): Unit {
        handle(context, false, { _ => content.document(if (codeMode) { None } else { Some(routeNumber(context, "documentId")) },
            if (codeMode) { Some(required(context, "code")) } else { None }) })
    }
    public func figure(context: HttpContext, single: Bool): Unit {
        handle(context, false, { _ => if (single) { figures.detail(routeNumber(context, "figureId")) }
            else { figures.list(context.request.query.get("q"), number(context.request.query.get("page"), 0), number(context.request.query.get("size"), 20)) } })
    }
    public func image(context: HttpContext): Unit {
        try {
            let info = figures.imageInfo(routeNumber(context, "figureId"))
            let image: Option<Array<UInt8>> = try {
                let root = canonicalize(assetDirectory)
                let file = canonicalize(root.join(info[0].getOrThrow()))
                let normalizedRoot = root.toString().replace("\\", "/").toLower(CasingOption.Other)
                let normalizedFile = file.toString().replace("\\", "/").toLower(CasingOption.Other)
                if (!normalizedFile.startsWith(normalizedRoot + "/")) { None } else { Some(File.readFrom(file)) }
            } catch (_: Exception) { None }
            if (let Some(bytes) <- image) {
                context.response.statusCode = 200
                context.response.contentType = info[1].getOrDefault({ => "application/octet-stream" })
                context.response.contentLength = Some(bytes.size)
                context.response.headers["Cache-Control"] = ["public, max-age=31536000, immutable"]
                context.response.write(bytes)
            } else { context.response.statusCode = 404 }
        } catch (e: BusinessException) { fail(context, e) }
        catch (e: Exception) { internal(context, e) }
    }
    public func remote(context: HttpContext): Unit {
        try {
            let url = required(context, "url")
            // Preserve the old proxy's fixed upstream host and port.
            let lower = url.toLower(CasingOption.Other)
            let prefix = if (lower.startsWith("https://")) { "https://113.249.110.108:28901" } else { "http://113.249.110.108:28901" }
            if (!(lower == prefix || lower.startsWith(prefix + "/") || lower.startsWith(prefix + "?") || lower.startsWith(prefix + "#")) ||
                url.contains("\\") || url.contains("\r") || url.contains("\n")) {
                context.response.statusCode = 400; return
            }
            let client = ClientBuilder().tlsConfig(TlsClientConfig()).readTimeout(Duration.second * 20)
                .writeTimeout(Duration.second * 20).connector({ address =>
                    let socket = TcpSocket(address)
                    try { socket.connect(timeout: Some(Duration.second * 5)); return socket }
                    catch (e: Exception) { socket.close(); throw e }
                }).build()
            try {
                let request = HttpRequestBuilder().method("GET").url(url).header("User-Agent", "Mozilla/5.0 ITN Knowledge Image Proxy").build()
                let response = client.send(request)
                if (response.status < 200 || response.status >= 300) { context.response.statusCode = response.status; return }
                context.response.statusCode = 200
                context.response.contentType = response.headers.getFirst("Content-Type").getOrDefault({ => "application/octet-stream" })
                context.response.headers["Cache-Control"] = ["public, max-age=604800"]
                let buffer = Array<UInt8>(65536, repeat: 0)
                while (true) {
                    let count = response.body.read(buffer)
                    if (count == 0) { break }
                    context.response.write(buffer.slice(0, count))
                }
            } finally { client.close() }
        } catch (e: BusinessException) { fail(context, e) }
        catch (e: Exception) { internal(context, e) }
    }
    private func handle(context: HttpContext, authenticated: Bool, work: (Option<User>) -> String): Unit {
        context.response.contentType = "application/json; charset=utf-8"
        try {
            let user: Option<User> = if (authenticated) { Some(access.authenticate(AccountAccessController.bearer(context))) } else { None }
            context.response.write(ProfileJson.wrap("success", Some(work(user))))
        } catch (e: BusinessException) { fail(context, e) }
        catch (e: Exception) { internal(context, e) }
    }
    private static func fail(context: HttpContext, e: BusinessException): Unit {
        context.response.statusCode = UInt16(e.status)
        context.response.contentType = "application/json; charset=utf-8"
        context.response.write(AuthController.errorJson(e.code, e.message))
    }
    private static func internal(context: HttpContext, e: Exception): Unit {
        println("Knowledge request failed: " + e.message)
        if (context.response.hasStarted) { return }
        context.response.statusCode = 500
        context.response.contentType = "application/json; charset=utf-8"
        context.response.write(AuthController.errorJson(ErrorCode.INTERNAL_ERROR, "服务器内部错误"))
    }
    private static func required(context: HttpContext, key: String): String {
        return context.request.query.get(key).getOrDefault({ => throw ProfileJson.invalid("缺少查询参数: " + key) })
    }
    private static func parameter(context: HttpContext, key: String): String {
        return context.request.routeValues.get(key).getOrDefault({ => throw ProfileJson.invalid("缺少路由参数: " + key) })
    }
    private static func number(value: Option<String>, fallback: Int64): Int64 {
        if (let Some(text) <- value) {
            try { return Int64.parse(text) } catch (_: Exception) { throw ProfileJson.invalid("参数必须是整数") }
        }
        return fallback
    }
    private static func routeNumber(context: HttpContext, key: String): Int64 { return number(Some(parameter(context, key)), 0) }
}
