package web.service

import std.convert.*
import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User
import web.security.AuthUtilities

public class GardenService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func get(user: User, requested: Option<String>): String {
        return DbTransaction.run<String>(database, { tx =>
            let id = LearningActivityStore.learner(tx, user, requested)
            ensure(tx, user, id)
            return read(tx, user, id)
        })
    }
    public func record(user: User, object: JsonObject): String {
        let learner = ProfileJson.text(object, "learnerId", 36)
        let event = ProfileJson.text(object, "eventType", 64).getOrDefault({ => throw ProfileJson.invalid("缺少 eventType") })
        let title = ProfileJson.text(object, "title", 255).getOrDefault({ => throw ProfileJson.invalid("缺少 title") })
        let amount = ProfileJson.number(object, "amount", -2147483648, 2147483647).getOrDefault({ => throw ProfileJson.invalid("缺少 amount") })
        let metadata = ProfileJson.objectJson(object, "metadata", false)
        let reward = match (event) {
            case "quiz-answer-correct" => 5
            case "quiz-answer" => 1
            case "lecture-read" => 15
            case "guide-complete" => 20
            case "tutoring-finished" => 25
            case "note-taken" => 8
            case "courseware-complete" => 15
            case "focus-bonus" => if (amount < 0) { 0 } else if (amount > 25) { 25 } else { amount }
            case _ => if (amount > 0) { 0 } else { amount }
        }
        return DbTransaction.run<String>(database, { tx =>
            let id = LearningActivityStore.learner(tx, user, learner)
            ensure(tx, user, id)
            tx.execute("UPDATE growth_states SET orb = GREATEST(0, orb + ${reward}), updated_at = UTC_TIMESTAMP(6) " +
                "WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) + " AND learner_id = " + AuthUtilities.uuidSql(id))
            eventRow(tx, user, id, event, title, reward, metadata)
            return read(tx, user, id)
        })
    }
    public func nourish(user: User, requested: Option<String>): String {
        return DbTransaction.run<String>(database, { tx =>
            let id = LearningActivityStore.learner(tx, user, requested)
            ensure(tx, user, id)
            let old = tx.query("SELECT orb, watered FROM growth_states WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) +
                " AND learner_id = " + AuthUtilities.uuidSql(id) + " FOR UPDATE")[0]
            let spent = Int64.parse(old[0].getOrThrow())
            let total = Int64.parse(old[1].getOrThrow()) + spent
            let stage = if (total >= 280) { "tree" } else if (total >= 160) { "young_tree" }
                else if (total >= 80) { "seedling" } else if (total >= 30) { "sprout" } else { "seed" }
            tx.execute("UPDATE growth_states SET orb = 0, watered = ${total}, stage = " + AuthUtilities.text(stage) +
                ", updated_at = UTC_TIMESTAMP(6) WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) +
                " AND learner_id = " + AuthUtilities.uuidSql(id))
            if (spent > 0) { eventRow(tx, user, id, "nourish", "滋养园子", -spent, None) }
            return read(tx, user, id)
        })
    }
    private static func ensure(tx: DbTransaction, user: User, id: String): Unit {
        let exists = tx.query("SELECT 1 FROM growth_states WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) +
            " AND learner_id = " + AuthUtilities.uuidSql(id) + " FOR UPDATE")
        if (exists.isEmpty()) {
            tx.execute("INSERT INTO growth_states (id, user_id, learner_id, orb, watered, stage, updated_at) VALUES (" +
                AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " + AuthUtilities.uuidSql(user.getId()) + ", " +
                AuthUtilities.uuidSql(id) + ", 0, 0, 'seed', UTC_TIMESTAMP(6))")
        }
    }
    private static func eventRow(tx: DbTransaction, user: User, id: String, kind: String, title: String,
        amount: Int64, metadata: Option<String>): Unit {
        tx.execute("INSERT INTO growth_events (id, user_id, learner_id, event_type, title, amount, metadata_json, created_at) VALUES (" +
            AuthUtilities.uuidSql(AuthUtilities.uuid()) + ", " + AuthUtilities.uuidSql(user.getId()) + ", " +
            AuthUtilities.uuidSql(id) + ", " + AuthUtilities.text(kind) + ", " + AuthUtilities.text(title) +
            ", ${amount}, " + ProfileJson.textSql(metadata) + ", UTC_TIMESTAMP(6))")
    }
    private static func read(tx: DbTransaction, user: User, id: String): String {
        let filter = " WHERE user_id = " + AuthUtilities.uuidSql(user.getId()) + " AND learner_id = " + AuthUtilities.uuidSql(id)
        let state = JsonValue.fromStr(ProfileJson.row(["orb", "watered", "stage"],
            tx.query("SELECT orb, watered, stage FROM growth_states" + filter)[0], [0, 1])).asObject()
        let events = JsonArray()
        for (row in tx.query("SELECT event_type, title, amount, DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') " +
            "FROM growth_events" + filter + " ORDER BY created_at DESC LIMIT 30")) {
            events.add(JsonValue.fromStr(ProfileJson.row(["eventType", "title", "amount", "createdAt"], row, [2])))
        }
        state.put("events", events)
        return state.toString()
    }
}
