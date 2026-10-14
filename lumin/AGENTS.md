# lumin 协作指引（给 Code Agent / 人类）

> 动手之前先读 `README.md`（现状与跑法）、`docs/vs-pi.md`（与真实 Pi 的逐条对照）、
> `docs/roadmap.md`（已知差距与优先级）、`CHANGELOG.md`（改了什么）。

## 1. 这是什么

lumin 是**照 Pi（`github.com/earendil-works/pi`，TypeScript，MIT）的架构与数据格式**、
用**仓颉**重写的 Agent 运行时 harness。语言不同，能搬的是**设计与格式**，不是代码。

## 2. 硬约束

1. **分层不许破坏**：
   - `src/pi/` = 运行时（事件、消息、会话、循环、提示词、skills、流式解析）—— **零网络、零文件、零业务**；
   - `src/tools/` = 真实工具 + 工作区沙箱 + 截断 —— 只用 std.fs / std.process / std.regex；
   - `src/net/` = 联网（目前只有 Tavily）；
   - `src/cli/` = OpenAI 兼容提供方 + 命令行界面 + 本地配置。
   加新能力时先想"它属于哪一层"，别把网络调用塞进 `pi/`。
2. **对齐 Pi 的地方不要"顺手改成更好看的"**：事件名、工具名、工具参数 schema、会话 JSONL 格式、
   `<available_skills>` 播报格式都是**对外契约**，改了就等于和 Pi 生态脱钩。要改先在 `docs/vs-pi.md` 记一笔。
3. **读写策略不许回退**：**沙箱只隔离写**。读在任何档位都不设边界，只有两条红线 ——
   模型自己在用的含 Key 的配置、CLI 数据目录（`Workspace.denyReasonRead` / `denyAtRedLine`）。
   写按档位（`denyReason`）：ask 档越界要审批层批准过（`allowWriteAt`）才放行。
   改这块时注意：**路径比较前必须先 `collapseDots`**（`..` 既能绕过红线，也能让审批误判）。
4. **密钥不进仓**：`.env.local`、`.env`、真 Key 一律 gitignore。新增配置项要同步更新 `.env.example`。
5. **窗口/编码**：终端一律 PowerShell 7（`pwsh`），不是 Windows PowerShell 5.1。

## 3. 改动流程

1. 改代码 → `.\scripts\test.ps1`（`cjpm test`，**必须全绿**）。
2. 真机跑一遍受影响路径 → `.\scripts\chat.ps1`（会真打模型接口）。
3. **本地 Git 提交**（一次功能一个 commit，message 用中文写清"做了什么、为什么"）。
4. 往 `CHANGELOG.md` 追加一条（时间 / 范围 / 涉及文件 / 验证结果）。
5. 不要 `git reset --hard`、不要 `git checkout --` 清工作区。

## 4. 独立仓与发布

- 独立仓：**https://github.com/SuanXiangJi/lumin**（默认 private）。
- **正本在 ITN-Desktop 仓库的 `lumin/` 目录**（上层桌面应用要合并它，两份必须同源）；
  独立仓是用 `git subtree split --prefix=lumin` 导出的，**不要在独立仓上直接改代码** ——
  改了下次导出会被覆盖。改完本地提交，然后在上层仓库根目录跑 `scripts\publish-lumin.ps1` 重新导出。
- 发布前脚本会检查 `lumin/` 有没有未提交改动，有就拒绝推（免得推上去的历史和你眼前看到的代码对不上）。

## 5. 仓颉语言坑（踩过，别再踩）

- `with` / `where` 是关键字，不能当标识符。
- `String.size` 是**字节数**不是字符数；`ArrayList.size` 是属性、`JsonArray.size()` 是方法。
- **多字节字符必须整块解码**：逐字节处理 UTF-8 会炸出 `Invalid utf8 byte sequence`
  （`toSlashes` / `globToRegex` 都栽过）。
- `enum` 没有 `==`，要自己写 `tag()` + `operator ==`；包内同名类会**遮蔽**枚举项。
- `spawn` 的 lambda **不能捕获可变变量**，要 `let` 或把逻辑收进方法。
- `Process.start` 默认**不接管管道**（要么 `executeWithOutput`，要么重定向到文件）。
- `SubProcess.wait(timeout:)` 超时**抛异常**；`Future.get(timeout:)` 不存在。
- 编译产物被占用（上一次的 `main.exe` / `lumin-demo.exe` 还在跑）会导致 build 失败 —— 先结束进程。

## 6. 环境

需要 **仓颉 SDK 1.2.0**（含 stdx）与 **OpenSSL 3**。
`.\scripts\env.ps1` 自己找：`$env:CANGJIE_SDK_ROOT` → `$env:SDK_ROOT` → `D:\cangjie-sdk\1.2.0`。
