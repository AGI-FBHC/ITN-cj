# ITN-cj 前端变更记录

## 2026-10-18 知识网络页右上角装饰与发版缓存修复

用户反馈：`/learn` 页右上角蕨叶/草丛装饰悬空压在“本章导航”卡片上，视觉突兀；随后又遇到 `Failed to fetch dynamically imported module: .../WrongBook-*.js`。

### 1. 右上角装饰

- `src/pages/Learn.tsx`：移除页头右侧绝对定位的 Fern / GrassTuft，避免高度超出页头后压到下方卡片。
- `src/components/learn/ChapterSidebar.tsx`：把蕨叶与草丛收进“本章导航”卡片右上角，卡片增加 `relative overflow-hidden`，装饰使用低透明度并按圆角裁切，成为角标而不是悬浮物。
- 效果：装饰与卡片形成一体，不再遮挡/悬空；页面标题行保持干净。

### 2. 发版后旧 chunk 404

根因：重新部署时替换了 `dist`，旧 index 仍引用旧哈希文件名；懒加载 `WrongBook-*.js` 时文件已不存在。

- `src/main.tsx`：监听 Vite 的 `vite:preloadError`，10 秒内只自动刷新一次，拿到新 index 后恢复。
- `src/components/RootErrorBoundary.tsx`：识别动态导入失败，提示“页面刚刚更新，旧资源已失效”，只保留“刷新页面”主操作；不再引导用户清空本地数据。
- 部署侧：`deploy/nginx.conf` 对 `index.html` 加 `no-cache, no-store, must-revalidate`；部署说明改为 `rsync -a` 而不是 `--delete`，保留旧哈希 assets，避免已打开页面突然 404。

### 验证

- `npx vite build` 通过（`tsc -b` 仍有仓库既有的历史类型错误，本次未新增）。
- 构建产物包含 `lf.chunkReloadAt` 兜底逻辑。
- 公网 `/learn` 登录态截图确认：装饰已收进“本章导航”卡片右上角，卡片不再被压住。
- `http://43.160.236.121:20889/`、`/assets/WrongBook-CeE7joW9.js` 均返回 200。

### 说明

本次直接更新 `front` 分支并部署到 20889。后续前端发版请保留旧 `assets` 文件；若用户仍停留在旧 index，刷新一次即可。
## 2026-10-18 追加：移除知识网络页右上角装饰

用户反馈角标仍不理想，要求直接去掉。已从 `ChapterSidebar` 删除 Fern / GrassTuft 及其 import，恢复干净卡片；`vite build` 通过并已部署。发版 chunk 自动刷新与保留旧 assets 的机制保留。

## 2026-10-18 页面崩溃修复审计（会话 01a14f66-003f-71f1-addf-07a76856b570）

### 用户诉求与边界

用户要求读取会话 codex://threads/01a14ef5-cec6-74d3-82e0-5c055eb0e76c（标题“合并、联调”），核实其最新“页面出错了 / Failed to fetch dynamically imported module: .../WrongBook-CeE7joW9.js”问题是否解决。用户对上次排障质量有疑问；本次以当前源码和真实浏览器证据判断，不评价模型能力。本轮执行核查及故障注入，没有修改功能代码、发布服务器或推送远端。按用户规则使用 PowerShell 7，并在项目根目录追加 TRACE，提交本地 Git。

### 仓库和版本

- 本次聊天工作目录 C:\Users\GeJie\.codex\worktrees\5a82\ITN，HEAD b32380a，是旧主线，不能当作当前前端。
- 实际已部署前端 D:\Desktop\ITN\ITN-cj-front，front 分支，核查开始时 HEAD b9af089，功能代码工作区干净。
- 前端先前修复 b219571；移除装饰 b9af089。
- 部署工程 D:\Desktop\ITN\tmp\ITN-cj-merge-inspect，cangjie-integration 分支；检查 deploy/nginx.conf，未修改。
- 读取上个会话最新相关轮次、上述前端 TRACE.md、main.tsx、RootErrorBoundary.tsx、App.tsx、BootGate.tsx。更早讨论仓颉目录的历史引用与本次 chunk 问题无关，未扩大历史读取范围。

