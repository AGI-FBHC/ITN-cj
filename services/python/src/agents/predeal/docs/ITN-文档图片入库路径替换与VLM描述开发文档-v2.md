# ITN 文档图片入库、路径替换与 VLM 描述开发文档

# 0. 基础api使用和测试数据

1. 目前已经创建knowledge_figures表，

2. 测试文档：/Users/inyvn/Documents/Projects/GitHub/ITN/src/itn_source/hello_agents/docs/chapter4 

3. 建议图片存储路径：/home/jnuaipr/Data/images/ITN/hello_agents/chapter4

4. vlm使用模型：GLM-4.6V-Flash，调用文档参考：https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash

   api key：<ZAI_API_KEY>

5. /Users/inyvn/Documents/Projects/GitHub/ITN/src/agents/KnowledgeCore/predeal IMAGE_UPLOAD_GUIDE.md

6. ## MySQL账户密码

   账户：`root`

   密码：`<MYSQL_PASSWORD>`

   主机：`113.249.110.108`

   端口号：`58391`

   数据库：`itn-platform`

   相关数据库表：knowledge_figures  非必要不新增字段



## 1. 目标

本模块负责对知识源 Markdown 文档中的图片进行统一处理，完成以下三个动作：

1. **图片路径替换**
   - 识别文档中的远程图片；
   - 将远程图片读取到本地临时文件；
   - 调用现有图片上传接口，保存到 ITN 图片服务器；
   - 将原始图片地址替换为 ITN 图片服务器地址。

2. **VLM 图片描述**
   - 使用 `GLM-4.6V-Flash` 识别图片内容；
   - 将描述写入 `knowledge_figures.vlm_description`；
   - 同时写入对应 `<img>` 标签的 `data-vlm-description` 属性，供后续切片读取。

3. **图片入库管理**
   - 保存图片原始地址、服务器存储路径、文件信息、VLM 描述及处理状态；
   - 建立必要索引，支持图片查询、重试、路径维护和文档重处理。

本阶段不负责判断图片属于哪个切片。图片与切片的关系在后续切片阶段，根据图片在文档中的实际位置和前后文本统一处理。

---

## 2. 设计原则

### 2.1 面向通用文档处理

测试文档仅用于验证，不在代码中写死章节名称、图片数量、文件名或目录。

程序应支持：

- 任意 Markdown 文件；
- HTML `<img>` 标签；
- Markdown 图片语法 `![alt](url)`；
- 一篇文档包含零张、一张或多张图片；
- PNG、JPEG、WebP、GIF 等允许的图片格式；
- 同一文档重复处理。

### 2.2 图片服务器负责文件保存

图片上传后存储在服务器目录：

```text
/home/jnuaipr/Data/images/{storage_key}
```

公开访问地址：

```text
http://113.249.110.108:28901/{storage_key}
```

业务程序不直接远程写服务器磁盘，只调用已经完成的图片上传接口。

### 2.3 MySQL 负责图片索引和处理状态

图片二进制文件不存入 MySQL。

`knowledge_figures` 保存：

- 图片属于哪篇文档；
- 图片在文档中的顺序；
- 原始图片地址；
- 图片服务器中的相对路径；
- 图片格式、大小、宽高和哈希；
- VLM 描述；
- 下载、上传和 VLM 状态；
- 错误信息和处理时间。

### 2.4 不在本阶段处理切片关系

本阶段不增加以下字段：

```text
before_context
after_context
chunk_binding_hint
binding_reason
chunk_id
```

后续切片程序读取处理后的 `<img>` 标签，根据图片当前位置决定图片属于前一切片、后一切片或同时被多个切片引用。

---

## 3. 测试环境

### 3.1 测试文档目录

```text
/Users/inyvn/Documents/Projects/GitHub/ITN/src/itn_source/hello_agents/docs/chapter4
```

测试文件：

```text
第四章 智能体经典范式构建.md
```

测试文档用于验证流程，不作为程序中的固定路径。实际运行时应通过命令行参数或配置传入文档路径。

### 3.2 测试图片存储目录

建议本次测试使用：

