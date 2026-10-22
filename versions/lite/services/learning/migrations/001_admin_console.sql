-- One-time migration for the admin console.
-- Target: the isolated itn_learning_v2_dev database only. Never run against a legacy database.
-- Every statement is additive; safe defaults keep the learner app working unchanged.

ALTER TABLE users
    ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'learner' AFTER display_name;

ALTER TABLE courses
    ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'published',
    ADD COLUMN sort_order INT NOT NULL DEFAULT 100,
    ADD COLUMN updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6);

ALTER TABLE lessons
    ADD COLUMN updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6);

-- Keep the five seeded courses in their current learner-facing order.
UPDATE courses
SET sort_order = FIELD(id, 'ds', 'co', 'os', 'cn', 'agent')
WHERE sort_order = 100 AND FIELD(id, 'ds', 'co', 'os', 'cn', 'agent') > 0;
