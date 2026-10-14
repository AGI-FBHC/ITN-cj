# Agent 接入 pi-cj（迁移方案）

> 状态：**方案，未开始迁移**。写于 2026-10-14。
> 背景：另一个会话在 `pi-cj/` 里按 Pi Agent 的架构重写了一个仓颉运行时（它的自述见 `pi-cj/README.md`），
> 目标是**替换掉现在这张手写的 agent 循环**。这份文档只回答一件事：**怎么接、接哪几个点、按什么顺序验证**。
>
> 读这份文档前先看：`pi-cj/README.md`（尤其第 7 节《合并清单》）与 `pi-cj/docs/vs-pi.md`。

> **版本注记（2026-10-14 复核）**：这份方案写完后，pi-cj 自己又做了一轮"按 Pi 源码对齐"的重构
> （`9b9242e refactor(pi-cj)!: 事件名/循环/会话树/工具 schema/skills`）。我重新核对了本文依赖的接缝：
> `ChatProvider.respond(StepContext, EventStream)`、`Tool.spec()/run()`、`ToolResult.modelText()`、
> 以及事件名（`agent_start/turn_start/message_*/tool_execution_*` 与 `text_delta/thinking_delta/toolcall_delta`）**都没变**；
> 变的是它内部实现与测试数（69 → 47 例）。接入时以 **`pi-cj/README.md` 的《合并清单》为准**，本文的映射关系仍然成立。

## 一、两边各是什么（先别急着替换）

| | 现在（`core/src/agent/agent.cj`） | pi-cj（`pi-cj/src/pi/`） |
| --- | --- | --- |
| 循环 | 手写 `while (guard < 5)`，一轮模型请求 + 一次工具 | Pi 的 agent-loop：外层 follow-up/steering 队列 + 内层"模型→工具→再问" |
| 工具调用 | **提示词协议**：要求模型只输出 `{"tool":..,"args":..}`，我们再解析 | **原生 function calling**（`tools` 数组），并按 OpenAI 形状回填 `tool_call_id`；服务端不支持时回落提示词协议 |
| 参数流式 | 无（整段回来才解析） | `PartialJsonParser` 边到边解析半截 JSON（`toolcall_delta`） |
| 事件 | 我们自定：`turn/start` `step/*` `tool/call` `tool/result` `assistant/delta`… | Pi 的名字：`agent_start/turn_start/message_*/tool_execution_*`，`kindText()` 直接就是类型名 |
| 历史 | 从 SQLite 事件表重建（`history()`） | 内存 `Session` + `History.freeze()/thaw()` 冻结视图 |
| 工具集 | `tools/registry.cj` 的 ToolSpec（name/title/usage/desc + available），10 个领域工具 | `Tool` 接口 + JSON Schema + 风险档 + `mode` 白名单 + 工作区沙箱（read/write/edit/ls/find/grep/run_command） |
| 测试 | 我们靠 `tools/*.ps1` + E2E | `cjpm test` 69 例（事件流/流式解析/模式/原生工具调用/沙箱/主循环） |

**结论**：要换的是"循环 + 工具协议 + 事件形状"，**不要**换掉我们的领域能力（知识库检索、联网策略、技能白名单、引用自检、SQLite 事件表）。

## 二、唯一的边界：两个接口 + 一条流

pi-cj 的运行时**零网络、零文件 IO**（它的 README 明确写了这条硬约束）。和宿主只有三个接点：

| 接点 | 形状 | 我们这边谁来提供 |
| --- | --- | --- |
| `ChatProvider.respond(ctx: StepContext, stream: EventStream): ModelReply` | 自己把 `text_delta`/`thinking_delta`/`toolcall_delta` 推进 stream；失败**不抛**，填 `stopReason="error"` | 新文件 `core/src/llm/provider.cj`，复用 `llm.cj` 里已经踩平的 TLS(SNI)/ALPN/退避/SSE |
| `Tool.spec()/run(callId, args): ToolResult` | `content` 是给模型的正文、`details` 给界面、`summary` 一行给人看 | 把现有 10 个工具各包一层 `FuncTool`（`tools/registry.cj` 的字段名和 pi-cj 的 `ToolSpec` 已经对齐，多一个 `risk`） |
| `EventStream` | `on()` 实时（推 SSE）、`drain()` 只取一次（写库） | `api.cj`：`drain()` → 写 `session_events`，`type = kindText()`；`on()` → 前端的流式通道 |

## 三、概念映射（哪些照搬、哪些改动、哪些不碰）

