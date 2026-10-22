# QuestionBank 题库方案（v2）

> 版本：v2（2026-08-11），对齐 Knowledge Core 架构。
> 核心原则一句话：**题库不拥有知识，只拥有题目；Knowledge Core 是题库唯一的知识入口。**

## 1. 架构总览

```
                    ┌──────────────────────────┐
                    │      Knowledge Core      │
                    │  KP解析 / DAG / Chunk     │
                    │  Coverage / RAG fallback  │
                    │  Evidence / Trace         │
                    └────────────┬─────────────┘
                                 │ KnowledgeContext
         ┌───────────────────────┼───────────────────────┐
         ↓                       ↓                       ↓
 Question Generator        Question Reviewer       Answer Judge
      出题                      审题                  主观题判题
         │                       │                       │
         └───────────┬───────────┘                       │
                     ↓                                   │
               Question Service                          │
                     │                                   │
         ┌───────────┼───────────────┐                   │
         ↓           ↓               ↓                   │
     question   question_kp    question_attempt ◄───────┘
         │
         ↓
   Question Selector
         ↓
    学习端 / 测试端 / Agent
```

**三层闭环**：

- 知识证据层：`Document → Chunk → RAG`
- 知识结构层：`Knowledge Point → DAG`
- 学习评估层：`Knowledge Point → Question → Attempt`

Knowledge Core 在中间统一调度，最终汇聚到 `Learner Model → Learning Path`。

## 2. 职责边界（硬边界，不可逾越）

| Knowledge Core 负责 | Question Bank 负责 |
| --- | --- |
| 知识点名称/ID 解析（resolve） | 题目生成、题型/难度控制 |
| 知识点基础信息、前置知识（DAG） | 知识点绑定（question_knowledge_point） |
| 证据切片、跨领域知识 | 参考答案、解析 |
| 覆盖度判断、RAGFlow fallback | 题目审核、状态管理 |
| Evidence 去重排序、知识溯源 | 取题、判题、作答记录 |
| 统一 KnowledgeContext | 题库查询 |

**禁止**：Question Bank 直接操作 RAGFlow 或自己拼知识。

```python
# ✗ 禁止
question_generator.search_ragflow(...)

# ✓ 永远
context = knowledge_core.get_context(category_id=123, purpose="question_generation", ...)
```

## 3. KnowledgeContext 契约（题库 ↔ KC 唯一 Contract）

```json
{
  "knowledge_point": { "id": 123, "name": "MCP传输方式", "description": "..." },
  "prerequisites": [
    { "id": 120, "name": "MCP协议", "relation_type": "prerequisite" }
  ],
  "evidence": [
    { "chunk_id": "chunk_1024", "document_id": 18, "content": "...", "score": 0.93, "source": "mysql", "category_id": 123 },
    { "chunk_id": "rag_882", "document_id": 20, "content": "...", "score": 0.81, "source": "ragflow", "category_id": 123 }
  ],
  "coverage": { "direct_chunk_count": 4, "rag_supplement_count": 2, "coverage_level": "sufficient" },
  "trace": { "strategy": "mysql_plus_rag", "request_id": "..." }
}
```

**Knowledge Core 内部检索**（已具备，需封装统一入口）：

```
category_id → 找到 KP → 查绑定 chunks → 覆盖度判断
    ├─ sufficient → 直接返回
    └─ insufficient → RAGFlow 检索 → 证据过滤/去重 → 合并返回
```

覆盖度 `evaluate_coverage(chunks)` 输出 `empty / weak / sufficient`，至少综合：数量、相关度、内容长度、知识点直接绑定比例。Question Bank 不关心算法。

**KC 三个核心接口**（本方案只依赖这三个，不暴露几十个函数）：

1. `resolve_knowledge_point(query)`：名称 → category_id（如 "MCP传输" → 123）
2. `get_context(category_id, purpose, include_prerequisites=False, max_prerequisite_depth=1)`：核心
3. `get_evidence(evidence_ids)`：审核 / 判题 / 溯源

## 4. 数据模型 v2（三张核心表，已落库）

