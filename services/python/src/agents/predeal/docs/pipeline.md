# ITN 预处理管线文档

## 概述

ITN 预处理管线负责将 Markdown 文档转化为可检索的知识切片，完成图片处理、切片编译、分类标注，并上传至 RAGFlow 向量数据库。

```
原始 Markdown → 12 步处理 → MySQL + RAGFlow + 文件服务器
```

---

## 流程总览

| 步骤 | 名称 | 说明 |
|------|------|------|
| 1 | Intake | 读取文件，计算 hash，生成文档 ID |
| 2 | Raw Archive | 原始文件归档到本地 output 目录 |
| 2.5 | Create Document | 在 MySQL `knowledge_document` 建记录，上传原始文件到文件服务器 |
| 3 | Normalizer | 规范化 Markdown（标题层级、代码块、表格、链接等） |
| 4 | Image Pipeline | 下载远程图片 → 上传图片服务器 → VLM 生成描述 → 写入 `knowledge_figures` |
| 5 | Structure Parser | 解析文档结构树（heading 层级 + 偏移量） |
| 6 | Chunk Compilation | 按结构切片 → 图片归属（LLM）→ 输出最终切片 |
| 7 | Chunk DB Insert | 切片写入 `knowledge_chunk` |
| 8 | Category Classify | LLM 将每个切片分类到 1 个知识点 |
| 9 | RAGFlow Packager | 打包 ragflow_import_config.json |
| 10 | Preflight | 预检（切片数、图片数、内容完整性） |
| 11 | Audit | 生成处理审计报告，更新文档状态 |
| 12 | RAGFlow Upload | 逐条上传切片到 RAGFlow dataset |

---

## 各步骤详解

### Step 1: Intake

读取源文件，生成文档元数据。

- 计算文件 SHA256 hash
- 生成 `doc_xxxxxx` 格式的文档 ID（UUID 前 6 位）
- 从 domain config 读取 `authority_level`、`applicability_scope` 等元数据

**输入**: 原始 `.md` 文件路径
**输出**: `DocumentSource` 对象（内存）

---

### Step 2: Raw Archive

将原始文件归档到 output 目录。

```
output/{domain_id}/{version}/{doc_id}/raw/{原始文件名}.md
```

---

### Step 2.5: Create Document + Upload Raw

在 MySQL 创建 `knowledge_document` 记录（upsert），然后上传原始文件到文件服务器。

**MySQL 字段**:

| 字段 | 来源 | 示例值 |
|------|------|--------|
| `document_code` | `{domain_id}_{file_hash[:8]}` | `hello_agents_sha256:3` |
| `title` | 文件名去扩展名 | `第四章 智能体经典范式构建` |
| `document_type` | config `metadata_defaults` | `course_markdown` |
| `source_type` | config `metadata_defaults` | `web` |
| `source_name` | config `metadata_defaults` | `Hello Agents · Datawhale` |
| `publisher` | config `metadata_defaults` | `Datawhale` |
| `publish_year` | config `metadata_defaults` | `2025` |
| `version` | config `metadata_defaults` | `v1.0` |
| `language` | config `language` | `zh-CN` |
| `reliability_score` | config `metadata_defaults` | `0.90` |
| `status` | 初始值 | `processing` |

**文件服务器上传**:

```
POST http://113.249.110.108:28802/api/assets/files
目录: ITN/{domain_id}/{doc_id}/
文件: {原始文件名}.md
```

上传结果 `storage_key` 写入 `knowledge_document.storage_key`。

---

### Step 3: Normalizer

规范化 Markdown 文本：

- 统一标题层级（修正跳级标题）
- 规范代码块（确保围栏闭合）
- 统一表格格式
- 处理相对链接
- 提取图片引用列表（`image_refs`）

**输入**: 原始 Markdown 文本
**输出**: `NormalizationResult`（normalized_text + image_refs）

---

### Step 4: Image Pipeline

子管线处理所有图片，每个图片经历以下流程：

```
下载远程图片 → 检查图片信息 → 上传图片服务器 → VLM 生成描述 → 写入 MySQL
```

