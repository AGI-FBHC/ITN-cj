package itn_desktop_core.store

import std.collection.*
import std.fs.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.util.*

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

public class KnowledgeBase {
    public var id: String = ""
    public var name: String = ""
    public var rootDir: String = ""
    /** 这份资料是从哪儿来的（导入的原始路径）。重新导入同一处时用它认出来，不会又建一个库。 */
    public var sourcePath: String = ""
    public var docCount: Int64 = 0
    public var chunkCount: Int64 = 0
    public var imageCount: Int64 = 0
    public var builtAt: String = ""

    public init() {}

    public func toJson(): JsonObject {
        let o = JsonObject()
        o.put("id", JsonString(id))
        o.put("name", JsonString(name))
        o.put("rootDir", JsonString(rootDir))
        o.put("sourcePath", JsonString(sourcePath))
        o.put("docCount", JsonInt(docCount))
        o.put("chunkCount", JsonInt(chunkCount))
        o.put("imageCount", JsonInt(imageCount))
        o.put("builtAt", JsonString(builtAt))
        return o
    }

    public static func fromJson(v: JsonValue): KnowledgeBase {
        let b = KnowledgeBase()
        match (objOf(v)) {
            case Some(o) =>
                b.id = strOf(o, "id")
                b.name = strOf(o, "name")
                b.rootDir = strOf(o, "rootDir")
                b.sourcePath = strOf(o, "sourcePath")
                b.docCount = intOf(o, "docCount")
                b.chunkCount = intOf(o, "chunkCount")
                b.imageCount = intOf(o, "imageCount")
                b.builtAt = strOf(o, "builtAt")
            case None => ()
        }
        return b
    }
}

public class Settings {
    public var models: ArrayList<ModelConfig> = ArrayList<ModelConfig>()
    public var knowledgeBases: ArrayList<KnowledgeBase> = ArrayList<KnowledgeBase>()
    public var chunkModelId: String = ""
    public var embedModelId: String = ""
    public var chatModelId: String = ""

    public init() {}

    public func findKb(id: String): ?KnowledgeBase {
        for (b in knowledgeBases) {
            if (b.id == id) {
                return Some(b)
            }
        }
        return None
    }

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
        let kbs = JsonArray()
        for (b in knowledgeBases) {
            kbs.add(b.toJson())
        }
        o.put("knowledgeBases", kbs)
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
                match (vj.get("knowledgeBases")) {
                    case Some(kv) =>
                        match (kv) {
                            case ka: JsonArray =>
                                var i = 0
                                while (i < ka.size()) {
                                    s.knowledgeBases.add(KnowledgeBase.fromJson(ka[i]))
                                    i = i + 1
                                }
                            case _ => ()
                        }
                    case None => ()
                }
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

/*
 * 配置仓库。
 *
 * 模型接口、用途绑定、知识库登记三类数据落在 SQLite。对外签名与 JSON 时代完全一致，
 * 上层 (api.cj) 不需要改。
 */
public class Store {
    public let dataDir: String

    public init(dataDir: String) {
        this.dataDir = dataDir
    }

    private func db(): Db {
        return DbHub.open(dataDir)
    }

    public func ensure(): Unit {
        ensureDir(dataDir)
        // 新加的列要自己补：`CREATE TABLE IF NOT EXISTS` 不会给老库加列。
        // 已经有了就报错，忽略即可（幂等）。
        try {
            db().exec("ALTER TABLE knowledge_bases ADD COLUMN source_path TEXT")
        } catch (e: Exception) {
            ()
        }
    }

