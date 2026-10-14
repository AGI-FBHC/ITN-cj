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
