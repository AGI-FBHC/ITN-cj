# 仓颉 API 服务

基于 Spire 的数据接口与转发网关，处理已迁移的学习数据接口，并将其余请求转交业务服务或现有 Agent 服务。

## 目录

- `src/`：路由、业务与数据访问实现。
- `config/sample.env`：环境变量示例。
- `resources/`：数据库结构及资源文件。
- `tmp_verify/`：接口验证脚本；部分检查会写入测试数据，应先确认目标数据库。
- `cjpm.toml`：仓颉 SDK 1.1.3 工程与依赖配置。

## 本地开发

在 `services/api/` 下构建，先加载仓颉 SDK 1.1.3，并将 STDX 静态目录写入 `CANGJIE_STDX_PATH`。数据库、JWT、上游地址及监听地址按 `config/sample.env` 配置，配置示例中的值不用于生产。

```powershell
Set-Location services/api
cjpm build
cjpm run
```

`SPIRE_HTTP_URL` 控制监听地址；开发配置通常使用 `http://127.0.0.1:8100`。账号与业务请求由 `services/business/` 承接，部分 Agent 请求需要现有 Python 上游可用。

Linux 容器构建与集成部署见 [Web 部署说明](../../deploy/web/README.md)。
