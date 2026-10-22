# lumin 桌面端契约（serve RPC + 壳 IPC）v1

> 三方共享的唯一事实源：**内核 `src/cli/serve.cj`（本仓）、Electron 壳 `shell/`、界面 `shell/ui/`**。
> 任何接口变更**先改本文档**再改代码。状态：实现中（2026-10-15）。

---

## 0. 总则

- 服务只绑 `127.0.0.1` 随机端口；界面由 serve 托管（**同源，无 CORS 问题**）。
- 成功响应 = 直接给 JSON 对象/数组；失败 = `{"error":"中文原因"}` + 4xx/5xx。
  `Content-Type: application/json; charset=utf-8`。
- 除下面标 `GET` 的接口外，一律 **POST + JSON body**（body 为空也接受）。
- 实时通道**只有** `POST /api/events` 长轮询；界面禁止 200ms 短轮询其它接口。

---

## 1. 启动（内核）

```
lumin-demo.exe serve --port-file <file> --ui-dir <dir>
    [--workspace <目录>] [--permissions ask|auto|full] [--mode <档>] [--model <名>]
    [--data-dir <目录>] [--trust] [--allow-exec]
```

- 配置来源与 `chat` 相同：环境变量 > `<cwd>/.env.local` > `$LUMIN_HOME/.env.local` > 内置默认。
- 启动后：把端口（纯数字）写入 `--port-file`；stdout 打一行 `LUMIN_SERVE_PORT=<port>`；进程常驻。
- `--workspace` 缺省 = `$LUMIN_HOME/chat-workspace`（存在时），否则 cwd。
- **无 Key 不退出**：`state.keyConfigured=false`；发消息时返回 400 `没有配置 API Key：在 <lumin根>/.env.local 写一行 LUMIN_KEY=... 后重启`。
- `--ui-dir` 静态白名单（其余一律 404，防路径穿越）：
  `/` `/index.html` `/app.js` `/style.css` `/vendor/xterm.js` `/vendor/xterm.css` `/vendor/xterm.js.map`
- 开发旗标 `--no-serve`（仅壳用）：跳过拉起 serve，用于壳单独自测。

---

## 2. 事件（唯一实时通道）

```
POST /api/events    body {"since": N}        // 首次传 0
→ {"events":[Ev...], "next": M, "reset": false}
```

- 每个事件带 `"seq"`（从 1 单调递增）。服务端保留最近 **2000** 条。
- 客户端 `since` 落后到已被淘汰 → `reset:true`：界面必须**丢弃本地历史**，改用 `GET /api/entries` 重建，再从 `next` 续轮。
- 无新事件时服务端**挂起至多 20s** 再回空数组；客户端拿到响应立刻带新 `since` 续轮。
- 网络错误：指数退避（1s 起，上限 10s）重试；恢复后先 `GET /api/state` + `GET /api/entries` 对账。

### 2.1 内核原生事件（PiEvent 原样透传 + seq）

`type ∈ agent_start / turn_start / turn_end / message_start / message_update / message_end / tool_execution_start / tool_execution_update / tool_execution_end / agent_end`

- `message_update`：`{assistantEvent:{type, delta?}, message:{role,...}}`
  `assistantEvent.type ∈ start / text_delta / text_end / thinking_delta / thinking_end / toolcall_start / toolcall_delta / toolcall_end`
- `tool_execution_start`：`{toolCallId, toolName, args}` —— `args` 是 **JSON 字符串**
- `tool_execution_end`：`{toolCallId, toolName, summary, isError, durationMs}`
- 其余字段以 `src/pi/event.cj` 的 `toJson()` 为准，界面遇到未知字段一律忽略。

### 2.2 serve 扩展事件

| type | 字段 | 时机 |
| --- | --- | --- |
| `run_start` | - | `/api/message` 受理成功 |
| `run_end` | `ok, stopReason, error, turns, usageIn, usageOut, warnings[], compactNote` | 一轮结束（含失败/中止） |
| `approval_request` | `id, kind, value, detail` | 需要审批，`kind ∈ command / command-dangerous / path-outside / web` |
| `approval_resolved` | `id, answer` | 审批已应答（含 stop 兜底 `n`），`answer ∈ y/s/a/n` |
| `notice` | `text` | 插话回显、停止、压缩等提示（替代 CLI 的 println） |

---

## 3. 运行控制

| 接口 | body | 成功 | 错误 |
| --- | --- | --- | --- |
| `POST /api/message` | `{"text":"..."}` | `{"ok":true}` | `409 {"error":"running"}`；`400` Key 未配置/空文本 |
| `POST /api/steer` | `{"text":"..."}` | `{"ok":true}` | `409 {"error":"idle"}`（没在跑）；`400` 以 `/` 开头 |
| `POST /api/stop` | - | `{"ok":true}` | - |
| `POST /api/approval` | `{"id":3,"answer":"y"}` | `{"ok":true}` | `409 {"error":"stale"}`（id ≠ 当前挂起的） |

- **界面不许乐观渲染**：发消息后等 `message_start(user)` 事件再画气泡（内容与服务端一致，避免重放错位）。
- `POST /api/stop`：中止当前轮；**若有挂起审批，先以 `answer:"n"` 结束审批**（否则工具线程会永远阻塞），随后 `agent.abort()`。
- 跑动中输入框语义自动切到「插话」（发 `/api/steer`）；停止按钮发 `/api/stop`。

---

## 4. 会话

