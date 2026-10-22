package itn_desktop_core.learning

import std.collection.*
import std.sync.*
import stdx.encoding.json.*
import itn_desktop_core.db.*
import itn_desktop_core.kb.*
import itn_desktop_core.study.*
import itn_desktop_core.util.*

let courseGenerationLock = Mutex()
let courseGenerations = HashMap<String, String>()
func generationKey(dataDir: String, kbId: String, chapter: String): String { return dataDir + "\n" + kbId + "\n" + chapter }
public func studyLectureSession(dataDir: String, kbId: String, chapter: String): String {
    synchronized(courseGenerationLock) { return courseGenerations.get(generationKey(dataDir, kbId, chapter)) ?? "" }
}
public func claimStudyLecture(dataDir: String, kbId: String, chapter: String, sid: String): Bool {
    synchronized(courseGenerationLock) {
        let key = generationKey(dataDir, kbId, chapter)
        if (courseGenerations.contains(key)) { return false }
        courseGenerations[key] = sid
        return true
    }
}
public func releaseStudyLecture(dataDir: String, kbId: String, chapter: String): Unit {
    synchronized(courseGenerationLock) { courseGenerations.remove(generationKey(dataDir, kbId, chapter)) }
}

func courseSection(chapter: String, group: String, title: String, markdown: String, occurrence: Int64): JsonObject {
    let o = JsonObject()
    // A title path survives a revised resource id/version; repeated titles remain distinct.
    o.put("id", JsonString(chapter + "\n" + group + "\n" + title + "\n" + occurrence.toString()))
    o.put("title", JsonString(title)); o.put("markdown", JsonString(markdown))
    o.put("lectureChapter", JsonString(group))
    return o
}

