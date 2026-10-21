-- Tavily 联网检索：管理员端保存开关、条数、深度与加密后的密钥。
-- 密钥列只存 encryptSecret 的密文，明文永不落库，页面只回显尾号提示。
ALTER TABLE kb_settings
    ADD COLUMN tavily_enabled TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN tavily_api_key_cipher TEXT NULL,
    ADD COLUMN tavily_api_key_hint VARCHAR(40) NOT NULL DEFAULT '',
    ADD COLUMN tavily_max_results INT NOT NULL DEFAULT 5,
    ADD COLUMN tavily_search_depth VARCHAR(16) NOT NULL DEFAULT 'basic';
