# 图片处理模块实现总结

## 概述

按照《ITN 文档图片入库路径替换与VLM描述开发文档-v2》完成了图片处理模块的实现。

## 实现的文件

### 核心模块 (`predeal/images/`)

| 文件 | 职责 | 状态 |
|------|------|------|
| `__init__.py` | 模块初始化，懒加载导入 | ✅ 完成 |
| `models.py` | 数据模型定义 | ✅ 完成 |
| `parser.py` | 图片识别（HTML/Markdown） | ✅ 完成 |
| `downloader.py` | 远程图片下载 | ✅ 完成 |
| `inspector.py` | 图片校验和元数据提取 | ✅ 完成 |
| `uploader.py` | 上传到 ITN 图片服务器 | ✅ 完成 |
| `vlm.py` | GLM-4.6V-Flash 集成 | ✅ 完成 |
| `repository.py` | MySQL 数据库操作 | ✅ 完成 |
| `rewriter.py` | 文档路径替换 | ✅ 完成 |
| `pipeline.py` | 流程编排 | ✅ 完成 |
| `README.md` | 模块文档 | ✅ 完成 |

### 更新的文件

| 文件 | 更新内容 |
|------|----------|
| `pyproject.toml` | 添加新依赖：httpx, pymysql, Pillow, zai-sdk |
| `cli.py` | 添加 `figures` 命令 |
| `README.md` | 添加图片处理使用说明 |

### 测试文件

| 文件 | 说明 |
|------|------|
| `tests/test_image_pipeline.py` | 基础测试（解析器和模型） |

## 功能实现

### 1. 图片识别

- ✅ 支持 HTML `<img>` 标签
- ✅ 支持 HTML div 包裹的图片+图注
- ✅ 支持 Markdown `![alt](url)` 语法
- ✅ 自动提取图注和图号
- ✅ 跳过已处理的图片（ITN 服务器地址）

### 2. 图片下载

- ✅ 使用 httpx 流式下载
- ✅ 支持超时配置
- ✅ 文件大小限制（50MB）
- ✅ 内容类型验证
- ✅ 临时文件管理

### 3. 图片校验

- ✅ SHA-256 哈希计算
- ✅ MIME 类型检测
- ✅ 图片尺寸获取（使用 Pillow）
- ✅ 支持 PNG、JPEG、WebP、GIF

### 4. 图片上传

- ✅ 调用现有上传接口
- ✅ Bearer Token 认证
- ✅ 目录参数支持
- ✅ 错误处理（409 冲突等）

### 5. VLM 描述

- ✅ GLM-4.6V-Flash 集成
- ✅ Base64 图片编码
- ✅ 自定义提示词
- ✅ 描述清洗和规范化

### 6. 数据库操作

- ✅ 幂等处理（document_id + occurrence_no）
- ✅ 三状态独立跟踪
- ✅ 复用条件判断
- ✅ 错误状态记录

### 7. 文档重写

- ✅ 替换图片 URL
- ✅ 添加 data-figure-id 属性
- ✅ 添加 data-vlm-description 属性
- ✅ HTML 转义处理
- ✅ Markdown 转 HTML img 标签

### 8. 流程编排

- ✅ 完整处理流程
- ✅ 幂等检查
- ✅ 错误处理和状态更新
- ✅ 原子文件写入
- ✅ 临时文件清理

## 使用方法

### 1. 安装依赖

```bash
cd src/agents/KnowledgeCore/predeal
pip install -e ".[images]"
# 或者直接安装
pip install httpx pymysql Pillow zai-sdk
```

### 2. 配置环境变量

```bash
# 图片服务器
export IMAGE_BASE_URL=http://113.249.110.108:28901
export IMAGE_UPLOAD_URL=http://113.249.110.108:28902/api/assets/images
export IMAGE_UPLOAD_TOKEN=<IMAGE_UPLOAD_TOKEN>

# VLM
export ZAI_API_KEY=<ZAI_API_KEY>
export VLM_MODEL=glm-4.6v-flash

# MySQL
export MYSQL_HOST=113.249.110.108
export MYSQL_PORT=58391
export MYSQL_USER=root
export MYSQL_PASSWORD=<MYSQL_PASSWORD>
export MYSQL_DATABASE=itn-platform
```

### 3. 运行处理

```bash
# 使用 CLI
predeal figures \
  --document-id 123 \
  --source-path /path/to/document.md \
  --storage-prefix ITN/hello_agents/chapter4

# 或使用 Python API
from predeal.images.pipeline import process_markdown_images
from pathlib import Path

output = process_markdown_images(
    document_id=123,
    source_path=Path("/path/to/document.md"),
    storage_prefix="ITN/hello_agents/chapter4",
)
```

## 数据库表结构

使用现有的 `knowledge_figures` 表，关键字段：

```sql
- id (主键)
- document_id (文档ID)
- occurrence_no (图片顺序)
- source_url (原始URL)
- storage_key (服务器存储路径)
- sha256 (文件哈希)
- mime_type (MIME类型)
- file_extension (文件扩展名)
- file_size (文件大小)
- width, height (图片尺寸)
- download_status, upload_status, vlm_status (处理状态)
- vlm_description (VLM描述)
- vlm_model (VLM模型)
- download_error, upload_error, vlm_error (错误信息)
- downloaded_at, uploaded_at, described_at (处理时间)
- created_at, updated_at (记录时间)
```

## 处理流程

```
读取 Markdown
    ↓
识别所有图片
    ↓
按文档中的出现顺序处理
    ↓
在 knowledge_figures 中创建或取得图片记录
    ↓
HTTP GET 读取原始远程图片到本地临时文件
    ↓
校验图片并计算 SHA-256、MIME、大小和宽高
    ↓
调用现有图片上传接口
    ↓
取得 storage_key
    ↓
使用本地临时图片调用 GLM-4.6V-Flash
    ↓
保存 VLM 描述
    ↓
更新 knowledge_figures
    ↓
替换 <img> 的 src
    ↓
写入 data-figure-id
    ↓
写入 data-vlm-description
    ↓
生成 normalized Markdown
    ↓
删除本地临时文件
```

## 测试验证

运行测试：

```bash
cd src/agents/KnowledgeCore/predeal
python tests/test_image_pipeline.py
```

测试内容：
- ✅ ProcessingStatus 枚举
- ✅ ImageRef 数据模型
- ✅ HTML img 标签解析
- ✅ Markdown 图片解析
- ✅ 多图片解析
- ✅ 跳过已处理图片

## 后续工作

1. **集成测试** - 使用真实文档进行端到端测试
2. **数据库索引** - 按文档建议添加索引
3. **错误重试** - 添加失败重试机制
4. **并发处理** - 支持多图片并行处理
5. **进度报告** - 添加处理进度显示
