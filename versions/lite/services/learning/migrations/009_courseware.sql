-- Courseware generated from a knowledge-base chapter.
CREATE TABLE IF NOT EXISTS kb_courseware (
    id CHAR(36) PRIMARY KEY,
    bundle_id CHAR(36) NOT NULL,
    doc_id CHAR(36) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    title VARCHAR(240) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'generating',
    published TINYINT NOT NULL DEFAULT 0,
    content_json MEDIUMTEXT NULL,
    model VARCHAR(160) NOT NULL DEFAULT '',
    error_message VARCHAR(500) NOT NULL DEFAULT '',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    KEY ix_cw_bundle (bundle_id, doc_id),
    CONSTRAINT fk_cw_bundle FOREIGN KEY (bundle_id) REFERENCES kb_bundles(id) ON DELETE CASCADE,
    CONSTRAINT fk_cw_doc FOREIGN KEY (doc_id) REFERENCES kb_bundle_docs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
