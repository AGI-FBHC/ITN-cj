# ITN-cj 仓颉版集成与部署记录

## 2026-10-18 会话目标

用户要求查看 GitHub 上已有分支，确定如何合并团队已完成的仓颉分支，并部署到腾讯云 `43.160.236.121`，通过 `http://43.160.236.121:20889/` 访问。

## 远端分支盘点

`git@github.com:AGI-FBHC/ITN-cj.git`：

| 分支 | 内容 |
| --- | --- |
| `main` | 仅 Initial commit |
| `front` | React 网页前端（942 条历史） |
| `full` | 旧版完整代码快照 |
| `yjyprojects` | 业务后端：认证、组织、管理员、学习者画像、成长报告等 |
| `zyqprojects` | 数据/Agent API：笔记、课程、会话、演示文稿、资源任务等，并带转发网关 |

`yjyprojects` 基于 `main`；`zyqprojects` 是独立根提交，二者无共同祖先，合并时必须 `--allow-unrelated-histories`。

## 集成方案

新建分支 `cangjie-integration`，以 `zyqprojects` 为基线合并 `yjyprojects`，采用“两套仓颉服务 + Nginx 统一入口”：

```text
浏览器 :20889
  └─ Nginx
       ├─ /                          → React 静态文件
       └─ /api/v1 /v1 /internal/v1   → itn-cj-api:8100（zyq）
            ├─ 已迁移路由            → MySQL itn_cangjie_dev
            ├─ 未迁移 /api/v1        → itn-cj-business:5000（yjy）
            └─ 未迁移 /v1            → itn-agents-v2:8000（Python）
```

这样避免把两个独立 `cjpm` 工程强行合成一个包，同时保留两边全部能力。

## 集成分支提交

- `1cf5ba4` merge `origin/yjyprojects`（仅 README 冲突，已重写为集成说明）
- `a788f2f` 把 yjy 工程从 `src/backend-cj` 移到 `backend-cj/`，避免根 `cjpm` 扫描两套源码
- `9792d4f` 给根 `cjpm.toml` 补 Linux 目标与 STDX 路径
- `779f397` 增加 `deploy/`（compose、Nginx、环境变量模板、构建脚本）
- `c662bba` 启动前 `source /opt/cangjie/envsetup.sh`，补运行时库路径
- `e10c28f` / `1b1d0a0` 业务服务统一 5000 端口；Nginx 保留缓存目录权限
- `2940f04` / `2715410` 修复 Linux 下 MySQL 文本长度读取（32/64 位差异）
- `d5bcad5` 固定部署网段 `172.28.0.0/24`，恢复通用错误信息

## 构建与部署

服务器目录：

```text
/home/ubuntu/itn-cangjie-stack/
  docker-compose.yml
  nginx.conf
  app/api/main
  app/business/main
  web/dist/
  env/api.env        # 0600
  env/business.env   # 0600
```

镜像：

- `itn-cangjie-sdk:1.1.3`：原有 SDK/STDX/Spire 镜像
- `itn-cangjie-sdk:1.1.3-mysql`：在其上安装 `default-libmysqlclient-dev`，供 yjy 链接 `-lmysqlclient`

关键构建命令：

```bash
docker run --rm -v /home/ubuntu/itn-cangjie-staging:/workspace itn-cangjie-sdk:1.1.3 \
  bash -lc 'source /opt/cangjie/envsetup.sh; export CANGJIE_STDX_PATH=/opt/stdx/linux_x86_64_cjnative/static/stdx; cd /workspace; cjpm build -i -j1'
```

yjy 使用 `itn-cangjie-sdk:1.1.3-mysql`，挂载 `backend-cj`。

前端：`front` 分支 `npm ci` 后 `npx vite build`。注意 `npm run build` 会先跑 `tsc -b`，当前分支存在历史类型错误，暂时用 `vite build` 产出。

## 部署时修复的问题

