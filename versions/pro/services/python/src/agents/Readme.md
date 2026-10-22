# ITN Agent Service

ITN Agent Service 是直接对前端开放的 FastAPI 多智能体与对话服务，与 Spring Boot 共用同一套用户 JWT（共享签名密钥），前端不再经过 Spring Boot 透传访问。

## 接口分组

- `/v1/**`：对前端开放的接口，使用 `Authorization: Bearer <accessToken>` 鉴权
  - `GET /v1/agents`：Agent 清单
  - `POST /v1/agent-runs`、`POST /v1/agent-runs/stream`、`GET /v1/agent-runs/{id}`：六智能体工作流，服务会连接平台 MySQL 校验学习目标归属并注入用户画像
  - `POST /v1/chat`、`POST /v1/chat/stream`：普通对话（见下节）
- `/internal/v1/**`：服务间内部接口，HMAC 签名鉴权，不应对外暴露

## 工作流

学情诊断 → 任务拆解 → 知识检索 → 内容生成 → 质量审核 → 最终裁决

结构与鉴权协议见 [doc/ARCHITECTURE.md](doc/ARCHITECTURE.md)。

## 目录结构

```text
app/
├─ agents/          多智能体工作流节点
├─ domain/          公共领域模型
├─ presentations/   PPT Agent、请求模型与任务存储
├─ routers/         FastAPI 公开与内部路由
├─ services/        对话等应用服务
├─ storage/         数据库、附件和会话存储适配器
├─ tools/           可注册的 Agent 工具
├─ config.py        服务配置
├─ llm.py           模型客户端
├─ security.py      JWT 与内部签名鉴权
└─ workflow.py      多智能体编排
```

运行时数据库、上传文件和演示文稿产物统一写入 `data/`，不与源码混放且不提交 Git。

## 普通对话接口

`/v1/chat` 与 `/v1/chat/stream` 不经过 Agent 管线，支持多轮消息历史，不写 Agent 运行记录；会话与消息存放在平台 MySQL 的 `chat_sessions` / `chat_messages` 表（Spring Boot Flyway 建表），通过 `POST/GET/DELETE /v1/chat/sessions` 系列接口管理，请求携带 `session_id` 时自动落库：

- 请求体 `{"messages": [{"role": "user", "content": "..."}], "system_prompt": "可选", "include_reasoning": false, "session_id": "可选"}`（同时兼容 `systemPrompt`、`includeReasoning`、`sessionId` 驼峰写法）
- 流式事件：`chat_reasoning_delta`（思考过程，仅 `include_reasoning=true` 时出现）、`chat_delta`、`chat_completed`、`chat_failed`
- 未传 `system_prompt` 时使用内置的导学助手提示词

## 关键配置

- `JWT_SECRET`：与 Spring Boot 相同的 JWT 签名密钥（必填，公开接口鉴权）
- `PLATFORM_DB_URL`：平台 MySQL 只读连接，形如 `mysql://user:password@host:3306/itn-platform`，agent-runs 的用户上下文读取依赖它
- `AGENT_INTERNAL_SECRET`：内部 HMAC 密钥（`/internal` 接口）
- `PRESENTATION_VISUAL_REVIEW_ENABLED`：是否对复杂 PPT 页面启用多模态排版审查
- `PRESENTATION_VISUAL_REVIEW_MODEL`：视觉审查模型，默认 `mimo-v2.6-pro`
- `PRESENTATION_VISUAL_REVIEW_MAX_SLIDES`：每份 PPT 最多送审的复杂页面数量，默认 6
- `PRESENTATION_VISUAL_REVIEW_TIMEOUT_SECONDS`：视觉审查总耗时上限，默认 75 秒；超时保留本地规则校验结果
- `PRESENTATION_CONTENT_MIN_CONCURRENCY` / `INITIAL_CONCURRENCY` / `MAX_CONCURRENCY`：逐页内容生成的自适应并发范围，默认 4 / 6 / 8；请求不稳定时自动降并发
- `PRESENTATION_CONTENT_RETRY_BUDGET`：失败页的独立尝试次数，默认 2，不会重跑已经成功的页面
- `PRESENTATION_CONTENT_BATCH_SIZE`：单次内容请求生成的页数，默认 1；MiMo 4096 Token 限制下不建议调高
- `PRESENTATION_AGENDA_MAX_TOKENS`：目录规划输出预算，默认 3072；正文内容仍保留 MiMo 4096 Token 上限

PPT 排版审查只选择代码、表格、流程、时间线、对比、案例和练习等复杂页面，并把候选页合并在一次
多模态请求中。Windows 本地使用 PowerPoint 导出图片；Docker/Linux 使用 LibreOffice 与 Poppler。
普通标题页和简单文字页不会调用视觉模型。

PPT 正文按页独立生成并通过内容门槛后再写入大纲，失败时只补偿对应页。稳定学科主题会跳过
重复的工具决策模型调用；涉及最新、行业、政策、版本、就业等时效性内容时仍先检索再规划目录。
演讲者备注会在排版前统一检查：目录页和章节页改为自然口播转场，正文页承接相邻主题；
“介绍本页”“引导学生”“讲解时需强调”等写给讲者看的指令会转换为可直接朗读的讲稿，再用于 PPTX 备注与 TTS。
口播只使用“首先、接下来、随后、然后、最后”等简短页首连接词，并移除页尾的下一页预告。
目录在 1～5 章时使用单列，6～10 章使用双列单页，超过 10 章才分页。

## 本地测试

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
pytest -q
```

Windows 激活命令为：

```powershell
.venv\Scripts\Activate.ps1
```

## 单独启动

先设置长度不少于 32 字节的 `AGENT_INTERNAL_SECRET` 以及 `JWT_SECRET`，然后执行：

```bash
python main.py
```

默认监听 `8000`。生产环境应通过 HTTPS 入口暴露 `/v1`，`/internal` 不应对公网开放。

## Docker 联调

统一部署由 `src/backend/compose.yml` 管理：

```bash
cd src/backend
docker compose up -d --build
```

Compose 会把 agents 的 `8000` 映射到宿主机 `127.0.0.1:8100`（8000 被本机其他服务占用），前端直接访问该地址。
