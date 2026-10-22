package zhixun_learning

import std.collection.*
import std.core.*
import std.fs.*
import std.sync.*

/**
 * 原文、图片先持久化，再由 Agent 整理；摘要和向量交给持久化队列。
 * 只有原文可靠保存后才清理上传包和临时目录，失败可从数据库与最终图片重建输入。
 */
class KbBundleDoc {
    let title: String
    let content: String
    let sourcePath: String

    init(title: String, content: String, sourcePath: String) {
        this.title = title
        this.content = content
        this.sourcePath = sourcePath
    }
}

func kbWorkRoot(cfg: Config): String {
    let base = envOr("ZHIXUN_WORK_ROOT", "data/kb_work")
    if (!exists(Path(base))) { Directory.create(Path(base), recursive: true) }
    base
}

func kbBundleZipPath(cfg: Config, bundleId: String): String {
    kbWorkRoot(cfg) + "/" + bundleId + ".zip"
}

func kbRemoveBundleZip(cfg: Config, bundleId: String): Unit {
    try {
        let path = Path(kbBundleZipPath(cfg, bundleId))
        if (exists(path)) { remove(path) }
    } catch (_: Exception) {}
}

func kbBundleWorkDir(cfg: Config, bundleId: String): String {
    kbWorkRoot(cfg) + "/" + bundleId
}

func kbRemoveTree(path: String): Unit {
    if (!exists(Path(path))) { return }
    let entries = try {
        Directory.readFrom(Path(path))
    } catch (_: Exception) {
        return
    }
    for (entry in entries) {
        let full = path + "/" + entry.name
        var isDir = false
        try {
            Directory.readFrom(Path(full))
            isDir = true
        } catch (_: Exception) {
            isDir = false
        }
        if (isDir) {
            kbRemoveTree(full)
        } else {
            try { remove(Path(full)) } catch (_: Exception) {}
        }
    }
    try { remove(Path(path)) } catch (_: Exception) {}
}

func kbTitleFromFile(fileName: String): String {
    var name = fileName
    match (name.lastIndexOf(".")) {
        case Some(position) => name = name[0..position]
        case None => ()
    }
    // 去掉 01- / 01_ / 1. 这类排序前缀
    var cut: Int64 = 0
    let bytes = name.toArray()
    while (cut < bytes.size) {
        let ch = bytes[cut]
        if (ch >= 48 && ch <= 57) {
            cut += 1
        } else {
            break
        }
    }
    if (cut > 0 && cut < name.size) {
        let ch = bytes[cut]
        if (ch == 45 || ch == 95 || ch == 46 || ch == 32) {
            name = name[cut + 1..name.size]
        }
    }
    let trimmed = name.trimAscii()
    if (trimmed.size == 0) { fileName } else { trimmed }
}

func kbBundleTitleValid(value: String): Bool {
    let title = value.trimAscii()
    if (title.size == 0 || charCount(title) > 160) { return false }
    for (byte in title.toArray()) {
        let code = Int64(byte)
        if (code < 32 || code == 127) { return false }
    }
    true
}

/** Rename the bundle and its published/learning course as one operation. */
func kbRenameBundle(cfg: Config, bundleId: String, title: String): Bool {
    let rows = query(cfg, "SELECT COALESCE(course_id,'') course_id FROM kb_bundles WHERE id=" +
        sqlQuote(bundleId) + " LIMIT 1")
    if (rows.size == 0) { return false }
    let clean = title.trimAscii()
    let statements = ArrayList<String>()
    statements.add("UPDATE kb_bundles SET title=" + sqlQuote(clean) +
        ",updated_at=NOW(6) WHERE id=" + sqlQuote(bundleId))
    if (rows[0].text("course_id").size > 0) {
        statements.add("UPDATE courses SET name=" + sqlQuote(clean) +
            ",updated_at=NOW(6) WHERE id=" + sqlQuote(rows[0].text("course_id")))
    }
    transaction(cfg, statements.toArray())
    kbBumpVersion()
    true
}

