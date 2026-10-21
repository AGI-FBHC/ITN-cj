-- Run the whole file with the MySQL CLI: the backfill contains DML.
CREATE TABLE IF NOT EXISTS learner_activity_days (
    user_id CHAR(36) NOT NULL,
    activity_date DATE NOT NULL,
    course_id VARCHAR(100) NOT NULL,
    lesson_index INT NOT NULL,
    kind VARCHAR(16) NOT NULL,
    PRIMARY KEY (user_id, activity_date, course_id, lesson_index, kind),
    CONSTRAINT fk_activity_day_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT ck_activity_day_kind CHECK (kind IN ('lesson', 'lecture', 'bank', 'slides'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Deliberately no course/lesson/resource FK: removal or regeneration must preserve learning days.
-- Existing DATETIME values were written with NOW() in the database's local wall clock.
-- Translate that clock to Beijing without requiring MySQL's named time-zone tables.
SET @learning_activity_bj_shift_seconds = TIMESTAMPDIFF(SECOND, NOW(), UTC_TIMESTAMP()) + 28800;

-- Only surviving, verifiable timestamps can be recovered. Do not expand ranges into invented days.
INSERT IGNORE INTO learner_activity_days (user_id, activity_date, course_id, lesson_index, kind)
SELECT p.user_id, DATE(TIMESTAMPADD(SECOND, @learning_activity_bj_shift_seconds, p.updated_at)),
       p.course_id, p.lesson_index, p.kind
FROM lesson_resource_progress p
WHERE p.kind IN ('lecture', 'bank', 'slides')
  AND (p.is_read = 1 OR p.completed = 1 OR p.score IS NOT NULL)
  AND p.updated_at IS NOT NULL AND p.updated_at <= NOW(6);

INSERT IGNORE INTO learner_activity_days (user_id, activity_date, course_id, lesson_index, kind)
SELECT q.user_id, DATE(TIMESTAMPADD(SECOND, @learning_activity_bj_shift_seconds, q.created_at)),
       q.course_id, q.lesson_index, 'bank'
FROM quiz_attempts q
WHERE q.created_at IS NOT NULL AND q.created_at <= NOW(6);

-- Generic legacy progress proves a lesson visit, not which resource was opened.
-- Do not add a generic event when typed progress or a quiz already proves that same day's visit.
INSERT IGNORE INTO learner_activity_days (user_id, activity_date, course_id, lesson_index, kind)
SELECT p.user_id, DATE(TIMESTAMPADD(SECOND, @learning_activity_bj_shift_seconds, p.updated_at)),
       p.course_id, p.lesson_index, 'lesson'
FROM lesson_progress p
WHERE (p.is_read = 1 OR p.completed = 1 OR p.score IS NOT NULL)
  AND p.updated_at IS NOT NULL AND p.updated_at <= NOW(6)
  AND NOT EXISTS (
      SELECT 1 FROM lesson_resource_progress typed
      WHERE typed.user_id = p.user_id AND typed.course_id = p.course_id AND typed.lesson_index = p.lesson_index
        AND typed.kind IN ('lecture', 'bank', 'slides')
        AND (typed.is_read = 1 OR typed.completed = 1 OR typed.score IS NOT NULL)
        AND typed.updated_at IS NOT NULL AND typed.updated_at <= NOW(6)
        AND DATE(TIMESTAMPADD(SECOND, @learning_activity_bj_shift_seconds, typed.updated_at)) =
            DATE(TIMESTAMPADD(SECOND, @learning_activity_bj_shift_seconds, p.updated_at))
  )
  AND NOT EXISTS (
      SELECT 1 FROM quiz_attempts quiz
      WHERE quiz.user_id = p.user_id AND quiz.course_id = p.course_id AND quiz.lesson_index = p.lesson_index
        AND quiz.created_at IS NOT NULL AND quiz.created_at <= NOW(6)
        AND DATE(TIMESTAMPADD(SECOND, @learning_activity_bj_shift_seconds, quiz.created_at)) =
            DATE(TIMESTAMPADD(SECOND, @learning_activity_bj_shift_seconds, p.updated_at))
  );
