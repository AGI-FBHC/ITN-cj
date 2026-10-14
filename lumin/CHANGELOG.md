# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
lumin 目前是 `0.x`，**对外契约（事件名 / 工具 schema / 会话 JSONL）在 1.0 前仍可能微调**。

## [Unreleased]

### Added
- 独立的仓库骨架：`LICENSE`(MIT)、`.env.example`、`AGENTS.md`、`docs/roadmap.md`、`docs/merge-into-itn.md`。
- `samples/demo-workspace/`：一个自包含的示例工作区（含一份示例 skill），克隆下来直接 `lumin --workspace samples/demo-workspace` 就能玩。
- `scripts/env.ps1`：**不再依赖任何父项目**，自己找仓颉 SDK（`CANGJIE_SDK_ROOT` → `SDK_ROOT` → `D:\cangjie-sdk\1.2.0`）。

### Changed
- `scripts/{chat,demo,test,package-demo,run-demos}.ps1` 改为调用本仓库自己的 `env.ps1`。
- 仓库清理：移除散落的探针/临时产物；`.gitignore` 增补 `config/`、`.vscode/` 等。

## [0.1.0] —— 2026-10-14

首次成型的版本。用仓颉重写 Pi 的架构与数据格式（**不是源码移植**）。

### Added
- **事件模型 / 循环 / 会话全对齐 Pi**：10 个事件名（`agent_start` … `agent_end`）、
  turn = 一次模型请求 + 它的工具、steering / follow-up 两个消息注入点、
  JSONL 会话（`id`/`parentId` 树 + 续聊 / 分叉 / compaction）。
- **7 个工具**（名字与参数 schema 逐字对齐 Pi）：`read` / `write` / `edit` / `ls` / `find` / `grep` / `powershell`；
  `edit` 支持 `edits[]` 多段替换。
- **自动压缩**（`autoCompactBytes`，默认 120000 字节）+ **并行工具执行**（事件与历史仍按源顺序落）。
- **权限档位**（存 `<数据目录>/settings.json`）：`ask` 请求批准 / `auto` 帮我批准 / `full` 完全访问权限。
- **human-in-the-loop 审批**：按动作分类（`path-outside` / `command` / `command-dangerous` / `web`），
  四答 `y` 一次 / `s` 本次会话 / `a` 记住 / `n` 拒绝；每次决定写进会话（自定义 entry `lumin.approval`）。
- **Tavily 联网检索**（工具 `web_search`）：结果编号 `[W1]…` + 链接，正好喂给运行时的引用自检。
- **工作区管理**：`workspaces.json` 登记表 + `--workspace <名字|目录>` + `/workspace list|add|open|rm`。
- **项目信任**：`trust.json` 向上继承 + `/trust on|off|clear`。
- **Skills**：实现 Agent Skills 规范（`SKILL.md` + frontmatter），扫 `{工作区}/.pi/skills`、
  `{工作区}/.agents/skills`、`{数据目录}/skills`、`~/.agents/skills`；`/skill:<名字>` 强制加载。
- **CLI**：`/help /tools /skills /sessions /new /resume /compact /model /mode /permissions /approvals /workspace /trust /quit`。
- **单元测试 62 例**（`cjpm test` 全绿），覆盖事件流 / 会话树与分叉 / 压缩 / 并行执行 / 截断字节安全 /
  7 个工具的边界 / 沙箱越界 / 命令超时 / skills 扫描 / 流式解析分片无关性 / 权限档位与审批 / Tavily 结果形状。

### Known Issues
见 [`docs/roadmap.md`](docs/roadmap.md)。两条会挡路的：
- `ask` 档下工作区外的 skills 能播报但读不到（白名单缺失）；
- 命令审批的危险判定只到"首词"，`pwsh -c "Remove-Item -Recurse -Force …"` 判不出来。

[Unreleased]: https://github.com/SuanXiangJi/lumin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SuanXiangJi/lumin/releases/tag/v0.1.0
