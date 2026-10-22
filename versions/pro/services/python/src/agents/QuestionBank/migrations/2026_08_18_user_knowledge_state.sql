-- ============================================================================
-- T4.1 掌握度估计 · user_knowledge_state（2026-08-18）
-- 817 行动方案批次四·数据飞轮：mastery = 半衰期14天指数衰减加权正确率 ×
-- 置信折扣 min(1, n/5)；QuestionBank AttemptService.submit() 落库后增量更新。
--
-- 消费方：
--   - QuestionBank `GET /v1/practice/mastery`
--   - QuestionBank `question_selector.py`（frontier_first，配合 KnowledgeCore frontier 接口）
--   - KnowledgeCore `GET /api/v1/knowledge/graph/{domain_id}/frontier`（T4.2，同库直读）
--   - QuestionBank `qb graph-vote`（T4.3，按对先修知识点的掌握度分组）
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_knowledge_state (
    user_id VARCHAR(64) NOT NULL COMMENT '用户标识（独立模块不依赖 users 表）',
    category_id BIGINT NOT NULL COMMENT '知识点（knowledge_category.id）',
    mastery DECIMAL(4,3) NOT NULL DEFAULT 0.000 COMMENT '掌握度 0.000~1.000',
    evidence_count INT NOT NULL DEFAULT 0 COMMENT '参与计算的有效作答次数（is_correct 非 NULL）',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, category_id),
    KEY idx_uks_category (category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户知识点掌握度状态表（T4.1）';

-- ----------------------------------------------------------------------------
-- T4.3 作答数据投票（qb graph-vote）需要在先修边上记录检验结果，字段属于
-- KnowledgeCore 拥有的 knowledge_category_prerequisite 表（alembic 管理）；
-- 这里补一条幂等 ALTER 作为兜底——若 KnowledgeCore 侧的 T3.2/T4.3 迁移尚未
-- 加上该列，`qb graph-vote --apply` 首次写库前也能保证列已存在，避免跨仓库
-- 迁移顺序耦合。KnowledgeCore alembic 若已建同名列，本语句安全跳过（幂等）。
-- ----------------------------------------------------------------------------
SET @has_col := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'knowledge_category_prerequisite'
      AND column_name = 'evidence_json'
);
SET @stmt := IF(@has_col = 0,
    'ALTER TABLE knowledge_category_prerequisite
        ADD COLUMN evidence_json JSON NULL
        COMMENT ''证据快照（T3.2 defines/uses 概念共现 + T4.3 graph-vote 检验结果 vote）''',
    'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