### 当前线上 HTTP 证据

地址 http://43.160.236.121:20889/，本轮直接 HTTP 请求实测：

- /、/index.html、/learn 均 200，Content-Type text/html，Cache-Control: no-cache, no-store, must-revalidate；内容一致。
- 当前入口 /assets/index-CLgSbxm-.js 返回真实 JS，包含 lf.chunkReloadAt 自动刷新处理；当前错题本 chunk 为 WrongBook-DHROjuqW.js。
- 原始报错 /assets/WrongBook-CeE7joW9.js 返回 200 application/javascript，15258 字节，SHA256 54cdbe57adf6e43c6db71aa5d90106c07d07b2d0d08415282d288e1532006e5b。它的 9 个直接依赖也均返回 200，包含旧 index-CPIWhiPj.js（该旧入口没有自动刷新处理）。因此这次没有把“返回 HTML 的假 200”误判为资源恢复。
- 不存在资源 /assets/__audit_nonexistent__.js 返回 404，静态资源未错误回退成 SPA HTML。
- 从两个入口提取并检查的各 25 个 JS 文件名中，旧入口全部可访问；新入口开发专用 MarkdownCheck-Dx4En8vv.js 一次请求超时，其余可访问。该开发路由在生产未注册，本次不能据此宣称线上全部资源完全无故障。

### 浏览器验证与实际复现

使用独立 Chrome 会话（没有使用用户的日常浏览器资料），通过真实“游客体验”按钮、选择“小明”画像、点击“继续学习”进入系统：

1. 正常链路：进入 /me，点击“错题本”到 /me/wrong，错题本标题出现；再点击“学 · 练”到 /learn，“本章导航”出现。这些正常加载路径没有出现根错误边界。
2. 单次瞬时 chunk 失败：回 /me，清除测试会话 lf.chunkReloadAt，浏览器拦截 WrongBook-*.js，只将第一次请求 abort，第二次放行。应用自动刷新并恢复 /me/wrong。测试结果 chunkRequests=2、mainFrameNavigations=2（包括 SPA 跳转及刷新，不代表两次刷新）、recovered=true。
3. 保护期内再次失败：回 /me，在测试会话设置 lf.chunkReloadAt=Date.now()，模拟刚发生过自动刷新；将 WrongBook-*.js 请求 abort 后点击错题本。稳定复现根错误边界“页面出错了”，原始控制台错误 TypeError: Cannot read properties of undefined (reading 'default')。
4. 错误页此时仍提示旧本地数据不兼容，并显示“清空本地数据并刷新”，属于误导。解除浏览器拦截后手动刷新，错题本恢复。
5. 上述故障只在独立测试浏览器注入，没有删除服务器文件，也没有破坏线上资源。

### 根因与结论

结论：部分修复，不能认定彻底解决。原报错资源已恢复、HTML 缓存策略生效、正常导航和单次失败自动恢复通过；但二次失败恢复路径有明确代码缺陷。

src/main.tsx:16-29 中先无条件 event.preventDefault()（第 17 行），再判断最近刷新是否超过 10 秒（第 22 行）。保护期内既阻止 Vite 抛出原始动态导入错误，也不刷新，导致 lazy import 得到 undefined，React 读取 default 抛出 TypeError。RootErrorBoundary 只按原动态导入错误消息识别 chunk 错误，无法识别这个被转换的 TypeError，因此显示清数据入口。

后续修复方向：只有实际执行恢复动作时才处理/阻止该错误；达到重试限制时保留原始错误并提供可手动重试的资源错误提示，避免误导清数据；验证首次失败、保护期内再次失败、持续失败和 sessionStorage 不可用的分支。当前 10 秒窗口只限制频率，不保证持续失败时永远只刷新一次；本轮没有以禁用 sessionStorage 的方式实测该分支，不能将推断写成已复现。

