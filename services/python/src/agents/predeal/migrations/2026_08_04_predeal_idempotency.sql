-- predeal 幂等性 / 增量更新 / 失败恢复 迁移
-- 目标库: itn-platform  (MySQL 8.x / utf8mb4)
-- 说明:
--   knowledge_document.document_key   稳定逻辑键（domain_id + 相对路径），唯一
--   knowledge_document.content_sha256 当前内容 SHA256，用于幂等快路径判断
--   knowledge_document.ragflow_doc_id RAGFlow dataset 内的真实 document id
--   knowledge_document.last_ragflow_sha256 上次成功上传到 RAGFlow 的 chunked 文件哈希
--   knowledge_document.last_error     最近一次处理错误信息（失败恢复排查）
--   knowledge_chunk.content_hash      切片正文哈希（增量 diff 依据）
--   knowledge_chunk.status            active / superseded / archived（软删除状态机）
--   knowledge_chunk.updated_at        更新时间

ALTER TABLE knowledge_document
    ADD COLUMN document_key VARCHAR(255) NULL AFTER document_code,
    ADD COLUMN content_sha256 VARCHAR(128) NULL AFTER document_key,
    ADD COLUMN ragflow_doc_id VARCHAR(128) NULL AFTER ragflow_document_id,
    ADD COLUMN last_ragflow_sha256 VARCHAR(128) NULL AFTER ragflow_doc_id,
    ADD COLUMN last_error TEXT NULL AFTER status,
    ADD UNIQUE KEY uk_document_key (document_key);

ALTER TABLE knowledge_chunk
    ADD COLUMN content_hash VARCHAR(128) NULL AFTER content,
    ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active' AFTER ragflow_chunk_id,
    ADD COLUMN updated_at DATETIME NULL AFTER created_at,
    ADD KEY idx_chunk_doc_status (document_id, status);

-- figure binding 确定性缓存（LLM 图片归属结果，避免重复调用与非确定性漂移）
ALTER TABLE knowledge_figures
    ADD COLUMN bound_chunk_ids VARCHAR(255) NULL AFTER vlm_model,
    ADD COLUMN bound_context_hash VARCHAR(128) NULL AFTER bound_chunk_ids;
