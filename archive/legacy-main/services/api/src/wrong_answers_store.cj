package itn_spire

import std.core.*
import std.collection.*
import std.convert.*
import stdx.encoding.json.*

/*
 * Wrong-answer persistence for learning_wrong_answers.
 * Ported from src/agents/app/storage/wrong_answers.py WrongAnswerStore,
 * including ON DUPLICATE KEY UPDATE, review streak/mastered rules and
 * ownership filters on every statement.
 */
public class WrongAnswersStore {
    private let conn: MyConnection

    public init(conn: MyConnection) {
        this.conn = conn
    }

    public func list(userId: Array<Byte>, keyword: ?String): Array<String> {
        var sql = "SELECT id,resource_id,question_id,stem,learner_id,kp_id,from_source,first_at," +
            "streak,last_pick,mastered,kb_refs_json,options_json,user_answer,correct_answer," +
            "explanation,difficulty,citations_json,knowledge_category_id,knowledge_category_name," +
            "knowledge_match_confidence,knowledge_match_locked,review_status,review_count," +
            "created_at,updated_at " +
            "FROM learning_wrong_answers WHERE user_id=" + sqlBinary(userId)
        match (keyword) {
            case Some(k) =>
                let trimmed = k.trimAscii()
                if (!trimmed.isEmpty()) {
                    let like = sqlQuote("%" + trimmed + "%")
                    sql = sql + " AND (stem LIKE " + like +
                        " OR explanation LIKE " + like +
                        " OR knowledge_category_name LIKE " + like + ")"
                }
            case None => ()
        }
        sql = sql + " ORDER BY updated_at DESC"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return Array<String>(0, repeat: "")
            case QueryOutcome.ResultSet(rs) =>
                let out = ArrayList<String>()
                for (row in rs.rows) {
                    out.add(serializeWrong(row))
                }
                return out.toArray()
        }
    }

    public func getWrong(userId: Array<Byte>, wrongId: Array<Byte>): ?String {
        match (conn.query(selectById(wrongId, userId))) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeWrong(rs.rows[0]))
        }
    }

    /* record() returns the row matching the unique key, like Python's list() scan. */
    private func findByQuestion(userId: Array<Byte>, resourceId: ?Array<Byte>,
                                questionId: String): ?String {
        var sql = "SELECT id,resource_id,question_id,stem,learner_id,kp_id,from_source,first_at," +
            "streak,last_pick,mastered,kb_refs_json,options_json,user_answer,correct_answer," +
            "explanation,difficulty,citations_json,knowledge_category_id,knowledge_category_name," +
            "knowledge_match_confidence,knowledge_match_locked,review_status,review_count," +
            "created_at,updated_at " +
            "FROM learning_wrong_answers WHERE user_id=" + sqlBinary(userId) +
            " AND question_id=" + sqlQuote(questionId) +
            " AND resource_id IS " + (match (resourceId) {
                case Some(_) => "NOT NULL"
                case None => "NULL"
            })
        match (resourceId) {
            case Some(rid) => sql = sql + " AND resource_id=" + sqlBinary(rid)
            case None => ()
        }
        sql = sql + " ORDER BY updated_at DESC LIMIT 1"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                return Some(serializeWrong(rs.rows[0]))
        }
    }

    /*
     * Mirrors WrongAnswerStore.record. Explicit knowledgeCategoryId locks the
     * match; otherwise auto-match overwrites both id and name (a failed match
     * leaves both NULL, even when the caller supplied a name hint).
     */
    public func record(userId: Array<Byte>, resourceId: ?Array<Byte>,
                       questionId: String, stem: String, options: Array<String>,
                       userAnswer: Int64, correctAnswer: Int64,
                       explanation: String, difficulty: String,
                       learnerId: ?Array<Byte>, kpId: ?String, fromSource: String,
                       kbRefs: Array<String>, citations: Array<String>,
                       knowledgeCategoryId: ?Int64,
                       knowledgeNameHint: ?String): ?String {
        var knowledgeId = knowledgeCategoryId
        var knowledgeName = knowledgeNameHint
        var confidence: ?Float64 = None
        var locked = 0
        match (knowledgeCategoryId) {
            case Some(_) => locked = 1
            case None =>
                try {
                    let matcher = KnowledgeMatcher(conn)
                    let text = (knowledgeNameHint ?? "") + " " + stem + " " + explanation
                    match (matcher.findMatch(text)) {
                        case Some(m) =>
                            knowledgeId = Some(m.id)
                            knowledgeName = Some(m.name)
                            confidence = Some(m.confidence)
                        case None =>
                            knowledgeId = None
                            knowledgeName = None
                            confidence = None
                    }
                } catch (_: Exception) {
                    /* enrichment only */
                    knowledgeId = None
                    knowledgeName = None
                    confidence = None
                }
        }
        let now = nowUtcParts()
        let wrongId = uuidV4()
        let sql = "INSERT INTO learning_wrong_answers " +
            "(id,user_id,learner_id,kp_id,from_source,first_at,streak,last_pick,mastered," +
            "resource_id,question_id,stem,options_json,user_answer,correct_answer,explanation,difficulty," +
            "citations_json,kb_refs_json,knowledge_category_id,knowledge_category_name," +
            "knowledge_match_confidence,knowledge_match_locked,review_status,review_count,created_at,updated_at) VALUES (" +
            sqlBinary(wrongId) + "," +
            sqlBinary(userId) + "," +
            sqlOptBinary(learnerId) + "," +
            sqlOptString(kpId) + "," +
            sqlQuote(fromSource) + "," +
            sqlQuote(mysqlDatetime(now)) + "," +
            "0," +
            sqlInt(userAnswer) + "," +
            "0," +
            sqlOptBinary(resourceId) + "," +
            sqlQuote(questionId) + "," +
            sqlQuote(stem) + "," +
            sqlQuote(jsonStringArray(options)) + "," +
            sqlInt(userAnswer) + "," +
            sqlInt(correctAnswer) + "," +
            sqlQuote(explanation) + "," +
            sqlQuote(difficulty) + "," +
            sqlQuote(jsonStringArray(citations)) + "," +
            sqlQuote(jsonStringArray(kbRefs)) + "," +
            sqlOptInt(knowledgeId) + "," +
            sqlOptString(knowledgeName) + "," +
            matchFloat(confidence) + "," +
            locked.toString() + "," +
            "'unreviewed',0," +
            sqlQuote(mysqlDatetime(now)) + "," +
            sqlQuote(mysqlDatetime(now)) + ") " +
            "ON DUPLICATE KEY UPDATE user_answer=VALUES(user_answer), explanation=VALUES(explanation)," +
            " review_status='unreviewed', first_at=COALESCE(first_at, VALUES(first_at))," +
            " streak=0, last_pick=VALUES(last_pick), mastered=0, updated_at=VALUES(updated_at)"
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        return findByQuestion(userId, resourceId, questionId)
    }

    public func update(userId: Array<Byte>, wrongId: Array<Byte>, req: WrongUpdate): ?String {
        let sets = ArrayList<String>()
        if (req.hasReviewStatus) {
            sets.add("review_status=" + sqlQuote(req.reviewStatus))
        }
        if (req.hasMastered) {
            sets.add("mastered=" + (if (req.mastered) { "1" } else { "0" }))
        }
        if (req.hasStreak) {
            sets.add("streak=" + sqlInt(req.streak))
        }
        if (req.hasLastPick) {
            sets.add("last_pick=" + sqlInt(req.lastPick))
        }
        /* Python updates knowledge fields when knowledge_category_id is present,
         * even if its value is null (clears the match and locks). */
        if (req.hasKnowledge) {
            sets.add("knowledge_category_id=" + sqlOptInt(req.knowledgeCategoryId))
            sets.add("knowledge_category_name=" + sqlOptString(req.knowledgeCategoryName))
            sets.add("knowledge_match_confidence=NULL")
            sets.add("knowledge_match_locked=1")
        }
        if (!sets.isEmpty()) {
            sets.add("updated_at=" + sqlQuote(mysqlDatetime(nowUtcParts())))
            var clause = ""
            var first = true
            for (s in sets) {
                if (!first) {
                    clause = clause + ", "
                }
                first = false
                clause = clause + s
            }
            let sql = "UPDATE learning_wrong_answers SET " + clause +
                " WHERE id=" + sqlBinary(wrongId) + " AND user_id=" + sqlBinary(userId)
            match (conn.query(sql)) {
                case QueryOutcome.Ok(_) => ()
                case QueryOutcome.ResultSet(_) => ()
            }
        }
        /* Return the owned row when it exists (Python 404s on a no-op UPDATE
         * because affected_rows is 0; that is a pymysql quirk, not a contract). */
        return getWrong(userId, wrongId)
    }

    /* Returns None when missing; the review payload is built by the API layer. */
    public func review(userId: Array<Byte>, wrongId: Array<Byte>, answer: Int64): ?ReviewOutcome {
        let sel = "SELECT options_json,correct_answer,mastered FROM learning_wrong_answers" +
            " WHERE id=" + sqlBinary(wrongId) + " AND user_id=" + sqlBinary(userId)
        var options: Array<String> = []
        var correctAnswer: Int64 = -1
        var mastered = 0
        match (conn.query(sel)) {
            case QueryOutcome.Ok(_) => return None
            case QueryOutcome.ResultSet(rs) =>
                if (rs.rows.isEmpty()) {
                    return None
                }
                let row = rs.rows[0]
                options = parseStringArrayText(cellText(row, 0))
                correctAnswer = Int64.tryParse(cellText(row, 1)) ?? -1
                mastered = Int64.tryParse(cellText(row, 2)) ?? 0
        }
        if (answer >= options.size) {
            return Some(ReviewOutcome.indexOutOfRange())
        }
        let correct = answer == correctAnswer
        /* MySQL UPDATE SET references the pre-update row, matching the Python CASE expressions. */
        let sql = "UPDATE learning_wrong_answers SET last_pick=" + sqlInt(answer) + "," +
            " streak=CASE WHEN " + (if (correct) { "1" } else { "0" }) + " THEN streak+1 ELSE 0 END," +
            " mastered=CASE WHEN " + (if (correct) { "1" } else { "0" }) + " THEN " + sqlInt(mastered) + " ELSE 0 END," +
            " review_status=CASE WHEN " + sqlInt(mastered) + "=1 AND " + (if (correct) { "1" } else { "0" }) +
            " THEN 'mastered' ELSE 'reviewing' END," +
            " review_count=review_count+1," +
            " updated_at=" + sqlQuote(mysqlDatetime(nowUtcParts())) +
            " WHERE id=" + sqlBinary(wrongId) + " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
        match (getWrong(userId, wrongId)) {
            case None => return None
            case Some(item) => return Some(ReviewOutcome.done(item, correct))
        }
    }

    public func delete(userId: Array<Byte>, wrongId: Array<Byte>): Bool {
        let sql = "DELETE FROM learning_wrong_answers WHERE id=" + sqlBinary(wrongId) +
            " AND user_id=" + sqlBinary(userId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(ok) => return ok.affectedRows > 0
            case QueryOutcome.ResultSet(_) => return false
        }
    }

    /* 重新练习：清除该用户对此资源的全部错题记录。 */
    public func deleteByResource(userId: Array<Byte>, resourceId: Array<Byte>): Unit {
        let sql = "DELETE FROM learning_wrong_answers WHERE user_id=" + sqlBinary(userId) +
            " AND resource_id=" + sqlBinary(resourceId)
        match (conn.query(sql)) {
            case QueryOutcome.Ok(_) => ()
            case QueryOutcome.ResultSet(_) => ()
        }
    }
}

