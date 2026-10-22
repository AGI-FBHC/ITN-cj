# ITN-cj 整体架构

ITN-cj 包含 Web 平台和 Desktop 本地应用。两端的源码放在同一仓库，分别构建和运行。

## Web

```text
浏览器
  → Nginx
      ├─ 静态页面 → apps/web 的构建产物
      └─ /api、/v1 → services/api
                         ├─ 已迁移数据接口 → MySQL
                         ├─ 业务请求 → services/business → MySQL
                         └─ 部分 Agent 请求 → 已有 Python Agent 服务
```

`services/api` 提供 Spire API 和转发网关；`services/business` 提供账号、组织、管理和学习者业务。两套服务使用兼容的登录令牌约定。模型与上游服务配置见组件 README 和部署文档，真实配置由运行环境注入。

## Desktop

```text
Electron shell
  → 仓颉本地内核 core
      ├─ 本机 SQLite、知识库、会话与产物
      ├─ Lumin Agent 运行时
      └─ 用户配置的模型与联网服务
```

Desktop 的业务与用户数据按本地应用组织，不能通过设置 Web 网关地址替代其内核。Lumin 目前保留在 `apps/desktop/lumin/`，后续若其他组件实际复用，再单独设计公共依赖与版本约定。

## 组件边界

| 组件 | 主要运行环境 |
| --- | --- |
| `apps/web` | Node.js/npm 开发构建；浏览器运行 |
| `services/api`、`services/business` | 仓颉 SDK 1.1.3 构建；当前集成部署使用 Linux 容器 |
| `apps/desktop/core`、`apps/desktop/lumin` | 仓颉 SDK 1.2.0，当前构建目标 Windows x64 |
| `apps/desktop/shell` | Electron |

目录整理保留组件内部布局和 Git 历史。两端界面与运行时各自构建，工具链按组件配置。
