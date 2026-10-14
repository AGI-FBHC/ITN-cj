# 把 lumin 合并进 ITN-Desktop（上层桌面应用）

> lumin 先独立维护，最终要作为 **ITN-Desktop 的内核 Agent** 合并进去。
> 这篇只写给"合并的那一刻"，不需要读懂整个 lumin。

## 0. 合并前必须先做完的事

1. `.\.\scripts\test.ps1` 全绿（`cjpm test`）。
2. 真机跑通至少两条路径：纯对话、带工具（读文件 + 跑命令）。
3. `docs/roadmap.md` 里 A 类缺陷（会挡路的）修完 —— 它们是"用户真会撞到"的。
4. 确认没有把 `.env.local` / 真 Key / `target/` / `dist/` 带进去。

## 1. 分层照搬，包名改掉

| lumin 源 | 目标 | 包名变化 | 备注 |
| --- | --- | --- | --- |
| `src/pi/` | `core/src/pi/` | `lumin.pi` → `itn_desktop_core.pi` | 同包内直接可用，**不用加依赖** |
| `src/tools/` | `core/src/pi_tools/` | `lumin.tools` → `itn_desktop_core.pi_tools` | 内核原有 8 个工具各包一层 `Tool` 即可见 |
| `src/net/` | `core/src/net/` | `lumin.net` → `itn_desktop_core.net` | 联网只在这里 |
| `src/cli/` | 只取 `http.cj` / `permissions.cj` / `approvals.cj` / `trust.cj` / `workspaces.cj` / `util.cj` | | `chat.cj` 是给终端用的，**不要搬** |

要点：`pi` 层零网络零文件，搬过去可以直接用；**别把 `cli` 的 REPL 逻辑搬进去**，
桌面版的界面是 Electron，不是终端。

## 2. 把里面的 8 个内核工具接到 `Tool` 接口

`ToolSpec` 的字段是 `name / label / snippet / description / parameters(显式 JSON Schema) / risk`。
内核原有的 read / list / search / write / edit / run_command / current_time / calc 各包一层 `FuncTool`，
模型就能通过事件循环直接调用它们。

## 3. 接模型：照 `src/cli/http.cj` 写一个 `ChatProvider`

- 请求带 `tools`（来自 `ctx.tools` 的显式 schema）；
- 增量映射：`content` → `text_delta`、`reasoning_content` → `thinking_delta`、
  `tool_calls[].function.arguments` → `toolcall_delta`；
- 顺手记 `usage`（`usageIn/usageOut`），CLI 会把它显示在每轮末尾。

## 4. 接事件与会话

- 事件逐条写 `session_events` 表 —— `kindText()` 返回的就是类型名，直接当 `kind` 列；
- 会话文件直接用 Pi 的 JSONL 格式（`src/pi/session.cj`）：**续聊 / 回退 / 分叉 / 压缩全是现成的**，
  不用自己再设计一套；
- 界面要展示"正在想 / 正在调工具 / 正在写文件"时，读事件流就够了，别去解析模型原始 JSON。

## 5. 别丢的三样（丢了就等于退化成普通 chatbot）

1. **一步多调用**：一条 assistant 消息里的多个 `tool_calls` 要**都执行**，各自带 `tool_call_id`；
2. **工具结果回填**：结果正文要按 `tool_call_id` 回灌给模型，不能只显示在界面上；
3. **事件驱动**：界面状态由事件驱动，别轮询模型输出。

## 6. 合并后的验证顺序

1. `cjpm test`（lumin 的 62 例 + 内核原有测试）；
2. 内核侧端到端冒烟；
3. 桌面应用的 UI e2e；
4. 打包产物在干净机器上跑（不需要装仓颉）。
