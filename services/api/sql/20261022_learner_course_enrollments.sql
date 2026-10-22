-- 学习者与课程的选课关系（谁在学哪门课）
-- 「我的学习」书架加入/移出课程时写入本表，首页「正在学习」与热学榜的人数都读这里。
CREATE TABLE IF NOT EXISTS `learner_course_enrollments` (
  `user_id` binary(16) NOT NULL,
  `domain_code` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` timestamp(6) NOT NULL,
  `updated_at` timestamp(6) NOT NULL,
  PRIMARY KEY (`user_id`, `domain_code`),
  KEY `idx_lce_domain` (`domain_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
