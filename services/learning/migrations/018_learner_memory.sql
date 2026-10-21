-- Per-user learning memory for Lumin. One durable row per learner.
CREATE TABLE IF NOT EXISTS user_learning_memory (
    user_id CHAR(36) NOT NULL,
    memory_version INT UNSIGNED NOT NULL DEFAULT 1,
    profile_summary VARCHAR(1800) NOT NULL DEFAULT '',
    learning_goals_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
    knowledge_level_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
    preferences_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
    strengths_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
    weaknesses_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
    active_topics_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
    tutor_notes_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
    recent_signals_json JSON NOT NULL DEFAULT (JSON_ARRAY()),
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (user_id),
    KEY ix_learner_memory_updated (updated_at),
    CONSTRAINT fk_learner_memory_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
