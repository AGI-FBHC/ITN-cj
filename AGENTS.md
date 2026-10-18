# ITN-cj 协作约定

- 功能更新必须提交到本地 Git，保留可回滚的提交；不要用 `git reset --hard` 清理工作区。
- 新操作、对话重点、修改范围和验证结果统一追加到仓库根目录 `TRACE.md`。各组件已有 TRACE 保留为历史，不另开新的操作日志。
- Windows 终端使用 PowerShell 7。
- API Key、密码、私钥及真实环境文件不进 Git；示例配置使用占位值。
- `apps/web/` 是网页前端，`apps/desktop/` 是桌面应用；两个仓颉服务分别在 `services/api/` 和 `services/business/`。不要混用工具链：服务端当前为1.1.3，桌面端为1.2.0。
- 修改桌面端前读取 `apps/desktop/AGENTS.md`；修改 Lumin 内部代码还需遵循其目录内的约定。
- 移动目录或更改入口时同步修正相对路径、构建脚本及 README。验证应覆盖实际受影响的启动或构建路径，明确没有验证的部分。