/** 收集 out/ 下整理好的 Markdown，按文件名顺序作为章节顺序。 */
func kbCollectResult(workspace: KbWorkspace): ArrayList<KbBundleDoc> {
    let outDir = workspace.root + "/out"
    let files = ArrayList<String>()
    kbWalkFiles(outDir, "", files, 0)
    let docs = ArrayList<String>()
    for (file in files) {
        if (file.toAsciiLower().endsWith(".md") || file.toAsciiLower().endsWith(".markdown")) { docs.add(file) }
    }
    docs.sort()
    let result = ArrayList<KbBundleDoc>()
    for (file in docs) {
        let full = outDir + "/" + file
        let data = File.readFrom(Path(full))
        if (data.size == 0) { continue }
        let text = String.fromUtf8(data)
        let baseName = if (file.contains("/")) {
            file[file.lastIndexOf("/").getOrThrow() + 1..file.size]
        } else {
            file
        }
        result.add(KbBundleDoc(kbTitleFromFile(baseName), text, workspace.documentSources.get(file) ?? ""))
    }
    result
}

func kbBundleAssets(cfg: Config, bundleId: String, workDir: String, log: KbAgentLog): KbAssetFinalizer {
    let assets = KbAssetFinalizer(cfg, bundleId, workDir + "/in", log, true)
    let saved = query(cfg, "SELECT id,source_path FROM kb_bundle_assets WHERE bundle_id=" + sqlQuote(bundleId))
    for (asset in saved) {
        assets.saved[asset.text("source_path")] = "/api/admin/kb/bundles/" + bundleId + "/assets/" + asset.text("id")
    }
    assets
}

func kbSaveBundleWarnings(cfg: Config, bundleId: String, assets: KbAssetFinalizer): Unit {
    let warnings = JsonArrWriter()
    for (warning in assets.warnings) { warnings.addRaw(jsonQuote(warning)) }
    execute(cfg, "UPDATE kb_bundles SET warnings_json=" + sqlQuote(warnings.toJson()) + " WHERE id=" + sqlQuote(bundleId))
}

func kbSeedBundleSources(cfg: Config, bundleId: String, workDir: String, log: KbAgentLog): Unit {
    let files = ArrayList<String>()
    kbWalkFiles(workDir + "/in", "", files, 0)
    files.sort()
    let assets = kbBundleAssets(cfg, bundleId, workDir, log)
    var values = ""
    var count: Int64 = 0
    var batch: Int64 = 0
    for (file in files) {
        if (!kbIsSourceDocument(file)) { continue }
        let original = kbNormalizeWorkspaceSource(workDir + "/in/" + file)
        // Even empty supported files have an original record; they are not silently discarded.
        let content = assets.document(file, original)
        let base = match (file.lastIndexOf("/")) { case Some(pos) => file[pos + 1..file.size]; case None => file }
        let title = kbTitleFromFile(base)
        if (values.size > 0) { values += "," }
        values += "(" + sqlQuote(kbStableUuid("bundle-source:" + bundleId + ":" + file)) + "," + sqlQuote(bundleId) + "," +
            count.toString() + "," + sqlQuote(kbTruncate(title, 230)) + "," + sqlQuote(content) + "," +
            kbCharsBetween(content.toArray(), 0, content.size).toString() + "," + sqlQuote(file) + "," + sqlQuote(original) + ")"
        count += 1; batch += 1
        if (batch >= 20 || values.size >= 384000) {
            assets.flushMetadata()
            transaction(cfg, ["INSERT INTO kb_bundle_docs(id,bundle_id,order_index,title,content,char_count,source_path,original_content) VALUES " +
                values + " ON DUPLICATE KEY UPDATE original_content=VALUES(original_content),content=VALUES(content),char_count=VALUES(char_count)"])
            values = ""; batch = 0
        }
    }
    assets.flushMetadata()
    if (values.size > 0) {
        transaction(cfg, ["INSERT INTO kb_bundle_docs(id,bundle_id,order_index,title,content,char_count,source_path,original_content) VALUES " +
            values + " ON DUPLICATE KEY UPDATE original_content=VALUES(original_content),content=VALUES(content),char_count=VALUES(char_count)"])
    }
    if (count == 0) { throw Exception("资料包里没有可处理的 Markdown、文本或 RST 原文") }
    kbSaveBundleWarnings(cfg, bundleId, assets)
    execute(cfg, "UPDATE kb_bundles SET source_saved=1 WHERE id=" + sqlQuote(bundleId))
    log.add("原文已可靠保存：" + count.toString() + " 篇，包内图片 " + assets.saved.size.toString() + " 张；组织失败仍可恢复")
}