1. **Linux 目标缺失**：根 `cjpm.toml` 只有 mingw 配置，补 `x86_64-unknown-linux-gnu` 和 STDX `bin-dependencies`。
2. **运行时库缺失**：直接启动二进制报 `libcangjie-runtime.so` 找不到，compose 改为 `bash -lc 'source /opt/cangjie/envsetup.sh && exec /app/main'`。
3. **yjy 缺 MySQL 客户端库**：新建 `1.1.3-mysql` 镜像。
4. **业务服务端口**：`host.run()` 实际监听 5000（`HTTP_PORTS` 未生效），API 网关和健康检查统一改为 `business:5000`。
5. **Nginx 只读降权**：`cap_drop ALL` 时无法 chown 缓存目录，去掉 web 的 `cap_drop`，保留 `no-new-privileges`。
6. **MySQL 长度读取**：yjy 的 `mysql_fetch_lengths` 按 32 位读取，Linux x64 的 `unsigned long` 是 64 位，导致多列查询长度错位、`Invalid utf8 byte sequence`。改为按 C 字符串长度读取；`MySqlConnection` 和 `DbTransaction` 两处都修。
7. **zyq 不解析主机名**：其自研 MySQL 客户端只接受 IPv4 字面量，`host.docker.internal` 报 `IPv4 address too long`。compose 固定网段 `172.28.0.0/24`，环境文件使用 `172.28.0.1`。
8. **错误信息调试**：定位期间临时把异常信息放入 500 响应，修复后已回退为通用“服务器内部错误”。

## 线上验证（2026-10-18）

服务器容器：

- `itn-cj-api`：healthy
- `itn-cj-business`：healthy
- `itn-cj-web`：`0.0.0.0:20889->80`
- 旧演示容器 `itn-cangjie-web`：已停止，`restart=no`（可回滚启动）

接口冒烟（真实令牌）：

| 接口 | 状态 |
| --- | --- |
| `/` | 200 |
| `/health` | 200 |
| `POST /api/v1/auth/guest-login` | 200 |
| `POST /api/v1/auth/login` | 200（clean1 测试账号） |
| `/api/v1/learners` | 200 |
| `/api/v1/profile` | 200 |
| `/api/v1/rag/domains` | 200 |
| `/v1/notes` | 200 |
| `/v1/courses` | 200 |
| `/v1/course-progress` | 200 |
| `/v1/agent-sessions` | 200 |
| `/v1/presentations` | 200 |
| `/v1/customize-tasks` | 200 |
| `/v1/learning-resource-tasks` | 200 |
| `/v1/chat/sessions` | 200（转发 Python agents） |
| `POST /v1/notes` | 201 |
| `DELETE /v1/notes/{id}` | 204 |

公网访问 `http://43.160.236.121:20889/` 返回 200；Edge headless 等待 20 秒后截图确认已进入“智训云枢”登录页。

## 回滚

```bash
cd /home/ubuntu/itn-cangjie-stack
docker compose down
docker update --restart=unless-stopped itn-cangjie-web
docker start itn-cangjie-web
```

## 遗留

- `front` 分支 `npm run build`（`tsc -b`）有历史类型错误：`Learn.tsx`、`Report.tsx`、`Resources.tsx`、`SlidePlayer.tsx`、`Welcome.tsx`。当前部署使用 `vite build` 绕过，建议前端负责人单独修复。
- 服务器根盘使用率 92%，剩余约 9.6 GB；后续新增镜像/构建产物前需清理。
- 旧版 Vue 前端与 `full` 分支未部署，仍保留在 GitHub 供对照。
## 2026-10-18 将当前部署版本提交到 main（会话 01a14f66-003f-71f1-addf-07a76856b570）

### 用户要求和发布范围

用户先确认当前站点是否已合并，随后明确要求“提交到main分支”。目标仓库为 AGI-FBHC/ITN-cj，而非聊天原始工作树所对应的旧 ITN 仓库。本轮把当前已部署的前后端源码及崩溃修复纳入 main，并正常推送远端；不做服务重新部署或数据库操作。

### 分支核查

重新 fetch 并 ls-remote 核对：origin/main=4e4d202（初始提交），origin/cangjie-integration=5b05a17，origin/front=b9af089，origin/yjyprojects=15441d9，origin/zyqprojects=07aa2c3。当前部署后端来源 5b05a17，其中合并 1cf5ba4 已包含 zyq 基线 eafb941 与 yjy 15441d9。

zyq 新增 07aa2c3（scores_json 单写入及鉴权深化）尚未部署；按用户要求提交“当前部署内容”，本轮保留在原开发分支，未混入 main。前端来源是本地 front 的 e00384c，包含功能修复 e1232b7 以及验收文档；该本地修复此前未单独推送 front，本轮随 main 的历史一起发布。

### 合并方式和目录

