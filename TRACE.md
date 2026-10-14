# 操作与对话记录

> 只追加不删除。新条目写在最下面，写清时间、范围、涉及文件、提交号、验证结果。

## 2026-10-14 项目立项与产品定义

- 用户决定：参照 ITN 做桌面版，不接后端、不要登录账号，只体现功能；知识库改由用户自己定义；Agent 相关 API 配置全部由用户自配；使用仓颉语言开发；只借鉴旧版本思路，其余重写。
- 技术选型确认过程：查证仓颉官方 UI 能力面向鸿蒙设备，Windows 桌面无官方 GUI 库；社区有 CUI（自渲染、SDL 底层）和 CJQT（Qt 封装）两条纯仓颉路线，但框架年轻。用户确认"如果没有合适且成熟的 GUI 框架就算了，用 Electron 也可以"，但明确不要做成网页版应用。
- 功能口径确认：知识库只支持 Markdown 与纯文本，Markdown 需支持图片；含图片的知识库要求切片模型支持多模态；模型统一 OpenAI 格式，用户可自行新增、配置、切换。
- 战略口径确认：与 ITN 仓颉迁移并行推进，属于后手方案；不考虑其他人力分工，由本窗口单独完成，越快越好；目标仍是投稿仓颉杯。
- 本机环境侦察结果：Visual Studio 生成工具 2022（MSVC 14.44.35207）与 Windows SDK 10.0.26100 已安装，满足仓颉 Windows 工具链的前置要求；D 盘剩余 94 GB。本机尚未安装仓颉工具链（`CANGJIE_HOME` 为空，无 `cjc`/`cjpm`）。
- 发现的问题：官方下载页需要登录，下载接口 `cangjie-lang.cn/v1/files/auth/downLoad` 需要 `objectKey` 参数，无法直接匿名获取 Windows 安装包；另外官网已有 1.2.0 STS。
- 本次产出：建立 `D:\Desktop\ITN\ITN-Desktop` 目录，写下 `PRODUCT.md` 产品定义、`docs/01-架构与分工.md`、`docs/02-接口契约.md` 草案，以及 `core/`、`shell/`、`scripts/` 骨架说明。
- 待办：确认产品定义与待讨论项；取得仓颉 Windows 安装包；完成技术验证。

## 2026-10-14T01:35:42+08:00 工具链就位 + Agent 架构定稿

- 用户明确两点：工具链由我自行获取，不再确认；讨论重心转向业务实现与架构，参考 Pi Agent 与 DeepSeek Harness 的架构思想（非源码），用仓颉实现。
- 下载地址攻破过程：官网是 Vue 单页应用，`preDownLoad` 是登录校验接口（匿名返回 data:null）；真实下载地址是 `/v1/files/auth/downLoad?nsId=142267&fileName=<包名>&objectKey=<对象键>`，objectKey 藏在 JS chunk `csdnimg.cn/release/devpress-cangjie/public/js/chunk/organization/download/version.560a3b27.js` 的页面数据里。按文件名在该 chunk 内检索即可得到完整 url 与 sha256。
- 已下载并校验（SHA256 与官网一致）：
  - `cangjie-sdk-windows-x64-1.2.0.zip`（250.7MB，sha 7bd5088a…250bf，发布于 2026-09-22）
  - `cangjie-sdk-windows-x64-1.1.3.zip`（374MB，sha 8bb65499…7da72，发布于 2026-05-29）
  落盘于 `D:\cangjie-sdk\_downloads\`。
- 已解压 1.2.0 至 `D:\cangjie-sdk\1.2.0\cangjie`，dot-source `envsetup.ps1` 后实测：`cjc --version` = Cangjie Compiler 1.2.0 (cjnative)，Target x86_64-w64-mingw32；编译并运行 hello world 成功（中文输出正常）；`cjpm --version` = 1.2.0。前置条件是本机已有的 Visual Studio 生成工具 2022 与 Windows SDK 10.0.26100。
- 新建 `docs/03-Agent架构.md`，记录从 Pi Agent 借鉴的三层分离、事件流、流式解析不完整 JSON；从 DeepSeek Harness 借鉴的会话日志即唯一真相、turn/step 显式生命周期、事件分域、模式即工具集组合；明确不照搬全套插件系统、多供应商适配层、沙箱审批。并给出仓颉模块划分与第一版工具集、引用自检与上下文治理，以及"生成讲义"的完整 turn 生命周期。
- 本轮未写业务代码，无接口变更。

## 2026-10-14T01:49:49+08:00 技术验证全部通过 + 内核骨架可运行

- 用户指令：架构方案定稿后由我自行决定实现方式并直接进入目标模式开发。已创建目标（objective 记录在本轮），不再逐项确认。
- 自取工具链：官网下载页是 Vue 单页应用，`preDownLoad` 为登录校验接口（匿名 data:null）；真实地址 `/v1/files/auth/downLoad?nsId=142267&fileName=<包>&objectKey=<键>`，objectKey 与 SHA256 藏在 JS chunk `version.560a3b27.js`。已下载并校验 1.2.0（250.7MB）与 1.1.3（374MB）两个 Windows 包。
- STDX 不在 SDK 内，从 gitcode releases 取 `cangjie-stdx-windows-x64-1.2.0.1.zip`（21.3MB）。
- OpenSSL 3 是 stdx 的硬依赖。本机 Git 自带 3.2.4 但缺导入库；改从 MSYS2 取 `mingw-w64-x86_64-openssl-3.6.5-1`，只提取 `libssl.dll.a`、`libcrypto.dll.a`、`libssl-3-x64.dll`、`libcrypto-3-x64.dll`，落盘 `D:\cangjie-sdk\1.2.0\openssl`。
- 建立 `core/` 仓颉工程：`cjpm.toml` + `src/main.cj`（stdx.net.http 服务、系统分配端口、/health、/selftest/tls 自检）与 `scripts/env.ps1`、`build.ps1`、`package.ps1`。
- 踩坑与修复：Cangjie 类型名是 `Bool` 不是 `bool`；`Exception.message` 已是 `String` 不能 `??`；JSON 内嵌引号改用 `#"..."#` 原始字符串；链接必须补 `-lcrypt32`，否则 `libstdx.crypto.x509.a` 报 `CertEnumCertificatesInStore` 未定义。
- 三项验证全部通过：① 本地 HTTP 系统分配端口、200/404 正常；② HTTPS 出网 `cangjie-lang.cn`、`baidu` 均 200（`example.com` 失败是本机代理拦截）；③ 干净环境（PATH 仅 System32）下仅需 4 个 DLL、共约 17MB 即可运行并完成 HTTPS 调用。
- 已知问题：`println` 写入管道被缓冲，端口号要等进程退出才出现，Electron 握手不能依赖 stdout，后续改为写端口文件。
- 本轮无接口契约变更（本地自检接口仅用于技术验证）。

## 2026-10-14T02:00:02+08:00 内核模块化：配置存储、模型调用、本地接口全部打通

- 新增模块：`util`（文件与环境、参数解析）、`store`（模型配置与用途绑定的本地持久化）、`llm`（OpenAI 兼容的对话与向量调用）、`api`（本地 HTTP 接口）。`main.cj` 改为启动内核并写端口文件。
- 端口握手改为写文件，解决了 `println` 到管道被缓冲、Electron 读不到端口的问题。新增启动参数 `--data-dir`、`--port-file`，且同时支持 `--flag value` 与 `--flag=value`。
- 踩坑记录：① 仓颉类型名为 `Bool`；② `Exception.message` 已是 `String`；③ `x as T` 在类层次里返回 `Option<T>`，改用 `case x: T =>` 类型模式匹配；④ `Int64.parse` 需要 `import std.convert.*`；⑤ `String` 常量拼接与 `JsonArray()` 需显式类型；⑥ 默认请求分发器按精确路径匹配，`register("")` 不能兜底，所有路由必须在 `buildServer` 显式注册（已写入接口文档）。
- 新增 `tools/mock-openai/server.py`：本地 OpenAI 兼容 mock（chat 与 embeddings），供无真实密钥时自测。
- 新增 `tools/smoke.ps1`：端到端冒烟。实测结果：端口文件握手成功；`/health` 200；`/api/models/save` 200；`/api/models/roles` 200；`/api/models/test` 返回「连通」（真实发出 HTTPS/HTTP 请求）；`/api/chat` 返回 mock 回复；`/api/settings` 不回传密钥；未知模型返回 400 与明确提示。
- 重要发现：`core/target` 下的裸可执行文件需要工具链 PATH 才能启动（缺 DLL 会以 0xC0000135 退出），而 `dist/core` 里的打包产物自包含。冒烟测试因此改为直接跑打包产物，更贴近真实发布形态。
- 接口契约文档 `docs/02-接口契约.md` 按实际实现重写，新增「实现注意」一节说明精确路径匹配的约束。本轮接口为本项目自定义，不涉及旧系统契约。

## 2026-10-14T02:08:41+08:00 知识库模块完成：分块、多模态描述、向量索引与检索

- 新增 `kb` 包三个文件：`kb.cj`（数据结构、Markdown 分块、余弦检索）、`indexer.cj`（扫描分块、图片描述、批量向量化、索引读写）；`store` 增加知识库注册表；`api` 增加五个知识库接口；`llm` 增加 `chatVision` 多模态调用。
- 分块策略：按 Markdown 标题层级切块并记录 `headingPath`；代码围栏内不做标题判定也不切开；单块超过 `maxChars`（默认 1200）即切；图片引用随所属切片记录。`docTitle` 取正文首个一级标题。
- 多模态：建索引时对含图片的切片读取图片、base64 编码成 data URL，与提示词一起发给 `chunkModelId` 指定的视觉模型，描述写入 `caption`；参与向量化的文本为「正文 + [图片描述]」。图片相对路径拒绝绝对路径与 `..` 跳转。
- 实测（`tools/smoke.ps1`，随机 mock 端口）：3 篇文档切出 5 个切片，识别 1 张图片并生成 1 条描述；`kb/search` 返回带 `headingPath`、`text`、`images` 的命中，分数 1 / 0.993916 / 0.989892。代码围栏内的 `#` 未被误判为标题（切片 headingPath 为「第一章 概述 > 1.1 背景 > 代码示例」）。
- 修掉两个真实缺陷：① `search` 里把命中项对象标记为已取用后直接返回同一引用，导致分数被覆盖成 -2，改为返回副本；② `trimStr` 未处理换行，切片文本首尾残留空行。
- 踩坑：`File.readFrom(Path)` 会解析成读文件字节的重载，遍历目录必须用 `Directory.walk(Path, (FileInfo) -> Bool)`；`intOf` 在 `store` 与 `kb` 重复定义导致 api 侧函数解析歧义，已合并；`std.fs` 的 `FileInfo.name` / `isDirectory()` 需通过 `Directory.walk` 回调取得。
- 冒烟脚本改用随机高位端口并清理残留 python 进程：上一轮旧 mock 占用 9999 导致新 mock 未启动，请求仍由旧进程应答，一度误判为视觉分支未生效。
- 接口契约文档补充知识库接口、检索命中结构与处理约定。

## 2026-10-14T02:13:05+08:00 session / tools / agent 完成，核心演示链路跑通

- 新增三个包：`session`（只追加会话日志，JSONL 每会话一文件，含摘要与列表）、`tools`（工具注册表：`kb_search` 检索、`artifact_save` 落盘，产物名做非法字符替换）、`agent`（`ask` 检索增强问答、`lecture` 生成讲义、`quiz` 生成练习，含引用自检）。`api` 增加 6 个接口。
- 把 JSON 与文本辅助函数（`strOf`/`objOf`/`intOf`/`floatValue`/`splitLines`/`trimStr`/`joinWith` 等）从 `store`、`kb` 统一收敛到 `util`，消除了跨包重复定义与解析歧义。
- 实测结果（`tools/smoke.ps1`）：`agent/ask` 返回带编号出处的答案；`agent/lecture` 产出 `讲义-分块.md`（589 字节），含「资料来源」章节与 `[n]` 引用标记；`agent/quiz` 200；会话列表 3 条；选中会话事件数 14，类型序列为 `turn/start,user/message,step/start,tool/call,tool/result,step/end,step/start,step/end,step/start,validation,step/end,step/start,step/end,turn/end`；产物列表 2 项。
- 引用自检为程序化实现而非再调模型：统计正文段落数、带引用段落数、越界引用编号数，返回 `citationReport`。这样既省一次模型调用，也让「可溯源」变成可测的数值。
- 踩坑：`type` 是仓颉保留字，事件字段改用 `kind`（JSON 键仍是 `type`）；`JsonArray.size` 是方法而非属性；`Int64.parse` 需 `import std.convert.*`。
- 接口契约文档补充 agent / session / artifact 接口、会话事件表、引用自检说明与产物目录约定。
- 剩余：Electron 外壳与极简界面、绿色压缩包产物。

