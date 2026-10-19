package itn_desktop_core.unittests

import std.collection.*
import std.fs.*
import std.time.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*
import stdx.net.http.*
import itn_desktop_core.api.buildServer
import itn_desktop_core.agent.*
import itn_desktop_core.db.*
import itn_desktop_core.store.*
import itn_desktop_core.tts.*
import itn_desktop_core.util.*

func ttsTestModel(port: Int64, protocol: String): ModelConfig {
    let cfg = ModelConfig()
    cfg.id = "tts-test"
    cfg.name = "TTS 测试"
    cfg.baseUrl = "http://127.0.0.1:" + port.toString() + "/v1"
    cfg.apiKey = "test-key"
    cfg.ttsModel = if (protocol == "mimo") { "mimo-v2.5-tts" } else { "tts-1" }
    cfg.ttsVoice = if (protocol == "mimo") { "苏打" } else { "alloy" }
    cfg.ttsFormat = "wav"
    cfg.ttsProtocol = protocol
    return cfg
}

@Test
func ttsConfigurationRoundTripsAndBindsAsRole(): Unit {
    let dir = freshDir("tts-store")
    let s = Store(dir).load()
    let m = ModelConfig()
    m.id = "mimo-tts"
    m.name = "MiMo 朗读"
    m.baseUrl = "https://example.invalid/v1"
    m.apiKey = "secret"
    m.ttsModel = "mimo-v2.5-tts"
    m.ttsVoice = "茉莉"
    m.ttsFormat = "wav"
    m.ttsProtocol = "mimo"
    s.models.add(m)
    s.ttsModelId = m.id
    Store(dir).save(s)

    let loaded = Store(dir).load()
    @Expect(loaded.ttsModelId, "mimo-tts")
    @Expect(loaded.models.size, 1)
    @Expect(loaded.models[0].ttsModel, "mimo-v2.5-tts")
    @Expect(loaded.models[0].ttsVoice, "茉莉")
    @Expect(loaded.models[0].ttsFormat, "wav")
    @Expect(loaded.models[0].ttsProtocol, "mimo")
}

@Test
func legacyModelTableGetsTtsColumnsWithoutLosingRows(): Unit {
    let dir = freshDir("tts-legacy-columns")
    let store = Store(dir)
    store.ensure()
    let db = DbHub.open(dir)
    db.exec("DROP TABLE models")
    db.exec("CREATE TABLE models (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, api_key TEXT, model TEXT, vision_model TEXT, embedding_model TEXT, capabilities TEXT, ord INTEGER)")
    db.run("INSERT INTO models (id,name,base_url,api_key,model,vision_model,embedding_model,capabilities,ord) VALUES (?,?,?,?,?,?,?,?,?)",
        va([tv("legacy"), tv("旧模型"), tv("http://localhost/v1"), tv("key"), tv("chat"), tv(""), tv(""), tv(""), nv(0)]))

    let loaded = store.load()
    @Expect(loaded.models.size, 1)
    @Expect(loaded.models[0].id, "legacy")
    @Expect(loaded.models[0].ttsModel, "")
    @Expect(loaded.models[0].ttsVoice, "")
    @Expect(loaded.models[0].ttsFormat, "")
    @Expect(loaded.models[0].ttsProtocol, "")
}

@Test
func openAiSpeechAndLuminToolWriteAnAudioFile(): Unit {
    let requests = ArrayList<JsonObject>()
    let server = ServerBuilder().addr("127.0.0.1").port(0).build()
    server.distributor.register("/v1/audio/speech", { ctx: HttpContext =>
        requests.add(objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow())
        ctx.responseBuilder.status(200)
        ctx.responseBuilder.header("Content-Type", "audio/wav")
        ctx.responseBuilder.body("RIFF-openai-test-audio".toArray())
    })
    spawn { server.serve() }
    sleep(Duration.millisecond * 150)

    try {
        let cfg = ttsTestModel(Int64(server.port), "openai")
        let audio = synthesizeSpeech(cfg, "你好，小鼋龙", "")
        @Expect(audio.format, "wav")
        @Expect(audio.mimeType, "audio/wav")
        @Expect(audio.voice, "alloy")
        @Expect(audio.protocol, "openai")
        @Expect(String.fromUtf8(audio.bytes), "RIFF-openai-test-audio")
        @Expect(requests.size, 1)
        @Expect(strOf(requests[0], "model"), "tts-1")
        @Expect(strOf(requests[0], "input"), "你好，小鼋龙")
        @Expect(strOf(requests[0], "voice"), "alloy")
        @Expect(strOf(requests[0], "response_format"), "wav")

        let dir = freshDir("tts-tool")
        let store = Store(dir)
        let s = store.load()
        s.models.add(cfg)
        s.ttsModelId = cfg.id
        store.save(s)
        let defs = buildDomainToolDefs(store, "", true)
        var speechTool: ?DomainTool = None
        for (d in defs) {
            if (d.name == "synthesize_speech") { speechTool = Some(d) }
        }
        match (speechTool) {
            case Some(tool) =>
                let args = JsonObject()
                args.put("text", JsonString("工具朗读测试"))
                let result = tool.run(args)
                @Expect(result.ok, true)
                @Expect(result.summary.contains("已生成朗读音频"), true)
                match (objOf(result.details)) {
                    case Some(details) =>
                        let path = strOf(details, "path")
                        @Expect(path.contains("audio"), true)
                        @Expect(exists(path), true)
                        @Expect(File.readFrom(path).size > 0, true)
                    case None => @Expect(false, true)
                }
            case None => @Expect(false, true)
        }
    } finally {
        server.close()
    }
}

