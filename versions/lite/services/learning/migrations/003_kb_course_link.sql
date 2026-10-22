-- Courses are now generated from a knowledge-base document.
-- Target: the isolated itn_learning_v2_dev database only.

ALTER TABLE kb_documents
    ADD COLUMN course_id VARCHAR(40) NULL,
    ADD KEY ix_kb_doc_course (course_id);
