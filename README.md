# 智训云枢

当前用户端以 28801 线上页面为基线，使用 React/Vite；学习服务使用仓颉
1.2.0 + Spire。开发环境不使用 Docker。

## 启动

分别打开两个 PowerShell 7 终端：

```powershell
.\scripts\run-backend.ps1
.\scripts\run-frontend.ps1
```

浏览器打开 `http://localhost:3006/`。停止时在终端按 `Ctrl+C`。

也可以后台启动（日志写入 `backend.log` / `frontend.log`，加 `-Stop` 停止）：

```powershell
.\scripts\build-backend.ps1      # 首次或改过后端后构建；构建前必须先停服
.\scripts\start-backend.ps1
.\scripts\start-frontend.ps1
```

数据库连接只从项目根目录已忽略的 `.env.local` 读取。后端启动时会拒绝连接
`itn_learning_v2_dev` 以外的数据库。

邮箱验证码使用 `.env.local` 中的 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USERNAME`、
`SMTP_PASSWORD`、`EMAIL_FROM` 等变量。真实值不进入 Git。

## 管理端

访问 `http://127.0.0.1:3006/admin`，也可以从用户端登录页卡片下方的「进入管理端」进去。
默认账号密码都是 `admin`（仅本地开发库，正式环境务必重置）。管理员账号存在同一张
`users` 表里，靠 `role='admin'` 区分。

首次创建或重置管理员：

```powershell
.\scripts\create-admin.ps1                       # 生成随机密码并输出一次
.\scripts\create-admin.ps1 -Account admin -Password 'admin'
```

管理端现有能力：

- 概览：学习账号数、建档率、课程与课时数、测验提交与平均分、近 7 天活跃。
- 知识库：**课程的唯一来源**。上传或粘贴 Markdown / 纯文本 → 自动按标题切片并建索引 →
  一键发布为课程（每个顶层章节是一节课）→ 可下架、重新发布、删除。
  删除文档时，没人学过的课程会一并删除，有人学过的只下架。
- 用户：只读查看建档状态、完成课时、平均分与最近活跃，可过滤空的游客账号。
- 设置：配置 OpenAI 兼容的接口地址、向量模型、对话模型与切片参数，并测试连通性。

上架流程只有三步：**上传文档 → 建索引 → 发布课程**。课程不再手工新建课时；
要改内容就改文档再重新发布（重新发布会把这门课原有的学习记录一并重置）。

## 模型与检索

向量化与 AI 导师都走 OpenAI 兼容接口，密钥只放服务端环境变量：

```text
# .env.local
ZHIXUN_MODEL_API_KEY=sk-...
# 兼容 OPENAI_API_KEY
```

接口地址、模型名和切片参数在「设置」页里填，存在 `kb_settings` 表。向量检索是
本机余弦（向量以 int8 量化后存十六进制），检索时把候选切片取进内存算分；没有配置
向量模型时自动退化成字符二元组关键词检索，上传和检索都照常可用。

想在本地把整条链路跑通又不花钱，可以起一个 mock 模型服务：

```powershell
python tools\mock-model-server.py --port 8790
```

然后在「设置」里把接口地址填成 `http://127.0.0.1:8790/v1`，向量模型 `mock-embed`，
对话模型 `mock-chat`。这个 mock 只用于开发自检，不参与运行。

发布即生效，没有多级审核。课时只允许删除最后一节，避免打乱已发布编号和
学习记录。

## 已验证范围

- 自动建立独立访客学习账号，不共享其他用户的数据。
- “立即体验”进入登录页；首次账号完成建档，老账号直接恢复学习主页。
- 学习账号注册与再次登录已接入隔离库，密码只保存加盐哈希。
- 支持邮箱验证码登录：验证码 5 分钟有效、60 秒内不可重复发送、校验成功后立即失效。
- 建档、课程目录、课时阅读、服务端判题、测验提交、课程进度。
- 课程收藏与片段书签刷新后恢复。
- 5 门课程、24 个课时。Agent 课程复用了隔离开发库中的公开讲义和题目；
  其余计算机基础课程是已标注来源的演示内容。
- 界面保持原页面结构，增加加载失败重试与同步状态提示。
- 管理端全流程：登录、概览、课程发布与下架、课时编辑保存、用户列表；
  草稿课程及其课时对学习者不可见。
- 知识库全流程：上传 Markdown、按标题切片、检索测试（有模型时向量+关键词融合，
  没有模型时纯关键词）、删除后立即从检索里消失。
- AI 导师：阅读页提问会带检索到的课程资料回答并返回引用；没有配置对话模型时
  明确提示缺少什么，不会假装回答。

AI 导师需要配置模型接口后才能回答，其余功能不依赖外部服务。

## 测试

接口测试直接打本机的仓颉服务，三个测试文件共用同一个隔离开发库，必须串行执行：

```powershell
$env:ZHIXUN_TEST_API = 'http://127.0.0.1:8312/api'
$env:ZHIXUN_ADMIN_PASSWORD = '<管理员密码>'
node --test --test-concurrency=1 tests/*.test.mjs
```

并行执行（默认行为）会互相干扰：管理端用例增删课时时，学习端用例正在比较
`stats.totalLessons` 的前后值。

## 目录

- `apps/web/`：可从构建产物恢复的开发前端。
- `apps/web/src/admin/`：管理端页面与接口层，与用户端共用同一份构建。
- `services/learning/`：原生仓颉学习后端。
- `schema.sql`：隔离开发库结构，位于 `services/learning/schema.sql`。
- `services/learning/migrations/`：已执行的一次性结构变更，按序号记录（001 管理端字段、002 知识库）。
- `apps/web/src/tutor.js`：用户端 AI 导师的请求封装，由阅读页提问面板调用。
- `tools/mock-model-server.py`：本地 mock 模型服务，只用于开发自检，不参与运行。
- `tools/`、`scripts/`：静态源码恢复、课程导入、启动与管理员账号脚本。
- `deployed/`：线上发布产物原件，保持逐字节不变。
- `TRACE.md`：跨会话操作记录。

## 原始页面

要查看未修改的 28801 线上产物：

```powershell
python preview_server.py --port 3005
```

浏览器打开 `http://localhost:3005/`。