**图片服务器**:

```
POST http://113.249.110.108:28902/api/assets/images
目录: {storage_prefix}/ (如 ITN/hello_agents/chapter4/)
文件: {图片名}.png
```

**VLM 描述**（可选，由 `enable_vlm_summary` 控制）:

- 模型: GLM-4.6V-Flash（智谱 AI）
- API: `https://open.bigmodel.cn/api/paas/v4/chat/completions`
- 生成 100-300 字的图片描述

**MySQL `knowledge_figures` 字段**:

| 字段 | 说明 |
|------|------|
| `document_id` | 关联 knowledge_document.id |
| `occurrence_no` | 图片在文档中的序号 |
| `caption` | 图片标题（如 "图 4.1"） |
| `alt_text` | alt 文本 |
| `source_url` | 原始 URL |
| `storage_key` | 图片服务器存储路径 |
| `vlm_description` | VLM 生成的描述 |
| `file_size` | 文件大小（字节） |
| `width` / `height` | 图片尺寸 |

**重试策略**: 3 次重试，全部失败则抛出异常终止管线。

---

### Step 5: Structure Parser

解析文档结构树，生成 heading 层级和偏移量。

**输出**: `StructureTree`，包含 `StructureNode` 列表，每个节点记录：

- `heading`: 标题文本
- `level`: 标题层级（1-6）
- `section_path`: 从根到当前标题的路径
- `normalized_start_offset` / `normalized_end_offset`: 在规范化文本中的偏移量
- `source_start_offset` / `source_end_offset`: 在原始文本中的偏移量

---

### Step 6: Chunk Compilation（含图片归属）

这是管线的核心步骤，包含两个阶段：

#### 阶段 A: 切片编译

按结构树将文本切分为知识切片：

1. 遍历每个 `StructureNode`，提取对应文本
2. 按策略拆分超长切片（优先级：`####` 标题 > `##/###` 标题 > 中文编号 > 段落边界）
3. 合并过短的 heading-only 切片到后续切片
4. 重新编号

**拆分策略**（按优先级）:

| 优先级 | 策略 | 说明 |
|--------|------|------|
| 1 | `####` 标题 | 四级标题作为切分点 |
| 2 | `##/###` 标题 | 二三级标题作为切分点 |
| 3 | 中文编号 `（1）（2）` | 编号项作为切分点 |
| 4 | `方式/步骤/组件` | 操作类模式作为切分点 |
| 5 | `###` 标题（内容超长时） | 三级标题作为切分点 |
| 6 | 全行粗体 | `**标题**` 作为切分点 |
| 7 | 段落边界 | 双换行作为切分点 |
| 8 | 安全切分点 | 回退策略，按优先级选择安全位置 |

**约束**:

- 永远不在代码块内切分
- 字数统计排除 `<img>` 标签和图片说明文字
- `hard_max_chars`（默认 1800）为硬上限
- `target_min_chars`（默认 300）为合并阈值

#### 阶段 B: 图片归属（LLM）

编译完成后，如果 `knowledge_figures` 表有记录，调用 LLM 判断每个图片应归属到哪个切片：

1. 从 `knowledge_figures` 加载图片记录（id、caption、vlm_description）
2. 定位每个图片在哪个切片中（通过 `data-figure-id` 属性）
3. 构建上下文（当前切片 + 前一个 + 后一个）
4. 调用 LLM 判断归属（mimo-v2.5）
5. 移除所有 `<img>` 标签，然后插入到目标切片
6. 同步更新 `KnowledgeChunk` 对象的 `content`、`char_count`、`figure_ids`

**LLM Prompt**:

```
判断图片应归属到哪些切片：
- 当前切片（图片所在位置）
- 前一个切片
- 后一个切片

返回: {"target_indices": [0], "reasoning": "..."}
```

**边界情况**:

- 图片在切片末尾，可能属于下一个切片
- 图片被两个切片引用，复制到两个切片
- LLM 调用失败时，默认保留在当前切片

**输出**: 最终的 `KnowledgeChunk` 列表（含正确的 img 标签）+ `chunked_for_ragflow.md`

