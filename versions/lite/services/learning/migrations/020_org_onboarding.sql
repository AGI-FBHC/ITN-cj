-- Per-organization public website and administrator-managed registration questions.
-- Both DDL statements are guarded so this migration can be re-run safely.
SET @has_org_website_url = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'organizations'
      AND COLUMN_NAME = 'website_url'
);
SET @ddl = IF(
    @has_org_website_url = 0,
    'ALTER TABLE `organizations` ADD COLUMN `website_url` VARCHAR(512) NOT NULL DEFAULT '''' AFTER `logo_mime`',
    'SELECT 1'
);
PREPARE org_website_url_stmt FROM @ddl;
EXECUTE org_website_url_stmt;
DEALLOCATE PREPARE org_website_url_stmt;

SET @has_org_onboarding_questions = (
    SELECT COUNT(*)
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'organizations'
      AND COLUMN_NAME = 'onboarding_questions_json'
);
SET @ddl = IF(
    @has_org_onboarding_questions = 0,
    'ALTER TABLE `organizations` ADD COLUMN `onboarding_questions_json` JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER `website_url`',
    'SELECT 1'
);
PREPARE org_onboarding_questions_stmt FROM @ddl;
EXECUTE org_onboarding_questions_stmt;
DEALLOCATE PREPARE org_onboarding_questions_stmt;
