-- 对话 / 向量 / 语音各自独立的接口地址、模型与密钥。
-- 旧的 base_url / api_key_* 保留为兜底：某个槽位留空时回退到它，避免老配置失效。
ALTER TABLE kb_settings
    ADD COLUMN embedding_base_url VARCHAR(300) NOT NULL DEFAULT '',
    ADD COLUMN embedding_api_key_cipher TEXT NULL,
    ADD COLUMN embedding_api_key_hint VARCHAR(40) NOT NULL DEFAULT '',
    ADD COLUMN chat_base_url VARCHAR(300) NOT NULL DEFAULT '',
    ADD COLUMN chat_api_key_cipher TEXT NULL,
    ADD COLUMN chat_api_key_hint VARCHAR(40) NOT NULL DEFAULT '',
    ADD COLUMN tts_base_url VARCHAR(300) NOT NULL DEFAULT '',
    ADD COLUMN tts_api_key_cipher TEXT NULL,
    ADD COLUMN tts_api_key_hint VARCHAR(40) NOT NULL DEFAULT '';
