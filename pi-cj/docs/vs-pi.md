# pi-cj vs 真实 Pi —— 按源码核对的对照（2026-10-14）

## 0. 口径（先说清楚，免得后人重复劳动）

- 来源：`github.com/earendil-works/pi`，分支 `main`，2026-10-14 抓取。
- 版本：`packages/coding-agent/package.json` = **1.2.0**；Node **>= 22.19**。
- 许可：**MIT**（所以"抄代码"在法律上是允许的；但语言不同——它是 TypeScript，我们是仓颉——
  实际能搬的是**设计与数据格式**，不是代码本身）。
- 仓库形态：npm monorepo，`packages/` 下 `agent / ai / coding-agent / mcp / tui / durable / codemode / env / evals / telemetry / chord`。
  我们真正该看的是 `agent`（循环）、`coding-agent`（工具与会话）、`mcp`（外部工具）。
- 本工程 `docs/03-Agent架构.md` 里"参考 Pi 的三种思想、不搬源码"的结论**是对的**，
  但当时没有源码，有两处判断错了，下面第 2 节更正。

## 1. 对照表（左：Pi 源码事实；右：pi-cj 现状）

| 维度 | 真实 Pi | pi-cj | 差距性质 |
| --- | --- | --- | --- |
| 语言/运行时 | TypeScript + Node ≥22.19（也能跑 Bun） | 仓颉原生，绿色包只要 4 个 DLL | 这是我们的立身之本，不是差距 |
| 内置工具 | `bash`、`powershell`、`read`、`write`、`edit`(+diff)、`find`、`grep`、`ls` | read_file / list_files / search_text / write_file / edit_file / run_command / current_time / calc | 缺 `find`（按文件名找）；shell 只做了 `cmd` 一条；多出两个我们自己的小工具 |
| 工具结果展示 | `edit-diff.ts` + `renderers/`：改文件出**差异预览** | 只有一行 summary + 结果正文 | 体验差距（要 UI 配合） |
| 循环单位 | 一个 "turn" = 一次模型请求 + 它触发的工具（**≈ 我们的 step**）；多条 turn 组成一次 run | turn/step 两级，与 DeepSeek 口径一致 | 术语不同，能力对齐 |
| 中途插话 | **steering 消息**（当前 turn 之后进）+ **follow-up 消息**（跑着时排队）；abort 会把排队消息还给编辑器 | 只有 `abort()`，没有插话/排队 | **真差距** |
| 会话 | JSONL，消息/事件构成**树**（每条 entry 有 id + parent），当前 entry 决定 active branch；续聊=分叉；支持 fork/clone | 内存 History，**退出即散** | **最大真差距** |
| 上下文治理 | **compaction**：插一条 summary entry 顶掉旧消息（原 entry 留档） | 只有工具结果 8KB 截断 + maxSteps 护栏 | **真差距** |
| Skills | 实现 **Agent Skills 规范**：目录 + `SKILL.md`（frontmatter 有 name/description），启动只播名字与描述，**按需加载全文**，`/skill:name` 可强制，`disable-model-invocation` 可关 | 无 | **真差距**（你之前专门问过怎么内置） |
| 扩展 | extensions = **TypeScript 模块加载进 Pi 进程**，可注册工具/命令/快捷键/供应商/事件处理/renderer/TUI；另有 prompt templates、themes、packages（npm/git 分发） | 代码级 `Tool` 接口 + 注册表，无运行时装载 | 真差距，但形式要换（见第 3 节） |
| 模型接入 | 多供应商 + `/login` 登录（订阅或 Key）+ model registry/resolver | 只走 OpenAI 兼容，Key 在 `.env.local` | 真差距（我们刻意只做一层） |
| MCP | 有（`packages/mcp` + `core/mcp-servers.ts`） | 无 | 真差距，也是**最该补**的对外接口 |
| 界面 | 交互 TUI（自建 `packages/tui`，含 native 部分）+ print 模式 + JSON 事件流模式 + **RPC**（stdin/stdout JSONL）+ TypeScript SDK | 行式 REPL + `--ask-file/--ask-stdin` | 差距，但桌面版会自己画界面，不算问题 |
| 权限模型 | **project trust（项目信任）+ 启用工具直接用进程自身的操作系统权限**；扩展也跑在同一进程 | 工作区沙箱（路径归一化、越界拒）+ 四档模式白名单 + `--allow-exec` | **pi-cj 反而更紧**（见更正 2） |
| 遥测/评测 | `telemetry`、`evals`、`durable`、`codemode` 独立包 | 无 | 不照搬 |

