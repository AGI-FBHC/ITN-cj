package itn_desktop_core.db

import std.collection.*
import std.fs.*
import itn_desktop_core.util.*

/*
 * 表结构。
 *
 * 全部 IF NOT EXISTS，每次打开数据库都跑一遍，所以升级版本时新增表不需要单独的
 * 迁移脚本，只要在这里追加一条语句。
 *
 * 约定：表名/列名只用 ASCII，值一律走绑定参数；键值类的三张表 (meta/settings/profile)
 * 结构相同，共用 Db 的 putKv/getKv。
 */
let ddl = [
    "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
    "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)",
    "CREATE TABLE IF NOT EXISTS profile (k TEXT PRIMARY KEY, v TEXT)",
    "CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, api_key TEXT, model TEXT, " +
    "vision_model TEXT, embedding_model TEXT, capabilities TEXT, ord INTEGER)",
    "CREATE TABLE IF NOT EXISTS roles (kind TEXT PRIMARY KEY, model_id TEXT)",
    "CREATE TABLE IF NOT EXISTS knowledge_bases (id TEXT PRIMARY KEY, name TEXT, root_dir TEXT, source_path TEXT, " +
    "doc_count INTEGER, " +
    "chunk_count INTEGER, image_count INTEGER, built_at TEXT, ord INTEGER)",
    "CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, kb_id TEXT NOT NULL, chunk_key TEXT NOT NULL, " +
    "doc_path TEXT, doc_title TEXT, heading_path TEXT, ord INTEGER, text TEXT, caption TEXT, caption_error TEXT, images TEXT)",
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_chunks_key ON chunks (kb_id, chunk_key)",
    "CREATE INDEX IF NOT EXISTS ix_chunks_kb ON chunks (kb_id, ord)",
    "CREATE TABLE IF NOT EXISTS embeddings (chunk_id INTEGER PRIMARY KEY, kb_id TEXT NOT NULL, dim INTEGER, vec BLOB)",
    "CREATE INDEX IF NOT EXISTS ix_embeddings_kb ON embeddings (kb_id)",
    "CREATE TABLE IF NOT EXISTS progress (kb_id TEXT NOT NULL, kind TEXT NOT NULL, item_key TEXT NOT NULL, at TEXT, " +
    "PRIMARY KEY (kb_id, kind, item_key))",
    "CREATE TABLE IF NOT EXISTS chapter_done (kb_id TEXT NOT NULL, chapter TEXT NOT NULL, at TEXT, PRIMARY KEY (kb_id, chapter))",
    "CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, kb_id TEXT, chapter TEXT, title TEXT, text TEXT, created_at TEXT)",
    "CREATE INDEX IF NOT EXISTS ix_notes_kb ON notes (kb_id, chapter)",
    "CREATE TABLE IF NOT EXISTS quiz_records (id TEXT PRIMARY KEY, kb_id TEXT, chapter TEXT, question TEXT, my_answer TEXT, " +
    "reference TEXT, correct INTEGER, created_at TEXT, ord INTEGER)",
    "CREATE INDEX IF NOT EXISTS ix_quiz_kb ON quiz_records (kb_id, chapter)",
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS sessions_meta (k TEXT PRIMARY KEY, v TEXT)",
    "CREATE TABLE IF NOT EXISTS session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts TEXT, " +
    "kind TEXT, turn_id TEXT, payload TEXT)",
    "CREATE INDEX IF NOT EXISTS ix_session_events ON session_events (session_id, id)",
    // 会话列表要"每段会话的第一个 user/message（标题）与第一个 turn/start（类型）"。
    // 没这条索引就是全表扫 8000+ 行、逐行解 payload，21MB 的库上每拉一次列表就卡一下。
    "CREATE INDEX IF NOT EXISTS ix_session_events_kind ON session_events (kind, id)",
    "CREATE TABLE IF NOT EXISTS learning_resources (id TEXT PRIMARY KEY, kind TEXT, title TEXT, kb_id TEXT, latest_version INTEGER, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS learning_resource_versions (resource_id TEXT, version INTEGER, body TEXT, PRIMARY KEY (resource_id, version))",
    "CREATE TABLE IF NOT EXISTS learning_memories (id TEXT PRIMARY KEY, kb_id TEXT, body TEXT, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS learning_events (id TEXT PRIMARY KEY, kind TEXT, kb_id TEXT, resource_id TEXT, version INTEGER, item_key TEXT, topic TEXT, correct INTEGER, first_attempt INTEGER, payload TEXT, at TEXT)",
    "CREATE INDEX IF NOT EXISTS ix_learning_events_resource ON learning_events (resource_id, version, item_key)",
    // 改动草稿：AI 写过的每个文件留一份原样（界面据此"看差异 / 撤销这次改动"）
    "CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, rel TEXT, " +
    "abs_path TEXT, existed INTEGER, add_n INTEGER, del_n INTEGER, created_at TEXT, state TEXT)",
    "CREATE INDEX IF NOT EXISTS ix_drafts_session ON drafts (session_id, state)",
    "CREATE TABLE IF NOT EXISTS desktop_jobs (id TEXT PRIMARY KEY, kind TEXT, status TEXT, body TEXT, result TEXT, error TEXT, created_at TEXT)"
]

public func ensureSchema(db: Db): Unit {
    for (sql in ddl) {
        db.exec(sql)
    }
    /*
     * 会话树：每条事件记下"它接在哪条后面"（parent_id = 父事件 id，0 = 根）。
     *
     * 老库没有这一列，加一次；已经有了会抛，忽略即可 —— 与 store.cj 里加列的做法一致。
     * 有了它，"改一条重发"就不再是删数据，只是把这段会话的末端（leaf）挪到别处，
     * 被放弃的那条线仍然留在库里、可以在会话树里切回来。
     */
    try {
        db.exec("ALTER TABLE session_events ADD COLUMN parent_id INTEGER")
    } catch (e: Exception) {
        ()
    }
}

/** 迁移标记：每个模块自己一段，迁移完置位，不会重复导入。 */
public func migrationDone(db: Db, name: String): Bool {
    return db.getKv("meta", "migrated_" + name, "") == "1"
}

public func markMigrationDone(db: Db, name: String): Unit {
    db.putKv("meta", "migrated_" + name, "1")
}

/*
 * 老文件保留副本，不删除：迁移出问题时原始数据还在。
 *
 * 标准库这版没有 File.copy / Directory.copy，所以按字节读写来复制；
 * 目标文件已存在就不覆盖，避免第二次运行时把首次的备份冲掉。
 */
func copyFileIfMissing(from: String, to: String): Unit {
    if (!exists(from) || exists(to)) {
        return
    }
    try {
        File.writeTo(to, File.readFrom(from))
    } catch (e: Exception) {
        ()
    }
}

/** 老文件改名保留，不删除：迁移出问题时原始数据还在。 */
public func archiveLegacy(path: String): Unit {
    copyFileIfMissing(path, path + ".migrated")
}

/** 目录形态的老数据（sessions/）逐个文件留副本。 */
public func archiveLegacyDir(dir: String): Unit {
    if (!exists(dir)) {
        return
    }
    try {
        Directory.walk(Path(dir), { fi: FileInfo =>
            if (!fi.isDirectory()) {
                copyFileIfMissing(dir + Path.Separator + fi.name, dir + Path.Separator + fi.name + ".migrated")
            }
            true
        })
    } catch (e: Exception) {
        ()
    }
}
