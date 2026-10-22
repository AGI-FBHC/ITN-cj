-- Retire practical-guide resources as a supported courseware kind.
--
-- This migration is intentionally a one-off data cleanup, not an additive
-- schema migration. It is safe to run more than once:
--   * guide courseware/progress rows are selected by kind;
--   * merged guide sections are identified by the stable signature emitted by
--     cwSyncBundleCourseLocked: id=cw-N, eyebrow=实操;
--   * only managed kb-courseware lessons are touched, so legacy courses with
--     their own "实操" sections are preserved;
--   * bookmarks are removed only when they explicitly identify guide content.
--
-- The application's tools/apply-schema.py intentionally accepts additive DDL
-- only, so it cannot execute this file. See the deployment note in TRACE.md.

SET SESSION group_concat_max_len = 67108864;

START TRANSACTION;

-- Rebuild only the top-level sections of managed lessons. A guide-only lesson
-- becomes sections=[] rather than retaining its old practical-guide text.
UPDATE lessons l
JOIN (
    SELECT
        l2.course_id,
        l2.lesson_index,
        CAST(
            CONCAT(
                '[',
                COALESCE(
                    GROUP_CONCAT(
                        CASE
                            WHEN s.ord IS NULL
                            THEN NULL
                            WHEN s.section_id REGEXP '^cw-[0-9]+$'
                             AND s.eyebrow = '实操'
                            THEN NULL
                            ELSE CAST(s.section_doc AS CHAR)
                        END
                        ORDER BY s.ord
                        SEPARATOR ','
                    ),
                    ''
                ),
                ']'
            ) AS JSON
        ) AS sections
    FROM lessons l2
    LEFT JOIN JSON_TABLE(
        l2.content_json,
        '$.sections[*]' COLUMNS (
            ord FOR ORDINALITY,
            section_doc JSON PATH '$',
            section_id VARCHAR(200) PATH '$.id',
            eyebrow VARCHAR(80) PATH '$.eyebrow'
        )
    ) s ON TRUE
    WHERE (l2.source_doc_id IS NOT NULL AND l2.source_doc_id <> '')
       OR JSON_UNQUOTE(JSON_EXTRACT(l2.sources_json, '$[0].kind')) = 'kb-courseware'
    GROUP BY l2.course_id, l2.lesson_index
) rebuilt
  ON rebuilt.course_id = l.course_id
 AND rebuilt.lesson_index = l.lesson_index
SET l.content_json = JSON_SET(l.content_json, '$.sections', rebuilt.sections)
WHERE JSON_LENGTH(l.content_json, '$.sections') > JSON_LENGTH(rebuilt.sections);

-- Remove only bookmarks with an explicit guide marker. Do not infer from
-- arbitrary headings: lecture and guide sections can share similar text.
UPDATE user_state s
JOIN (
    SELECT
        s2.user_id,
        CAST(
            CONCAT(
                '[',
                COALESCE(
                    GROUP_CONCAT(
                        CASE
                            WHEN b.ord IS NULL THEN NULL
                            WHEN LOWER(COALESCE(b.resource_kind, '')) = 'guide' THEN NULL
                            WHEN COALESCE(b.resource_kind, '') = ''
                             AND (b.bookmark_id LIKE '%-guide-%'
                                  OR b.bookmark_id LIKE 'guide-%')
                            THEN NULL
                            ELSE CAST(b.item AS CHAR)
                        END
                        ORDER BY b.ord
                        SEPARATOR ','
                    ),
                    ''
                ),
                ']'
            ) AS JSON
        ) AS bookmarks
    FROM user_state s2
    LEFT JOIN JSON_TABLE(
        s2.bookmarks_json,
        '$[*]' COLUMNS (
            ord FOR ORDINALITY,
            item JSON PATH '$',
            resource_kind VARCHAR(32) PATH '$.resourceKind',
            bookmark_id VARCHAR(300) PATH '$.id'
        )
    ) b ON TRUE
    GROUP BY s2.user_id
    HAVING SUM(
        CASE
            WHEN LOWER(COALESCE(b.resource_kind, '')) = 'guide'
              OR (
                  COALESCE(b.resource_kind, '') = ''
                  AND (b.bookmark_id LIKE '%-guide-%'
                       OR b.bookmark_id LIKE 'guide-%')
              )
            THEN 1
            ELSE 0
        END
    ) > 0
) rebuilt
  ON rebuilt.user_id = s.user_id
SET s.bookmarks_json = rebuilt.bookmarks;

-- Recompute aggregate progress while guide progress still exists, but ignore
-- guide rows in the remaining-resource checks. This also handles orphan guide
-- progress whose lesson no longer has resources.guide.
UPDATE lesson_progress p
JOIN lessons l
  ON l.course_id = p.course_id
 AND l.lesson_index = p.lesson_index
SET p.is_read = IF(
        EXISTS (
            SELECT 1
            FROM lesson_resource_progress r
            WHERE r.user_id = p.user_id
              AND r.course_id = p.course_id
              AND r.lesson_index = p.lesson_index
              AND r.kind <> 'guide'
              AND r.is_read = 1
        ),
        1,
        IF(p.score IS NOT NULL, 1, 0)
    ),
    p.completed = IF(
        p.score >= 60,
        1,
        IF(
            EXISTS (
                SELECT 1
                FROM lesson_resource_progress r
                WHERE r.user_id = p.user_id
                  AND r.course_id = p.course_id
                  AND r.lesson_index = p.lesson_index
                  AND r.kind <> 'guide'
                  AND r.completed = 1
            ),
            1,
            0
        )
    )
WHERE JSON_CONTAINS_PATH(l.content_json, 'one', '$.resources.guide')
   OR EXISTS (
       SELECT 1
       FROM lesson_resource_progress rg
       WHERE rg.user_id = p.user_id
         AND rg.course_id = p.course_id
         AND rg.lesson_index = p.lesson_index
         AND rg.kind = 'guide'
   );

DELETE p
FROM lesson_progress p
JOIN lessons l
  ON l.course_id = p.course_id
 AND l.lesson_index = p.lesson_index
WHERE (
        JSON_CONTAINS_PATH(l.content_json, 'one', '$.resources.guide')
        OR EXISTS (
            SELECT 1
            FROM lesson_resource_progress rg
            WHERE rg.user_id = p.user_id
              AND rg.course_id = p.course_id
              AND rg.lesson_index = p.lesson_index
              AND rg.kind = 'guide'
        )
    )
  AND p.is_read = 0
  AND p.completed = 0
  AND p.score IS NULL;

DELETE FROM lesson_resource_progress
WHERE kind = 'guide';

UPDATE lessons
SET content_json = JSON_REMOVE(content_json, '$.resources.guide')
WHERE JSON_CONTAINS_PATH(content_json, 'one', '$.resources.guide');

DELETE g
FROM logo_generations g
JOIN kb_courseware c
  ON c.id = g.resource_id
WHERE g.resource_type = 'kb_courseware'
  AND c.kind = 'guide';

DELETE FROM kb_courseware
WHERE kind = 'guide';

COMMIT;
