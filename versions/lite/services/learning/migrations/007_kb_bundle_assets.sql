-- Only final image assets survive upload-workspace cleanup. No model settings are changed.
ALTER TABLE kb_bundle_docs ADD COLUMN source_path VARCHAR(1024) NOT NULL DEFAULT '';
ALTER TABLE kb_bundles ADD COLUMN warnings_json MEDIUMTEXT NULL;

CREATE TABLE IF NOT EXISTS kb_bundle_assets (
    id CHAR(36) PRIMARY KEY,
    bundle_id CHAR(36) NOT NULL,
    source_path VARCHAR(1024) NOT NULL,
    mime_type VARCHAR(80) NOT NULL,
    byte_size INT NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    KEY ix_bundle_assets (bundle_id),
    CONSTRAINT fk_bundle_assets FOREIGN KEY (bundle_id) REFERENCES kb_bundles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
