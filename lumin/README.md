# Lumin —— 照 Pi 的架构用仓颉写的 Agent 运行时

> **不是 Pi 的源码移植。** Pi 本体是 TypeScript（`github.com/earendil-works/pi`，MIT，v1.2.0，Node ≥22.19），
> 我们把它的**架构与数据格式**搬到仓颉里实现；语言不同，能搬的是设计与格式，不是代码。
> 对照表在 `docs/vs-pi.md`（按源码逐条核对，含我之前凭印象说错的两处更正）。

## 1. 现在和 Pi 对齐到什么程度

| 维度 | Pi | lumin（现状） |
| --- | --- | --- |
| 事件模型 | `agent_start / turn_start / message_start / message_update / message_end / tool_execution_start / tool_execution_update / tool_execution_end / turn_end / agent_end` | **同名同字段**；`message_update` 里带 `assistantEvent`（`text_delta / thinking_delta / toolcall_delta`） |
| 循环 | turn = 一次模型请求 + 它的工具；内层跑工具、外层接排队的消息 | **同结构**；steering 在请求前注入、follow-up 在"本该收工"时注入 |
| 工具 | `read / write / edit / ls / find / grep / bash / powershell`，参数是显式 JSON Schema | `read / write / edit / ls / find / grep / powershell`（Windows 上代替 bash），**参数 schema 逐字对齐**（含 offset/limit、edits[]、glob/ignoreCase/literal/context） |
| 工具结果 | `content`（给模型）+ `details`（给界面）+ `isError` | 同分工；另外多一个 `summary` 给 CLI 一行显示 |
| 会话 | JSONL + `id/parentId` 树 + 叶子分支 + compaction + fork | **同格式**（header v3、8 位十六进制 id、`compaction.firstKeptEntryId`、`model_change`、`session_info`） |
| 模型接入 | 二十多家 + `/login` | **只走 OpenAI 兼容**（刻意的，一层适配） |
| Skills | Agent Skills 规范：`SKILL.md` + frontmatter，启动只播 name/description/location，正文按需 read | **同规范同播报格式**（`<available_skills>`）；支持 `disable-model-invocation` 与 `/skill:<名字>` 强制 |
| 界面 | TUI + print + JSON + RPC + TS SDK | **行式 CLI**（定位就是"拿来测 harness"）；斜杠命令与 Pi 同形 |
| 权限 | project trust + 进程自身系统权限（**没有逐条审批**） | 工作区沙箱（越界拒）+ 工具集白名单 + `--allow-exec`（比 Pi 默认更紧） |
| 压缩 | 自动 compaction 钩子 | **手动 `/compact`**（同样写 compaction entry，上下文组装也认它） |
| 扩展 | TS 扩展进程内装载 / MCP / 包管理 | 没有（`Tool` 接口 + 注册表；MCP 未做） |

仍然不做的：TUI、RPC/SDK、多供应商、遥测、评测、子 agent（Pi 也没有）、plan mode（Pi 也没有）。

## 2. 分层（为合并而分）

| 包 | 目录 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `lumin.pi` | `src/pi/` | 运行时：事件流、消息、会话、循环、工具接口、提示词 sections、skills、流式解析 | 零网络、零业务 |
| `lumin.tools` | `src/tools/` | 真实工具 + 工作区沙箱 + 截断策略 | std.fs / std.process / std.regex |
| `lumin.cli` | `src/cli/` | OpenAI 兼容提供方（SSE + 重试）+ 命令行界面 | stdx.net.http/tls |

## 3. 跑起来

    ...\lumin\scripts\chat.ps1                      # 连真实模型（读 .env.local 里的 Key）
    ...\lumin\scripts\package-demo.ps1              # 打绿色包：双击「运行演示.cmd」/「对话.cmd」
    pwsh -File ...\lumin\scripts\run-demos.ps1      # 并行跑一组演示，每段落日志 + 汇总

配置（命令行 > 环境变量 > `.env.local` > 默认）：`LUMIN_KEY / LUMIN_BASE / LUMIN_MODEL / LUMIN_MODE / LUMIN_WORKSPACE / LUMIN_DATA / LUMIN_ALLOW_EXEC`

CLI 命令（与 Pi 同形）：`/help /tools /skills /sessions /new /resume <id> /compact /model <名字> /mode <档位> /skill:<名字> /quit`

工具集四档（这是 DeepSeek 那套"模式=工具集"，Pi 本身没有 mode）：`chat`（不给工具）/ `standard`（文件读写，默认）/ `research`（+联网）/ `agent`（+跑命令）。

## 4. 测试（51 例，`cjpm test` 全绿）