| 我们现在的 | pi-cj 的 | 处置 |
| --- | --- | --- |
| 提示词协议 `{"tool":..}` | 原生 function calling + 回落 | **换成 pi-cj 的**。MiMo 实测不认"只输出一行 JSON"（它吐 `<tool_call>` XML），这正是 pi-cj 六大坑里的第 2 条 |
| `guard < 5` 轮数上限 | `maxTurns=40` + `abort()` | 用 pi-cj 的，但**保留我们的取消**语义（`/api/agent/cancel` → `Agent.abort()`） |
| `tool/call` `tool/result` `step/*` | `tool_execution_start/update/end`、`turn_*`、`message_*` | 事件名对齐后，**前端是唯一要动的地方**：`KIND_LABEL`/`STEP_LABEL`/`renderToolRows`/`turnsFromEvents` 跟着改（会话总览页也读同一份表） |
| 联网档位 `off/auto/always` | `mode`：chat/standard/research/agent | **不引它的四档**（用户明确要"agent 自己判断该不该联网"）。改成宿主策略：`allowWeb` 决定 `web_search/web_fetch` 是否注册进本轮工具集 |
| 技能 `tools:` 白名单 + 授权门 | `mode.allows()`、`skills.cj`（同一套 Agent Skills 规范） | 保留**我们的** skill 加载器（它更全：`tools` 白名单 + `requires_consent` + 内置只读），把"三份白名单"合成一个 ToolFilter：**可用性 ∩ mode ∩ 技能** |
| `citationReport` 引用自检 | `RunOutcome.warnings` | 保留我们的自检，挂在循环结束之后当 validation 步骤（pi-cj 只提供 warnings 出口） |
| SQLite `session_events`（唯一真相） | `Session` 文件 + `History` | **内核仍是唯一真相**：不接 pi-cj 的 session 持久化，只用它运行期内的 `History`（由我们的历史查询喂养） |

## 四、落地顺序（每步都能独立验证，一步一提交）

| 阶段 | 做什么 | 验证 |
| --- | --- | --- |
| **P1 搬运行时** | `pi-cj/src/pi/*` → `core/src/pi/`，包名 `pi_cj.pi` → `itn_desktop_core.pi`（同包内引用，不用加依赖）。**只搬不改**，先让它在内核里编译过 | `cjpm build`；把 pi-cj 的 69 例单测平移到 `core/src/unittests/` 并 `cjpm test` 全绿 |
| **P2 写 provider** | 新 `core/src/llm/provider.cj` 实现 `ChatProvider`：请求带 `tools`（来自 `ctx.toolSpecs`）+ `tool_choice: auto`；增量里 `content`→text_delta、`reasoning_content`→thinking_delta、`tool_calls[i].function.arguments`→`PartialJsonParser`；顺带记 `usage` | 对着 `tools/mock-openai/server.py` 跑通"流式正文 + 原生 tool_calls + 一次并行两条调用"；再拿真模型（MiMo）跑一次 |
| **P3 包工具** | 现有 10 个工具各包一层 `FuncTool`（`kb_search/list_documents/read_chunk/current_time/calc/save_note/save_artifact/web_search/web_fetch/skill_read`），补 JSON Schema 与 `risk` | `/api/tools/list` 从新 registry 出；`tools/skill-check.ps1`（越权拒绝）与 `tools/web-fetch-check.ps1` 仍全过 |
| **P4 换循环** | `agent.askWeb` 改成：组装 `StepContext`（system = 角色设定 + 工具说明 + 技能清单 + 本轮技能正文；messages = 历史 + 本轮）→ `Agent.prompt()` → `drain()` 写事件。保留：联网策略、技能白名单与授权门、引用自检、取消 | `tools/smoke.ps1`（问答/讲义/练习三条链路）+ `tools/ui-e2e.cjs` 全绿；**同一批问题新旧循环答案一致性抽查** |
| **P5 前端吃事件** | 标签表与"每步事件"渲染适配新事件名；工具面板显示 `risk` 与"为什么不可用"；流式打字机改吃 `message_update` | `node tools/ui-e2e.cjs`（含"流式增量事件真的写进了会话"）、`tools/ui-shot.cjs` |
| **P6（可选）工作区工具** | 把 read/write/edit/ls/find/grep/run_command 注册成"工作区工具"，**默认关**（`--allow-exec` + 设置页开关，UI 明确写"能给本机文件读写/跑命令"），并**先补 `run_command` 超时**（pi-cj 自列的已知缺口） | 新增 `tools/workspace-check.ps1`：越界路径被拒、未开开关时工具不可用且不进提示词 |

## 五、迁移中必须守住的四条

1. **不要丢并行工具调用**（pi-cj 实测：只接第一条会引发重试风暴）。
2. **不要丢 `tool_call_id` 回填**（一条 assistant 带齐 tool_calls + 每条一个 `role:tool`），否则下一轮被服务端拒。
3. **回灌给模型的是工具结果正文**（`modelText()`），不是给人看的 summary——pi-cj 第 3 条坑。
4. **别在 `core/src/pi/` 里加网络或文件 IO**：运行时的边界就是 `ChatProvider` 与 `Tool`。

## 六、明确不做

- **不接 pi-cj 的 `cli/`**（那是给人手动测的），也不引它的 `.env.local`（Key 不入库）。
- **不用它的 `mode` 四档替换桌面端的"agent 自己判断联网"**：模式概念只用来做"风险旋钮"（是否允许改本机文件/跑命令）。
- **不迁移 session 文件持久化**：我们的 SQLite 事件表 + 前端按事件还原已经够用，并存两套历史只会分叉。
- **不给技能脚本能力**：pi-cj 与我们都停在"技能只能编排已注册的工具"。
