-- Keep permanent lesson identities separate from the current learner-facing order.
-- Additive migration for itn_learning_v2_dev; existing lessons remain visible.
ALTER TABLE lessons
    ADD COLUMN source_doc_id CHAR(36) NULL,
    ADD COLUMN display_index INT NULL,
    ADD COLUMN is_visible TINYINT NOT NULL DEFAULT 1,
    ADD UNIQUE KEY uk_lesson_source (course_id, source_doc_id);

-- Replayed attempts return their saved result even after resource content changes.
ALTER TABLE quiz_attempts
    ADD COLUMN correct_count INT NULL,
    ADD COLUMN question_count INT NULL;