- 原检查工作树 D:\Desktop\ITN\tmp\ITN-cj-merge-inspect 仍保持 cangjie-integration；原前端 D:\Desktop\ITN\ITN-cj-front 保持 front。
- 新建 Git 工作树 D:\Desktop\ITN\tmp\ITN-cj-main-release，检出已有 main。先 fast-forward 至 5b05a17，再用 git subtree add --prefix=frontend 导入前端 e00384c，创建双亲合并提交 57918b1（双亲 5b05a17、e00384c），保留两条开发线的提交历史。
- main 根 src/ 和 cjpm.* 保持 zyq API；backend-cj/ 保持 yjy；frontend/ 包含 React 前端；deploy/ 提供部署配置。避免把两种 src/ 文件混到一起。
- subtree 导入后的 frontend 树对象为 c79ddfa19e035057036321658ba3fef3176ed7b0，与来源 e00384c 的根树对象完全一致。git diff 5b05a17 -- src backend-cj cjpm.toml cjpm.lock config resources 无差异。
- README.md 更新为 main 完整源码入口，说明 frontend 开发、构建、测试与来源；修正业务服务示意端口为5000。deploy/README.md 改为检出 main、构建 frontend/，保留旧 assets，先复制资源再原子替换 index.html；说明源码示例目录必须实际 clone，不假定服务器已有 /home/ubuntu/itn-cangjie-src。

### 验证

- 从 main/frontend 执行 node --test tests/chunkRecovery.test.mjs：4组全部通过。
- main/frontend 执行 npx vite build：通过，18.82秒；入口 index-KTreDdLj.js，index.html SHA256 f7ed31611d6d015b7d1d45ba260474d33babadf9d6edea280ee67f7ca41e0098，与当前线上及原前端构建一致。
- 仅在本地把 frontend/node_modules 链接到原已验证依赖以便复用；node_modules 和 dist 均由前端 .gitignore 忽略，不提交到 Git。构建日志 D:\Temp\itn-main-build-20261018.txt。
- 验证 main 保留原 origin/main 及 e1232b7 的祖先关系；git diff --check 通过。后端源码未变，因此未重复运行仓颉编译或重新部署。
- 原有全量 TypeScript 检查19条报错与资源接口500的限制继续存在，本轮不宣称这些已修复。

### 部分克隆问题与处理

集成仓库是 blob:none 部分克隆，从本地前端 fetch 后只接入了历史和树对象，read-tree 触发 GitHub 拉取当前前端缺失的288个对象并停滞。中断该次导入并仅结束对应 read-tree/fetch/index-pack 进程，清理该工作树的遗留 index.lock；没有删除其他Git文件。

用原前端副本导出已验证当前树328个对象（源副本全部存在）并 index-pack 到目标，再补入 b9af089..e00384c 的17个未公开本地提交所需对象。随后 subtree add 成功；未改全局 Git 配置、未覆盖开发分支、未重写历史。推送使用普通 git push origin main，若远端有并发变化会由 Git 拒绝，禁止强推。

## 2026-10-19 总 README 重写、Desktop 纳入 main 与目录整理

### 用户对话与授权

用户指出上一版 README 像内部交接记录，要求先给方案审核；随后提出把 Desktop 一并放进 main。已只读检查 desktop 分支并给出 apps/web、apps/desktop、services/api、services/business、deploy/web 的结构方案。用户明确接受方案，要求落地、重写同时覆盖 Web 和 Desktop 的总 README，附原仓库链接，并说明本仓库是基于仓颉开发的新版本。实施期间用户进一步要求标题不要再加“仓颉版”，已将总标题定为 ITN，将仓颉背景放在正文介绍中。

### 源码与来源

- 操作目标 AGI-FBHC/ITN-cj/main，工作树 D:\Desktop\ITN\tmp\ITN-cj-main-release。开始时 main=10549a2；重新 fetch 和 ls-remote 确认 desktop=49ad7d234a4968d0b3298b9098ab5eff480f88c8。
- 原项目地址 https://github.com/AGI-FBHC/ITN，通过旧项目 Git remote 和 GitHub 仓库元数据双重核实；名称为 ITN（Intelligent Training Nexus）。总 README 已附链接，未把 ITN-Beta 或其他分支误写成原项目。
- Desktop 本机副本 D:\Desktop\ITN\ITN-Desktop 位于相同提交49ad7d2，另有两份未跟踪的方案笔记。本次只导入已提交的分支源码，不移动、覆盖或提交用户原副本中的笔记与运行数据。
- 从原 Desktop Git 对象库导出当前树671个对象（9301882字节）到部分克隆对象库，避免前一轮 read-tree 触发网络补 blob 的停滞。使用 git subtree add --prefix=apps/desktop origin/desktop 创建合并 a3971c4，双亲10549a2和49ad7d2，保留Desktop提交历史。导入时子树83ce03b4052ab7535642f8c3ddfe8186ea8c6bd2与源分支根树一致。

### 目录与文档

