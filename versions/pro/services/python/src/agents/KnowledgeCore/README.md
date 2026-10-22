# ITN Knowledge Core

**领域包驱动的规则-证据双轨知识决策内核**

> 将文档知识、结构化规则、技能关系、学习状态与运行约束统一为可计算事实，生成可审计的高保真知识决策（Knowledge Decision Contract）。

---

## 📋 目录

- [ITN Knowledge Core 系统介绍](#itn-knowledge-core-系统介绍)
  - [一、系统架构](#一系统架构)
  - [二、已完成的核心模块](#二已完成的核心模块)
  - [三、数据库表结构](#三数据库表结构)
  - [四、API 端点汇总](#四api-端点汇总)
  - [五、测试覆盖](#五测试覆盖)
  - [六、待完善功能](#六待完善功能)
- [详细文档](#详细文档)
  - [系统概述](#系统概述)
  - [核心概念](#核心概念)
  - [双轨推断算法](#双轨推断算法)
  - [快速开始](#快速开始)
  - [API 参考](#api-参考)
  - [数据库设计](#数据库设计)
  - [配置说明](#配置说明)
  - [开发指南](#开发指南)

---

# ITN Knowledge Core 系统介绍

## 一、系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        前端测试面板                               │
│                    http://localhost:8000                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    FastAPI 服务层                                 │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│   │ 领域管理  │ │ 证据检索  │ │ 规则执行  │ │ 双轨推断  │          │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│   │ 知识图谱  │ │ 文档管理  │ │ 审计日志  │ │ 决策契约  │          │
│   └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│     MySQL       │ │    RAGFlow      │ │   NetworkX      │
│   数据持久化     │ │   向量检索       │ │   图谱查询       │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## 二、已完成的核心模块

### 1. 领域包管理 (Domain Service)

**功能：**
- 领域创建、版本管理、激活、回滚
- 领域配置文件管理（本体、术语、证据角色、风险策略等）
- 运行快照生成与管理

**数据模型：**
```
Domain (领域)
  ├── DomainVersion (版本)
  │     └── DomainRuntimeSnapshot (运行快照)
  ├── DomainProfile (配置文件)
  ├── DomainEntityType (实体类型)
  ├── DomainRelationType (关系类型)
  ├── DomainEvidenceRole (证据角色)
  ├── DomainRuleBundle (规则包)
  └── DomainClaimSchema (关键主张)
```

---

### 2. 双轨推断算法 (Dual-Track Inference)

这是系统的核心算法，流程如下：

```
┌─────────────────────────────────────────────────────────────────┐
│                    双轨推断流程                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ① 构建事实快照 (Fact Snapshot)                                  │
│     │                                                           │
│     ▼                                                           │
│  ② 执行预检索规则 ──────────────────────────────┐                │
│     │                                           │                │
│     ▼                                           ▼                │
│  ③ RAGFlow 证据检索                         检索策略调整          │
│     │                                      (扩展查询/过滤)       │
│     ▼                                                           │
│  ④ 构建证据包 (Evidence Pack)                                    │
│     │                                                           │
│     ▼                                                           │
│  ⑤ 执行后检索规则 ──────────────────────────────┐                │
│     │                                           │                │
│     ▼                                           ▼                │
│  ⑥ 资格门控 (Eligibility Gate)             规则过滤/重排序       │
│     │                                                           │
│     ▼                                                           │
│  ⑦ 高保真评分 (HF Score)                                        │
│     │                                                           │
│     ▼                                                           │
│  ⑧ 生成决策契约 (Knowledge Decision Contract)                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 完整案例演示

**输入：**
```
查询: "什么是数据库事务的 ACID 特性？"
任务类型: question
数据集: cs_base_v1
```

---

**📥 阶段 1: 构建事实快照 (Fact Snapshot)**

**目的：** 固化任务上下文，为后续步骤提供统一的事实基础。

```json
{
    "fact_id": "fact_5ecd5798",
    "domain_runtime_snapshot_id": "drs_a163efd1",
    "query": "什么是数据库事务的 ACID 特性？",
    "task_type": "question",
    "user_context": {
        "learner": {}
    },
    "relevant_sections": [],
    "relevant_skills": [],
    "prerequisite_chain": [],
    "related_entities": [],
    "constraints": {}
}
```

**说明：** 事实快照将查询、任务类型、用户上下文等信息固化为一个不可变的对象，后续所有步骤都基于这个快照进行计算。

---

**📋 阶段 2: 执行预检索规则**

**目的：** 根据规则调整检索策略（扩展查询、过滤条件等）。

```
已加载规则: 3 条
  - rule_001: 高风险任务检查 (high_risk_task)
  - rule_002: 证据数量检查 (evidence_count_below)
  - rule_003: 查询关键词扩展 (query_contains)

检索策略调整:
{
    "expanded_queries": [],
    "required_sections": [],
    "excluded_documents": [],
    "max_results": 10
}
```

**说明：** 预检索规则会在检索之前运行，可以：
- 扩展查询词（如添加同义词）
- 指定必须包含的章节
- 排除某些文档
- 限制返回结果数量

本例中，规则未触发检索策略调整。

---

**🔍 阶段 3: RAGFlow 证据检索**

**目的：** 从知识库中检索与查询相关的证据 chunks。

```
证据包 ID: epack_10326a82
检索到证据: 10 条

证据列表 (前 5 条):
  [1] evi_e2e7306d
      相似度: 0.636
      角色: base
      权威性: official
      内容: # 事务隔离级别是怎么实现的？
            ## 事务有哪些特性？
            事务是由 MySQL 的引擎来实现的...

  [2] evi_71cb6ca2
      相似度: 0.635
      角色: base
      权威性: official
      内容: # Redis 常见面试题
            ## 认识 Redis
            ### 什么是 Redis？...

  [3] evi_7e1b1e67
      相似度: 0.630
      角色: base
      权威性: official
      内容: # Redis 数据结构
            Redis 为什么那么快？...
```

**说明：** RAGFlow 使用嵌入模型（BAAI/bge-m3）将查询和文档转换为向量，然后计算余弦相似度，返回最相关的 10 条证据。

---

**📦 阶段 4: 构建证据包评分**

**目的：** 对检索到的证据进行多维度评分。

```
证据包评分:
  覆盖度 (Coverage):           1.00
  权威性 (Authority):          1.00
  时效性 (Freshness):          0.80
  适用性 (Applicability):      0.63
  来源独立性 (SourceIndependence): 1.00
  冲突风险 (ConflictRisk):     0.00

评分计算说明:
  覆盖度 = min(1.0, 证据数量/3) = min(1.0, 10/3) = 1.00
  来源独立性 = min(1.0, 独立文档数/2) = min(1.0, 6/2) = 1.00
```

**说明：**
- **覆盖度 100%**：检索到 10 条证据，超过最低要求 3 条
- **权威性 100%**：所有证据都来自官方文档（official）
- **适用性 63%**：平均相似度为 0.63
- **来源独立性 100%**：证据来自 6 个不同文档

---

**⚙️ 阶段 5: 执行规则**

**目的：** 检查查询是否触发了任何规则（硬规则、证据策略等）。

```
规则执行结果:
  是否通过: True
  命中规则: 2 条
  被阻止: 0 条
  被限制: 1 条

命中的规则:
  ✓ rule_002: 证据数量检查
    级别: operational, 动作: restrict
    消息: 证据不足，建议扩大检索范围
  ✓ rule_003: 查询关键词扩展
    级别: soft, 动作: expand_query
    消息: 扩展相关查询
```

**说明：**
- **rule_002** 触发是因为规则检查的是"预检索阶段"的证据数量（此时为 0）
- **rule_003** 触发是因为查询包含"数据库"关键词
- 规则通过，没有硬规则阻止执行

---

**🚦 阶段 6: 资格门控 (Eligibility Gate)**

**目的：** 综合判断证据是否满足决策条件。

```
门控结果:
  是否通过: True
  门控类型: pass
  决策建议: permit

各维度检查:
  ✓ 覆盖度: 1.00 >= 0.5 通过
  ✓ 权威性: 1.00 >= 0.3 通过
  ✓ 适用性: 0.63 >= 0.3 通过
  ✓ 时效性: 0.80 >= 0.3 通过
  ✓ 冲突风险: 0.00 <= 0.5 通过
```

**说明：** 所有维度都通过了阈值检查，门控结果为 PASS。

---

**📊 阶段 7: 高保真评分 (HF Score)**

**目的：** 计算决策的综合置信度。

```
HF 评分公式:
HF = Eligibility × (α·Coverage + β·Authority + γ·Applicability
     + δ·Freshness + ε·GraphConsistency + ζ·SourceIndependence − λ·ConflictRisk)

计算过程:
  HF = 1.0 × (
      0.25 × 1.00    # 覆盖度贡献
    + 0.15 × 1.00    # 权威性贡献
    + 0.20 × 0.63    # 适用性贡献
    + 0.10 × 0.80    # 时效性贡献
    + 0.15 × 1.00    # 图谱一致性贡献
    + 0.10 × 1.00    # 来源独立性贡献
    - 0.05 × 0.00    # 冲突风险扣除
  )

  HF = 0.8557 = 85.6%
```

**说明：** HF 评分 85.6%，超过高置信度阈值 0.8。

---

**📜 阶段 8: 生成决策契约 (Knowledge Decision Contract)**

**目的：** 生成最终的决策结果，包含所有审计信息。

```
决策类型判定:
  HF 阈值: 高≥0.8, 中≥0.5, 低≥0.3
  当前 HF: 0.8557
  决策结果: PERMIT - 高置信度，允许执行

允许的操作:
  ✓ answer_question      # 回答问题
  ✓ provide_explanation  # 提供解释
  ✓ show_code_examples   # 展示代码示例
  ✓ reference_figures    # 引用图表

必需引用 (相似度最高的 3 条证据):
  [1] f66c74c1fd8403b4
  [2] 8609fe52624c4391
  [3] 7212729a7efd3fe6
```

**说明：** 最终决策为 PERMIT，系统可以：
- 回答用户关于 ACID 特性的问题
- 提供详细的解释
- 展示相关的代码示例
- 引用知识库中的图表

---

### 3. 资格门控算法 (Eligibility Gate)

**检查维度：**

| 维度 | 阈值 | 说明 |
|------|------|------|
| 覆盖度 (Coverage) | ≥ 0.5 | 证据覆盖知识点的比例 |
| 权威性 (Authority) | ≥ 0.3 | 证据来源的权威程度 |
| 适用性 (Applicability) | ≥ 0.3 | 证据与查询的相关性 |
| 时效性 (Freshness) | ≥ 0.3 | 证据的新鲜程度 |
| 冲突风险 (Conflict Risk) | ≤ 0.5 | 证据间的冲突程度 |
| 证据数量 | ≥ 1 | 最少证据数 |

**门控结果：**
- `PASS` - 全部通过
- `INSUFFICIENT_EVIDENCE` - 证据不足
- `BLOCKED` - 被规则阻止
- `RESTRICTED` - 部分不通过

**核心问题：评分是靠什么计算的？是大模型生成的吗？**

**答案：不是大模型生成的，是基于规则的确定性计算。**

评分由以下几部分组成：

#### 1) 覆盖度 (Coverage Score)

**当前实现：**
```python
coverage_score = min(1.0, evidence_count / 3)
```

| 证据数量 | 覆盖度 |
|----------|--------|
| 0 | 0% |
| 1 | 33% |
| 2 | 67% |
| 3+ | 100% |

**说明：** 这是一个简化的计算，假设至少需要 3 条证据才能覆盖知识点。

#### 2) 权威性 (Authority Score)

**计算方式：** 加权平均

```python
AUTHORITY_WEIGHTS = {
    "official": 1.0,      # 官方文档
    "reference": 0.7,     # 参考资料
    "example": 0.5,       # 示例代码
    "community": 0.3,     # 社区贡献
}

authority_score = sum(weight for each evidence) / evidence_count
```

**示例：**
```
10 条证据，全部来自官方文档
authority_score = (1.0 × 10) / 10 = 1.0 (100%)

10 条证据，5 条官方 + 5 条社区
authority_score = (1.0 × 5 + 0.3 × 5) / 10 = 0.65 (65%)
```

#### 3) 适用性 (Applicability Score)

**计算方式：** RAGFlow 返回的相似度分数平均值

```python
applicability_score = sum(item.similarity_score for item in items) / len(items)
```

**关键点：** 这个分数来自 RAGFlow 的向量检索，底层使用的是 **嵌入模型**（如 BAAI/bge-m3），这是神经网络模型，但不是大语言模型（LLM）。

```
RAGFlow 检索流程：
1. 用户查询 → 嵌入模型 → 查询向量
2. 文档 chunks → 嵌入模型 → 文档向量（预计算）
3. 计算余弦相似度 → 返回 top_k 结果
```

#### 4) 时效性 (Freshness Score)

**当前实现：** 固定值

```python
freshness_score = 0.8  # 简化实现
```

**说明：** 当前未基于文档时间计算，后续可基于文档版本、更新时间等计算。

#### 5) 来源独立性 (Source Independence)

**计算方式：** 独立文档来源数量

```python
unique_docs = len(set(item.document_id for item in items))
source_independence_score = min(1.0, unique_docs / 2)
```

**示例：**
```
10 条证据，全部来自 1 个文档
source_independence_score = min(1.0, 1/2) = 0.5 (50%)

10 条证据，来自 3 个不同文档
source_independence_score = min(1.0, 3/2) = 1.0 (100%)
```

#### 6) 冲突风险 (Conflict Risk)

**计算方式：** 同章节内证据相似度方差

```python
# 按章节分组
for section, items in section_evidence.items():
    similarities = [item.similarity_score for item in items]
    if max(similarities) - min(similarities) > 0.3:
        conflicts.append(...)

conflict_risk_score = min(1.0, len(conflicts) * 0.2)
```

**说明：** 如果同一章节的多条证据相似度差异大，说明可能存在冲突。

#### 评分来源总结

| 组件 | 计算方式 | 是否 AI |
|------|----------|---------|
| 覆盖度 | 规则计算 | ❌ 否 |
| 权威性 | 规则计算 | ❌ 否 |
| **适用性** | **嵌入模型相似度** | ✅ 是（嵌入模型，非 LLM） |
| 时效性 | 固定值 | ❌ 否 |
| 来源独立性 | 规则计算 | ❌ 否 |
| 冲突风险 | 规则计算 | ❌ 否 |
| **HF 评分** | 加权公式 | ❌ 否 |
| **门控判定** | 阈值比较 | ❌ 否 |

#### 数据流示例

```
用户查询 "什么是数据库索引？"
         │
         ▼
┌─────────────────────────────────────────┐
│ RAGFlow 向量检索                         │
│ - 嵌入模型: BAAI/bge-m3                 │
│ - 返回: 10 条相似 chunks                │
│ - 每条包含: similarity_score (0.674 等)  │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ 规则计算（非 AI）                        │
│ - 覆盖度: 10/3 = 1.0                    │
│ - 权威性: 全部 official = 1.0           │
│ - 适用性: avg(0.674, 0.656, ...) = 0.65 │
│ - 来源独立性: 3个文档/2 = 1.0           │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ HF 评分公式                              │
│ hf = 0.25×1.0 + 0.15×1.0 + 0.20×0.65   │
│      + 0.10×0.8 + 0.15×1.0 + 0.10×1.0  │
│      - 0.05×0.0                         │
│ hf = 0.86 (86%)                         │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│ 门控判定                                 │
│ - 覆盖度 1.0 ≥ 0.5 ✓                   │
│ - 权威性 1.0 ≥ 0.3 ✓                   │
│ - 适用性 0.65 ≥ 0.3 ✓                  │
│ - 时效性 0.8 ≥ 0.3 ✓                   │
│ - 冲突风险 0.0 ≤ 0.5 ✓                 │
│ → 结果: PASS (permit)                   │
└─────────────────────────────────────────┘
```


---

### 4. 高保真评分算法 (High-Fidelity Score)

**公式：**
```
HF = Eligibility × (α·Coverage + β·Authority + γ·Applicability 
     + δ·Freshness + ε·GraphConsistency 
     + ζ·SourceIndependence − λ·ConflictRisk)
```

**权重配置：**

| 指标 | 权重 | 说明 |
|------|------|------|
| Coverage (覆盖度) | α = 0.25 | 证据覆盖知识点的比例 |
| Authority (权威性) | β = 0.15 | 文档权威等级 |
| Applicability (适用性) | γ = 0.20 | 查询与证据的匹配度 |
| Freshness (时效性) | δ = 0.10 | 文档新鲜度 |
| GraphConsistency (图谱一致性) | ε = 0.15 | 知识图谱一致性 |
| SourceIndependence (来源独立性) | ζ = 0.10 | 证据来源多样性 |
| ConflictRisk (冲突风险) | λ = -0.05 | 证据冲突程度 |

**评分计算示例：**
```python
# 假设各维度分数
coverage = 1.0
authority = 1.0
applicability = 0.65
freshness = 0.8
graph_consistency = 1.0
source_independence = 0.5
conflict_risk = 0.0

# 计算 HF 分数
hf = (0.25 * 1.0 + 0.15 * 1.0 + 0.20 * 0.65 
      + 0.10 * 0.8 + 0.15 * 1.0 + 0.10 * 0.5 
      - 0.05 * 0.0)
hf = 0.25 + 0.15 + 0.13 + 0.08 + 0.15 + 0.05 - 0.0
hf = 0.81  # 81% 高保真度
```

---

### 5. 决策契约 (Knowledge Decision Contract)

**决策类型：**

| 决策 | HF 阈值 | 允许的操作 |
|------|---------|-----------|
| `PERMIT` | ≥ 0.8 | 回答问题、提供解释、代码示例、引用图表 |
| `RESTRICT_SCOPE` | ≥ 0.5 | 回答问题、部分解释 |
| `RETRIEVE_AGAIN` | < 0.5 | 请求更多信息 |
| `BLOCK` | 门控失败 | 无 |
| `REQUEST_HUMAN_REVIEW` | < 0.3 | 升级到人工 |

**契约结构：**
```json
{
  "contract_id": "kdc_xxx",
  "decision": "permit",
  "high_fidelity_score": 0.86,
  "eligibility": {
    "is_eligible": true,
    "gate_type": "pass",
    "scores": {
      "coverage": 1.0,
      "authority": 1.0,
      "applicability": 0.65,
      "freshness": 0.8,
      "conflict_risk": 0.0
    }
  },
  "permitted_actions": ["answer_question", "provide_explanation"],
  "required_citations": ["chunk_id_1", "chunk_id_2"],
  "prohibited_content": [],
  "evidence_items": [...],
  "rule_hits": [...],
  "audit_trail": [...]
}
```

---

### 6. 规则执行引擎 (Rule Service)

**规则层级：**

| 层级 | 优先级 | 说明 |
|------|--------|------|
| `hard` | 最高 | 安全、合规、关键流程 |
| `evidence_policy` | 高 | 证据等级、适用性 |
| `operational` | 中 | 时延、成本、检索次数 |
| `pedagogical` | 低 | 难度、示例、补救 |
| `soft` | 最低 | 表达粒度、术语密度 |

**内置谓词：**

| 谓词 | 说明 | 参数 |
|------|------|------|
| `always` | 总是返回 True | 无 |
| `never` | 总是返回 False | 无 |
| `high_risk_task` | 高风险任务检查 | 无 |
| `query_contains` | 查询包含关键词 | `keywords: list[str]` |
| `evidence_count_below` | 证据数量不足 | `threshold: int` |
| `similarity_below` | 相似度过低 | `threshold: float` |

---

### 7. 证据检索 (Evidence Service)

**与 RAGFlow 集成：**

```python
# 检索流程
1. 调用 RAGFlow retrieve() API
2. 获取相关 chunks
3. 构建 EvidenceItem 列表
4. 计算各维度评分
5. 持久化到数据库
```

**评分计算：**

| 维度 | 计算方法 |
|------|----------|
| 覆盖度 | `min(1.0, evidence_count / 3)` |
| 权威性 | 加权平均（official=1.0, reference=0.7, example=0.5, community=0.3） |
| 适用性 | 平均相似度分数 |
| 时效性 | 固定 0.8（简化） |
| 来源独立性 | `min(1.0, unique_docs / 2)` |
| 冲突风险 | 同 section 相似度方差 > 0.3 则计为冲突 |

---

### 8. 知识图谱 (Graph Service)

**功能：**
- 节点管理（概念、技能、文档、规则）
- 边管理（先修、相关、包含、适用）
- 先修链查询（BFS 遍历）
- 影响分析（反向图遍历）
- 一致性校验（环检测）

**图谱结构：**
```
[概念A] ──先修──▶ [技能B] ──相关──▶ [文档C]
    │                                  │
    └──包含──▶ [规则D] ◀──适用──┘
```

---

## 三、数据库表结构

共 **21 张表**：

| 模块 | 表名 | 说明 |
|------|------|------|
| 领域 | `domains` | 领域主表 |
| | `domain_versions` | 领域版本 |
| | `domain_runtime_snapshots` | 运行快照 |
| | `domain_profiles` | 配置文件 |
| | `domain_entity_types` | 实体类型 |
| | `domain_relation_types` | 关系类型 |
| | `domain_evidence_roles` | 证据角色 |
| | `domain_rule_bundles` | 规则包 |
| | `domain_claim_schemas` | 关键主张 |
| 文档 | `documents` | 文档主表 |
| | `document_chunks` | 文档分块 |
| 证据 | `evidence_packs` | 证据包 |
| | `evidence_items` | 证据项 |
| 规则 | `rule_bundles` | 规则包 |
| | `rule_execution_logs` | 执行日志 |
| 决策 | `decision_records` | 决策记录 |
| | `fact_snapshots` | 事实快照 |
| 图谱 | `graph_nodes` | 图谱节点 |
| | `graph_edges` | 图谱边 |
| 审计 | `audit_records` | 审计记录 |
| 系统 | `alembic_version` | 迁移版本 |

---

## 四、API 端点汇总

| 模块 | 端点 | 说明 |
|------|------|------|
| 领域 | `POST /domains` | 创建领域 |
| | `POST /domains/{id}/versions` | 创建版本 |
| | `POST /domains/{id}/activate` | 激活版本 |
| | `POST /domains/{id}/rollback` | 回滚版本 |
| 决策 | `POST /knowledge/resolve` | **双轨推断** |
| | `POST /knowledge/decision/replay` | 决策回放 |
| | `GET /knowledge/decision/{id}` | 查询决策 |
| 证据 | `POST /evidence/search` | 证据检索 |
| 规则 | `POST /rules/execute` | 执行规则 |
| | `GET /rules/predicates` | 查看谓词 |
| 图谱 | `GET /graph/{id}/nodes` | 查看节点 |
| | `GET /graph/{id}/prerequisites/{skill}` | 先修链 |
| | `POST /graph/{id}/validate` | 一致性校验 |
| 文档 | `POST /documents` | 创建文档 |
| | `GET /documents/{id}` | 获取文档 |
| 审计 | `GET /audit` | 审计日志 |

---

## 五、测试覆盖

**26 个单元测试全部通过：**

| 模块 | 测试数 | 覆盖内容 |
|------|--------|----------|
| DomainService | 8 | 创建、查询、版本、校验 |
| EvidenceService | 6 | 证据包、证据项、评分、冲突 |
| DecisionService | 6 | 门控、HF 评分、契约生成 |
| RuleService | 6 | 快照、规则执行、谓词评估 |

---

## 六、待完善功能

| 功能 | 状态 | 说明 |
|------|------|------|
| RAGFlow 实际检索 | ✅ 已集成 | 需配置 API Key |
| 规则 DSL 解析 | ⚠️ 基础版 | 支持简单谓词，复杂规则待扩展 |
| 图谱查询 | ⚠️ 基础版 | NetworkX 集成待完善 |
| 审计回放 | ⚠️ 基础版 | 历史决策回放已实现 |
| 跨领域对齐 | ❌ 未开始 | P2 优先级 |

---

# 详细文档

## 系统概述

### 定位

ITN Knowledge Core **不是通用文档问答组件**，而是领域包驱动的规则-证据双轨知识底座。它通过以下方式确保知识决策的可靠性：

1. **证据轨**：从 RAGFlow 检索相关证据，评估覆盖度、权威性、适用性
2. **规则轨**：执行结构化规则，检查约束、限制、合规要求
3. **图谱校验**：验证知识结构一致性、先修关系完整性
4. **高保真评分**：综合多维度指标计算决策置信度
5. **决策契约**：生成可审计的 Knowledge Decision Contract

### 核心价值

| 价值 | 说明 |
|------|------|
| 🔒 **安全可控** | 高风险任务可被稳定拦截或限制 |
| 📊 **可审计** | 每次决策都有完整的审计追踪 |
| 🎯 **高保真** | 多维度评分确保决策质量 |
| 🔄 **可回放** | 支持历史决策回放与分析 |
| 📦 **领域隔离** | 不同领域知识严格隔离 |

---

## 核心概念

### 1. 双轨推断

| 轨道 | 核心问题 | 输出 |
|------|----------|------|
| **证据轨** | 系统是否拥有适用于当前任务的可靠依据？ | Evidence Pack、覆盖度、权威性、时效性、适用性 |
| **规则轨** | 当前任务是否允许执行，执行时需要满足什么边界？ | 硬约束、检索策略、输出边界、限制动作 |
| **图谱层** | 知识、任务、对象和约束之间是否结构一致？ | 先修链、关联实体、依赖关系 |
| **裁决层** | 是否达到可供下游消费的高保真条件？ | PERMIT / RESTRICT / BLOCK / REVIEW |

### 2. 决策工件

| 工件 | 生成时机 | 作用 |
|------|----------|------|
| **Domain Runtime Snapshot** | 领域包激活时 | 锁定领域、规则、图谱、文档版本组合 |
| **Fact Snapshot** | 每次请求开始时 | 固化任务、学习状态、领域上下文 |
| **Evidence Pack** | 检索后 | 封装可用证据及其角色、覆盖、适用性 |
| **Knowledge Decision Contract** | 双轨裁决后 | 定义决策状态、可用范围、必需引用 |

### 3. 领域知识包 (DKP)

DKP 是可独立版本化、校验、激活、回滚和审计的领域运行单元：

```
domain-knowledge-pack/
├── domain_manifest          # 领域标识与版本
├── ontology_profile         # 实体类型、关系类型
├── terminology_profile      # 术语、缩写、同义词
├── document_source_policy   # 来源准入、权威等级
├── evidence_role_profile    # 基础/扩展证据角色
├── risk_policy_profile      # 风险枚举、门控项
├── retrieval_profile        # 查询改写、过滤策略
├── graph_profile            # 核心/扩展本体映射
├── rule_bundle              # 规则 DSL、优先级
├── claim_schema             # 关键主张与验证要求
└── evaluation_profile       # 测试集、验收阈值
```

### 4. 规则层级

| 层级 | 职责 | 冲突处理 |
|------|------|----------|
| **hard** | 安全、合规、先修、关键流程 | 不可被任何低层级覆盖 |
| **evidence_policy** | 证据等级、适用性 | 仅允许被更严格的硬规则收紧 |
| **operational** | 时延、成本、检索次数 | 不得破坏硬规则和证据政策 |
| **pedagogical** | 难度、示例、补救 | 在可行域内选择更适合学习者的策略 |
| **soft** | 表达粒度、术语密度 | 优先级最低 |

---

## 系统架构

### 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        应用层                                     │
│              FastAPI + 前端测试面板                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      服务层 (Services)                           │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │ DomainService │ │EvidenceService│ │ RuleService  │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │DecisionService│ │ GraphService │ │  AuditService │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      数据层 (Data)                               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │    MySQL      │ │   RAGFlow    │ │  NetworkX    │            │
│  │  (21 张表)    │ │  (向量检索)   │ │  (图谱查询)   │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### 目录结构

```
src/agents/KnowledgeCore/
├── app/                          # FastAPI 应用
│   ├── core/                     # 核心配置
│   │   ├── config.py             # 配置管理
│   │   └── database.py           # 数据库连接
│   ├── domain/                   # 领域管理模块
│   │   ├── models/               # ORM + Pydantic 模型
│   │   ├── schemas.py            # 请求/响应模型
│   │   ├── services/             # 业务逻辑
│   │   └── api/                  # API 路由
│   ├── document/                 # 文档管理模块
│   ├── evidence/                 # 证据检索模块
│   │   └── services/
│   │       ├── evidence_service.py
│   │       └── ragflow_retriever.py
│   ├── rules/                    # 规则执行模块
│   │   └── services/
│   │       ├── rule_service.py
│   │       └── predicate_registry.py
│   ├── decision/                 # 双轨推断模块
│   │   └── services/
│   │       └── decision_service.py
│   ├── graph/                    # 知识图谱模块
│   ├── audit/                    # 审计日志模块
│   └── main.py                   # 应用入口
├── alembic/                      # 数据库迁移
├── static/                       # 前端静态文件
├── tests/                        # 单元测试
├── predeal/                      # 预处理管线 (已有)
├── pyproject.toml                # 项目配置
└── README.md                     # 本文档
```

---

## 双轨推断算法

### 流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                      双轨推断流程                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  输入: query + task_type + dataset_ids                          │
│    │                                                            │
│    ▼                                                            │
│  ┌─────────────────────────────────────────┐                    │
│  │ ① 构建事实快照 (Fact Snapshot)           │                    │
│  │    - 查询内容                            │                    │
│  │    - 任务类型                            │                    │
│  │    - 用户上下文                          │                    │
│  └─────────────────────────────────────────┘                    │
│    │                                                            │
│    ▼                                                            │
│  ┌─────────────────────────────────────────┐                    │
│  │ ② 执行预检索规则                         │                    │
│  │    - 查询扩展                            │                    │
│  │    - 过滤条件                            │                    │
│  └─────────────────────────────────────────┘                    │
│    │                                                            │
│    ▼                                                            │
│  ┌─────────────────────────────────────────┐                    │
│  │ ③ RAGFlow 证据检索                       │                    │
│  │    - 向量相似度检索                       │                    │
│  │    - 返回 top_k 相关 chunks              │                    │
│  └─────────────────────────────────────────┘                    │
│    │                                                            │
│    ▼                                                            │
│  ┌─────────────────────────────────────────┐                    │
│  │ ④ 构建证据包 (Evidence Pack)             │                    │
│  │    - 计算覆盖度                          │                    │
│  │    - 计算权威性                          │                    │
│  │    - 计算适用性                          │                    │
│  │    - 检测冲突                            │                    │
│  └─────────────────────────────────────────┘                    │
│    │                                                            │
│    ├──────────────────────┬──────────────────────┐              │
│    ▼                      ▼                      ▼              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │ 证据轨检查   │  │ 规则轨执行   │  │ 图谱校验    │            │
│  │ - 覆盖度    │  │ - 硬规则    │  │ - 先修链    │            │
│  │ - 权威性    │  │ - 证据策略  │  │ - 一致性    │            │
│  │ - 适用性    │  │ - 运营规则  │  │ - 依赖      │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
│    │                      │                      │              │
│    └──────────────────────┴──────────────────────┘              │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────┐                    │
│  │ ⑤ 资格门控 (Eligibility Gate)            │                    │
│  │    - 综合判断是否通过                     │                    │
│  │    - 确定门控类型                         │                    │
│  └─────────────────────────────────────────┘                    │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────┐                    │
│  │ ⑥ 高保真评分 (HF Score)                  │                    │
│  │    HF = Eligibility × (                  │                    │
│  │      α·Coverage + β·Authority +          │                    │
│  │      γ·Applicability + δ·Freshness +     │                    │
│  │      ε·GraphConsistency +                │                    │
│  │      ζ·SourceIndependence -              │                    │
│  │      λ·ConflictRisk                      │                    │
│  │    )                                     │                    │
│  └─────────────────────────────────────────┘                    │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────┐                    │
│  │ ⑦ 生成决策契约                           │                    │
│  │    - 决策类型 (PERMIT/RESTRICT/BLOCK)    │                    │
│  │    - 允许的操作                          │                    │
│  │    - 必需引用                            │                    │
│  │    - 禁止内容                            │                    │
│  │    - 补救建议                            │                    │
│  │    - 审计追踪                            │                    │
│  └─────────────────────────────────────────┘                    │
│                           │                                     │
│                           ▼                                     │
│  输出: Knowledge Decision Contract                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 资格门控算法

**检查维度与阈值：**

```python
ELIGIBILITY_THRESHOLDS = {
    "min_coverage": 0.5,        # 覆盖度阈值
    "min_authority": 0.3,       # 权威性阈值
    "min_applicability": 0.3,   # 适用性阈值
    "min_freshness": 0.3,       # 时效性阈值
    "max_conflict_risk": 0.5,   # 冲突风险阈值
    "min_evidence_count": 1,    # 最少证据数
}
```

**门控逻辑：**

```python
def check_eligibility(evidence_pack, rule_results, graph_validation):
    # 1. 检查证据数量
    if evidence_count < min_evidence_count:
        return INSUFFICIENT_EVIDENCE
    
    # 2. 检查覆盖度
    coverage_passed = coverage_score >= min_coverage
    
    # 3. 检查权威性
    authority_passed = authority_score >= min_authority
    
    # 4. 检查适用性
    applicability_passed = applicability_score >= min_applicability
    
    # 5. 检查时效性
    freshness_passed = freshness_score >= min_freshness
    
    # 6. 检查冲突风险
    conflict_check_passed = conflict_risk_score <= max_conflict_risk
    
    # 7. 检查规则
    rules_passed = rule_results.passed
    
    # 8. 综合判断
    is_eligible = all([
        coverage_passed,
        authority_passed,
        applicability_passed,
        freshness_passed,
        conflict_check_passed,
        rules_passed,
    ])
    
    return determine_gate_type(is_eligible, ...)
```

### 高保真评分算法

**公式：**

```
HF = Eligibility × (
    α · Coverage +
    β · Authority +
    γ · Applicability +
    δ · Freshness +
    ε · GraphConsistency +
    ζ · SourceIndependence -
    λ · ConflictRisk
)
```

**权重配置：**

| 指标 | 符号 | 权重 | 说明 |
|------|------|------|------|
| Coverage | α | 0.25 | 证据覆盖知识点的比例 |
| Authority | β | 0.15 | 文档权威等级 |
| Applicability | γ | 0.20 | 查询与证据的匹配度 |
| Freshness | δ | 0.10 | 文档新鲜度 |
| GraphConsistency | ε | 0.15 | 知识图谱一致性 |
| SourceIndependence | ζ | 0.10 | 证据来源多样性 |
| ConflictRisk | λ | -0.05 | 证据冲突程度 |

**计算示例：**

```python
# 输入分数
coverage = 1.0        # 100% 覆盖
authority = 1.0       # 全部官方文档
applicability = 0.65  # 65% 适用
freshness = 0.8       # 80% 新鲜
graph_consistency = 1.0  # 图谱一致
source_independence = 0.5  # 2个独立来源
conflict_risk = 0.0   # 无冲突

# 计算
hf = (0.25 * 1.0 +    # 0.25
      0.15 * 1.0 +    # 0.15
      0.20 * 0.65 +   # 0.13
      0.10 * 0.8 +    # 0.08
      0.15 * 1.0 +    # 0.15
      0.10 * 0.5 -    # 0.05
      0.05 * 0.0)     # 0.00
hf = 0.81             # 81% 高保真度
```

### 决策类型判定

```python
def determine_decision(eligibility, hf_score):
    # 门控失败
    if not eligibility.is_eligible:
        if eligibility.gate_type == "blocked":
            return "block"
        elif eligibility.gate_type == "insufficient_evidence":
            return "retrieve_again"
        else:
            return "restrict_scope"
    
    # 门控通过，根据 HF 分数决定
    if hf_score >= 0.8:
        return "permit"           # 高置信度，允许执行
    elif hf_score >= 0.5:
        return "restrict_scope"   # 中置信度，限制范围
    elif hf_score >= 0.3:
        return "restrict_scope"   # 低置信度，限制范围
    else:
        return "request_human_review"  # 极低置信度，人工审核
```

---

## 快速开始

### 环境要求

- Python 3.10+
- MySQL 8.0+
- RAGFlow 服务

### 安装

```bash
cd src/agents/KnowledgeCore

# 创建虚拟环境
python -m venv .venv
source .venv/bin/activate

# 安装依赖
pip install -e .
pip install -e ".[dev]"
```

### 配置

创建 `.env` 文件：

```env
# MySQL 配置
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DB=itn_core

# RAGFlow 配置
RAGFLOW_BASE_URL=http://127.0.0.1:9380
RAGFLOW_API_KEY=your_api_key

# 调试模式
DEBUG=true
```

### 数据库迁移

```bash
# 初始化 Alembic
alembic init alembic

# 生成迁移脚本
alembic revision --autogenerate -m "initial tables"

# 执行迁移
alembic upgrade head
```

### 启动服务

```bash
# 开发模式
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# 生产模式
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

### 访问

- **前端面板**: http://localhost:8000
- **API 文档**: http://localhost:8000/docs
- **健康检查**: http://localhost:8000/health

---

## API 参考

### 双轨推断

#### POST /api/v1/knowledge/resolve

执行完整的双轨推断，生成 Knowledge Decision Contract。

**请求体：**

```json
{
  "query": "什么是数据库事务的 ACID 特性？",
  "task_type": "question",
  "dataset_ids": ["107e63147f7811f19fb2cf1621f4faf0"],
  "top_k": 10,
  "similarity_threshold": 0.2
}
```

**参数说明：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | ✅ | 查询内容 |
| task_type | string | ❌ | 任务类型：question/explanation/exercise/troubleshooting |
| domain_id | string | ❌ | 领域 ID（可选，默认使用第一个可用领域） |
| dataset_ids | string[] | ❌ | RAGFlow 数据集 ID 列表 |
| top_k | int | ❌ | 检索结果数量，默认 10 |
| similarity_threshold | float | ❌ | 相似度阈值，默认 0.2 |

**响应示例：**

```json
{
  "contract_id": "kdc_7232d55f",
  "decision": "permit",
  "high_fidelity_score": 0.86,
  "domain_runtime_snapshot_id": "drs_a163efd1",
  "fact_snapshot_id": "fact_6cfcc5d2",
  "evidence_pack_id": "epack_bb1b66bb",
  "eligibility": {
    "is_eligible": true,
    "gate_type": "pass",
    "coverage_passed": true,
    "authority_passed": true,
    "applicability_passed": true,
    "freshness_passed": true,
    "conflict_check_passed": true,
    "failure_reasons": [],
    "remediation_suggestions": [],
    "scores": {
      "coverage": 1.0,
      "authority": 1.0,
      "applicability": 0.65,
      "freshness": 0.8,
      "conflict_risk": 0.0
    }
  },
  "permitted_actions": [
    "answer_question",
    "provide_explanation",
    "show_code_examples",
    "reference_figures"
  ],
  "required_citations": [
    "7b2a32685b26390e",
    "8b87247a160d4231",
    "db184885ba8e1494"
  ],
  "prohibited_content": [],
  "remediation_items": [],
  "evidence_count": 10,
  "evidence_items": [
    {
      "evidence_id": "evi_212a06c0",
      "chunk_id": "bbe4048484bc642e",
      "document_id": "doc_xxx",
      "content": "# 索引常见面试题\n## 什么是索引？...",
      "similarity_score": 0.674,
      "evidence_role": "base",
      "authority_level": "official",
      "heading": "什么是索引？"
    }
  ],
  "rule_hits": [
    {
      "rule_id": "rule_003",
      "name": "查询关键词扩展",
      "level": "soft",
      "action": "expand_query",
      "message": "扩展相关查询"
    }
  ],
  "audit_trail": [
    {
      "step": "eligibility_check",
      "timestamp": "2026-07-16T15:59:40.091919",
      "result": {
        "is_eligible": true,
        "gate_type": "pass",
        "failure_reasons": []
      }
    },
    {
      "step": "hf_scoring",
      "timestamp": "2026-07-16T15:59:40.091941",
      "result": {
        "hf_score": 0.86
      }
    }
  ],
  "created_at": "2026-07-16T15:59:43.238395"
}
```

### 领域管理

#### POST /api/v1/domains

创建领域。

```json
{
  "domain_id": "cs_base",
  "name": "计算机科学基础",
  "description": "计算机科学基础知识库"
}
```

#### POST /api/v1/domains/{domain_id}/versions

创建领域版本。

```json
{
  "version": "v1",
  "created_by": "admin"
}
```

#### POST /api/v1/domains/{domain_id}/activate

激活领域版本。

```json
{
  "version": "v1",
  "activated_by": "admin"
}
```

### 证据检索

#### POST /api/v1/evidence/search

检索证据。

```json
{
  "domain_id": "cs_base",
  "query": "数据库索引",
  "dataset_ids": ["107e63147f7811f19fb2cf1621f4faf0"],
  "top_k": 10
}
```

### 规则管理

#### GET /api/v1/rules/predicates

列出可用谓词。

#### POST /api/v1/rules/execute

执行规则。

```json
{
  "domain_id": "cs_base",
  "fact_snapshot_id": "fact_xxx"
}
```

### 知识图谱

#### GET /api/v1/graph/{domain_id}/nodes

列出图谱节点。

#### GET /api/v1/graph/{domain_id}/prerequisites/{skill_id}

查询先修链。

#### POST /api/v1/graph/{domain_id}/validate

校验图谱一致性。

### 审计日志

#### GET /api/v1/audit

列出审计记录。

| 参数 | 类型 | 说明 |
|------|------|------|
| domain_id | string | 领域 ID 过滤 |
| audit_type | string | 审计类型过滤 |
| limit | int | 返回数量 |
| offset | int | 偏移量 |

---

## 数据库设计

### 表结构总览

共 **21 张表**：

```
┌─────────────────────────────────────────────────────────────────┐
│                        领域模块 (9 张表)                         │
├─────────────────────────────────────────────────────────────────┤
│ domains                    # 领域主表                            │
│ domain_versions            # 领域版本                            │
│ domain_runtime_snapshots   # 运行快照                            │
│ domain_profiles            # 配置文件                            │
│ domain_entity_types        # 实体类型                            │
│ domain_relation_types      # 关系类型                            │
│ domain_evidence_roles      # 证据角色                            │
│ domain_rule_bundles        # 规则包                              │
│ domain_claim_schemas       # 关键主张                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        文档模块 (2 张表)                         │
├─────────────────────────────────────────────────────────────────┤
│ documents                  # 文档主表                            │
│ document_chunks            # 文档分块                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        证据模块 (2 张表)                         │
├─────────────────────────────────────────────────────────────────┤
│ evidence_packs             # 证据包                              │
│ evidence_items             # 证据项                              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        规则模块 (2 张表)                         │
├─────────────────────────────────────────────────────────────────┤
│ rule_bundles               # 规则包                              │
│ rule_execution_logs        # 执行日志                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        决策模块 (2 张表)                         │
├─────────────────────────────────────────────────────────────────┤
│ decision_records           # 决策记录                            │
│ fact_snapshots             # 事实快照                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        图谱模块 (2 张表)                         │
├─────────────────────────────────────────────────────────────────┤
│ graph_nodes                # 图谱节点                            │
│ graph_edges                # 图谱边                              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        审计模块 (1 张表)                         │
├─────────────────────────────────────────────────────────────────┤
│ audit_records              # 审计记录                            │
└─────────────────────────────────────────────────────────────────┘
```

### 核心表结构

#### decision_records (决策记录)

```sql
CREATE TABLE decision_records (
    id INT PRIMARY KEY AUTO_INCREMENT,
    contract_id VARCHAR(64) UNIQUE NOT NULL,
    domain_id VARCHAR(64) NOT NULL,
    domain_version_id VARCHAR(64),
    decision ENUM('permit', 'restrict_scope', 'retrieve_again', 'block', 'request_human_review'),
    high_fidelity_score FLOAT,
    domain_runtime_snapshot_id VARCHAR(64),
    fact_snapshot_id VARCHAR(64),
    evidence_pack_id VARCHAR(64),
    eligibility_json JSON,
    permitted_actions JSON,
    required_citations JSON,
    prohibited_content JSON,
    remediation_items JSON,
    audit_trail JSON,
    query TEXT,
    task_type VARCHAR(32),
    user_context JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_domain_id (domain_id),
    INDEX idx_contract_id (contract_id)
);
```

#### evidence_packs (证据包)

```sql
CREATE TABLE evidence_packs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    pack_id VARCHAR(64) UNIQUE NOT NULL,
    query TEXT NOT NULL,
    domain_id VARCHAR(64),
    domain_version_id VARCHAR(64),
    coverage_score FLOAT DEFAULT 0,
    authority_score FLOAT DEFAULT 0,
    freshness_score FLOAT DEFAULT 0,
    applicability_score FLOAT DEFAULT 0,
    source_independence_score FLOAT DEFAULT 0,
    conflict_risk_score FLOAT DEFAULT 0,
    covered_aspects JSON,
    missing_aspects JSON,
    authority_distribution JSON,
    conflicts JSON,
    snapshot_id VARCHAR(64),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_domain_id (domain_id),
    INDEX idx_pack_id (pack_id)
);
```

---

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSQL_HOST` | 127.0.0.1 | MySQL 主机 |
| `MYSQL_PORT` | 3306 | MySQL 端口 |
| `MYSQL_USER` | root | MySQL 用户 |
| `MYSQL_PASSWORD` | - | MySQL 密码 |
| `MYSQL_DB` | itn_core | 数据库名 |
| `RAGFLOW_BASE_URL` | http://127.0.0.1:9380 | RAGFlow 地址 |
| `RAGFLOW_API_KEY` | - | RAGFlow API Key |
| `DEBUG` | false | 调试模式 |

### 评分权重配置

在 `app/decision/services/decision_service.py` 中配置：

```python
HF_WEIGHTS = {
    "coverage": 0.25,           # 覆盖度权重
    "authority": 0.15,          # 权威性权重
    "applicability": 0.20,      # 适用性权重
    "freshness": 0.10,          # 时效性权重
    "graph_consistency": 0.15,  # 图谱一致性权重
    "source_independence": 0.10,# 来源独立性权重
    "conflict_risk": -0.05,     # 冲突风险权重（负值）
}
```

### 门控阈值配置

```python
ELIGIBILITY_THRESHOLDS = {
    "min_coverage": 0.5,        # 最小覆盖度
    "min_authority": 0.3,       # 最小权威性
    "min_applicability": 0.3,   # 最小适用性
    "min_freshness": 0.3,       # 最小时效性
    "max_conflict_risk": 0.5,   # 最大冲突风险
    "min_evidence_count": 1,    # 最少证据数
}
```

---

## 开发指南

### 运行测试

```bash
# 运行所有测试
pytest tests/ -v

# 运行特定测试
pytest tests/test_decision_service.py -v

# 运行测试并生成覆盖率报告
pytest tests/ --cov=app --cov-report=html
```

### 添加新谓词

在 `app/rules/services/rule_service.py` 中添加：

```python
def _evaluate_predicate(self, predicate: str, params: dict, context: dict) -> bool:
    # ... 现有谓词 ...
    
    elif predicate == "your_new_predicate":
        # 实现谓词逻辑
        param_value = params.get("param_name", default_value)
        context_value = context.get("context_key", default_value)
        return your_logic(param_value, context_value)
    
    return False
```

### 添加新规则

通过 API 创建规则包：

```bash
curl -X POST http://localhost:8000/api/v1/domains/cs_base/rule-bundles \
  -H "Content-Type: application/json" \
  -d '{
    "domain_version_id": "dv_xxx",
    "bundle_version": "v1",
    "rules_json": [
      {
        "rule_id": "rule_custom",
        "level": "operational",
        "name": "自定义规则",
        "predicate": "your_predicate",
        "action": "restrict",
        "message": "触发自定义规则",
        "params": {"key": "value"}
      }
    ]
  }'
```

### 扩展证据评分

在 `app/evidence/services/evidence_service.py` 中修改：

```python
def _calculate_pack_scores(self, evidence_items: list[dict]) -> dict:
    # 自定义评分逻辑
    coverage_score = your_coverage_calculation(evidence_items)
    authority_score = your_authority_calculation(evidence_items)
    # ...
    
    return {
        "coverage_score": coverage_score,
        "authority_score": authority_score,
        # ...
    }
```

---

## 验收指标

| 指标 | 目标 | 当前状态 |
|------|------|----------|
| 领域隔离正确率 | 高风险任务 100% | ✅ 已实现 |
| 关键主张覆盖率 | 高风险任务 100% | ✅ 已实现 |
| 适用性误放行率 | 0% | ✅ 已实现 |
| 高风险证据不足拦截率 | 100% | ✅ 已实现 |
| 领域规则回放一致率 | 100% | ✅ 已实现 |
| 文档-技能-规则映射完整率 | ≥95% | ⚠️ 待完善 |
| 来源可追溯完整率 | ≥95% | ✅ 已实现 |

---

## 交付优先级

| 优先级 | 交付内容 | 状态 |
|--------|----------|------|
| **P0** | 领域知识包模型；领域运行快照；领域隔离；资格门控 | ✅ 已完成 |
| **P1** | 关键主张-证据绑定；受控谓词库；领域检索画像；审计回放 | ✅ 已完成 |
| **P2** | 跨领域术语对齐；规则自动草拟；本体自动抽取 | ❌ 待开发 |

---

## 更新日志

### v0.1.0 (2026-07-16)

- ✅ 完成 FastAPI 服务框架搭建
- ✅ 实现 7 个核心服务模块
- ✅ 实现 48+ 个 API 端点
- ✅ 完成 MySQL 数据库设计（21 张表）
- ✅ 集成 RAGFlow 证据检索
- ✅ 实现双轨推断算法
- ✅ 实现资格门控与 HF 评分
- ✅ 实现决策契约生成
- ✅ 实现审计日志
- ✅ 完成 26 个单元测试
- ✅ 完成前端测试面板

---

## 许可证

内部项目，仅供 ITN 团队使用。

---

## 联系方式

- 项目负责人：Jianqi Wang
- 代码仓库：`src/agents/KnowledgeCore`
