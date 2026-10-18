# 仓颉业务后端

基于 Spire 实现的业务后端，沿用旧 `/api/v1/...` 接口路径和响应约定。

## 目录

| 目录 / 文件 | 用途 |
| --- | --- |
| `src/main.cj` | 服务入口与路由注册 |
| `src/controllers/` | HTTP 请求处理与响应 |
| `src/service/` | 业务逻辑及上游服务接入 |
| `src/repository/`、`src/database/` | 数据访问 |
| `src/security/` | 密码处理、JWT 等认证支持 |
| `cjpm.toml`、`cjpm.lock` | 构建配置与依赖版本 |
| `.env.example` | 本地环境配置示例 |

## 配置

首次将 `.env.example` 复制为 `.env`，填写实际配置：

- `DB_*`：MySQL 连接信息。使用已有业务表结构，本服务不会自动初始化数据库。
- `JWT_SECRET`：登录令牌签名密钥，至少 32 字节；与需要共用登录态的服务约定一致。
- `SMTP_*`、`EMAIL_FROM`：验证码邮件发送配置。
- `KNOWLEDGE_CORE_URL`、`KC_INTERNAL_SECRET`：知识服务地址与内部认证密钥。
- `AGENT_URL`、`AGENT_INTERNAL_SECRET`：Agent 地址与内部认证密钥。
- `RAG_ASSET_DIR`：可选，知识库图片目录。

真实 `.env` 不提交到仓库；上游地址和密钥须与对应服务一致。

## 本地启动

先加载仓颉 SDK 环境，设置 `CANGJIE_STDX_PATH`，并将 STDX、OpenSSL、MySQL 客户端动态库目录加入系统动态库搜索路径。

在 `src/backend-cj` 目录打开 PowerShell，执行：

```powershell
. .\load-db-env.ps1
cjpm build
cjpm run
```

服务地址以启动输出为准。`cjpm.toml` 中的 MySQL 库路径需按本机安装目录调整。Linux 部署通过运行环境注入变量，不执行 PowerShell 加载脚本。

## 旧前端连接

- `VITE_API_PROXY_TARGET` 指向本业务服务。
- `VITE_AGENT_BASE` 指向 Agent 服务。
- 修改前端环境配置后，重启前端开发服务器。

知识服务与 Agent 独立运行；资源生成、重新生成和交互课件文件清理等操作需要对应服务可用。

## 辅助脚本

| 脚本 | 用途 |
| --- | --- |
| `check-password-login.ps1` | 检查账号密码认证 |
| `test-login-api.ps1` | 检查密码登录接口与会话 |
| `test-account-features.ps1` | 注册、密码及验证码登录检查 |
| `test-guest-demo.ps1` | 游客和演示账号检查 |
| `setup-local-admin.ps1` | 创建本地管理员及邀请码 |

辅助脚本中的 SDK 和依赖路径需按本机调整。管理员初始化及部分检查脚本会写入数据库，按实际需要手动执行，常规启动无需运行。
