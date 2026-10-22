# ITN Knowledge Core 文档预处理至 RAGFlow 入库前工作流设计

版本：v0.1  
适用范围：从原始文档进入系统，到生成可交付给 RAGFlow 的入库文件与元数据包为止。  
不包含范围：RAGFlow 内部索引、检索、重排序、问答生成、Evidence Pack 构建、规则裁决、领域版本激活后的运行时决策。

---

## 1. 设计目标

本工作流负责将培训系统中的原始资料转换为结构稳定、边界明确、可追溯、可审计、可交付给 RAGFlow 的标准入库包。

目标是让系统在更换知识领域时，主要依赖领域配置、文档类型模板和自动评测，而不是依赖人工逐份文档修订。

工作流完成后，应输出以下内容：

```text
raw 原始文档归档
normalized 规范化文档
structure 结构树
figure_manifest 图片资产清单
chunk_manifest chunk 元数据清单
chunked_for_ragflow RAGFlow 入库专用文档
processing_audit 处理审计记录
preflight_report 入库前质量检查报告
```

该模块的边界是：

```text
输入：原始文档 + 领域配置 + 文档来源元数据
输出：可传给 RAGFlow 的入库文件 + 完整元数据映射
```

---

## 2. 总体原则

### 2.1 原始文档不可变

原始文件必须完整保存。任何规范化、图片抽取、AI 辅助结构识别、分隔符插入、chunk 编译结果，都应作为派生工件保存。

```text
raw_document ≠ normalized_document ≠ chunked_for_ragflow_document
```

系统不得覆盖原始文件。

### 2.2 证据内容与辅助内容分离

原文内容、图片资产、AI 生成的结构建议、AI 生成的图片说明、AI 生成的检索提示，应分别保存并标明来源。

AI 生成内容只能作为：

```text
结构建议
虚拟标题
检索辅助字段
图片摘要
技能标签候选
评测问题候选
```

不能替代原文证据。

### 2.3 分块边界由 ITN 预处理层控制

RAGFlow 接收的文档应已经包含明确的 chunk 边界。RAGFlow 只负责后续索引和检索，不负责最终知识治理。

推荐使用统一分隔符：

```text
<<<ITN_CHUNK_BOUNDARY>>>
```

### 2.4 图片是一等知识资产

培训材料中的架构图、流程图、截图、表格图、公式图都应作为独立资产治理。

图片不应被简单删除，也不应以混乱 HTML 形式直接污染文本 chunk。图片应被抽取、归档、编号、绑定到对应 chunk，并通过 caption、alt、OCR、VLM 摘要等方式参与检索增强。

### 2.5 元数据完整性优先

每个 chunk、figure、normalized document、processing job 都必须绑定：

```text
domain_id
domain_version_id
document_id
source_file_hash
processing_version
```

---

## 3. 工作流总览

```text
1. 文档接收 Document Intake
2. 原文归档 Raw Archive
3. 文档类型识别 Document Classification
4. 基础规范化 Normalization
5. 图片资产抽取 Figure Asset Processing
6. 结构解析 Structure Parsing
7. 超长结构单元粗切 Deterministic Section Splitting
8. AI 辅助边界规划 AI-Assisted Boundary Planning
9. Chunk 编译 Chunk Compilation
10. RAGFlow 入库文档生成 RAGFlow Document Packaging
11. 入库前质量检查 Preflight Validation
12. 处理审计记录 Processing Audit
```

输出目录建议：

```text
processed_documents/
└── {domain_id}/
    └── {domain_version_id}/
        └── {document_id}/
            ├── raw/
            │   └── source_file.ext
            ├── normalized/
            │   └── normalized.md
            ├── assets/
            │   ├── figures/
            │   │   ├── fig_0001.png
            │   │   └── fig_0002.png
            │   └── attachments/
            ├── structure/
            │   └── structure_tree.json
            ├── chunks/
            │   ├── chunked_for_ragflow.md
            │   └── chunk_manifest.json
            ├── figures/
            │   └── figure_manifest.json
            ├── ai/
            │   ├── boundary_plan.json
            │   └── ai_processing_log.json
            ├── validation/
            │   └── preflight_report.json
            └── audit/
                └── processing_audit.json
```

