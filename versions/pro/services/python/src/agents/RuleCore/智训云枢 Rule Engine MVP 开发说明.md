# 智训云枢 Rule Engine MVP 开发说明

## 1. 开发目标

在现有智训云枢系统中新增一个轻量级规则推断能力，使领域规范文档中的“条件—结论/约束”能够被自动抽取为结构化规则，并参与培训内容生成全过程。

本阶段目标不是构建完整的一阶逻辑系统，也不是开发通用规则引擎，而是实现一个适用于当前比赛演示的：

> **领域规则抽取 + 有限前向推理 + 生成约束 + 结果回放校验系统**

最终主链路：

```text
领域文档
   ↓
规则抽取
   ↓
Rule DB
   ↓
用户生成任务
   ↓
任务事实抽取
   ↓
规则匹配 / 有限前向推理
   ↓
得到本次生成约束
   ↓
Generation Agent
   ↓
Rule Checker
   ↓
PASS → 输出
FAIL → 自动修正 → 再校验 → 输出
```

---

# 2. 设计原则

## 2.1 不修改现有 Knowledge Core 主体

Knowledge Core 继续负责：

```text
知识点
知识切片
知识关系
DAG
RAG 检索
知识内容获取
```

Rule Engine 作为新增能力，与 Knowledge Core 并列。

两者职责严格区分：

```text
Knowledge Core
→ 当前生成需要“知道什么”

Rule Engine
→ 当前生成“必须满足什么”
```

---

## 2.2 第一版禁止过度设计

本阶段不实现：

```text
完整一阶逻辑 FOL
Prolog / Drools
复杂规则 DSL 编辑器
人工审核后台
复杂规则冲突消解
时序逻辑系统
规则知识图谱
自动规则版本继承
规则自动优化
CEP
任意深度递归推理
```

优先保证演示链路稳定。

---

# 3. 系统整体架构

新增两个主要流程。

---

# 3.1 文档入库阶段：Rule Pipeline

现有文档进入 Knowledge Pipeline 的同时增加一条规则抽取支路。

```text
                   原始领域文档
                         │
             ┌───────────┴───────────┐
             │                       │
             ▼                       ▼
      Knowledge Pipeline        Rule Pipeline
             │                       │
             ▼                       ▼
       Knowledge Core          条款预处理
                                     │
                                     ▼
                               LLM 规则抽取
                                     │
                                     ▼
                               LLM 自动校验
                                     │
                                     ▼
                               Schema 校验
                                     │
                                     ▼
                                  Rule DB
```

Knowledge Pipeline 原有逻辑不得因为 Rule Pipeline 失败而失败。

Rule Pipeline 应作为独立流程执行。

---

# 3.2 内容生成阶段：Rule Runtime

```text
用户生成任务
     │
     ▼
任务解析 / Generation Context
     │
     ├──────────────────→ Knowledge Core
     │                         │
     │                    knowledge context
     │
     ▼
Fact Extractor
     │
     ▼
结构化 Facts
     │
     ▼
Rule Engine
     │
     ├─ 直接规则匹配
     │
     ├─ 派生新事实
     │
     └─ 最多 2 轮前向推理
     │
     ▼
Generation Constraints
     │
     └──────────────┐
                    ▼
              Generation Agent
                    │
                    ▼
              初始生成结果
                    │
           ┌────────┴────────┐
           ▼                 ▼
     Existing Review     Rule Checker
        Agents               │
                             ▼
                     Rule Check Result
                             │
                    ┌────────┴────────┐
                    │                 │
                  PASS              FAIL
                    │                 │
                    │          Revision Agent
                    │                 │
                    │          再检查一次
                    │                 │
                    └────────┬────────┘
                             ▼
                         最终结果
```

---

# 4. MVP 支持的规则模型

所有规则统一采用：

```text
IF conditions
THEN conclusions
```

规则示例：

```text
R-001

IF:
    height >= 2

THEN:
    SET work_type = 高处作业
```

```text
R-002

IF:
    work_type = 高处作业

THEN:
    MUST 佩戴安全带
```

输入事实：

```text
height = 3
```

推理过程：

```text
height = 3
↓ R-001
work_type = 高处作业
↓ R-002
MUST 佩戴安全带
```

---

# 5. 第一版规则能力范围

## 5.1 条件运算符

必须实现：

```text
EQ       =
NE       !=
GT       >
GTE      >=
LT       <
LTE      <=
IN
NOT_IN
EXISTS
```

