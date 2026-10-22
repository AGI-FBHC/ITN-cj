-- 管理员上传的学习资料（文件型资源）
-- 资源主记录仍写入 generated_learning_resources（resource_type='file'），
-- 文件字节单独放本表，避免把大字段混进资源表影响列表查询。
CREATE TABLE IF NOT EXISTS `resource_files` (
  `resource_id` binary(16) NOT NULL,
  `file_name` varchar(255) NOT NULL,
  `mime_type` varchar(128) NOT NULL,
  `size_bytes` int NOT NULL,
  `data` longblob NOT NULL,
  `created_at` datetime(6) NOT NULL,
  PRIMARY KEY (`resource_id`),
  CONSTRAINT `fk_resource_file_resource` FOREIGN KEY (`resource_id`)
    REFERENCES `generated_learning_resources` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
