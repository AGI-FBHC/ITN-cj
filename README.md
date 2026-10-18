# ITN-cj 仓颉版

`main` 保存当前 20889 测试站点使用的完整源码，包含两条已集成的仓颉后端开发线和 React 前端：

- `zyqprojects`：数据/Agent API 层，直接访问 MySQL，并带 `/api/v1`、`/v1`、`/internal/v1` 转发网关。
- `yjyprojects`：业务后端，覆盖认证、组织、管理员、学习者画像、成长报告等接口。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/`、`cjpm.toml` | zyq 的 Spire 服务（默认监听 `127.0.0.1:8100`） |
| `backend-cj/` | yjy 的业务后端（独立 cjpm 工程） |
| `deploy/` | 集成部署用的 compose、Nginx 配置 |
| `frontend/` | React + TypeScript + Vite 前端，包含动态资源失败恢复修复和回归测试 |

## 运行关系

```text
浏览器 :20889
  └─ Nginx
       ├─ /            → 前端静态文件
       └─ /api/v1 /v1 /internal/v1 → spire-api:8100（zyq）
            ├─ 已迁移路由 → MySQL itn_cangjie_dev
            ├─ 未迁移 /api/v1 → business-api:5000（yjy）
            └─ 未迁移 /v1    → itn-agents-v2:8000（Python agents）
```

两套仓颉服务共用同一个 `JWT_SECRET`，数据库使用 `itn_cangjie_dev`。
真实密钥只通过服务器上的 `0600` 环境文件注入，不进入 Git。

## 前端开发与验证

```bash
cd frontend
npm ci
npm run dev
```

生产构建和资源加载恢复测试：

```bash
cd frontend
node --test tests/chunkRecovery.test.mjs
npx vite build
```

`npm run build` 还会运行全量 `tsc -b`，现有分支仍有历史类型错误；当前上线构建使用 `vite build`。构建输出为 `frontend/dist/`，不提交到 Git。

## 本次纳入的版本

- 仓颉后端：`cangjie-integration` 的 `5b05a17`，已包含 zyq/yjy 合并及部署修复。
- 网页前端：`front` 开发线的 `e00384c`，包含功能修复 `e1232b7`；通过 Git subtree 导入 `frontend/` 并保留原提交历史。
- 开发分支继续保留；`main` 表示本次已部署版本，不自动包含开发分支后续新增的提交。

部署方式见 [deploy/README.md](deploy/README.md)，操作和验收记录见根目录 `TRACE.md`；前端历史记录保留于 `frontend/TRACE.md`。
