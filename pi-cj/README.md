# pi-cj —— Pi-Agent 风格的仓颉 Agent 运行时

> **这不是 Pi Agent 的源码移植。** 仓库里没有 Pi 的源码；这里做的是"按 Pi 的架构思想，
> 用仓颉重新写一遍"，并且刻意把"可独立测试 + 可整体搬进 ITN-Desktop"当作硬约束。
> 合并进 ITN-Desktop 的步骤见文末《合并清单》。

## 1. 它解决什么问题

内核已经是个能跑的 Agent（turn/step 事件流、工具注册表、引用自检、护栏），但有几处只借了形：
工具参数要等整段返回才解析、模式与工具集没有真正解耦、没有可复用的运行时边界。
pi-cj 就是把这几处补齐的一个**独立、可测、可嵌入**的运行时内核。

| 模块 | 文件 | 干什么 |
| --- | --- | --- |
| 事件 | `src/pi/event.cj` | 10 种细粒度事件（turn/step/text/think/tool/call/result）+ `toJson()` |
| 流 | `src/pi/stream.cj` | 生产者推、消费者按序取；`on()` 实时给界面、`drain()` 落日志；可 `abort()` |
| 流式解析 | `src/pi/partialjson.cj` | 解析**还没写完**的工具调用 JSON，边到边出 `tool/call_start/arg/end` |
| 工具 | `src/pi/tool.cj` | `Tool` 接口 + `ToolRegistry`（模式过滤、可用性、风险分级、异常转结果） |
| 模式 | `src/pi/mode.cj` | 模式 = 工具集白名单（plain / standard / research） |
| 历史 | `src/pi/history.cj` | 多轮历史 + **冻结视图**（同一 step 内上下文不可变） |
| 提供方 | `src/pi/provider.cj` | `ChatProvider` 接口（模型通信层）+ `ScriptedProvider`（离线脚本播放器） |
| 主循环 | `src/pi/runner.cj` | turn/step 生命周期、回灌、护栏、引用自检 |
| 门面 | `src/pi/pi.cj` | `PiSession`：一个会话 = 注册表 + 历史 + 当前模式 |
| 示例工具 | `src/pi/examples.cj` | KbSearchTool / SaveNoteTool / WebSearchTool（内存假数据） |

## 2. 借了什么、没照搬什么

借自 **Pi Agent**（三条）：

1. **三层分离**：模型通信层 / 工具层 / 运行时循环互不知道对方内部（这里用 `ChatProvider`
   与 `Tool` 两个接口切干净，运行时零网络、零文件依赖）。
2. **事件流**：响应不是字符串，而是一串事件；界面看实时、日志看持久，两条消费者共用一串。
3. **流式解析不完整 JSON**（Pi 的 toolcall_delta）：工具参数边到边解析。

借自 **DeepSeek Harness**（一条）：

4. **模式 = 工具集的组合**：换一组工具就是另一种用法；plain 不给工具、research 才给联网。

**没照搬**：Pi 的 TS/Node 运行时、完整插件系统、多供应商适配层、沙箱进程隔离。
理由：这会破坏"核心仓颉 + 零依赖绿色包"这个前提。工具集的外部扩展走 MCP，不引 Node。

## 3. 仓颉特有的取舍（都写在对应文件的注释里）

| 取舍 | 原因 |
| --- | --- |
| 事件流用**同步推送**而不是 async 可迭代 | 仓颉 1.2 没有 async/await；语义等价：按序、可中止、可拿最终结果 |
| 模式方法叫 `allow` 不叫 `with` | `with` 是仓颉关键字，`x.with([...])` 会被当限定名解析，编译期直接报错 |
| `String.size` 是**字节数**不是字符数 | 流式增量阈值、字节截断都按字节算；要字符数就得自己数 |
| 流式解析每次**从头重扫**整个缓冲 | 工具调用只有几百字节，换"无需可恢复状态机"的健壮性 |
| 半截字符**整个丢掉**（而不是退到非续字节） | 3 字节汉字只到第 1 字节时，末字节是首字节不是续字节，按那个判据会解出半个字符 |

## 4. 跑起来

    ...\pi-cj\scripts\test.ps1          # 单元测试（56 例）
    ...\pi-cj\scripts\demo.ps1          # 构建并跑一遍走路演示
    ...\pi-cj\scripts\package-demo.ps1  # 打成 dist\pi-cj-demo（双击「运行演示.cmd」）

演示是**纯离线**的：假模型（脚本播放器）+ 假工具，不联网、不读写文件。四段输出依次是
流式解析、标准模式一轮、研究模式（含引用自检抓到 [W9]）、护栏（白名单 / 最大轮数 / 中止）。

## 5. 测试覆盖（56 例，cjpm test 全绿）