### 4.1 knowledge_question —— 题本身

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | BIGINT UNSIGNED PK | |
| question_type | VARCHAR(32) | single_choice / multiple_choice / true_false / short_answer |
| difficulty | TINYINT | 1~5（见 §6 rubric） |
| cognitive_level | VARCHAR(32) | remember / understand / apply / analyze / evaluate / create |
| stem | TEXT | 题干（Markdown） |
| options | JSON | 选择题选项 `[{key,text}]` |
| reference_answer | JSON | 参考答案 |
| explanation | TEXT | 解析 |
| status | VARCHAR(24) | proposed / active / rejected / deprecated |
| source_type | VARCHAR(24) | human / llm / imported |
| **evidence_refs** | JSON | **证据快照引用** `[{chunk_id, document_id, score, source}]`（v2 由 source_chunk_ids 演进，生成时固化，知识库变化后仍可溯源） |
| **generation_metadata** | JSON | 生成溯源 `{model, prompt_version, knowledge_context_hash, knowledge_core_version, generated_at}`（v2 新增） |
| content_hash | CHAR(64) UK | canonical(stem+options+answer) sha256 去重 |
| metadata | JSON | 扩展（tags / needs_revalidation / ai_review 等） |
| created_by | VARCHAR(64) | human / agent / 用户标识 |

### 4.2 knowledge_question_knowledge_point —— 这道题测什么

`question_id + category_id`（→ knowledge_category.id），`role`（primary/secondary/related），`weight`。多对多，不直接在 question 上放单值。

### 4.3 knowledge_question_attempt —— 一次作答

| 字段 | 说明 |
| --- | --- |
| user_id, question_id | |
| submitted_answer JSON | 用户答案 |
| is_correct TINYINT NULL | 客观题 0/1；主观题未判 NULL |
| score DECIMAL | 得分 |
| **judge_details** JSON | **判题详情**（v2 新增）：主观题存 `matched_points / missing_points / feedback / rationale` |
| started_at / submitted_at / duration_ms | |

**attempt 是 Learner Model 的原始证据**：`attempt → question → question_knowledge_point → Knowledge Point`，未来可消费为 `mastery estimation → user_knowledge_state → DAG → next knowledge point`。

### 4.4 知识更新重校验（needs_revalidation）

知识切片变更后：`KC 内容更新 → 找到引用该 evidence 的 questions → 标记 metadata.needs_revalidation → Reviewer 重审 → active / deprecated`。不物理删题，不加状态位（先放 metadata，量大了再提列）。

## 5. 出题流水线（POST /questions/generate）

```
用户/系统：{ knowledge_point: "MCP传输方式" | category_id, difficulty, question_type, count }
   ↓
① 参数校验
   ↓
② Knowledge Core get_context（名称 → resolve → context，含前置知识）
   ↓
③ 覆盖度检查（empty/weak → 拒绝，见 §9）
   ↓
④ Question Generator 生成（输入仅 KnowledgeContext + 生成要求，禁止访问 DB）
   ↓
⑤ 防线1 Schema 校验
   ↓
⑥ 防线2 Evidence 校验（returned evidence ⊆ context evidence，LLM 不能自创证据 ID）
   ↓
⑦ 防线3 Question Reviewer（LLM 复审，不修改原题）
   ↓
⑧ 防线4 重复检测（精确 hash + 语义 embedding，见 §7）
   ↓
⑨ 保存 question（status=proposed, source_type=llm, evidence_refs 快照, generation_metadata）
   ↓
⑩ 保存 question_knowledge_point（primary + secondary）
```

### 防线 1：Schema 校验（代码，零 LLM）

- stem 非空、difficulty 合法、question_type 合法
- 单选：options ≥ 2 且答案数量=1 且答案在 options 中
- 多选：答案 ≥ 2
- 判断：答案仅 true/false
- 失败 → 丢弃 / retry，不落库

### 防线 2：Evidence 校验（代码）

LLM 返回的 `evidence_chunk_ids` 必须 ⊆ KnowledgeContext.evidence，否则拒绝。

### 防线 3：Question Reviewer（LLM）

输入：题目 + 参考答案 + 解析 + KnowledgeContext。检查：证据支持、答案正确、解析一致、无歧义、不超知识点、难度匹配。返回 `{grounded, answer_correct, unambiguous, difficulty_match, confidence, issues[]}`。**Reviewer 不修改原题**，有问题 reject 或重新生成。

### 防线 4：重复检测（两级）

- 精确：`normalize(stem) → hash`，已存在即 reject
- 语义：同知识点已有题题干 embedding，`similarity > threshold` → duplicate candidate（题量小可独立 embedding 存储，不必 RAGFlow）

## 6. 难度 Rubric（统一标准，Generator 与 Reviewer 共用）

| 难度 | 定义 |
| --- | --- |
| 1 | 直接识别、定义、事实回忆，几乎无推理 |
| 2 | 单知识点理解、简单判断 |
| 3 | 单知识点应用、轻度场景推理 |
| 4 | 多条件 / 多知识组合、较强分析 |
| 5 | 复杂迁移、综合推理、深层分析 |

**DAG 参与**：难度决定上下文范围——难度 1~2 用目标知识点；难度 3 加必要前置；难度 4~5 加前置 + 相关知识。难题 = 知识组合复杂度，不是措辞绕。

