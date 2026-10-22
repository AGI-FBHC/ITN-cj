-- T3.1 一次 LLM 通道（chunk enrichment）
-- 目标库: itn-platform  (MySQL 8.x / utf8mb4)
-- 说明:
--   knowledge_chunk_enrichment 记录每个切片单次 LLM 调用产出的检索增强信息：
--   概念定义/引用（供 T3.2 证据驱动先修边使用）、上下文前缀 + 可回答问题
--   （供 ragflow_packager2 拼进打包文本，见 T3.1 §4）、近重复提示（供 T3.5
--   索引期去冗余）、代码/表格摘要（T3.6，已并入本任务的 asset_summary 字段）。
--   分类结果（category_ids/confidence）仍写 knowledge_chunk_category，不在
--   本表重复存储，避免双写不一致；本表只存分类之外的增强信息。
--   content_hash 是缓存键：与 knowledge_chunk.content_hash 一致时视为已处理，
--   零 LLM 调用（chunk_enricher.get_chunks_needing_enrichment 依据此列判断）。

CREATE TABLE IF NOT EXISTS knowledge_chunk_enrichment (
    chunk_id BIGINT PRIMARY KEY,
    defines_json JSON,
    uses_json JSON,
    context_prefix TEXT,
    questions_json JSON,
    asset_summary TEXT,
    near_duplicate_hint TINYINT(1) DEFAULT 0,
    content_hash VARCHAR(128),
    updated_at DATETIME,
    KEY idx_near_duplicate (near_duplicate_hint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
