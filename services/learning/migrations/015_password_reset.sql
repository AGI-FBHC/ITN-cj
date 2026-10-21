-- Bound password-reset verification attempts without changing existing codes.
ALTER TABLE email_verification_codes
    ADD COLUMN failed_attempts INT NOT NULL DEFAULT 0;