## 7. 题目生命周期

```
LLM / 人工创建 → proposed ──Question Review──→ active ──→ deprecated
                      │                          │
                      └──────→ rejected ←────────┘
```

- LLM 题**必须** proposed；人工创建是否直接 active 可配置（生产建议也走审核）
- 只有 active 可被取题/作答

## 8. Answer Judge（两个独立模式）

| 模式 | 处理 | 说明 |
| --- | --- | --- |
| 客观题 | 纯代码判定 | single/multiple/true_false，稳定、便宜、可重复、可测试，不调 LLM |
| 主观题 | LLM 判定 | 输入：用户答案 + reference_answer + scoring criteria + **KnowledgeContext**（学生可用不同于参考答案的正确表达，KC evidence 可证明正确） |

主观题返回 `{score, is_correct, matched_points[], missing_points[], feedback}` → 写入 `question_attempt.judge_details`。

**Question Reviewer（审题）与 Answer Judge（判答）完全独立**，不混用。

## 9. 失败策略

- `coverage = empty` → 直接拒绝生成（`QUESTION_GENERATION_INSUFFICIENT_EVIDENCE`），不允许 LLM 凭自己知识生成
- `coverage = weak` → KC 已触发 RAG fallback，补充后仍 weak → 拒绝生成，不放宽约束

## 10. API 全集

### 管理 / 生成

```
POST /questions/generate            # 出题 {knowledge_point|category_id, difficulty, question_type, count}
POST /questions                     # 人工创建
PUT  /questions/{id}                # 更新
GET  /questions                     # 分页 + 筛选
GET  /questions/{id}                # 详情（含知识点、evidence_refs、generation_metadata）
GET  /questions/review-queue        # 待审队列（proposed）
POST /questions/{id}/review         # 审题 → active/rejected
POST /questions/review/batch        # 批量审核
POST /questions/{id}/deprecate      # 下架
```

### 学习端

```
GET  /practice/questions            # Question Selector 取题（绝不返回 answer/explanation/evidence）
POST /practice/submit               # 作答 → Answer Judge → 落 attempt
GET  /practice/attempts             # 作答历史（分页）
GET  /practice/attempts/{id}        # 作答详情
```

**学习端取题响应只含** `{id, type, stem, options}`。

### 内部服务接口（Question Service 统一出口）

```
search_questions(category_id, difficulty, question_type, status, count)   # 业务侧禁止拼 SQL
```

## 11. 服务模块划分（禁止 3000 行大文件）

```
services/
├── knowledge_core/            # KC 客户端封装
│   ├── core.py                #   get_context / resolve / get_evidence 统一入口
│   ├── resolver.py
│   ├── retriever.py
│   ├── coverage.py
│   └── schemas.py             #   KnowledgeContext
│
└── question/
    ├── question_service.py    #   查询/状态/保存
    ├── question_generator.py  #   出题（输入仅 KnowledgeContext + 要求）
    ├── question_reviewer.py   #   审题（防线3）
    ├── question_selector.py   #   取题（策略可换）
    ├── answer_judge.py        #   判题（客观代码 / 主观 LLM+KC）
    ├── duplicate_detector.py  #   防线4
    └── validators.py          #   防线1 Schema + 防线2 Evidence
```

## 12. 落地顺序（按依赖关系，非先搭架子）

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| 1 | **Knowledge Core Contract**：resolve_knowledge_point / get_context / get_evidence + KnowledgeContext 定型（包装现有 retrieval/evidence/graph 服务） | KC 现有能力 |
| 2 | **题库 Domain**：QuestionService（三表 CRUD/状态/查询） | 已建表 |
| 3 | **Generator**：KC → Generator → Validator（防线1/2） | 1,2 |
| 4 | **Reviewer**：grounding / answer / ambiguity / difficulty（防线3） | 1,2 |
| 5 | **审核闭环**：proposed → review → active/rejected | 2,4 |
| 6 | **Question Selector**：按知识点取题（排除近期做过 / 错题优先 / 掌握度匹配，策略可换） | 2,5 |
| 7 | **Attempt + Answer Judge**：客观规则 + 主观 KC+LLM | 1,2 |
| 8 | **Knowledge Change Revalidation**：切片变化 → 题目重审机制 | 4 |

完成第 8 阶段后，题库成为与知识库同步演化的生产系统。

## 13. 数据表现状（生产库 itn-platform，2026-08-11）

- `knowledge_question` / `knowledge_question_knowledge_point` / `knowledge_question_attempt` 已建（v1）
- v2 演进已执行：`evidence_refs`（替代 source_chunk_ids）、`generation_metadata`、`judge_details`
- 待办：无（下一阶段是 Knowledge Core Contract，不涉及建表）