/** The course is a projection of actual lecture content, never a concatenation of KB chunks. */
public func studyCourse(dataDir: String, kbId: String, idx: KbIndex): JsonObject {
    let ls = LearningStore(dataDir)
    let db = DbHub.open(dataDir)
    let lectures = HashMap<String, JsonObject>()
    for (row in db.query("SELECT v.body FROM learning_resources r JOIN learning_resource_versions v ON v.resource_id=r.id AND v.version=r.latest_version WHERE r.kb_id=? AND r.kind='lecture' ORDER BY r.updated_at DESC, r.rowid DESC", va([tv(kbId)]))) {
        let r = parsed(row.text(0))
        let explicit = strOf(r, "studyChapter")
        let key = if (explicit.size > 0) { explicit } else { strOf(r, "topic") }
        if (key.size > 0 && !lectures.contains(key)) { lectures[key] = r }
        let title = strOf(r, "title")
        if (explicit.size == 0 && title.size > 0 && !lectures.contains(title)) { lectures[title] = r }
    }
    let completed = HashSet<String>()
    for (row in db.query("SELECT item_key FROM progress WHERE kb_id=? AND kind='section'", va([tv(kbId)]))) { completed.add(row.text(0)) }
    let out = JsonObject(); let chapters = JsonArray()
    var total: Int64 = 0; var done: Int64 = 0; var next: ?JsonObject = None
    let tree = buildChapterTree(idx, StudyStore(dataDir).load().progress, kbId)
    var i = 0
    while (i < tree.size()) {
        let source = objOf(tree[i]).getOrThrow(); i += 1
        let name = strOf(source, "name")
        let chapter = JsonObject(); let sections = JsonArray()
        chapter.put("name", JsonString(name)); chapter.put("sections", sections)
        chapter.put("generationSessionId", JsonString(studyLectureSession(dataDir, kbId, name)))
        let counts = HashMap<String, Int64>()
        match (lectures.get(name)) {
            case Some(res) =>
                let content = objOf(res.get("content").getOrDefault({ => JsonObject() })).getOrDefault({ => JsonObject() })
                let groups = arrOf(content, "chapters")
                var g = 0
                while (g < groups.size()) {
                    let group = objOf(groups[g]).getOrThrow(); g += 1
                    let groupTitle = strOf(group, "title")
                    let ss = arrOf(group, "sections"); var j = 0
                    while (j < ss.size()) {
                        let s = objOf(ss[j]).getOrThrow(); j += 1
                        let title = strOf(s, "title")
                        let key = groupTitle + "\n" + title
                        let occurrence = (counts.get(key) ?? 0) + 1; counts[key] = occurrence
                        var markdown = strOf(s, "content")
                        if (j == 1 && strOf(group, "introduction").size > 0) { markdown = strOf(group, "introduction") + "\n\n" + markdown }
                        if (j == ss.size() && strOf(group, "summary").size > 0) { markdown += "\n\n**本章小结：**" + strOf(group, "summary") }
                        sections.add(courseSection(name, groupTitle, title, markdown, occurrence))
                    }
                }
                if (sections.size() > 0) {
                    chapter.put("resourceId", JsonString(strOf(res, "id"))); chapter.put("version", JsonInt(intOf(res, "version")))
                    chapter.put("citations", arrOf(res, "citations"))
                }
            case None => ()
        }
        if (sections.size() == 0) {
            let seen = HashSet<String>()
            for (c in idx.chunks) {
                if (chapterOf(c.headingPath, c.docTitle) != name) { continue }
                let path = c.headingPath.split(" > ")
                let title = if (path.size > 1) { path[1] } else { "认识" + name }
                if (seen.contains(title)) { continue }; seen.add(title)
                sections.add(courseSection(name, "", title, "", 1))
            }
        }
        var chapterDone: Int64 = 0; var j = 0
        while (j < sections.size()) {
            let s = objOf(sections[j]).getOrThrow(); j += 1
            let isDone = completed.contains(strOf(s, "id"))
            s.put("done", JsonBool(isDone))
            if (isDone) { chapterDone += 1 } else if (next.isNone()) {
                let n = JsonObject(); n.put("chapter", JsonString(name)); n.put("sectionId", JsonString(strOf(s, "id"))); n.put("title", JsonString(strOf(s, "title"))); next = n
            }
        }
        chapter.put("doneCount", JsonInt(chapterDone)); chapter.put("sectionCount", JsonInt(sections.size()))
        total += sections.size(); done += chapterDone
        if (strOf(chapter,"resourceId").size > 0) {
            // Promote the lecture's own chapter/section outline into the two-level directory.
            let projected = HashMap<String, JsonObject>(); let groupOrder = ArrayList<String>()
            var k = 0
            while (k < sections.size()) {
                let section = objOf(sections[k]).getOrThrow(); k += 1
                let group = strOf(section,"lectureChapter")
                if (!projected.contains(group)) {
                    let c = JsonObject()
                    c.put("name",JsonString(name + " · " + group)); c.put("sourceChapter",JsonString(name)); c.put("title",JsonString(group))
                    c.put("resourceId",chapter.get("resourceId").getOrThrow()); c.put("version",chapter.get("version").getOrThrow()); c.put("citations",chapter.get("citations").getOrThrow())
                    c.put("sections",JsonArray()); c.put("doneCount",JsonInt(0)); projected[group]=c; groupOrder.add(group)
                }
                let c = projected.get(group).getOrThrow(); let ss = arrOf(c,"sections"); ss.add(section)
                c.put("sectionCount",JsonInt(ss.size()))
                if (boolOf(section,"done")) { c.put("doneCount",JsonInt(intOf(c,"doneCount") + 1)) }
                // next was originally built using the source chapter; make its destination exact.
                match (next) { case Some(n) => if (strOf(n,"sectionId") == strOf(section,"id")) { n.put("chapter",c.get("name").getOrThrow()) }; case None => () }
            }
            for (group in groupOrder) { chapters.add(projected.get(group).getOrThrow()) }
        } else { chapter.put("sourceChapter",JsonString(name)); chapters.add(chapter) }
    }
    out.put("chapters", chapters); out.put("sectionCount", JsonInt(total)); out.put("doneCount", JsonInt(done))
    match (next) { case Some(n) => out.put("next", n); case None => () }
    return out
}

public func findCourseSection(course: JsonObject, chapter: String, sectionId: String): JsonObject {
    let chapters = arrOf(course, "chapters"); var i = 0
    while (i < chapters.size()) {
        let c = objOf(chapters[i]).getOrThrow(); i += 1
        if (strOf(c, "name") != chapter) { continue }
        let sections = arrOf(c, "sections"); var j = 0
        while (j < sections.size()) {
            let s = objOf(sections[j]).getOrThrow(); j += 1
            if (strOf(s, "id") == sectionId) { return s }
        }
    }
    throw Exception("找不到这一节，请重新打开课程")
}
