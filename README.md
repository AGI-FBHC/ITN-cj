# ITN

基于仓颉开发的 ITN（Intelligent Training Nexus）新版本，提供 Web 学习平台与本地桌面 Agent 工作台。

本项目延续[原 ITN 项目](https://github.com/AGI-FBHC/ITN)的个性化学习与智能教培方向，使用仓颉开发服务端和桌面本地内核，并分别通过 React 网页和 Electron 桌面应用提供交互界面。

## Web 与 Desktop

| | Web 网页版 | Desktop 桌面版 |
| --- | --- | --- |
| 使用方式 | 通过浏览器访问部署好的平台 | 在 Windows 本机运行桌面应用，应用名为 Lumin |
| 使用场景 | 在线学习、训练与组织管理 | 个人学习、资料管理与本地 Agent 工作流 |
| 运行组成 | React 前端、仓颉 API 与业务服务 | Electron 外壳、仓颉本地内核与 Lumin Agent 运行时 |
| 数据存储 | 服务端 MySQL | 本机 SQLite、文件与会话记录 |
| 模型接入 | 由服务端配置与接入 | 由用户配置模型接口 |
| 开发入口 | [Web 说明](apps/web/README.md) | [Desktop 说明](apps/desktop/README.md) |

### Web 网页版

网页版提供学习内容、知识网络、笔记、错题和成长记录等入口，并通过服务端处理账号、组织、学习者画像与学习数据。仓颉服务承担 API 网关和业务处理，部分尚未迁移的 Agent 能力继续接入现有 Python 服务。

### Desktop 桌面版

桌面版面向个人学习与内容生成，将本地资料、知识库、对话、学习资源和学习记录组织在同一工作台。仓颉内核处理本地业务，Lumin 提供 Agent 执行能力，Electron 负责窗口、界面和系统集成。

桌面端使用独立的本地数据目录。模型请求与联网操作仍可能把任务所需内容发送给用户配置的远程服务。产品定位与演进方向见 [Desktop 产品说明](apps/desktop/PRODUCT.md)。

## 项目结构

```text
ITN-cj/
├── apps/
│   ├── web/                 # React 网页前端
│   └── desktop/             # 桌面应用
│       ├── core/            # 仓颉本地业务内核
│       ├── shell/           # Electron 外壳与界面
│       ├── lumin/           # 仓颉 Agent 运行时
│       ├── scripts/         # 构建与打包
│       ├── tools/           # 检查与测试工具
│       └── third_party/     # 桌面端依赖源码与许可
├── services/
│   ├── api/                 # 仓颉 API 与转发网关
│   └── business/            # 仓颉业务服务
├── deploy/
│   └── web/                 # Web 部署配置
├── docs/                    # 跨端架构与开发说明
├── AGENTS.md                # 仓库协作约定
└── TRACE.md                 # 操作与验证记录
```

## 开始开发

先检出仓库：

```bash
git clone https://github.com/AGI-FBHC/ITN-cj.git
cd ITN-cj
```

- **开发网页界面**：从 [apps/web/README.md](apps/web/README.md) 开始，配置后端地址后启动 Vite。
- **开发桌面应用**：从 [apps/desktop/README.md](apps/desktop/README.md) 开始，准备仓颉工具链、构建本地内核并启动 Electron。
- **开发服务端**：分别查看 [API 服务](services/api/README.md)和[业务服务](services/business/README.md)。
- **部署网页版**：查看 [Web 部署说明](deploy/web/README.md)。

Web 服务端当前声明仓颉 SDK **1.1.3**，Desktop 内核与 Lumin 声明 **1.2.0**。各组件独立配置工具链和依赖；完整应用还需要对应界面运行时、数据库与模型服务。

## 文档

- [整体架构](docs/architecture.md)
- [开发与验证](docs/development.md)
- [Desktop 产品定位](apps/desktop/PRODUCT.md)
- [Desktop 使用说明](apps/desktop/docs/07-使用说明.md)
- [原 ITN 仓库](https://github.com/AGI-FBHC/ITN)

当前仍在推进仓颉迁移与两端开发。已知构建限制和组件准备步骤写在各端 README 中，设计文档中的规划能力以对应实现和验证结果为准。
