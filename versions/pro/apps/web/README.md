# ITN Web

ITN-cj 的 React 网页前端，提供学习、知识网络、笔记、错题、画像与成长记录等界面。网页通过同源 `/api/`、`/v1/` 请求接入服务端。

## 开发

需要 Node.js 与 npm。本仓库已使用 Node.js 22 构建验证。

```powershell
Set-Location apps/web
npm ci
Copy-Item .env.example .env.local
npm run dev
```

开发地址为 `http://localhost:3002`。启动前确认 `.env.local` 中的代理目标：

- `VITE_API_PROXY_TARGET`：处理 `/api` 请求。
- `VITE_AGENT_BASE`：处理 `/v1` 请求。

使用本仓库的仓颉 API 网关联调时，两项可指向同一个地址，例如 `http://127.0.0.1:8100`；联调远端环境时填写实际平台地址。修改后重启开发服务器。

## 构建与检查

```powershell
node --test tests/chunkRecovery.test.mjs
npx vite build
```

构建输出为 `dist/`。资源加载恢复测试覆盖自动重试次数、重复失败和存储异常，不能替代完整业务端到端验证。

`npm run build` 会先执行 `tsc -b`，当前仍有既有类型检查错误；现阶段静态包通过 `npx vite build` 生成。处理类型错误后，应恢复使用包含完整类型检查的构建流程。

部署步骤见 [Web 部署说明](../../deploy/web/README.md)。前端发版需要保留已有哈希资源，最后更新 HTML，避免已打开页面的懒加载资源失效。
