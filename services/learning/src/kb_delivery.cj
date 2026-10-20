package zhixun_learning

import std.collection.*
import std.core.*
import soulsoft_web_http.*

/** Publish from complete source documents, never concatenate overlapping search chunks. */
func kbPublishBundle(cfg: Config, bundleId: String): ?KbPublishResult {
    let bundles = query(cfg, "SELECT title,name,status,course_id FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (bundles.size == 0 || bundles[0].text("status") != "ready") { return None }
    let docs = query(cfg, "SELECT id,document_id,title,content,source_path FROM kb_bundle_docs WHERE bundle_id=" +
        sqlQuote(bundleId) + " ORDER BY order_index,id")
    if (docs.size == 0) { return None }
    let existing = bundles[0].text("course_id")
    let courseId = if (existing.size > 0) { existing } else { "kb-" + bundleId.replace("-", "") }
    let title = if (bundles[0].text("title").size > 0) { bundles[0].text("title") } else { bundles[0].text("name") }
    let chapters = JsonArrWriter()
    let statements = ArrayList<String>()
    var index: Int64 = 0
    for (doc in docs) {
        let chapter = JsonWriter()
        chapter.putStr("title", doc.text("title"))
        chapters.addRaw(chapter.toJson())
    }
    let icon = "/api/kb/bundles/" + bundleId + "/logo"
    statements.add("INSERT INTO courses(id,name,icon,description,level,duration,chapters_json,source_label,status,sort_order) VALUES(" +
        sqlQuote(courseId) + "," + sqlQuote(title) + "," + sqlQuote(icon) + "," +
        sqlQuote(kbSummaryOf(docs[0].text("content"), 120)) + ",'入门'," + (docs.size * 10).toString() + "," +
        sqlQuote(chapters.toJson()) + "," + sqlQuote("知识库《" + title + "》") + ",'published',100) " +
        "ON DUPLICATE KEY UPDATE name=VALUES(name),icon=VALUES(icon),description=VALUES(description)," +
        "duration=VALUES(duration),chapters_json=VALUES(chapters_json),source_label=VALUES(source_label),status='published',updated_at=NOW(6)")
    var rows = ""
    for (doc in docs) {
        let section = JsonWriter()
        section.putStr("id", "source-" + doc.text("id"))
        section.putStr("eyebrow", "课程讲义")
        section.putStr("heading", doc.text("title"))
        section.putStr("text", doc.text("content"))
        section.putBool("markdown", true)
        let content = JsonWriter()
        content.putRaw("sections", "[" + section.toJson() + "]")
        content.putRaw("slides", "[]")
        content.putStr("sourceLabel", doc.text("source_path"))
        let source = JsonWriter()
        source.putStr("id", doc.text("document_id"))
        source.putStr("title", doc.text("title"))
        source.putStr("kind", "kb-document")
        source.putStr("sourcePath", doc.text("source_path"))
        if (rows.size > 0) { rows += "," }
        rows += "(" + sqlQuote(courseId) + "," + index.toString() + "," + sqlQuote(doc.text("title")) + "," +
            sqlQuote(content.toJson()) + ",'[]'," + sqlQuote("[" + source.toJson() + "]") + ")"
        index += 1
        if (index % 15 == 0 || index == docs.size) {
            statements.add("INSERT INTO lessons(course_id,lesson_index,title,content_json,quiz_json,sources_json) VALUES " + rows +
                " ON DUPLICATE KEY UPDATE title=VALUES(title),content_json=VALUES(content_json),sources_json=VALUES(sources_json)")
            rows = ""
        }
    }
    // Stable source ordering keeps existing learner progress on an idempotent publish.
    statements.add("UPDATE kb_bundles SET course_id=" + sqlQuote(courseId) + " WHERE id=" + sqlQuote(bundleId))
    statements.add("UPDATE kb_documents SET course_id=" + sqlQuote(courseId) + " WHERE bundle_id=" + sqlQuote(bundleId))
    transaction(cfg, statements.toArray())
    kbBumpVersion()
    Some(KbPublishResult(courseId, docs.size, existing.size == 0))
}

func kbSetBundleCourseStatus(cfg: Config, bundleId: String, status: String): Bool {
    let rows = query(cfg, "SELECT course_id FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (rows.size == 0 || rows[0].text("course_id").size == 0) { return false }
    execute(cfg, "UPDATE courses SET status=" + sqlQuote(status) + ",updated_at=NOW(6) WHERE id=" + sqlQuote(rows[0].text("course_id")))
    kbBumpVersion()
    true
}

func kbBundlePublished(cfg: Config, bundleId: String): Bool {
    query(cfg, "SELECT b.id FROM kb_bundles b JOIN courses c ON c.id=b.course_id " +
        "WHERE b.id=" + sqlQuote(bundleId) + " AND c.status='published' LIMIT 1").size > 0
}

func kbWriteBundleLogo(response: HttpResponse, cfg: Config, bundleId: String): Unit {
    let rows = query(cfg, "SELECT COALESCE(logo_svg,'') svg FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (rows.size == 0) { writeError(response, 404, "没有找到图标"); return }
    let svg = if (rows[0].text("svg").size > 0) { rows[0].text("svg") } else {
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='16' fill='#ede9fe'/>" +
        "<path d='M15 18h14l3 3 3-3h14v29H35l-3 3-3-3H15z' fill='none' stroke='#7047eb' stroke-width='3'/><path d='M32 21v29' stroke='#7047eb' stroke-width='3'/></svg>"
    }
    response.statusCode = 200
    response.contentType = "image/svg+xml; charset=utf-8"
    response.headers.add("Cache-Control", "no-store")
    response.headers.add("X-Content-Type-Options", "nosniff")
    response.headers.add("Content-Security-Policy", "default-src 'none'; sandbox")
    response.write(svg)
}

/** Cancel derived work before removing source metadata. Preserve studied courses as drafts. */
func kbDeleteBundleContent(cfg: Config, bundleId: String): Unit {
    let rows = query(cfg, "SELECT course_id FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    let statements = ArrayList<String>()
    statements.add("UPDATE kb_ingest_jobs j JOIN kb_documents d ON d.id=j.document_id SET j.status='cancelled' WHERE d.bundle_id=" + sqlQuote(bundleId))
    statements.add("DELETE FROM logo_generations WHERE resource_type='kb_bundle' AND resource_id=" + sqlQuote(bundleId))
    if (rows.size > 0 && rows[0].text("course_id").size > 0) {
        let courseId = rows[0].text("course_id")
        if (kbCourseInUse(cfg, courseId)) {
            statements.add("UPDATE courses SET status='draft',updated_at=NOW(6) WHERE id=" + sqlQuote(courseId))
        } else {
            statements.add("DELETE FROM lessons WHERE course_id=" + sqlQuote(courseId))
            statements.add("DELETE FROM courses WHERE id=" + sqlQuote(courseId))
        }
    }
    statements.add("DELETE FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    transaction(cfg, statements.toArray())
    kbRemoveTree(kbAssetBundleDir(bundleId))
    kbRemoveTree(kbBundleWorkDir(cfg, bundleId))
    kbBumpVersion()
}