- 原 frontend/ 移到 apps/web/。
- 原根 src/、config/、resources/、tmp_verify/、cjpm.toml、cjpm.lock 移入 services/api/；原 backend-cj/ 移为 services/business/。
- 原 deploy 下配置与脚本移入 deploy/web/。Desktop 内部的 core、shell、lumin、third_party、scripts、tools、docs 等布局整体保留。
- Windows 目录移动前逐一检查源和目标绝对路径都在本工作树内，使用 git mv 保留移动关系。原 source worktrees 保持原分支和文件。
- 总 README 以项目定位、原项目来源、Web/Desktop 对照、代码结构和开发文档导航组织；移除了根 README 中的具体服务器信息、开发者分工、提交哈希和故障交接记录。标题按用户最新要求为 ITN，简介说明基于仓颉开发的新版本，并如实写明 Web 部分 Agent 能力仍接入现有 Python 服务。
- 重写 apps/web/README.md 和 apps/desktop/README.md；补充 API README、整体架构和开发验证文档。Desktop 原有“尚未初始化工程”等陈旧描述已从入口 README/core README/scripts README 中更新为当前源码与构建方式。Desktop 打包使用当前真实名称 Lumin 和 dist/Lumin 产物路径。
- 根 AGENTS 统一协作入口；新操作只追加根 TRACE。Desktop AGENTS 中的 TRACE 指向 ../../TRACE.md；导入前的各端 TRACE 保留为历史，未删除、覆盖或继续分叉。

### 路径和配置适配

- deploy/web/build.sh 从脚本位置推导仓库根目录，显式检查 services/api 与 services/business 的 cjpm.toml，并按新目录挂载编译、复制可执行文件。
- deploy/web/deploy.sh 的源码根、API工作目录和预期分支更新为新布局/main；本轮没有运行该部署脚本或修改线上进程。
- Desktop publish-lumin.ps1 从当前Git顶层和当前目录前缀计算 apps/desktop/lumin，避免在子目录运行git subtree时找错前缀。只检查了路径和语法，没有向独立 Lumin 仓库发布。
- Web .env.example 更新为仓颉 API 网关联调地址，/api和/v1可同指8100；真实地址由开发者在被忽略的.env.local中设置。未写入真实密钥。
- 根/API .gitignore 随目录调整，覆盖依赖、构建产物和本地环境；增加Shell脚本LF、Windows批处理CRLF的.gitattributes。已核实4个已跟踪Desktop批处理为ASCII且使用CRLF。
- 一条过长的批量写文件shell请求被工具策略拦截，没有执行；随后改用apply_patch完成逐文件修改，没有绕过执行权限或扩大操作范围。

### 验证结果

1. Web：从 apps/web 运行4组Node资源恢复回归测试，全部通过；npx vite build 成功（20.16秒）。首页 SHA256 f7ed31611d6d015b7d1d45ba260474d33babadf9d6edea280ee67f7ca41e0098，与之前已部署版本一致。
2. Desktop：在迁移目录使用实际安装的仓颉1.2.0、STDX和OpenSSL构建，cjpm build 成功（2条既有废弃API告警）。core的cjpm test共156项全部通过，0失败/0跳过；package.ps1成功生成独立内核与4个DLL，并做拷贝哈希核验。
3. Desktop本地API：既有 tools/api-route-smoke.ps1 在全新数据目录下检查145条路由的空JSON和坏JSON入口，结果 no5xx=yes、noUnknownRoute=yes。报告位于 apps/desktop/tmp/audit/api-route-smoke.json（忽略的本地产物）。
4. Desktop界面：用新路径打包内核、全新临时数据目录、迁移后的shell/renderer启动本地服务；独立Chrome打开Lumin，显示“已连接”，6个导航入口、#view有渲染节点，资源请求无4xx/5xx。检查后关闭专用浏览器，核对进程路径和数据目录后仅结束本轮内核进程。未启动会注册用户lumin://协议的Electron主程序。
5. 文档和脚本：新入口文档29个相对链接全部存在；PowerShell脚本AST检查与两份Bash脚本语法检查通过。用临时目录和mock docker验证 build.sh 默认根路径、带空格路径、两个新服务挂载、产物复制位置；缺失源目录时在调用Docker前拒绝。该检查只验证路径/调用约定，不等同于重新编译Linux服务端。
6. 树一致性：移动后的6组源码/资源树与移动前完全相同：services/api/src、config、resources、tmp_verify，services/business/src，apps/web/src。Desktop核心、Lumin、第三方依赖和界面运行代码未修改；变化集中在目录、文档、忽略规则和辅助脚本路径。
7. 依赖复用：apps/web保留了原验证工作树已有的node_modules链接；Desktop shell使用原副本node_modules的本地链接。依赖、dist、target、日志、个人配置均不提交。原Desktop副本仍仅有原先两份未跟踪笔记，原Web副本Git工作区仍干净。

