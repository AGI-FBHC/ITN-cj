-- 学习计划：由 Lumin 依据注册问卷与当前已上架课程生成，随学习画像一起展示。
ALTER TABLE user_learning_memory
    ADD COLUMN learning_plan_json JSON NULL,
    ADD COLUMN plan_generated_at DATETIME(6) NULL,
    ADD COLUMN plan_model VARCHAR(160) NOT NULL DEFAULT '';
