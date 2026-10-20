-- Knowledge base + tutor schema. Target: the isolated itn_learning_v2_dev database only.
-- Additive only; the learner app keeps working without any of these rows.

CREATE TABLE IF NOT EXISTS kb_documents (
    id CHAR(36) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    source_name VARCHAR(240) NOT NULL DEFAULT '',
    source_type VARCHAR(16) NOT NULL DEFAULT 'paste',
    mime VARCHAR(100) NOT NULL DEFAULT '',
    byte_size INT NOT NULL DEFAULT 0,
    char_count INT NOT NULL DEFAULT 0,
    content MEDIUMTEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',
    chunk_count INT NOT NULL DEFAULT 0,
    embedded_count INT NOT NULL DEFAULT 0,
    embedding_model VARCHAR(160) NOT NULL DEFAULT '',
    error_message VARCHAR(500) NOT NULL DEFAULT '',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    indexed_at DATETIME(6) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kb_chunks (
    id CHAR(36) PRIMARY KEY,
    document_id CHAR(36) NOT NULL,
    chunk_index INT NOT NULL,
    heading_path VARCHAR(400) NOT NULL DEFAULT '',
    text MEDIUMTEXT NOT NULL,
    char_count INT NOT NULL DEFAULT 0,
    UNIQUE KEY uk_kb_chunk (document_id, chunk_index),
    KEY ix_kb_chunk_doc (document_id),
    CONSTRAINT fk_kb_chunk_doc FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Vectors are int8-quantised unit vectors, hex encoded. 1024 dims cost 2 KB instead
-- of ~20 KB as float text, and cosine stays accurate enough for retrieval.
CREATE TABLE IF NOT EXISTS kb_embeddings (
    chunk_id CHAR(36) PRIMARY KEY,
    model VARCHAR(160) NOT NULL,
    dim INT NOT NULL,
    vec_hex MEDIUMTEXT NOT NULL,
    CONSTRAINT fk_kb_embedding_chunk FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kb_settings (
    id TINYINT PRIMARY KEY,
    base_url VARCHAR(300) NOT NULL DEFAULT '',
    embedding_model VARCHAR(160) NOT NULL DEFAULT '',
    chat_model VARCHAR(160) NOT NULL DEFAULT '',
    embedding_dim INT NOT NULL DEFAULT 0,
    batch_size INT NOT NULL DEFAULT 16,
    chunk_size INT NOT NULL DEFAULT 800,
    chunk_overlap INT NOT NULL DEFAULT 120,
    top_k INT NOT NULL DEFAULT 6,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO kb_settings (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id;

CREATE TABLE IF NOT EXISTS tutor_messages (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    role VARCHAR(16) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    citations_json MEDIUMTEXT NULL,
    mode VARCHAR(24) NOT NULL DEFAULT 'general',
    course_id VARCHAR(40) NOT NULL DEFAULT '',
    lesson_index INT NOT NULL DEFAULT -1,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY ix_tutor_user (user_id, created_at),
    CONSTRAINT fk_tutor_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