### 边界与交接

- 本轮未重新部署服务器、未改数据库，也未把zyqprojects先前未部署的后续提交混入现有发布内容。
- 本轮验证了Desktop本地内核、打包内核和托管界面；没有重新制作完整Electron分发包，没有验证真实远程模型生成质量，也没有发布独立Lumin仓库。
- Web全量tsc既有错误、已知服务端资源接口500仍需各自处理；本轮没有宣称全部业务已完成或全部代码均已仓颉化。
- 主要日志 D:\Temp\itn-monorepo-desktop-build-20261019.txt、itn-monorepo-desktop-tests-20261019.txt、itn-monorepo-desktop-package-20261019.txt、itn-monorepo-desktop-routes-20261019.txt、itn-monorepo-web-build-20261019.txt。界面检查进程信息 D:\Temp\itn-monorepo-ui-manifest-20261019.json。
- 沿用用户前文提交main的授权，本轮在上述检查后提交整理结果并普通推送main，不强推。后续从仓库根README按组件进入开发，不再在根直接运行cjpm或Vite。

## 2026-10-19 明确总 README 面向使用者并修正

用户先质疑“开始开发”，随后明确说明“README是写给用户看的 不是写给开发者看的”。此前仅解释写偏了，没有立即调整文档；本轮按这一明确要求重写根 README，保留 ITN 标题、原仓库链接和仓颉新版本背景，内容改为两种产品的用途、使用选择、网页版体验入口、桌面版使用步骤、用户资料与记录及使用手册。

从根 README 移除开发命令、源码目录树、工具链/SDK、前后端实现细节、类型检查和构建限制以及面向开发者的文档导航。各组件开发文档仍保留在原位置，不再作为总 README 的主体或用户入口。根 README 不把尚无发布包的 Desktop 写成已有下载：通过 gh release list 当前返回空数组核实，已如实说明暂无桌面应用下载包；应用包启动文件依据实际打包脚本写为 Lumin.exe。

验证：当前网页版体验地址 http://43.160.236.121:20889/ 公网直连HTTP200；登录源码存在游客体验入口；使用说明及本地链接存在；检查总标题、两端内容、原仓库链接，并确认无开发命令和SDK/源码结构段落。本轮只修改 README 和追加 TRACE，没有重跑无关构建或改变功能、目录和线上环境。按前文 main 交付授权提交并普通推送 main。

## 2026-10-19 Desktop docs 仅本地保留，停止在 main 与 desktop 发布

用户明确要求“desktop版本的docs不用上传github 主分支和desktop分支都是 不需要”。本轮范围为 main 的 apps/desktop/docs/ 和 desktop 分支的根 docs/；保留 main 的跨端 docs/ 和 Lumin 自身的运行时文档，没有扩大到所有Markdown或改写历史。

main起点cbe7070，desktop起点49ad7d2，均已重新fetch/ls-remote核实。为desktop创建独立工作树 D:\Desktop\ITN\tmp\ITN-cj-desktop-public（本地codex/private-desktop-docs），避免修改用户原 D:\Desktop\ITN\ITN-Desktop 中的本地笔记和工作区。

对两处各18个已跟踪文件先保存SHA256清单，再用git rm --cached停止跟踪；本地文件没有删除。各Desktop .gitignore增加/docs/，AGENTS明确文档只在本地保存。根README和两分支Desktop README清理指向这些私有文档的链接，PRODUCT不再要求GitHub读者跳转本地设计文档。没有把docs内容复制到别的公开文件。

scripts/package-app.ps1原来强制复制两份docs说明，公开检出缺docs时会失败；两分支均改为Copy-OptionalDocumentation，存在本地文件才附带。未改内核、Lumin工具或业务接口。

验证：两个打包脚本PowerShell AST通过；分别从各脚本AST提取真实说明复制函数，在临时空工程验证无docs时不报错且不生成说明，在仅有一份本地说明时只复制该份且跳过另一份。未为这项局部变化重跑不相关的内核或完整应用打包。再次核验36个本地文件SHA256无变化；两个Git索引中各自docs均为0个；README相对链接均指向仍被跟踪的文件；diff --check通过。

哈希清单 D:\Temp\itn-private-docs-preservation-20261019.json。两分支分别本地提交，再用普通原子推送更新main和desktop；禁止强推。文档在旧提交中仍存在，本轮只从最新版本停止跟踪，不重写历史，也未改变线上部署或数据库。

## 2026-10-20 管理员上传文档资源（文件型）

