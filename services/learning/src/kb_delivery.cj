package zhixun_learning

import std.collection.*
import std.core.*
import soulsoft_web_http.*

/** Publish from complete source documents, never concatenate overlapping search chunks. */
func kbPublishBundle(cfg: Config, bundleId: String): ?KbPublishResult {
    // 课程内容不再直接取原文：只建课程壳，课时来自「已上架章节 + 已发布课件」。
    let bundles = query(cfg, "SELECT title,name,status,course_id FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (bundles.size == 0 || bundles[0].text("status") != "ready") { return None }
    let existing = bundles[0].text("course_id")
    cwRebuildBundleCourse(cfg, bundleId, "published")
    let rows = query(cfg, "SELECT course_id FROM kb_bundles WHERE id=" + sqlQuote(bundleId))
    if (rows.size == 0 || rows[0].text("course_id").size == 0) { return None }
    let courseId = rows[0].text("course_id")
    let lessons = query(cfg, "SELECT COUNT(*) n FROM lessons WHERE course_id=" + sqlQuote(courseId))
    let count = if (lessons.size > 0) { lessons[0].int("n") } else { 0 }
    Some(KbPublishResult(courseId, count, existing.size == 0))
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
