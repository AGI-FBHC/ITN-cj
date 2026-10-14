# Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。
lumin 目前是 `0.x`，**对外契约（事件名 / 工具 schema / 会话 JSONL）在 1.0 前仍可能微调**。

## [Unreleased]

### Added
- **中途插话（Pi 的 steering）**：读键盘改成**单独一个线程**（`src/cli/lines.cj` 的 `LineQueue`），
  模型跑着的时候你也能直接打字 —— 普通句子在下一次模型请求之前插进当前这一轮；
  斜杠命令等这一轮跑完再执行；`/stop` 让这一轮在当前这句回复说完后停下（`Agent.abort()`）。
- 审批提示走同一个队列（`Approver.nextLine`）—— 否则它会跟读键盘的线程抢 stdin。

### Changed
- **读写策略分开：沙箱只隔离写，不隔离读。** 三个档位现在调的是**写**：
  `ask` 写只在工作区（越界要批准）、`auto` 写不限（风险操作才问）、`full` 不问。
  读在任何档位都不设边界，只保留两条红线 —— 模型自己在用的那份配置（含 API Key）、CLI 自己的数据目录。
  读工作区外时 CLI 会把绝对路径打出来并标 `(工作区外)`，用可见性代替拦截。
  理由：读不改用户的东西，而"文件在哪、写了什么"是干活的前提；把读也关起来只会让模型靠猜。

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
- **单元测试 70 例**（`cjpm test` 全绿），覆盖事件流 / 会话树与分叉 / 压缩 / 并行执行 / 截断字节安全 /
  7 个工具的边界 / 沙箱越界 / 命令超时 / skills 扫描 / 流式解析分片无关性 / 权限档位与审批 / Tavily 结果形状。

### Fixed
- **`lumin` 启动器在 cmd.exe 里报 `'m' 不是内部或外部命令`**（真机撞到）：`bin\lumin.cmd` 里有中文注释 +
  `chcp 65001`，cmd.exe 会把自己的文件位置读错、把行的中段当命令执行。现在启动器**纯 ASCII**（用 `goto` 而非
  `if/else` 块），`package-demo.ps1` 生成的两个启动器也改成 ASCII + CRLF，并加了会 throw 的写入函数 +
  `verify-clean.ps1` 的全仓批处理体检（非 ASCII 或裸 LF 直接失败）。
- 读键盘的线程上线后，审批提示还是直接 `readln()`，两边抢同一个 stdin —— 谁先抢到谁读到，
  审批可能永远等不到回答。现在统一走 `LineQueue.takeBlocking()`。
- `takeBlocking` 一次拿到多行（粘贴/管道）时把剩下的按**倒序**塞回队尾，会把粘贴的多行顺序搞乱；
  单测逮到后改成正序。
- `ask` 档"越界写"以前是**自相矛盾**的：审批层问过、用户批了，工具层又被沙箱拒。
  现在批准过的目录会登记进本次会话的写白名单（`Approver.applyApproval`），批了就真能落盘。
- 审批分类用的路径前缀是**字符串**比较，`<工作区>/../outside/x.md` 会被误判成"工作区内"，
  于是该弹的审批不弹、工具层又拒绝 —— 用户只看到一个失败。现在先折叠 `.` / `..` 再比。
- Key 红线可以被 `..` 绕过（`<目录>/sub/../.env.local` 字符串上不等于 `<目录>/.env.local`）。
  红线比较前统一折叠路径段。
- `/workspace open` 换工作区时用的是两参构造，会把权限档位和 Key 红线**悄悄重置成默认**。
- 读操作不再返回工作区外的相对路径（`../../..` 拼出来的怪路径），外面一律显示绝对路径。

### Known Issues
见 [`docs/roadmap.md`](docs/roadmap.md)。两条会挡路的：
- `ask` 档下工作区外的 skills 能播报但读不到（白名单缺失）；
- 命令审批的危险判定只到"首词"，`pwsh -c "Remove-Item -Recurse -Force …"` 判不出来。

[Unreleased]: https://github.com/SuanXiangJi/lumin/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SuanXiangJi/lumin/releases/tag/v0.1.0