- 新表 `resource_files`（SQL 见 `services/api/sql/20261020_resource_files.sql`）：文件字节单独存 LONGBLOB，资源主记录仍写 `generated_learning_resources`（`resource_type='file'`、`resource_scope='ORGANIZATION'`、`review_status='PUBLISHED'`，每个知识点首个上传置 `is_template=1` 作为模板标记）。
- 新后端 `services/api/src/resource_upload_api.cj`：
  `POST /api/v1/admin/resources/upload`（JSON + base64，≤12MB，扩展名白名单 PDF/PPT/Word/Excel/图片/文本）；
  `GET /api/v1/resources/{id}/file`（登录校验 + 同机构可见，流式返回字节）。
- 管理端「资源中心」新增「文档资料」区块：上传即发布、查看、下架；上传记录不参与知识网络/定制映射（`useLearningMap` 已排除 `type='file'`）。
- 学习者「我的资源」新增「文档资料」，新增 `/learn/file/:resourceId` 预览页：PDF/图片/文本内嵌，Office 格式提供下载。
- 验证：经 nginx 6023 完整链路（上传 → 模板列表可见 → 文件 200 → 下架后消失 → 彻底删除 200），测试数据与临时会话已清理。

## 2026-10-21 文档入库补 Word/PPT + 文档生成知识目录（不做 PDF）

- 文档入库格式：`predeal/doc_convert.py`（DOCX 走 zip+XML，PPTX 走 python-pptx）输出 Markdown；
  `upload_service.py` 的 `SUPPORTED_EXTENSIONS` 增加 `.docx/.pptx`，入库前自动转换后再归档切片；
  `web/app.py` 的 `/api/v1/uploads` 白名单同步放宽。PDF 明确不支持（用户要求）。
- 新增 `predeal/catalog.py` + `POST /api/v1/catalog/outline`（JSON `{fileName,dataBase64}`）：
  按标题层级切「章 / 知识点」，无子标题时退化为按段落/要点切分，返回 `{title, chapters[]}`，不写库。
- 新增 `services/api/src/resource_catalog_api.cj`：
  `GET  /api/v1/admin/resources/catalog/domains` 一级目录候选；
  `POST /api/v1/admin/resources/{id}/catalog/suggest` 取 `resource_files` 字节 → base64 转发 predeal；
  `POST /api/v1/admin/resources/{id}/catalog/apply` 管理员确认后写入 `knowledge_category`
  （L2 章 `category` / L3 知识点 `knowledge_point`，同名复用、`node_code` 冲突加后缀、事务写入）。
- 管理端「资源中心 → 文档资料」每份文档新增「生成目录」：选一级目录 → 解析 → 勾选/改名 → 写入。
- 验证：predeal 直连 200；spire 端到端上传 → 建议 → 写入（2 章 5 点）→ 重复写入幂等（0 新增）→
  非管理员 403；测试目录节点与上传资源已清理；`cjpm build` 与 `npx vite build` 通过，二进制/前端已部署。

## 2026-10-21 管理员「新建资源」：上传文档 → 教材结构 → 资源中心

- predeal 新增 `POST /api/v1/catalog/ingest`（`web/app.py`）：同步完成规范化 + 切片入库，返回切片 `id/titlePath`；
  `pipeline2.PipelineOptions` 增加 `skip_enrichment`，入库时跳过 LLM 分类，由平台按标题路径绑定。
- 新增领域配置 `predeal/domains/custom_ingest.yaml`（文档落 `/opt/itn-python/venv/itn_source/custom_uploads`，
  关闭 RAGFlow/VLM/图片管线），并同步到 site-packages 与 `lib/python3.12/domains`。
- 新增 `services/api/src/knowledge_import_api.cj`：
  `POST /api/v1/admin/resources/knowledge/parse`（解析建议，不写库）；
  `POST /api/v1/admin/resources/knowledge/import`（三种模式）：
    `domain` 新建 `knowledge_domain` + L1 根 + L2 章 + L3 知识点；
    `chapters` 在已有 L1 下新增章/知识点；
    `point` 不建节点，切片全部挂到选中 L3。
  入库后按切片 `title_path` 从深到浅匹配节点，写 `knowledge_chunk_category`（`relation_type='heading'`, `source='ingest'`）。
- 修复：`knowledge_domain.id` 为 BIGINT UNSIGNED（自增从 9.4e18 起，超过 Int64），领域 id 统一按字符串传递；
  `rcInsertCategory` 等改为插入后按 `node_code` 回查 id，不再依赖 `LAST_INSERT_ID()`。
