-- T4.6 图谱增量重审 · predeal 侧生产队列
-- 目标库: itn-platform  (MySQL 8.x / utf8mb4)
-- 说明:
--   predeal 的 chunk_repository.sync_chunks 每次同步后，把本轮判定为
--   updated（内容变了，原位置覆盖）或 superseded（原切片消失，软删）的
--   chunk_id 写入本表——这些切片的旧内容/旧分类可能是某些 LLM 生成的
--   先修边的证据来源，内容一变，那些边就该被重新审视。
--   本表只是队列（生产者是 predeal，消费者是 KnowledgeCore 的图谱模块）：
--   KnowledgeCore 定期任务按 chunk_id 反查 knowledge_chunk_category 定位
--   知识点，把该知识点下 generation_source='llm' 的边置 needs_review，
--   然后自行清理/标记本表中已处理的行。predeal 侧只负责写入，写入失败
--   （例如迁移尚未执行）静默吞掉，绝不影响 chunk 同步主流程。

CREATE TABLE IF NOT EXISTS graph_review_pending (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    chunk_id BIGINT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