---

## 4. 输入与输出

### 4.1 输入

#### 4.1.1 原始文档

MVP 优先支持：

```text
Markdown
HTML 片段型 Markdown
本地图片引用
远程图片引用
```

后续扩展：

```text
PDF
DOCX
PPTX
HTML
代码仓库
图片型扫描件
```

#### 4.1.2 领域配置

示例：

```json
{
  "domain_id": "hello_agents",
  "domain_version_id": "v1",
  "pipeline_profile": "markdown_tutorial",
  "language": "zh-CN",
  "chunk_policy": {
    "target_min_chars": 300,
    "target_max_chars": 1200,
    "hard_max_chars": 1800,
    "preserve_code_block": true,
    "preserve_table": true,
    "preserve_figure": true
  },
  "figure_policy": {
    "download_remote_images": true,
    "enable_ocr": true,
    "enable_vlm_summary": false,
    "keep_decorative_images": false
  }
}
```

#### 4.1.3 文档来源元数据

```json
{
  "source_uri": "https://example.com/source.md",
  "authority_level": "official",
  "license_info": "unknown",
  "applicability_scope": {
    "course": "HelloAgents",
    "chapter": "8"
  }
}
```

### 4.2 输出

#### 4.2.1 `chunked_for_ragflow.md`

这是交给 RAGFlow 的主文件。它应包含统一分隔符。

示例：

```md
<<<ITN_CHUNK_BOUNDARY>>>

# 第八章 记忆与检索
## 8.1 从认知科学到智能体记忆
### 8.1.1 人类记忆系统的启发

在构建智能体的记忆系统之前……

[FIGURE: fig_0001]
图 8.1 人类记忆系统的层次结构
Alt: 人类记忆系统结构图
```

#### 4.2.2 `chunk_manifest.json`

保存 chunk 与原始文档、结构树、图片资产的映射关系。

#### 4.2.3 `figure_manifest.json`

保存图片资产、caption、alt、来源、hash、绑定 chunk、OCR/VLM 结果。

#### 4.2.4 `processing_audit.json`

保存本次处理任务的版本、参数、AI 调用记录、异常与校验结果。

---

## 5. 模块设计

### 5.1 Document Intake

#### 要做什么

接收上传文档和文档元数据，创建 `document_id`，初始化处理任务。

#### 输入

```text
file
domain_id
domain_version_id
source_metadata
pipeline_profile
```

#### 输出

```text
document_id
ingestion_job_id
raw_file_location
```

#### 处理要求

1. 校验文件大小、格式、后缀、MIME type。
2. 计算文件 hash。
3. 创建文档处理任务。
4. 绑定领域与领域版本。
5. 保存上传者、上传时间、来源信息。

#### 数据字段

```json
{
  "document_id": "doc_000001",
  "domain_id": "hello_agents",
  "domain_version_id": "v1",
  "source_file_name": "第八章 记忆与检索.md",
  "mime_type": "text/markdown",
  "file_hash": "sha256:...",
  "file_size": 123456,
  "pipeline_profile": "markdown_tutorial"
}
```

---

### 5.2 Raw Archive

#### 要做什么

保存原始文件，不做覆盖式修改。

#### 输出

```text
raw/source_file.ext
raw_document_record
```

#### 处理要求

1. 原文保存到对象存储或文件系统归档区。
2. 文件路径与 hash 写入元数据库。
3. 后续所有派生工件必须引用原始文件 hash。
4. 同一文件 hash 重复上传时允许复用 raw asset，但应创建新的领域版本绑定记录。

---

### 5.3 Document Classification

#### 要做什么

识别文档类型，并选择处理模板。

#### MVP 支持类型

```text
markdown_tutorial
markdown_reference
unknown_text
```

#### 后续支持类型