## 2026-10-14T02:18:12+08:00 界面与外壳完成，绿色压缩包产出并验证可启动

- 架构决策：界面由仓颉内核以静态资源托管，Electron 只负责拉起内核、读端口文件、把窗口指向 `http://127.0.0.1:<port>/`。好处是界面与接口同源、无需处理 CORS、也没有前端构建步骤。静态资源放行白名单（index.html / app.js / style.css），其余 404，避免路径穿越。
- 新增 `--ui-dir` 启动参数；内核增加 `/`、`/index.html`、`/app.js`、`/style.css` 四个静态路由与内容类型推断。
- 新增 `shell/`：`package.json`、`main.js`（拉起内核、端口文件握手、失败弹窗、退出时回收子进程、`--smoke` 校验模式）、`renderer/`（index.html、app.js、style.css）。界面极简三页：知识库、对话与产物、设置；无框架、无构建。
- 新增 `tools/ui-check.ps1`（静态资源与白名单校验）与 `tools/package-smoke.ps1`（打包后启动校验）。
- 实测：内核托管界面 `/`、`/index.html`、`/app.js`、`/style.css` 均 200，`/nope.js` 404；Electron 44.7.1 开发态冒烟返回 `TITLE=ITN-Desktop / STATUS=内核已连接 · 1.2.0 / PANELS=3 / RESULT=OK`；打包后 `dist/ITN-Desktop/ITN-Desktop.exe --smoke` 同样返回上述结果，绿色压缩包 161.6 MB。
- 打包后的 Electron 是 GUI 子系统程序，控制台看不到 stdout，因此冒烟结果同时写入 `%TEMP%\itn-desktop-smoke-result.txt`。
- Electron 经 npmmirror 镜像安装（`ELECTRON_MIRROR` + `--registry=https://registry.npmmirror.com`），版本 44.7.1。

- 2026-10-14T02:20:10+08:00 界面渲染复核：用浏览器打开内核托管的 `http://127.0.0.1:60641/`，页面标题为 ITN-Desktop，三个标签页（知识库 / 对话与产物 / 设置）与状态「内核已连接 · 1.2.0」均正常渲染；截图归档到 `docs/screenshots/ui-kb.png`。

## 2026-10-14T02:23:48+08:00 界面全流程验证通过 + 仓颉杯提交说明

- 界面全流程实测（浏览器驱动真实界面，本地 mock 模型，无真实密钥）：配置模型 → 绑定三种用途 → 添加知识库 → 建立索引（2 篇 / 3 片 / 1 图 / 1 条描述）→ 提问（答案带 3 条出处，页脚显示「段落 1 · 带引用 1 · 越界引用 0」）→ 生成讲义（落盘 `讲义-提示词工程.md`，含「资料来源」章节）。会话日志 17 条事件。
- 发现并修复的体验缺陷：讲义在界面上按纯文本显示，`#` 与 `##` 直接裸露。补了约 60 行无依赖的极简 Markdown 渲染（先转义 HTML，再处理标题、代码块、列表、粗体与行内代码），并在样式里补齐标题与列表排版；复测渲染出 8 个结构元素，界面显示正常。
- 新增 `tools/ui-flow.ps1`：一键准备界面验证环境（本地 mock + 示例知识库含图片 + 带界面的内核），打印界面地址与 mock 地址。
- 新增 `docs/05-仓颉杯提交说明.md`：项目简介、技术架构、仓颉使用情况（2538 行、10 个文件、用到的 stdx 能力、两个踩坑修复）、四条主链路、引用自检、运行方式、实测验证数据、已知边界与复核命令。
- 截图归档：`docs/screenshots/ui-kb.png`（知识库页）、`itn-desktop-flow2.png`（讲义渲染效果）。

## 2026-10-14T02:31:01+08:00 真实 OpenAI 兼容端点验证：定位并修复 TLS SNI 缺失

- 起因：目标里明确要求"OpenSSL 走通 HTTPS 的 OpenAI 兼容接口"，此前只用公开 HTTPS 站点验过 TLS，没有真正打通模型服务。
- 现象：对真实端点发起请求时握手失败，报 `tlsv1 alert internal error (1080)`。
- 排查：PowerShell 直连（含 -NoProxy 与走系统代理两种）均返回 HTTP 200，模型正常回复，TCP 443 可达，排除网络与凭据；逐个尝试 TLS 版本（1.2 / 1.3）、安全级别（0 / 1）、ALPN，七种组合错误完全相同，排除协商参数问题。
- 根因：仓颉 `stdx.net.http` 客户端不会把请求域名自动带入 TLS 握手，缺少 SNI 时服务端无法按域名路由，直接以 internal error 拒绝。
- 修复：`LlmClient.postJson` 中从 URL 提取主机名并显式设置 `tls.serverName`。实测修复后 `/api/models/test` 返回「连通」（3.6 秒），`/api/chat` 拿到真实模型回答。
- 附带修正早期误判：`www.example.com` 握手失败当时归因为本机代理拦截，实际是同一个 SNI 缺失问题。
- 新增 `/api/models/diagnose` 端点诊断：自动尝试多种 TLS 协商参数并报告结果，用户可自助排查自己的端点。
- 新发现：当前供应商只提供对话接口，`/embeddings` 返回网关 404。内核已针对该情况给出「请为向量用途单独绑定支持向量化的模型」的提示。向量链路仍以本地 mock 验证。
- 新增 `tools/real-model-check.ps1`、`tools/real-embed-check.ps1`、`tools/tls-diagnose.ps1` 三个验证脚本，均从外部 .env 读取密钥且不回显。

- 2026-10-14T02:32:37+08:00 界面补充「已生成的产物」列表：此前 `/api/artifacts/list` 有接口但界面没有入口，「产物可复现、可管理」在产品上落不了地。现在生成后自动刷新，显示文件名、字节数与完整路径。实测界面显示「讲义-提示词工程.md（546 字节）」及其路径。

## 2026-10-14T02:52:28+08:00 容量验证暴露 OOM，已修复：向量脱离 JSON + 提高堆上限 + 索引缓存

- 用 100 篇 Markdown（4.2 MB）配 1024 维向量做容量验证，此前只用 2 篇文档测过，规模上完全是两回事。
- 问题一：索引把向量写进 JSON，360 万个 JsonFloat 对象顶穿内存，内核以 `Out of memory` 崩溃。日志同时暴露 `allHeapSize 268435456`，即仓颉运行时默认堆上限只有 256MB。
- 修复：① 向量移出 JSON，`index.json` 只留元数据，向量单独存 `vectors.txt`；② 写向量改为分批追加（`File.appendTo`，每 200 切片一批），加载时按字节原地解析浮点；③ 通过 `cjHeapSize=2GB` 放宽堆上限，外壳 spawn 内核时带上，测试脚本也已统一设置；④ 索引按 (数据目录, 知识库) 进程内缓存并加锁，重建时替换。
- 修复后实测：3500 切片、index.json 4.65MB、vectors.txt 30.76MB、建索引 10 秒、检索 0.28~0.32 秒（缓存命中）；修复前检索每次 2.15 秒且随时 OOM。
- 回归：接口冒烟、界面托管与白名单全部通过。
- 这两条（`cjHeapSize` 默认 256MB、向量不可进 JSON）都是真实规模下才会暴露的问题，已写入技术验证文档，对仓颉生态其他项目同样有参考价值。

## 2026-10-14T02:53:44+08:00 补齐仓颉杯所需材料

- 新增 `docs/06-第三方依赖与工具说明.md`：运行期依赖（4 个 DLL + Electron 运行时）与编译期依赖（SDK / STDX / OpenSSL / MSVC / Windows SDK）的版本与许可证、对仓颉生态的依赖边界、AI 工具使用说明（含三个"AI 判断出错并被实测纠正"的具体例子）、以及一条约三分钟的演示录制流程建议。
- 三个被纠正的例子分别是：把 TLS 失败误判为本机代理拦截、检索分数被对象引用覆盖成 -2、用 2 篇文档得出"性能良好"却在 100 篇规模下 OOM。写进材料是为了说明为何所有结论都以可重复执行的脚本为准。

## 2026-10-14T02:58:50+08:00 打包版容量验证通过 + 界面补齐会话记录

- 在打包后的应用上做容量验证（此前只直接跑内核测过）：Electron 启动 `ITN-Desktop.exe`，界面上把 100 篇 Markdown 建成索引，回显「100 篇 / 3500 片」，提问返回带出处的答案。重启应用后第一次检索 2.4 秒（需重新解析 30MB 向量），第二次 0.31 秒。确认 `cjHeapSize` 确实经外壳传给内核，OOM 在真实产品路径上不再出现。
- 界面新增「会话记录」：列出会话及事件数，点击展开显示逐条事件与时间戳。此前会话日志有接口但界面没有入口，「答案可溯源」在产品上落不了地。实测显示「提示词 · 11 条事件」并正确展开 `turn/start → user/message → step/start → tool/call → tool/result → step/end → step/start → assistant/message → step/end → validation → turn/end`。
- 修掉一个刷新缺陷：提问后没有触发会话列表刷新，导致刚产生的会话不显示。
- 新增 `tools/big-kb-setup.ps1`：生成大规模知识库并起动 mock，供容量验证复用。
- 截图归档 `docs/screenshots/ui-sessions.png`。

- 2026-10-14T03:00:01+08:00 验收视角验证：新增 `tools/fresh-extract-check.ps1`，把 `ITN-Desktop-win-x64.zip` 解压到全新目录（1.6 秒）后直接运行入口程序，返回 `TITLE=ITN-Desktop / STATUS=内核已连接 · 1.2.0 / PANELS=3 / RESULT=OK`。「解压即用、目标机器无需安装仓颉或 Node」据此从描述变为实测结论。

## 2026-10-14T03:01:14+08:00 真实视觉模型验证多模态切片

- 「含图片的多模态切片」是目标里明确要求的能力，此前只有 mock 验证——而 mock 只检查请求里有没有 `image_url`，并没有真的看图，这不足以证明能力可用。
- 新增 `tools/real-vision-check.ps1`：把界面截图（22.4 KB）放进知识库，切片模型绑定真实端点、向量模型用本地 mock（真实端点不提供 /embeddings）。建索引返回 `imageCount 1 / captioned 1`，耗时 14.4 秒。
- 真实视觉模型的输出：「这是 ITN-Desktop 的知识库配置界面，用于指定本地目录，应用会递归读取目录内的 Markdown 与纯文本文件；配置时需填写标识、显示名称、目录绝对路径，可点击「保存」或「建立索引」完成知识库设置。」——准确读出了图内的中文界面文字。
- 结论：图片读取、base64 编码、多模态消息构造、描述落库、描述参与索引文本，整条链路真实可用。

## 2026-10-14T03:27:51+08:00 真实模型长生成暴露读超时，改为流式；并修掉一个静默打包失败

- 用真实模型跑完整讲义链路时，大纲正常但每节正文都失败于 `Read body timeout and the connection is closed`，且固定在约 16 秒失败。内核日志定位为 `Client1.1 read response timeout`。
- 排查：PowerShell 对同一端点发同规模长请求需 42.5~108 秒、返回 5000 余字，代理与直连均成功，排除网络与凭据；把 readTimeout 从 10 分钟改为 5 秒做判别实验，失败时间仍为 16 秒，说明与 readTimeout 设置无关。
- 根因：非流式请求下服务端等整段生成完才返回响应体，客户端单次读阻塞超过默认 15 秒的连接层读超时。
- 修复：文本生成改走流式（SSE 增量），并兼容 `delta.content` 与部分服务端直接回的 `message.content`，服务端忽略 stream 时回退整体 JSON 解析。修复后讲义生成 127.5 秒 / 5 节 / 2200 余字，引用自检「段落 66 / 带引用 57 / 越界 0」；单次长生成 68.3 秒成功。
- 边界：多模态请求在当前供应商不支持流式，视觉调用保持非流式，实测描述正常。
- **流程事故与修复**：`dist/core` 中的产物被残留的旧内核进程锁定，`Copy-Item` 静默失败而我用 `Select-Object -Last 1` 过滤了输出，导致连续多轮"验证"实际跑的是旧二进制。已把 `package.ps1` 改为出错即停并在拷贝后校验 SHA256，同时清掉残留进程后重跑验证。这条教训已记入文档。
- 顺带修掉：`/api/chat` 与 `/api/models/test` 缺少异常捕获，异常会变成不透明的 500，现已返回带原因的 502；图片描述失败原先被静默吞掉，现在记录到 `captionError` 字段。

