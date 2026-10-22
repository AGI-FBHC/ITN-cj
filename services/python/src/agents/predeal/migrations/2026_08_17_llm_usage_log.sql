-- T2.2 trace id 贯穿 + LLM 记账
-- 目标库: itn-platform  (MySQL 8.x / utf8mb4)
-- 说明:
--   llm_usage_log 记录 agents / KnowledgeCore / QuestionBank 三个服务每次 LLM 调用的
--   trace_id（与请求链路的 X-Request-Id 一致）、feature（调用方标识，如
--   chat / classification / question_gen / evidence_judge）、token 用量与耗时，
--   用于跨服务串联同一条链路 + 成本观测。写入均为 fire-and-forget，失败不影响主流程。

CREATE TABLE IF NOT EXISTS llm_usage_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    trace_id VARCHAR(64),
    service VARCHAR(32),
    feature VARCHAR(64),
    model VARCHAR(64),
    in_tokens INT,
    out_tokens INT,
    latency_ms INT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_feature (feature),
    KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
