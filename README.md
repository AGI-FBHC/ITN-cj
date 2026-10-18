# ITN-cj 仓颉版

本仓库当前集成分支为 `cangjie-integration`，合并了两条并行开发线：

- `zyqprojects`：数据/Agent API 层，直接访问 MySQL，并带 `/api/v1`、`/v1`、`/internal/v1` 转发网关。
- `yjyprojects`：业务后端，覆盖认证、组织、管理员、学习者画像、成长报告等接口。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/`、`cjpm.toml` | zyq 的 Spire 服务（默认监听 `127.0.0.1:8100`） |
| `backend-cj/` | yjy 的业务后端（独立 cjpm 工程） |
| `deploy/` | 集成部署用的 compose、Nginx 配置 |
| `front` 分支 | React 网页前端源码 |

## 运行关系

```text
浏览器 :20889
  └─ Nginx
       ├─ /            → 前端静态文件
       └─ /api/v1 /v1 /internal/v1 → spire-api:8100（zyq）
            ├─ 已迁移路由 → MySQL itn_cangjie_dev
            ├─ 未迁移 /api/v1 → business-api:8080（yjy）
            └─ 未迁移 /v1    → itn-agents-v2:8000（Python agents）
```

两套仓颉服务共用同一个 `JWT_SECRET`，数据库使用 `itn_cangjie_dev`。
真实密钥只通过服务器上的 `0600` 环境文件注入，不进入 Git。
