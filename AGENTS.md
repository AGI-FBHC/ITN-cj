# ITN-cj 协作约定

- 功能更新必须提交到本地 Git，保留可回滚的提交；不要用 `git reset --hard` 清理工作区。
- 新操作、对话重点、修改范围和验证结果统一追加到仓库根目录 `TRACE.md`。各组件已有 TRACE 保留为历史，不另开新的操作日志。
- Windows 终端使用 PowerShell 7。
- API Key、密码、私钥及真实环境文件不进 Git；示例配置使用占位值。
- 三个版本分别位于 `versions/pro/`、`versions/lite/`、`versions/desktop/`。进入版本目录后再使用其相对路径与构建命令；`archive/legacy-main/` 是整合前 main 的完整历史快照，不作为新的开发入口。
- 工具链按版本隔离：Pro 的仓颉服务使用 1.1.3；Lite 和 Desktop 使用 1.2.0。数据库、环境文件、构建目录也由各版本分别管理。
- 修改版本内部代码前读取该目录的 `AGENTS.md`（如有）；修改 Lumin 内部代码还需遵循其目录内的约定。新操作只追加到根 `TRACE.md`，版本自带 TRACE 保留为来源历史。
- 版本整合使用保留完整历史的 subtree / merge commit；不要 squash 导入、改写原提交作者或 force-push main。整合来源和快照标签见 `docs/REPOSITORY.md`。
- 移动目录或更改入口时同步修正相对路径、构建脚本及 README。验证应覆盖实际受影响的启动或构建路径，明确没有验证的部分。