---

## 5.2 条件关系

第一版只强制支持：

```text
AND
```

如果原规范存在：

```text
A OR B → C
```

由规则抽取阶段拆成：

```text
A → C
B → C
```

避免增加 Rule Engine 复杂度。

---

# 5.3 结论类型

只支持四种：

```text
SET
MUST
MUST_NOT
SHOULD
```

解释：

### SET

产生新的结构化事实。

例如：

```text
height >= 2
→ SET work_type = 高处作业
```

用于继续参与后续推理。

---

### MUST

本次生成必须出现或满足的约束。

例如：

```text
work_type = 高处作业
→ MUST 佩戴安全带
```

---

### MUST_NOT

禁止生成某种行为。

例如：

```text
equipment_status = energized
→ MUST_NOT 直接检修
```

---

### SHOULD

推荐性约束，第一版纳入生成 Prompt，但不必作为强失败条件。

---

# 6. 结构化数据模型

推荐建立以下 Pydantic 模型。

```python
class RuleCondition(BaseModel):
    field: str
    operator: str
    value: Any | None = None
    unit: str | None = None


class RuleConclusion(BaseModel):
    type: Literal["SET", "MUST", "MUST_NOT", "SHOULD"]

    field: str | None = None
    value: Any | None = None

    content: str | None = None


class DomainRuleSchema(BaseModel):
    rule_code: str
    name: str

    conditions: list[RuleCondition]
    conclusions: list[RuleConclusion]

    source_text: str
    source_section: str | None = None

    confidence: float
```

---

# 7. 数据库设计

MVP 先建立两张表。

---

## 7.1 domain_rule

用于保存领域规则。

推荐字段：

```text
id                  BIGINT PK

rule_code           VARCHAR(64)
name                VARCHAR(255)

rule_type           VARCHAR(32)

conditions_json     JSON
conclusions_json    JSON

source_document_id  BIGINT / UUID
source_section      VARCHAR(255)
source_text         TEXT

confidence          DECIMAL(5,4)

status              VARCHAR(20)

created_at
updated_at
```

其中：

```text
status:
ACTIVE
DISABLED
INVALID
```

`source_text` 必须保留。

禁止只保存结构化规则、不保存原文。

---

## 7.2 rule_execution

记录规则运行和演示溯源。

推荐字段：

```text
id

request_id

rule_id
rule_code

input_facts_json

matched

derived_facts_json

conclusions_json

check_status
check_evidence

created_at
```

其中：

```text
check_status:

PENDING
PASS
FAIL
SKIPPED
```

---

# 8. Rule Pipeline 实现

## 8.1 输入

优先直接复用现有文档预处理结果。

如果 Knowledge Pipeline 已经有：

```text
Document
↓
Chunk
```

不要重新解析完整 PDF。

Rule Pipeline 可以直接从：

```text
knowledge_document
+
document chunk
```

读取文本。

---

# 8.2 规则候选段识别

第一阶段无需做复杂机器学习分类。

先通过关键词 + LLM 判断具有规则性质的段落。

优先处理包含：

```text
必须
不得
禁止
严禁
应当
应该
应
须
不得超过
至少
不低于
不高于
超过
低于
当……时
若……
如果……
只有……
之前
之后
```

的文档段。

关键词只做候选过滤。

最终是否构成规则由 LLM 判断。

---

# 8.3 Rule Extractor

实现：

```text
RuleExtractorService
```

接口：

```python
extract_rules(
    text: str,
    document_context: dict
) -> list[DomainRuleSchema]
```

要求 LLM：

1. 只抽取原文明确支持的规则；
2. 不允许自行补充领域常识；
3. 一条规则只表达一个主要约束；
4. OR 条件拆成多条规则；
5. 数值、单位必须保持原文；
6. 原文不能形式化时允许不抽；
7. 必须返回对应 source_text；
8. MUST / MUST_NOT / SHOULD 必须区分；
9. SET 只用于能够由条件明确推导出的事实。

示例输入：

```text
凡在坠落高度基准面 2m 及以上有可能坠落的高处进行的作业，
均称为高处作业。高处作业人员应正确佩戴安全带。
```

期望输出：

