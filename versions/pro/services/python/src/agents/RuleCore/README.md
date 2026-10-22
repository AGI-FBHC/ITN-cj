# RuleCore —— 智训云枢规则引擎(MVP)

从知识文档中**自动抽取规则**,对 LLM 生成任务做**确定性前向推理**,把命中的 MUST / MUST_NOT / SHOULD 约束注入生成过程,并对生成结果做**逐条 Checker 校验**,支持**无规则(A 臂)/ 有规则(B 臂)A/B 对照**。

> 上游规范见 [智训云枢 Rule Engine MVP 开发说明.md](./智训云枢%20Rule%20Engine%20MVP%20开发说明.md)。
> 本模块是独立 FastAPI 服务(默认端口 **8201**),与 KnowledgeCore(8200)、QuestionBank 同库(`itn-platform`)但**独立进程、独立迁移**。

---

## 1. 架构总览

```
                    ┌────────────────────────────────────────────────────────┐
                    │                  RuleCore (FastAPI :8201)              │
  知识文档           │                                                        │
  (knowledge_       │  ┌──────────┐   ┌───────────┐   ┌──────────────────┐  │
   document /       │  │  抽取管线 │──▶│  前向推理  │──▶│  MUST/MUST_NOT   │  │
   chunk)           │  │  Extract │   │  Engine   │   │  Checker 校验    │  │
  ────────────────▶  │  └──────────┘   └───────────┘   └──────────────────┘  │
                     │     │  LLM 抽取        │ 确定性 Python     │ LLM 语义校验 │
                     │     ▼                  ▼                        ▼        │
                     │  domain_rule     reasoning_trace        check_a/b       │
                     │  (规则库)        (溯源链)               (逐条结论)      │
                     │                                                        │
                     │  ┌──────────────────────────────────────────────┐      │
                     │  │  A/B 对照: A 臂(不注入) vs B 臂(注入约束)      │      │
                     │  │  + 失败重试修订(≤ MAX_REVISION_RETRY)          │      │
                     │  └──────────────────────────────────────────────┘      │
                     └────────────────────────────────────────────────────────┘
```

### 数据流(一次对照任务)
1. **事实抽取**:LLM 从任务描述提取结构化 facts(如 `paradigm=ReAct`)。
2. **前向推理**:确定性 Python 引擎按 `conditions_json`(AND 条件 + 白名单运算符)匹配 `domain_rule`,同步轮直到不动点(≤ `MAX_REASONING_ROUNDS`)。
3. **约束注入**:命中规则的 MUST/MUST_NOT/SHOULD 作为约束清单注入 B 臂生成 prompt。
4. **生成**:A 臂原始生成;B 臂受控生成(注入约束)。
5. **Checker 校验**:LLM 对同一约束清单逐条判定 A/B 两臂 PASS/FAIL。
6. **修订重试**:B 臂未全过 → 带失败原因重生成一次(仅一次)。
7. **存档**:全部写入 `rule_compare`,可回放。

---

## 2. 目录结构

```
RuleCore/
├── app/
│   ├── main.py                 # FastAPI 入口、CORS、静态页挂载
│   ├── core/config.py          # pydantic-settings 配置(读 .env)
│   ├── rule_engine/
│   │   ├── api.py              # /api/rules/* 路由(抽取/推理/对照/回放)
│   │   ├── engine.py           # 确定性前向推理引擎(纯 Python, 无 LLM)
│   │   ├── fact_extractor.py   # 任务事实抽取(LLM)
│   │   ├── rule_extractor.py   # 文档→规则抽取(LLM, 置信度阈值过滤)
│   │   ├── rule_verifier.py    # 抽取规则二次核验(LLM, 防幻觉)
│   │   ├── rule_checker.py     # 生成结果逐条约束校验(LLM)
│   │   ├── comparison.py       # A/B 对照编排(双臂生成 + 修订重试)
│   │   ├── stable_code.py      # 规则稳定码(内容决定 rule_code, 去重/幂等)
│   │   ├── field_registry.py   # 事实字段注册表
│   │   ├── chunk_reader.py     # 读取 knowledge_document/chunk 原文
│   │   ├── rule_repository.py  # domain_rule 持久化(upsert/去重)
│   │   └── llm.py              # LLM 客户端(OpenAI 兼容, 截断 JSON 修复)
│   └── db/                     # 数据库访问
├── migrations/
│   └── 2026_08_25_rule_engine.sql  # domain_rule + rule_compare 建表
├── scripts/
│   ├── migrate.py              # 应用 SQL 迁移
│   ├── seed_rules.py           # 种子规则
│   ├── ingest_mcp_rules.py     # MCP 文档规则批量入库(幂等)
│   ├── purge_mcp_rules.py      # 按 MCP- 前缀整批删除(默认 dry-run)
│   ├── remap_mcp_codes.py      # 一次性 rule_code 迁移(两阶段防唯一键冲突)
│   ├── compare_react_demo.py   # 非 MCP 对照演示(ReAct+反思)
│   ├── extractor_control.py / evaluate_demo.py / llm_smoke.py / mcp_spec_probe.py
│   └── inspect_db.py           # 库内规则/对照统计(读 .env, 无硬编码凭据)
├── static/
│   └── comparison.html         # A/B 对照 Web 界面(来源文档下拉 + 回放)
├── tests/                      # pytest(引擎 + 离线逻辑, 45 用例)
├── data/mcp_spec/              # MCP 规范原文(.mdx, 抽取来源)
├── pyproject.toml / pytest.ini
└── .env.example                # 配置样例(无真实凭据)
```

