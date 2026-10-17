# Spring Boot 业务层迁移至仓颉 Spire

负责人：颜嘉怡。本目录是业务后端，接口主要保留旧 `/api/v1/...` 约定。服务入口见 `src/main.cj`。Agent 层及 KnowledgeCore 是独立服务，需共同联调。

## 版本与依赖

- 仓颉 SDK 1.1.3。
- STDX 1.1.3.1，与 SDK、操作系统、CPU 架构匹配。
- Spire 模块 1.0.20260528，依赖由 cjpm.toml/cjpm.lock 管理。
- MySQL：沿用旧业务表结构和迁移版本。本目录不自动初始化数据库；先与团队确认开发库结构、数据和权限。
- 运行依赖 MySQL 客户端动态库和 STDX/OpenSSL 动态库；Windows 的 cjpm.toml 当前使用 MySQL 8.4 默认安装目录，非默认目录需调整。Linux 链接 mysqlclient/dl，尚待服务器验证。

## 本地启动

1. 安装对应 SDK/STDX，并加载 SDK 的 envsetup.ps1（Linux 使用对应 SDK 环境脚本）。
2. 将 `.env.example` 复制为 `.env`，填写本机或团队开发库、JWT、SMTP及上游服务配置。JWT/内部服务密钥须与联调对象约定一致，示例占位符不能用于真实运行。
3. 设置 CANGJIE_STDX_PATH 为 STDX 动态库目录，并确保系统动态库搜索路径包含 STDX、OpenSSL、MySQL 客户端库目录。
4. Windows PowerShell 在本目录运行：

```powershell
. .\load-db-env.ps1
cjpm build
cjpm run
```

服务监听地址以 Spire 启动输出为准。旧前端 `VITE_API_PROXY_TARGET` 应指向该地址；`VITE_AGENT_BASE` 单独指向 Agent。配置变更后重启前端。加载脚本仅针对 PowerShell；Linux 部署需由部署环境注入相同变量，勿直接 source PowerShell 脚本。

已有 check-password-login.ps1、test-login-api.ps1、test-account-features.ps1、test-guest-demo.ps1 等为本地辅助脚本，其中 SDK/依赖路径采用原开发机目录；其他机器运行前需核对路径。setup-local-admin.ps1 会创建本地管理员和邀请码，仅在明确需要的本地开发库使用，常规启动不需要运行。

## 范围与状态

已包含账号注册/登录、游客/演示、画像/目标、学习进度/园子/复习、知识网络/路径和知识库读取、日历/能力/报告、机构与用户管理、重置学员、知识编辑接入层、资源分组/母版、审核发布及归档删除接口。

此前已分批编译并进行部分本地页面/脚本验证；不代表全部端到端验收通过。本次提交准备仅整理源码及配置，未重新运行完整测试。

### 联调待办

- KnowledgeCore 编辑代理需接通 KNOWLEDGE_CORE_URL/KC_INTERNAL_SECRET。知识库服务迁移/接入按团队分工协作处理。
- Agent 生成、重新生成、任务队列和完整课件预览/文件清理需接通上游。单条归档课件彻底删除依赖 Agent 成功；批量归档清理保留旧数据库 fallback，Agent 离线时可能遗留文件。
- 旧前端资源中心无审核发布操作入口，接口已提供，页面入口需前端协作；当前资源中心500仍待具体失败请求与日志定位。
- 旧机构 Logo 预览使用 img，缺少认证头，可能上传成功但无法显示，需前后端确认获取方式。
- 与 Agent 仓颉层统一 JWT、用户/机构 UUID、数据库字段与会话规则，核对同步文档中 UUID/JSON 修复是否适用。
- 日历、日志、小结等未覆盖的持久化完整流程，以及 Linux 云端构建部署，仍需联调确认。

本目录没有包含真实 `.env`、SDK/STDX、构建产物和数据库快照。不要上传含密码/API Key 的同步文档或本地环境文件。
