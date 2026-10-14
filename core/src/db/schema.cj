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
    "CREATE TABLE IF NOT EXISTS session_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts TEXT, " +
    "kind TEXT, turn_id TEXT, payload TEXT)",
    "CREATE INDEX IF NOT EXISTS ix_session_events ON session_events (session_id, id)"
]

public func ensureSchema(db: Db): Unit {
    for (sql in ddl) {
        db.exec(sql)
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