@Test
func mimoSseAudioChunksBecomeOneWaveFile(): Unit {
    let requests = ArrayList<JsonObject>()
    let server = ServerBuilder().addr("127.0.0.1").port(0).build()
    server.distributor.register("/v1/chat/completions", { ctx: HttpContext =>
        requests.add(objOf(JsonValue.fromStr(readAllString(ctx.request.body))).getOrThrow())
        let body = "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"AAAAAA==\"}}}]}\n\n" +
            "data: {\"choices\":[{\"delta\":{\"audio\":{\"data\":\"/////w==\"}}}]}\n\n" +
            "data: [DONE]\n\n"
        ctx.responseBuilder.status(200)
        ctx.responseBuilder.header("Content-Type", "text/event-stream")
        ctx.responseBuilder.body(body.toArray())
    })
    spawn { server.serve() }
    sleep(Duration.millisecond * 150)

    try {
        let cfg = ttsTestModel(Int64(server.port), "mimo")
        let audio = synthesizeSpeech(cfg, "测试语音块", "")
        @Expect(audio.format, "wav")
        @Expect(audio.protocol, "mimo")
        @Expect(audio.voice, "苏打")
        @Expect(audio.bytes.size, 52)
        @Expect(String.fromUtf8(audio.bytes[0..4]), "RIFF")
        @Expect(String.fromUtf8(audio.bytes[8..12]), "WAVE")
        @Expect(audio.bytes[44], UInt8(0))
        @Expect(audio.bytes[47], UInt8(0))
        @Expect(audio.bytes[48], UInt8(255))
        @Expect(audio.bytes[51], UInt8(255))
        @Expect(requests.size, 1)
        @Expect(strOf(requests[0], "model"), "mimo-v2.5-tts")
        @Expect(boolOf(requests[0], "stream"), true)
        match (objOf(requests[0].get("audio").getOrThrow())) {
            case Some(audioConfig) =>
                @Expect(strOf(audioConfig, "format"), "pcm16")
                @Expect(strOf(audioConfig, "voice"), "苏打")
            case None => @Expect(false, true)
        }
    } finally {
        server.close()
    }
}

@Test
func ttsRejectsMissingKeyAndUnboundToolExplainsHowToFixIt(): Unit {
    let cfg = ModelConfig()
    cfg.baseUrl = "http://127.0.0.1:1/v1"
    cfg.ttsModel = "tts-1"
    var missingKey = false
    try { synthesizeSpeech(cfg, "hello", "") }
    catch (e: Exception) { missingKey = e.message.contains("密钥") }
    @Expect(missingKey, true)

    let dir = freshDir("tts-unbound-tool")
    let defs = buildDomainToolDefs(Store(dir), "", true)
    var speechTool: ?DomainTool = None
    for (d in defs) {
        if (d.name == "synthesize_speech") { speechTool = Some(d) }
    }
    match (speechTool) {
        case Some(tool) =>
            let args = JsonObject()
            args.put("text", JsonString("hello"))
            let result = tool.run(args)
            @Expect(result.ok, false)
            @Expect(result.summary.contains("还没有绑定朗读模型"), true)
        case None => @Expect(false, true)
    }
}

@Test
func rolePatchKeepsExistingTtsBinding(): Unit {
    let dir = freshDir("tts-role-patch")
    let store = Store(dir)
    let s = store.load()
    let chat = ModelConfig()
    chat.id = "chat"
    chat.name = "对话"
    chat.baseUrl = "https://example.invalid/v1"
    chat.model = "chat-model"
    let tts = ModelConfig()
    tts.id = "tts"
    tts.name = "朗读"
    tts.baseUrl = "https://example.invalid/v1"
    tts.ttsModel = "tts-1"
    s.models.add(chat)
    s.models.add(tts)
    s.chatModelId = "chat"
    s.ttsModelId = "tts"
    store.save(s)

    let server = buildServer(dir, dir + "/ui")
    spawn { server.serve() }
    sleep(Duration.millisecond * 150)
    let client = ClientBuilder().build()
    try {
        let req = HttpRequestBuilder()
            .method("POST")
            .url("http://127.0.0.1:" + server.port.toString() + "/api/models/roles")
            .header("Content-Type", "application/json")
            .body("{\"chatModelId\":\"chat\"}".toArray())
            .build()
        let resp = client.send(req)
        readAllString(resp.body)
        @Expect(resp.status, 200)
        let after = Store(dir).load()
        @Expect(after.chatModelId, "chat")
        @Expect(after.ttsModelId, "tts")
    } finally {
        client.close()
        server.close()
    }
}
