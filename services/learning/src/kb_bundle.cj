package zhixun_learning

import std.collection.*
import std.core.*
import std.fs.*
import std.sync.*

/**
 * 资料包流水线：解包 → Agent 整理 → 只保存成品。
 * 工作目录在跑完后整目录删除，磁盘上不留原始文件和中间产物。
 */
class KbBundleDoc {
    let title: String
    let content: String

    init(title: String, content: String) {
        this.title = title
        this.content = content
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
    while (cut < name.size) {
        let ch = name[cut..cut + 1]
        if (ch >= "0" && ch <= "9") {
            cut += 1
        } else {
            break
        }
    }
    if (cut > 0 && cut < name.size) {
        let ch = name[cut..cut + 1]
        if (ch == "-" || ch == "_" || ch == "." || ch == " ") {
            name = name[cut + 1..name.size]
        }
    }
    let trimmed = name.trimAscii()
    if (trimmed.size == 0) { fileName } else { trimmed }
}

/** 收集 out/ 下整理好的 Markdown，按文件名顺序作为章节顺序。 */
func kbCollectResult(workDir: String): ArrayList<KbBundleDoc> {
    let outDir = workDir + "/out"
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
        result.add(KbBundleDoc(kbTitleFromFile(baseName), text))
    }
    result
}

func kbSaveBundleDocs(cfg: Config, bundleId: String, docs: ArrayList<KbBundleDoc>): Unit {
    execute(cfg, "DELETE FROM kb_bundle_docs WHERE bundle_id=" + sqlQuote(bundleId))
    var index: Int64 = 0
    for (doc in docs) {
        execute(cfg,
            "INSERT INTO kb_bundle_docs(id,bundle_id,order_index,title,content,char_count) VALUES(" +
            sqlQuote(uuidFormat(uuidV4())) + "," + sqlQuote(bundleId) + "," + index.toString() + "," +
            sqlQuote(doc.title) + "," + sqlQuote(doc.content) + "," +
            kbCharsBetween(doc.content.toArray(), 0, doc.content.toArray().size).toString() + ")")
        index += 1
    }
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
func kbProcessBundle(cfg: Config, bundleId: String): Unit {
    let settings = loadKbSettings(cfg)
    let endpoint = slotEndpoint(cfg, settings.chat)
    let log = KbAgentLog()
    let zipPath = kbBundleZipPath(cfg, bundleId)
    let workDir = kbBundleWorkDir(cfg, bundleId)
    try {
        if (!endpoint.hasChat()) {
            kbSetBundle(cfg, bundleId, "failed", 0, "", "还没有配置对话模型，无法整理资料包", log.text())
            return
        }
        if (!exists(Path(zipPath))) {
            kbSetBundle(cfg, bundleId, "failed", 0, "", "上传的压缩包已丢失，请重新上传", log.text())
            return
        }
        kbSetBundle(cfg, bundleId, "running", 0, "", "", "")
        let zipBytes = File.readFrom(Path(zipPath))
        if (!exists(Path(workDir + "/in"))) { Directory.create(Path(workDir + "/in"), recursive: true) }
        if (!exists(Path(workDir + "/out"))) { Directory.create(Path(workDir + "/out"), recursive: true) }
        let count = try {
            kbZipExtractAll(zipBytes, workDir + "/in", 400)
        } catch (error: Exception) {
            kbSetBundle(cfg, bundleId, "failed", 0, "", "解压失败：" + error.message, log.text())
            return
        }
        log.add("解压完成，共 " + count.toString() + " 个文件")
        if (count == 0) {
            kbSetBundle(cfg, bundleId, "failed", 0, "", "压缩包里没有可处理的文件", log.text())
            return
        }
        let workspace = KbWorkspace(workDir)
        let result = kbRunAgent(endpoint, workspace, log, 60)
        if (!result.finished) {
            kbSetBundle(cfg, bundleId, "failed", log.steps(), "", result.message, log.text())
            return
        }
        let docs = kbCollectResult(workDir)
        if (docs.size == 0) {
            kbSetBundle(cfg, bundleId, "failed", log.steps(), result.title, "整理完成但没有产出任何章节文件", log.text())
            return
        }
        kbSaveBundleDocs(cfg, bundleId, docs)
        kbSetBundle(cfg, bundleId, "ready", log.steps(), result.title, "", log.text())
    } catch (error: Exception) {
        kbSetBundle(cfg, bundleId, "failed", log.steps(), "", "处理失败：" + error.message, log.text())
    } finally {
        kbRemoveTree(workDir)
        try { if (exists(Path(zipPath))) { remove(Path(zipPath)) } } catch (_: Exception) {}
    }
}

/** 后台跑资料包，HTTP 请求立刻返回。 */
func kbLaunchBundle(cfg: Config, bundleId: String): Unit {
    spawn {
        try {
            kbProcessBundle(cfg, bundleId)
        } catch (_: Exception) {}
    }
}