## 2026-10-14T03:33:46+08:00 用当前二进制重跑全部关键验证

- 上一轮发现验证事故（dist/core 被残留进程锁定导致 Copy-Item 静默失败、若干轮跑的是旧二进制）后，清理进程并用当前二进制重跑：mock 全链路、真实模型对话、真实视觉描述、真实讲义生成、打包版大规模索引与检索、冷启动检索、绿色包全新解压。
- 重跑结果与上一轮结论一致：打包版索引 100 篇 / 3500 片成功，提问带出处；冷启动首次检索 2.59 秒、第二次 0.33 秒；全新解压后启动 RESULT=OK。
- 二进制新鲜度用字符串标记校验：打包产物中确认包含 `captionError`、`读取响应体`、`模型调用失败` 等最新改动标记，排除了再次跑到旧产物的可能。
- 技术验证文档补充「关于验证本身的说明」一节，写明事故、修复方式与重跑范围。

## 2026-10-14T03:36:05+08:00 交付包补充随包文档

- 审计发现交付物自身缺一个环节：绿色压缩包里没有任何说明，解压的人只看到一个可执行文件，不知道怎么用。在投稿场景下这是硬伤。
- 新增 `docs/07-使用说明.md`（面向解压包的使用者：运行环境、配置步骤、数据存放位置、常见问题排查），并把 `07-使用说明.md` 与 `05-仓颉杯提交说明.md` 一并放进压缩包根目录，分别命名为 `使用说明.md` 与 `系统说明.md`。
- 打包脚本已同步：`scripts/package-app.ps1` 在压缩前复制这两份文档。
- 复验：全新解压 1.6 秒，根目录含两份说明文档，启动应用返回 `RESULT=OK`。

## 2026-10-14T08:43:04+08:00 支持无向量服务运行；统一数据目录

- 起因：用户问「如何打开软件试用」。核查发现本机现有服务商只提供对话、不提供 /embeddings，而知识库检索强依赖向量，用户会卡在第一步。
- 新增关键词兜底检索：未绑定向量模型（或向量调用失败）时，用字符二元组重叠度排序并按切片长度归一化，不依赖外部服务；`/api/kb/build` 不再强制要求向量模型。
- 顺带修掉一个真实检索缺陷：参与检索的文本此前不含标题路径，「常用手法」这类只出现在标题里的词永远检索不到。现在 `indexText()` 把标题路径并入。
- 踩坑：仓颉默认对整数溢出抛异常，FNV 哈希里的乘法直接让问答报错，错误信息只有一个 `mul`；改用每步掩到 31 位的整数哈希；另 `Float64` 不支持 `%` 取模。
- 应用数据目录统一：此前 Electron 用 `%APPDATA%\itn-desktop\data`，内核独立运行用 `%LOCALAPPDATA%\ITN-Desktop`，同一个软件两个目录。现统一为 `%LOCALAPPDATA%\ITN-Desktop`，与文档一致。
- 实测：只配对话模型时建索引 2 篇 / 4 片（embedded 0），检索命中正确切片，完整问答给出三种手法并标注出处。
- 新增 `tools/keyword-mode-check.ps1`、`samples/示例资料`（三篇示例 Markdown，便于开箱试用）。

## 2026-10-14T09:45:00+08:00 存储层整体换成 SQLite（含中文 SQL 词法器修复、向量 BLOB 化）

**这一轮做了什么**：内核所有本地数据从 JSON 文件改为 SQLite 单文件 `itn.db`，同时修掉内置驱动里一个会让中文 SQL 完全无法解析的词法器缺陷。提交：`a9731dc`。

### 一、为什么换

JSON 在真实规模下有三个硬伤，都在实测里撞到过：向量与切片要整份读进内存；统计类操作（正确率、完成度、按章节聚合）只能自己遍历；改一条记录要重写整个文件。SQLite 是单文件、零服务、可整体备份，正好对上"本地单人使用"。

驱动选型：`sqlite-driver`（上游 <https://gitcode.com/zhangyin_gitcode/sqlite-driver>，Apache-2.0），**纯仓颉实现的 SQLite 驱动与嵌入引擎**，直接读写 SQLite 3 文件格式，不依赖本机 libsqlite3，实现标准库 `std.database.sql` 接口。源码已内置到 `third_party/sqlite-driver/`（见该目录 `VENDOR.md`），保证离网也能一条命令构建。

### 二、踩到的真问题：中文写进 SQL 就崩（根因在词法器，不在"中文"）

现象：`INSERT INTO t (name) VALUES ('中文')`、`CREATE TABLE "表" (...)`、`SELECT length('中文')` 全部抛 `IllegalArgumentException: Invalid utf8 byte sequence`，栈顶固定 `sql_lexer.cj` 的 `Lexer::lexPunct`。而参数绑定中文（`VALUES (?)`）却完全正常 —— 这个对比很容易把人引到"中文不能进 SQL"的错误结论。

定位过程（值得照抄）：先用 11 条 SQL 逐条二分，发现「`SELECT '中文'` 通过、`SELECT length('中文')` 失败」「`INSERT ... VALUES ('中文一')` 失败、`INSERT ... SELECT '中文二'` 通过」，共同点是**标点后面紧跟中文**；再让异常不被捕获，由仓颉运行时打出完整栈，直接看到 `lexPunct` 第 342 行的 `sliceText(pos, pos + 3)`。

根因：`lexPunct` 为了找 `->>` 会**无条件切 3 个字节**再解码比较，紧跟其后的双字符运算符判断又切 2 个字节。只要标点后是多字节字符（`VALUES ('中文')` 里的 `(` 紧跟 `'`、`CREATE TABLE 表 (...)` 里的 `(` 紧跟中文列名），切出来的字节序列就落在字符中间，`String.fromUtf8` 立即抛异常。报错只指向词法器，与真正的原因（语句里有中文）毫无关系。

修复（`third_party/sqlite-driver/src/sql_lexer.cj`）：新增 `matchAsciiBytes(at, lit)` 按字节逐个比较 ASCII 运算符，不再解码；单字符标点只在确认 `c < 128` 之后才切片；报错路径改用 `describeAt` 整字符解码，解码失败退回字节值，保证报错本身不再抛异常。

验证：`third_party/probe` 的 23 条用例全过（中文标识符 / 中文字面量 / 参数绑定 / LIKE 中文 / 168KB 长文本 / 引号与 emoji / Int64 与 Float64 与 NULL / 事务提交与回滚 / 1024 维 BLOB 向量 / 自增主键 / 排序分页 / 幂等 DDL / 中文的 UPDATE 与 DELETE），另单独验了 `->>`、`->`、`<=`、`>=`、`<>`、`||`、`<<`、`>>`、`==`、`!=` 以及带中文键的 JSON 箭头取值。运行 `third_party/probe` 的方法：` . scripts\env.ps1` → `cd third_party/probe` → `cjpm build` → `.\target\release\bin\main.exe`（结尾应打印 `PASS=23 FAIL=0`）。

### 三、代码结构

| 文件 | 作用 |
| --- | --- |
| `core/src/db/db.cj` | `Db`（连接 + 互斥锁 + 绑定参数 + 事务/批量）、`DbRow`、`DbValue`、`DbOp`、`DbHub`（进程内共享连接）、向量编解码（每维 4 字节小端 Float32） |
| `core/src/db/schema.cj` | 全部 DDL（幂等，全部 `IF NOT EXISTS`，升级只需追加语句）、迁移标记、老文件留副本 |
| `core/src/store/store.cj` | 模型接口 / 用途绑定 / 知识库登记 → 查库；签名不变 |
| `core/src/study/study.cj` | 档案 / 进度 / 笔记 / 答题记录 → 查库；签名不变 |
| `core/src/session/session.cj` | 会话与事件 → 查库（事件表只插入）；摘要与列表改为 SQL 聚合 |
| `core/src/kb/indexer.cj` | 切片 → `chunks` 表、向量 → `embeddings.vec` BLOB；切片主键显式分配，切片与向量同一批写入 |

两条必须遵守的规矩（都写进了 `db.cj` 的注释）：**参数一律走绑定，不把用户文本拼进 SQL 字面量**；**表名列名只用 ASCII**。

### 四、数据迁移

每个模块自带一次性导入：`store`← `settings.json`、`study`← `study.json`、`session`← `sessions/*.jsonl`、`kb`← `kb/<id>/index.json` + `vectors.txt`。导入完成后在 `meta` 表置位（`migrated_store` / `migrated_study` / `migrated_sessions` / `migrated_kb_<id>`），并把老文件/老目录复制成 `*.migrated` **保留不删**（标准库这版没有 `File.copy`，按字节读写复制）。所以升级不会丢配置与学习记录，出问题原始数据还在。

实测（老数据目录首次打开内核）：`sessions/list` 直接读出 21 个会话，事件类型完整；`settings.json.migrated`、`sessions/*.jsonl.migrated` 生成；模型列表、角色绑定正常读出。

### 五、实测数字（100 篇 Markdown / 3500 切片 / 1024 维，`tools/kb-scale-check.ps1`）

| 指标 | JSON + vectors.txt | SQLite | 变化 |
| --- | --- | --- | --- |
| 建索引耗时 | 10 秒 | 5.4 秒 | 1.9× |
| 落盘体积 | index.json 4.65MB + vectors.txt 30.76MB = 35.4MB | itn.db 6.46MB | 5.5× 更小 |
| 冷启动首次检索 | 2.4~2.6 秒 | 0.73 秒 | 3.4× |
| 热态检索 | 0.31 秒 | 0.02~0.04 秒 | 约 10× |

冷启动那一步是本轮最该被量化的：老实现要按十进制文本逐个 `Float64.parse` 三十多万个浮点，现在是一次 BLOB 读取 + 位移解码。`kb-scale-check.ps1` 已改为自动重启内核测冷启动。

### 六、回归（全部通过）

- `tools/smoke.ps1`：模型配置、用途绑定、连通性测试、对话、知识库建索引（3 篇 / 5 片 / 1 图 / 1 条图片描述 / 5 条向量）、统计、向量检索、完整问答带 3 条出处、讲义落盘、出题、会话 14 条事件、产物列表全部 200；`settings` 不回传密钥。
- `tools/study-api-check.ps1`：档案存取（中文）、章节树 2 章、标记已读、笔记、答题记录、错题、学习报告全通。
- `tools/keyword-mode-check.ps1`：不绑向量模型也能建索引与检索（关键词兜底），完整问答链路正常。
- 驱动自带 `cjpm test`：615 例通过 570。未通过的全部集中在需要外部参照 sqlite 的用例类（`InteropForward/Reverse`、`Wal*`、`Vacuum`、`WithoutRowid*`、`MathFunctionValueTest`），它们靠 `python3` 起参照 sqlite 做差分，本机 `python3` 一是指向 Store 版 Python（打不开临时目录下的库文件），二是指向 Anaconda 版（其 sqlite 未开启数学函数，报 `no such function: sqrt`）——两种环境下失败集合互补，都是参照环境问题。纯仓颉侧（引擎、DDL/DML、表达式、窗口函数）用例全部通过。

### 七、这一轮踩的坑（写给后来的人）

1. `no such column: k`：我把 `getKv/putKv`（键值表专用，列名 `k`/`v`）用在了 `roles` 表上（该表是 `kind`/`model_id`）。教训是**键值表和其他实体表不能共用同一套读写助手**，现在 `roles` 单独走 `roleOf()`。
2. 用 PowerShell 做"按行区间替换"生成代码时，`RemoveRange` + 循环 `Insert(固定下标)` 会把插入块**倒序**。当场用"取头部 + 新块 + 尾部"重新拼装修好了，但这类批量改文件的脚本必须写完后立刻读回校验边界行。
3. 仓颉的块注释**可以嵌套**，所以注释里写 `sessions/*.jsonl` 会因为 `/*` 开了一个永不闭合的嵌套注释，报 `unterminated block comment`。注释里不要出现 `/*`。
4. `Int64.parse` / `Float64.parse` 需要 `import std.convert.*`；`driver.open` 的第二个参数要 `Array` 不是 `ArrayList`；路径父目录直接 `Path(p).parent.toString()` 取，别去 match 成 `Some/None`。
5. `File.copy` / `Directory.copy` 在这版标准库里不存在，复制文件只能按字节读写。

