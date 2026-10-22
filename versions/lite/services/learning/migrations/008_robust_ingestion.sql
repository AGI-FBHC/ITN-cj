-- Additive migration for the isolated learning-v2 development database.
-- Run with a DDL-capable account, never change the application's saved model settings.
ALTER TABLE kb_bundles
    ADD COLUMN upload_hash CHAR(64) NULL,
    ADD COLUMN owner_id CHAR(36) NULL,
    ADD COLUMN course_id VARCHAR(40) NULL,
    ADD COLUMN source_saved TINYINT NOT NULL DEFAULT 0,
    ADD COLUMN organize_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN organize_retry_at DATETIME(6) NULL,
    ADD COLUMN logo_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    ADD COLUMN logo_svg MEDIUMTEXT NULL,
    ADD COLUMN logo_error VARCHAR(500) NOT NULL DEFAULT '',
    ADD COLUMN logo_model VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN logo_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN logo_generation_id CHAR(36) NULL,
    ADD UNIQUE KEY uk_bundle_upload_hash (upload_hash);

ALTER TABLE kb_bundle_docs
    ADD COLUMN document_id CHAR(36) NULL,
    ADD COLUMN original_content MEDIUMTEXT NULL,
    ADD KEY ix_bundle_document (document_id);

ALTER TABLE kb_documents
    ADD COLUMN bundle_id CHAR(36) NULL,
    ADD COLUMN source_path VARCHAR(1024) NOT NULL DEFAULT '',
    ADD COLUMN content_hash CHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN active_build_id CHAR(36) NOT NULL DEFAULT '',
    ADD COLUMN pending_build_id CHAR(36) NOT NULL DEFAULT '',
    ADD KEY ix_document_bundle (bundle_id),
    ADD CONSTRAINT fk_document_bundle FOREIGN KEY (bundle_id) REFERENCES kb_bundles(id) ON DELETE CASCADE;

ALTER TABLE kb_chunks
    DROP INDEX uk_kb_chunk,
    ADD COLUMN build_id CHAR(36) NOT NULL DEFAULT '',
    ADD COLUMN source_start INT NOT NULL DEFAULT 0,
    ADD COLUMN source_end INT NOT NULL DEFAULT 0,
    ADD COLUMN content_hash CHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN summary TEXT NULL,
    ADD COLUMN keywords_json TEXT NULL,
    ADD COLUMN summary_model VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN summary_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    ADD COLUMN summary_error VARCHAR(500) NOT NULL DEFAULT '',
    ADD COLUMN summary_attempts INT NOT NULL DEFAULT 0,
    ADD UNIQUE KEY uk_kb_chunk_build (document_id,build_id,chunk_index),
    ADD KEY ix_chunk_build (build_id,summary_status);

ALTER TABLE kb_embeddings ADD COLUMN space_key CHAR(64) NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS kb_ingest_jobs (
    id CHAR(36) PRIMARY KEY,
    document_id CHAR(36) NOT NULL,
    build_id CHAR(36) NOT NULL,
    source_hash CHAR(64) NOT NULL,
    config_hash CHAR(64) NOT NULL,
    title_snapshot VARCHAR(240) NOT NULL,
    source_content MEDIUMTEXT NOT NULL,
    settings_json MEDIUMTEXT NOT NULL,
    chat_model VARCHAR(160) NOT NULL DEFAULT '',
    embedding_model VARCHAR(160) NOT NULL DEFAULT '',
    embedding_dim INT NOT NULL DEFAULT 0,
    space_key CHAR(64) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    phase VARCHAR(24) NOT NULL DEFAULT 'chunking',
    summary_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    embedding_status VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,
    chunk_count INT NOT NULL DEFAULT 0,
    summary_count INT NOT NULL DEFAULT 0,
    embedded_count INT NOT NULL DEFAULT 0,
    error_message VARCHAR(1000) NOT NULL DEFAULT '',
    lease_owner VARCHAR(64) NOT NULL DEFAULT '',
    next_attempt_at DATETIME(6) NULL,
    started_at DATETIME(6) NULL,
    finished_at DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_document_build_config (document_id,source_hash,config_hash),
    KEY ix_ingest_worker (status,next_attempt_at,created_at),
    CONSTRAINT fk_ingest_document FOREIGN KEY (document_id) REFERENCES kb_documents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS logo_generations (
    id CHAR(36) PRIMARY KEY,
    owner_id CHAR(36) NULL,
    resource_type VARCHAR(40) NOT NULL DEFAULT '',
    resource_id VARCHAR(80) NOT NULL DEFAULT '',
    title VARCHAR(240) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    variants_json MEDIUMTEXT NULL,
    selected_variant_id VARCHAR(40) NOT NULL DEFAULT '',
    model VARCHAR(160) NOT NULL DEFAULT '',
    attempts INT NOT NULL DEFAULT 0,
    error_message VARCHAR(1000) NOT NULL DEFAULT '',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    KEY ix_logo_worker (status,created_at),
    KEY ix_logo_resource (resource_type,resource_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
