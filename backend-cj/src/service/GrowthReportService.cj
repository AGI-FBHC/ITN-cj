package web.service

import stdx.encoding.json.*
import web.config.DatabaseConfig
import web.database.DbTransaction
import web.domain.User

public class GrowthReportService {
    private let database: DatabaseConfig
    public init(database: DatabaseConfig) { this.database = database }
    public func get(user: User, requested: Option<String>): String {
        let id = DbTransaction.run<String>(database, { tx => LearningActivityStore.learner(tx, user, requested) })
        let learner = JsonValue.fromStr(LearnerProfileService(database).get(user, id)).asObject()
        let graph = JsonValue.fromStr(KnowledgePathService(database).graph()).asObject()
        let result = JsonObject()
        result.put("learner", learner)
        result.put("overall", learner.get("overallMastery").getOrThrow())
        result.put("blindSpots", learner.get("blindSpots").getOrDefault({ => JsonArray() }))
        result.put("pathRoadmap", graph.get("edges").getOrThrow())
        result.put("growth", JsonValue.fromStr(GardenService(database).get(user, Some(id))))
        return result.toString()
    }
}