- **事件流**：顺序、on 不重放、drain 只取一次、finish/fail/abort、事件 JSON 字段名与 Pi 一致。
- **会话**：JSONL 形状（header + 每行一条 entry + id/parentId 链）、重新载入后分支一致、**分叉**（回到旧 entry 再追加）、**compaction**（摘要替代旧消息、原文留档）、model_change/session_info、按目录分文件、toolResult 的 callId/isError 往返。
- **工具**：read（整文件 + offset/limit）、write 往返、edit（多段替换 / 找不到 / 不唯一都拒）、ls、find（glob）、grep（正则 / literal / ignoreCase / glob 过滤）、**越界一律拒**、命令工具被 `--allow-exec` 门住、真跑 PowerShell（含中文不乱码、退出码）。
- **循环**：完整事件序列（agent_start → turn_start → message_* → tool_execution_* → turn_end → agent_end）、**一条 assistant 里两条工具调用都执行且各自有 tool_call_id**、beforeToolCall 拦截、工具失败不中断、模型报错不抛、最大轮数、steering 注入点、follow-up 注入点、resume 的前置校验、系统提示词快照写进会话；**自动压缩**（超阈值才压、压完上下文改用摘要）；**并行执行**（两个各睡 300ms 的工具并发跑，总墙钟 < 600ms，事件与结果仍按源顺序）。
- **自动压缩**：上下文超阈值时自动压（写 compaction entry、上下文改用摘要）、没超阈值时不压。
- **并行执行**：两个各睡 300ms 的工具并发跑，总墙钟 < 600ms（顺序执行必然超），且事件与工具结果仍按源顺序落地。
- **命令超时**：`ping -n 6` 给 1 秒超时 → 判定超时、杀子进程、耗时 < 4 秒；正常命令带超时照样拿到退出码与输出。
- **Skills**：扫描、frontmatter 校验（缺 name/description 跳过）、播报只带 name/description/location、`disable-model-invocation` 只手动可触发。
- **流式解析**：分片无关性、截断缓冲不抛、字节安全（汉字不被切断）、转义引号、原生 arguments 形态。

## 5. 真机验证（mimo-v2.6-flash）

- 「列文件 + 读 readme.md 说三要素」：**3 轮 3 次工具调用**答对（并行 ls+read），用量 8475/187 tokens。
- 「跑命令 + 算数」（agent 档 + `--allow-exec`）：一步并行两条调用，2 轮 0 失败。
- 越界读 `../../windows/win.ini`：被拒，模型如实转述。
- 无 Key / 错 Key / 429 限流：分别给出配置指引 / 401 原文 / 退避重试（实测有一次 115 秒才成功）。
- 并行工具（agent 档，ls + powershell echo）：一步两条，2 轮 0 失败。

## 6. 已知差距（按影响排序）

1. **没有 MCP / 扩展装载**：要长工具生态得走 MCP 客户端（JSON-RPC，不引 Node 也能做）。
2. **没有 TUI / RPC / SDK**：只有单一 CLI，桌面版会自己画界面。
3. **超时路径的输出是合并流**：带 `timeout` 时走"重定向到临时文件"（stdout+stderr 合并，与 Pi 的 bash 一致），不带超时时
   `executeWithOutput` 会给分离的 stdout/stderr；两条路径的差别写在 `workspace.cj` 注释里。
4. **子进程可能残留**：超时后我们会 `terminate(force)`，但它自己再拉起的孙进程管不到（Pi 也差不多）。
5. **读操作不加锁**：并行时读到"别人正在写"的半旧内容是可能的（Pi 同样如此，只对写加了 file-mutation-queue）。

## 7. 合并进 ITN-Desktop

1. **搬运行时**：`src/pi/` → `core/src/pi/`，包名 `lumin.pi` → `itn_desktop_core.pi`（同包，不用加依赖）。
2. **搬工具与沙箱**：`src/tools/` → `core/src/pi_tools/`；内核原有 8 个工具各包一层 `Tool`（`ToolSpec` 字段：name/label/snippet/description/parameters/risk）。
3. **接模型**：照 `src/cli/http.cj` 给内核 `llm.cj` 写 `ChatProvider`：请求带 `tools`（来自 `ctx.tools` 的显式 schema），增量里 `content`→`text_delta`、`reasoning_content`→`thinking_delta`、`tool_calls[].function.arguments`→`toolcall_delta`；顺手记 `usage`。
4. **接事件与会话**：事件逐条写 `session_events`（`kindText()` 就是类型名）；会话文件可直接用 Pi 的 JSONL 格式（`session.cj`），续聊/分叉/压缩都是现成的。
5. **别丢三样**：一步多调用、`tool_call_id` 回填、工具结果正文回灌。
6. **验证顺序**：`cjpm test`（47 例）→ `tools/ui-e2e.cjs` + `ui-shot.cjs` → `scripts/build.ps1` + `package.ps1`。