```text
/home/jnuaipr/Data/images/ITN/hello_agents/chapter4
```

对应 `storage_key` 前缀：

```text
ITN/hello_agents/chapter4
```

公开访问前缀：

```text
http://113.249.110.108:28901
```

示例：

```text
服务器文件：
/home/jnuaipr/Data/images/ITN/hello_agents/chapter4/4-1-a1b2c3d4.png

storage_key：
ITN/hello_agents/chapter4/4-1-a1b2c3d4.png

公开地址：
http://113.249.110.108:28901/ITN/hello_agents/chapter4/4-1-a1b2c3d4.png
```

### 3.3 VLM

模型：

```text
glm-4.6v-flash
```

官方文档：

```text
https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash
```

该模型支持图像输入并输出文本描述，也支持 URL 和 Base64 图片输入。本模块优先使用已经下载到本地的临时图片进行 Base64 编码，避免模型服务再次访问原始图片地址或当前 HTTP 图片服务器。

---

## 4. 输入与输出

### 4.1 输入

```text
source_path       原始 Markdown 文件
document_id       文档在业务数据库中的 ID
storage_prefix    图片服务器中的目标目录前缀
```

测试参数：

```text
source_path =
/Users/inyvn/Documents/Projects/GitHub/ITN/src/itn_source/hello_agents/docs/chapter4/第四章 智能体经典范式构建.md

storage_prefix =
ITN/hello_agents/chapter4
```

### 4.2 输出

1. 图片上传至 ITN 图片服务器；
2. `knowledge_figures` 中新增或更新图片记录；
3. 生成处理后的 Markdown 文件；
4. 原始 Markdown 文件保持不变。

建议输出：

```text
chapter4/
├── 第四章 智能体经典范式构建.md
└── normalized/
    └── 第四章 智能体经典范式构建.md
```

---

## 5. 总体处理流程

```text
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

这里的“下载”是预处理程序直接读取原始远程 URL，不调用服务器图片下载接口。

---

## 6. 配置项

建议通过 `.env` 或应用配置管理：

```env
# 图片公开访问地址
IMAGE_BASE_URL=http://113.249.110.108:28901

# 现有图片上传接口
IMAGE_UPLOAD_URL=http://<服务器IP>:<上传接口端口>/api/assets/images
IMAGE_UPLOAD_TOKEN=<上传接口令牌>

# 本地临时目录
IMAGE_TEMP_DIR=/tmp/itn-images

# VLM
ZAI_API_KEY=<智谱 API Key>
VLM_MODEL=glm-4.6v-flash

# MySQL
MYSQL_DSN=mysql+pymysql://<user>:<password>@<host>:<port>/<database>?charset=utf8mb4
```

`storage_prefix` 不建议写死在环境变量中，应按每次处理任务传入。

例如：

```text
ITN/hello_agents/chapter4
ITN/hello_agents/chapter5
ITN/other_corpus/module_a
```

---

## 7. `knowledge_figures` 表要求

表已经创建，本模块以现有表为基础实现，不再拆分新的图片资产表或图片引用表。

一条记录表示：

> 某篇文档中按顺序出现的一张图片。

### 7.1 必需字段

```text
id
document_id
occurrence_no
figure_label
caption
alt_text
source_url
storage_key
mime_type
file_extension
file_size
width
height
sha256
download_status
upload_status
vlm_status
vlm_description
vlm_model
download_error
upload_error
vlm_error
downloaded_at
uploaded_at
described_at
created_at
updated_at
```

字段命名可以沿用现有数据库设计，但应覆盖上述语义。

### 7.2 不保存完整公开 URL

数据库保存：

```text
storage_key = ITN/hello_agents/chapter4/4-1-a1b2c3d4.png
```

公开地址运行时生成：

```python
public_url = f"{IMAGE_BASE_URL.rstrip('/')}/{storage_key.lstrip('/')}"
```

这样未来更换 IP、端口、域名或 HTTPS 时，不需要批量修改数据库。

### 7.3 推荐索引

先检查现有索引，缺少时再添加：

```sql
ALTER TABLE knowledge_figures
    ADD UNIQUE KEY uk_document_occurrence (
        document_id,
        occurrence_no
    ),
    ADD KEY idx_document_id (
        document_id
    ),
    ADD KEY idx_storage_key (
        storage_key(191)
    ),
    ADD KEY idx_sha256 (
        sha256
    ),
    ADD KEY idx_download_status (
        download_status
    ),
    ADD KEY idx_upload_status (
        upload_status
    ),
    ADD KEY idx_vlm_status (
        vlm_status
    );