```text
pdf_textbook
html_article
ppt_courseware
docx_manual
code_repository
scanned_document
```

#### 判断特征

Markdown 教程类文档通常包含：

```text
# / ## / ### 标题
代码块
图示
教程步骤
示例代码
习题
参考文献
```

#### 输出

```json
{
  "document_type": "markdown_tutorial",
  "confidence": 0.94,
  "selected_pipeline": "markdown_tutorial_v1"
}
```

---

### 5.4 Normalization

#### 要做什么

生成统一的 `normalized.md`。该文件用于后续结构解析、图片抽取和 chunk 编译。

#### Markdown 规范化要求

1. 保留 Markdown 标题层级。
2. 保留代码块完整性。
3. 保留表格完整性。
4. 保留列表结构。
5. 将简单 HTML 标签转换为 Markdown 或受控文本。
6. 将图片 HTML 块转换为 FigureNode 占位结构。
7. 清理多余空行。
8. 生成 source offset 映射。
9. 保留原始文本 hash。

#### HTML 标签处理

可转换：

```html
<strong>文本</strong> → **文本**
<em>文本</em> → *文本*
<sup>[1]</sup> → ^[1]
```

应结构化处理：

```html
<div><img .../><p>图注</p></div>
```

不应直接丢弃。

#### 输出

```text
normalized/normalized.md
normalized/source_map.json
```

#### source_map 示例

```json
{
  "normalized_start": 1024,
  "normalized_end": 1180,
  "source_start": 980,
  "source_end": 1160,
  "transform": "html_strong_to_markdown"
}
```

---

### 5.5 Figure Asset Processing

#### 要做什么

识别、抽取、保存、描述和绑定文档中的图片资产。

#### 支持的图片形式

```md
![alt](./images/a.png)
```

```html
<img src="..." alt="..." width="85%"/>
```

```html
<div align="center">
  <img src="..." alt="..." width="85%"/>
  <p>图 8.1 xxx</p>
</div>
```

后续扩展：

```text
PDF 内嵌图片
PPT 页面截图
DOCX media/image*.png
base64 image
扫描页
公式截图
表格截图
```

#### 处理步骤

```text
1. 扫描文档中的图片引用
2. 解析 src、alt、caption、width、height
3. 为每张图片生成 figure_id
4. 下载远程图片或复制本地图片
5. 计算 asset_hash
6. 保存到 assets/figures/
7. 在 normalized.md 中替换为 [FIGURE: figure_id]
8. 生成 figure_manifest.json
9. 将图片绑定到最近的标题路径
10. 可选执行 OCR / VLM 摘要
```

#### 图片占位符格式

```md
[FIGURE: fig_0001]
Caption: 图 8.1 人类记忆系统的层次结构
Alt: 人类记忆系统结构图
```

#### figure_manifest 示例

```json
{
  "figure_id": "fig_0001",
  "domain_id": "hello_agents",
  "domain_version_id": "v1",
  "document_id": "doc_000001",
  "caption": "图 8.1 人类记忆系统的层次结构",
  "alt_text": "人类记忆系统结构图",
  "original_src": "https://raw.githubusercontent.com/datawhalechina/Hello-Agents/main/docs/images/8-figures/8-1.png",
  "asset_uri": "object://itn-assets/hello_agents/v1/doc_000001/fig_0001.png",
  "asset_hash": "sha256:...",
  "source_start_offset": 1200,
  "source_end_offset": 1420,
  "section_path": [
    "第八章 记忆与检索",
    "8.1 从认知科学到智能体记忆",
    "8.1.1 人类记忆系统的启发"
  ],
  "linked_chunk_ids": [],
  "ocr_text": null,
  "vlm_summary": null,
  "asset_status": "available",
  "importance": "content"
}
```

#### 图片重要性分类

