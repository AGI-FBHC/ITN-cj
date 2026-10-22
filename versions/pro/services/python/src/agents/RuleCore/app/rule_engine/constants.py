"""Rule Engine 常量定义（MVP 第一版能力边界）."""

# 条件运算符（§5.1）
OPERATORS = {"EQ", "NE", "GT", "GTE", "LT", "LTE", "IN", "NOT_IN", "EXISTS"}

# 结论类型（§5.3）
CONCLUSION_TYPES = {"SET", "MUST", "MUST_NOT", "SHOULD"}

# 规则状态
RULE_STATUS = {"ACTIVE", "DISABLED", "INVALID"}

# 检查状态
CHECK_STATUS = {"PENDING", "PASS", "FAIL", "SKIPPED"}

# 对照任务状态
COMPARE_STATUS = {"PENDING", "RUNNING", "DONE", "FAILED"}

# 前向推理最大轮数（§11.3）
MAX_REASONING_ROUNDS = 2

# 自动修正最大重试（§16）
MAX_REVISION_RETRY = 1

# 抽取置信度阈值（§8.4）
RULE_EXTRACT_CONFIDENCE_THRESHOLD = 0.80

# 候选段关键词（§8.2，只做候选过滤，最终由 LLM 判断）
CANDIDATE_KEYWORDS = [
    "必须", "不得", "禁止", "严禁", "应当", "应该", "应", "须",
    "不得超过", "至少", "不低于", "不高于", "超过", "低于",
    "当…时", "若", "如果", "只有", "之前", "之后",
]

# Checker 只强检查这两类（§15）
HARD_CHECK_TYPES = {"MUST", "MUST_NOT"}

# SHOULD 可检查但不导致 FAIL（§15）
SOFT_CHECK_TYPES = {"SHOULD"}
