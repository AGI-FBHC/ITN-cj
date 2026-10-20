-- Uploaded archives are unpacked in a temporary workspace and organised by the
-- agent; only the normalised result is kept here.
CREATE TABLE IF NOT EXISTS kb_bundles (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(240) NOT NULL DEFAULT '',
    bytes INT NOT NULL DEFAULT 0,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    steps INT NOT NULL DEFAULT 0,
    model VARCHAR(160) NOT NULL DEFAULT '',
    title VARCHAR(240) NOT NULL DEFAULT '',
    error_message VARCHAR(500) NOT NULL DEFAULT '',
    log_text MEDIUMTEXT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS kb_bundle_docs (
    id CHAR(36) PRIMARY KEY,
    bundle_id CHAR(36) NOT NULL,
    order_index INT NOT NULL,
    title VARCHAR(240) NOT NULL,
    content MEDIUMTEXT NOT NULL,
    char_count INT NOT NULL DEFAULT 0,
    KEY ix_bundle_docs (bundle_id, order_index),
    CONSTRAINT fk_bundle_docs FOREIGN KEY (bundle_id) REFERENCES kb_bundles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