---

### Step 7: Chunk DB Insert

将最终切片写入 MySQL `knowledge_chunk` 表。

**字段**:

| 字段 | 说明 |
|------|------|
| `document_id` | 关联 knowledge_document.id |
| `chunk_code` | 切片编号（如 `chunk_000001`） |
| `chunk_index` | 切片序号 |
| `title_path` | 标题路径（如 `第四章 > 4.1 概述`） |
| `section_title` | 所属章节标题 |
| `content` | 切片内容（含 img 标签） |
| `token_count` | 近似 token 数 |
| `char_start` / `char_end` | 在原文中的偏移量 |

---

### Step 8: Category Classify（LLM）

将每个切片分类到 1 个知识点。

1. 从 `knowledge_domain` 查找 domain_db_id（通过 `domain_code`）
2. 加载 `knowledge_category` 目录树（114 个节点，3 层结构）
3. 逐个切片调用 LLM（mimo-v2.5）
4. 写入 `knowledge_chunk_category` 表

**LLM Prompt**:

```
根据切片内容，归类到最合适的知识点。
优先选择最具体的叶子节点（level 最大的）。
一个切片只归到 1 个最匹配的知识点。

返回: {"category_ids": [32], "confidence": 0.95, "reasoning": "..."}
```

**数据库写入**: `knowledge_chunk_category`（chunk_id, category_id, confidence, source）

---

### Step 9: RAGFlow Packager

打包 RAGFlow 导入配置：

```json
{
  "dataset_name": "hello_agents_v1",
  "document_id": "doc_xxxxx"
}
```

保存到 `output/.../ragflow_package/ragflow_import_config.json`。

---

### Step 10: Preflight Validation

预检验证：

- 切片数量 > 0
- 图片数量匹配
- 每个切片 content 非空
- 代码块闭合检查
- 字数分布检查

输出 `preflight_report.json`，状态为 `passed` 或 `passed_with_warnings`。

---

### Step 11: Audit

生成处理审计报告：

- 处理耗时
- 各步骤状态
- 错误列表
- 统计信息

更新 `knowledge_document.status` 为 preflight 结果（`passed` / `passed_with_warnings`）。

---

### Step 12: RAGFlow Upload

上传切片到 RAGFlow（可选，需 `--upload` 参数）：

1. 查找或创建 dataset（如 `hello_agents_v1`）
2. 删除同名旧文档
3. 上传 `chunked_for_ragflow.md` 作为占位文档
4. 逐条上传切片（通过 `add_chunk` API）
5. 更新 `knowledge_document.status` 为 `uploaded`

**RAGFlow API**:

```
POST http://113.249.110.108:9380/api/v1/datasets/{dataset_id}/documents/{document_id}/chunks
Authorization: Bearer {api_key}
```

---

## 数据存储

### MySQL 表

| 表名 | 说明 | 关键字段 |
|------|------|----------|
| `knowledge_document` | 文档记录 | document_code, title, document_type, status |
| `knowledge_chunk` | 知识切片 | document_id, chunk_code, content, char_count |
| `knowledge_chunk_category` | 切片-知识点关系 | chunk_id, category_id, confidence |
| `knowledge_figures` | 图片记录 | document_id, storage_key, vlm_description |
| `knowledge_domain` | 知识领域 | code, name |
| `knowledge_category` | 知识点目录树 | domain_id, parent_id, name, level |

### 文件服务器 (28802)

```
ITN/{domain_id}/{doc_id}/
├── {原始文件名}.md          # storage_key
├── normalized.md            # normalized_storage_key
└── chunked_for_ragflow.md   # ragflow_document_id
```

### 图片服务器 (28902)

```
{storage_prefix}/
├── 4-1.png
├── 4-2.png
├── 4-3.png
└── 4-4.png
```

### RAGFlow

```
Dataset: {domain_id}_{version} (如 hello_agents_v1)
Document: chunked_for_ragflow.md
Chunks: 逐条上传的切片内容
```

---

## 外部依赖

