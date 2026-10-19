package itn_desktop_core.tts

import std.collection.*
import std.convert.*
import std.fs.*
import std.io.*
import std.time.*
import stdx.encoding.base64.*
import stdx.encoding.json.*
import stdx.net.http.*
import stdx.net.tls.*
import stdx.net.tls.common.*
import itn_desktop_core.store.*
import itn_desktop_core.util.*

public class TtsException <: Exception {
    public init(message: String) {
        super(message)
    }
}

public class SpeechAudio {
    public var bytes: Array<UInt8> = Array<UInt8>()
    public var format: String = "wav"
    public var mimeType: String = "audio/wav"
    public var voice: String = ""
    public var protocol: String = ""

    public init() {}
}

func ttsEndpoint(baseUrl: String, path: String): String {
    var base = trimStr(baseUrl)
    while (base.size > 0 && hasSuffix(base, "/")) {
        base = String.fromUtf8(base.toArray()[0..(base.toArray().size - 1)])
    }
    return base + path
}

func ttsHostOf(url: String): String {
    let b = url.toArray()
    var i = 0
    while (i + 2 < b.size) {
        if (b[i] == 58 && b[i + 1] == 47 && b[i + 2] == 47) {
            i = i + 3
            break
        }
        i = i + 1
    }
    let start = i
    var end = b.size
    var j = i
    while (j < b.size) {
        if (b[j] == 47 || b[j] == 58) {
            end = j
            break
        }
        j = j + 1
    }
    return String.fromUtf8(b[start..end])
}

func readHttpBytes(input: InputStream): Array<UInt8> {
    let out = ArrayList<UInt8>()
    let buf = Array<UInt8>(8192, repeat: 0)
    while (true) {
        let n = input.read(buf)
        if (n <= 0) {
            break
        }
        var i = 0
        while (i < n) {
            out.add(buf[i])
            i = i + 1
        }
    }
    return out.toArray()
}

func errorText(bytes: Array<UInt8>): String {
    if (bytes.size == 0) {
        return "（响应体为空）"
    }
    var text = ""
    try {
        text = trimStr(String.fromUtf8(bytes))
    } catch (e: Exception) {
        return "（响应不是文本）"
    }
    if (text.size > 220) {
        return byteSafePrefix(text, 220) + "…"
    }
    return text
}

func nestedText(v: JsonValue, path: Array<String>): String {
    var cur = v
    for (key in path) {
        match (cur) {
            case obj: JsonObject =>
                match (obj.get(key)) {
                    case Some(next) => cur = next
                    case None => return ""
                }
            case arr: JsonArray =>
                let idx = Int64.parse(key)
                if (idx < 0 || idx >= arr.size()) {
                    return ""
                }
                cur = arr[idx]
            case _ => return ""
        }
    }
    match (cur) {
        case text: JsonString => return text.getValue()
        case _ => return ""
    }
}

func appendBase64(target: ArrayList<UInt8>, encoded: String): Bool {
    let clean = encoded.replace("\r", "").replace("\n", "").replace(" ", "")
    if (clean.size == 0) {
        return false
    }
    match (fromBase64String(clean)) {
        case Some(bytes) =>
            for (b in bytes) {
                target.add(b)
            }
            return bytes.size > 0
        case None => return false
    }
}

func writeLe16(out: Array<UInt8>, at: Int64, value: Int64): Unit {
    out[at] = UInt8(value & 0xFF)
    out[at + 1] = UInt8((value >> 8) & 0xFF)
}

func writeLe32(out: Array<UInt8>, at: Int64, value: Int64): Unit {
    out[at] = UInt8(value & 0xFF)
    out[at + 1] = UInt8((value >> 8) & 0xFF)
    out[at + 2] = UInt8((value >> 16) & 0xFF)
    out[at + 3] = UInt8((value >> 24) & 0xFF)
}

func wavFromPcm(pcm: Array<UInt8>, sampleRate: Int64): Array<UInt8> {
    let out = Array<UInt8>(pcm.size + 44, repeat: 0)
    let asciiRiff = [82, 73, 70, 70]
    let asciiWave = [87, 65, 86, 69]
    let asciiFmt = [102, 109, 116, 32]
    let asciiData = [100, 97, 116, 97]
    var i = 0
    while (i < 4) {
        out[i] = UInt8(asciiRiff[i])
        out[8 + i] = UInt8(asciiWave[i])
        out[12 + i] = UInt8(asciiFmt[i])
        out[36 + i] = UInt8(asciiData[i])
        i = i + 1
    }
    writeLe32(out, 4, Int64(pcm.size + 36))
    writeLe32(out, 16, 16)
    writeLe16(out, 20, 1)
    writeLe16(out, 22, 1)
    writeLe32(out, 24, sampleRate)
    writeLe32(out, 28, sampleRate * 2)
    writeLe16(out, 32, 2)
    writeLe16(out, 34, 16)
    writeLe32(out, 40, Int64(pcm.size))
    i = 0
    while (i < pcm.size) {
        out[44 + i] = pcm[i]
        i = i + 1
    }
    return out
}