---

## 3. 快速开始

### 3.1 依赖
```bash
cd src/agents/RuleCore
python -m venv .venv && source .venv/bin/activate
pip install -e .
```

### 3.2 配置
复制 `.env.example` 为 `.env`,填入 **MySQL** 与 **LLM** 凭据。**不要把真实 `.env` 提交到 Git。**

```ini
# .env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=change-me
MYSQL_DATABASE=itn-platform

LLM_API_URL=http://.../v1
LLM_API_KEY=change-me
LLM_MODEL=mimo-v2.6-flash

RULE_EXTRACT_CONFIDENCE_THRESHOLD=0.80
MAX_REASONING_ROUNDS=2
MAX_REVISION_RETRY=1
RULE_ENGINE_ENABLED=true
```

### 3.3 迁移 + 启动
```bash
python scripts/migrate.py                                  # 建 domain_rule / rule_compare
.venv/bin/python -m uvicorn app.main:app \
    --host 127.0.0.1 --port 8201 --log-level info          # 服务
```
- 健康检查:`GET /health`
- 对照界面:`http://127.0.0.1:8201/`(comparison.html)

### 3.4 测试
```bash
.venv/bin/python -m pytest -q        # 45 用例
```

---

## 4. API 一览(`/api/rules`)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 引擎/库/LLM 状态 + ACTIVE 规则数 |
| GET | `/documents` | 可抽取的知识文档列表(来源文档下拉) |
| POST | `/extract` | 文档→规则抽取(返回候选, 不直接入库) |
| POST | `/ingest` | 抽取→校验→upsert 入库(幂等去重) |
| POST | `/infer` | 任务→事实→前向推理(返回命中规则 + 溯源) |
| POST | `/compare` | 发起 A/B 对照(异步, 返回 task_id) |
| GET | `/compare/{task_id}` | 轮询对照状态 / 取结果 |
| GET | `/compare/{task_id}/replay` | 回放存档(事实/约束/双臂正文/逐条校验) |

> 对照任务写入 `rule_compare`,**内存态 + DB 双路径**均可取回;DB 回退路径会重建 `summary` 与 `matched_rules`。

---

## 5. 规则模型

### `domain_rule`
| 列 | 说明 |
|---|---|
| `rule_code` | **稳定码**,由内容哈希决定(非自增),重跑幂等去重的键 |
| `rule_type` | `extracted`(自动抽取)/ `seed`(种子) |
| `conditions_json` | AND 条件列表:`{field, value, operator}` |
| `conclusions_json` | `{type: MUST/MUST_NOT/SHOULD/SET, content, ...}` |
| `source_document_id` / `source_chunk_id` / `source_section` / `source_text` | **溯源**(抽取必存 `source_text`) |
| `confidence` | 抽取置信度;Verifier `≥0.80` → `ACTIVE`,否则 `INVALID` |
| `status` | `ACTIVE` / `INVALID` |

### 运算符与结论白名单(文档红线)
- **条件**:仅 AND;运算符 `EQ / NE / GT / GTE / LT / LTE / IN / NOT_IN / EXISTS`
- **结论**:`SET / MUST / MUST_NOT / SHOULD`
- **引擎**:确定性 Python,**禁 LLM**;前向推理**同步轮**,`MAX_REVISION_RETRY = 1`

---

## 6. 关键设计决策

1. **稳定码 `stable_code.py`**:规则身份由「来源原文 + 结论类型 + 结论内容 + 归一化条件值集」哈希决定,**不含规则名**。对 LLM 非确定性做**漂移容忍**——字段名同义词归一、值大小写归一、去 markdown/末尾标点——从而跨 run 重复抽取能幂等合并,而非产生重复规则。
2. **两阶段重命名**(`remap_mcp_codes.py`):迁移 rule_code 时先全部 → `TMPREM_*` 临时码 → 最终码,避免 UPDATE 过程中新码撞另一条旧码的 UNIQUE 键。
3. **抽取纪律**:只抽取原文明确支持的内容,必存 `source_text`;无法形式化的不抽;Verifier 二次核验拦截幻觉规则。
4. **A/B 对照**:同一约束清单同时校验 A/B 两臂,保证对照公平;B 臂失败才触发一次修订重试。
5. **溯源链**:每条命中规则可回放到「文档原文 → 章节 → 抽取 → 核验 → fire 轮次」。

---

## 7. 安全说明

- **凭据仅存于本地 `.env`**(已 `.gitignore`),仓库内**不提交任何真实密钥/密码**。
- `scripts/inspect_db.py` 等工具脚本一律 `from app.core.config import settings` 读 `.env`,**不硬编码** DB/LLM 凭据。
- `.env.example` 只含占位符,可安全提交。

---

## 8. 与 KnowledgeCore 的关系

- 同库 `itn-platform`,但 RuleCore **独立进程、独立端口(8201)**、独立迁移文件。
- RuleCore 从 `knowledge_document` / `knowledge_chunk` **读**原文做抽取;**切片不入库**(`source_document_id` 可指向已存在文档,但不新建知识实体)。
- MCP 规则按约定 `source_document_id=NULL` + `MCP-` 前缀,可用 `purge_mcp_rules.py` 整批删除。
- **不修改** KnowledgeCore 主体及其 `app/rules/`。
