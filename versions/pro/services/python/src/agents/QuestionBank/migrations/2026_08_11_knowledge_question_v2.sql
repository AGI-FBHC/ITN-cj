-- ============================================================================
-- QuestionBank v2 表结构演进（2026-08-11）
-- 对齐《题库方案 v2》：evidence_refs 证据快照 / generation_metadata 生成元数据
-- / judge_details 判题详情。三张核心表结构不变，仅字段演进。
-- 幂等：CHANGE/ADD COLUMN 前检查列是否存在。
-- ============================================================================

-- 1. knowledge_question: source_chunk_ids → evidence_refs
--    生成时必须保存证据快照引用（chunk_id + document_id），
--    否则知识库内容变化后无法回答"这道题当年依据什么生成"。
SET @has_col := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'knowledge_question'
      AND column_name = 'source_chunk_ids'
);
SET @stmt := IF(@has_col > 0,
    'ALTER TABLE knowledge_question
        CHANGE COLUMN source_chunk_ids evidence_refs JSON NULL
        COMMENT ''出题依据的证据快照引用 [{chunk_id, document_id, score, source}]''',
    'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. knowledge_question: 新增 generation_metadata（生成溯源，方案 §34）
SET @has_col := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'knowledge_question'
      AND column_name = 'generation_metadata'
);
SET @stmt := IF(@has_col = 0,
    'ALTER TABLE knowledge_question
        ADD COLUMN generation_metadata JSON NULL
        COMMENT ''生成元数据 {model, prompt_version, knowledge_context_hash, knowledge_core_version, generated_at}''
        AFTER evidence_refs',
    'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. knowledge_question_attempt: 新增 judge_details（Answer Judge 输出落库，方案 §24）
SET @has_col := (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'knowledge_question_attempt'
      AND column_name = 'judge_details'
);
SET @stmt := IF(@has_col = 0,
    'ALTER TABLE knowledge_question_attempt
        ADD COLUMN judge_details JSON NULL
        COMMENT ''判题详情（客观题NULL；主观题存matched_points/missing_points/feedback/rationale）''
        AFTER score',
    'SELECT 1');
PREPARE s FROM @stmt; EXECUTE s; DEALLOCATE PREPARE s;