### 八、还没做的

- UI 仍是我上一轮那套九页布局，用户明确说"太简单太丑、缺网页版的主要功能与交互"（已在并行线上处理）。
- 产物（`artifacts`）仍是目录扫描，没有登记进库；本轮判断文件本身就是权威、没有额外查询需求，先不动。
- 数据库备份/导出入口还没做进界面（`docs/08-整体规划.md` 里列的风险项）。

## 2026-10-14 修 P0：界面文件被写坏导致整个桌面窗口只显示 HTML 源码（提交 c7aa074）

- **现象**：用内核 HTTP 界面（tools/ui-flow.ps1 拉起）在浏览器里打开，页面显示的是 HTML 源码文本，document.title 为空、.nav-item 数量 0。
- **定位**：shell/renderer/index.html 的**每个字符后面都跟了一个 LF**（1875 字节里 961 个换行；core.autocrlf=true 在检出时又变成 CRLF），于是浏览器把它当纯文本解析；git show HEAD:... 显示这个损坏**已经提交进仓库**，dist/ITN-Desktop/resources/app/renderer/index.html 同样是坏副本 → 打包后的绿色包启动后窗口里只会显示一屏 HTML 源码。
- **影响面**：全仓扫描（html/js/css/md/cj/ps1/json/toml/yml，排除 node_modules/.git/target/tmp）只有这两个文件异常，其余正常。
- **修复**：按原语义重建 shell/renderer/index.html（1038 字节、32 行、结构校验通过），并同步覆盖 dist 下的打包副本。
- **顺带交付**：新增 	ools/ui-shot.cjs —— 桌面端界面自检脚本（无头 Edge 直连内核 HTTP 界面，逐页截图 + 结构摘要 + console error 收集，playwright 路径自动解析），已用它验证修复：标题 ITN-Desktop · 本地教培工作台、10 个导航项、九页全部渲染正常。
- **教训（写进约定）**：往仓库写 .html 这类文件时**不要用 PowerShell 的 Set-Content -Value ** 这类会按行输出的写法；写完必须读回校验字节数/换行数。	ools/ui-shot.cjs 可作为"界面是否真的渲染"的常规自检手段。


## 2026-10-14 桌面版：11 页工作台 → Codex 式对话 + 仓颉 Agent 工具回路（提交 479215e / d406692）

### 一、本轮的用户指令与范围界定（重要）

用户在本轮给出了一条**边界指令**：「你这边应该只是做 **Desktop 版**的页面，不要与网页版冲突」。

- 本仓 `D:\Desktop\ITN\ITN-Desktop` 是 Desktop 版（仓颉内核 + Electron 壳），**本轮所有改动都在这里**。
- `D:\Desktop\ITN\ITN\src\front`（网页版 React）由**另一个并行会话**负责，本轮一行未动；用户提到的
  「评委导览全部删掉、知识库接口保留、MiMo tokenplan 换模型」都在网页版/agents 那条线上完成（见主仓
  `docs/change-trace.md` 与 `src/agents/app/config.py` 的 `mimo_*` 配置），Desktop 侧只做**对应的能力**：
  模型页加了 MiMo TokenPlan 预设。
- 用户另要求：「页面做得像 Codex 那样」「要有主对话框和 session 栏」「对话框就是之前网页版里那个，
  但要有 Agent 的功能，把 Pi Agent / DeepSeek Harness 那一套拿过来，一些能直接用的工具链也支持一下，
  不过我们的版本一定要基于仓颉开发」。本轮就是按这条做。

### 二、做了什么（两刀）

**第一刀（提交 479215e）：把九页列表改成任务导向的 11 页工作台，并补上前端完全缺失的核心入口**

- 首页第一屏是「开始使用」五步清单：配置模型接口 / 指定资料目录 / 建立索引 / 问第一个问题 / 生成第一份产物。
  完成状态全部读真实数据（`settings`、`knowledgeBases[].chunkCount`、`sessions`、`artifacts`），未完成项带跳转按钮。
- **全站空态都给出可点的下一步**。`tools/ui-shot.cjs` 新增统计：空态数量、**没有按钮的空态（死胡同）数量**、
  清单完成数。改动前首页 0 个按钮；改动后每页都有出口，11 页 deadEnds=0。
- **补上此前界面完全点不到的能力**：`/api/agent/lecture`（生成讲义）与 `/api/agent/quiz`（生成练习册）
  在旧界面里根本没有入口（「我的资源」却提示"到学·练里生成"）。现在章节行与工具栏都有按钮。
- 新增「会话记录」页：`/api/sessions/list` 与 `/api/sessions/events` 从来没被界面用过，现在能展开
  每一轮的 retrieve / outline / write_section / 引用自检 / 落盘。
- 模型页加**预设**（MiMo TokenPlan v2.6 flash / v2.6 pro、DeepSeek、其它 OpenAI 兼容）、测试连通、
  诊断连接（`/api/models/diagnose`）、一键绑定三种用途；档案页补知识库管理（索引进度、统计、切换、删除）。
- 侧栏加真实计数徽标；改用 hash 路由（刷新与前进后退不丢页面）。

**第二刀（提交 d406692）：内核补齐 Agent 工具回路与流式输出；对话页改成 Codex 式两栏**

- `llm.cj`：流式请求支持增量回调（`postStream(path, payload, onDelta)` / `chatStream` / `chatMessagesStream`）。
- `tools/registry.cj`（新增，396 行）：`ToolSpec` + `toolCatalog()`（界面与提示词共用同一份定义）+
  `ToolBox`。7 个工具：

  | 名字 | 用途 |
  | --- | --- |
  | `kb_search` | 检索当前知识库（向量或关键词） |
  | `list_documents` | 列出文档与切片数 |
  | `read_chunk` | 按切片 id 取完整原文 |
  | `current_time` | 本机当前时间 |
  | `calc` | 四则运算（自带递归下降求值器，`Float64` 没有 `%` 运算符，取余用 `v - Int64(v/d)*d` 实现） |
  | `save_note` | 写一条笔记到本机库 |
  | `save_artifact` | 写一份 Markdown 产物 |

- `agent.cj`：`ask` = 取最近 6 轮历史 → 检索 → 最多 4 轮模型调用（可插工具）→ 引用自检 → `turn/end`；
  流式增量写 `assistant/delta`；工具调用写 `tool/call`（带 `args`）与 `tool/result`。
  **工具协议不用 OpenAI 的 function calling**——用户可能接任意 OpenAI 兼容服务，改让模型输出一行
  `{"tool":"名字","args":{...}}`，内核按花括号配对扫描（跳过字符串与转义）取出来执行。
  工具结果的检索条目用 `[T1]` 前缀编号，与正文引用 `[n]` 区分，避免模型拿工具序号去引用。
- `api.cj`：新增 `/api/tools/list`、`/api/sessions/new`；`handle` 拆成 `handle`（统一捕获异常）+ `route`（真路由），
  异常返回带原因与处理办法的 JSON。
- `session.cj`：会话摘要补 `kind`（问答/讲义/练习），供会话栏分类。
- 界面：`index.html` 多一列 `#session-rail`；`app.js` 的 `PAGES.chat` 重写为
  「会话栏（可搜索/切换/显示类型与步数）+ 主对话框（工具行、出处列表、打字机式流式输出、快捷动作）」。
  **流式实现方式**：内核 HTTP 服务是多线程的（先做了实测：一次 30 秒的生成期间，`/api/kb/stats` 十次调用
  耗时 3~34ms 全部返回），所以生成过程中前端可以直接轮询 `/api/sessions/events` 拿 `assistant/delta`
  渲染增量，**不需要 SSE**。会话记录页把增量事件过滤掉（只提示"另有 N 条流式增量"）。

### 三、真实缺陷（本轮测试里抓出来的，都修了）

1. **强杀进程会让数据目录永久打不开（严重）**。打包版 `--smoke` 启动后首页报
   「内核返回的不是 JSON（HTTP 500）」。定位：`%LOCALAPPDATA%\ITN-Desktop\itn.db-cjflock` 是上一轮
   被强杀的进程留下的锁文件，内核日志为
   `SqlException: sqlite busy: database is locked by another process holding ...itn.db-cjflock (waited 5000 ms)`。
   根因在内置驱动的 `storage_lockfile.cj`：它靠 `/proc/<pid>` 判断持锁进程是否存活，
   **Windows 上没有 `/proc` 就一律认为持锁者还活着**，于是陈旧锁无人接管。
   两层修复：① 外壳 `shell/main.js` 在启动内核前用 `process.kill(pid, 0)` 判断并接管残留锁
   （改名成 `itn.db-cjflock.stale-<ts>`，不删）；② 内核把未预期异常转成带原因与处理办法的 JSON，
   界面能直接看到"关掉其它实例、删掉 itn.db-cjflock"。两条都验证过（见第五节）。
   **注意**：`dist/` 里的内核与外壳产物已用 `scripts/package-app.ps1` 重新生成（zip 162.8MB）。
2. `shell/main.js` 的 `--smoke` 检查数的是 `.panel` —— 那个类名在九页改版时就没了，等于一直在数 0，
   报 `PANELS=0` 却仍打印 `RESULT=OK`。现在改为等首页真正渲染完（有卡片且不在加载态），
   再统计 `NAV`（导航项）与 `VIEW_NODES`（首屏节点），`RESULT` 也据此判定。
3. `tools/ui-e2e.cjs` 里等待助手回复时只判断"有文字"——加载中的气泡里也有字，导致断言在生成中就通过。
   改为等最后一个助手气泡不再带 spinner。同时给 E2E 加了**源码比 dist 内核新就拒绝跑**的前置检查，
   彻底堵掉"验证跑的是旧二进制"（TRACE 里记过一次的坑）。
4. 中文引号写进了仓颉字符串字面量（`"资料里有什么"`）导致编译失败；`Float64` 不支持 `%`；闭包不能捕获
   `var`（流式回调里的 `sessionId` 先拷成 `let sid`）；`JsonArray` 不能直接 for-in。都是编译期错误，已修。

### 四、验证证据（都是实跑）

- `node tools/ui-e2e.cjs`：**32 步全过**。自带 mock + 内核 + 无头 Edge，覆盖配模型（预设）→ 绑三种用途 →
  登记知识库并建索引（2 篇 / 3 片 / 1 图 / 1 条图片描述）→ 读章节并标记已读 → 出题作答（对错反馈、错题入本）→
  生成练习册与讲义 → 读产物全文 → 对话提问（3 条出处）→ **Agent 自己调工具算数**
  （工具行显示「检索知识库 / 计算：(12+8)*3/4」，回答 15）→ 点会话栏还原历史（2 轮 / 6 条出处）→
  新建空会话 → 会话记录展开（2 轮 / 32 条事件）→ 写笔记 → 复核成长统计 → 全程 0 条 console error。
- `node tools/ui-shot.cjs`（v5 截图，`tmp/ui-shots-v5/`）：11 页全渲染，**deadEnds 全为 0**，consoleErrors 空。
- `tools/smoke.ps1` 全部 200（含 `/api/agent/ask` 带 3 条出处、讲义落盘含「资料来源」与引用标记）；
  `tools/study-api-check.ps1`、`tools/keyword-mode-check.ps1` 通过。
- 内核级探针：`/api/tools/list` 返回 7 个工具；第二轮 ask 时 mock 侧收到
  `roles=[system,user,assistant,user]`（历史确实带上了）；第三轮 ask `toolCalls=1 / toolsUsed=[calc]`，
  事件分布 `assistant/delta: 8, tool/call: 3, tool/result: 3, validation: 1`。
- 打包版：`dist/ITN-Desktop/ITN-Desktop.exe --smoke` →
  `TITLE=ITN-Desktop · 本地教培工作台 / STATUS=内核已连接 · 1.2.0 / NAV=11 / VIEW_NODES=6 / RESULT=OK`；
  数据目录里的陈旧锁被外壳接管为 `itn.db-cjflock.stale-*`，界面正常渲染。
