# ITN QuestionBank 题库模块

独立题库系统：**题目管理 · AI 出题 · 审题闭环 · 刷题判题 · 题库看板 · 知识变更重审**。

架构原则一句话：**题库不拥有知识，只拥有题目；Knowledge Core 是题库唯一的知识入口。**

- 技术栈：Python 3.11+ / FastAPI / MySQL 8 / Vue 3（CDN 单页，零构建）
- 存储：平台 MySQL（`itn-platform` 库，`knowledge_question*` 三张表，与知识库同库）
- 不依赖 Spring Boot / 前端主仓库，独立启动、独立部署

---

## 1. 目录结构

```
QuestionBank/
├─ pyproject.toml                  # 独立包（pip install -e . 安装，入口 qb）
├─ .env.example                    # 配置示例（复制到 ../.env 与 agents 共用）
├─ README.md                       # 本文档
├─ docs/DESIGN.md                  # 方案设计 v2（架构/边界/契约/落地）
├─ migrations/
│   ├─ 2026_08_10_knowledge_question_core.sql   # 核心三表（已执行）
│   └─ 2026_08_11_knowledge_question_v2.sql     # v2 演进：evidence_refs 等（已执行）
├─ static/                         # 前端页面（刷题/新增题/题库看板/审核）
│   ├─ index.html / app.js / style.css
├─ src/questionbank/
│   ├─ config.py                   # 配置（读 ../.env：KNOWLEDGE_CORE_URL / MYSQL_* / LLM_*）
│   ├─ llm.py                      # LLM 客户端（OpenAI 兼容，重试+宽容解析）
│   ├─ store.py                    # MySQL 存储层（题目/关联/作答/统计）
│   ├─ cli.py                      # 命令行工具（qb ...）
│   ├─ services/
│   │   ├─ knowledge_core/         # ★ Knowledge Core Contract（阶段1）
│   │   │   ├─ core.py             #   统一入口：resolve / get_context / get_evidence
│   │   │   ├─ retriever.py        #   HTTP 客户端
│   │   │   ├─ resolver.py         #   知识点名称 → category_id
│   │   │   ├─ coverage.py         #   覆盖度 empty/weak/sufficient 分级
│   │   │   └─ schemas.py          #   KnowledgeContext 契约（五段结构）
│   │   └─ question/
│   │       ├─ question_service.py #   题目 CRUD / 状态机 / 去重 / 批量导入
│   │       ├─ validators.py       #   防线1：Schema 校验（纯代码）
│   │       ├─ duplicate_detector.py # 防线4：content_hash 精确去重
│   │       ├─ generator/          #   AI 出题（防线1/2 + 重试轮）
│   │       ├─ reviewer/           #   防线3：AI 审题（只审不改）
│   │       ├─ question_selector.py#   取题（排除近期/错题优先）
│   │       ├─ answer_judge.py     #   判题（客观规则 / 主观 LLM+KC）
│   │       ├─ attempt_service.py  #   作答提交落库
│   │       └─ revalidation.py     #   知识变更重审
│   └─ web/
│       ├─ app.py                  # FastAPI 入口（API + 静态前端）
│       └─ api.py                  # REST 路由
└─ tests/                          # 111 项 pytest
```

## 2. 职责边界（硬边界）

| Knowledge Core 负责 | Question Bank 负责 |
| --- | --- |
| 知识点解析 / 前置知识（DAG） | 题目生成 / 题型难度控制 |
| 证据切片 / 覆盖度 / RAG fallback | 知识点绑定 / 参考答案 / 解析 |
| 统一 KnowledgeContext | 审核 / 状态 / 取题 / 判题 / 作答记录 |

**禁止**题库侧直接操作 RAGFlow 或知识表，一切知识获取走：

```python
context = knowledge_core.get_context(category_id=123, purpose="question_generation")
```

## 3. 数据模型（生产库 itn-platform）

| 表 | 职责 | 关键字段 |
| --- | --- | --- |
| `knowledge_question` | 题目主表 | question_type / difficulty(1-5) / cognitive_level / stem / options(JSON) / reference_answer(JSON) / explanation / status / source_type / **evidence_refs**(JSON 证据快照) / **generation_metadata**(JSON 溯源) / content_hash(sha256 唯一去重) / metadata |
| `knowledge_question_knowledge_point` | 题目↔知识点多对多 | question_id / category_id(→knowledge_category.id) / role(primary/secondary/related) / weight |
| `knowledge_question_attempt` | 用户作答记录（掌握度数据源） | user_id / question_id / submitted_answer / is_correct / score / judge_details(JSON 判题详情) / 耗时 |