另外，浏览器多次观测 /api/v1/learning-template-resources?domainCode=agent 返回 HTTP 500；正常页面仍能显示。本次未定位其后端根因，不能把它与 JS chunk 崩溃混为同一问题。

### 证据文件和工具情况

- 复现截图 D:\Temp\itn-chunk-failure-audit.png。
- 复现脚本 D:\Temp\itn-crash-audit.js；单次失败恢复脚本 D:\Temp\itn-transient-audit.js。
- 控制台/快照 D:\Temp\itn-crash-audit-20261018-browser-logs\console-2026-10-18T14-29-01-631Z.log；关键原始 TypeError 及 RootErrorBoundary 栈均保存。
- Playwright CLI 默认缓存目录 C:\Users\GeJie\AppData\Local\ms-playwright 为异常 reparse point，创建 daemon 失败。最终仅对测试进程设置 LOCALAPPDATA=D:\Temp\itn-browser-local、PWTEST_DAEMON_SESSION_DIR=D:\Temp\itn-playwright-audit 后成功运行；未改用户系统环境或目录。
- 测试完成关闭独立浏览器，将 CLI 临时日志移到上述临时目录，保持前端源码工作区整洁。未运行构建，因为本轮没有功能变更。

## 2026-10-18 修复动态资源加载失败的二次崩溃

用户在审计结论后明确要求“帮我修复”，本轮授权实施修复和更新已有 20889 测试站点。

- 新增 src/lib/chunkRecovery.ts：保留 Vite 原始 rejection，不再调用 preventDefault，避免 React.lazy 得到 undefined 后触发读取 default 的二次异常。按事件 payload 记录实际 preload 错误，兼容动态导入/CSS/chunk 常见错误消息。
- 同一标签页用既有 lf.chunkReloadAt 标记最多自动刷新一次；不再经过 10 秒后重试。标记必须成功写入 sessionStorage 才自动刷新；读写异常则保留原始错误并转人工重试，避免存储不可用时无限刷新。既有重试标记继续生效；刷新不会清除标记，所以持续故障不会循环。
- main.tsx 在 ensureStorageSchema 后安装处理，防止首次 schema 迁移删除刚写的恢复标记。
- RootErrorBoundary 对资源失败显示“页面资源加载失败”、网络/稍后重试说明和“重新加载页面”按钮；该类错误不提供清空数据操作。一般渲染错误原有处理保持不变。
- 新增 tests/chunkRecovery.test.mjs，使用 Node 内置测试框架和现有 TypeScript 编译器，未新增 npm 依赖。4 组测试通过，覆盖跨文档持续失败、保护期/旧标记、存储 get/set 异常、浏览器错误识别及无关错误不被误认。执行 node --test tests/chunkRecovery.test.mjs。
- 修改的 TS/TSX 文件定向 ESLint 和 chunkRecovery 严格 TypeScript 检查通过；npx vite build 通过，入口 index-KTreDdLj.js。全量 tsc -b 仍失败（原有 ChatStream/KnowledgeGraph3D/Learn/CourseResourcePlayer 等类型问题），完整输出 D:\Temp\itn-typecheck-20261018.txt，不包含本次修改文件错误。没有宣称完整 npm run build 通过。
- 本地生产预览 http://127.0.0.1:4002，API 同源代理至既有 20889。独立 Chrome 真实游客登录；浏览器故障注入通过：正常错题本和知识网络、单次失败 1 次文档刷新恢复、已有重试标记再次失败 0 次自动刷新、手动重试恢复、持续失败超过 11 秒仍仅 1 次自动刷新、sessionStorage 不可用 0 次自动刷新。每次错误保留原始动态导入消息，无 default 二次错误、无清数据提示；登录令牌与本地学习标记保持一致。
- 浏览器回归脚本 D:\Temp\itn-regression-browser.js；错误页截图 D:\Temp\itn-regression-20261018\recoverable-error.png。仅在独立测试浏览器拦截 JS，没有删除线上文件。
- 服务器预检：api/business healthy，web 运行；Nginx 配置检查通过，磁盘剩余约 9.6 GB。SSH 密钥登录不可用，复用前一授权部署会话中的已有凭据，仅运行时解析并认证，没有将密码写进新脚本、日志或 Git。
- 功能代码先提交本地 Git，随后部署；发版采用先补齐 assets、最后原子替换 index.html，保留原 dist 目录及历史哈希资源，并备份旧入口以便回滚。线上验收结果在本文件后续追加。

