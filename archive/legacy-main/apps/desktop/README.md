# ITN Desktop（Lumin）

ITN-cj 的本地桌面 Agent 工作台，主要面向个人学习、资料管理和学习内容生成。仓颉本地内核处理业务与数据，Lumin 提供 Agent 运行时，Electron 提供窗口和系统集成。

桌面端在本机保存知识库、会话、学习记录与产物；调用远程模型或联网工具时，会按配置与权限向对应服务发送任务所需内容。产品定位与规划见 [PRODUCT.md](PRODUCT.md)。

## 组成

| 目录 | 内容 |
| --- | --- |
| `core/` | 仓颉本地业务内核、HTTP 接口和 SQLite 存储 |
| `shell/` | Electron 主进程、窗口与界面资源 |
| `lumin/` | 仓颉 Agent 运行时 |
| `third_party/` | SQLite 驱动等依赖源码与许可 |
| `scripts/` | 环境、构建、打包和发布辅助脚本 |
| `tools/` | 单项检查、mock 和端到端验证工具 |

## 环境

当前桌面构建目标为 Windows x64，需要：

- PowerShell 7。
- 仓颉 SDK **1.2.0**、对应 STDX 与 OpenSSL 3。
- Node.js 与 npm，用于安装和运行 Electron 外壳。

`scripts/env.ps1` 默认从 `D:\cangjie-sdk\1.2.0` 加载 SDK、STDX 和 OpenSSL。自定义安装位置时，先在当前 PowerShell 会话设置 `$SdkRoot`，再加载环境脚本。Web 服务端的1.1.3工具链与本地内核所需的版本不同。

## 构建与运行

以下命令从仓库根目录进入桌面项目后执行：

```powershell
Set-Location apps/desktop
pwsh -NoProfile -File ./scripts/build.ps1
pwsh -NoProfile -File ./scripts/package.ps1
Set-Location shell
npm ci
npm start
```

内核包位于 `dist/core/`。Electron 开发入口会从该目录启动内核，并加载 `shell/renderer/` 中的界面。

如果 SDK 安装在其他位置，可直接在当前会话加载环境并构建，再执行打包脚本：

```powershell
# 在 apps/desktop 目录中
$SdkRoot = 'D:\your-cangjie-sdk\1.2.0'
. ./scripts/env.ps1
Push-Location core
cjpm build
Pop-Location
./scripts/package.ps1
```

## 桌面应用打包

完整打包需要先安装 `shell/` 的 npm 依赖，并准备随包的 PPT 渲染运行时。以下命令仍从 `apps/desktop/` 执行：

```powershell
pwsh -NoProfile -File ./scripts/prepare-ppt-runtime.ps1
pwsh -NoProfile -File ./scripts/package-app.ps1
```

默认输出为 `dist/Lumin/` 与 `dist/Lumin-win-x64.zip`。打包脚本会检查内核、运行库和预览依赖；模型接口与用户资料由使用者配置，不随源码分发。

## 验证

```powershell
# apps/desktop 下，先加载环境
. ./scripts/env.ps1
Push-Location core
cjpm test
Pop-Location

# 先按上文构建并打包内核，再检查本地接口路由
pwsh -NoProfile -File ./tools/api-route-smoke.ps1
```

`tools/` 中的检查分别覆盖界面、模型、知识库与生成流程。真实模型检查需要自行配置接口；mock 检查只验证所覆盖的调用和数据链路。

本目录的 `TRACE.md` 保留导入前历史。后续操作统一追加到[仓库根 TRACE](../../TRACE.md)，协作要求见 [AGENTS.md](AGENTS.md)。
