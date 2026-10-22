-- T3.5 索引期去冗余
-- 目标库: itn-platform  (MySQL 8.x / utf8mb4)
-- 说明:
--   knowledge_chunk.canonical_chunk_id 指向同文档内更早出现的"规范"切片；
--   由 predeal 的 chunk_enricher.dedup_document_chunks 在 enrichment 完成后
--   写入（依据 knowledge_chunk_enrichment.near_duplicate_hint + 文本相似度，
--   有 embedding 时可替换为向量相似度 ≥0.95）。取片检索侧据此过滤/降权
--   （检索侧改造见 KnowledgeCore retrieval_service.py，不在本迁移范围）。

ALTER TABLE knowledge_chunk
    ADD COLUMN canonical_chunk_id BIGINT NULL AFTER status,
    ADD KEY idx_canonical_chunk (canonical_chunk_id);