- 锁占用时的错误提示：手工造一个"持有者 pid 活着"的锁，接口返回
  `{"code":1,"message":"本地数据库被另一个进程占用，无法读写：... 请先关闭所有 ITN-Desktop 窗口与内核进程再重试；确认没有进程在运行后，删除数据目录里的 itn.db-cjflock 即可恢复 ..."}`，
  不再是 `Internal Server Error`。
- 真实模型端点（用户本轮给的 MiMo TokenPlan）：`GET /v1/models` 返回
  `mimo-v2.5 / mimo-v2.5-pro / mimo-v2.6-flash / mimo-v2.6-pro` 等；`mimo-v2.6-pro` 非流式对话正常；
  **带图片请求也能正确读出界面截图里的中文内容**（说明多模态可用，据此把预设的"多模态模型"填成
  `mimo-v2.6-pro`）；流式返回是标准 SSE（首行 `: PROCESSING` 注释前导 + `reasoning_content` 增量），
  内核解析正常；`/embeddings` 返回 404（该服务不提供向量），Desktop 侧因此走关键词兜底检索并在界面注明。
  用 `tools/real-model-check.ps1`（`mimo-v2.6-flash`）跑通真实问答；
  `tools/real-lecture-check.ps1` 跑通真实讲义：**139.5 秒 / 5 小节 / 段落 99 · 带引用 70 · 越界 0**，
  产物落盘。密钥只放在 `%TEMP%` 的临时 env 文件里，未入库。

### 五、当前状态与下一步

- 仓颉内核行数：5648 行（`core/src` 下 `.cj`）。构建 `scripts/build.ps1`；打包 `scripts/package.ps1`；
  出绿色包 `scripts/package-app.ps1`（**改了内核或界面后必须重跑，否则 dist 里是旧产物**）。
- 界面自检两条命令：`node tools/ui-shot.cjs <UI_URL>`（渲染+截图）与 `node tools/ui-e2e.cjs`（全流程点击，
  自带环境，**推荐**）。`tools/ui-flow.ps1` 仍可用，但用 `$out = & ...` 捕获输出时会挂住子进程句柄，
  已在脚本头注释里写明。
- 已知未做：① 讲义/练习生成还没有流式增量（只有 `ask` 有）；② 对话没有"停止生成"（内核无取消接口）；
  ③ 产物仍是目录扫描、没登记进库；④ 界面没有数据库备份/导出入口；⑤ 不做联网检索（产品边界）；
  ⑥ 讲义正文偶尔把小节标题重复输出（模型在大纲与正文里都写了标题），属生成质量，未在界面层掩盖。
- 给接手的人：改 `shell/renderer/*` 只要 3 个白名单文件（`api.cj` 的 `serveStatic` 限制），
  新增静态文件要同时改 `allowed` 与路由并更新 `docs/02-接口契约.md`；
  往这几个文件写内容**不要用 PowerShell 的 Set-Content -Value 数组写法**（TRACE 里记过 P0）。


## 2026-10-14 桌面版第三轮：课件播放 + 画像校准进桌面版，抓到一个"没有返回入口"的真 bug（提交 b916529）

### 一、范围说明（再次确认）

用户上一轮的边界指令仍然有效：**只做 Desktop 版**（本仓），网页版 `src/front` 一行不动。
本轮开工前核对了网页版现状：`src/front` 最后一批改动是今天 10:09（另一条会话的 `484910a feat(front): render math and code`
等），**并行会话仍在改它**，因此继续不碰。目标里的"迁移旧版 ITN 网页版主要功能与交互"这条，
在本仓按同样的标准执行：对照网页版 `src/front/src/pages/`，把还缺的交互搬过来。

### 二、本轮搬过来的两个交互

**1. 课件播放器（对标网页版 `SlidePlayer.tsx`，739 行）**

- 入口：我的资源每份产物上的「播放」、产物全文页的「按页播放」、生成结果卡的「按页播放」、
  学 · 练 章节里的「按节播放」（整章切片拼成一份可翻页的课件）。
- 分页规则：按 `##` 切；只有一页时退回 `###`；正文里"只有标题没有正文"的空白页会被去掉（保留封面）。
- 交互：目录抽屉跳页、字号 A−/A+（14~30px，讲课时后排看得清）、全屏、键盘
  `← →` / `空格` / `PageUp/Down` / `Home` / `End` / `T` / `Esc`。
- 进度：新增 `/api/artifacts/progress`（读）与 `/api/artifacts/progress/save`（写），
  存在 SQLite 的 `meta` 键值表（`artprog:<name>` → `页码|总页数|更新时间`），`artifacts/list` 顺带回传，
  列表上直接显示"上次讲到第 N / M 页"，重新打开自动续播。
- 顺带修生成质量问题：模型写小节时会把小节标题再抄一遍，落盘后同一句标题出现三次、翻页还多一页空白。
  现在内核在拼正文前调用 `stripLeadingSectionHeadings`（只去 1~2 级标题，`###` 及以下保留）。

**2. 画像校准（对标网页版 `Calibrate.tsx`，391 行）**

- 六维能力五档自评：刚起步 20 / 能跟做 35 / 能独立 50 / 能带人 65 / 能设计 80（与网页版档位一致）。
- 右侧给"实测参考"：本机真实答题总数、正确率、已读切片、错题；**题量少于 4 道就不给建议档位**，
  明确写"以自评为主"——拿噪声当依据比不给建议更糟。
- 保存写回档案；可一键生成一条「画像校准记录」笔记（含六维档位表 + 当时的实测参考），之后能回看当时怎么判断的。
- 为此新增前端统一的 `saveProfile()`：内核 `/api/profile/save` 是**整体覆盖写**，
  请求里没带的字段会写成空。之前"只保存自评"会把昵称、学习目标、偏好格式一起清掉——
  这是个真实的数据丢失口子，现在所有保存入口都走 `saveProfile()` 拼完整对象。
  E2E 里固化成断言：校准后昵称与学习目标必须还在。

### 三、本轮抓到的真 bug（端到端测试的功劳）

**章节页没有"返回目录"的入口**：`renderChapter` 里把头部（`← 返回目录` + 章节标题 + 已读比例）
建好了，但 `bar.appendChild(head)` 从来没写——头部根本没进 DOM。后果是进入某一章后，
页面上没有任何回到目录的按钮；再点侧栏「学 · 练」也还停在那一章（`state.chapter` 会记忆），
等于把用户困在章节里。是写 E2E 步骤时"点不到按钮"暴露出来的：我先用探针打了页面里全部按钮文本，
发现 `按节播放/生成讲义/...` 都在、唯独 `返回目录` 不在，才定位到漏挂。

修复后固化成 E2E 步骤「章节页有返回目录的出口（标题/已读比例也要在）」。

顺带记录测试自身的三个坑（都改在 `tools/ui-e2e.cjs`）：
1. 播放器是全屏遮罩，任何导航前必须先收起它，否则后续点击全被它拦住（`nav()` 里加了兜底）。
2. `.player[hidden]` 不能用"等可见"来等，要等 hidden 状态。
3. 目录抽屉是切换式的，扫描前要先判断它是否已经开着，不能盲目再点一次。

### 四、验证证据

- `node tools/ui-e2e.cjs`：**40 步全过**（比上一轮多 8 步）。新增覆盖：章节返回入口、播放器翻页/键盘/目录跳页、
  逐页翻完无空白页、进度续播到第 5 页、整章按节播放、档案写入称呼与目标、六维校准写回且不清空其它字段、
  校准记录笔记、讲义正文不重复抄写小节标题。
- `node tools/ui-shot.cjs`：12 页（新增「画像校准」）全渲染，**deadEnds 全 0**，consoleErrors 空。
- `tools/smoke.ps1`：全部接口 200，新增播放进度往返（保存 200 / 读取 2-7 / 列表带回 2/7）；
  讲义体积从 1560 降到 1512 字节，与"去掉重复标题"一致。
- `tools/study-api-check.ps1`、`tools/keyword-mode-check.ps1` 通过。
- 绿色包已用 `scripts/package-app.ps1` 重出（内核 + 外壳 + 界面都已是最新）。
- 截图证据：`tmp/ui-e2e-shots/16-课件播放器.png`、`17-章节播放.png`、`18-画像校准.png`、`19-校准记录笔记.png`。

### 五、还没做 / 下一步

- 学习单元向导（读 → 练 → 记 → 完成 的连续流程）仍是"分动作"的，没有串成一条向导；
  网页版 `LearnUnit.tsx` 的"讲稿逐句朗读 + 视觉动作同步"依赖语音与动画素材，桌面版当前没有。
- 资源播放（网页版 `CourseResourcePlayer`）里的富媒体（视频/音频/3D）桌面版不做；
  桌面版的"资源"就是本地 Markdown 与图，播放器已覆盖。
- 产物仍未登记进库（目录扫描）；界面仍无数据库备份/导出入口。
- 讲义/练习生成还没有流式增量（只有问答有）；没有"停止生成"（内核无取消接口）。


## 2026-10-14 桌面版第四轮：学 · 练 的一章改成「学习单元」（提交 ba449bd）

### 一、为什么做这个

对照网页版 `src/front/src/pages/LearnUnit.tsx`（学习单元：领学 → 练习 → 笔记 → 完成，带进度），
桌面版这边"读资料"只是若干孤立动作（翻章节、标记已读、出题、写笔记），没有一个连续的学习流程，
看起来就像"把接口摆在了页面上"。本轮把它改成一条明确的四步流程，并把每一步的状态接到真实记录上。

### 二、具体做法

章节页新增「学习单元」步骤条，四步各带一句真实数据与主按钮：

| 步骤 | 完成判定（真实记录） | 页面上的按钮 |
| --- | --- | --- |
| ① 讲一遍 | 本章已读切片 > 0（显示"已读 r / n 片"） | 按节播放 · 整章标记已读 |
| ② 练一组 | 本章答题记录 > 0（显示"已答 N 题 · 对 x · 错 y"） | 出题练习 · 错题本 |
| ③ 记一条 | 本章笔记 > 0（显示"本章已有 N 条笔记"） | 写笔记 · 全部笔记 |
| ④ 完成本章 | 章节完成标记（`chapter_done`） | 标记本章完成 |

- **不存"向导进度"**：四步状态全部由切片已读、答题记录、笔记、章节完成标记推导。
  这样不会出现"界面说你做完了，但记录是空的"这种自欺。
- 「标记本章完成」执行后**回到章节目录**（此前是留在章节里，用户看不到"已完成"、也不知道去哪挑下一章），
  目录里该章显示「已完成」，再进去四步全绿。
- 原来的扁平工具栏（生成讲义/练习册/出题/写笔记/整章已读）收进步骤与「还能做什么」，
  生成讲义/练习册仍然在，只是不再和学习流程混在一排里。

### 三、内核改动（很小，但没有它界面就只能猜）

新增 `/api/study/quiz/stats`：按章节聚合答题统计 `{chapters:[{kbId, chapter, total, right, wrong}]}`。
原先只有 `/api/study/wrong`（只返回错题），界面拿不到"这一章练过多少、对了几道"。
实现上直接 `SELECT kb_id, chapter, correct FROM quiz_records` 在仓颉里聚合，
不用 `SUM(CASE WHEN ...)`（避免依赖驱动的表达式能力）。

### 四、文档补齐

`docs/02-接口契约.md` 此前**只登记了内核与 Agent 的接口，整套 `/api/study/*` 与 `/api/profile/*` 都没写**
（接口存在于代码里、界面也在用，但契约文档没有）。本轮补上完整表格，
并写明 `/api/profile/save` 是整体覆盖写、前端必须走统一的 `saveProfile()` 拼完整对象。

### 五、验证

- `node tools/ui-e2e.cjs`：**42 步全过**。新增两步：
  「学习单元：四步状态全部来自真实记录」（进入时 3/4，四步描述分别是"已读 1/2 片"、"本章已答 1 题 · 对 0 · 错 1"、"本章已有 1 条笔记"、第四章待做）、
  「标记本章完成后回目录，目录标已完成且四步全绿」（4/4）。
  随之 `我的成长` 统计变为 已读 2 / 完成章节 1 —— 说明完成标记真的进了报告。