| 类型 | 说明 | 默认处理 |
|---|---|---|
| content | 架构图、流程图、知识图、截图 | 保留、绑定、可摘要 |
| table_image | 表格截图 | OCR / 表格抽取 |
| formula_image | 公式图 | 保留，尝试转文本 |
| decorative | logo、背景图、装饰图 | 保留元数据，可不参与检索 |
| unavailable | 无法下载或损坏 | 保留原 URL 和错误状态 |

#### OCR / VLM 输出要求

OCR 和 VLM 结果必须标明为派生辅助内容。

```json
{
  "figure_id": "fig_0002",
  "ocr_text": "MemoryManager ...",
  "vlm_summary": "该图展示 HelloAgents 记忆与 RAG 系统的整体架构，包括 memory_tool、rag_tool、存储层与嵌入层。",
  "ai_generated": true,
  "ai_model": "model_name",
  "ai_prompt_hash": "sha256:..."
}
```

---

### 5.6 Structure Parsing

#### 要做什么

将 `normalized.md` 解析为结构树。

#### 节点类型

```text
document
chapter
section
subsection
paragraph
list
table
code_block
figure
blockquote
exercise
reference
```

#### 节点字段

```json
{
  "node_id": "node_000123",
  "node_type": "section",
  "heading": "8.1.3 记忆与RAG系统架构设计",
  "level": 3,
  "parent_id": "node_000100",
  "section_path": [
    "第八章 记忆与检索",
    "8.1 从认知科学到智能体记忆",
    "8.1.3 记忆与RAG系统架构设计"
  ],
  "source_start_offset": 8000,
  "source_end_offset": 12000,
  "normalized_start_offset": 7900,
  "normalized_end_offset": 11850,
  "contains_code": true,
  "contains_table": false,
  "contains_figure": true,
  "figure_ids": ["fig_0002"],
  "text_hash": "sha256:..."
}
```

#### 解析要求

1. 标题节点维护层级栈。
2. 代码块节点不可被拆断。
3. 表格节点不可被拆断。
4. 图片节点作为 FigureNode 插入结构树。
5. 每个内容节点继承最近的 section_path。
6. 习题、参考文献等特殊区域应识别为独立结构类型。

---

### 5.7 Deterministic Section Splitting

#### 要做什么

在调用 AI 之前，先用确定性规则将超长文档切成可处理的结构单元。

#### 触发条件

```text
section char_count > hard_max_chars
section token_count > ai_window_safe_limit
section contains multiple operation blocks
section contains multiple code examples
```

#### 切分优先级

```text
1. Markdown 四级标题 ####
2. 中文编号：（1）（2）（3）
3. 操作1 / 操作2 / 操作3
4. 步骤1 / 步骤2 / 步骤3
5. 图示边界 [FIGURE: ...]
6. 代码块前后解释
7. 列表组
8. 段落边界
```

#### 输出

```json
{
  "section_id": "node_000200",
  "sub_units": [
    {
      "unit_id": "unit_0001",
      "start_offset": 1000,
      "end_offset": 2200,
      "reason": "operation_heading"
    }
  ]
}
```

---

### 5.8 AI-Assisted Boundary Planning

#### 要做什么

对结构不够细、长度过长或语义混杂的 section，调用 AI 生成边界规划。

AI 输出的是规划，不直接产生最终 chunk。

#### 输入

```json
{
  "section_id": "node_000200",
  "section_path": ["...", "8.2.3 MemoryTool详解"],
  "text": "section text within safe token limit",
  "figures": [
    {
      "figure_id": "fig_0005",
      "caption": "图 ...",
      "alt_text": "..."
    }
  ],
  "constraints": {
    "do_not_rewrite": true,
    "do_not_cross_heading": true,
    "preserve_code_blocks": true,
    "preserve_tables": true,
    "preserve_figures": true
  }
}
```

#### AI 输出

```json
{
  "section_id": "node_000200",
  "recommended_boundaries": [
    {
      "virtual_heading": "add 操作",
      "start_anchor": "（1）操作1：add",
      "end_anchor": "（2）操作2：search",
      "reason": "operation_block"
    },
    {
      "virtual_heading": "search 操作",
      "start_anchor": "（2）操作2：search",
      "end_anchor": "（3）操作3：forget",
      "reason": "operation_block"
    }
  ],
  "skill_tags": ["memory_tool", "agent_memory"],
  "warnings": []
}
```

