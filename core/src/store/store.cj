package itn_desktop_core.store

import std.collection.*
import stdx.encoding.json.*
import itn_desktop_core.util.*

public func strValue(v: JsonValue): String {
    match (v) {
        case s: JsonString => s.getValue()
        case _ => ""
    }
}

public func strOf(o: JsonObject, key: String): String {
    match (o.get(key)) {
        case Some(v) => strValue(v)
        case None => ""
    }
}

public func objOf(v: JsonValue): ?JsonObject {
    match (v) {
        case o: JsonObject => Some(o)
        case _ => None
    }
}

public func arrOf(v: JsonValue): ?JsonArray {
    match (v) {
        case a: JsonArray => Some(a)
        case _ => None
    }
}

public func strArrayOf(o: JsonObject, key: String): ArrayList<String> {
    let out = ArrayList<String>()
    match (o.get(key)) {
        case Some(v) =>
            match (v) {
                case a: JsonArray =>
                    var i = 0
                    while (i < a.size()) {
                        out.add(strValue(a[i]))
                        i = i + 1
                    }
                case _ => ()
            }
        case None => ()
    }
    return out
}

public class ModelConfig {
    public var id: String = ""
    public var name: String = ""
    public var baseUrl: String = ""
    public var apiKey: String = ""
    public var model: String = ""
    public var visionModel: String = ""
    public var embeddingModel: String = ""
    public var capabilities: ArrayList<String> = ArrayList<String>()

    public init() {}

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("name", JsonString(name))
        o.put("baseUrl", JsonString(baseUrl))
        o.put("apiKey", JsonString(apiKey))
        o.put("model", JsonString(model))
        o.put("visionModel", JsonString(visionModel))
        o.put("embeddingModel", JsonString(embeddingModel))
        let caps = JsonArray()
        for (c in capabilities) {
            caps.add(JsonString(c))
        }
        o.put("capabilities", caps)
        return o
    }

    // 对外接口不回传密钥，只报告是否已设置
    public func toPublicJson(): JsonObject {
        let o = toJson()
        o.put("apiKey", JsonString(""))
        o.put("hasApiKey", JsonBool(apiKey.size > 0))
        return o
    }

    public static func fromJson(v: JsonValue): ModelConfig {
        let m = ModelConfig()
        match (objOf(v)) {
            case Some(vj) =>
                m.id = strOf(vj, "id")
                m.name = strOf(vj, "name")
                m.baseUrl = strOf(vj, "baseUrl")
                m.apiKey = strOf(vj, "apiKey")
                m.model = strOf(vj, "model")
                m.visionModel = strOf(vj, "visionModel")
                m.embeddingModel = strOf(vj, "embeddingModel")
                m.capabilities = strArrayOf(vj, "capabilities")
            case None => ()
        }
        return m
    }
}

public class Settings {
    public var models: ArrayList<ModelConfig> = ArrayList<ModelConfig>()
    public var chunkModelId: String = ""
    public var embedModelId: String = ""
    public var chatModelId: String = ""

    public init() {}

    public func findModel(id: String): ?ModelConfig {
        for (m in models) {
            if (m.id == id) {
                return Some(m)
            }
        }
        return None
    }

    public func toJson(): JsonObject {
        let o = JsonObject()
        let arr = JsonArray()
        for (m in models) {
            arr.add(m.toJson())
        }
        o.put("models", arr)
        o.put("chunkModelId", JsonString(chunkModelId))
        o.put("embedModelId", JsonString(embedModelId))
        o.put("chatModelId", JsonString(chatModelId))
        return o
    }

    public static func fromJson(v: JsonValue): Settings {
        let s = Settings()
        match (objOf(v)) {
            case Some(vj) =>
                s.chunkModelId = strOf(vj, "chunkModelId")
                s.embedModelId = strOf(vj, "embedModelId")
                s.chatModelId = strOf(vj, "chatModelId")
                match (vj.get("models")) {
                    case Some(mv) =>
                        match (mv) {
                            case arr: JsonArray =>
                                var i = 0
                                while (i < arr.size()) {
                                    s.models.add(ModelConfig.fromJson(arr[i]))
                                    i = i + 1
                                }
                            case _ => ()
                        }
                    case None => ()
                }
            case None => ()
        }
        return s
    }
}

public class Store {
    public let dataDir: String
    public let settingsPath: String

    public init(dataDir: String) {
        this.dataDir = dataDir
        this.settingsPath = dataDir + "\\settings.json"
    }

    public func ensure(): Unit {
        ensureDir(dataDir)
    }

    public func load(): Settings {
        ensure()
        let raw = readTextOr(settingsPath, "")
        if (raw.size == 0) {
            return Settings()
        }
        try {
            return Settings.fromJson(JsonValue.fromStr(raw))
        } catch (e: Exception) {
            return Settings()
        }
    }

    public func save(s: Settings): Unit {
        ensure()
        writeText(settingsPath, s.toJson().toString())
    }
}
