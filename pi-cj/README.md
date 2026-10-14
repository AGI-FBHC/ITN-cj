# pi-cj —— Pi-Agent 风格的仓颉 Agent 运行时

> **这不是 Pi Agent 的源码移植。** 仓库里没有 Pi 的源码；这里做的是"按 Pi 的架构思想，
> 用仓颉重新写一遍"，并且刻意把"可独立测试 + 可整体搬进 ITN-Desktop"当作硬约束。
> 合并进 ITN-Desktop 的步骤见文末《合并清单》。

## 0. 三十秒上手

    ...\pi-cj\scripts\chat.ps1                      # 连真实模型聊天（读 .env.local 里的 Key）
    ...\pi-cj\scripts\package-demo.ps1              # 打成 dist\pi-cj-demo（双击「运行演示.cmd」/「对话.cmd」）

配置（命令行参数 > 环境变量 > 当前目录 `.env.local` > 内置默认）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `PI_CJ_KEY` | 无 | 必填，模型 API Key（`.env.local` 已在 .gitignore 里） |
| `PI_CJ_BASE` | `https://token-plan-cn.xiaomimimo.com/v1` | OpenAI 兼容地址 |
| `PI_CJ_MODEL` | `mimo-v2.6-flash` | 模型名（同端点还有 `mimo-v2.6-pro`） |
| `PI_CJ_MODE` | `standard` | plain / standard / research / agent |
| `PI_CJ_WORKSPACE` | `.` | 工作区：模型只能在这里读写、命令也只在这里跑 |
| `PI_CJ_ALLOW_EXEC` | 0 | 设 1（或加 `--allow-exec`）才允许跑本机命令 |

对话里：直接打字提问；`:mode research` 换模式、`:tools` 看工具、`:help`、`:q` 退出。

## 1. 三层，各管各的

| 包 | 目录 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `pi_cj.pi` | `src/pi/` | **运行时循环**：事件流、流式解析、模式、历史、主循环、护栏 | 零网络、零文件 |
| `pi_cj.tools` | `src/tools/` | **真实工具**：读/写/改/搜文件、跑命令、算数、时间 + 工作区沙箱 | std.fs / std.process |
| `pi_cj.cli` | `src/cli/` | **模型通信 + 命令行界面**：OpenAI 兼容流式客户端、SSE、重试 | stdx.net.http/tls |

这么分是为了合并：搬走 `src/pi/` 就是搬走运行时，不会把网络和文件 IO 一起拖进内核。

## 2. 借了什么、没照搬什么

借自 **Pi Agent**：

1. **三层分离**：模型通信层 / 工具层 / 运行时循环互不知道对方内部。
2. **事件流**：响应不是字符串，而是一串事件；界面看实时、日志看持久，两条消费者共用一串。
3. **流式解析不完整 JSON**（Pi 的 toolcall_delta）：工具参数边到边解析，工具名一到齐前端就能显示。
4. **"读-写-改-搜-跑"这套工具**（见 `src/tools/`）：Pi 作为编码 Agent 的看家本领。

借自 **DeepSeek Harness**：

5. **模式 = 工具集的组合**（四档：plain / standard / research / agent）。
6. **同一 step 内上下文冻结**（`History.freeze()/thaw()`）。

**没照搬**：Pi 的 TS/Node 运行时、插件系统、多供应商适配层、沙箱进程隔离。理由：会破坏
"核心仓颉 + 零依赖绿色包"这个前提。工具生态的外部扩展走 MCP，不引 Node。

## 3. 工具（真实可用）

| 工具 | 风险档 | 干什么 |
| --- | --- | --- |
| `read_file` | read | 读工作区里的文本文件（32KB 上限） |
| `list_files` | read | 列文件/子目录（可递归；`.git`、`node_modules`、`target` 等噪声目录直接跳过） |
| `search_text` | read | 逐行搜内容，返回 `文件:行号: 内容` |
| `write_file` | write | 写文件（父目录自动建，已存在则覆盖） |
| `edit_file` | write | 唯一匹配替换（找不到/出现多次都拒绝，避免改错地方） |
| `run_command` | external | `cmd /c` 跑命令，返回退出码 + stdout/stderr |
| `current_time` / `calc` | read | 时间 / 四则运算（求值器与内核 registry.cj 同款） |

**沙箱**：模型给的都是相对路径，先归一化（反斜杠当分隔符、消 `.` 与 `..` 段），
越界、带盘符、带冒号一律拒绝；命令的 cwd 也钉死在工作区。`run_command` 还有二层闸：启动时没加
`--allow-exec` 就标成"不可用"——它仍在工具清单里（前端看得见为什么关着），但不进提示词、调也调不动。

## 4. 工具调用怎么走（这是本工程的核心）