```json
[
  {
    "name": "高处作业判定",
    "conditions": [
      {
        "field": "height",
        "operator": "GTE",
        "value": 2,
        "unit": "m"
      }
    ],
    "conclusions": [
      {
        "type": "SET",
        "field": "work_type",
        "value": "高处作业"
      }
    ]
  },
  {
    "name": "高处作业安全带要求",
    "conditions": [
      {
        "field": "work_type",
        "operator": "EQ",
        "value": "高处作业"
      }
    ],
    "conclusions": [
      {
        "type": "MUST",
        "content": "作业人员正确佩戴安全带"
      }
    ]
  }
]
```

---

# 8.4 自动 Verifier

由于演示阶段不设置人工审核，规则抽取完成后必须自动验证。

新增：

```text
RuleVerifierService
```

输入：

```text
原文
+
候选规则
```

输出：

```json
{
  "valid": true,
  "confidence": 0.94,
  "issues": []
}
```

Verifier 只负责验证：

```text
条件是否来自原文
结论是否来自原文
有没有扩大规则适用范围
有没有遗漏关键条件
数值是否正确
单位是否正确
MUST/MUST_NOT/SHOULD 强度是否正确
```

禁止 Verifier 创建新的规则。

建议：

```text
confidence >= 0.80
→ ACTIVE

confidence < 0.80
→ INVALID
```

阈值通过配置文件控制。

---

# 8.5 Schema Validator

LLM 输出之后必须执行程序级校验。

校验：

```text
operator 是否合法
conclusion.type 是否合法
GT/GTE/LT/LTE 是否具有数值
SET 是否具有 field/value
MUST/MUST_NOT/SHOULD 是否具有 content
confidence 是否 0~1
source_text 是否存在
```

不合法规则不得进入 ACTIVE 状态。

---

# 9. Fact Extractor

生成任务进入 Rule Engine 前，必须转成结构化事实。

新增：

```text
FactExtractorService
```

输入：

```text
用户需求
+
生成任务上下文
+
目标知识点
```

输出：

```json
{
  "task_type": "设备检修",
  "height": 3,
  "height_unit": "m",
  "equipment_type": "电气设备"
}
```

第一版允许使用 LLM 提取 Facts。

要求：

```text
不能推测用户没有提供的信息
没有明确值则不要填
单位标准化
字段名尽量复用已有规则字段
```

---

# 10. 字段对齐

这是实现时必须处理的问题。

规则可能使用：

```text
height
work_height
作业高度
高度
```

如果不处理，规则无法命中。

MVP 不做复杂 ontology。

先定义一个 Field Registry。

例如：

```python
FIELD_ALIASES = {
    "height": [
        "height",
        "work_height",
        "作业高度",
        "高度"
    ],

    "work_type": [
        "work_type",
        "task_type",
        "作业类型"
    ]
}
```

所有 Rule Extractor 和 Fact Extractor Prompt 都要求优先从 Field Registry 中选择字段。

不存在时才创建新字段。

---

# 11. Rule Engine

新增：

```text
RuleEngineService
```

主接口：

```python
evaluate(
    facts: dict,
    rules: list[DomainRule]
) -> RuleEvaluationResult
```

---

# 11.1 基础匹配

规则：

```text
conditions 全部成立
→ matched
```

例如：

```text
equipment_type = 电气设备
AND
task_type = 检修
```

两个条件都满足才能命中。

---

# 11.2 SET 结论

如果命中：

```text
SET work_type = 高处作业
```

将事实加入：

```python
facts["work_type"] = "高处作业"
```

同时记录：

```text
derived = true
source_rule = R-001
```

---

# 11.3 有限前向推理

最多：

```text
MAX_REASONING_ROUNDS = 2
```

推荐算法：

```python
facts = initial_facts

for round in range(MAX_REASONING_ROUNDS):

    changed = False

    for rule in active_rules:

        if match(rule.conditions, facts):

            if rule not already fired:

                fire(rule)

                for conclusion in rule.conclusions:

                    if conclusion.type == "SET":
                        add_fact()

                        changed = True

                    else:
                        add_constraint()

    if not changed:
        break
```

防止：

```text
无限循环
重复执行
环形规则
```

每条规则一次 evaluate 中只允许 fire 一次。

---

# 12. RuleEvaluationResult

建议输出：

```json
{
  "input_facts": {},

  "derived_facts": {},

  "matched_rules": [],

  "constraints": [],

  "reasoning_trace": []
}
```

示例：

