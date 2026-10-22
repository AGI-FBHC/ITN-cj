# lumin

> **照 Pi 的架构，用仓颉写的 Agent 运行时（harness）。**
> 事件流、会话树、工具 schema、skills 规范都对齐 [`earendil-works/pi`](https://github.com/earendil-works/pi)（TypeScript，MIT）；
> 语言不同 —— 能搬的是**设计与数据格式**，不是代码。逐条核对见 [`docs/vs-pi.md`](docs/vs-pi.md)。

lumin 是一个**能跑起来的 Agent 内核**：给它一个 OpenAI 兼容的模型端点和一个工作区，
它就能读文件、改文件、跑命令、联网查资料，全过程走一套和 Pi 同形的事件流与会话格式。

```
你 > 看一下这个项目是做什么的，然后写一份 README

  [第 1 轮]
  [执行] ls   参数 {"path":"."}
  [执行] read 参数 {"path":"package.json"}     ← 同一步里两条工具并行跑
  [OK] ls：列出了 12 项（8ms）
  [OK] read：读到 3 个字段（6ms）
  [完成] 轮次 2，工具 3，用量 8475/187 tokens
```

## 目录

- [这是什么 / 不是什么](#1-这是什么不是什么)
- [现状一览：和 Pi 对齐到什么程度](#2-现状一览和-pi-对齐到什么程度)
- [快速开始](#3-快速开始)
- [命令行](#4-命令行)
- [权限与审批（human-in-the-loop）](#5-权限与审批human-in-the-loop)
- [工具与工具集档位](#6-工具与工具集档位)
- [Skills](#7-skills)
- [联网检索（Tavily）](#8-联网检索tavily)
- [测试](#9-测试)
- [目录结构](#10-目录结构)
- [已知差距 / 路线图](#11-已知差距--路线图)
- [License](#12-license)

## 1. 这是什么，不是什么

**是**：

- 一个**照 Pi 的架构重写的仓颉 Agent 运行时** —— 真的能连模型、真的能读写文件、真的能跑命令；
- 一套**和 Pi 同名同形的对外契约**：10 个事件名、7 个工具及其 JSON Schema、JSONL 会话树（`id`/`parentId`）、
  `<available_skills>` 播报格式。因此**上层界面可以按 Pi 的语义来写**，将来换回 Pi 本体也不用改界面；
- 一个**带权限档位与逐条审批的 harness**：读不设限、写按档位放开，越界动作停下来问你 ——
  比 Pi 的"项目信任 + 进程权限"更细（见 [权限与审批](#5-权限与审批human-in-the-loop)）；
- **纯绿色包**：编译产物 + 4 个 DLL 就能在没有装仓颉的 Windows 上双击运行。

**不是**：

- **不是 Pi 的源码移植**。Pi 是 TypeScript + Node ≥ 22.19，lumin 是仓颉原生。
  照着抄一遍 TS 代码既不可能也没意义，我们搬的是它的**架构决策和数据格式**；
- **不是给终端用户用的成品**。定位是"**拿来测 harness 的内核**"——界面（TUI / 桌面应用）是上层的事；
- **不做**多供应商登录、遥测、评测框架。**也不做**子 agent 和 plan mode ——
  Pi 自己就没做（原话：*Pi ships with powerful defaults but skips features like sub-agents and plan mode*），
  所以"没做"不算与 Pi 的差距。

## 2. 现状一览：和 Pi 对齐到什么程度

| 维度 | Pi | lumin |
| --- | --- | --- |
| 语言 / 运行时 | TypeScript + Node ≥ 22.19 | **仓颉原生**；绿色包只要 4 个 DLL |
| 事件模型 | `agent_start` / `turn_start` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `turn_end` / `agent_end` | **同名同字段**；`message_update` 里带 `assistantEvent`（`text_delta` / `thinking_delta` / `toolcall_delta`） |
| 循环 | turn = 一次模型请求 + 它触发的工具；内层跑工具、外层接排队的消息 | **同结构**；steering 在请求前注入、follow-up 在"本该收工"时注入 |
| 工具 | `read` / `write` / `edit` / `ls` / `find` / `grep` / `bash` / `powershell`，参数是显式 JSON Schema | `read` / `write` / `edit` / `ls` / `find` / `grep` / `powershell`（Windows 上代替 `bash`）；**参数 schema 逐字对齐**（含 `offset`/`limit`、`edits[]`、`glob`/`ignoreCase`/`literal`/`context`） |
| 工具结果 | `content`（给模型）+ `details`（给界面）+ `isError` | 同分工；另加一个 `summary` 给 CLI 一行显示 |
| 会话 | JSONL + `id`/`parentId` 树 + 叶子分支 + compaction + fork | **同格式**（header v3、8 位十六进制 id、`compaction.firstKeptEntryId`、`model_change`、`session_info`） |
| 上下文治理 | 自动 compaction 钩子 | 自动（阈值 `autoCompactBytes`，默认 120000 字节）+ 手动 `/compact` |
| Skills | Agent Skills 规范：`SKILL.md` + frontmatter，启动只播 name/description/location，正文按需 `read` | **同规范同播报格式**；支持 `disable-model-invocation` 与 `/skill:<名字>` 强制 |
| 模型接入 | 二十多家 + `/login` | **只走 OpenAI 兼容**（刻意的，只做一层适配） |
| 权限 | 项目信任 + 进程自身的系统权限（**没有逐条审批**） | **读不设限、写按档位**（ask/auto/full）+ 越界动作逐条审批 + 工具集白名单；工作区内 `.env`/`.git` 之类的**写**直接拒（比 Pi 更细） |
| 界面 | TUI + print + JSON + RPC + TS SDK | **行式 CLI**（定位就是"拿来测 harness"）；斜杠命令与 Pi 同形 |
| 扩展 / MCP | TS 扩展进程内装载 / MCP / 包管理 | 没有（`Tool` 接口 + 注册表；MCP 见 [roadmap](docs/roadmap.md)） |

## 3. 快速开始

### 3.1 你需要什么

- **Windows x64**（当前只在 Windows 上验证过）；
- **仓颉 SDK 1.2.0**（含 `stdx`）与 **OpenSSL 3**（TLS 用，随 SDK 附带即可）；
- 一个 **OpenAI 兼容**的模型端点（Key + Base URL + 模型名）。

找不到 SDK 时 `scripts/env.ps1` 会报错，并把查找顺序打出来。要指定就设环境变量：

```powershell
$env:CANGJIE_SDK_ROOT = "D:\cangjie-sdk\1.2.0"   # 或者 SDK_ROOT
```

### 3.2 先看离线演示（不联网、不读写文件、不需要 Key）

```powershell
pwsh -File .\scripts\demo.ps1
```

它用脚本模型 + 假工具走一遍完整的循环与事件序列，几秒钟就能看出这个 harness 长什么样。

### 3.3 连真模型

```powershell
Copy-Item .env.example .env.local
# 编辑 .env.local，填 LUMIN_BASE / LUMIN_KEY / LUMIN_MODEL
pwsh -File .\scripts\chat.ps1 --Workspace .\samples\demo-workspace
```

`samples/demo-workspace/` 是个自包含的示例工作区（几份小文件 + 一份示例 skill），
克隆下来直接就能玩。想让它在你自己的目录里干活，把 `--Workspace` 换成那个目录就行。

### 3.4 打包成绿色目录（目标机器不用装仓颉）

```powershell
pwsh -File .\scripts\package-demo.ps1
# 产物在 dist\lumin-demo\：双击「对话.cmd」或「运行演示.cmd」
```

打包脚本会校验"产物比源码新"以及"拷贝后哈希一致"，防止把上一次的二进制当成这次的结果发出去。

## 4. 命令行

```
lumin              进入对话（**当前目录即工作区**，Pi 的 cwd 语义）
lumin demo         离线演示
lumin chat [选项]  显式进入对话
```

启动参数：

| 参数 | 作用 |
| --- | --- |
| `--workspace <名字\|目录>` | 指定工作区（也可以是 `workspaces.json` 里登记过的名字） |
| `--mode <档位>` | 工具集档位：`chat` / `standard` / `research` / `agent` |
| `--model <名字>` | 换模型 |
| `--base <URL>` / `--key <KEY>` | 临时覆盖接口与密钥 |
| `--permissions <ask\|auto\|full>` | 权限档位（见下一节） |
| `--trust` / `--no-trust` | 这个目录信不信任（决定给不给工具） |
| `--allow-exec` | 允许模型跑命令 |
| `--data-dir <目录>` | 数据目录（会话 / 审批记录 / 权限档位 / 工作区登记） |
| `--ask "<问题>"` / `--ask-file <文件>` / `--ask-stdin` | 非交互式问一句就退出（脚本化用） |
| `--session-id <id>` / `--continue` | 续某个会话 / 接着上一个 |

对话里的斜杠命令：

| 命令 | 作用 |
| --- | --- |
| `/help` `/quit`（`/q` `/exit`） | 帮助 / 退出 |
| `/tools` | 看**当前档位**给模型的工具，以及"注册了但没给"的是哪些、为什么 |
| `/skills` | 看扫到哪些 skills |
| `/sessions` `/new` `/resume <id 前缀>` `/compact` | 会话：列出 / 新建 / 续聊 / 压缩 |
| `/model <名字>` `/mode <档位>` | 换模型 / 换工具集 |
| `/permissions`（`/perm`） | 看/改权限档位 |
| `/approvals [clear]` | 看审批记录与"记住的规则"，`clear` 清空 |
| `/workspace`（`/ws`）`list \| add <目录> [名字] \| open <名字\|目录> \| rm <名字>` | 管理工作区 |
| `/trust on \| off \| clear` | 管理项目信任 |
| `/skill:<名字> [要求]` | 强制加载某个 skill 再干活 |
| `/prompt` | 把**此刻发给模型的完整系统提示词**打出来（preamble + 工具清单 + skills 播报 + 工作目录） |
| `/stop`（`/abort` `/cancel`） | 停下正在跑的这一轮 |

**中途插话**：读键盘是单独一个线程（`src/cli/lines.cj` 的 `LineQueue`），所以模型跑着的时候你也能直接打字 ——
普通句子当成 `steering` 消息，在**下一次模型请求之前**插进当前这一轮（Pi 的 steering 语义）；
斜杠命令要等这一轮跑完才执行（换档位之类的不能和正在跑的一轮打架）；
`/stop` 让这一轮在**当前这句回复说完之后**停下（不打断已经在流的 HTTP 响应，见 [roadmap](docs/roadmap.md)）。
审批提示（y/s/a/n）也走同一个队列 —— 否则它会跟读键盘的线程抢 stdin。

配置优先级：**命令行参数 > 环境变量 > `./.env.local`（当前目录）> `<LUMIN_HOME>/.env.local` > 默认值**。
完整键名见 [`.env.example`](.env.example)。

## 5. 权限与审批（human-in-the-loop）

### 先分清"读"和"写"

**沙箱只隔离写，不隔离读。** 这三档权限调的是**写**：

| | 读 | 写 |
| --- | --- | --- |
| **所有档位** | 整台机器都能读 | 看下面三档 |
| 红线（任何档位都不给） | 模型自己在用的那份配置（里面有 API Key）、CLI 自己的数据目录（配置与会话） | 同左 |

理由：读不改你的东西，而"这个文件到底在哪、里面写了什么"是 agent 干活的前提 ——
把读也关起来，模型就只能靠猜，反而更容易乱写。读的开销用**可见性**兜底：
每次读到工作区外，CLI 都会把绝对路径打出来并标 `（工作区外）`。

### 三档

三档权限（存 `<数据目录>/settings.json`，`/permissions` 随时切）：

| 档位 | 含义 | 行为 |
| --- | --- | --- |
| `ask` **请求批准** | 写只在工作区，越界要批准 | 写**工作区外**的文件 / 跑命令 / 联网 **每次都要问你** |
| `auto` **帮我批准** | 写不再限制工作区 | 只有风险操作（危险命令、联网、写外部文件）才问 |
| `full` **完全访问权限** | 写也不限 | **不问**。唯一红线：**不把模型自己在用的 API Key 交出去** |

`ask` 档里"越界写"的正确语义是**先问、批了就能写**，不是"永远不行"：
批准过的目录会记进本次会话的写白名单（`/approvals` 能看到记住的规则）。
工作区**内部**的 `.env` / `.git` / `.ssh` 这类路径，写依旧直接拒 —— 那不是"外面"，是"危险"。

真正停下来问你的地方是**审批层**，按动作分类：`path-outside`（写工作区外）/ `command`（跑命令）/
`command-dangerous`（危险命令）/ `web`（联网）。回答四选一：

```
[审批] 模型要跑命令：npm test
  y = 这一次可以    s = 本次会话都可以    a = 记住（以后这类不再问）    n = 拒绝
```

- 每个决定都会打印出来，并写进会话（自定义 entry `lumin.approval`），事后可以审计；
- `a` 记住的规则落在 `<数据目录>/approvals.json`，`/approvals clear` 清空；
- **拒绝不是中断**：拒绝的结果会回灌给模型，它会自己换一条路走。

另有**项目信任**：`ask` 档下碰到没信任过的目录会问一次（回车 = 只这次不信任，不落盘）；
`trust.json` 向上继承，所以信任了父目录，子目录也信。没信任 = 工具一个都不给，只剩纯对话。

> 为什么会话里要记审批？因为"模型干了什么、你当时批了什么"是**审计信息**，
> 只存在内存里的话，`/resume` 回来就黑了。

### 思考（reasoning）的语言

`reasoning_content` 是**原样透传**的（`http.cj` → `thinking_delta` → CLI 的 `[思考]`），我们不翻译也不过滤。
语言由模型自己定：只写"回答用中文"时，推理常走英文（推理语料以英文为主）。
现在的 `preamble` **整段中文 + 明说"思考过程也用中文"**，实测能把思考拉到中文
（专有名词、代码、报错原文保留英文）。这只是**引导**，不是参数 —— OpenAI 兼容协议里没有"用中文思考"这种开关。

## 6. 工具与工具集档位

7 个工具，名字与参数 schema **逐字对齐 Pi**：

| 工具 | 干什么 | 风险 |
| --- | --- | --- |
| `read` | 读文件（支持 `offset`/`limit`） | `read` |
| `write` | 写文件 | `write` |
| `edit` | 改文件（`edits[]` 多段替换；找不到 / 不唯一都拒） | `write` |
| `ls` | 列目录 | `read` |
| `find` | 按 **文件名** glob 找 | `read` |
| `grep` | 按**内容**正则找（`literal`/`ignoreCase`/`glob`/`context`） | `read` |
| `powershell` | 跑命令（Windows 上代替 Pi 的 `bash`） | `command` |

加 `research` 档还会给一个 `web_search`（联网，`risk=external`）。

**工具集档位**（这是 DeepSeek 那套"模式 = 工具集"，Pi 本体没有 mode）：

| 档位 | 给模型什么 |
| --- | --- |
| `chat` | 一个工具都不给 —— 纯对话 |
| `standard` | 文件读写（`read`/`write`/`edit`/`ls`/`find`/`grep`），**默认** |
| `research` | `standard` + 联网检索 |
| `agent` | `research` + `powershell`（还要 `--allow-exec` 才真给） |

> `/tools` 会把"这一档给什么、注册了但没给什么、为什么"都列出来 —— 调 prompt 时很有用。

## 7. Skills

实现的是 **Agent Skills 规范**：一个目录 + 一个 `SKILL.md`，frontmatter 里至少写 `name` 和 `description`。
启动时**只播报名字和描述**（省上下文），正文等模型真要用了再 `read` —— 这正是规范和 Pi 的做法。

扫描位置（按顺序）：

```
<工作区>/.pi/skills/<名字>/SKILL.md
<工作区>/.agents/skills/<名字>/SKILL.md
<数据目录>/skills/<名字>/SKILL.md
~/.agents/skills/<名字>/SKILL.md        # 与 Codex / 其他 Agent 工具共用同一套
```

支持 `disable-model-invocation: true`（模型不能自己触发，但你可以用 `/skill:<名字>` 强制）。
示例见 [`samples/demo-workspace/.pi/skills/weekly-summary/SKILL.md`](samples/demo-workspace/.pi/skills/weekly-summary/SKILL.md)。

## 8. 联网检索（Tavily）

```
LUMIN_TAVILY_KEY=tvly-...        # 在 .env.local 里写
LUMIN_TAVILY_RESULTS=5
```

填了就在 `research` / `agent` 档给模型一个 `web_search` 工具；**不填也不报错** ——
工具照样注册，只是标成"不可用"并说明原因（`/tools` 能看到）。

检索结果会编号成 `[W1] [W2] …` 并带上链接，这样正好喂给运行时的引用自检：
模型说了带标记的话，就必须有对应的编号来源。

## 9. 测试

```powershell
pwsh -File .\scripts\test.ps1          # cjpm test，70 例
pwsh -File .\scripts\run-demos.ps1     # 并行跑一组端到端场景，日志 + 汇总（会打模型接口）
```

70 例覆盖：

- **事件流**：顺序、`on` 不重放、`drain` 只取一次、finish/fail/abort、事件 JSON 字段名与 Pi 一致；
- **会话**：JSONL 形状（header + 每行一条 entry + `id`/`parentId` 链）、重新载入后分支一致、
  **分叉**（回到旧 entry 再追加）、**compaction**（摘要替代旧消息、原文留档）、`model_change`/`session_info`、
  按目录分文件、`toolResult` 的 `callId`/`isError` 往返；
- **循环**：完整事件序列、**一条 assistant 里两条工具调用都执行且各自有 `tool_call_id`**、
  `beforeToolCall` 拦截、工具失败不中断、模型报错不抛、最大轮数、steering/follow-up 注入点、resume 前置校验、
  系统提示词快照写进会话、**自动压缩**、**并行执行**（两个各睡 300ms 的工具并发跑，总墙钟 < 600ms）；
- **工具**：`read`（整文件 + offset/limit）、`write` 往返、`edit`（多段替换 / 找不到 / 不唯一都拒）、`ls`、
  `find`（glob）、`grep`（正则 / literal / ignoreCase / glob 过滤）、**越界读放行 / 越界写要批准**、
  命令工具被 `--allow-exec` 门住、
  真跑 PowerShell（含中文不乱码、退出码）、**命令超时**（1 秒超时 → 判定超时、杀子进程、耗时 < 4 秒）；
- **权限与审批**：读写策略分开（读越界放行、写越界要批准）、工作区内敏感路径写拒、受保护根目录拒、
  `full` 档能出工作区但**永远碰不到 Key**、`..` 折叠过不掉 Key 红线、
  审批分类先折叠路径（`ws/../outside/x.md` 不会被误判成工作区内）、批准后才真能落盘、
  档位记忆、信任向上继承、工作区登记表；
- **Skills**：扫描、frontmatter 校验（缺 name/description 就跳过）、播报只带 name/description/location、`disable-model-invocation`；
- **键盘与插话**：行队列跨线程传递（含"另一个线程 80ms 后才推"的阻塞等待）、斜杠命令不会被当成插话喂给模型、
  插话真的在请求之前生效（`seenMessageCounts`）、`/stop` 让本轮以 `aborted` 收尾且下一次 prompt 自动复位；
- **流式解析**：分片无关性、截断缓冲不抛、**字节安全**（汉字不被切断）、转义引号、原生 arguments 形态；
- **Tavily**：结果编号带链接、错误形状如实上报、没 Key 时拒绝而不是偷偷发请求、spec 显式且标 `external`。

## 10. 目录结构

```
lumin/
├── cjpm.toml / cjpm.lock      仓颉包定义（输出 executable，链接 ssl/crypto/crypt32）
├── bin/lumin.cmd              启动器：任何目录敲 lumin 就进对话，当前目录即工作区
├── .env.example               配置示例（复制成 .env.local）
├── src/
│   ├── pi/                    运行时：零网络、零文件、零业务
│   │   ├── event.cj           10 个事件（与 Pi 同名同字段）
│   │   ├── message.cj         消息/角色/tool call 的规范化
│   │   ├── session.cj         JSONL 会话树：id/parentId、分支、分叉、compaction
│   │   ├── agent.cj           循环本体：turn = 一次请求 + 它的工具
│   │   ├── stream.cj          事件总线（on / drain / finish / fail / abort）
│   │   ├── tool.cj            Tool 接口 + ToolRegistry + ToolSpec
│   │   ├── mode.cj            工具集档位（mode = 工具白名单）
│   │   ├── prompt.cj          系统提示词 sections + <available_skills> 播报
│   │   ├── skills.cj          Agent Skills 规范：扫描 + frontmatter 校验
│   │   ├── provider.cj        模型提供方接口（流式）
│   │   ├── scripted.cj        脚本模型（离线演示 / 单测用）
│   │   ├── partialjson.cj     流式工具参数的增量解析
│   │   ├── jsonx.cj / textx.cj / errors.cj   工具函数与错误形状
│   ├── tools/
│   │   ├── tools.cj           7 个工具（read/write/edit/ls/find/grep/powershell）
│   │   ├── workspace.cj       沙箱（读不设限 / 写按档位 + 红线名单）+ 命令执行 + 超时
│   │   └── truncate.cj        结果截断（字节安全）
│   ├── net/tavily.cj          联网检索（全项目唯一的联网处，risk=external）
│   ├── cli/
│   │   ├── chat.cj            行式 REPL + 斜杠命令
│   │   ├── http.cj            OpenAI 兼容提供方（SSE 流式 + 429 退避重试）
│   │   ├── permissions.cj     三档权限（存 settings.json）
│   │   ├── approvals.cj       审批层（y/s/a/n + 记住的规则 + 审计）
│   │   ├── lines.cj          读键盘的线程 + 行队列（中途插话 / 审批取行都走它）
│   │   ├── trust.cj           项目信任（向上继承）
│   │   ├── workspaces.cj      工作区登记表
│   │   └── util.cj            路径/文本小工具
│   └── unittests/             70 例（cjpm test）
├── samples/demo-workspace/    示例工作区（含一份示例 skill）
├── docs/
│   ├── vs-pi.md               按 Pi 源码逐条核对（含两处更正）
│   ├── system-prompt.md       系统提示词的结构、来源、样例（想改看这篇）
│   ├── roadmap.md             已知差距与优先级
│   └── merge-into-itn.md      合并进上层桌面应用的清单
└── scripts/                    env / demo / chat / test / package-demo / run-demos
```

分层是**为合并而分**的：`pi` 零依赖可以原样搬走，`tools` 只依赖标准库，`net` 是唯一边界，
`cli` 是给终端用的（合并时不要搬 REPL）。

## 11. 已知差距 / 路线图

完整清单（含优先级和打算怎么做）在 [`docs/roadmap.md`](docs/roadmap.md)。要点：

**会挡路的**：

1. `ask` 档下**工作区外的 skills 能播报但读不到**（沙箱缺一个只读白名单）；
2. 命令审批的危险判定**只到"首词"**，`pwsh -c "Remove-Item -Recurse -Force …"` 这种藏在参数里的判不出来。

**与 Pi 的真实差距**：MCP 客户端（最该补）、扩展装载、TUI/RPC/SDK。

**合并进上层桌面应用**：见 [`docs/merge-into-itn.md`](docs/merge-into-itn.md)。

## 12. License

[MIT](LICENSE)。

与 Pi 同为 MIT —— 但请注意：**lumin 没有复制 Pi 的代码**。
Pi 是 TypeScript（`github.com/earendil-works/pi`，MIT），lumin 是照着它的**架构与数据格式**重写的仓颉实现。
文中引用的 Pi 文档原句仅为说明设计来源。