- 题目**软删除**（status=deprecated），attempt 历史永不悬空
- 状态机：`proposed →(审核)→ active/rejected`，`active → deprecated`，`rejected → proposed`（修订重审）
- 证据快照 `evidence_refs` 在生成时固化，知识库变化后仍可溯源"当年依据什么出题"

## 4. 启动

### 4.1 依赖

```bash
cd src/agents/QuestionBank
python3.11 -m venv .venv && .venv/bin/pip install -e ".[web]" pytest
```

### 4.2 配置（与 agents 共用 `src/agents/.env`）

| 配置键 | 说明 |
| --- | --- |
| `KNOWLEDGE_CORE_URL` | Knowledge Core 地址（如 http://localhost:8000），出题/审题/知识点必需 |
| `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` | 平台 MySQL（题库三表所在库） |
| `LLM_API_URL/LLM_API_KEY/LLM_MODEL` | LLM（出题/审题/判题），兼容 Kimi/MiMo |
| `LLM_PROVIDER` | `openai-compatible`（默认）或 `mock`（测试） |

### 4.3 启动

```bash
# 1. Knowledge Core（依赖）
cd src/agents/KnowledgeCore && .venv/bin/python -m uvicorn app.main:app --port 8010

# 2. QuestionBank（API + 前端）
cd src/agents/QuestionBank
KNOWLEDGE_CORE_URL=http://127.0.0.1:8010 \
  .venv/bin/python -m uvicorn questionbank.web.app:app --host 0.0.0.0 --port 8001

# 浏览器打开 http://localhost:8001
```

## 5. 功能一览

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 题目管理 | `POST/GET/PUT/DELETE /v1/questions*`、`qb create/list/get` | CRUD、分页筛选、content_hash 去重、批量导入 |
| AI 出题 | `POST /v1/questions/generate`、`qb generate`、页面「新增题→AI 出题」 | KC 取上下文 → 覆盖度检查（不足拒绝）→ LLM 生成 → 四层防线 → 入库 proposed；失败按题型自动重试一轮 |
| AI 审题 | `POST /v1/questions/{id}/ai-review`、`qb review --ai` | 四项检查（证据支持/答案正确/无歧义/难度匹配），通过→active，不通过→rejected；只审不改 |
| 人工审核 | `POST /v1/questions/{id}/review`、页面「审核」tab | proposed 队列一键通过/拒绝 |
| 取题 | `GET /v1/practice/questions`、`qb select` | active + 排除近期做过 + 错题优先；**不泄露答案/解析/证据** |
| 作答判分 | `POST /v1/practice/submit`、`qb submit` | 客观题规则即时判分；主观题 LLM+KC 批改（matched/missing/feedback）或仅记录 |
| 作答历史/统计 | `GET /v1/practice/attempts`、`GET /v1/questions/{id}/stats` | 分页历史、单题正确率（近 20 次） |
| 题库看板 | `GET /v1/questions/stats/overview`、`/stats/by-category`、页面「题库」tab | 总数/状态/题型/难度分布、知识点×难度矩阵（合并 KC 覆盖） |
| 知识变更重审 | `POST /v1/revalidation/*`、`qb revalidate*` | evidence_refs 反查 → 标记 needs_revalidation → 重审（通过保持 active / 不通过 deprecated） |

### 四层防线（出题质量）

1. **Schema 校验**（代码）：题型/选项/答案结构，失败丢弃不落库
2. **Evidence 校验**（代码）：LLM 引用必须 ⊆ KnowledgeContext 证据，不能自创证据 ID
3. **Question Reviewer**（LLM）：grounded / answer_correct / unambiguous / difficulty_match，只审不改，失败保守拒绝
4. **重复检测**：content_hash（canonical sha256）精确去重

## 6. REST API 参考

### 管理端 `/v1/questions`

