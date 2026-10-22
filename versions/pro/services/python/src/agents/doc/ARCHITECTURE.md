# ITN Agent 服务架构

## 1. 迁移目标

Agent 服务采用独立 FastAPI 进程，保留“诊断 → 任务拆解 → 检索 → 生成 → 审核 → 裁决”的多智能体协同链路，同时与 Spring Boot 的用户认证和业务数据严格分离。

## 2. 服务边界

| 服务 | 职责 |
| --- | --- |
| Spring Boot | 用户、登录会话、用户画像、学习目标等管理接口 |
| FastAPI | Agent 编排、模型调用、普通对话、流式事件、运行记录和生成产物 |

FastAPI 不创建用户、画像和学习目标副本，只以只读方式查询平台 MySQL 获取运行所需的用户上下文。

## 3. 调用链

```text
前端
  → Spring Boot 登录并签发 JWT
  → 前端携带 JWT 直连 FastAPI /v1/**
  → FastAPI 校验 JWT 签名与有效期，解析 userId
  → FastAPI 只读查询 MySQL，校验 learningGoalId 归属并注入用户画像
  → Agent Workflow 执行并记录事件
  → SSE 流或普通响应直接返回前端
```

## 4. Agent 工作流

| 顺序 | Agent | 输出 |
| --- | --- | --- |
| 1 | Diagnosis | 学习者状态、能力和学习偏好摘要 |
| 2 | Task | 目标拆解、技能序列和资源要求 |
| 3 | Retrieval | 证据、引用和知识摘要 |
| 4 | Generation | 讲义、实操和测试候选内容 |
| 5 | Review | 缺陷、事实性和教学质量检查 |
| 6 | Judge | 最终内容、风险级别和裁决理由 |

所有 Agent 读写同一个 `WorkflowState`。单步失败会产生结构化错误事件，运行状态置为 `FAILED`，不会把服务端堆栈返回调用方。

## 5. 内部鉴权

Spring Boot 和 FastAPI 共享独立的 `AGENT_INTERNAL_SECRET`。签名原文为：

```text
HTTP_METHOD\nREQUEST_PATH\nTIMESTAMP\nNONCE\nUSER_ID\nSHA256(BODY)
```

签名使用 HMAC-SHA256 十六进制编码。FastAPI 拒绝过期时间戳、重复 nonce、非法 UUID 和不匹配签名。

## 6. 数据结构

Agent 服务只持久化：

- `agent_runs`：运行 ID、用户 ID、学习目标 ID、输入、状态、结果、错误和时间。
- `agent_events`：运行内的顺序事件，用于审计和流式过程回放。

当前使用独立 SQLite 文件满足单机部署；数据库路径挂载到 Docker Volume。扩展为多实例时应迁移至独立 MySQL/PostgreSQL，并把 nonce 防重放存储迁移至 Redis。

## 7. 对外直连模式（当前默认）

除内部 HMAC 模式外，服务现在默认以"共享 JWT 直连"方式对前端开放：

- 前端使用 Spring Boot 登录签发的同一个 Bearer Token 直接访问 `/v1/**`，不再经过 Spring Boot 透传
- `app/security.py` 的 `require_user_principal` 校验 JWT 签名与有效期，从 `sub` 提取用户 UUID；签名算法兼容 HS256/HS384/HS512（JJWT 会按密钥长度自动选择）
- `app/platform_db.py` 以只读方式连接平台 MySQL，agent-runs 会校验学习目标归属并把用户画像注入工作流上下文，前端无法伪造
- `/internal/v1/**` 的 HMAC 鉴权继续保留，供未来的服务间调用使用，不应对公网开放
- 密钥通过 `JWT_SECRET`（与 Spring Boot 相同）与 `PLATFORM_DB_URL` 注入，均保存在不提交仓库的 `.env` 中
## 6. 对话工具（Tools）

交互导学的普通对话（`/v1/chat`、`/v1/chat/stream`）由 `ChatAgent`（`app/services/chat_agent.py`）驱动，支持 function calling 工具调用循环：

```text
用户消息 → LLM（携带工具定义，流式）
  → 无 tool_calls：内容即最终回答，流式透出
  → 有 tool_calls：执行工具 → 结果追加上下文 → 再次调用 LLM（最多 CHAT_TOOL_MAX_ITERATIONS 轮）
```

工具统一注册在 `app/tools/`：

| 工具 | id | 说明 |
| --- | --- | --- |
| 互联网搜索 | `web_search` | Tavily API 检索，需配置 `TAVILY_API_KEY`，未配置时自动对 LLM 隐藏 |
| 网页抓取与提炼 | `url_fetch` | 抓取 URL 正文并围绕 focus 用 LLM 提炼要点 |

新增工具只需继承 `BaseTool` 并加 `@register_tool` 装饰器，工具的 id/description/参数 Schema 与 MCP tool 定义同构，后续如需接入 MCP Server 只需增加适配层。

工具调用过程通过 SSE 事件透出：`tool_call_started`（工具名与参数）和 `tool_call_completed`（成功标志与结果预览），前端据此展示工具执行状态。