func kbRestoreBundleInput(cfg: Config, bundleId: String, workDir: String): Unit {
    let docs = query(cfg, "SELECT source_path,original_content FROM kb_bundle_docs WHERE bundle_id=" + sqlQuote(bundleId) + " ORDER BY order_index")
    if (docs.size == 0) { throw Exception("没有可恢复的原文，请重新上传资料包") }
    for (doc in docs) {
        if (doc.isNull("original_content") || doc.text("source_path").size == 0) { throw Exception("旧资料包没有保留原文来源，请重新上传") }
        let source = kbPathNormalize(doc.text("source_path"))
        kbWriteTextDeep(workDir + "/in/" + source, doc.text("original_content"))
    }
    let images = query(cfg, "SELECT id,source_path FROM kb_bundle_assets WHERE bundle_id=" + sqlQuote(bundleId))
    for (image in images) {
        let full = kbAssetFile(bundleId, image.text("id"))
        if (exists(Path(full))) {
            kbWriteFileDeep(workDir + "/in/" + kbPathNormalize(image.text("source_path")), File.readFrom(Path(full)))
        }
    }
}

func kbSaveBundleDocs(cfg: Config, bundleId: String, docs: ArrayList<KbBundleDoc>, workDir: String, log: KbAgentLog): Unit {
    let assets = kbBundleAssets(cfg, bundleId, workDir, log)
    var values = ""
    var batch: Int64 = 0
    var index: Int64 = 0
    for (doc in docs) {
        if (doc.sourcePath.size == 0) { throw Exception("整理结果缺少原文来源，拒绝覆盖原文") }
        let content = assets.document(doc.sourcePath, doc.content)
        if (values.size > 0) { values += "," }
        values += "(" + sqlQuote(kbStableUuid("bundle-source:" + bundleId + ":" + doc.sourcePath)) + "," + sqlQuote(bundleId) + "," +
            index.toString() + "," + sqlQuote(kbTruncate(doc.title, 230)) + "," + sqlQuote(content) + "," +
            kbCharsBetween(content.toArray(), 0, content.size).toString() + "," + sqlQuote(doc.sourcePath) + ")"
        batch += 1
        if (batch >= 20 || values.size >= 384000) {
            assets.flushMetadata()
            transaction(cfg, ["INSERT INTO kb_bundle_docs(id,bundle_id,order_index,title,content,char_count,source_path) VALUES " + values +
                " ON DUPLICATE KEY UPDATE order_index=VALUES(order_index),title=VALUES(title),content=VALUES(content),char_count=VALUES(char_count)"])
            values = ""; batch = 0
        }
        index += 1
    }
    assets.flushMetadata()
    if (values.size > 0) {
        transaction(cfg, ["INSERT INTO kb_bundle_docs(id,bundle_id,order_index,title,content,char_count,source_path) VALUES " + values +
            " ON DUPLICATE KEY UPDATE order_index=VALUES(order_index),title=VALUES(title),content=VALUES(content),char_count=VALUES(char_count)"])
    }
    // Keep the complete seed warnings: successful URL reuse must not erase an earlier missing-image warning.
    if (assets.warnings.size > 0) { kbSaveBundleWarnings(cfg, bundleId, assets) }
    log.add("成品已保存：" + docs.size.toString() + " 篇文档，" + assets.saved.size.toString() + " 张包内图片")
}

func kbMapBundleDocuments(cfg: Config, bundleId: String, settings: KbSettings): Unit {
    let docs = query(cfg, "SELECT id,title,content,char_count,source_path FROM kb_bundle_docs WHERE bundle_id=" + sqlQuote(bundleId) + " ORDER BY order_index")
    var values = ""
    var mapping = "CASE id "
    var ids = ""
    var batch: Int64 = 0
    for (doc in docs) {
        let documentId = kbStableUuid("bundle-document:" + bundleId + ":" + doc.text("source_path"))
        let content = doc.text("content")
        if (values.size > 0) { values += ","; ids += "," }
        values += "(" + sqlQuote(documentId) + "," + sqlQuote(kbTruncate(doc.text("title"), 190)) + "," +
            sqlQuote(kbTruncate(doc.text("source_path"), 230)) + ",'bundle','text/markdown'," + content.size.toString() + "," +
            doc.int("char_count").toString() + "," + sqlQuote(content) + "," + sqlQuote(bundleId) + "," +
            sqlQuote(doc.text("source_path")) + "," + sqlQuote(kbIngestHash(content)) + ")"
        mapping += "WHEN " + sqlQuote(doc.text("id")) + " THEN " + sqlQuote(documentId) + " "
        ids += sqlQuote(doc.text("id")); batch += 1
        if (batch >= 20 || values.size >= 384000) {
            kbFlushBundleMapping(cfg, values, mapping, ids)
            values = ""; mapping = "CASE id "; ids = ""; batch = 0
        }
    }
    if (batch > 0) { kbFlushBundleMapping(cfg, values, mapping, ids) }
    kbQueueBundleBuilds(cfg, bundleId, settings)
}