private func selectById(wrongId: Array<Byte>, userId: Array<Byte>): String {
    "SELECT id,resource_id,question_id,stem,learner_id,kp_id,from_source,first_at," +
        "streak,last_pick,mastered,kb_refs_json,options_json,user_answer,correct_answer," +
        "explanation,difficulty,citations_json,knowledge_category_id,knowledge_category_name," +
        "knowledge_match_confidence,knowledge_match_locked,review_status,review_count," +
        "created_at,updated_at " +
        "FROM learning_wrong_answers WHERE id=" + sqlBinary(wrongId) +
        " AND user_id=" + sqlBinary(userId)
}

public struct WrongUpdate {
    public let hasReviewStatus: Bool
    public let reviewStatus: String
    public let hasMastered: Bool
    public let mastered: Bool
    public let hasStreak: Bool
    public let streak: Int64
    public let hasLastPick: Bool
    public let lastPick: Int64
    /* True only when the request included knowledge_category_id (Pydantic exclude_unset). */
    public let hasKnowledge: Bool
    public let knowledgeCategoryId: ?Int64
    public let knowledgeCategoryName: ?String

    public init(hasReviewStatus: Bool, reviewStatus: String, hasMastered: Bool, mastered: Bool,
                hasStreak: Bool, streak: Int64, hasLastPick: Bool, lastPick: Int64,
                hasKnowledge: Bool, knowledgeCategoryId: ?Int64, knowledgeCategoryName: ?String) {
        this.hasReviewStatus = hasReviewStatus
        this.reviewStatus = reviewStatus
        this.hasMastered = hasMastered
        this.mastered = mastered
        this.hasStreak = hasStreak
        this.streak = streak
        this.hasLastPick = hasLastPick
        this.lastPick = lastPick
        this.hasKnowledge = hasKnowledge
        this.knowledgeCategoryId = knowledgeCategoryId
        this.knowledgeCategoryName = knowledgeCategoryName
    }
}