func mimeFor(format: String): String {
    if (format == "mp3") { return "audio/mpeg" }
    if (format == "opus") { return "audio/ogg" }
    if (format == "aac") { return "audio/aac" }
    if (format == "flac") { return "audio/flac" }
    if (format == "pcm" || format == "pcm16") { return "audio/L16;rate=24000;channels=1" }
    return "audio/wav"
}

func normalizedProtocol(cfg: ModelConfig): String {
    let p = trimStr(cfg.ttsProtocol).toAsciiLower()
    if (p == "mimo" || p == "openai") {
        return p
    }
    if (cfg.ttsModel.toAsciiLower().contains("mimo") || cfg.model.toAsciiLower().contains("mimo")) {
        return "mimo"
    }
    return "openai"
}

func normalizedVoice(cfg: ModelConfig, protocol: String, requested: String): String {
    let voice = if (trimStr(requested).size > 0) { trimStr(requested) } else { trimStr(cfg.ttsVoice) }
    if (voice.size > 0) {
        return voice
    }
    return if (protocol == "mimo") { "苏打" } else { "alloy" }
}

func openAiSpeech(cfg: ModelConfig, text: String, voice: String): SpeechAudio {
    var format = trimStr(cfg.ttsFormat).toAsciiLower()
    if (format.size == 0 || format == "pcm16") {
        format = "mp3"
    }
    let payload = JsonObject()
    payload.put("model", JsonString(if (cfg.ttsModel.size > 0) { cfg.ttsModel } else { cfg.model }))
    payload.put("input", JsonString(text))
    payload.put("voice", JsonString(voice))
    payload.put("response_format", JsonString(format))
    payload.put("speed", JsonFloat(1.0))
    let url = ttsEndpoint(cfg.baseUrl, "/audio/speech")
    var tls = TlsClientConfig()
    tls.serverName = Some(ttsHostOf(url))
    tls.supportedAlpnProtocols = ["http/1.1"]
    let client = ClientBuilder().tlsConfig(tls).readTimeout(Duration.second * 120).writeTimeout(Duration.second * 120).build()
    try {
        let req = HttpRequestBuilder()
            .method("POST")
            .url(url)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + cfg.apiKey)
            .header("Accept", "audio/*, application/octet-stream")
            .body(payload.toString())
            .build()
        let resp = client.send(req)
        let bytes = readHttpBytes(resp.body)
        if (resp.status != 200) {
            throw TtsException("TTS 接口返回 " + resp.status.toString() + "：" + errorText(bytes))
        }
        if (bytes.size == 0) {
            throw TtsException("TTS 接口返回了空音频")
        }
        let audio = SpeechAudio()
        audio.bytes = bytes
        audio.format = format
        audio.mimeType = mimeFor(format)
        audio.voice = voice
        audio.protocol = "openai"
        return audio
    } catch (e: TtsException) {
        throw e
    } catch (e: Exception) {
        throw TtsException("请求 TTS 失败：" + e.message)
    } finally {
        client.close()
    }
}