func kbFlushBundleMapping(cfg: Config, values: String, mapping: String, ids: String): Unit {
    transaction(cfg, [
        "INSERT INTO kb_documents(id,title,source_name,source_type,mime,byte_size,char_count,content,bundle_id,source_path,content_hash) VALUES " + values +
            " ON DUPLICATE KEY UPDATE title=VALUES(title),content=VALUES(content),byte_size=VALUES(byte_size),char_count=VALUES(char_count),content_hash=VALUES(content_hash)",
        "UPDATE kb_bundle_docs SET document_id=" + mapping + "END WHERE id IN(" + ids + ")"
    ])
}

func kbSetBundle(cfg: Config, bundleId: String, status: String, steps: Int64, title: String,
                 error: String, logText: String): Unit {
    execute(cfg,
        "UPDATE kb_bundles SET status=" + sqlQuote(status) + ",steps=" + steps.toString() +
        ",title=" + sqlQuote(title) + ",error_message=" + sqlQuote(error) +
        ",log_text=" + sqlQuote(logText) + ",updated_at=NOW(6) WHERE id=" + sqlQuote(bundleId))
}

/**
 * 同步跑完一个资料包。失败时把原因写进 bundle，工作目录同样清掉。
 * 调用方负责在线程里执行，避免 HTTP 请求卡住几分钟。
 */
let kbBundleRunLock = Mutex()

