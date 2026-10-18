package web.exception
public class ErrorCode {
    public static let VALIDATION_FAILED: Int32 = 1000
    public static let EMAIL_ALREADY_REGISTERED: Int32 = 1001
    public static let VERIFICATION_CODE_INVALID: Int32 = 1002
    public static let VERIFICATION_CODE_RATE_LIMITED: Int32 = 1003
    public static let EMAIL_SEND_FAILED: Int32 = 1004
    public static let INVALID_CREDENTIALS: Int32 = 1005
    public static let UNAUTHORIZED: Int32 = 1006
    public static let ACCOUNT_DISABLED: Int32 = 1007
    public static let EMAIL_NOT_FOUND: Int32 = 1008
    public static let PROFILE_NOT_FOUND: Int32 = 2000
    public static let LEARNING_GOAL_NOT_FOUND: Int32 = 2001
    public static let AGENT_SERVICE_FAILED: Int32 = 3000
    public static let AGENT_SERVICE_UNAVAILABLE: Int32 = 3001
    public static let KNOWLEDGE_POINT_NOT_FOUND: Int32 = 3002
    public static let REVIEW_SCHEDULE_NOT_FOUND: Int32 = 3003
    public static let LEARNER_NOT_FOUND: Int32 = 3004
    public static let KNOWLEDGE_ARTICLE_NOT_FOUND: Int32 = 4000
    public static let KNOWLEDGE_ASSET_NOT_FOUND: Int32 = 4001
    public static let INTERNAL_ERROR: Int32 = 1500
    private init() {}
}