#### 校验要求

程序必须验证 AI 输出：

```text
start_anchor 存在
end_anchor 存在
边界不交叉
边界不跨标题
不切断代码块
不切断表格
不切断 FigureNode
chunk 长度在合理范围内
```

校验失败时：

```text
使用确定性规则兜底
标记 ai_boundary_invalid
进入人工复核队列
```

---

### 5.9 Chunk Compilation

#### 要做什么

根据结构树、确定性切分结果、AI 边界规划和图片绑定关系，生成最终 chunk。

#### 编译硬规则

```text
1. 不允许跨 # / ## / ### 标题合并。
2. 不允许标题挂到上一个 chunk 末尾。
3. 不允许切断代码块。
4. 不允许切断表格。
5. 不允许切断 FigureNode。
6. 不允许删除原文内容。
7. 不允许 AI 改写正文后作为证据。
8. 每个 chunk 必须有 section_path。
9. 每个 chunk 必须有 source offset。
10. 每个 chunk 必须绑定 domain_id / domain_version_id。
```

#### chunk 类型

```text
concept_explanation
architecture_description
operation_instruction
code_example
configuration_example
workflow_description
exercise
reference
figure_explanation
mixed
```

#### chunk_manifest 示例

```json
{
  "chunk_id": "chunk_000001",
  "domain_id": "hello_agents",
  "domain_version_id": "v1",
  "document_id": "doc_000001",
  "source_file_hash": "sha256:...",
  "section_path": [
    "第八章 记忆与检索",
    "8.1 从认知科学到智能体记忆",
    "8.1.3 记忆与RAG系统架构设计"
  ],
  "heading": "8.1.3 记忆与RAG系统架构设计",
  "virtual_heading": null,
  "chunk_type": "architecture_description",
  "chunk_order": 3,
  "content_hash": "sha256:...",
  "source_start_offset": 8000,
  "source_end_offset": 10200,
  "normalized_start_offset": 7900,
  "normalized_end_offset": 10050,
  "char_count": 980,
  "approx_token_count": 760,
  "contains_code": true,
  "contains_table": false,
  "contains_figure": true,
  "figure_ids": ["fig_0002"],
  "evidence_role": "concept_explanation",
  "skill_tags": ["rag_architecture", "memory_system"],
  "ai_assisted": false,
  "metadata": {
    "authority_level": "official",
    "applicability_scope": {
      "course": "HelloAgents",
      "chapter": "8"
    }
  }
}
```

#### RAGFlow 文档中的 chunk 形式

```md
<<<ITN_CHUNK_BOUNDARY>>>

# 第八章 记忆与检索
## 8.1 从认知科学到智能体记忆
### 8.1.3 记忆与RAG系统架构设计

基于第七章建立的框架基础和认知科学的启发……

[FIGURE: fig_0002]
图 8.2 HelloAgents记忆与RAG系统整体架构
Alt: HelloAgents记忆与RAG系统架构图
```

---

### 5.10 RAGFlow Document Packaging

#### 要做什么

生成传给 RAGFlow 的文件包。

#### 输出包

```text
ragflow_package/
├── chunked_for_ragflow.md
├── chunk_manifest.json
├── figure_manifest.json
└── ragflow_import_config.json
```

#### RAGFlow 分隔符配置

推荐使用固定分隔符：

```text
<<<ITN_CHUNK_BOUNDARY>>>
```

RAGFlow 的分块器配置应保持简单，避免同时使用复杂标题分块和 token 分块。

#### `ragflow_import_config.json` 示例

```json
{
  "dataset_name": "hello_agents_v1",
  "document_id": "doc_000001",
  "file": "chunked_for_ragflow.md",
  "splitter": {
    "type": "delimiter",
    "delimiter": "<<<ITN_CHUNK_BOUNDARY>>>"
  },
  "metadata_mapping": {
    "external_manifest": "chunk_manifest.json",
    "chunk_id_strategy": "content_hash_and_order"
  }
}
```