public class ReviewOutcome {
    public let outOfRange: Bool
    public let item: ?String
    public let correct: Bool

    public static func indexOutOfRange(): ReviewOutcome {
        ReviewOutcome(true, None, false)
    }

    public static func done(item: String, correct: Bool): ReviewOutcome {
        ReviewOutcome(false, Some(item), correct)
    }

    public init(outOfRange: Bool, item: ?String, correct: Bool) {
        this.outOfRange = outOfRange
        this.item = item
        this.correct = correct
    }
}

private func serializeWrong(row: Array<MyCell>): String {
    let obj = JsonWriter()
    obj.putOptStr("id", uuidText(row, 0))
    obj.putOptStr("resourceId", uuidText(row, 1))
    obj.putStr("questionId", cellText(row, 2))
    obj.putStr("stem", cellText(row, 3))
    obj.putOptStr("learnerId", uuidText(row, 4))
    obj.putOptStr("kpId", optCellText(row, 5))
    obj.putOptStr("fromSource", optCellText(row, 6))
    /* firstAt falls back to created_at when the column is NULL. */
    let firstAt = optCellText(row, 7)
    obj.putStr("firstAt", isoUtcZFromDb(match (firstAt) {
        case Some(t) => t
        case None => cellText(row, 24)
    }))
    obj.putInt("streak", optCellInt(row, 8) ?? 0)
    obj.putOptInt("lastPick", optCellInt(row, 9))
    obj.putBool("mastered", (optCellInt(row, 10) ?? 0) != 0)
    obj.putRaw("kbRefs", parseJsonArrayText(cellText(row, 11)))
    obj.putRaw("options", parseJsonArrayText(cellText(row, 12)))
    obj.putInt("userAnswer", optCellInt(row, 13) ?? 0)
    obj.putInt("correctAnswer", optCellInt(row, 14) ?? 0)
    obj.putStr("explanation", cellText(row, 15))
    obj.putStr("difficulty", cellText(row, 16))
    obj.putRaw("citations", parseJsonArrayText(cellText(row, 17)))
    obj.putOptInt("knowledgeCategoryId", optCellInt(row, 18))
    obj.putOptStr("knowledgeCategoryName", optCellText(row, 19))
    obj.putOptFloat("knowledgeMatchConfidence", optCellFloat(row, 20))
    obj.putOptBool("knowledgeMatchLocked", optCellBool(row, 21))
    obj.putStr("reviewStatus", cellText(row, 22))
    obj.putInt("reviewCount", optCellInt(row, 23) ?? 0)
    obj.putStr("createdAt", isoUtcZFromDb(cellText(row, 24)))
    obj.putStr("updatedAt", isoUtcZFromDb(cellText(row, 25)))
    return obj.toJson()
}

private func parseStringArrayText(text: String): Array<String> {
    let out = ArrayList<String>()
    let trimmed = text.trimAscii()
    if (trimmed.isEmpty() || !trimmed.startsWith("[")) {
        return out.toArray()
    }
    match (jsonParse(trimmed)) {
        case None => return out.toArray()
        case Some(v) =>
            match (v.kind()) {
                case JsonKind.JsArray =>
                    let arr = v.asArray()
                    var i: Int64 = 0
                    while (i < arr.size()) {
                        match (arr.get(i)) {
                            case Some(item) =>
                                match (item.kind()) {
                                    case JsonKind.JsString => out.add(item.asString().getValue())
                                    case _ => ()
                                }
                            case None => ()
                        }
                        i += 1
                    }
                case _ => ()
            }
    }
    return out.toArray()
}
