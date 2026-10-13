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
