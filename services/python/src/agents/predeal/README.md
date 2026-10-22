# ITN Knowledge Core 预处理管线

将培训资料编译为可被 RAGFlow 稳定索引的标准知识输入包，并上传到 RAGFlow。

## 快速开始

```bash
# 安装依赖
cd src/agents/predeal
pip install -e .

# 配置环境变量（必须）
cp ../.env.example ../.env
# 编辑 .env 填入实际的 API Key 和数据库密码

# 查看所有领域
predeal domains

# 处理整个领域（自动上传到 RAGFlow；v2 管线）
predeal2 process --domain hello_agents

# 处理单个文件
predeal2 process --domain hello_agents --file "第八章"

# 单文档增量上传（推荐，幂等）
predeal2 upload path/to/doc.md --domain hello_agents
```

> `predeal`（`predeal.cli:cli`）的 `process` 命令为 v1 管线入口，已在 T5.3
> 唯一事实源收敛中下线（调用会直接报错并提示改用 `predeal2`）；v1 代码只读留档于
> `legacy/pipeline.py`。`domains` / `figures` / `info` 子命令不受影响，仍可通过
> `predeal` 使用。

## 环境配置

所有配置通过 `agents/.env` 文件管理（KnowledgeCore 和 predeal 共用）：

```bash
# 复制模板
cp agents/.env.example agents/.env
```

必需配置项：

| 变量 | 说明 |
|---|---|
| `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` | MySQL 数据库连接 |
| `RAGFLOW_URL` | RAGFlow 服务器地址 |
| `RAGFLOW_API_KEY` | RAGFlow API Key |
| `ZAI_API_KEY` | 智谱 AI API Key（VLM 图片描述） |

## 领域配置

在 `domains/` 目录下创建 YAML 文件即可添加新领域：

```yaml
# domains/your_domain.yaml
domain_id: your_domain
domain_version_id: v1
pipeline_profile: markdown_tutorial
language: zh-CN

discovery:
  root: ../../path/to/your/docs
  include:
    - "**/*.md"
  exclude:
    - "README.md"

chunk_policy:
  target_min_chars: 300
  target_max_chars: 1200
  hard_max_chars: 1800
  preserve_code_block: true
  preserve_table: true
  preserve_figure: true

figure_policy:
  download_remote_images: true
  enable_vlm_summary: true

metadata_defaults:
  authority_level: official
```

## 输出结构

```
output/
└── {domain_id}/
    └── {domain_version_id}/
        └── {document_id}/
            ├── raw/                     # 原始文件归档
            ├── normalized/              # 规范化文档 + source_map
            ├── assets/figures/          # 图片资产
            ├── structure/               # 结构树
            ├── chunks/                  # chunk 分隔文档 + manifest
            ├── figures/                 # 图片清单
            ├── ragflow_package/         # RAGFlow 导入配置
            ├── validation/              # 入库前质量检查
            └── audit/                   # 处理审计记录
```

## CLI 参考

```bash
predeal2 process [OPTIONS]     # v2 管线，替代已下线的 `predeal process`
  --domain TEXT        领域 ID [必填]
  --file TEXT          文件名过滤
  --until TEXT         调试：运行到指定步骤后停止
  --enable-ai          启用 AI 边界规划
  --output TEXT        输出目录 (默认: output)
  --domains-dir TEXT   领域配置目录
  --ragflow-url TEXT   RAGFlow 服务器 URL（默认从 .env 读取）
  --ragflow-key TEXT   RAGFlow API Key（默认从 .env 读取）
  --dataset-name TEXT  覆盖 RAGFlow 数据集名称
  --force              内容未变也强制重跑所有步骤

predeal2 upload FILE_PATH --domain TEXT [OPTIONS]   # 单文档增量上传，推荐入口
  --no-ragflow / --no-vlm / --no-classify  跳过对应步骤
  --force                                  忽略内容哈希强制重跑

predeal figures [OPTIONS]
  --document-id INT    文档 ID [必填]
  --source-path PATH   源 Markdown 文件路径 [必填]
  --storage-prefix TEXT 图片服务器存储前缀 [必填]

predeal domains         列出所有领域
predeal info DOMAIN     显示领域配置详情
predeal process          [已下线，v1] 调用直接报错，提示改用 predeal2 process
```

> v1 管线代码（`predeal/pipeline.py`、`predeal/steps/ragflow_packager.py`）已
> 移至 `legacy/` 只读留档，详见 `legacy/README.md`。