func kbProcessBundle(cfg: Config, bundleId: String): Unit {
    let settings = loadKbSettings(cfg)
    let endpoint = slotEndpoint(cfg, settings.chat)
    let log = KbAgentLog()
    let zipPath = kbBundleZipPath(cfg, bundleId)
    let workDir = kbBundleWorkDir(cfg, bundleId)
    var originalsSaved = false
    try {
        let bundles = query(cfg, "SELECT status,source_saved,title,name,organize_attempts,COALESCE(logo_generation_id,'') logo_generation_id FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
        if (bundles.size == 0 || bundles[0].text("status") == "ready") { return }
        originalsSaved = bundles[0].int("source_saved") == 1
        if (!originalsSaved && !exists(Path(zipPath)) && !exists(Path(workDir + "/in"))) {
            kbSetBundle(cfg, bundleId, "failed", 0, "", "上传的压缩包已丢失，请重新上传", log.text())
            return
        }
        let title = if (bundles[0].text("title").size > 0) { bundles[0].text("title") } else { kbTitleFromFile(bundles[0].text("name")) }
        kbSetBundle(cfg, bundleId, "running", 0, title, "", "")
        execute(cfg, "UPDATE kb_bundles SET organize_attempts=organize_attempts+1 WHERE id=" + sqlQuote(bundleId))
        if (!exists(Path(workDir + "/in"))) { Directory.create(Path(workDir + "/in"), recursive: true) }
        if (!exists(Path(workDir + "/out"))) { Directory.create(Path(workDir + "/out"), recursive: true) }
        if (originalsSaved) {
            kbRestoreBundleInput(cfg, bundleId, workDir)
            log.add("已从保存的原文和图片重建输入，继续组织")
        } else {
            if (exists(Path(zipPath))) {
                let zipBytes = File.readFrom(Path(zipPath))
                let count = kbZipExtractAll(zipBytes, workDir + "/in", 4000)
                log.add("解压完成，共 " + count.toString() + " 个文件")
            }
            kbSeedBundleSources(cfg, bundleId, workDir, log)
            originalsSaved = true
        }
        if (!endpoint.hasChat()) {
            kbSetBundle(cfg, bundleId, "failed", log.steps(), title, "原文已保存；还没有配置对话模型，配置后可继续整理", log.text())
            return
        }
        let workspace = KbWorkspace(workDir)
        let result = kbRunAgent(endpoint, workspace, log, 80)
        if (!result.finished) {
            kbSetBundle(cfg, bundleId, "failed", log.steps(), title, result.message, log.text())
            return
        }
        let docs = kbCollectResult(workspace)
        if (docs.size == 0) {
            kbSetBundle(cfg, bundleId, "failed", log.steps(), result.title, "整理完成但没有产出任何章节文件", log.text())
            return
        }
        kbSaveBundleDocs(cfg, bundleId, docs, workDir, log)
        kbMapBundleDocuments(cfg, bundleId, settings)
        kbSetBundle(cfg, bundleId, "ready", log.steps(), result.title, "", log.text())
        // Logo has its own durable queue and cannot block organizing or indexing.
        if (bundles[0].text("logo_generation_id").size == 0) {
            try { let _logoId = kbQueueLogoGeneration(cfg, result.title, "", "kb_bundle", bundleId) }
            catch (error: Exception) { log.add("Logo独立排队失败，可稍后单独重试：" + error.message) }
        }

    } catch (error: Exception) {
        kbSetBundle(cfg, bundleId, "failed", log.steps(), "", "处理失败：" + error.message, log.text())
    } finally {
        if (originalsSaved) {
            kbRemoveTree(workDir)
            try { if (exists(Path(zipPath))) { remove(Path(zipPath)) } } catch (_: Exception) {}
        }
    }
}

/** 后台跑资料包，HTTP 请求立刻返回。 */
func kbLaunchBundle(cfg: Config, bundleId: String): Unit {
    spawn {
        while (true) {
            kbBundleRunLock.lock()
            try { kbProcessBundle(cfg, bundleId) } catch (_: Exception) {} finally { kbBundleRunLock.unlock() }
            let again = try {
                let rows = query(cfg, "SELECT status,organize_attempts FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
                if (rows.size > 0 && rows[0].text("status") == "failed" && rows[0].int("organize_attempts") < 3) {
                    execute(cfg, "UPDATE kb_bundles SET status='queued',organize_retry_at=DATE_ADD(NOW(6),INTERVAL 8 SECOND) WHERE id=" + sqlQuote(bundleId))
                    true
                } else { false }
            } catch (_: Exception) { false }
            if (!again) { break }
            sleep(Duration.second * 8)
        }
    }
}

func kbRestoreBundleJobs(cfg: Config): Unit {
    execute(cfg, "UPDATE kb_bundles SET status='queued',error_message='服务重启，正在从已保存的原文继续' WHERE status='running'")
    let rows = query(cfg, "SELECT id FROM kb_bundles WHERE status='queued' ORDER BY created_at")
    for (row in rows) { kbLaunchBundle(cfg, row.text("id")) }
}

func kbBundlePipelineJson(row: Row): String {
    let documents = row.int("process_docs")
    let chunks = row.int("total_chunks")
    let summaries = row.int("summary_chunks")
    let embeddings = row.int("embedded_chunks")
    var status = "running"
    var stage = "chunking"
    var error = row.text("job_error")
    if (documents == 0) {
        status = row.text("status")
        if (status == "ready") { status = "pending" }
        stage = "organizing"
        error = row.text("error_message")
    } else if (row.int("ready_docs") == documents) { status = "ready"; stage = "ready" }
    else {
        if (row.int("failed_docs") > 0) { status = if (row.int("ready_docs") > 0) { "partial" } else { "failed" } }
        else if (row.int("queued_docs") > 0 && row.int("running_docs") == 0) { status = "queued" }
        if (row.int("chunking_jobs") > 0 || chunks == 0) { stage = "chunking" }
        else if (summaries < chunks) { stage = "summarizing" }
        else if (embeddings < chunks) { stage = "embedding" }
    }
    let out = JsonWriter()
    out.putStr("status", status)
    out.putStr("stage", stage)
    out.putInt("documents", if (documents > 0) { documents } else { row.int("doc_count") })
    out.putInt("totalChunks", chunks)
    out.putInt("summarizedChunks", summaries)
    out.putInt("embeddedChunks", embeddings)
    out.putInt("failedChunks", row.int("failed_chunks"))
    out.putInt("pendingChunks", if (chunks > embeddings) { chunks - embeddings } else { 0 })
    out.putStr("errorMessage", error)
    out.toJson()
}

func kbBundleChunksBody(cfg: Config, bundleId: String, offset: Int64, limit: Int64): ?String {
    let bundle = query(cfg, "SELECT id FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (bundle.size == 0) { return None }
    let fromSql = " FROM kb_chunks c JOIN kb_documents d ON d.id=c.document_id LEFT JOIN kb_embeddings e ON e.chunk_id=c.id " +
        "WHERE d.bundle_id=" + sqlQuote(bundleId) + " AND c.build_id=IF(d.pending_build_id<>'',d.pending_build_id,d.active_build_id) "
    let total = query(cfg, "SELECT COUNT(*) n" + fromSql)
    let rows = query(cfg, "SELECT c.id,c.document_id,d.source_path,c.heading_path,c.text,c.summary,c.keywords_json,c.summary_status," +
        "c.source_start,c.source_end,COALESCE(e.dim,0) embedding_dim,COALESCE(e.space_key,'') space_key,IF(e.chunk_id IS NULL,0,1) has_vector" + fromSql +
        "ORDER BY d.source_path,c.chunk_index LIMIT " + limit.toString() + " OFFSET " + offset.toString())
    let chunks = JsonArrWriter()
    for (row in rows) {
        let item = JsonWriter()
        item.putStr("id", row.text("id"))
        item.putStr("documentId", row.text("document_id"))
        item.putStr("sourcePath", row.text("source_path"))
        item.putStr("headingPath", row.text("heading_path"))
        item.putStr("text", row.text("text"))
        item.putStr("summary", row.text("summary"))
        item.putRaw("keywords", if (row.isNull("keywords_json")) { "[]" } else { row.text("keywords_json") })
        item.putStr("summaryStatus", row.text("summary_status"))
        item.putBool("hasVector", row.int("has_vector") == 1)
        item.putInt("embeddingDim", row.int("embedding_dim"))
        item.putStr("spaceKey", row.text("space_key"))
        item.putInt("startOffset", row.int("source_start"))
        item.putInt("endOffset", row.int("source_end"))
        chunks.addRaw(item.toJson())
    }
    let out = JsonWriter()
    out.putRaw("chunks", chunks.toJson())
    out.putInt("total", if (total.size > 0) { total[0].int("n") } else { 0 })
    out.putInt("offset", offset)
    out.putInt("limit", limit)
    Some(out.toJson())
}

func kbRetryBundle(cfg: Config, bundleId: String, stage: String): Bool {
    let bundles = query(cfg, "SELECT id,status,title,name,source_saved FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (bundles.size == 0) { return false }
    if (stage == "logo") {
        let title = if (bundles[0].text("title").size > 0) { bundles[0].text("title") } else { kbTitleFromFile(bundles[0].text("name")) }
        let _id = kbQueueLogoGeneration(cfg, title, "", "kb_bundle", bundleId)
        return true
    }
    if (stage == "all" && bundles[0].text("status") == "failed") {
        execute(cfg, "UPDATE kb_bundles SET status='queued',organize_attempts=0,organize_retry_at=NOW(6),error_message='' WHERE id=" + sqlQuote(bundleId))
        kbLaunchBundle(cfg, bundleId)
        return true
    }
    // Jobs carry immutable model/source snapshots. Retrying adds only missing artifacts.
    transaction(cfg, [
        "UPDATE kb_ingest_jobs j JOIN kb_documents d ON d.id=j.document_id SET j.status='queued',j.attempts=0,j.error_message=''," +
            "j.next_attempt_at=NOW(6),j.finished_at=NULL WHERE d.bundle_id=" + sqlQuote(bundleId) +
            " AND j.build_id=d.pending_build_id AND j.status='failed'",
        "UPDATE kb_chunks c JOIN kb_ingest_jobs j ON j.build_id=c.build_id JOIN kb_documents d ON d.id=j.document_id " +
            "SET c.summary_status='pending',c.summary_error='',c.summary_attempts=0 WHERE d.bundle_id=" + sqlQuote(bundleId) +
            " AND j.status='queued' AND c.summary_status<>'ready'",
        "UPDATE kb_documents d JOIN kb_ingest_jobs j ON j.id=d.pending_build_id SET d.status='indexing',d.error_message='' WHERE d.bundle_id=" +
            sqlQuote(bundleId) + " AND j.status='queued'"
    ])
    // Legacy organised bundles can join the new pipeline without running the organization model again.
    if (bundles[0].text("status") == "ready") { kbMapBundleDocuments(cfg, bundleId, loadKbSettings(cfg)) }
    return true
}