## 2026-10-18 修复上线与验收完成（功能提交 e1232b7）

- 实际部署地址 http://43.160.236.121:20889/。仅更新前端静态文件，没有重启容器或修改后端/数据库。
- 发布包 D:\Temp\chunk-recovery-e1232b7.tgz（8447657 字节）；先解包至服务器 _upload/chunk-recovery-e1232b7-ov9ra40l，再补齐资源，最后在现有 dist 目录内用 os.replace 原子替换 index.html，目录 inode 保持不变。387 个既有 assets 文件全部保留。
- 新入口 /assets/index-KTreDdLj.js，当前错题本 WrongBook-YuEnpyPb.js。线上首页 SHA256 f7ed31611d6d015b7d1d45ba260474d33babadf9d6edea280ee67f7ca41e0098，与本地构建一致。
- /、/learn 返回 200 和 no-cache, no-store, must-revalidate；/health 返回 200。旧 WrongBook-CeE7joW9.js、上一版 WrongBook-DHROjuqW.js 均仍为 200 application/javascript；原始报错 chunk 的 SHA256 与发版前一致。
- 旧首页已备份为 /home/ubuntu/itn-cangjie-stack/_upload/index-before-chunk-recovery-e1232b7.html。回滚只需先把该备份复制为 web/dist/index.html.rollback，再 mv 到 web/dist/index.html；因旧 assets 保留，无需删除新资产或重启整个栈。回滚会恢复有缺陷的前端，只有需要时再执行。
- 上线后独立 Chrome 重新真实游客登录，完整重复本地 7 个场景，全部通过：正常错题本/知识网络；瞬时失败 requests=2/documentReloads=1；已有恢复标记再次失败 documentReloads=0；手动重试成功；持续失败等待 11 秒 requests=2/documentReloads=1；恢复标记的 sessionStorage 读取被 SecurityError 拒绝时 documentReloads=0；最终登录令牌和本地学习标记均未变化。存储测试仅针对恢复处理访问的键，未声称整个应用所有存储调用都已适配禁用存储环境。
- 错误页截图已经视觉核验：资源失败显示正确标题和原始导入错误，只提供“重新加载页面”；未出现 default 二次异常或清空数据按钮。浏览器请求 abort 均限独立测试会话，测试后解除并关闭浏览器；本地预览也已停止。
- 验收文件：D:\Temp\itn-regression-20261018\live-browser-results.txt、local-browser-results.txt、deployment.json、recoverable-error.png；线上控制台 D:\Temp\.playwright-cli\console-2026-10-18T14-43-02-644Z.log。本轮未提交临时浏览器日志、凭据或构建包。
- 4 组 Node 回归测试、定向 ESLint/严格 TS 检查和 Vite 生产构建通过。全量 tsc -b 仍有 19 条原有类型错误（与本次修改文件无关）；原有 learning-template-resources 接口 HTTP 500 仍可观测，未在本次动态模块恢复修复中处理。
- Git 按用户要求只提交本地，没有推送远端：功能提交 e1232b7；本次追加记录另作文档提交。聊天旧主线根目录 TRACE.md 同步记录实际前端路径和部署交接信息，避免跨会话在错误工作树继续修改。
