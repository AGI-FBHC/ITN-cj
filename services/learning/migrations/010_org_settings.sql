-- Organisation branding, edited in the admin console and shown to learners after login.
CREATE TABLE IF NOT EXISTS org_settings (
    id TINYINT PRIMARY KEY,
    name VARCHAR(128) NOT NULL DEFAULT '',
    short_name VARCHAR(64) NOT NULL DEFAULT '',
    logo_mime VARCHAR(80) NOT NULL DEFAULT '',
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO org_settings (id, name, short_name) VALUES (1, '智训云枢', '智训云枢')
ON DUPLICATE KEY UPDATE id = id;
