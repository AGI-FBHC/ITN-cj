-- Add durable tutor conversation identities while preserving legacy history.
-- The column is initially nullable so re-running the backfill never rewrites
-- conversations created after this migration.
SET @has_conversation_column = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tutor_messages'
      AND COLUMN_NAME = 'conversation_id'
);
SET @ddl = IF(
    @has_conversation_column = 0,
    'ALTER TABLE `tutor_messages` ADD COLUMN `conversation_id` VARCHAR(96) NULL AFTER `mode`',
    'SELECT 1'
);
PREPARE tutor_conversation_column_stmt FROM @ddl;
EXECUTE tutor_conversation_column_stmt;
DEALLOCATE PREPARE tutor_conversation_column_stmt;

-- Legacy lesson pairs with the same course/chapter intentionally share one
-- conversation. Empty course IDs form the single legacy `general` thread.
UPDATE `tutor_messages`
SET `conversation_id` = CASE
    WHEN COALESCE(`course_id`, '') = '' THEN 'general'
    ELSE CONCAT('lesson:', `course_id`, ':', COALESCE(`lesson_index`, -1))
END
WHERE `conversation_id` IS NULL OR `conversation_id` = '';

ALTER TABLE `tutor_messages`
    MODIFY COLUMN `conversation_id` VARCHAR(96) NOT NULL DEFAULT 'general';

SET @has_conversation_index = (
    SELECT COUNT(*)
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'tutor_messages'
      AND INDEX_NAME = 'ix_tutor_conversation'
);
SET @ddl = IF(
    @has_conversation_index = 0,
    'ALTER TABLE `tutor_messages` ADD INDEX `ix_tutor_conversation` (`user_id`, `conversation_id`, `created_at`, `id`)',
    'SELECT 1'
);
PREPARE tutor_conversation_index_stmt FROM @ddl;
EXECUTE tutor_conversation_index_stmt;
DEALLOCATE PREPARE tutor_conversation_index_stmt;