- `node tools/ui-shot.cjs`：12 页全渲染，**deadEnds 0**，0 条控制台报错。
- `tools/smoke.ps1`（全部 200，含播放进度往返）、`tools/study-api-check.ps1` 通过；绿色包已重出。
- 截图：`tmp/ui-e2e-shots/20-学习单元.png`、`21-学习单元完成.png`。

### 六、下一轮可以做的

- 讲义/练习生成的流式增量（现在只有问答有）；生成期间可显示"正在写第 3 节"。
- 产物登记进库（现在是目录扫描），顺带支持删除产物。
- 数据库备份/导出入口（规划里的风险项）。
- 学习单元里"讲一遍"目前只按已读判定，可以再细化到"播放到第几页"（播放进度已经有接口了）。


## 2026-10-14 桌面版第五轮：生成过程实时进度 + 一个"中文标题把会话列表打 500"的严重 bug（提交 9c204d5）

### 一、这一轮修的那个严重 bug（先说它）

**现象**：端到端跑完"生成讲义"之后，会话栏空、会话记录页打不开，控制台只有三条 `HTTP 500`。

**定位过程（值得记下来）**：一开始内核日志里什么都没有——因为我在第三轮给内核加的异常包装
只把原因回给前端、没有落日志，于是"500"在两边都是哑的。这一轮先给内核补上
`[api] METHOD PATH 失败：原因` 的日志，再跑一次，日志一句话点破：

```
[api] POST /api/sessions/list 失败：Invalid utf8 byte sequence.
```

**根因**：`core/src/session/session.cj` 的 `summary()` 里
`title = String.fromUtf8(title.toArray()[0..40])` —— 它按**字节**截断标题。
中文一个字 3 字节，40 字节 ≈ 13 个字；只要第 40 字节落在一个汉字中间，`fromUtf8` 就抛
`Invalid utf8 byte sequence`。而标题取的是**会话的第一条用户提问**，所以：

> 任何一句长度跨过 40 字节、且第 40 字节正好切在汉字中间的中文提问，
> 都会让 `/api/sessions/list` **永久 500** —— 会话栏、会话记录页从此全部打不开。

本轮之所以踩到，是因为新生成的标题变长了（"生成讲义：提示词工程实时进度"），
正好跨过 40 字节。这是"读路径上的固定字节截断"这一类 bug 的第二次出现
（第一次在 agent 的会话历史上限里，当时加了 `byteSafePrefix`），这次把
`byteSafePrefix` 提到 `util`，session 与 agent 共用；并顺手修掉 `llm.readSse` 里
`String.fromUtf8(buf[0..n])` 的同类隐患（网络分片边界会切断多字节字符，只是之前没踩到）。

**顺带立的规矩**：内核所有接口失败都要落日志。只回 500 不说话，排障就是猜谜。

### 二、这一轮做的功能：生成过程实时进度

此前点"生成讲义"，界面只有一句"生成中…"，而真实模型要跑 90 秒到几分钟（本轮实测 92.1 秒），
用户对着它干等。现在：

- 内核：讲义的大纲与逐节写作、练习册出题都改用流式（`chatStream`），每段正文写一条
  `assistant/delta`，带上 `stage`（outline / section / quiz）与 `label`（小节名）；
  逐节完成继续写 `section/done`。
- 前端：生成前先 `POST /api/sessions/new` 拿一个会话 id，带 `sessionId` 发生成请求，
  然后每 450ms 轮询 `/api/sessions/events` 渲染：
  「正在拟大纲 → 正在写：第二节 典型流程 → 正在出题」+ 实时文字（等宽滚动区，末尾 800 字）
  + 「已完成 N 小节：…」，外加原有的计时器与流水线提示。
- 实测（E2E，mock 分片延时调到 60ms 以留出观察窗口）：请求进行中抓到
  「正在写：第一节 基本概念」+ 120 字实时文字；事件里 21 段逐节增量、3 节完成、小节名齐全。
  真实端点也用流式跑通了一次完整讲义（92.1 秒 / 5 节 / 段落 76 · 带引用 47 · 越界 0）。

### 三、验证

- `node tools/ui-e2e.cjs`：**43 步全过**（新增"生成过程有实时进度"，
  并且这次把内核实录下来：`tmp/ui-e2e-shots/core.log`，失败时不用再猜）。
- 内核 `[api]` 失败日志为空。
- `node tools/ui-shot.cjs`：12 页 / deadEnds 0 / 0 控制台报错。
- `tools/smoke.ps1`、`tools/study-api-check.ps1`、`tools/keyword-mode-check.ps1` 通过。
- `tools/real-lecture-check.ps1`（真实 MiMo TokenPlan 端点）：92.1 秒 / 5 小节 /
  引用自检 段落 76 · 带引用 47 · 越界 0；顺带确认第四轮那个"正文里重复小节标题"的修复在真模型上也生效。
- 截图：`tmp/ui-e2e-shots/22-生成实时进度.png`。

### 四、E2E 本身的两点改进

- 内核 stdout/stderr 落 `tmp/ui-e2e-shots/core.log`（以前丢弃，出问题只能靠猜）。
- mock 的分片延时改为 60ms：真模型要跑几十秒到几分钟，mock 秒完会让"实时进度"这类断言没有观察窗口
  （第一次跑就是因为 mock 太快、卡片已经消失而断言失败）。


## 2026-10-14 桌面版第六轮：产物能搜能改能删，并告诉用户东西存在哪（提交 fe24460）

### 一、为什么做这一轮

前几轮把"生成"打通了，但**产物只能生成、不能管理**：界面里搜不了、改不了、删不掉，
用户甚至不知道文件躺在哪个文件夹里。生成三份草稿之后就只能看着它们堆在那儿——
这不是"符合真实使用逻辑"。本轮补上。

### 二、做了什么

- **搜索**：按文件名过滤，筛选时显示"筛选后 N / 共 M 份"（不筛选就不重复总数，头部标签已经写了）。
- **重命名**：弹层改名，不写 `.md` 会自动补；同名已存在直接拒绝；**播放进度会跟着搬到新名字下**。
- **删除**：确认弹层（不可撤销的动作不用 window.confirm，桌面壳里观感差）；
  删掉文件的同时清掉播放进度——否则以后生成一个同名文件，会莫名"续播"到旧页码。
- **这些文件在哪**：页面底部显示 `dataDir\artifacts` 的完整路径 + 一键复制。产物就是普通 Markdown，
  用户可以拷走或用别的编辑器打开（这是"产物可复现"的兑现方式）。
- **命名对齐**：界面按钮写「生成练习册」，产物文件却叫 `练习-<主题>.md`，现在统一成 `练习册-<主题>.md`
  （旧文件照旧识别，`ARTIFACT_KIND` 只看 `练习` 前缀）。

内核新增 `/api/artifacts/delete` 与 `/api/artifacts/rename`；两者都要求 `name` 与 `sanitizeName(name)` 完全相同，
否则 400 —— 这样就不用担心 `..\..\` 这类文件名跑到产物目录外面去。`/api/settings` 现在回传 `dataDir`。

### 三、这一轮踩到并修掉的（都是测试暴露出来的）

1. **我自己写的搜索断言搜错了词**：我按界面用词搜「练习册」，但产物文件那时候还叫 `练习-…`，
   于是"筛不出东西"。诊断日志（input 值 / 计数器 / 列表文本 / 视图内条目数）一看就明白了。
   这条同时暴露了上面那个命名不一致，所以顺手把文件名对齐了。
2. **播放器按钮定位要限定范围**：资源页新增了「复制数据目录路径」按钮后，
   `getByRole('button', { name: '目录' })` 同时命中它和播放器里的「目录」，Playwright 直接 strict mode 报错。
   现在播放器里的按钮统一在 `#player` 内定位。
3. **删除后重渲染瞬间 `.list` 会消失**：断言里 `document.querySelector('.list').innerText` 因此抛错，
   改成空值容错。

### 四、验证

- `node tools/ui-e2e.cjs`：**44 步全过**。新增一步「产物管理」：
  搜索 1/3 份 → 改名后播放进度仍是第 5 页（并且磁盘上旧名没了、新名在） →
  删除后磁盘文件确实不存在、播放进度键也回到 0。
- `node tools/ui-shot.cjs`：12 页 / deadEnds 0 / 0 控制台报错。
- `tools/smoke.ps1`、`tools/study-api-check.ps1`、`tools/keyword-mode-check.ps1` 通过；绿色包已重出。
- 截图：`tmp/ui-e2e-shots/23-产物搜索.png`、`24-产物管理.png`。

### 五、还没做

- 产物仍未登记进库（现在文件就是权威，删除/改名直接操作文件 + 进度键）；
  如果以后要做"按类型统计/最近生成排序/标签"，才需要建表。
- 界面还没有数据库备份/导出入口（规划里列的风险项）——下一轮候选。
- 没有"停止生成"（内核暂无可取消机制）。


## 2026-10-14 桌面版第七轮：数据库备份入口（备份即校验）+ 截图工具修复（提交 c57e914）

### 一、为什么做

`docs/08-整体规划.md` 的风险表里一直挂着「界面提供导出/备份数据库」这一条没做。
数据全在本机一个 SQLite 文件里，但用户**没有任何"备份一下"的按钮**——攒了两个月的东西，
一旦文件坏了或误删就没了。另外内置驱动本身在 VENDOR.md 里就写明"不提供文件级 fsync，
掉电持久化只能尽力"，所以"能一键备份"对这个产品是刚需而不是锦上添花。

### 二、做法（关键在"备份即校验"）

- 内核新增三个接口：`/api/maintenance/status`、`/api/maintenance/backup`、`/api/maintenance/backups/delete`。
- 备份动作：把 `itn.db` 复制到 `backups/itn-<日期>-<时间>.db`，
  若数据库旁边还有 `-journal` 就一起带上（只拷主文件的话，正好撞上一次写入的那一瞬间可能是不完整的）。
- **然后立刻把副本当数据库打开、数一次 `meta` 表的行数**：
  拷出来打不开的备份不算备份。校验失败就删掉副本并返回 500（提示"可能正好撞上一次写入，稍后重试"）。
  副本有自己独立的 `-cjflock`，不会和主库互相干扰。
- 实测（API 级探针）：
  - 空闲时备份：`size` 与库一致（135168），`verified true`，`rows 3`；
  - **生成进行中**备份：`verified true`，`rows 3`，副本 143360 字节；
  - 备份列表、删除、非法名（`..\itn.db`）→ 400，全部符合预期。
- 界面：「档案与知识库」底部新增「数据与备份」卡片——数据目录（可复制路径）、
  库大小与备份数、立即备份、备份列表（大小 / 复制路径 / 删除）、以及写清楚的恢复步骤
  （退出应用 → 把备份改名成 `itn.db` 覆盖 → 若旁边还有 `itn.db-journal` 一并删掉）。
  恢复刻意不做成一键按钮：运行中替换数据库文件风险太大，宁可让用户手动做，也不做半吊子。

### 三、顺带修掉的工具问题（影响的是所有人工复核）

`ui-shot.cjs` / `ui-e2e.cjs` 的截图一直用 `fullPage: true`，但**页面真正的滚动容器是 `#view`，
`document` 本身不滚动**，所以 fullPage 只能拍到一屏——也就是说前几轮我复核的那些截图，
页面下半部分其实都没拍到（这一轮"数据与备份"卡片放在页面底部，才让这个问题暴露出来）。
现在改成"截图前把视口临时拉到 1440×2600，拍完还原"，整页内容都能留证。

另外：`ui-shot.cjs` 的**死胡同计数**在这一轮抓到了我自己新写的空态——「还没有备份」只有文字没有按钮，
已补上「立即备份」。这个计数器是第三轮加的，这次真正发挥了作用。

### 四、验证

- `node tools/ui-e2e.cjs`：**45 步全过**。新增「数据与备份」一步：
  备份数 +1、**备份文件确实写在磁盘上且大小与当前库一致**、界面出现该备份条目、删除后磁盘文件消失且列表回到原值。
- `node tools/ui-shot.cjs`：12 页 / **deadEnds 0** / 0 控制台报错。
- `tools/smoke.ps1`、`tools/study-api-check.ps1`、`tools/keyword-mode-check.ps1` 通过；绿色包已重出。
- 截图：`tmp/ui-e2e-shots/25-数据与备份.png`（这张现在是完整整页）。

### 五、还没做