- **事件流**：顺序、`on` 不重放旧事件、`drain` 只取一次、finish/fail/result/error、abort、`toJson` 只写有意义的字段。
- **流式解析**（最重的一组）：
  - 扁平 `{"tool":..,"args":..}`（内核协议）与 OpenAI 原生 `function.arguments`（字符串里再套一层 JSON）
  - **分片无关性**：12 种负载 × 1~12 字节分片，结果必须与整段一次喂完全一致
  - 截断缓冲：不抛异常，且"已完整的参数"之后不会再变
  - 汉字被切断（含"丢掉半截字符、剩下的字节下次再来"的传输模型）、转义引号、嵌套对象、数组/布尔/数字/null、JSON 前后带文字
- **模式与工具**：plain 一个工具都不给、standard 拒 web_search、research 放行；未注册 / 越权 / 不可用 / 工具内部抛异常，四种都转成 `ok=false` 而不是抛出去。
- **历史**：冻结期间写入进队列、快照不动；解冻后合并；`viewTail` 截取。
- **主循环**：一次工具调用 + 最终回答的完整事件序列、两步工具调用（1/3/5 条历史三档冻结视图）、
  最大轮数、工具结果后中止、模型抛异常、空回答、引用自检。
- **门面**：换模式后模型看到的工具确实变了；未知模式被拒；工具协议段与系统提示词分开。

### 写测试时抓出来的两个真 bug（都已修）

1. **顶层参数永远收集不到**：`collectMembers` 的 `depth` 从 0 起算，但函数的 `start` 就是对象自己的
   `{`，成员层级其实是 1 —— 结果是 `argsJson()` 永远是空对象、工具拿到空参数。
   （演示第一版打出来的就是「本地命中 1 条切片（）」。）
2. **工具名提前播报**：名字字符串还没闭合就把已经到达的部分当工具名发出去，按 5 字节分片喂
   `{"tool":"kb_search",...}` 时前端会先看到 "k"。改成"字符串闭合才算已知"。

外加一处**字节安全**的修复：原 `safeUtf8` 只判"末字节不是续字节"，对"切在 3 字节汉字的第 1 个字节后"
仍然会解出半个字符并抛异常（内核 `util.cj` 的 `readAllString` 报的 Invalid utf8 就是这一类）。
现在改成"按首字节算长度、只保留完整字符"。

## 6. 合并清单（搬进 ITN-Desktop）

目标：让内核的 Agent 循环用上这套运行时，且不破坏"核心仓颉 + 前端零依赖 + 绿色包"。

1. **搬文件**：`src/pi/` 整个复制成 `core/src/pi/`，把 `package pi_cj.pi` 改成
   `package itn_desktop_core.pi`（同包，不需要在 `core/cjpm.toml` 里加依赖）。
2. **接模型**：给内核 `llm.cj` 的 `LlmClient` 写一个 `ChatProvider` 适配器（`HttpChatProvider`）：
   - `chatMessagesStream` 的每个增量：正文 → `text/delta`；`reasoning_content` → `think/delta`；
     `tool_calls[].function.arguments` 的增量 → 喂 `PartialJsonParser` → `tool/call_start/arg/end`。
   - system 由适配器拼：`ctx.system` + 空行 + `ctx.tools`（`ctx.tools` 已经是完整协议段）。
3. **接工具**：把 `core/src/tools/registry.cj` 的 8 个工具各包一个 `Tool` 实现
   （`ToolSpec` 字段名已经对齐：`name/title/usage/desc`，多一个 `risk`）。
   未配 Tavily 密钥时调 `markUnavailable("web_search", ...)`，等价于现在 `toolPrompt(webSearch=false)` 的效果。
4. **接事件**：`stream.drain()` 出来的事件逐条写进现有 `session_events`（`type` 直接用
   `kindText()`：turn/start、text/delta…），`on()` 那一路上 SSE 推给前端。
   `RunOutcome.toJson()` 直接当作一轮的收尾 payload。
5. **接界面**：模式切换面板读 `builtinModes()`；工具清单面板读 `registry.specsOf(mode)`（含 `risk`，
   可在 `external` 上挂审批门）；引用自检的 `warnings` 显示成黄条。
6. **验证**：改完先 `cjpm test`（本工程 56 例）再 `tools/ui-e2e.cjs` + `tools/ui-shot.cjs`，
   最后重新 `scripts/build.ps1` + `package.ps1`。

**不要**在 pi-cj 里加网络/文件 IO —— 那些属于宿主。运行时的边界就是 `ChatProvider` 和 `Tool`。

## 7. 已知没做（有意留在运行时之外）

- 真实 HTTP/SSE（属于宿主的 `llm.cj`）、Token/用量统计、重试退避、并发工具、子 agent、MCP。
- 审批门只做到"风险分级 + `isExternal()` 判据"，真正的"弹窗等用户点确认"是界面的事。