## 2. 更正：我上一轮凭印象说错的两处

1. **"Pi 有子 agent"——错。** README 原话：
   `Pi ships with powerful defaults but skips features like sub-agents and plan mode.`
   （要的话靠扩展或装包自己加。）所以"pi-cj 没有子 agent"**不是**与 Pi 的差距。
2. **"Pi 的关键操作会逐条弹窗审批"——错。** `how-pi-works.md` 的 Trust and permissions 一节写的是：
   先做 project trust 判定，然后"enabled tools use the operating-system permissions of the Pi process"。
   也就是说 **Pi 不做逐条审批**，靠"你信不信任这个项目 + 进程自身的系统权限"。
   → 结论反过来了：**pi-cj 的工作区沙箱比 Pi 默认更严**（越界直接拒、命令要 `--allow-exec`）。

## 3. 对 pi-cj / ITN-Desktop 的四条可操作结论（按优先级）

1. **会话持久化 + 树形分支**（补掉最大缺口）：Pi 的模型是"JSONL + 每条有 id/parent + 当前 entry 定 active branch"，
   续聊即分叉、fork/clone 复制历史。内核已有 `session_events`（只追加事件），把它升级成
   "entry(id,parent) + 当前指针"就能一次拿到续聊/回退/分叉三件事；pi-cj 的 `History` 换掉内存实现即可。
2. **Skills 照 Agent Skills 规范做，别自己发明格式**：`agentskills.io` 那套（目录 + `SKILL.md` +
   frontmatter name/description + scripts/references/assets）已经是事实标准——**本机的 `~/.agents/skills`
   和 Codex 的 skills 都是同一套**，照它做能直接互通。要点两条：启动只播"名字+描述"（省上下文）、
   全文按需加载；再给一个 `/skill:name` 强制入口。
3. **Compaction**：长对话用"插一条 summary entry 顶掉旧消息"来控制上下文，比现在只截工具结果 8KB 有效得多。
4. **MCP**：Pi 把外部工具生态交给 MCP。我们若要"不引 Node 还能长工具"，MCP 客户端（JSON-RPC over stdio/HTTP）
   是比"抄 TS 扩展宿主"划算得多的路。

**仍然不照搬**：TS 进程内扩展宿主（我们是仓颉，改成"注册表 + 配置文件 + 可选外部进程"）、RPC/SDK 双接口、
telemetry/evals/durable/codemode。

## 4. 附：Pi 的目录索引（下次要看什么）

```
packages/agent/src/agent-loop.ts       循环本体（对照 runner.cj）
packages/agent/src/agent.ts            会话级封装（对照 PiSession）
packages/coding-agent/src/core/agent-session.ts   会话/分支/压缩
packages/coding-agent/src/core/tools/  内置工具（bash/powershell/read/write/edit/find/grep/ls）
packages/coding-agent/src/core/event-bus.ts        事件总线（对照 stream.cj）
packages/coding-agent/src/core/skills.ts           skills 装载（对照我们要做的）
packages/coding-agent/src/core/mcp-servers.ts      MCP 接入
packages/coding-agent/docs/how-pi-works.md         一页讲清它的架构（先读这个）
packages/coding-agent/docs/{sessions,skills,mcp,extensions,security}.md
```