```json
{
  "input_facts": {
    "height": 3
  },

  "derived_facts": {
    "work_type": "高处作业"
  },

  "matched_rules": [
    "R-001",
    "R-002"
  ],

  "constraints": [
    {
      "rule_code": "R-002",
      "type": "MUST",
      "content": "作业人员正确佩戴安全带"
    }
  ],

  "reasoning_trace": [
    {
      "round": 1,
      "rule": "R-001",
      "reason": "height=3 GTE 2",
      "result": "SET work_type=高处作业"
    },
    {
      "round": 2,
      "rule": "R-002",
      "reason": "work_type=高处作业",
      "result": "MUST 作业人员正确佩戴安全带"
    }
  ]
}
```

---

# 13. 与生成 Agent 集成

现有生成调用类似：

```python
knowledge_context = knowledge_core.retrieve(...)

result = generation_agent.generate(
    task=task,
    knowledge=knowledge_context
)
```

修改为：

```python
knowledge_context = knowledge_core.retrieve(...)

facts = fact_extractor.extract(task)

rule_result = rule_engine.evaluate(
    facts=facts,
    rules=rule_repository.get_active_rules(...)
)

result = generation_agent.generate(
    task=task,
    knowledge=knowledge_context,
    constraints=rule_result.constraints
)
```

不要修改 Knowledge Core 内部逻辑。

---

# 14. Generation Prompt 规则注入

给 Generation Agent 增加独立区域：

```text
## 强制领域规则

以下约束来自领域规范。

MUST 和 MUST_NOT 属于强制约束，不得遗漏或违反。

[R-017]
MUST：作业人员正确佩戴安全带

来源：
《XXX安全操作规范》第 4.2 条

[R-018]
MUST：设置可靠防坠落措施
```

Knowledge Context 与 Rule Constraints 分开。

不要混成：

```text
参考资料：
xxxx
xxxx
规则
xxxx
```

应该显式告诉模型哪些是：

```text
REFERENCE KNOWLEDGE

HARD CONSTRAINTS
```

---

# 15. Rule Checker

新增：

```text
RuleCheckerService
```

输入：

```text
generated_content
+
matched constraints
```

只检查：

```text
MUST
MUST_NOT
```

SHOULD 可以检查，但不得导致整体 FAIL。

---

# 15.1 Checker 输出

```json
{
  "passed": false,

  "results": [
    {
      "rule_code": "R-017",
      "status": "PASS",
      "evidence": "作业人员佩戴全身式安全带"
    },

    {
      "rule_code": "R-018",
      "status": "FAIL",
      "evidence": null,
      "reason": "生成内容未描述防坠落措施"
    }
  ]
}
```

Rule Checker 使用 LLM 进行语义判断。

但必须：

```text
逐条规则检查
禁止整体给一个“基本合规”
必须返回 rule_code
必须引用生成文本证据
没有明确证据时不能 PASS
```

---

# 16. 自动修正

如果：

```python
check_result.passed is False
```

触发：

```text
Revision Agent
```

输入：

```text
原生成内容
+
失败规则
+
失败原因
```

Prompt 要求：

```text
仅修正违反规则的内容
尽量保持其他内容不变
不得删除已经通过的规则内容
```

第一次修正后重新执行 Rule Checker。

MVP 设置：

```text
MAX_REVISION_RETRY = 1
```

如果第二次仍然 FAIL：

```text
允许输出结果
+
标记规则校验未完全通过
```

不要无限生成。

---

# 17. API 设计

---

## 17.1 抽取文档规则

```http
POST /api/rules/extract/{document_id}
```

作用：

```text
读取文档切片
→ 规则抽取
→ 自动校验
→ 入库
```

返回：

```json
{
  "document_id": "...",
  "candidate_count": 15,
  "active_count": 11,
  "invalid_count": 4
}
```

---

## 17.2 查询规则

```http
GET /api/rules
```

支持：

```text
document_id
status
rule_type
keyword
```

---

## 17.3 查询规则详情

```http
GET /api/rules/{rule_id}
```

返回：

```text
结构化规则
原文
来源文档
来源章节
confidence
```

---

## 17.4 手动测试推理

建议保留一个开发 API：

```http
POST /api/rules/evaluate
```

输入：

```json
{
  "facts": {
    "height": 3
  }
}
```

返回：

```text
matched_rules
derived_facts
constraints
reasoning_trace
```

非常利于调试和比赛演示。

---

# 18. 现有生成接口改造

不建议新建一个完全独立的“规则生成接口”。