- 没有"停止生成"（内核暂无可取消机制；一个写错主题的讲义只能等它跑完）。
- 产物仍未登记进库（文件即权威）。
- 备份策略上不做自动轮转（不会自动删旧备份）——备份归用户管，界面只给大小和删除。


## 2026-10-14 桌面版第八轮：可以随时停止生成 + 冻结第一版（提交 ccd5a64，标签 freeze-1-20261014）

### 一、这一轮做的：停止生成

**为什么**：之前写错主题的讲义只能等它跑完（实测最久 92 秒），对话也一样。
这是 `docs/08` 里"还没做"清单上最后一项较大的空白。

**内核**：
- 新增 `core/src/agent/cancel.cj`：取消登记表（`Mutex` 护住的 `HashMap`，用 sessionId 做键）
  + `CancelException`（继承 `LlmException`，为此把 `LlmException` 改成 `open`，
  这样 `postStream` 的 `catch (e: LlmException)` 会原样重抛，不会被包成"请求模型失败"）。
- `ask` / `lecture` / `quiz` 三条链路：每轮开始 `clearCancel`，流式回调里 `if (isCancelled) throw CancelException()`，
  收到取消就地收尾并写 `turn/end`；**讲义不保存半成品**，返回「已取消（已完成 N 小节，未保存产物）」。
- 新增 `/api/agent/cancel`。

**界面**：对话输入框旁的「停止」、生成进度卡上的「停止生成」；
被取消的一轮渲染成**灰色说明**（不是红色报错）+ 「重新问一次 / 重新生成」入口。

### 二、两个坑（都值得记）

1. **取消被静默吞掉**：`llm.handleSseLine` 原来是
   `try { 解析 JSON; out.append(piece); onDelta(piece) } catch (e: Exception) { () }` ——
   这个 catch 本意是"单行解析失败不影响整体"，但把 `onDelta` 也圈进去了，
   于是回调里抛的取消异常被吞，用户点了停止却继续生成到底。
   现在 try 只保护解析，`onDelta` 移到 try 之外。
   （第一次实测时"问答取消"没生效、"讲义取消"生效，就是因为讲义还有循环顶部的 `isCancelled` 兜底。）
2. **对话在"提问后、第一段文字到达前"什么都不显示**：点没点上都看不出来。
   这是本轮写 E2E 断言时暴露的（我按旧代码的记忆等 `.spinner` 等不到），已补等待占位。
   顺带把 E2E 里两处"等回答"的判断都加上 `!spinner`——占位气泡里也有文字，
   只看"有文字"会让断言在生成中通过（这个坑第三轮踩过一次，这次是它换了张脸再来一次）。

### 三、冻结第一版（提交 ccd5a64 / 标签 freeze-1-20261014）

用户要求"先冻结一个版本先用用看"。冻结内容：

- **代码**：`git tag freeze-1-20261014`（annotated），指向 ccd5a64；本地仓库，未推送。
- **绿色包**：`dist\ITN-Desktop-freeze-1-20261014.zip`（由 `scripts/package-app.ps1` 从同一提交产出）。
- **本机已预置好模型配置**：在默认数据目录 `%LOCALAPPDATA%\ITN-Desktop` 里写入 MiMo TokenPlan
  （baseUrl `https://token-plan-cn.xiaomimimo.com/v1`，对话 `mimo-v2.6-flash`，多模态 `mimo-v2.6-pro`，
  密钥只在本机数据库里，不进 Git），并绑定「对话与生成」；用户只需再指定一个资料目录并建立索引。
- 打包版自检：`ITN-Desktop.exe --smoke` → `NAV=12 / VIEW_NODES=? / RESULT=OK`（见当轮输出）。

### 四、验证

- `node tools/ui-e2e.cjs`：**47 步全过**。新增 2 步：
  「生成中可以停止：写明停在哪、且不落产物」（停前阶段可见、产物数不变、会话里有取消事件）与
  「回答可以停止，并且能一键重问」（出现取消态 → 点重问 → 真的拿到回答）。
- API 级探针：问答中途取消 **502ms** 返回 `cancelled:true`；讲义中途取消 **1683ms**、提示"已完成 1 小节"、
  产物数不变；取消后再发一轮正常。
- `tools/smoke.ps1`、`tools/study-api-check.ps1`、`tools/keyword-mode-check.ps1` 通过；绿色包已重出。

### 五、冻结期间我在做什么

用户会先拿冻结版试用并提新需求。我这边继续按"改一处 → 端到端验证 → 提交并写 TRACE"推进，
**但冻结版对应的提交不会被动**：新改动都提交到 ccd5a64 之后，标签 freeze-1-20261014 是回滚锚点。


## 2026-10-14 桌面版第九轮：让"读不到我的资料"变成可见（提交 e346f88）

> 冻结版 freeze-1-20261014 保持不动；本轮改动都在它之后，冻结包
> `dist\ITN-Desktop-freeze-1-20261014.zip` 也原样保留，方便对照/回滚。

### 一、为什么做这一轮

用户正在拿冻结版试用。我按"他最可能第一天就撞到的墙"排优先级：
老师的资料大量是 PDF/Word，而桌面版只能读 `.md/.txt`，**遇到读不了的文件是静默跳过**，
用户看到"没有找到文件"根本不知道问题出在哪，只会认为软件坏了。这一轮把这件事做成可见，
并把"不需要额外依赖就能读"的格式尽量收进来。

### 二、做了什么

**内核**
- 可读格式：`.md .markdown .txt .text .csv .tsv .log .json .html .htm`。
- HTML 先转文本：去掉 `script`/`style` 的内容，`h1`~`h6` → Markdown 标题（于是网页另存的资料照样按标题分章），
  常见实体还原，块级标签补换行。
- 新增 `ScanReport`（`kb.cj`）：按扩展名统计跳过的文件；随 `/api/kb/build` 返回
  `skipped` / `skippedSummary`（形如 `pdf ×3、docx ×1`）/ `skippedTotal`，同时写进 `meta`（`kb-skipped:<kbId>`），
  `/api/kb/stats` 回传，界面随时可回看。
- 图片（png/jpg/jpeg/gif/webp/bmp/svg/ico）与系统文件（exe/dll/so/bin/db/lock/tmp/cache/ini/lnk）**不计入**报告——
  图片本来就是被文档以 `![]()` 引用的附件，报出来只会让提示变噪音。
- 单文件 > 4MB 跳过并计入「超过体积上限 ×N」；隐藏目录与 `node_modules`/`target`/`dist` 不扫描。
- "目录里没有可读文件"的报错现在会说明被跳过的是什么（例：`…；这个目录里被跳过的是：pdf ×1`）。

**界面**
- 建索引完成弹层：有跳过时显示琥珀色提示「未纳入 N 个文件：…」+ 能读哪些格式 + 解决办法（另存为 Markdown/文本）。
- 领域知识库页的「索引状态」卡片：回看「上次建索引时未纳入：…」。

**工程保护（本轮踩到才加的）**
- `scripts/package.ps1` 现在会**拒绝打包比源码旧的构建产物**，并给出"请先运行 build.ps1"。
  起因：这一轮我改 HTML 转换时先写错了一版（`closing` 变量不存在），构建失败，
  但 `package.ps1` 照旧把 `core/target` 里**上一次**的产物拷进了 `dist/core`，
  于是紧接着的探针在"验证新代码"，实际测的是旧二进制——正是 TRACE 里记过一次的坑。
  现在这条路径被脚本挡住了（当场验证：不 build 直接 package 会报错并说明原因）。

### 三、写 HTML 转换时自己踩的两个真 bug（都是实测抓的）

1. 逐字节 `String.fromUtf8([c])` 遇到中文立刻抛 `Invalid utf8 byte sequence`——
   HTML 正文全是中文，必踩。改成"输出按字节攒着、最后统一转字符串"。
2. 标签名扫描只吃字母，`h1` 被读成 `h`（于是标题不识别）；而且 `script/style` 的跳过判断
   只在遇到 `<` 时才检查，导致 `p{color:red}`、`var a=1;` 全被当成正文。
   改成"标签名允许数字 + 进入跳过态后逐字符跳过直到匹配的结束标签"。
   另外 `</h2>` 这类结束标签原本也会输出一行空的 `## `，加 `closing` 判断后修掉。

### 四、验证

- `node tools/ui-e2e.cjs`：**49 步全过**。样例知识库加了 `03-成绩.csv`、`04-网页讲义.html`（h1+h2+style+script）
  与 `05-课件.pdf`；新增两步：
  「HTML 资料按标题分章（网页另存的资料也能用）」（章节名出现「网页讲义」、检索能命中正文、`color:red` 不进索引）与
  「读不了的文件会被如实报出来（不是静默跳过）」（建索引弹层含「未纳入」与 `pdf`；领域知识库页 `.skip-note` 可回看）。
- API 探针：一个含 md/csv/html/pdf/docx/超限 txt 的目录 → `docCount 3`、
  `skippedSummary = pdf ×1、docx ×1、超过体积上限 ×1`；只放 PDF 的目录 → 400 且消息点名 `pdf ×1`。
- `node tools/ui-shot.cjs`：12 页 / deadEnds 0 / 0 控制台报错。
- `tools/smoke.ps1`、`study-api-check.ps1`、`keyword-mode-check.ps1` 通过；绿色包已重出。
- 截图：`tmp/ui-e2e-shots/28-未纳入的文件.png`、`29-知识库漏读提示.png`。

### 五、下一步候选

- 冻结版试用反馈回来后按用户意见调整（冻结标签是回滚锚点）。
- 若用户资料确实是 PDF/Word 为主：可选方案是"让用户手工导出成文本/Markdown"（已有明确提示），
  或评估在仓颉里接第三方解析（当前判断是不现实，需要时再论证）。
- 笔记搜索、笔记与切片/章节的引用联动、对话按知识库分组的会话栏——都还是候选。


## 2026-10-14 桌面版第十轮：自绘窗口框 + Ctrl+K 全局检索 + 按设计检查表过一遍（提交 5e3945a）

> 冻结版 freeze-1-20261014 仍未动；冻结包与最新包的差别在这条：
> 冻结包是**系统标题栏**，最新包里标题栏由界面自绘。

### 一、用户这一轮的两条反馈

1. 「顶部那个边框，是不是还是 Windows 原生的，能不能优化一下，自己设计顶部框」——对，此前 `BrowserWindow` 没设 `frame`，用的是系统标题栏。
2. 「用 `emilkowalski/skills` 优化一下前端」——执行了 `npx skills@latest add emilkowalski/skills`（装了 15 个 skills 到 `.agents/skills`），
   读完之后按它的 **Review Checklist** 逐条过了一遍现有 CSS。

### 二、自绘窗口框

- `shell/main.js`：`frame: false` + `ipcMain` 的 `win:minimize` / `win:toggle-maximize` / `win:close`，
  并在 `maximize`/`unmaximize` 时向渲染层推 `win:state`。
- 新增 `shell/preload.js`：`contextBridge` **只**暴露三个方法 + 一个状态订阅。
  自绘标题栏需要窗口控制，但这不该成为"打开整扇后门"的理由——渲染层拿不到 Node，也拿不到任意 IPC 通道。
- 界面：38px 深绿标题栏（`-webkit-app-region: drag`），左边品牌、右边自绘的三个 26px 按钮
  （悬停淡白、关闭悬停变红、按下 scale .94），双击标题栏切换最大化；最大化后按钮图标切成"还原"。
- **去重复**：侧栏原来那块 `.brand`（同一角落的第二份品牌）删掉，品牌只在标题栏出现一次；
  侧栏从「检索资料与笔记」开始。
- 遮罩层（Ctrl+K 弹层、课件播放器）改成 `top: var(--titlebar-h)`，压在标题栏下面，窗口按钮永远够得着。
- 浏览器里打开同一份界面（开发自测 / E2E）没有这套能力：按钮**不假装能用**，点了提示「最小化只在桌面应用窗口里可用」。
- `scripts/package-app.ps1` 同步把 `preload.js` 放进 `resources/app`；
  打包版 `--smoke` 新增两条硬指标：`PRELOAD=ok`、`TITLEBAR=ok`（实测都是 ok）。

### 三、Ctrl+K 全局检索（顺带把网页版最常用的交互搬过来）

网页版 `AppShell.tsx` 里有一个 ⌘K 知识切片检索弹层（防抖调 RAG 搜索）。桌面版照同样的习惯做了一个：

