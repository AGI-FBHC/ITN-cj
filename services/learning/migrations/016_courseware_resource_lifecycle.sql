ALTER TABLE kb_courseware
    ADD COLUMN is_current TINYINT NULL DEFAULT 1,
    ADD COLUMN generation INT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS lesson_resource_progress (
    user_id CHAR(36) NOT NULL,
    course_id VARCHAR(40) NOT NULL,
    lesson_index INT NOT NULL,
    kind VARCHAR(16) NOT NULL,
    generation INT NOT NULL DEFAULT 1,
    is_read TINYINT NOT NULL DEFAULT 0,
    score INT NULL,
    completed TINYINT NOT NULL DEFAULT 0,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY(user_id,course_id,lesson_index,kind),
    KEY ix_resource_lesson(course_id,lesson_index,kind),
    CONSTRAINT fk_resource_progress_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_resource_progress_lesson FOREIGN KEY(course_id,lesson_index) REFERENCES lessons(course_id,lesson_index) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