直接改现有 Generation Service。

在生成过程增加：

```text
STEP 1 Knowledge Retrieve

STEP 2 Fact Extract

STEP 3 Rule Evaluate

STEP 4 Generate

STEP 5 Existing Agent Review

STEP 6 Rule Check

STEP 7 Revision if required
```

---

# 19. 前端改造

本阶段不要新增复杂 Rule Management 系统。

优先改生成流程页面。

---

## 19.1 增加“规则推断”阶段

生成进度展示：

```text
任务理解
   ↓
知识检索
   ↓
规则推断
   ↓
内容生成
   ↓
多智能体审核
   ↓
规则一致性校验
   ↓
结果生成
```

---

# 19.2 规则推断结果

建议展示：

```text
规则推断

识别任务事实：4 项

直接命中规则：3 条
推理命中规则：2 条

生成约束：5 条
```

展开：

```text
R-017
高处作业安全带要求

命中原因：
work_type = 高处作业

约束：
必须正确佩戴安全带

来源：
《XXX操作规程》第 4.2 条
```

---

# 19.3 推理链展示

如果存在：

```text
height = 3
↓
R-001
↓
work_type = 高处作业
↓
R-002
↓
MUST 佩戴安全带
```

前端可简单使用纵向 Timeline。

第一版不需要做图谱。

---

# 19.4 最终规则一致性

最终结果增加：

```text
规则一致性

5 / 5 通过

✓ R-017
✓ R-018
✓ R-021
✓ R-031
✓ R-032
```

如果发生自动修正：

```text
R-031

初次校验：FAIL

系统自动修正

二次校验：PASS
```

这个状态应该保留用于演示。

---

# 20. 建议目录结构

如果当前后端为 FastAPI，可新增：

```text
app/
├── rule_engine/
│
│   ├── models/
│   │   ├── rule.py
│   │   ├── fact.py
│   │   └── result.py
│   │
│   ├── repositories/
│   │   └── rule_repository.py
│   │
│   ├── services/
│   │   ├── rule_extractor.py
│   │   ├── rule_verifier.py
│   │   ├── fact_extractor.py
│   │   ├── rule_engine.py
│   │   ├── rule_checker.py
│   │   └── rule_revision.py
│   │
│   ├── schemas/
│   │   └── rule_schema.py
│   │
│   ├── api/
│   │   └── rules.py
│   │
│   ├── constants.py
│   └── config.py
```

原则：

```text
Rule Engine 本身不得依赖 LLM
```

即：

```text
rule_extractor
rule_verifier
fact_extractor
rule_checker
```

可以使用 LLM。

但是：

```text
rule_engine.py
```

必须是确定性 Python 逻辑。

---

# 21. 关键配置

```python
RULE_EXTRACT_CONFIDENCE_THRESHOLD = 0.80

MAX_REASONING_ROUNDS = 2

MAX_REVISION_RETRY = 1

RULE_ENGINE_ENABLED = True
```

必须通过配置控制。

如果 Rule Engine 异常：

```text
不得让整个 Generation Service 崩溃
```

可以：

```text
记录 warning
继续执行原生成流程
```

但前端标记：

```text
规则推断不可用
```

---

# 22. 错误隔离

以下情况不能导致整个生成请求失败：

```text
Rule Extractor 失败
Rule Verifier 失败
部分 Rule Schema 错误
Rule Checker API 超时
某条规则无法解析
```

核心原则：

```text
Rule Engine 是增强链路，
不是现有生成系统的单点故障。
```

---

# 23. 演示推荐数据

至少准备一组具有明显规则链的数据。

推荐类似：

```text
R-001

IF height >= 2m

THEN SET work_type = 高处作业
```

```text
R-002

IF work_type = 高处作业

THEN MUST 正确佩戴安全带
```

```text
R-003

IF work_type = 高处作业

THEN MUST 设置防坠落措施
```

```text
R-004

IF task_type = 电气设备检修

THEN MUST 检修前切断电源
```

```text
R-005

IF power_cut = true

THEN MUST 验证设备处于无电状态
```

测试任务：

```text
生成一个作业高度 3 米的电气设备检修培训案例。
```

预期：

```text
height=3
↓
R-001
↓
高处作业
↓
R-002 / R-003

同时：

电气设备检修
↓
R-004
```

最终至少应产生：

```text
佩戴安全带
设置防坠落措施
切断电源
```