#### chunk_id 回填策略

优先级：

```text
1. RAGFlow 支持 metadata：直接写入 chunk_id
2. RAGFlow 不支持 metadata：通过 chunk_order + content_hash 回填
3. 回填失败：进入 preflight_error
```

---

### 5.11 Preflight Validation

#### 要做什么

在传给 RAGFlow 前，检查所有必要条件。

#### 检查项

```text
raw 文件存在
normalized.md 存在
chunked_for_ragflow.md 存在
chunk_manifest.json 存在
figure_manifest.json 存在
所有 chunk 有 domain_id
所有 chunk 有 domain_version_id
所有 chunk 有 document_id
所有 chunk 有 source offset
所有 chunk 有 content_hash
无跨三级标题 chunk
无代码块破坏
无表格破坏
无 FigureNode 破坏
所有 figure_id 可解析
所有 content figure 引用可在 figure_manifest 中找到
远程图片下载失败时有 asset_status
AI 辅助输出有审计记录
```

#### 报告示例

```json
{
  "status": "passed",
  "document_id": "doc_000001",
  "chunk_count": 42,
  "figure_count": 11,
  "errors": [],
  "warnings": [
    {
      "type": "asset_unavailable",
      "figure_id": "fig_0009",
      "message": "remote image download failed; original_src retained"
    }
  ]
}
```

---

### 5.12 Processing Audit

#### 要做什么

记录本次处理全过程。

#### 审计字段

```json
{
  "ingestion_job_id": "job_000001",
  "domain_id": "hello_agents",
  "domain_version_id": "v1",
  "document_id": "doc_000001",
  "source_file_hash": "sha256:...",
  "pipeline_profile": "markdown_tutorial_v1",
  "normalizer_version": "normalizer_0.1.0",
  "figure_processor_version": "figure_processor_0.1.0",
  "structure_parser_version": "structure_parser_0.1.0",
  "chunk_compiler_version": "chunk_compiler_0.1.0",
  "ai_assistant_enabled": true,
  "ai_calls": [
    {
      "task": "boundary_planning",
      "section_id": "node_000200",
      "model": "model_name",
      "prompt_hash": "sha256:...",
      "input_hash": "sha256:...",
      "output_hash": "sha256:...",
      "status": "validated"
    }
  ],
  "created_at": "2026-07-09T00:00:00+08:00",
  "finished_at": "2026-07-09T00:01:30+08:00",
  "status": "completed"
}
```

---

## 6. 超长文档处理策略

超长文档不得一次性提交给 AI。

应使用：

```text
确定性粗切 → 局部 AI 辅助 → 程序校验 → 递归切分
```

### 6.1 粗切规则

Markdown：

```text
按 # / ## / ### 切分
代码块不切
表格不切
图片节点不切
```

PDF：

```text
按目录、页码、标题候选切分
保留页码映射
图片先抽取为 FigureNode
```

PPT：

```text
按页切分
每页标题、要点、备注、图片分别抽取
```

### 6.2 AI 窗口控制

每次 AI 输入应控制在安全窗口内。

```text
max_input_tokens_per_ai_call = model_context_window * 0.45
reserve_output_tokens = model_context_window * 0.15
```

当 section 超过限制时，继续按段落组、列表组、代码块组递归拆分。

### 6.3 AI 输出格式

AI 应输出 JSON，不输出改写正文。

```json
{
  "recommended_boundaries": [],
  "virtual_headings": [],
  "warnings": []
}
```

---

## 7. 图片处理策略

### 7.1 图片与 chunk 的关系

图片应绑定到最近的有效标题路径，并最终绑定到一个或多个 chunk。

```text
FigureNode → section_path → chunk_id
```

### 7.2 图片文本化内容

进入 RAGFlow 文本的内容包括：