1. 主路径是 **原生 function calling**：`tools` 数组来自 `StepContext.toolSpecs`（结构化定义，
   参数 schema 从 `argsExample` 推），模型回 `tool_calls`；
   `arguments@@ 是**半截 JSON 片段**流式到达，正好喂 `PartialJsonParser`。
2. 回落路径是 **提示词协议**：服务端不支持 `tools` 时，把工具清单 + `{"tool":..,"args":..}` 约定
   塞进 system，模型把调用当正文吐出来，同一套解析器照样认。
3. 一步里模型可以**并行调多个工具**：全部执行、全部回灌（实测漏接第二条会让模型反复重试）。
4. 回灌给模型的是 `ToolResult.modelText()`（正文 > 摊平 data > summary，按字节截断 8KB），
   不是那一行给人看的 summary。
5. 历史按 OpenAI 协议写：一条 `assistant` 消息带齐全部 `tool_calls`，随后每条一个
   `role: tool` + `tool_call_id`（缺了这一段，下一轮请求会被服务端拒掉）。

## 5. 测试（69 例，`cjpm test` 全绿）

- **事件流**：顺序、`on` 不重放、`drain` 只取一次、finish/fail/result/error、abort、`toJson` 只写有意义的字段。
- **流式解析**：扁平协议 / OpenAI 原生（arguments 是字符串再套一层）；**分片无关性**（12 种负载 × 1~12 字节分片
  结果必须与整段一致）；截断缓冲不抛异常且已完整参数不再变；汉字被切断（含"丢掉半截字符、剩下字节下次再来"）；
  转义引号、嵌套对象、数组/布尔/数字/null、JSON 前后带文字。
- **模式与工具**：四档风险工具只增不减；plain 不给工具 / standard 拒 web_search / research 放行 / agent 才有 run_command；
  越权 / 未注册 / 不可用 / 工具内部抛异常，四种都转成 `ok=false`。
- **原生工具调用**：id 按 OpenAI 形状回填历史；一条 assistant 带齐多个 tool_calls + 多条 tool 结果；
  **并行调用两个工具都执行**；回灌内容是正文而不是 summary；`modelText()` 的优先级与 8KB 截断。
- **工作区沙箱**：路径归一化、越界/盘符/冒号全拒；读写往返；越界写真的没写出去；列目录/搜索跳过噪声目录。
- **主循环**：完整事件序列、1/3/5 三档冻结视图、最大轮数、工具结果后中止、模型抛异常、空回答、引用自检。

## 6. 真机跑出来的六个坑（都已修，写下来给接手的人）

1. **Windows 下中文不能进 argv**：命令行参数里的中文会让仓颉运行时**在 main 之前**就抛
   `Invalid unicode scalar value`（argv 按 ANSI 码页解成 UTF-8 失败）。所以中文问题一律走
   `--ask-file` / `--ask-stdin` / 交互式 stdin，别塞进 argv。
2. **MiMo 不认"只输出一行 JSON"**：它直接吐 Qwen 风格的 `<tool_call><function=..>` XML。
   改成发原生 `tools` 数组后一切正常（而且参数是流式片段，正好用上那个解析器）。
3. **只回灌 summary 等于没给模型数据**：模型看到"共 2 项"却看不到是哪 2 项，6 轮瞎试到撞上限。
   见 `ToolResult` 的 `content` / `modelText()`。
4. **漏接并行工具调用会引发重试风暴**：一步里两条调用只接第一条，第二条凭空消失，模型就会一遍遍重试
   （实测 6 轮 5 次调用 3 次失败；修好后 2 轮 2 次调用 0 失败）。
5. **套餐有速率限制**：会回 `429 Request rate limited`，加了 2s/4s/6s 退避重试；只在
   "一个事件都还没推出去"时重试，否则正文会重复。
6. **`run_command` 没有超时**（仓颉这版 `executeWithOutput` 不带 timeout 参数）：跑 `pause`
   这类交互命令会一直挂着。已写进工具说明让模型别这么干，但这是**已知缺口**，接内核时要用带超时的进程封装补上。

另外两条语言层面的坑：`with` 与 `where` 都是**关键字**（不能当方法名/变量名）；
`String.size` 是**字节数**不是字符数。

## 7. 合并清单（搬进 ITN-Desktop）

1. **搬运行时**：`src/pi/` → `core/src/pi/`，包名 `pi_cj.pi` → `itn_desktop_core.pi`（同包，不用加依赖）。
2. **搬沙箱与工具**：`src/tools/` → `core/src/pi_tools/`（或直接把这几个工具并进 `core/src/tools/`）。
   内核已有的 8 个工具各包一层 `Tool` 即可（`ToolSpec` 字段名已对齐 `name/title/usage/desc`，多一个 `risk`）。
3. **接模型**：照 `src/cli/http.cj` 给内核 `llm.cj` 写 `HttpChatProvider`（同一个 `ChatProvider` 接口）：
   - 请求带 `tools`（来自 `ctx.toolSpecs`）+ `tool_choice: auto`；
   - 增量里 `content` → `text/delta`、`reasoning_content` → `think/delta`、
     `tool_calls[i].function.arguments` → 喂 `PartialJsonParser`；顺手把 `usage` 记下来（内核目前没有 token 统计）。
4. **接事件与历史**：`stream.drain()` 逐条写 `session_events`（`kindText()` 就是类型名）；
   `on()` 那路上 SSE 推前端；`RunOutcome.toJson()` 当一轮收尾 payload。
5. **别丢这三样**：并行工具调用、`tool_call_id` 回填、工具结果正文回灌。丢掉任何一个，模型都会"看起来能跑但答不对"。
6. **验证顺序**：先 `cjpm test`（69 例）→ 再 `tools/ui-e2e.cjs` + `tools/ui-shot.cjs` → 最后 `scripts/build.ps1` + `package.ps1`。

**不要**在 `src/pi/` 里加网络或文件 IO —— 那些属于宿主。运行时的边界就是 `ChatProvider` 与 `Tool` 两个接口。

## 8. 还没做

- `run_command` 的超时与进程树回收；审批门目前只到"风险分级 + 可用性开关"，真正的弹窗确认是界面的事。
- MCP 客户端（外部工具生态）、子 agent、重试之外的降级与限流。
- 知识库检索那套（`kb_search` 等）现在还是内存假数据，接内核时换成真的 store 调用。