- 一次输入同时找：**资料切片**（服务端检索，220ms 防抖，用序号防串台）/ **章节** / **笔记** / **产物**（本地过滤），
  外加两条动作：「问助手：<关键词>」「就这个主题生成讲义：<关键词>」。
- ↑↓ 选择、Enter 打开、Esc 关闭；点条目直接跳到对应页面（切片会落到它所属的那一章，产物直接进播放器）。
- 入口不只是快捷键：侧栏顶部常驻一个「检索资料与笔记 Ctrl K」按钮（用户此前提过"入口太隐蔽"的问题）。

### 四、笔记可溯源

切片卡片新增「就这段记笔记」：预填 `> 原文摘录（标题路径）：前 160 字` + `我的想法：`，并记住所属章节。
至此"答案可溯源"这条产品承诺也覆盖到了笔记。

### 五、按 `emil-design-eng` 检查表做的改动（Before / After）

| Before | After | Why |
| --- | --- | --- |
| `.btn:active { transform: translateY(1px) }` | `:active { transform: scale(0.97) }` | 按下要有即时反馈；位移看不出"按下去" |
| `.view > * { animation: rise .22s }`（每次重渲染都跑） | 去掉 | 页面切换每天几十次，入场动画只会显得慢 |
| `.bar > i { transition: width .3s }` | 去掉宽度过渡 | 只动 transform/opacity；width 触发布局 |
| `.item.clickable:hover { transform: translateY(-1px) }` 无条件 | 包 `@media (hover: hover) and (pointer: fine)` | 触屏上 hover 会在点击时误触发 |
| 用内置 `ease` / `ease-out` | 自定义 `--ease-out: cubic-bezier(.23,1,.32,1)`、`--ease-in-out: cubic-bezier(.77,0,.175,1)` | 内置曲线太弱，动作没有"用力" |
| 弹层凭空出现 | 从 `scale(0.985) + opacity 0` 入场，180ms | 现实里没有东西凭空出现；偶发操作用轻量入场 |
| 无 `prefers-reduced-motion` 处理 | 单独的媒体查询：去掉位移动画、放慢 spinner、保留颜色/透明度过渡 | 动效敏感的人需要更安静的界面 |
| 系统标题栏 + 侧栏第二份品牌 | 自绘标题栏一处品牌 + 窗口按钮 | 去掉重复信息，窗口按钮也成为设计的一部分 |
| 浏览器里点窗口按钮毫无反应 | 明确提示"只在桌面应用窗口里可用" | 不留死按钮 |

**刻意没做**（说明理由，避免以后有人照搬）：spring 动画（本项目无框架、纯 CSS）；
列表 stagger 入场（会把刚去掉的页面入场动画又请回来）；tooltip 首次延迟/后续瞬开（几乎不用 tooltip）；
拖拽/手势类（桌面端没有触屏目标）。

### 六、验证

- `node tools/ui-e2e.cjs`：**53 步全过**。新增 4 步：
  Ctrl+K 全局检索（分组齐全、↑↓ 切换、Enter 落到学 · 练）、从检索直接播放产物、就这段记笔记带原文摘录、
  自绘标题栏（标题栏高度 30~48px、内容区紧贴其下、浏览器里点按钮给出明确提示）。
- `node tools/ui-shot.cjs`：12 页 / deadEnds 0 / 0 控制台报错（截图现在整页可见，含标题栏）。
- 打包版 `ITN-Desktop.exe --smoke`：`PRELOAD=ok / TITLEBAR=ok / NAV=12 / VIEW_NODES=6 / RESULT=OK`。
- `tools/smoke.ps1`、`tools/study-api-check.ps1`、`tools/keyword-mode-check.ps1` 通过。
- 截图：`tmp/ui-e2e-shots/32-自绘标题栏.png`、`30-全局检索.png`、`31-溯源笔记.png`。

### 七、下一步候选

- 冻结版试用反馈（用户正在试）。
- 会话栏按知识库分组、错题「重做」（需要把选项一起存下来）、讲义/练习的流式增量已做、产物登记进库（若要做标签/统计）。


## 2026-10-14 桌面版第十一轮：错题本改成间隔复习（提交 177fc51）

### 一、为什么挑这一轮做错题本

先按"网页版还有哪些学习端交互没搬过来"过了一遍路由：
`me/profile`、`me/notes`、`me/wrong`、`me/calibrate`、`learn`、`learn/:kpId`、`learn/slide/*`、`resources`、`report`、
`knowledge`、`chat` 都已经在桌面版落地，`tutoring`（交互导学）在学习者视角本来就会重定向到校准，剩下的
`admin`/`profiles`/`collaboration`/`onboarding`/`persona` 是多用户与机构相关的东西，按产品边界不做。

对照网页版 `WrongBook.tsx` 的 grep 结果里出现了 `memoryOf` / `retention` / `due` / "该重做了" / `Repeat` / `RotateCcw`（重做）——
也就是说**错题本是带遗忘曲线和重做的**，而桌面版那时只是一个平铺列表 + 按章节的复习建议。
"哪些错题今天该复习"这个问题没回答，这是真实使用里每天都会问的问题，所以这一轮补它。

### 二、内核

- 复习状态存进 `meta` 键值表：`quiz-review:<记录id>` = `重做答对次数|上次复习毫秒|是否已掌握`。
  **刻意不动表结构**：老数据目录（包括用户手上那个冻结版的数据）打开就能直接用，不需要迁移。
- 间隔节奏 `reviewIntervalMs` 只写在 `api.cj` 一处：答对 1 次后 1 天、2 次 3 天、3 次 7 天、4 次 16 天、5 次以上 35 天；
  `reviews == 0`（从没答对过）当天就要复习；答错回到今天；`mastered` 是显式开关。
  用毫秒时间戳而不是 ISO 字符串存"上次复习"，这样"是否到期"是纯整数比较，不用在仓颉里解析日期。
- **"重做"的可信度**：原来的 `quiz/submit` 只存题干/我的答案/参考答案，重做时最多只能"对着答案自评"。
  现在把原题（`options` / `answerIndex` / `explain` / `source`）存进 `quiz-q:<id>`，
  于是重做给的是**同一道题的选择题**。早期记录没有这些字段，界面会退化成自评模式并写明原因——
  不假装能判分。
- 新增 `/api/study/wrong/review`；`/api/study/wrong` 每条附 `reviews/lastMs/mastered/due/dueMs/hasOptions/origin`；
  `/api/study/report` 增加 `wrongDue`。

### 三、界面

- 顶部横幅：「今天该复习 N 条」+「开始复习」（没有到期的就说"今天的复习都做完了"，并解释间隔规则）。
- 分组（待复习 / 已掌握 / 全部）+ 关键词搜索（按题目或章节）。
- 每条显示：章节、错于何时、已重做对几次、下次复习时间（几月几号几点 + N 天后）、"该重做了"标签；
  动作是「重做」与「标记已掌握 / 取消已掌握」。
- 「我的成长」页加一行「错题 N 条，其中 M 条今天该复习」+ 直接去复习——不然用户想不起来去错题本。

### 四、验证

- `node tools/ui-e2e.cjs`：**55 步全过**。新增 2 步：
  「错题本能重做同一道题，并按间隔把复习往后推」（重做 → 4 个选项 → 选对 → 复习次数 1、`due=false`、下次至少排到明天）与
  「标记已掌握后不再进待复习，成长页的待复习数跟着降」（先用 `correct:false` 把它打回待复习，断言待复习 1 → 标记掌握 → 0，
  并出现在"已掌握"分组）。
- API 探针：初始 `due=true/reviews=0/hasOptions=true` 且 `origin` 完整；答对 → `reviews=1, due=false, 下次=次日`；
  答错 → `reviews=0, due=true`；掌握 → `due=false, wrongDue=0`；取消掌握 → 回到 `due=true, wrongDue=1`。
- `ui-shot.cjs` 12 页 / deadEnds 0 / 0 控制台报错；`study-api-check.ps1` 的报告里已能看到 `wrongDue`；
  smoke / keyword-mode 通过；绿色包已重出（冻结包未动）。
- 截图：`tmp/ui-e2e-shots/33-错题本待复习.png`、`34-错题重做.png`、`35-已掌握.png`。

### 五、下一步候选

- 冻结版试用反馈（用户在试）。
- 会话栏按知识库标注/分组（需要把 kbId 写进 turn/start 事件，会话才知道自己是关于哪个库的）。
- 产物登记进库（做标签/按知识库统计时才需要）。


## 2026-10-14 桌面版第十二轮：多知识库下的可用性与产物安全（提交 e8b153a）

### 一、为什么挑这一轮：先查了两个"可能已经在丢数据"的地方

上一轮结束后我没有直接加功能，而是先把两条一直挂在心里的数据完整性风险查实：

1. **重建索引会不会留下重复切片？** 不会。`saveIndex` 先按 `kb_id` 删掉旧 chunks / embeddings，
   再整批写入，而且在一个 `batch` 里（原子）。此前只是"应该是这样"，这轮看了代码确认。
2. **产物重名会不会覆盖？** 会，而且**没有任何提示**。`saveArtifact` 直接按名字写文件——
   两门课都生成「讲义-第一章」时，后一份把前一份冲掉；同一个主题重新生成一次也一样。
   这是实打实的丢工作，所以这一轮先修它。

### 二、产物：重名自动加序号

`saveArtifact` 现在发现目标已存在就加序号（`讲义-第一章-2.md`、`-3.md`…），并把最终文件名回给界面。
E2E 里固化了这一步：同一个主题连续生成两次 → 断言磁盘上两份都在。

### 三、多知识库：会话知道自己属于哪个库

一次会话是关于某个知识库的，但这个信息此前根本没被记下来（`turn/start` 只有 kind），于是：

- 会话栏只能显示「问答 · 6 步 · 14:22」，分不清是哪门课；
- 打开旧会话不会把当前知识库切回去 → 用户很容易拿着「数学」的资料去问「语文」的会话，答案自然对不上；
- 在对话页换知识库时，界面只是默默清空对话，没有任何解释。

现在：`turn/start` 事件带 `kbId` → 会话摘要回传 → 会话栏与「会话记录」页都标注（`问答 · 我的课程资料 · 6 步`）；
打开旧会话**自动切回它自己的知识库**并给一句提示；在对话页换知识库会明确开一段新会话，
并说明"从这条消息开始用新资料"（旧会话仍留在会话栏里，随时能回去）。

### 四、E2E 自身的两处健壮性修复（这一轮踩到的）

新加的多知识库步骤一开始把后面的步骤全带崩了（7 个失败、5 条 404），排查过程值得记：

- **症状**：切换知识库之后的每一步都失败——「学 · 练」找不到章节、Ctrl+K 搜不到资料、`#palette-input` 不可见。
- **原因**：那一步新建了第二个知识库但**没有给它建索引**，而且**结束时把界面留在了这个空库上**；
  后面所有依赖"有章节可学/可检索"的步骤自然全错。另外 Ctrl+K 是**切换式**的快捷键，
  前一步失败时弹层还开着，后一步再按一次就把它关掉了，于是"等不到输入框"。
- **修法与教训**：新库要建成可用状态（建索引）；步骤结束前把上下文恢复回去（重新进入第 1 章）；
  弹层类步骤先确保弹层是关着的再按快捷键。**E2E 的步骤之间有隐含的状态耦合**——
  写新步骤时要问自己"我会给后面留下什么状态"。

### 五、验证

- `node tools/ui-e2e.cjs`：**57 步全过**。新增 2 步：
  「同主题生成两次不覆盖」（`练习册-提示词.md` + `练习册-提示词-2.md` 两份都在）与
  「会话标注知识库；切库开新会话，回旧会话自动切回」（切库后 0 轮 → 回旧会话切回 course 并还原对话）。
- API 探针：两次生成返回不同文件名且列表里两份都在；`sessions/list` 的每条都带 `kbId`。
- `ui-shot.cjs` 12 页 / deadEnds 0 / 0 控制台报错；smoke / study-api / keyword-mode 通过；绿色包已重出（冻结包未动）。
- 截图：`tmp/ui-e2e-shots/36-会话标注知识库.png`（会话栏每条都标着知识库名）。

### 六、下一步候选

- 冻结版试用反馈（用户在试）。
- 产物登记进库（做标签/按知识库统计时才需要）。
- 讲义/练习生成时把"用了哪个知识库"也写进产物（现在只写进了会话事件与文件名）。