```text
figure_id
caption
alt_text
可选 OCR 文本摘要
可选 VLM 简短摘要
```

不进入 RAGFlow 文本的内容：

```text
图片二进制
冗长 base64
复杂 HTML 属性
下载失败堆栈
```

### 7.3 图片返回策略

RAGFlow 检索命中文本 chunk 后，ITN 通过 `chunk_manifest.figure_ids` 查找 `figure_manifest`，在上层应用中返回相关图片。

---

## 8. 数据模型

### 8.1 DocumentSource

```python
class DocumentSource(BaseModel):
    document_id: str
    domain_id: str
    domain_version_id: str
    source_file_name: str
    source_uri: str | None = None
    mime_type: str
    file_hash: str
    file_size: int
    pipeline_profile: str
    authority_level: str | None = None
    applicability_scope: dict = {}
    created_at: datetime
```

### 8.2 FigureAsset

```python
class FigureAsset(BaseModel):
    figure_id: str
    document_id: str
    domain_id: str
    domain_version_id: str
    caption: str | None = None
    alt_text: str | None = None
    original_src: str | None = None
    asset_uri: str | None = None
    asset_hash: str | None = None
    source_start_offset: int | None = None
    source_end_offset: int | None = None
    section_path: list[str] = []
    linked_chunk_ids: list[str] = []
    ocr_text: str | None = None
    vlm_summary: str | None = None
    asset_status: str
    metadata: dict = {}
```

### 8.3 StructureNode

```python
class StructureNode(BaseModel):
    node_id: str
    document_id: str
    parent_id: str | None = None
    node_type: str
    heading: str | None = None
    level: int | None = None
    section_path: list[str] = []
    source_start_offset: int
    source_end_offset: int
    normalized_start_offset: int
    normalized_end_offset: int
    contains_code: bool = False
    contains_table: bool = False
    contains_figure: bool = False
    figure_ids: list[str] = []
    text_hash: str
    metadata: dict = {}
```

### 8.4 KnowledgeChunk

```python
class KnowledgeChunk(BaseModel):
    chunk_id: str
    document_id: str
    domain_id: str
    domain_version_id: str
    source_file_hash: str
    section_path: list[str]
    heading: str | None = None
    virtual_heading: str | None = None
    content: str
    content_hash: str
    chunk_type: str
    chunk_order: int
    source_start_offset: int
    source_end_offset: int
    normalized_start_offset: int
    normalized_end_offset: int
    char_count: int
    approx_token_count: int
    contains_code: bool = False
    contains_table: bool = False
    contains_figure: bool = False
    figure_ids: list[str] = []
    evidence_role: str | None = None
    skill_tags: list[str] = []
    ai_assisted: bool = False
    metadata: dict = {}
```

---

## 9. API 设计

### 9.1 上传文档

```http
POST /api/v1/domains/{domain_id}/versions/{version_id}/documents
```

### 9.2 创建预处理任务

```http
POST /api/v1/preprocessing/jobs
```

请求：

```json
{
  "domain_id": "hello_agents",
  "domain_version_id": "v1",
  "document_ids": ["doc_000001"],
  "pipeline_profile": "markdown_tutorial",
  "options": {
    "enable_ai_boundary_planning": true,
    "enable_ocr": true,
    "enable_vlm_summary": false
  }
}
```

### 9.3 查询任务状态

```http
GET /api/v1/preprocessing/jobs/{job_id}
```

### 9.4 获取 RAGFlow 入库包

```http
GET /api/v1/preprocessing/jobs/{job_id}/ragflow-package
```

### 9.5 获取 chunk 清单

```http
GET /api/v1/documents/{document_id}/chunks
```

### 9.6 获取图片清单

```http
GET /api/v1/documents/{document_id}/figures
```

---

## 10. 目录结构建议

