-- RuleCore MVP: domain_rule + rule_execution + rule_compare
-- 与 itn-platform 库中 knowledge_document / knowledge_chunk 同库

CREATE TABLE IF NOT EXISTS domain_rule (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    rule_code           VARCHAR(64)  NOT NULL COMMENT '规则编码 R-xxx',
    name                VARCHAR(255) NOT NULL COMMENT '规则名称',
    rule_type           VARCHAR(32)  DEFAULT NULL COMMENT '规则类型（分类标签）',
    conditions_json     JSON         NOT NULL COMMENT 'IF 条件列表（AND 语义）',
    conclusions_json    JSON         NOT NULL COMMENT 'THEN 结论列表（SET/MUST/MUST_NOT/SHOULD）',
    source_document_id  BIGINT UNSIGNED DEFAULT NULL COMMENT '来源文档 knowledge_document.id',
    source_chunk_id     BIGINT UNSIGNED DEFAULT NULL COMMENT '来源切片 knowledge_chunk.id',
    source_section      VARCHAR(255) DEFAULT NULL COMMENT '来源章节',
    source_text         TEXT         NOT NULL COMMENT '原文（必须保留，禁止只存结构化规则）',
    confidence          DECIMAL(5,4) NOT NULL DEFAULT 0.0000 COMMENT 'Verifier 置信度',
    status              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / DISABLED / INVALID',
    reject_reason       VARCHAR(512) DEFAULT NULL COMMENT '低置信/校验失败原因',
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_rule_code (rule_code),
    KEY idx_doc_status (source_document_id, status),
    KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='领域规则（RuleCore）';

CREATE TABLE IF NOT EXISTS rule_execution (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    request_id          VARCHAR(64)  NOT NULL COMMENT '一次 evaluate 请求 ID',
    rule_id             BIGINT UNSIGNED DEFAULT NULL,
    rule_code           VARCHAR(64)  DEFAULT NULL,
    input_facts_json    JSON         DEFAULT NULL COMMENT '本次请求初始事实',
    matched             TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '是否命中',
    derived_facts_json  JSON         DEFAULT NULL COMMENT '本规则派生的事实',
    conclusions_json    JSON         DEFAULT NULL COMMENT '命中产生的结论',
    check_status        VARCHAR(20)  DEFAULT NULL COMMENT 'PENDING/PASS/FAIL/SKIPPED（Checker 阶段回填）',
    check_evidence      TEXT         DEFAULT NULL COMMENT 'Checker 证据（PASS 原文引用 / FAIL 原因）',
    arm                 VARCHAR(8)   DEFAULT NULL COMMENT '对照臂 A/B',
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_request (request_id),
    KEY idx_rule (rule_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='规则运行记录（演示溯源回放）';

CREATE TABLE IF NOT EXISTS rule_compare (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    task_id             VARCHAR(64)  NOT NULL COMMENT '对照任务 ID',
    task_text           TEXT         NOT NULL COMMENT '演示任务描述',
    status              VARCHAR(20)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/RUNNING/DONE/FAILED',
    request_id_a        VARCHAR(64)  DEFAULT NULL,
    request_id_b        VARCHAR(64)  DEFAULT NULL,
    facts_json          JSON         DEFAULT NULL COMMENT 'Fact Extractor 输出',
    constraints_json    JSON         DEFAULT NULL COMMENT 'B 臂注入的约束清单',
    knowledge_json      JSON         DEFAULT NULL COMMENT '两臂共用的知识上下文',
    output_a            MEDIUMTEXT   DEFAULT NULL,
    output_b            MEDIUMTEXT   DEFAULT NULL,
    output_b_revised    MEDIUMTEXT   DEFAULT NULL COMMENT 'B 臂自动修正后文本',
    check_a_json        JSON         DEFAULT NULL,
    check_b_json        JSON         DEFAULT NULL,
    check_b_revised_json JSON        DEFAULT NULL,
    reasoning_trace_json JSON        DEFAULT NULL,
    error               TEXT         DEFAULT NULL,
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_task (task_id),
    KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='A/B 对照演示任务存档';
