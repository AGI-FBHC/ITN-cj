# 开发与启动指南

仓库包含三套独立实现。先选择版本，再在该版本目录内配置依赖、数据库和模型服务。

| 版本 | 工作目录 | 仓颉工具链 | 主要依赖 |
| --- | --- | --- | --- |
| Pro | `versions/pro` | SDK 1.1.3 + 对应 STDX | Node.js、Python、MySQL；按部署方式准备 Agent 依赖 |
| Lite | `versions/lite` | SDK 1.2.0 + 对应 STDX | Node.js、MySQL；PPT / Logo 渲染需要 Python |
| Desktop | `versions/desktop` | Windows SDK 1.2.0 + 对应 STDX | OpenSSL、Node.js、Electron |

Windows 终端统一使用 PowerShell 7。下文所有 `cd` 均从总仓库根目录开始。

## Pro

```powershell
cd versions/pro
npm ci --prefix apps/web
npm run dev --prefix apps/web
```

前端需要已配置的仓颉 API 网关、业务服务与 Agent 服务。构建与部署按 [专业版 README](../versions/pro/README.md) 和 [部署指南](../versions/pro/deploy/web/README.md) 执行。

服务工程分别位于 `services/api`、`services/business`；不要把 Lite 的端口、数据库结构或 SDK 配置直接用于 Pro。

## Lite

```powershell
cd versions/lite
npm ci --prefix apps/web
npm run dev --prefix apps/web
```

另开终端进入同一个 `versions/lite` 目录，准备 `.env.local` 中的数据库、认证与邮件配置，再运行：

```powershell
.\scripts\run-backend.ps1
```

- `scripts/env.ps1` 默认从 `D:\cangjie-sdk\1.2.0` 加载工具链，可通过 `ZHIXUN_SDK_ROOT` 指定其他位置。
- `run-backend.ps1` 从脚本所在目录推导版本根目录，因此嵌入 `versions/lite` 后仍以本版本为运行目录。
- `ensure-local-mysql.ps1` 只负责启动已经配置好的本地实例，不会凭空初始化数据库。首次安装需按本版本的 schema / migrations 准备数据库。
- 前端默认 `127.0.0.1:3006`，学习 API 默认 `127.0.0.1:8312`；这是开发配置。
- 服务器部署按 [Lite 部署手册](../versions/lite/docs/deploy-6024.md) 执行。手册中的旧独立检出路径是原部署位置；从总仓库部署时，源目录改为 `versions/lite`，服务器运行目录保持按实际部署配置设置。

## Desktop

```powershell
cd versions/desktop
.\scripts\build.ps1
npm ci --prefix shell
npm start --prefix shell
```

`scripts/env.ps1` 管理仓颉 SDK、STDX 和 OpenSSL；构建产物由本版本脚本定位。内核构建失败时先检查工具链路径，桌面端启动还需要完成模型配置。

阅读 [PRODUCT.md](../versions/desktop/PRODUCT.md) 了解产品范围，修改代码前读取 [AGENTS.md](../versions/desktop/AGENTS.md)。桌面版内部 `docs/` 按原约定保留在本地，不由本次整合补入公开仓库。

## 路径与配置约定

- 本次导入保持各版本内部文件及相对目录完整，根目录仅提供导航和协作资料。
- 启动命令中的 `apps/`、`services/`、`core/` 等路径都相对于所选版本根目录，不是总仓库根目录。
- 现有独立检出和运行中的部署可以继续使用。切换到总仓库时，需要自行配置本机环境文件和数据目录；Git 不携带这些运行数据。
- `archive/legacy-main` 用于查阅与回溯，当前开发从 `versions/` 进入。