```text
src/agents/KnowledgeCore/
├── preprocessing/
│   ├── intake.py
│   ├── raw_archive.py
│   ├── document_classifier.py
│   ├── normalizer.py
│   ├── markdown_normalizer.py
│   ├── figure_processor.py
│   ├── structure_parser.py
│   ├── deterministic_splitter.py
│   ├── ai_boundary_planner.py
│   ├── chunk_compiler.py
│   ├── ragflow_packager.py
│   ├── preflight_validator.py
│   └── audit_logger.py
├── models/
│   ├── document.py
│   ├── figure.py
│   ├── structure_node.py
│   ├── chunk.py
│   ├── preprocessing_job.py
│   └── audit.py
├── storage/
│   ├── object_store.py
│   ├── document_repo.py
│   ├── figure_repo.py
│   ├── chunk_repo.py
│   └── audit_repo.py
└── integrations/
    └── ragflow_package_schema.py
```

---

## 11. 验收标准

### 11.1 文档处理验收

| 指标 | 目标 |
|---|---:|
| 原始文件归档成功率 | 100% |
| chunk 绑定 domain_id 比例 | 100% |
| chunk 绑定 domain_version_id 比例 | 100% |
| chunk 绑定 source offset 比例 | 100% |
| chunk content_hash 完整率 | 100% |
| 三级标题跨节混合率 | 0% |
| 标题挂载错误率 | 0% |
| 代码块破坏率 | 0% |
| 表格破坏率 | 0% |
| FigureNode 破坏率 | 0% |
| figure_manifest 引用完整率 | 100% |
| RAGFlow 入库包生成成功率 | ≥ 99% |

### 11.2 图片处理验收

| 指标 | 目标 |
|---|---:|
| Markdown 图片识别率 | ≥ 99% |
| HTML img 图片识别率 | ≥ 99% |
| caption 抽取成功率 | ≥ 95% |
| alt 抽取成功率 | 有则 100% |
| 图片 asset_hash 完整率 | 可访问图片 100% |
| 图片与 section_path 绑定率 | ≥ 99% |
| 图片与 chunk 绑定率 | ≥ 99% |
| 下载失败图片原始 URL 保留率 | 100% |

### 11.3 AI 辅助验收

| 指标 | 目标 |
|---|---:|
| AI 输出 JSON 可解析率 | ≥ 99% |
| AI 边界规划程序校验率 | 100% |
| AI 直接改写正文进入证据 | 0% |
| AI 调用审计完整率 | 100% |

---

## 12. MVP 里程碑

### M1：Raw Archive + Document Intake

完成：

```text
文档上传
原文归档
hash 计算
领域版本绑定
任务记录
```

### M2：Markdown Normalizer + Figure Processor

完成：

```text
Markdown 规范化
HTML img / div figure 识别
图片下载或引用保存
FigureNode 占位符
figure_manifest
```

### M3：Structure Parser

完成：

```text
标题树解析
代码块识别
表格识别
FigureNode 接入结构树
source offset 映射
```

### M4：Chunk Compiler

完成：

```text
统一分隔符 chunk 文档
chunk_manifest
标题边界硬约束
图片与 chunk 绑定
```

### M5：AI Boundary Planner

完成：

```text
长 section 局部 AI 边界建议
anchor 校验
规则兜底
AI 审计记录
```

### M6：RAGFlow Packaging + Preflight Validation

完成：

```text
ragflow_package
ragflow_import_config
preflight_report
可交付 RAGFlow
```

---

## 13. 最终交付物

每个成功处理的文档至少交付：

```text
1. raw/source_file.ext
2. normalized/normalized.md
3. assets/figures/*
4. structure/structure_tree.json
5. figures/figure_manifest.json
6. chunks/chunked_for_ragflow.md
7. chunks/chunk_manifest.json
8. ragflow_package/ragflow_import_config.json
9. validation/preflight_report.json
10. audit/processing_audit.json
```

---

## 14. 一句话设计定位

本工作流将培训资料编译为可被 RAGFlow 稳定索引的标准知识输入包，并在进入 RAGFlow 之前完成原文归档、结构规范化、图片资产治理、AI 辅助边界规划、chunk 编译、元数据绑定和质量检查。