func mimSpeech(cfg: ModelConfig, text: String, voice: String): SpeechAudio {
    let instruction = "请忠实使用所选预设音色朗读，保持音色、音高和情绪稳定；使用自然语速、清晰吐字。外部播放器会单独处理速度，不要改变音色或韵律。"
    let userMsg = JsonObject()
    userMsg.put("role", JsonString("user"))
    userMsg.put("content", JsonString(instruction))
    let speechMsg = JsonObject()
    speechMsg.put("role", JsonString("assistant"))
    speechMsg.put("content", JsonString(text))
    let messages = JsonArray()
    messages.add(userMsg)
    messages.add(speechMsg)
    let audioCfg = JsonObject()
    audioCfg.put("format", JsonString("pcm16"))
    audioCfg.put("voice", JsonString(voice))
    let payload = JsonObject()
    payload.put("model", JsonString(if (cfg.ttsModel.size > 0) { cfg.ttsModel } else { "mimo-v2.5-tts" }))
    payload.put("messages", messages)
    payload.put("audio", audioCfg)
    payload.put("stream", JsonBool(true))
    let url = ttsEndpoint(cfg.baseUrl, "/chat/completions")
    var tls = TlsClientConfig()
    tls.serverName = Some(ttsHostOf(url))
    tls.supportedAlpnProtocols = ["http/1.1"]
    let client = ClientBuilder().tlsConfig(tls).readTimeout(Duration.second * 120).writeTimeout(Duration.second * 120).build()
    try {
        let req = HttpRequestBuilder()
            .method("POST")
            .url(url)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + cfg.apiKey)
            .header("Accept", "text/event-stream, application/json")
            .body(payload.toString())
            .build()
        let resp = client.send(req)
        let raw = readHttpBytes(resp.body)
        if (resp.status != 200) {
            throw TtsException("TTS 接口返回 " + resp.status.toString() + "：" + errorText(raw))
        }
        let textBody = trimStr(String.fromUtf8(raw))
        let pcm = ArrayList<UInt8>()
        var parsedAny = false
        for (line in textBody.split("\n")) {
            let clean = trimStr(line)
            if (!hasPrefix(clean, "data:")) {
                continue
            }
            let data = trimStr(String.fromUtf8(clean.toArray()[5..clean.toArray().size]))
            if (data.size == 0 || data == "[DONE]") {
                continue
            }
            try {
                let chunk = JsonValue.fromStr(data)
                var encoded = nestedText(chunk, ["choices", "0", "delta", "audio", "data"])
                if (encoded.size == 0) {
                    encoded = nestedText(chunk, ["choices", "0", "message", "audio", "data"])
                }
                if (appendBase64(pcm, encoded)) {
                    parsedAny = true
                }
            } catch (e: Exception) {
                // 单条 SSE 解析失败不影响后续音频块。
            }
        }
        if (!parsedAny) {
            try {
                let whole = JsonValue.fromStr(textBody)
                var encoded = nestedText(whole, ["choices", "0", "message", "audio", "data"])
                if (encoded.size == 0) {
                    encoded = nestedText(whole, ["audio", "data"])
                }
                parsedAny = appendBase64(pcm, encoded)
            } catch (e: Exception) {
                ()
            }
        }
        if (!parsedAny || pcm.size == 0) {
            throw TtsException("TTS 接口没有返回可播放的音频数据")
        }
        let audio = SpeechAudio()
        audio.bytes = wavFromPcm(pcm.toArray(), 24000)
        audio.format = "wav"
        audio.mimeType = "audio/wav"
        audio.voice = voice
        audio.protocol = "mimo"
        return audio
    } catch (e: TtsException) {
        throw e
    } catch (e: Exception) {
        throw TtsException("请求 TTS 失败：" + e.message)
    } finally {
        client.close()
    }
}

public func synthesizeSpeech(cfg: ModelConfig, text: String, requestedVoice: String): SpeechAudio {
    let clean = trimStr(text)
    if (clean.size == 0) {
        throw TtsException("要朗读的文本为空")
    }
    if (clean.size > 4000) {
        throw TtsException("一次最多合成 4000 字，请分段后再试")
    }
    if (cfg.baseUrl.size == 0) {
        throw TtsException("TTS 接口地址为空")
    }
    if (cfg.apiKey.size == 0) {
        throw TtsException("TTS 密钥为空")
    }
    let protocol = normalizedProtocol(cfg)
    let voice = normalizedVoice(cfg, protocol, requestedVoice)
    if (protocol == "mimo") {
        return mimSpeech(cfg, clean, voice)
    }
    return openAiSpeech(cfg, clean, voice)
}

public func saveSpeech(dataDir: String, audio: SpeechAudio): String {
    let dir = dataDir + Path.Separator + "audio"
    ensureDir(dir)
    var ext = audio.format
    if (ext.size == 0) { ext = "wav" }
    var ms = DateTime.now().toUnixTimeStamp().toMilliseconds()
    var path = dir + Path.Separator + "tts-" + ms.toString() + "." + ext
    var n = 2
    while (exists(path)) {
        path = dir + Path.Separator + "tts-" + ms.toString() + "-" + n.toString() + "." + ext
        n = n + 1
    }
    File.writeTo(path, audio.bytes)
    return path
}

public func speechDataUrl(audio: SpeechAudio): String {
    return "data:" + audio.mimeType + ";base64," + toBase64String(audio.bytes)
}