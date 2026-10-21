package zhixun_learning

import std.core.*
import std.unittest.*
import std.unittest.testmacro.*

func learnerActivityTestRow(columns: Array<String>, values: Array<String>): Row {
    let cells = Array<MyCell>(values.size, { i => MyCell.of(values[i].toArray()) })
    Row(columns, cells)
}

@Test
class LearningActivityTests {
    @TestCase
    func activityWritesUseDailyResourceIdentityAndBeijingDate(): Unit {
        let sql = learnerActivityRecordSql("learner-a", "course-a", 17, "lecture")
        kbPrimitiveCheck(sql.startsWith("INSERT IGNORE INTO learner_activity_days"), "Repeat visits must be ignored")
        kbPrimitiveCheck(sql.contains("DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR)"), "Activity days must use Beijing time")
        kbPrimitiveCheck(sql.contains("'course-a',17,'lecture'"), "Persist stable lesson identity and resource kind")
        kbPrimitiveCheck(!sql.contains("generation") && !sql.contains("ON DUPLICATE KEY UPDATE"), "A repeat must not increase daily intensity")
        kbPrimitiveCheck(learnerActivityRecordSql("learner-a", "course-a", 17, "lesson").contains("'lesson'"), "Untyped legacy visits must remain valid")
        kbPrimitiveRejects({ => let _value = learnerActivityRecordSql("learner-a", "course-a", 17, "guide") })
        kbPrimitiveRejects({ => let _value = learnerActivityRecordSql("learner-a", "course-a", -1, "bank") })
    }

    @TestCase
    func userHistoryAndGridHaveIndependentBounds(): Unit {
        let total = learnerLearningDaysSql("learner-a")
        kbPrimitiveCheck(total.contains("COUNT(DISTINCT activity_date)") && total.contains("user_id='learner-a'"), "Learning days must count distinct dates for this user")
        kbPrimitiveCheck(!total.contains("BETWEEN") && !total.contains("JOIN courses"), "Keep cumulative days after course deletion and outside the grid")
        let grid = learnerActivityDaysSql("learner-a", "2026-06-05", "2026-10-22")
        kbPrimitiveCheck(grid.contains("user_id='learner-a'") && grid.contains("BETWEEN '2026-06-05' AND '2026-10-22'"), "Grid must be bounded and owner scoped")
        let days = [learnerActivityTestRow(["activity_date", "activity_count"], ["2026-10-21", "2"])]
        let value = jsonParse(learnerActivityJson("2026-10-22", "2026-06-05", days, 200)).getOrThrow().asObject()
        kbPrimitiveCheck(jsonGetInt(value, "learningDays").getOrThrow() == 200, "Cumulative days must not be capped to the grid")
        let item = jsonGetArray(value, "days").getOrThrow()[0].asObject()
        kbPrimitiveCheck(jsonGetInt(item, "count").getOrThrow() == 2, "Grid intensity must preserve distinct-resource counts")
        kbPrimitiveCheck(jsonGetString(value, "endDate").getOrThrow() == "2026-10-22", "Window ends on the captured Beijing date")
    }

    @TestCase
    func popularityCountsUniqueLearnersOnCurrentPublishedResources(): Unit {
        let sql = learnerPopularResourcesSql()
        for (required in ["COUNT(DISTINCT p.user_id)", "p.generation=w.generation", "p.lesson_index=l.lesson_index",
            "p.kind=w.kind", "p.is_read=1 OR p.completed=1 OR p.score IS NOT NULL", "w.is_current=1", "w.status='ready'",
            "w.published=1", "c.status='published'", "l.is_visible=1", "w.kind IN ('lecture','bank','slides')",
            "COALESCE(l.display_index,l.lesson_index) lesson_index", "ORDER BY learner_count DESC", "LIMIT 8"]) {
            kbPrimitiveCheck(sql.contains(required), "Missing popularity condition: " + required)
        }
        kbPrimitiveCheck(!sql.contains("NOT EXISTS") && !sql.contains("answers_json") && !sql.contains("content_json"),
            "Recommendations must retain learned resources without returning answers or bodies")
    }

    @TestCase
    func popularityJsonPreservesChineseMetadataAndPublicFields(): Unit {
        let columns = ["id", "title", "course_id", "course_name", "lesson_index", "lesson_title", "kind", "learner_count"]
        let row = learnerActivityTestRow(columns, ["resource-a", "事务\"入门\"", "course-a", "数据库", "2", "事务", "lecture", "3"])
        let guide = learnerActivityTestRow(columns, ["retired", "旧实操", "course-a", "数据库", "2", "事务", "guide", "99"])
        let raw = learnerPopularResourcesJson([row, guide])
        let items = jsonParse(raw).getOrThrow().asArray()
        kbPrimitiveCheck(items.size() == 1, "Retired resource types must not serialize")
        let item = items[0].asObject()
        kbPrimitiveCheck(jsonGetString(item, "title").getOrThrow() == "事务\"入门\"", "Use the UTF-8 safe JsonWriter")
        kbPrimitiveCheck(jsonGetInt(item, "learnerCount").getOrThrow() == 3, "Counts must remain real integers")
        kbPrimitiveCheck(jsonGetInt(item, "lessonIndex").getOrThrow() == 2, "Expose the navigation index")
        kbPrimitiveCheck(!raw.contains("correct") && !raw.contains("answers") && !raw.contains("userId"), "No quiz answers or learner identities belong in public rankings")
    }
}
