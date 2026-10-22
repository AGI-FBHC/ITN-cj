-- Run tools/backfill-courseware-current.py after 016 and before this index.
ALTER TABLE kb_courseware
    ADD UNIQUE KEY uk_courseware_current(doc_id,kind,is_current);