---

# 24. 推荐演示流程

比赛现场：

### 第一步

输入：

```text
生成一个作业高度 3 米的电气设备检修培训案例。
```

### 第二步

显示事实：

```text
作业高度：3m
任务类型：电气设备检修
```

### 第三步

显示规则推理：

```text
3m ≥ 2m

↓ R-001

高处作业

↓ R-002

必须佩戴安全带

↓ R-003

必须设置防坠落措施
```

### 第四步

展示规则已经注入生成上下文。

### 第五步

生成培训案例。

### 第六步

Rule Checker：

```text
R-002 PASS
R-003 PASS
R-004 FAIL
```

### 第七步

自动修正：

```text
发现 R-004 未满足
正在自动修正……
```

### 第八步

再次检查：

```text
R-002 PASS
R-003 PASS
R-004 PASS
```

最终：

```text
规则一致性：100%
```

---

## 24.5 对照演示（Rule Engine 有效性证明）

比赛需要回答一个问题：**"不用规则引擎时，生成质量到底差在哪里？"**

因此演示必须包含 A/B 对照，且对照必须公平、客观、可审计。

### 对照设计

同一输入、同一模型、同一知识上下文，只变一个变量：

| | A 臂（对照·无规则引擎） | B 臂（实验·有规则引擎） |
|---|---|---|
| 上下文 | Knowledge Context | Knowledge Context + Rule Constraints |
| 生成 | 直接生成 | 受控生成（约束独立区块注入） |
| 校验 | 同一套 Rule Checker | Rule Checker（FAIL → 自动修正一次 → 复查） |
| 产出 | 内容 + 逐条 PASS/FAIL | 内容 + PASS 证据 + reasoning_trace + 规则来源 |

### 对照纪律（必须遵守）

1. **不做假对照**：A 臂不得人为削弱——不得减少知识上下文、不得更换模型或温度、不得截断生成。
2. **同一把尺子**：Rule Checker 对两臂执行完全相同的约束清单，差异由客观校验结果体现，不由人眼对比。
3. **约束选择**：优先选用 LLM 裸生成大概率会遗漏的 MUST（细粒度安全步骤），保证差异自然涌现。
4. **演示任务预冻结**：赛前用候选任务 × 约束集实测多轮，选择"A 臂稳定 FAIL ≥ 1 项"的任务冻结为演示用例。
5. **兜底话术**：若演示轮 A 臂恰好全部 PASS，退一步展示审计能力——B 臂逐条 PASS 证据 + 规则来源引用，A 臂无此能力。
6. **禁止美化**：两臂原始输出与原始校验结果必须如实展示，包括 B 臂的修正前后状态（FAIL → 自动修正 → PASS）。

### 前端展示（独立对照页面）

- 左右分栏：A 输出 vs B 输出，A 臂违规项标红，B 臂合规项标绿
- B 臂推理链纵向 Timeline（事实 → 规则 → 派生事实 → 约束）
- 最终一致性对比：A `2/5` vs B `5/5`
- B 臂修正轨迹：`R-004 初次 FAIL → 自动修正 → 复查 PASS`
- 每臂完整 rule_execution 记录可展开回放

### 接口与实现

```http
POST /api/rules/compare        # 发起对照（异步任务，立即返回 task_id）
GET  /api/rules/compare/{task_id}  # 轮询任务状态与结果
```

- 一次对照 = 2 次生成 + 2 次检查 + 最多 1 次修正，耗时约 1~3 分钟，必须异步执行
- 任务状态：`PENDING → RUNNING → DONE / FAILED`
- 对照结果持久化存档（含两臂内容、校验结果、推理链、时间戳），作为演示证据
- 生成链路（Generation Service）接入前，对照编排使用独立的轻量生成调用自包含运行；接入后平移同一编排

### 成本估算

一次完整对照：LLM 调用约 5~7 次（2 生成 + 1 Fact 抽取 + 2 检查 + 0~1 修正），耗时 1~3 分钟。

---

# 25. 验收标准

以下能力全部满足即视为 MVP 完成。

## 文档侧

- [ ] 可以从现有文档切片抽取规则
- [ ] 规则保存 source_text
- [ ] 规则包含 conditions / conclusions
- [ ] 规则经过自动 verifier
- [ ] 低置信度规则自动拒绝
- [ ] 规则能够正常写入 MySQL

## 推理侧

