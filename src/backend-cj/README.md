# 仓颉业务后端

基于 Spire，沿用旧 `/api/v1/...` 接口。版本、分工和迁移进度见同步文档。

## 启动

加载仓颉 SDK 环境，配置 `CANGJIE_STDX_PATH` 及 MySQL、OpenSSL 动态库路径。

首次将 `.env.example` 复制为 `.env`，填写数据库、JWT、SMTP 和上游服务配置，然后在本目录执行：

```powershell
. .\load-db-env.ps1
cjpm build
cjpm run
```

## 配置注意

- 使用已有业务表结构，本目录不会自动初始化数据库。
- 前端 `VITE_API_PROXY_TARGET` 指向本服务，`VITE_AGENT_BASE` 指向 Agent；修改后重启前端。
- JWT 和内部服务密钥需与联调服务保持一致，真实 `.env` 不提交。
- `cjpm.toml` 中的 MySQL 库路径、辅助脚本中的 SDK 路径需按本机调整。
