-- Chapter-level courseware publishing: an admin picks the order number when a chapter goes live.
CREATE TABLE IF NOT EXISTS kb_courseware_chapters (
    bundle_id VARCHAR(36) NOT NULL,
    doc_id VARCHAR(36) NOT NULL,
    order_no INT NOT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (bundle_id, doc_id),
    UNIQUE KEY uk_chapter_order (bundle_id, order_no),
    CONSTRAINT fk_cw_chapter_bundle FOREIGN KEY (bundle_id) REFERENCES kb_bundles (id) ON DELETE CASCADE,
    CONSTRAINT fk_cw_chapter_doc FOREIGN KEY (doc_id) REFERENCES kb_bundle_docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
