package zhixun_learning

import std.core.*
import std.unittest.*
import std.unittest.testmacro.*
import stdx.encoding.json.*

func tutorConversationTestObject(text: String): JsonObject {
    jsonParse(text).getOrThrow().asObject()
}

func tutorConversationExpect400(action: () -> Unit): Unit {
    var rejected = false
    try { action() } catch (error: Exception) {
        rejected = error.message.startsWith("400|")
    }
    kbPrimitiveCheck(rejected, "Invalid conversation input must return 400")
}

@Test
class TutorConversationsTests {
    @TestCase
    func createContextUsesTypedServerValidatedCoordinates(): Unit {
        let (course, lesson) = tutorConversationCreateContext(tutorConversationTestObject("{}"))
        kbPrimitiveCheck(course == "" && lesson == -1, "Plain create must remain compatible")
        let (courseId, index) = tutorConversationCreateContext(tutorConversationTestObject(
            "{\"courseId\":\"course-a\",\"lessonIndex\":3,\"lessonTitle\":\"untrusted hint\",\"title\":\"untrusted title\"}"))
        kbPrimitiveCheck(courseId == "course-a" && index == 3, "Persist the selected course and visible lesson coordinates")
        for (invalid in ["{\"courseId\":1}", "{\"lessonIndex\":0}", "{\"lessonIndex\":-2}",
            "{\"courseId\":\"course-a\",\"lessonIndex\":\"0\"}", "{\"lessonTitle\":false}"]) {
            tutorConversationExpect400({ =>
                let _value = tutorConversationCreateContext(tutorConversationTestObject(invalid))
            })
        }
        let sql = tutorManagedConversationsSql("owner-a", false)
        kbPrimitiveCheck(sql.contains("c.course_id,c.lesson_index") && sql.contains("NULLIF(r.course_id,'')"),
            "Empty managed conversations must retain their database-backed course context")
        kbPrimitiveCheck(tutorManagedConversationTitle("", "", "课程", "章节") == "课程 · 章节",
            "A fresh course conversation must display the official course and lesson names")
    }

    @TestCase
    func titleValidationCountsUnicodeAndRequiresStrictTypes(): Unit {
        let chinese = kbPrimitiveRepeated("学", 64)
        let emoji = kbPrimitiveRepeated("😀", 64)
        kbPrimitiveCheck(tutorConversationCleanTitle(chinese) == chinese, "64 Chinese characters must fit")
        kbPrimitiveCheck(tutorConversationCleanTitle(emoji) == emoji, "Astral characters count as one code point")
        kbPrimitiveCheck(tutorConversationCleanTitle("  学习 SQL  ") == "学习 SQL", "Trim ASCII title padding")
        for (invalid in ["", "   ", "　", "a\nb", "a\u{0000}b", kbPrimitiveRepeated("学", 65)]) {
            tutorConversationExpect400({ => let _value = tutorConversationCleanTitle(invalid) })
        }
        for (invalid in ["{}", "{\"title\":null}", "{\"title\":12}", "{\"title\":true}",
            "{\"archived\":null}", "{\"archived\":1}", "{\"archived\":\"false\"}", "{\"archived\":[]}"]) {
            tutorConversationExpect400({ =>
                let _value = tutorConversationUpdateAssignments(tutorConversationTestObject(invalid))
            })
        }
        let patch = tutorConversationUpdateAssignments(tutorConversationTestObject("{\"title\":\"学员自定\",\"archived\":false}"))
        kbPrimitiveCheck(patch.contains("title='学员自定'") && patch.contains("archived=0"), "Accept a combined typed patch")
        kbPrimitiveCheck(tutorConversationUpdateAssignments(tutorConversationTestObject("{\"archived\":true}")).contains("archived=1"),
            "Archive true must remain a boolean")
    }

    @TestCase
    func automaticTitlesUseFirstMessageAndCustomTitlesStayStable(): Unit {
        kbPrimitiveCheck(tutorManagedConversationTitle("自定标题", "第一问", "课程", "章节") == "自定标题", "Custom title must win")
        kbPrimitiveCheck(tutorManagedConversationTitle("", "第一问", "课程", "章节") == "第一问", "Automatic title uses the first user message")
        kbPrimitiveCheck(tutorManagedConversationTitle("", "", "", "").size > 0, "Empty conversations need a display title")
        let ensure = tutorConversationEnsureSql("owner-a", "shared-id")
        kbPrimitiveCheck(ensure.contains("VALUES('owner-a','shared-id')"), "Ensure must use the composite owner key")
        let update = ensure.split("ON DUPLICATE KEY UPDATE")[1]
        kbPrimitiveCheck(!update.contains("title") && !update.contains("archived"), "Touch must preserve custom metadata")
    }

    @TestCase
    func listAndDeleteScopeEveryMessageLookupToItsOwner(): Unit {
        let sql = tutorManagedConversationsSql("owner-a", false)
        for (alias in ["t", "legacy", "existing", "u", "n", "m", "latest"]) {
            kbPrimitiveCheck(sql.contains(alias + ".user_id='owner-a'"), "Missing owner scope for " + alias)
        }
        kbPrimitiveCheck(sql.contains("c.user_id='owner-a'") && sql.contains("c.archived=0"), "Metadata must be owner scoped")
        kbPrimitiveCheck(sql.contains("UNION ALL") && sql.contains("NOT EXISTS") && sql.contains("LIMIT 100"),
            "List must retain empty metadata, legacy fallback, and the global limit")
        kbPrimitiveCheck(sql.contains("ORDER BY u.created_at ASC,u.id ASC"), "Automatic title must use the first user message")
        let archived = tutorManagedConversationsSql("owner-a", true)
        kbPrimitiveCheck(archived.contains("c.archived=1") && archived.contains("AND 1=0"), "Legacy rows must not leak into archived lists")
        let deletes = tutorConversationDeleteStatements("owner-a", "shared-id")
        kbPrimitiveCheck(deletes.size == 2, "Delete both messages and metadata")
        for (statement in deletes) {
            kbPrimitiveCheck(statement.contains("WHERE user_id='owner-a' AND conversation_id='shared-id'"),
                "Deletion must match both owner and conversation")
        }
    }

    @TestCase
    func chineseMetadataRoundTripsThroughRawJsonWriter(): Unit {
        let row = Row(["conversation_id", "custom_title", "first_user_content", "latest_content", "archived", "lesson_index", "message_count"],
            [MyCell.of("agent-test".toArray()), MyCell.of("学习\"事务\" 😀".toArray()), MyCell.of("第一问".toArray()),
             MyCell.of("最新答复\n下一行".toArray()), MyCell.of("1".toArray()), MyCell.of("-1".toArray()), MyCell.of("2".toArray())])
        let text = tutorManagedConversationJson(row)
        let parsed = tutorConversationTestObject(text)
        kbPrimitiveCheck(jsonGetString(parsed, "title").getOrThrow() == "学习\"事务\" 😀", "Chinese metadata must round trip")
        kbPrimitiveCheck(jsonGetBool(parsed, "archived").getOrThrow(), "Archive field must serialize as boolean")
        kbPrimitiveCheck(jsonGetInt(parsed, "messageCount").getOrThrow() == 2, "Retain existing numeric fields")
        let payload = tutorConversationTestObject(tutorConversationsPayload("[" + text + "]"))
        kbPrimitiveCheck(jsonGetArray(payload, "items").getOrThrow().size() == 1 &&
            jsonGetArray(payload, "conversations").getOrThrow().size() == 1, "Keep both list aliases")
    }
}