    public func load(): Settings {
        ensure()
        migrateFromJson()
        let s = Settings()
        s.chatModelId = roleOf("chat")
        s.embedModelId = roleOf("embed")
        s.chunkModelId = roleOf("chunk")
        for (r in db().querySql("SELECT id, name, base_url, api_key, model, vision_model, embedding_model, capabilities " +
            "FROM models ORDER BY ord")) {
            let m = ModelConfig()
            m.id = r.text(0)
            m.name = r.text(1)
            m.baseUrl = r.text(2)
            m.apiKey = r.text(3)
            m.model = r.text(4)
            m.visionModel = r.text(5)
            m.embeddingModel = r.text(6)
            m.capabilities = splitCsv(r.text(7))
            s.models.add(m)
        }
        for (r in db().querySql("SELECT id, name, root_dir, source_path, doc_count, chunk_count, image_count, built_at " +
            "FROM knowledge_bases ORDER BY ord")) {
            let b = KnowledgeBase()
            b.id = r.text(0)
            b.name = r.text(1)
            b.rootDir = r.text(2)
            b.sourcePath = r.text(3)
            b.docCount = r.int(4)
            b.chunkCount = r.int(5)
            b.imageCount = r.int(6)
            b.builtAt = r.text(7)
            s.knowledgeBases.add(b)
        }
        return s
    }

    public func save(s: Settings): Unit {
        ensure()
        let ops = ArrayList<DbOp>()
        ops.add(DbOp("DELETE FROM models", ArrayList<DbValue>()))
        var ord: Int64 = 0
        for (m in s.models) {
            ops.add(DbOp("INSERT INTO models (id, name, base_url, api_key, model, vision_model, embedding_model, capabilities, ord) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                va([tv(m.id), tv(m.name), tv(m.baseUrl), tv(m.apiKey), tv(m.model), tv(m.visionModel), tv(m.embeddingModel),
                    tv(joinCsv(m.capabilities)), nv(ord)])))
            ord += 1
        }
        ops.add(DbOp("DELETE FROM knowledge_bases", ArrayList<DbValue>()))
        ord = 0
        for (b in s.knowledgeBases) {
            ops.add(DbOp("INSERT INTO knowledge_bases (id, name, root_dir, source_path, doc_count, chunk_count, image_count, built_at, ord) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                va([tv(b.id), tv(b.name), tv(b.rootDir), tv(b.sourcePath), nv(b.docCount), nv(b.chunkCount), nv(b.imageCount), tv(b.builtAt), nv(ord)])))
            ord += 1
        }
        ops.add(DbOp("DELETE FROM roles", ArrayList<DbValue>()))
        if (s.chatModelId.size > 0) {
            ops.add(DbOp("INSERT INTO roles (kind, model_id) VALUES (?, ?)", va([tv("chat"), tv(s.chatModelId)])))
        }
        if (s.embedModelId.size > 0) {
            ops.add(DbOp("INSERT INTO roles (kind, model_id) VALUES (?, ?)", va([tv("embed"), tv(s.embedModelId)])))
        }
        if (s.chunkModelId.size > 0) {
            ops.add(DbOp("INSERT INTO roles (kind, model_id) VALUES (?, ?)", va([tv("chunk"), tv(s.chunkModelId)])))
        }
        db().batch(ops)
    }

    /** 一次性把 settings.json 导进数据库；导完保留 .migrated 副本，只导一次。 */
    private func migrateFromJson(): Unit {
        if (migrationDone(db(), "store")) {
            return
        }
        let path = dataDir + "\\settings.json"
        if (exists(path)) {
            let raw = readTextOr(path, "")
            if (raw.size > 0) {
                try {
                    save(Settings.fromJson(JsonValue.fromStr(raw)))
                } catch (e: Exception) {
                    ()
                }
            }
            archiveLegacy(path)
        }
        markMigrationDone(db(), "store")
    }

    /** 用途绑定在 roles 表里是 kind/model_id 两列，与 meta 那类 k/v 表不同。 */
    private func roleOf(kind: String): String {
        return db().scalarText("SELECT model_id FROM roles WHERE kind = ?", va([tv(kind)]))
    }

    private func splitCsv(text: String): ArrayList<String> {
        let out = ArrayList<String>()
        for (p in text.split(",")) {
            if (p.size > 0) {
                out.add(p)
            }
        }
        return out
    }

    private func joinCsv(items: ArrayList<String>): String {
        let sb = StringBuilder()
        var first = true
        for (it in items) {
            if (!first) {
                sb.append(",")
            }
            sb.append(it)
            first = false
        }
        return sb.toString()
    }
}
