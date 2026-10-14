# lumin roadmap —— 已知差距与优先级

> 2026-10-14 整理。每条都写清"现状 / 差距 / 打算怎么做"，方便下次直接开工。

## A. 会挡路的缺陷（优先级最高）

### A1. `ask` 档读不到工作区外的 skills
- **现状**：skills 会扫 `~/.agents/skills` 这类工作区外的目录，启动时也**如实播报**了它们的名字与描述；
  可等模型真要 `read` 那个 `SKILL.md` 时，`ask` 档的沙箱把工作区外的路径拒了 —— 提示与实际能力不一致。
- **打算**：给"技能目录"开一个**只读白名单**（扫描时记下 `path`，`read` 命中白名单放行）；
  或者在 `ask` 档只播报工作区内的技能。前者更好，因为跨项目共享技能本来就是这个规范的设计意图。

### A2. 命令审批粒度只到"首词"
- **现状**：`command-dangerous` 的判定看的是命令的第一个词（`rm` / `del` / `format` …）。
  `pwsh -c "Remove-Item -Recurse -Force ..."` 这种把危险动作藏在参数里的写法判不出来。
- **打算**：加一层"参数级"启发式（先剥掉 `pwsh/cmd -c/-Command`，再对**内层**命令重跑首词判定），
  并把规则表放进配置文件，别硬编码在 `.cj` 里。

## B. 与 Pi 的真实差距（按价值排序）

### B1. MCP 客户端（**最该补的对外接口**）
- Pi 把外部工具生态交给 `packages/mcp`。我们补 MCP（JSON-RPC over stdio / HTTP）比"抄 TS 扩展宿主"划算得多，
  而且不用引 Node。补完就能直接接现成的 MCP server（filesystem / git / sqlite / 各家 SaaS）。
- 落点：`src/net/mcp.cj`（传输）+ `src/tools/mcp_tools.cj`（把 remote tool 包成 `Tool`，`risk=external`）。

### B2. 扩展 / 包管理
- Pi 的 extensions 是"TS 模块进程内装载"。我们是仓颉，形式要换：**注册表 + 配置文件 + 可选外部进程**。
- 现在 `Tool` 接口 + `ToolRegistry` 已经够用，缺的是"不改代码就能加工具"的装载路径 —— 这正是 MCP 的活（见 B1），
  所以扩展先不做，等 MCP 落地后再看还需要什么。

### B3. TUI / RPC / SDK
- 现在只有行式 CLI。定位就是"拿来测 harness"，界面由上层（ITN-Desktop 的 Electron shell）自己画。
- 若将来要做 GUI，**优先级**是先把事件流暴露成 JSONL（RPC），而不是做 TUI。

## C. 体验/工程细节（有空再收）

| 项 | 现状 | 影响 |
| --- | --- | --- |
| 带超时的命令输出是合并流 | 带 `timeout` 时走"重定向到临时文件"（stdout+stderr 合并）；不带超时时 `executeWithOutput` 给分离流 | 小，两条路径的差别写在 `workspace.cj` 注释里 |
| 子进程可能残留 | 超时后 `terminate(force)`，但它自己再拉起的孙进程管不到 | 与 Pi 相同量级 |
| 读操作不加锁 | 并行时可能读到"别人正在写"的半旧内容 | 与 Pi 相同（Pi 也只对写加 file-mutation-queue） |
| 编辑没有差异预览 | 只有一行 summary + 结果正文；Pi 有 `edit-diff.ts` + renderers | 要 UI 配合，纯 CLI 下意义不大 |

## C2. 安全取舍（写下来，免得后面有人以为漏了）

- **读不设限是刻意的**：只有两条红线（模型自己在用的含 Key 的配置、CLI 数据目录）。
  没有做"凭据启发式"（`id_rsa` / `*.pem` / `credentials` 之类）—— 那类名单永远列不全，
  而且假阳性会让正常读日志/配置也被挡。补偿手段是**可见性**：读到工作区外会把绝对路径打出来。
- 真要把敏感目录挡掉，推荐用它外层的手段：把工作区设在项目目录、或把密钥放到不在工作区里的地方。
- 联网（`web_search`）只在 `research` / `agent` 档才给，且 `ask` / `auto` 档每次问 ——
  这是"读到的东西别顺手发出去"的主要闸门。

## D. 明确不做的

多供应商登录（`/login`）、遥测、评测框架、durable/codemode、子 agent、plan mode。
> 前四个是 Pi 的独立包，与我们的定位无关；后两个 **Pi 自己也没有**（原话：*skips features like sub-agents and plan mode*），
> 所以"没做"不构成与 Pi 的差距。