```
GET    /v1/questions                     分页+筛选（category_id/difficulty/type/cognitive/status/keyword）
POST   /v1/questions                     创建题目（含知识点关联）
GET    /v1/questions/{id}                详情（含知识点/证据快照/生成元数据）
PUT    /v1/questions/{id}                更新（hash 重算查重）
DELETE /v1/questions/{id}                软删除（deprecated）
POST   /v1/questions/import              批量导入（幂等）
GET    /v1/questions/review-queue        proposed 待审队列
POST   /v1/questions/{id}/review         人工审核（status=active|rejected）
POST   /v1/questions/review/batch        批量审核
POST   /v1/questions/{id}/deprecate      下架
POST   /v1/questions/{id}/ai-review       AI 审题（auto_apply=true 自动闭环）
POST   /v1/questions/generate            AI 出题
GET    /v1/questions/categories          知识点目录（转发 KC 覆盖报告）
GET    /v1/questions/stats/overview      题库总览
GET    /v1/questions/stats/by-category   知识点×难度矩阵
GET    /v1/questions/{id}/stats          单题作答统计
```

### 学习端 `/v1/practice` · 重审 `/v1/revalidation`

```
GET    /v1/practice/questions            取题（user_id 必填）
POST   /v1/practice/submit               作答 {user_id, question_id, submitted_answer, judge_mode?, duration_ms?}
GET    /v1/practice/attempts             作答历史
POST   /v1/revalidation/mark             标记 {chunk_ids, reason?}
GET    /v1/revalidation/queue            待重审队列
POST   /v1/revalidation/{id}             重审单题
```

### 出题请求示例

```json
POST /v1/questions/generate
{
  "knowledge_point": "MCP传输方式",   // 或 category_id
  "difficulty": 3,
  "question_type": "single_choice",   // 可省（混合）
  "count": 5,
  "created_by": "llm"
}
```

## 7. CLI 速查

```bash
qb list --category 72 --status active     # 查询
qb get 1001                               # 详情
qb create --type single_choice --difficulty 3 --stem "…" \
  --options "A:…|B:…|C:…|D:…" --answer B --kp "72:primary"
qb review 1001 --status active            # 人工审核
qb review 1001 --ai                       # AI 审题（自动闭环）
qb deprecate 1001                         # 下架
qb import questions.json                  # 批量导入（幂等）
qb select --user u1 --category 72 --count 5   # 取题
qb submit --user u1 --question 1001 --answer B  # 作答
qb attempts --user u1                     # 作答历史
qb stats --category 72                    # 题目统计
qb revalidate-mark --chunks 1303          # 知识变更标记
qb revalidate 1001                        # 重审
```

## 8. 测试

```bash
cd src/agents/QuestionBank && .venv/bin/python -m pytest tests -q   # 111 passed
```

- 纯函数单测（校验器/去重/判分/审题/生成器 mock LLM）：不依赖外部
- DB 集成测试：**直连生产 MySQL，事务回滚零污染**（测试数据不落库）

## 9. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 出题报 `QUESTION_GENERATION_INSUFFICIENT_EVIDENCE` | 知识点直接绑定切片不足（覆盖 weak/empty），质量底线拒绝。先为知识点补充知识切片，或换覆盖充足的知识点 |
| 出题报 `LLM 响应无法解析为 JSON` | MiMo 推理模型 content 为空（token 全用于 reasoning）。已内置：自动重试 3 次 + prompt 要求直接输出 + 宽容解析；仍失败可换模型或稍后重试 |
| 混合题型部分题校验失败（多选答案 1 项/判断题答案 'A'） | LLM 格式错误，防线1 拦截属正常；已内置按题型自动重试一轮 |
| 取题为空 | 该知识点无 active 题，或近期都做过了（exclude_recent 生效）；到审核页通过题目或 AI 出题 |
| 知识点下拉无数据 | `KNOWLEDGE_CORE_URL` 未配置或 KC 未启动 |
| 页面打不开 | 8001 端口服务未启动；日志 /tmp/qb-web.log |

## 10. 设计文档

方案细节（架构图 / KnowledgeContext 契约 / 难度 rubric / 落地过程）见 **`docs/DESIGN.md`**。

主要演进：`v1 核心三表 → v2 证据快照/生成元数据 → 阶段1~8 全能力 → 前端页面 → 稳定性与质量修复`。
