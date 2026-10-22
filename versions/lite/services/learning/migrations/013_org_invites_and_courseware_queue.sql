-- Organization membership, registration invitations, per-organization logos,
-- and the configurable courseware generation worker limit.
CREATE TABLE IF NOT EXISTS organizations (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    short_name VARCHAR(64) NOT NULL,
    invite_code VARCHAR(64) NULL,
    logo_mime VARCHAR(80) NOT NULL DEFAULT '',
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    UNIQUE KEY uk_org_invite (invite_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO organizations (id, name, short_name, logo_mime)
SELECT '00000000-0000-0000-0000-000000000001',
       IF(s.name = '' OR s.name = '智训云枢', '江南大学', s.name),
       IF(s.short_name = '' OR s.short_name = '智训云枢', '江南大学', s.short_name),
       s.logo_mime
FROM org_settings s WHERE s.id = 1
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    short_name = VALUES(short_name),
    logo_mime = IF(organizations.logo_mime = '', VALUES(logo_mime), organizations.logo_mime);

INSERT INTO organizations (id, name, short_name)
VALUES ('00000000-0000-0000-0000-000000000001', '江南大学', '江南大学')
ON DUPLICATE KEY UPDATE id = id;

ALTER TABLE users
    ADD COLUMN org_id CHAR(36) NULL AFTER role;

UPDATE users
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

ALTER TABLE users
    MODIFY COLUMN org_id CHAR(36) NOT NULL,
    ADD KEY ix_users_org (org_id),
    ADD CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id);

ALTER TABLE kb_settings
    ADD COLUMN max_courseware_parallel INT NOT NULL DEFAULT 10 AFTER top_k;
