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
