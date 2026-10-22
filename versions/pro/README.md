# 智训云枢 · 专业版

> 面向个性化学习的在线学习平台。前端 React 19；后端核心由 **仓颉（Cangjie）** 编写，其中 **API 网关是基于仓颉 Spire 框架实现的**——路由、鉴权、学习数据接口与上游转发都在 Spire 服务里完成，内容生成与多智能体编排由 Python Agent 服务补充。

<p>
<img alt="Cangjie" src="https://img.shields.io/badge/Backend-Cangjie%201.1.3-1F6F4A">
<img alt="Spire" src="https://img.shields.io/badge/Gateway-Spire%20Framework-2E7D5B">
<img alt="React" src="https://img.shields.io/badge/Frontend-React%2019-149ECA">
<img alt="Vite" src="https://img.shields.io/badge/Build-Vite%207-646CFF">
<img alt="Nginx" src="https://img.shields.io/badge/Deploy-Nginx%20%2B%20Compose-009639">
</p>

---

## 目录

- [整体架构](#整体架构)
- [仓颉后端 · Spire](#仓颉后端--spire)
- [接口约定](#接口约定)
- [目录结构](#目录结构)
- [本地开发](#本地开发)
- [构建](#构建)
- [部署](#部署)
- [发布与回滚](#发布与回滚)
- [验证清单](#验证清单)
- [工程约定](#工程约定)
- [常见问题](#常见问题)

## 整体架构

```text
浏览器
  │  HTTPS
  ▼
Nginx（静态站点 + 同源代理）
  ├─ /               → apps/web 构建产物（dist）
  ├─ /api/**         → services/api       （仓颉 Spire · API 网关）
  ├─ /v1/**          → services/api       （仓颉 Spire · 转发业务 / 智能体）
  └─ /internal/**    → services/api       （仅服务间，禁止对外暴露）
        │
        ├─ services/business   （仓颉 · 账号 / 组织 / 学习者 / 游客）
        ├─ MySQL               （业务数据、学习记录）
        └─ Python Agent 服务   （内容生成、多智能体、对话、PPT）
```

分层原则：

- **前端只做渲染与交互**，所有数据经仓颉服务读写，不直连数据库；
- **仓颉服务是唯一业务入口**，鉴权、归属校验、写库都在这一层完成；
- **Python Agent 只做生成与编排**，不承担账号与权限判断。

## 仓颉后端 · Spire

平台的 **API 网关就是仓颉 Spire 服务**（`services/api`，包名 `itn_spire`）：用 Spire 的 `WebHost` 直接注册路由，把已迁移的读写接口就地实现，其余请求转发给业务服务或 Agent 服务——同一套 JWT、同一份错误信封，前端无需感知后端是哪种语言。

两个仓颉服务均为 `cjpm` 工程，`cjc-version = "1.1.3"`，统一依赖 `soulsoft_web_http / routing / hosting / extensions_injection`：

| 服务 | 工程 | 职责 | 默认端口 | 健康检查 |
| --- | --- | --- | --- | --- |
| **Spire API 网关** | `services/api` | Spire 路由、鉴权、学习资源、讲义/实操/分阶题、转发业务与 Agent | `8100` | `GET /health` |
| 业务服务 | `services/business` | 登录与 JWT 签发、组织、学习者画像、游客体验、邮件验证码 | `5000` | `GET /hello` |

### Spire 入口与分层

```cangjie
// services/api/src/main.cj
main(): Int64 {
    let cfg = AppConfig()
    let builder = WebHost.createBuilder(getCommandLine())
    builder.services.addRouting()
    let app = builder.build()

    app.mapGet("health") { ctx =>
        ctx.response.contentType = "text/plain; charset=utf-8"
        ctx.response.write("ok")
    }

    registerNotesRoutes(app, cfg)          // 笔记 / 分类
    registerWrongAnswerRoutes(app, cfg)    // 错题本
    registerResourceRoutes(app, cfg)       // 学习资源
    registerLearnerCourseRoutes(app, cfg)  // 我的课程 + 热学榜
    registerCourseRoutes(app, cfg)
    registerAgentSessionRoutes(app, cfg)   // 伴学助手会话
    // …共 30+ 个 registerXxxRoutes 模块
}
```

按「路由 / 数据 / 转发」三件事分文件，新增能力时照此扩展：

| 文件后缀 | 职责 | 示例 |
| --- | --- | --- |
| `*_api.cj` | Spire 路由注册、参数解析、鉴权、统一响应 | `courses_api.cj`、`learner_courses_api.cj` |
| `*_store.cj` | 纯 SQL 访问层（MySQL），不做 HTTP 判断 | `courses_store.cj`、`chat_store.cj` |
| `*_proxy.cj` | 转发到业务服务 / Agent，超时与签名在这里处理 | `admin_knowledge_proxy.cj` |
| `gateway.cj` | 兜底转发与路由优先级 | — |

### 新增一个 Spire 接口

```cangjie
public func registerDemoRoutes(app: WebHost, cfg: AppConfig): Unit {
    app.mapGet("v1/demo/health") { ctx =>
        writeJson(ctx.response, 200, "{\"ok\":true}")
    }
    app.mapPost("v1/demo/items") { ctx =>
        /* 鉴权复用 http_util 的 requireUserApi：失败时它已写好 401 响应 */
        if (let Some(userId) <- requireUserApi(ctx.request, ctx.response, cfg)) {
            writeJson(ctx.response, 200, DemoStore(cfg).list(userId))
        }
    }
}
```

约定：路由挂在 `v1/**` 或 `api/v1/**` 下；响应统一 `{ code, message, data, timestamp }`（`writeJson` / `writeJsonEtag`）；异常走同一处 `BusinessException` 转信封，不在 handler 里拼字符串。

### Spire 侧的工程约束

- 编译必须显式指定 STDX 与动态库路径（见下方构建命令），否则 `soulsoft_*` 依赖链接失败；
- 监听地址由 `SPIRE_HTTP_URL` 决定（默认 `http://127.0.0.1:8100`），健康检查固定为 `GET /health`；
- 网关、业务服务与 Agent 服务**共用同一 `JWT_SECRET`**，否则令牌互不认可；
- 转发类接口带 HMAC 签名（`X-*-Signature`），密钥只从环境变量注入，不落仓库；
- 所有业务表按 `utf8mb4_unicode_ci` 统一排序规则，避免跨表 `UNION` 时的 collation 冲突；
- 二进制产物固定为 `target/release/bin/main`，部署脚本按此路径取包。

## 接口约定

| 前缀 | 提供方 | 返回形态 | 前端封装 |
| --- | --- | --- | --- |
| `/api/v1/**` | 仓颉 API 网关 | 统一信封 `{ code, message, data, timestamp }` | `request()`：自动拆包、非 0 抛错 |
| `/v1/**` | 仓颉 API / Agent | 直出 JSON 或 SSE 流 | `requestAgent()` / `requestAgentEtag()` |
| `/internal/**` | 服务间 | — | 前端不访问 |

- 鉴权：`Authorization: Bearer <accessToken>`，JWT 由业务服务签发；
- 缓存：列表接口支持 ETag，`304` 时复用本地数据；
- 流式：`/v1` 相关代理需关闭缓冲并放宽读超时（生成类请求可达数十分钟）。

## 目录结构

```text
.
├─ apps/web                 # React 19 + Vite 7 前端
│  ├─ src/pages             # 路由页面
│  ├─ src/components        # 业务组件（知识图谱、资源播放器、助手面板…）
│  ├─ src/context           # 登录、画像、智能体、笔记、成长
│  ├─ src/hooks             # 数据加载与缓存
│  └─ src/lib               # 接口封装与工具
├─ services/api             # 仓颉 · Spire API 网关（包名 itn_spire）
├─ services/business        # 仓颉 · 账号与业务服务
├─ services/python          # Python Agent 服务（FastAPI）
├─ deploy/web               # 构建脚本、Compose、Nginx、环境变量示例
└─ docs                     # 架构与开发说明
```

## 本地开发

**环境要求**：Node.js ≥ 20、npm、仓颉 SDK 1.1.3 + STDX、Python 3.11+、MySQL 8。

```bash
# 1) 前端
cd apps/web
npm install
cp .env.example .env.local     # 配好后端地址
npm run dev                    # http://localhost:3002

# 2) 仓颉 API 网关
source /opt/cangjie/envsetup.sh
export CANGJIE_STDX_PATH=/opt/stdx/linux_x86_64_cjnative/static/stdx
export JWT_SECRET=<与 business 一致>
export PLATFORM_DB_URL='mysql://user:pass@127.0.0.1:3306/<db>'
cd services/api && cjpm build && ./target/release/bin/main

# 3) 仓颉业务服务
cd services/business
cp .env.example .env           # 填数据库、JWT、SMTP 等
cjpm build && ./target/release/bin/main
```

前端开发服务器固定监听 `::`（双栈），并通过 Vite 代理把 `/api`、`/v1` 转发到后端，避免跨域：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `VITE_API_PROXY_TARGET` | `http://localhost:8080` | `/api` 代理目标 |
| `VITE_AGENT_BASE` | `http://localhost:8100` | `/v1` 代理目标 |
| `VITE_API_BASE` | 空 | 构建期接口前缀，仅跨域部署时需要 |

## 构建

### 一键构建（推荐）

```bash
bash deploy/web/build.sh
```

脚本在仓颉 SDK 镜像内编译两个服务，产物落到 `deploy/web/app/api/main`、`deploy/web/app/business/main`，随后手动构建前端：

```bash
cd apps/web
npm ci
npx vite build          # 产物：apps/web/dist/
```

> 前端全量 `tsc -b` 仍存在历史类型错误，构建以 `vite build` 为准；提交前请确保新增代码无类型问题。

### 镜像依赖

`build.sh` 使用两个预置镜像，需自行准备（包含 SDK、STDX 与原生依赖）：

- `itn-cangjie-sdk:1.1.3`：API 网关编译；
- `itn-cangjie-sdk:1.1.3-mysql`：业务服务编译（额外带 MySQL 客户端库）。

## 部署

### 方案一：Docker Compose（推荐）

部署目录约定：

```text
/opt/stack/
├─ docker-compose.yml
├─ nginx.conf
├─ app/api/main
├─ app/business/main
├─ web/dist/
└─ env/
   ├─ api.env
   └─ business.env
```

步骤：

```bash
# 1) 部署目录准备（env 只保留 0600 权限，不进 Git）
mkdir -p /opt/stack/{app/api,app/business,web/dist,env}
cp deploy/web/docker-compose.yml deploy/web/nginx.conf /opt/stack/
cp deploy/web/app/api/main      /opt/stack/app/api/
cp deploy/web/app/business/main /opt/stack/app/business/
rsync -a apps/web/dist/ /opt/stack/web/dist/
cp deploy/web/env/api.env.example      /opt/stack/env/api.env
cp deploy/web/env/business.env.example /opt/stack/env/business.env
chmod 600 /opt/stack/env/*.env

# 2) 启动
cd /opt/stack && docker compose up -d && docker compose ps

# 3) 健康检查
curl -fsS http://127.0.0.1:20889/health
```

要点：

- Compose 把 Web 入口映射到宿主机 `20889`，网关与业务服务不直接暴露到公网；
- 容器以只读根文件系统运行，仅挂载 `app/`、`web/dist/`、`nginx.conf`；
- `business` 需要访问宿主机 MySQL 时用 `host.docker.internal`（Compose 已配置 `host-gateway`）；
- Compose 引用了外部网络（见文件内 `networks` 段），首次部署需确认网段与 MySQL、Agent 容器地址一致。

### 方案二：裸机 + systemd

```ini
# /etc/systemd/system/itn-api.service
[Unit]
Description=Platform API (Cangjie)
After=network.target mysql.service

[Service]
WorkingDirectory=/opt/stack/app/api
EnvironmentFile=/opt/stack/env/api.env
ExecStart=/opt/stack/app/api/main
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

业务服务同理（`/opt/stack/app/business/main`，`/hello` 探活）。`deploy/web/deploy.sh` 提供了一个仅针对 API 的构建+替换辅助脚本，需要主机具备仓颉环境并已导出必要变量。

### Nginx 关键配置

```nginx
root /usr/share/nginx/html;
client_max_body_size 128m;

location /assets/ {
    add_header Cache-Control "public, max-age=604800, immutable";
    try_files $uri =404;
}
location = /index.html {
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    try_files $uri =404;
}
location /api/      { proxy_pass http://api:8100;      proxy_read_timeout 120s; }
location /v1/       { proxy_pass http://api:8100;      proxy_buffering off; proxy_read_timeout 7200s; }
location /internal/ { deny all; }
location /          { try_files $uri $uri/ /index.html; }
```

## 发布与回滚

前端必须**先补资源、后换 HTML**，避免已打开页面引用的哈希文件 404：

```bash
rsync -a --exclude=/index.html apps/web/dist/ /opt/stack/web/dist/
cp apps/web/dist/index.html /opt/stack/web/dist/index.html.next
mv /opt/stack/web/dist/index.html.next /opt/stack/web/dist/index.html
```

仓颉服务替换遵循 **stop → 覆盖二进制 → start**，不要在运行中直接覆盖：

```bash
systemctl stop itn-api
cp services/api/target/release/bin/main /opt/stack/app/api/main
systemctl start itn-api
```

回滚时保留上一版二进制与 `web/dist` 历史资源目录即可，无需重新构建。

## 验证清单

上线后至少验证以下四项，健康检查通过不代表业务可用：

1. `GET /health`（API 网关）、`GET /hello`（业务服务）返回 200；
2. 登录成功并拿到 `accessToken`，`GET /api/v1/learners` 能返回本人画像；
3. 学习页「我的课程 / 推荐资源」与数据库一致，空数据时展示空态；
4. `/v1` 流式接口可正常增量返回（关闭了代理缓冲）。

## 工程约定

- **数据以服务端为准**：学习记录、选课、资源、会话全部落库，前端不造演示数据；
- **空态不造假**：没有数据就展示空状态与下一步入口；
- **身份隔离**：登录态用 JWT；游客体验按设备分配独立身份，退出即清空服务端与本地缓存；
- **接口统一封装**：新增请求走 `apps/web/src/lib/api.ts`，页面不直接写 `fetch`；
- **配置不入库**：`env/` 下真实变量权限 `0600`，仓库只保留 `*.example`；
- **构建即检查**：前端 `vite build`、仓颉 `cjpm build` 必须通过后再提交。

## 常见问题

**仓颉编译报找不到 `soulsoft_*` / 链接失败**：确认已 `source /opt/cangjie/envsetup.sh`，且 `CANGJIE_STDX_PATH` 指向 `.../static/stdx`。

**前端请求 404 或一直转圈**：检查 Nginx 的 `/api`、`/v1` 反代目标与容器网络是否可达；`/v1` 生成类请求需要放长超时。

**登录后立刻被踢回登录页**：多为两个仓颉服务 `JWT_SECRET` 不一致或令牌过期。

**知识图谱空白**：浏览器未启用 WebGL 时降级为占位图，属预期行为。

**生成任务长时间无响应**：确认 `/v1` 关闭了 `proxy_buffering`，并检查 Agent 服务与 MySQL 连接。