```

如果 `storage_key` 是 `VARCHAR(512)` 或更短，也可以直接建立完整索引，不使用前缀索引。



---

## 8. 图片识别

### 8.1 支持 HTML 图片

示例：

```html
<div align="center">
  <img
    src="https://example.com/4-1.png"
    alt="ReAct 范式流程"
    width="90%"
  />
  <p>图 4.1 ReAct 范式流程</p>
</div>
```

需要提取：

```text
source_url
alt_text
caption
figure_label
occurrence_no
```

### 8.2 支持 Markdown 图片

示例：

```markdown
![ReAct 范式流程](https://example.com/4-1.png)
```

由于标准 Markdown 图片语法不能携带 `data-figure-id` 和 `data-vlm-description`，处理后统一转换成 HTML `<img>` 标签。

### 8.3 远程图片判断

第一版处理：

```text
http://
https://
```

对于已经是 ITN 图片服务器地址的图片：

```text
http://113.249.110.108:28901/...
```

应识别为已处理图片，优先根据 `data-figure-id` 或数据库记录复用，不再重复下载、上传和调用 VLM。

### 8.4 解析实现要求

不要只用一个正则表达式处理完整 HTML。

建议：

- 先通过 Markdown 解析器识别 Markdown 图片；
- 对 HTML 块使用 HTML 解析器；
- 保留原始块顺序；
- 路径替换时只修改目标 `<img>` 标签；
- 不改变标题、正文、公式、代码块和图注。

---

## 9. 图片读取与临时文件

### 9.1 读取动作

程序直接对原始远程图片执行 HTTP GET：

```python
from pathlib import Path

import httpx


def download_remote_image(source_url: str, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)

    with httpx.stream(
        "GET",
        source_url,
        follow_redirects=True,
        timeout=httpx.Timeout(
            connect=10,
            read=30,
            write=30,
            pool=10,
        ),
    ) as response:
        response.raise_for_status()

        content_type = response.headers.get("content-type", "")
        if not content_type.startswith("image/"):
            raise ValueError(f"远程内容不是图片：{content_type}")

        with target.open("wb") as output:
            for chunk in response.iter_bytes():
                output.write(chunk)

    return target
```

### 9.2 图片校验

下载后至少完成：

- 文件非空；
- MIME 为允许的图片类型；
- Pillow 可以打开；
- 获取宽高；
- 计算 SHA-256；
- 限制最大文件大小。

推荐允许：

```text
image/png
image/jpeg
image/webp
image/gif
```

SVG 是否允许应单独配置。VLM、Pillow 和安全策略对 SVG 的处理方式与普通位图不同，第一版可以不支持。

### 9.3 临时文件生命周期

```text
任务开始
→ 创建临时目录
→ 下载图片
→ 上传图片
→ 调用 VLM
→ 数据库和文档写入成功
→ 删除临时图片
```

发生错误时也应在 `finally` 中清理临时文件。

---

## 10. 图片文件名和服务器目录

### 10.1 目录

上传目录由调用参数决定：

```text
storage_prefix
```

测试值：

```text
ITN/hello_agents/chapter4
```

### 10.2 文件名

建议格式：

```text
{原始文件名主干}-{sha256前8位}.{规范扩展名}
```

示例：

```text
4-1-a1b2c3d4.png
```

这样可以：

- 保留一定可读性；
- 避免同名文件覆盖；
- 图片内容变化后生成新地址；
- 避免浏览器继续使用旧缓存。

最终名称以图片上传接口返回结果为准。

### 10.3 上传接口

调用现有上传接口：

```http
POST /api/assets/images
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

参数：

```text
file
directory
```

测试目录参数：

```text
directory=ITN/hello_agents/chapter4
```

期望返回：

```json
{
  "storage_key": "ITN/hello_agents/chapter4/4-1-a1b2c3d4.png",
  "url": "http://113.249.110.108:28901/ITN/hello_agents/chapter4/4-1-a1b2c3d4.png",
  "sha256": "完整哈希值",
  "mime_type": "image/png",
  "file_size": 123456
}
```

数据库以接口返回的 `storage_key` 为准。

---

## 11. VLM 图片识别

### 11.1 调用方式

使用 `GLM-4.6V-Flash`。

因为原始图片已经读取到本地临时文件，直接将该文件编码为 Base64 后传入模型，不需要模型服务再次访问原始 URL，也不依赖当前图片服务器是否启用 HTTPS。

安装官方 SDK：

```bash
pip install zai-sdk
```

示例：

```python
import base64
import os
from pathlib import Path

from zai import ZhipuAiClient


client = ZhipuAiClient(
    api_key=os.environ["ZAI_API_KEY"],
)


def describe_image(image_path: Path) -> str:
    image_base64 = base64.b64encode(
        image_path.read_bytes()
    ).decode("utf-8")

    response = client.chat.completions.create(
        model="glm-4.6v-flash",
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_base64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "请客观描述这张图片中的内容。"
                            "如果是流程图，说明主要节点和流程方向；"
                            "如果是表格，概括主要对比维度和结论；"
                            "如果是架构图，说明主要组件及关系。"
                            "不要补充图片中不存在的信息。"
                            "使用中文，控制在100到300字，"
                            "只输出描述正文。"
                        ),
                    },
                ],
            }
        ],
        thinking={
            "type": "disabled",
        },
    )

    description = response.choices[0].message.content

    if not description or not description.strip():
        raise ValueError("VLM 未返回有效描述")

    return " ".join(description.split())
```

### 11.2 描述要求

`vlm_description` 应：

- 客观描述图片中实际存在的内容；
- 流程图说明顺序；
- 架构图说明组件关系；
- 表格说明主要列、行或对比结论；
- 保留图片中的重要术语；
- 不评价图片美观程度；
- 不补充无法从图片确认的知识；
- 不包含 Markdown 代码块；
- 不包含换行。

### 11.3 数据库保存

成功：

```text
vlm_status = success
vlm_model = glm-4.6v-flash
vlm_description = 模型返回内容
described_at = 当前时间
vlm_error = NULL
```

失败：

```text
vlm_status = failed
vlm_error = 具体错误
```

---

## 12. 文档路径替换

### 12.1 原始标签

```html
<img
  src="https://raw.githubusercontent.com/datawhalechina/Hello-Agents/main/docs/images/4-figures/4-1.png"
  alt="ReAct范式中的“思考-行动-观察”协同循环"
  width="90%"
/>
```

### 12.2 处理后标签

```html
<img
  src="http://113.249.110.108:28901/ITN/hello_agents/chapter4/4-1-a1b2c3d4.png"
  alt="ReAct范式中的“思考-行动-观察”协同循环"
  width="90%"
  data-figure-id="123"
  data-vlm-description="该图展示ReAct范式中的思考、行动和观察循环。智能体根据当前问题与已有轨迹生成思考并选择行动，外部工具执行行动后返回观察结果，新的观察继续进入下一轮推理，直到任务完成。"
/>
```

只新增两个业务属性：

```text
data-figure-id
data-vlm-description
```

不增加切片归属属性。

### 12.3 属性转义

VLM 描述写入 HTML 属性前必须转义：

```python
from html import escape


def prepare_html_attribute(value: str) -> str:
    one_line = " ".join(value.split())
    return escape(one_line, quote=True)
```

需要处理：

```text
&  → &amp;
"  → &quot;
<  → &lt;
>  → &gt;
换行 → 空格
```

### 12.4 后续切片

切片程序读取：

```text
data-figure-id
data-vlm-description
src
图片在文档中的实际位置
```

判断图片归属后，可从最终切片正文中删除：

```text
data-vlm-description
```

数据库中的 `vlm_description` 保留，不受影响。

---

## 13. 数据库状态流转

建议使用独立状态：

```text
download_status
upload_status
vlm_status
```

取值统一为：

```text
pending
processing
success
failed
```

### 13.1 初始记录

图片被识别后先创建或更新记录：

```text
download_status = pending
upload_status = pending
vlm_status = pending
```

### 13.2 下载成功

保存：

```text
source_url
sha256
mime_type
file_extension
file_size
width
height
download_status = success
downloaded_at
```

### 13.3 上传成功

保存：

```text
storage_key
upload_status = success
uploaded_at
```

### 13.4 VLM 成功

保存：

```text
vlm_description
vlm_model
vlm_status = success
described_at
```

### 13.5 错误处理

下载失败：

```text
download_status = failed
download_error = 错误信息
```

上传失败：

```text
upload_status = failed
upload_error = 错误信息
```

VLM 失败：

```text
vlm_status = failed
vlm_error = 错误信息
```

---

## 14. 幂等处理

同一篇文档重复运行时，不应产生重复数据库记录。

### 14.1 记录定位

使用：

```text
document_id + occurrence_no
```

作为同一文档中同一图片位置的唯一条件。

同时校验：

```text
source_url
sha256
```

### 14.2 复用条件

满足以下条件时直接复用：

```text
source_url 未变化
upload_status = success
vlm_status = success
storage_key 非空
vlm_description 非空
```

处理时：

- 不重新上传；
- 不重新调用 VLM；
- 直接从数据库生成新的 `<img>` 标签。

### 14.3 原图变化

如果原图 URL 相同但文件哈希变化：

```text
重新上传
→ 生成新的 storage_key
→ 重新调用 VLM
→ 更新数据库
→ 重新生成 normalized Markdown
```

### 14.4 文档图片顺序变化

如果文档新增、删除或移动图片，`occurrence_no` 可能变化。

每次处理结束后，应将该文档中本轮未识别到的旧图片记录标记为失效，或使用现有软删除字段，例如：

```text
is_active = false
```

如果当前表没有软删除字段，第一版可以先记录警告，不直接删除服务器文件。

---

## 15. 文档写入策略

### 15.1 不覆盖原文

输出到：

```text
normalized/{原文件名}
```

### 15.2 完整成功后再写文件

先在内存中完成所有图片处理和标签替换。

只有全部图片处理成功后，才写入最终 normalized 文件。

发生任一关键错误时：

- 保存数据库错误状态；
- 不覆盖已经存在的成功输出；
- 输出错误日志；
- 允许下一次重试。

### 15.3 原子写入

```python
from pathlib import Path


def atomic_write(target: Path, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)

    temp_file = target.with_suffix(
        target.suffix + ".tmp"
    )

    temp_file.write_text(
        content,
        encoding="utf-8",
    )

    temp_file.replace(target)
```

---

## 16. 推荐代码结构

```text
predeal/
└── images/
    ├── parser.py
    ├── downloader.py
    ├── inspector.py
    ├── uploader.py
    ├── vlm.py
    ├── repository.py
    ├── rewriter.py
    └── pipeline.py
```

职责：

| 文件 | 职责 |
|---|---|
| `parser.py` | 识别 HTML 和 Markdown 图片 |
| `downloader.py` | 将远程图片读取到本地临时文件 |
| `inspector.py` | 校验图片，计算哈希、宽高和格式 |
| `uploader.py` | 调用现有图片上传接口 |
| `vlm.py` | 调用 GLM-4.6V-Flash |
| `repository.py` | 操作 `knowledge_figures` |
| `rewriter.py` | 替换 `src` 并写入两个 data 属性 |
| `pipeline.py` | 串联完整流程 |

不需要为当前功能拆分微服务。

---

## 17. Pipeline 伪代码

```python
def process_markdown_images(
    document_id: int,
    source_path: Path,
    storage_prefix: str,
) -> Path:
    source_text = source_path.read_text(
        encoding="utf-8"
    )

    images = parser.parse(source_text)
    replacements = []

    for occurrence_no, image in enumerate(
        images,
        start=1,
    ):
        record = repository.upsert_pending(
            document_id=document_id,
            occurrence_no=occurrence_no,
            figure_label=image.figure_label,
            caption=image.caption,
            alt_text=image.alt_text,
            source_url=image.source_url,
        )

        if repository.can_reuse(record):
            public_url = build_public_url(
                record.storage_key
            )
            replacements.append(
                rewriter.build(
                    image=image,
                    public_url=public_url,
                    figure_id=record.id,
                    vlm_description=record.vlm_description,
                )
            )
            continue

        local_path = None

        try:
            repository.mark_download_processing(
                record.id
            )

            local_path = downloader.download(
                image.source_url
            )

            metadata = inspector.inspect(
                local_path
            )

            repository.mark_download_success(
                record.id,
                metadata,
            )

            repository.mark_upload_processing(
                record.id
            )

            upload_result = uploader.upload(
                local_path=local_path,
                directory=storage_prefix,
            )

            repository.mark_upload_success(
                record.id,
                upload_result.storage_key,
            )

            repository.mark_vlm_processing(
                record.id
            )

            description = vlm.describe(
                local_path
            )

            repository.mark_vlm_success(
                record.id,
                model="glm-4.6v-flash",
                description=description,
            )

            public_url = build_public_url(
                upload_result.storage_key
            )

            replacements.append(
                rewriter.build(
                    image=image,
                    public_url=public_url,
                    figure_id=record.id,
                    vlm_description=description,
                )
            )

        except Exception as error:
            repository.mark_current_step_failed(
                record.id,
                str(error),
            )
            raise

        finally:
            if local_path:
                local_path.unlink(
                    missing_ok=True
                )

    normalized_text = rewriter.apply(
        source_text,
        replacements,
    )

    output_path = (
        source_path.parent
        / "normalized"
        / source_path.name
    )

    atomic_write(
        output_path,
        normalized_text,
    )

    return output_path
```

---

## 18. 测试文档验收

测试文档用于验证以下结果。

### 18.1 图片服务器

服务器目录：

```text
/home/jnuaipr/Data/images/ITN/hello_agents/chapter4
```

应保存测试文档中实际引用的全部图片。

每张图片都可以通过以下形式访问：

```text
http://113.249.110.108:28901/ITN/hello_agents/chapter4/{filename}
```

### 18.2 数据库

每张图片对应一条 `knowledge_figures` 记录，并满足：

```text
document_id 正确
occurrence_no 连续
source_url 正确
storage_key 非空
sha256 非空
upload_status = success
vlm_status = success
vlm_description 非空
```

### 18.3 处理后文档

输出文件：

```text
/Users/inyvn/Documents/Projects/GitHub/ITN/src/itn_source/hello_agents/docs/chapter4/normalized/第四章 智能体经典范式构建.md
```

检查：

- 原始远程图片地址已全部替换；
- 图片地址全部指向 ITN 图片服务器；
- 每个 `<img>` 均有 `data-figure-id`；
- 每个 `<img>` 均有 `data-vlm-description`；
- 原始图注、alt、width 和图片顺序保留；
- 标题、段落、公式和代码块未被破坏；
- 原始 Markdown 文件未被修改。

### 18.4 重复运行

连续运行两次：

- 不重复创建图片记录；
- 不重复上传未变化的图片；
- 不重复调用已有成功描述的 VLM；
- 两次生成的 normalized 文档内容一致。

---

## 19. 本阶段不实现

- 不判断图片属于哪个切片；
- 不建立图片与 chunk 的关系表；
- 不把图片描述拆成复杂 JSON；
- 不做完整 OCR 或图片表格结构化；
- 不建设 NAS、MinIO 或新的对象存储；
- 不拆分图片资产表和图片引用表；
- 不修改原始 Markdown；
- 不将图片二进制保存到 MySQL。

本阶段完成后，再进入文档切片开发。切片程序读取 `<img>` 中的 `data-figure-id`、`data-vlm-description` 和图片所在位置，决定图片与一个或多个切片的关系。