- 前端 `ResourceCenterAdmin.tsx` 增加「新建资源」入口（领域列表页 + 领域内页），
  弹窗支持三种模式、文件解析预览、勾选/改名后确认入库；入库成功刷新领域与目录树缓存。
- 验证：三种模式端到端通过（domain 建 1 章 6 点、7 切片全部绑定；chapters 追加成功；point 绑定 6 条）；
  非管理员 401/403；测试领域、目录、文档、切片与临时文件已清理；`cjpm build` / `npx vite build` 通过并部署。

## 2026-10-21 新建资源支持「只建结构」，内容补充下沉到章节

- `POST /api/v1/admin/resources/knowledge/import` 增加 `skipIngest: true`：只写 `knowledge_domain` / `knowledge_category`，
  不调用 predeal、不产生切片；文件字段可不传。
- `mode=point` 放宽为「任意目录节点」：L2 章或 L3 知识点都可以上传内容，整份文档切片全部挂到该节点。
- 前端「新建资源」弹窗只保留「新建大章节 / 新增章」两种模式，新增「只建结构，不上传文档」勾选，
  支持手动 添加章 / 添加知识点 / 删除，确认后只建结构。
- 内容补充入口下沉：知识目录树每一行（章 / 知识点）右侧新增上传按钮，选中知识点后列表工具栏也有
  「上传到「节点名」」；上传后按内容切片并挂到该节点，不再放在「新建资源」弹窗里。
- 验证：skipIngest 建出 2 章 3 知识点、0 切片；对 L2 章补充内容后 7 条切片全部绑定到该章；测试数据已清理；
  `cjpm build` / `npx vite build` 通过并部署。

## 2026-10-21 修复「新建资源」弹窗被裁切 + 视觉重做

- 根因：弹窗放在 `lf-anim-in-up`（动画 `both`，保留 transform）与 `lg:overflow-hidden` 的容器内，
  `position: fixed` 被祖先 transform 变成相对该容器定位并被裁切，出现「部分被遮盖」。
- 修复：`KnowledgeImportModal` / `NodeContentUploadModal` 改用 `createPortal(..., document.body)`，
  `z-[120]` 高于顶栏 `z-40`；去掉 `backdrop-blur`（也避免远程桌面重绘）。
- 视觉：实底 `bg-paper` 卡片、图标+标题头部、分段式模式切换、独立滚动内容区、固定底部操作栏；
  小屏整层可滚动，不再挤压表单。
- 验证：`npx vite build` 通过并部署（6023）。

## 2026-10-21 修复新建大章节后「服务器内部错误」

- 现象：新建大章节结构创建成功，但随后前端刷新领域列表报 500「服务器内部错误」。
- 根因：`knowledge_domain` 自增 id 已到 9.4e18，超过 Int64 上限 9.22e18；
  业务侧 `GET /api/v1/rag/domains`、`GET /api/v1/rag/tree/{code}` 按 Int64 解析 domain.id 时溢出。
- 修复：`knowledge_import_api.cj` 新建领域时显式分配小号 id（在 1..4 基础上续号，取
  `MAX(id) WHERE id < 9e18` + 1），不再依赖 9.4e18 的自增值。
- 数据修复：把已创建的「大模型应用开发」由 9400000000520710019 迁移为 id=5，
  同步更新 `knowledge_category.domain_id`，目录内容保留。
- 验证：`rag/domains`、`rag/tree/doc_63426c83` 恢复 200；再建测试领域得到 id=6、刷新正常；
  测试领域已清理。

## 2026-10-21 只建结构允许空容器

- `knowledge/import`：`skipIngest=true` 时不再要求 chapters 非空；
  「新建大章节」可以只建领域 + L1 根节点（0 章），「新增章」允许章下 0 知识点。
  从文档入库（skipIngest=false）仍要求至少一章。
- 前端：只建结构时不再报「请至少保留一个章」；空章下也能看到「添加知识点」按钮
  （之前该按钮只在已有点时渲染）；空结构时给出「点添加章开始搭建」提示。
- 验证：`chapters=[]` 导入返回 200，仅生成 1 个 L1 节点，`rag/domains` 正常；测试数据已清理。

## 2026-10-21 修复新增章后「补充内容」404

- 根因：`knowledge_category.id` 约 9.1e18，超过 JS 安全整数 2^53。`/rag/tree` 返回数字 id，
  前端回传时被四舍五入（9100000000886522047 → 9100000000886521856），后端按 id 查不到节点，
  返回 404「目标节点不存在或已停用」。表现为：新增章后点上传内容必失败。
- 修复：`mode=point` 支持 `domainCode + nodeCode`（字符串）反查节点；前端上传内容改用编码定位，
  不再回传数字 id（保留 parentId 兼容）。
