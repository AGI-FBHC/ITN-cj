-- ============================================================================
-- QuestionBank 题库核心三表（2026-08-10）
--
-- 设计要点：
--   1. 表名前缀 knowledge_，与现有知识库有效表（knowledge_domain /
--      knowledge_category / knowledge_document / knowledge_chunk /
--      knowledge_chunk_category / knowledge_category_prerequisite）同一命名空间。
--   2. 题目为平台共享（无 owner 字段），created_by 仅记录创建来源。
--   3. 题目使用软删除（status=deprecated/rejected），不物理删除，
--      保护 question_attempt 历史作答与错题推导。
--   4. 题目-知识点为多对多，独立关联表，不直接在 question 上放单值列。
--   5. source_chunk_ids 存 knowledge_chunk.id 数组（bigint 数值），
--      对应出题依据的知识切片。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. knowledge_question 题目主表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_question (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '题目ID',
    question_type VARCHAR(32) NOT NULL COMMENT '题型 single_choice/multiple_choice/true_false/short_answer',
    difficulty TINYINT UNSIGNED NOT NULL DEFAULT 3 COMMENT '难度 1~5',
    cognitive_level VARCHAR(32) NOT NULL DEFAULT 'remember' COMMENT '认知层级 remember/understand/apply/analyze/evaluate/create',
    stem TEXT NOT NULL COMMENT '题干（支持Markdown）',
    options JSON NULL COMMENT '选择题选项[{key,text}]，非选择题为NULL',
    reference_answer JSON NOT NULL COMMENT '参考答案（单选"key"/多选[key]/判断true,false/简答文本）',
    explanation TEXT NULL COMMENT '答案解析',
    status VARCHAR(24) NOT NULL DEFAULT 'proposed' COMMENT '状态 proposed/active/rejected/deprecated',
    source_type VARCHAR(24) NOT NULL DEFAULT 'human' COMMENT '来源 human/llm/imported',
    source_chunk_ids JSON NULL COMMENT '出题依据的知识切片ID数组',
    content_hash CHAR(64) NULL COMMENT '题干+选项+答案的sha256，用于去重',
    metadata JSON NULL COMMENT '扩展元数据',
    created_by VARCHAR(64) NULL COMMENT '创建来源 human/agent/用户标识',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_question_content_hash (content_hash),
    KEY idx_question_status (status),
    KEY idx_question_type_difficulty (question_type, difficulty)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题目主表';

-- ---------------------------------------------------------------------------
-- 2. knowledge_question_knowledge_point 题目-知识点关联表（多对多）
--    一道题可关联多个知识点，一个知识点可被多道题考查。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_question_knowledge_point (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '关联ID',
    question_id BIGINT UNSIGNED NOT NULL COMMENT '题目ID',
    category_id BIGINT UNSIGNED NOT NULL COMMENT '知识点（knowledge_category.id）',
    role VARCHAR(32) NOT NULL DEFAULT 'primary' COMMENT '角色 primary/secondary/related',
    weight DECIMAL(3,2) NOT NULL DEFAULT 1.00 COMMENT '关联权重 0.00~1.00',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_question_category (question_id, category_id),
    KEY idx_kqp_category (category_id),
    KEY idx_kqp_question (question_id),
    CONSTRAINT fk_kqp_question FOREIGN KEY (question_id)
        REFERENCES knowledge_question (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='题目知识点关联表';

-- ---------------------------------------------------------------------------
-- 3. knowledge_question_attempt 用户作答记录
--    题目不物理删除（软删除），作答记录长期保留，是未来掌握度计算的数据源。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_question_attempt (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '作答ID',
    user_id VARCHAR(64) NOT NULL COMMENT '用户标识（独立模块不依赖users表）',
    question_id BIGINT UNSIGNED NOT NULL COMMENT '题目ID',
    submitted_answer JSON NULL COMMENT '用户提交的答案',
    is_correct TINYINT(1) NULL COMMENT '是否答对（主观题未判分为NULL）',
    score DECIMAL(5,2) NULL COMMENT '本题得分（0~100或0~1由题型决定）',
    started_at DATETIME NULL COMMENT '开始作答时间',
    submitted_at DATETIME NULL COMMENT '提交时间',
    duration_ms BIGINT NULL COMMENT '作答耗时（毫秒）',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_attempt_user_time (user_id, submitted_at),
    KEY idx_attempt_question (question_id),
    KEY idx_attempt_user_correct (user_id, is_correct),
    CONSTRAINT fk_attempt_question FOREIGN KEY (question_id)
        REFERENCES knowledge_question (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户作答记录表';