| 服务 | 地址 | 用途 |
|------|------|------|
| MySQL | `113.249.110.108:58391` | 文档/切片/图片/分类存储 |
| 文件服务器 | `113.249.110.108:28802` | 原始/规范化/切片文件存储 |
| 图片服务器 | `113.249.110.108:28902` | 图片文件存储 |
| VLM API | `api.zhipuai.cn` | 图片描述（GLM-4.6V-Flash） |
| LLM API | `token-plan-cn.xiaomimimo.com` | 图片归属 + 切片分类（mimo-v2.5） |
| RAGFlow | `113.249.110.108:9380` | 向量检索存储 |

---

## 配置文件

### Domain Config (`domains/{domain_id}.yaml`)

```yaml
domain_id: hello_agents
domain_code: agent                    # knowledge_domain.code
domain_version_id: v1
pipeline_profile: markdown_tutorial
language: zh-CN

discovery:
  root: ../../../../itn_source/hello_agents/docs
  include: ["chapter*/*.md"]
  exclude: ["_sidebar*.md", "README*.md"]

chunk_policy:
  target_min_chars: 300               # 合并阈值
  target_max_chars: 1200              # 目标上限
  hard_max_chars: 1800                # 硬上限
  preserve_code_block: true
  preserve_table: true
  preserve_figure: true

figure_policy:
  download_remote_images: true
  enable_vlm_summary: true            # 是否生成 VLM 描述
  keep_decorative_images: false
  storage_prefix: ""                  # 图片服务器目录前缀

metadata_defaults:
  document_type: course_markdown
  source_type: web
  source_name: "Hello Agents · Datawhale"
  publisher: Datawhale
  publish_year: 2025
  version: v1.0
  reliability_score: 0.90
  authority_level: official
```

---

## 使用方法

### 基本用法

```bash
# 处理单个文件（不上传 RAGFlow）
predeal process --domain hello_agents --file "第四章.md" --domains-dir domains

# 处理并上传 RAGFlow
predeal process --domain hello_agents --file "第四章.md" --domains-dir domains \
  --upload --ragflow-url http://113.249.110.108:9380 \
  --ragflow-key "ragflow-xxxxx" \
  --storage-prefix "ITN/hello_agents/chapter4"

# 处理整个 domain
predeal process --domain hello_agents --domains-dir domains --upload ...
```

### 调试用法

```bash
# 跑到某一步就停
predeal process --domain hello_agents --file xxx.md --until chunk_compiler

# 查看 domain 配置
predeal info hello_agents --domains-dir domains

# 列出所有 domain
predeal domains --domains-dir domains

# 单独处理图片
predeal figures --document-id 1 --source-path xxx.md --storage-prefix ITN/hello_agents/chapter4
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MYSQL_HOST` | MySQL 地址 | `113.249.110.108` |
| `MYSQL_PORT` | MySQL 端口 | `58391` |
| `MYSQL_USER` | MySQL 用户 | `root` |
| `MYSQL_PASSWORD` | MySQL 密码 | - |
| `MYSQL_DATABASE` | MySQL 数据库 | `itn-platform` |
| `ZAI_API_KEY` | 智谱 AI API Key | - |
| `VLM_MODEL` | VLM 模型名 | `glm-4.6v-flash` |
| `LLM_API_URL` | LLM API 地址 | `https://token-plan-cn.xiaomimimo.com/v1/chat/completions` |
| `LLM_API_KEY` | LLM API Key | - |
| `LLM_MODEL` | LLM 模型名 | `mimo-v2.5` |

---

## 性能参考

处理一个 41 切片、4 张图片的文档（含 VLM + RAGFlow 上传）：

| 阶段 | 耗时 | 说明 |
|------|------|------|
| 图片处理 | ~30s | 4 张图下载+上传+VLM |
| 切片编译 | ~1s | 纯本地处理 |
| 图片归属 | ~15s | 4 次 LLM 调用 |
| 切片分类 | ~8min | 41 次 LLM 调用 |
| RAGFlow 上传 | ~2min | 41 个切片逐条上传 |
| **总计** | **~11min** | |

主要耗时在 LLM 推理（mimo-v2.5 thinking 模式）。