- 附带：目录树给 L2（章）节点加「章」徽标；新增章下拉里新领域不再显示成「X / X」。
- 验证：新增章 200；按 nodeCode 上传 7 条切片全部绑定到该章；用四舍五入后的旧 id 复现 404，
  确认根因；测试章、切片、文档已清理。

## 2026-10-21 修复目录树两个章节点一起高亮

- 根因：`knowledge_category.id` 约 9.1e18，相邻 id 在转成 JS Number 后落到同一个双精度值
  （9100000000886522041 与 9100000000886522046 → 都是 9100000000886521856）。
  树的选中判断与展开集合都用数字 id，导致两个不同节点被当成同一个，点击一起高亮、展开联动。
- 修复：`ResourceCenterAdmin` 树的选中态、`expanded` 集合、React key、上传弹窗重置依赖
  全部改用 `nodeCode`（字符串唯一）；不再用数字 id 做身份比较。
- 验证：`npx vite build` 通过并部署（6023）。

## 2026-10-21 移除机构邀请码与邀请码注册

- 登录页注册面去掉「机构邀请码」输入与校验，注册只填邮箱 / 密码 / 邮箱验证码。
- 机构配置页去掉「成员邀请码」卡片（生成、复制）。
- `api.ts` 移除 `createOrganizationInvite` 与 `registerEnterprise.invitationCode`。
- 后端 `VerificationController.registerEnterprise` 不再读取邀请码；
  `EnterpriseRegistrationService.register` 去掉邀请码参数与 `OrganizationInviteService.consume`，
  新用户默认加入「最早创建的启用机构」（当前为江南大学）。
- 移除邀请码路由：`services/business` 与 Spire `organization_api.cj` 的
  `POST /api/v1/admin/organization/invites`（现返回 404）。
- 顺带把验证码有效性判断改为 `IF(expires_at > UTC_TIMESTAMP(6), '1', '0')`，避免布尔表达式解析差异。
- 验证：无邀请码注册返回 201 并自动登录（测试用户/会话/验证码已清理）；邀请码接口 404；
  `cjpm build`（api、business）与 `vite build` 通过并部署。

## 2026-10-21 首页「正在学习」按大知识聚合

- 新增只读接口 `GET /api/v1/rag/category-index`（business `LearningKnowledgeReadService.categoryIndex`）：
  返回 `[{domainCode, domainName, nodeCode, name, level}]`，用于把知识点编码映射到所属大知识。
- `LearnerHome` 的「正在学习 → 课程」改为一块大知识一个框：
  用 `rag/domains` + `category-index` + 用户学习资源聚合，只有真正开始过的领域才出现；
  卡片展示领域名、简介、进度条、`已学 X / Y 个知识点`，点击进入 `/knowledge?domain=<code>`。
  智能体额外参考 `chapterProgress`，保证只有测评/播放进度时也能出现。
- `Knowledge.tsx` 支持 `?domain=` 参数，从首页大知识框直接定位到对应领域。
- 验证：`category-index` 返回 145 条编码映射；`vite build` 通过并部署。

## 2026-10-21 一个账号只保留一份学情画像

- 根因：`POST /api/v1/learners` 每次建档都新建一行（`code` 每次不同，`uk_learners_user_code` 挡不住）；
  「重新精准诊断」与重复提交会累积多份画像，列表接口又返回全部。
- 后端：
  - Spire `handleCreateLearner`：先取该用户最早的 learner，存在则更新，不再插入。
  - business `LearnerProfileService.save`：创建分支同样先查最早 learner，存在则复用。
  - `GuestDemoRepository.guestLearner`：按 `user_id` 查找已有画像，不再要求 `code='default'`。
  - 数据库加唯一键 `uk_learners_user (user_id)`，从存储层保证一人一份。
- 数据修复：5 个账号共 12 条重复画像，保留最早一条并把「资料最完整/最近更新」的画像字段叠加过去，
  业务数据（会话、成长、资源、知识点状态、错题、PLU、记忆等）迁移到保留行后删除重复行；
  最终 `learners` 18 行 / 18 个账号。
- 前端：
  - `Profiles` 去掉多画像卡片网格、`?learner=` 选中态与“画像能力对比”，只展示当前唯一画像。
  - `ProfileContext` 对接口/缓存结果做单画像兜底；删除未使用的多画像对比组件 `CompareRadar`。
  - 「重新诊断」文案改为更新当前画像。
- 验证：GET `/api/v1/learners` 返回 1 条；重复 POST 返回同一 id 且数据库仍 1 行；
  `cjpm build`（api、business）与 `vite build` 通过并部署。
