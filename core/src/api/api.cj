package itn_desktop_core.api

import stdx.net.http.*
import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.store.*
import itn_desktop_core.llm.*
import itn_desktop_core.util.*

public class Api {
    let store: Store

    public init(store: Store) {
        this.store = store
    }

    func send(ctx: HttpContext, status: UInt16, body: JsonValue): Unit {
        ctx.responseBuilder.status(status)
        ctx.responseBuilder.header("Content-Type", "application/json; charset=utf-8")
        ctx.responseBuilder.body(body.toString().toArray())
    }

    func ok(ctx: HttpContext, data: JsonValue): Unit {
        let o = JsonObject()
        o.put("code", JsonInt(0))
        o.put("data", data)
        send(ctx, 200, o)
    }

    func fail(ctx: HttpContext, status: UInt16, message: String): Unit {
        let o = JsonObject()
        o.put("code", JsonInt(1))
        o.put("message", JsonString(message))
        send(ctx, status, o)
    }

    func bodyJson(ctx: HttpContext): ?JsonObject {
        let raw = readAllString(ctx.request.body)
        if (raw.size == 0) {
            return None
        }
        try {
            return objOf(JsonValue.fromStr(raw))
        } catch (e: Exception) {
            return None
        }
    }

    func settingsJson(): JsonObject {
        let s = store.load()
        let o = s.toJson()
        let arr = JsonArray()
        for (m in s.models) {
            arr.add(m.toPublicJson())
        }
        o.put("models", arr)
        return o
    }

    public func handle(ctx: HttpContext): Unit {
        let path = ctx.request.url.path
        let method = ctx.request.method

        if (path == "/health" && method == "GET") {
            let o = JsonObject()
            o.put("status", JsonString("ok"))
            o.put("service", JsonString("itn-desktop-core"))
            o.put("cangjie", JsonString("1.2.0"))
            ok(ctx, o)
            return
        }

        if (path == "/api/settings" && method == "GET") {
            ok(ctx, settingsJson())
            return
        }

        if (path == "/api/models/save" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let s = store.load()
                    let incoming = ModelConfig.fromJson(b)
                    if (incoming.id.size == 0) {
                        fail(ctx, 400, "缺少 id")
                        return
                    }
                    var replaced = false
                    var i = 0
                    while (i < s.models.size) {
                        if (s.models[i].id == incoming.id) {
                            // 请求未带密钥时保留原密钥
                            if (incoming.apiKey.size == 0) {
                                incoming.apiKey = s.models[i].apiKey
                            }
                            s.models[i] = incoming
                            replaced = true
                        }
                        i = i + 1
                    }
                    if (!replaced) {
                        s.models.add(incoming)
                    }
                    store.save(s)
                    ok(ctx, settingsJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/models/delete" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    let s = store.load()
                    let kept = ArrayList<ModelConfig>()
                    for (m in s.models) {
                        if (m.id != id) {
                            kept.add(m)
                        }
                    }
                    s.models = kept
                    if (s.chatModelId == id) { s.chatModelId = "" }
                    if (s.embedModelId == id) { s.embedModelId = "" }
                    if (s.chunkModelId == id) { s.chunkModelId = "" }
                    store.save(s)
                    ok(ctx, settingsJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/models/roles" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let s = store.load()
                    s.chatModelId = strOf(b, "chatModelId")
                    s.embedModelId = strOf(b, "embedModelId")
                    s.chunkModelId = strOf(b, "chunkModelId")
                    store.save(s)
                    ok(ctx, settingsJson())
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/models/test" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let id = strOf(b, "id")
                    match (store.load().findModel(id)) {
                        case Some(cfg) =>
                            let client = LlmClient(cfg)
                            client.selfTest()
                            ok(ctx, JsonString("连通"))
                        case None => fail(ctx, 404, "找不到模型配置：" + id)
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        if (path == "/api/chat" && method == "POST") {
            match (bodyJson(ctx)) {
                case Some(b) =>
                    let s = store.load()
                    let modelId = strOf(b, "modelId")
                    let effectiveId = if (modelId.size > 0) { modelId } else { s.chatModelId }
                    match (s.findModel(effectiveId)) {
                        case Some(cfg) =>
                            let client = LlmClient(cfg)
                            let reply = client.chat(strOf(b, "system"), strOf(b, "user"))
                            let o = JsonObject()
                            o.put("reply", JsonString(reply))
                            o.put("modelId", JsonString(effectiveId))
                            ok(ctx, o)
                        case None => fail(ctx, 400, "没有可用的对话模型，请先在设置里配置并指定")
                    }
                case None => fail(ctx, 400, "请求体不是合法 JSON")
            }
            return
        }

        fail(ctx, 404, "未知接口：" + method + " " + path)
    }
}

public func buildServer(dataDir: String): Server {
    let server = ServerBuilder().addr("127.0.0.1").port(0).build()
    let api = Api(Store(dataDir))
    // 默认分发器按精确路径匹配，所有路由必须显式注册
    let routes = [
        "/health",
        "/api/settings",
        "/api/models/save",
        "/api/models/delete",
        "/api/models/roles",
        "/api/models/test",
        "/api/chat"
    ]
    for (r in routes) {
        server.distributor.register(r, { ctx: HttpContext => api.handle(ctx) })
    }
    return server
}
