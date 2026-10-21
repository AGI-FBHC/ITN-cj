-- Per-task courseware generation options. Existing rows keep using defaults.
ALTER TABLE kb_courseware
    ADD COLUMN options_json MEDIUMTEXT NULL;
