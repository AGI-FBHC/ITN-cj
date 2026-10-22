-- Execute the whole file with the MySQL CLI; this migration also contains DML.
-- A NULL title means automatic: read the first user message without overwriting custom titles.
CREATE TABLE IF NOT EXISTS tutor_conversations (
    user_id CHAR(36) NOT NULL,
    conversation_id VARCHAR(96) NOT NULL,
    title VARCHAR(64) NULL DEFAULT NULL,
    archived TINYINT(1) NOT NULL DEFAULT 0,
    course_id VARCHAR(100) NOT NULL DEFAULT '',
    lesson_index INT NOT NULL DEFAULT -1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (user_id, conversation_id),
    KEY ix_tutor_conversation_list (user_id, archived, updated_at, conversation_id),
    CONSTRAINT fk_tutor_conversation_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Re-running never changes a previously managed title, archive flag, or timestamp.
-- Request handlers also read missing metadata directly from owner-scoped legacy messages.
INSERT INTO tutor_conversations (user_id, conversation_id, created_at, updated_at)
SELECT messages.user_id, messages.conversation_id, MIN(messages.created_at), MAX(messages.created_at)
FROM tutor_messages messages
WHERE NOT EXISTS (
    SELECT 1 FROM tutor_conversations existing
    WHERE existing.user_id = messages.user_id
      AND existing.conversation_id = messages.conversation_id
)
GROUP BY messages.user_id, messages.conversation_id
ON DUPLICATE KEY UPDATE conversation_id = tutor_conversations.conversation_id;
