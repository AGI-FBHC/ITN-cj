-- Model credentials live in the admin console now.
-- The API key is stored encrypted at rest; only a 4-character hint stays readable.
ALTER TABLE kb_settings
    ADD COLUMN api_key_cipher TEXT NULL,
    ADD COLUMN api_key_hint VARCHAR(40) NOT NULL DEFAULT '',
    ADD COLUMN tts_model VARCHAR(160) NOT NULL DEFAULT '',
    ADD COLUMN tts_voice VARCHAR(80) NOT NULL DEFAULT '';