- [ ] EQ / GT / GTE / LT / LTE 可以执行
- [ ] AND 条件可以执行
- [ ] SET 可以产生派生事实
- [ ] 派生事实可以触发下一条规则
- [ ] 最多支持两轮前向推理
- [ ] 防止规则重复 fire
- [ ] 可以返回 reasoning_trace

## 生成侧

- [ ] 生成任务可以抽取 Facts
- [ ] Facts 可以进入 Rule Engine
- [ ] 命中规则可以转换为 Generation Constraints
- [ ] Constraints 可以注入 Generation Agent
- [ ] 不影响原 Knowledge Core 检索

## 校验侧

- [ ] 生成结果逐条匹配 MUST / MUST_NOT
- [ ] 每个规则返回 PASS / FAIL
- [ ] PASS 必须提供 evidence
- [ ] FAIL 必须提供 reason
- [ ] 能精确定位 rule_code
- [ ] FAIL 后自动修正一次
- [ ] 修正之后重新校验

## 前端侧

- [ ] 可以看到规则推断阶段
- [ ] 可以看到命中规则
- [ ] 可以看到规则编号
- [ ] 可以看到规则来源
- [ ] 可以看到推理链
- [ ] 可以看到最终规则一致性
- [ ] 可以看到自动修正前后状态

## 对照侧

- [ ] 可以发起 A/B 对照（同一任务、同一模型、同一知识上下文）
- [ ] A 臂无约束注入，B 臂注入 Rule Constraints
- [ ] 两臂使用同一套 Rule Checker 与同一约束清单
- [ ] A 臂 FAIL 项逐条展示（rule_code + 缺失证据）
- [ ] B 臂 PASS 项逐条展示（rule_code + 原文证据 + 来源）
- [ ] 推理链 Timeline 可展示
- [ ] 最终一致性对比可见（A `x/n` vs B `n/n`）
- [ ] 对照任务异步执行，状态可轮询
- [ ] 对照结果持久化存档
- [ ] A 臂不得人为削弱（知识/模型/温度与 B 臂一致）

## 对照演示页

- [ ] 独立页面（不依赖生成链路接入）
- [ ] 左右分栏展示 A/B 输出
- [ ] 违规项标红、合规项标绿
- [ ] 修正轨迹可见（FAIL → 自动修正 → PASS）
- [ ] rule_execution 记录可回放

---

# 26. Codex 实施优先级

严格按照以下顺序开发。

## P0：必须完成

```text
domain_rule 表
Rule Schema
Rule Extractor
Rule Verifier
Fact Extractor
基础 Rule Engine
SET 派生事实
两轮前向推理
Generation Constraints
Rule Checker
Generation Service 集成
对照编排（A/B compare 异步任务）
对照演示独立页面
```

---

## P1：完成核心链路后再做

```text
rule_execution
自动修正
reasoning_trace
前端规则面板
规则来源展示
```

---

## P2：时间允许再做

```text
简单规则查询页面
规则启停
文档规则重新抽取
规则统计
```

---

# 27. 明确禁止 Codex 擅自扩展的内容

除非现有项目已经有相关基础，否则不要增加：

```text
Drools
Prolog
Neo4j
规则图数据库
复杂 DSL parser
ANTLR
新的消息队列
新的微服务
新的向量数据库
复杂工作流框架
人工审核模块
规则管理后台大改版
```

优先复用：

```text
现有 FastAPI
现有 MySQL
现有 LLM Client
现有 Knowledge Pipeline
现有 Agent 调用方式
现有 Generation Service
```

---

# 28. 最终技术定位

系统最终应形成：

```text
Knowledge Core
负责提供领域知识证据

Rule Engine
负责将领域规范转化为可执行约束

Generation Agent
负责内容生成

Review Agents
负责语义和质量审核

Rule Checker
负责规则一致性审核
```

核心技术链：

```text
领域文档
↓
规则语义抽取
↓
结构化 Rule
↓
结构化 Fact
↓
有限前向推理
↓
生成约束
↓
受控生成
↓
规则回放
↓
自动修正
```

本阶段不宣称实现通用一阶逻辑推理。

技术描述统一使用：

> **针对行业培训规范设计受限结构化规则表示，通过条件匹配和有限深度前向推理，将领域规范转换为可执行生成约束，并在生成后逐条执行规则一致性回放。**

这样既符合实际实现，也足以支撑 PPT 中“规则推断引擎”的技术表述。