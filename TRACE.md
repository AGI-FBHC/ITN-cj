# ITN-cj 仓颉版集成与部署记录

## 2026-10-18 会话目标

用户要求查看 GitHub 上已有分支，确定如何合并团队已完成的仓颉分支，并部署到腾讯云 `43.160.236.121`，通过 `http://43.160.236.121:20889/` 访问。

## 远端分支盘点

`git@github.com:AGI-FBHC/ITN-cj.git`：

| 分支 | 内容 |
| --- | --- |
| `main` | 仅 Initial commit |
| `front` | React 网页前端（942 条历史） |
| `full` | 旧版完整代码快照 |
| `yjyprojects` | 业务后端：认证、组织、管理员、学习者画像、成长报告等 |
| `zyqprojects` | 数据/Agent API：笔记、课程、会话、演示文稿、资源任务等，并带转发网关 |

`yjyprojects` 基于 `main`；`zyqprojects` 是独立根提交，二者无共同祖先，合并时必须 `--allow-unrelated-histories`。

## 集成方案

新建分支 `cangjie-integration`，以 `zyqprojects` 为基线合并 `yjyprojects`，采用“两套仓颉服务 + Nginx 统一入口”：

```text
浏览器 :20889
  └─ Nginx
       ├─ /                          → React 静态文件
       └─ /api/v1 /v1 /internal/v1   → itn-cj-api:8100（zyq）
            ├─ 已迁移路由            → MySQL itn_cangjie_dev
            ├─ 未迁移 /api/v1        → itn-cj-business:5000（yjy）
            └─ 未迁移 /v1            → itn-agents-v2:8000（Python）
```

这样避免把两个独立 `cjpm` 工程强行合成一个包，同时保留两边全部能力。

## 集成分支提交

- `1cf5ba4` merge `origin/yjyprojects`（仅 README 冲突，已重写为集成说明）
- `a788f2f` 把 yjy 工程从 `src/backend-cj` 移到 `backend-cj/`，避免根 `cjpm` 扫描两套源码
- `9792d4f` 给根 `cjpm.toml` 补 Linux 目标与 STDX 路径
- `779f397` 增加 `deploy/`（compose、Nginx、环境变量模板、构建脚本）
- `c662bba` 启动前 `source /opt/cangjie/envsetup.sh`，补运行时库路径
- `e10c28f` / `1b1d0a0` 业务服务统一 5000 端口；Nginx 保留缓存目录权限
- `2940f04` / `2715410` 修复 Linux 下 MySQL 文本长度读取（32/64 位差异）
- `d5bcad5` 固定部署网段 `172.28.0.0/24`，恢复通用错误信息

## 构建与部署

服务器目录：

```text
/home/ubuntu/itn-cangjie-stack/
  docker-compose.yml
  nginx.conf
  app/api/main
  app/business/main
  web/dist/
  env/api.env        # 0600
  env/business.env   # 0600
```

镜像：

- `itn-cangjie-sdk:1.1.3`：原有 SDK/STDX/Spire 镜像
- `itn-cangjie-sdk:1.1.3-mysql`：在其上安装 `default-libmysqlclient-dev`，供 yjy 链接 `-lmysqlclient`

关键构建命令：

```bash
docker run --rm -v /home/ubuntu/itn-cangjie-staging:/workspace itn-cangjie-sdk:1.1.3 \
  bash -lc 'source /opt/cangjie/envsetup.sh; export CANGJIE_STDX_PATH=/opt/stdx/linux_x86_64_cjnative/static/stdx; cd /workspace; cjpm build -i -j1'
```

yjy 使用 `itn-cangjie-sdk:1.1.3-mysql`，挂载 `backend-cj`。

前端：`front` 分支 `npm ci` 后 `npx vite build`。注意 `npm run build` 会先跑 `tsc -b`，当前分支存在历史类型错误，暂时用 `vite build` 产出。

## 部署时修复的问题

1. **Linux 目标缺失**：根 `cjpm.toml` 只有 mingw 配置，补 `x86_64-unknown-linux-gnu` 和 STDX `bin-dependencies`。
2. **运行时库缺失**：直接启动二进制报 `libcangjie-runtime.so` 找不到，compose 改为 `bash -lc 'source /opt/cangjie/envsetup.sh && exec /app/main'`。
3. **yjy 缺 MySQL 客户端库**：新建 `1.1.3-mysql` 镜像。
4. **业务服务端口**：`host.run()` 实际监听 5000（`HTTP_PORTS` 未生效），API 网关和健康检查统一改为 `business:5000`。
5. **Nginx 只读降权**：`cap_drop ALL` 时无法 chown 缓存目录，去掉 web 的 `cap_drop`，保留 `no-new-privileges`。
6. **MySQL 长度读取**：yjy 的 `mysql_fetch_lengths` 按 32 位读取，Linux x64 的 `unsigned long` 是 64 位，导致多列查询长度错位、`Invalid utf8 byte sequence`。改为按 C 字符串长度读取；`MySqlConnection` 和 `DbTransaction` 两处都修。
7. **zyq 不解析主机名**：其自研 MySQL 客户端只接受 IPv4 字面量，`host.docker.internal` 报 `IPv4 address too long`。compose 固定网段 `172.28.0.0/24`，环境文件使用 `172.28.0.1`。
8. **错误信息调试**：定位期间临时把异常信息放入 500 响应，修复后已回退为通用“服务器内部错误”。

## 线上验证（2026-10-18）

服务器容器：

- `itn-cj-api`：healthy
- `itn-cj-business`：healthy
- `itn-cj-web`：`0.0.0.0:20889->80`
- 旧演示容器 `itn-cangjie-web`：已停止，`restart=no`（可回滚启动）

接口冒烟（真实令牌）：

| 接口 | 状态 |
| --- | --- |
| `/` | 200 |
| `/health` | 200 |
| `POST /api/v1/auth/guest-login` | 200 |
| `POST /api/v1/auth/login` | 200（clean1 测试账号） |
| `/api/v1/learners` | 200 |
| `/api/v1/profile` | 200 |
| `/api/v1/rag/domains` | 200 |
| `/v1/notes` | 200 |
| `/v1/courses` | 200 |
| `/v1/course-progress` | 200 |
| `/v1/agent-sessions` | 200 |
| `/v1/presentations` | 200 |
| `/v1/customize-tasks` | 200 |
| `/v1/learning-resource-tasks` | 200 |
| `/v1/chat/sessions` | 200（转发 Python agents） |
| `POST /v1/notes` | 201 |
| `DELETE /v1/notes/{id}` | 204 |

公网访问 `http://43.160.236.121:20889/` 返回 200；Edge headless 等待 20 秒后截图确认已进入“智训云枢”登录页。

## 回滚

```bash
cd /home/ubuntu/itn-cangjie-stack
docker compose down
docker update --restart=unless-stopped itn-cangjie-web
docker start itn-cangjie-web
```

## 遗留

- `front` 分支 `npm run build`（`tsc -b`）有历史类型错误：`Learn.tsx`、`Report.tsx`、`Resources.tsx`、`SlidePlayer.tsx`、`Welcome.tsx`。当前部署使用 `vite build` 绕过，建议前端负责人单独修复。
- 服务器根盘使用率 92%，剩余约 9.6 GB；后续新增镜像/构建产物前需清理。
- 旧版 Vue 前端与 `full` 分支未部署，仍保留在 GitHub 供对照。