| 接口 | 说明 |
| --- | --- |
| `GET /api/sessions` | `{"current":"<文件路径>","sessions":[{"id","label"}]}`，新在后；`id`=文件名去掉扩展名 |
| `POST /api/session/new` | `{"ok":true,"path"}`；running 时 `409 {"error":"running"}` |
| `POST /api/session/resume {"id"}` | `{"ok":true,"path","entries":N}`；找不到 `404` |
| `GET /api/entries` | `{"leafId":"...","entries":[...]}` —— **全量** entry（含完整 message JSON），按写入顺序；界面按 `parentId` 从 `leafId` 回溯出当前分支 |
| `POST /api/fork {"entryId"}` | `{"ok":true,"leafId"}` —— 把叶子移回该 entry（其后新建条目自然成新分支）；running 时 `409` |

- 会话树/回退/分叉 = `GET /api/entries` + `POST /api/fork`，不需要别的接口。

---

## 5. 设置（成功时返回完整 `state`，另行注明的除外）

| 接口 | body | 备注 |
| --- | --- | --- |
| `GET /api/state` | - | 见 §7 |
| `POST /api/mode` | `{"mode":"standard"}` | 未知档位 `400` |
| `POST /api/permissions` | `{"level":"ask"}` | 记住；副作用同 CLI `/permissions`（full → allowExec、信任放行） |
| `POST /api/model` | `{"model":"..."}` | 会话记 `model_change` |
| `POST /api/trust` | `{"on":true}` | 同 CLI `/trust on|off`（重建工具注册表） |
| `POST /api/compact` | - | `{"ok":true,"note"}`（无需压缩也 ok） |
| `GET /api/prompt` | - | `{"text"}` 此刻完整系统提示词 |
| `GET /api/skills` | - | `{"skills":[{"name","description","path","manualOnly"}]}` |
| `POST /api/skill` | `{"name":"weekly-summary"}` | `{"name","body"}`，body ≤256KB；未知 `404` |
| `GET /api/workspaces` | - | `{"current","list":[{"name","path","count"}]}` |
| `POST /api/workspace` | `{"path":"D:\\..."}` | 自动登记 + 切换；目录不存在 `400`；running `409` |
| `GET /api/approvals` | - | `{"ask","allow","deny","sessionAllows":[...],"rules":[{"kind","value"}]}` |
| `POST /api/approvals` | `{"action":"clear"}` | 清空记住的规则 |

- **Key / BaseURL 不在界面改**：编辑 `.env.local` 后重启。设置页只展示 base/model/key是否已配。

---

## 6. 静态界面

- `GET /` → `--ui-dir/index.html`；文件清单见 §1 白名单。
- 界面代码里**只用相对路径 fetch**（同源）。

---

## 7. State（`GET /api/state` 响应形状）

```json
{
  "running": false,
  "keyConfigured": true,
  "base": "https://token-plan-cn.xiaomimimo.com/v1",
  "model": "mimo-v2.6-flash",
  "mode": "standard",
  "modeTitle": "标准",
  "modeDescription": "读写文件 + 跑命令",
  "permissions": "ask",
  "permissionText": "请求批准",
  "allowExec": false,
  "trust": {"decided": true, "trusted": true, "source": "..."},
  "workspace": "D:/...",
  "session": {"id": "20261015-142037_3e38437c", "path": "..."},
  "webSearch": false,
  "skillsCount": 17,
  "tools": [{"name": "read", "risk": "read", "label": "...", "snippet": "..."}],
  "approval": null,
  "usageLast": {"in": 0, "out": 0},
  "approvals": {"ask": 0, "allow": 0, "deny": 0, "rules": 0}
}
```

- `approval` 非 null 时 = 当前挂起审批 `{"id","kind","value","detail"}`（界面重连后靠它恢复审批卡片）。
- 字段允许增，**不允许改名/删**；界面遇到未知字段忽略。

---

## 8. Electron 壳（preload 暴露 `window.lumin`，contextIsolation 开、渲染层无 Node）

```js
lumin.win.minimize()
lumin.win.toggleMaximize()
lumin.win.close()
lumin.win.onState(cb)                 // cb({maximized:bool})，最大化状态变化时

lumin.dlg.pickDirectory(title)        // Promise<string|"">，取消返回 ""

lumin.term.start({cwd?})              // Promise<{ok, error?}>；cwd 缺省 <lumin根>/chat-workspace
lumin.term.write(text)                // 写子进程 stdin
lumin.term.onData(cb)                 // cb(text)：stdout/stderr 增量（UTF-8 流解码后）
lumin.term.onExit(cb)                 // cb({code})
lumin.term.stop()                     // 杀子进程
lumin.paths                           // {luminRoot, kernelExe}
```

- `term` 子进程 = `<kernelExe> chat`，管道（**非 TTY**），env 带 `LUMIN_HOME=<lumin根>`。
- **serve 进程由 main 自动拉起**（§1 参数），窗口 `loadURL("http://127.0.0.1:<port>/")`；
  拉起失败 → `dialog.showErrorBox` + 退出（照 ITN shell）。开发自测可加 `--no-serve`。
- 自绘标题栏：`frame:false`，界面顶部画 `#titlebar`，窗口按钮走上面的 `win.*` IPC。

---

## 9. 职责边界（防撞车）

| 方 | 只允许写 |
| --- | --- |
| 内核（本仓主会话） | `src/**`、`docs/**`、`scripts/**`、`CHANGELOG.md`、`TRACE.md` |
| Electron 壳 | `shell/main.js`、`shell/preload.js`、`shell/package.json`（仅 scripts 字段） |
| 界面 | `shell/ui/index.html`、`shell/ui/app.js`、`shell/ui/style.css`、`shell/ui/vendor/*` |

任何一方**不跑 git**、不改对方文件、不改本文档以外的接口。
