# 本地恢复与开发交接记录

## 2026-10-20（Asia/Shanghai）下载并预览28801线上旧前端

### 用户目标与范围
- 用户要求定位 http://113.249.110.108:28801/ 在服务器43.160.236.121上的位置，随后要求把源码拉到本地并部署，确认页面后准备开发。
- 此页面与此前7月31日紫色React历史版本、newfront_khea6压缩包不能视为同一套。用户已明确改为以28801线上页面为当前目标。
- 服务器只读访问；不修改线上文件、服务、数据库或防火墙。SSH凭据不写入项目。

### 下载证据
- Nginx配置：/etc/nginx/sites-available/zhixun-yunshu-28801，sites-enabled内是它的软链接；宿主机Nginx监听28801，无需前端容器。
- 网站root：/var/www/zhixun-yunshu/current，软链接目标为 /var/www/zhixun-yunshu/releases/20260803-112502。
- SFTP下载了该发布目录的全部8个文件，共2,552,751字节，保存至本目录deployed；另下载Nginx配置，生成SHA256SUMS.txt。
- 入口HTML外网/远程磁盘/本地哈希：2aad0e7b28010754279746d5be5cd76337e62b5a1b2a13d545b242927b08888a。
- 主JS assets/index-Dla-aRwf.js 外网/远程磁盘/本地哈希：84a5a915c003d50509415a59179ede4e8c7f8a2211beb84549a2002f3016feaf。

### 源码查找与限制
- 发布目录只有index.html、JS、CSS和5张courses图片，无src、package.json或source map。
- 检查服务器/home/ubuntu、/root、/opt、/srv、/tmp、/var/www、/www/wwwroot、/data中的项目与压缩包候选，排除了依赖/缓存/编辑器目录；尚未找到对应原始React工程。
- /tmp/itn-front只剩node_modules。ds-platform及其cloud_src是DataSphere Vue工程，与目标不符。
- 检查本机front_6BhE2.tar.gz与front_JtdhW.tar.gz，均为其他版本，构建入口脚本与线上index-Dla-aRwf.js不同，不能冒充目标源码。
- 已告知用户：当前可原样预览的是构建产物；继续开发需要找回源码，或明确开展源码重建。

### 本地启动
- 新增preview_server.py，使用Python标准库HTTP服务，只监听127.0.0.1:3005；/courses及单页路由回退到index.html，已存在的静态文件直接提供。
- 启动命令：python preview_server.py --port 3005。
- 本地初始化独立Git仓库并保存恢复基线，以便后续回滚；不向远端推送，不改现有ITN工作区。
- 运行与浏览器验证结果继续追加本文件。

### 已完成验证
- 运行进程exec session_id=65755，绑定127.0.0.1:3005；服务启动输出Preview: http://localhost:3005/。
- 对SHA256SUMS.txt逐项校验，8个下载文件全部一致。
- GET /、/courses、/courses/、主JS与课程图片均HTTP 200，HTML/JS/PNG响应类型正确。
- 浏览器真实加载首页，标题“智训云枢”，显示“计算机核心课程，从难懂到真正掌握”。点击“开始学习”可显示身份选择弹窗。
- 用户随后在浏览器继续操作，页面已进入“个人档案”，显示角色、学习统计、继续学习、推荐课程与最近记录。本次保留用户当前页面，不再强制跳转。
- 本次只验证静态加载和入口交互，没有确认演示数据与真实业务后端的关联；未修改下载的HTML/JS/CSS。
- 为deployed/**与下载的Nginx配置设置Git -text属性，避免Windows换行转换破坏下载文件的原始字节及校验哈希。

## 2026-10-20 新前端迁移范围分析与半天首版方案

- 用户要求分析AGI-FBHC/ITN-cj及服务器itn_cangjie_dev，最初讨论后端重构，后明确由其重写后端，本轮只整理迁移范围，方案应简洁、符合用户视角并保证运行流畅，目标工期半天以内。
- 已确认用户边界：当前28801前端作为用户端，保留视觉和流程，只微调与加法；管理员端另建同风格页面；自建后端服务全部仓颉1.1.3 + Spire。旧系统按功能做减法，不整套复制。
- 将ITN-cj main以浅克隆保存至D:\Downloads\ITN-cj-analysis-20261020，核验提交cc2e6208ec9fc670639813970abfe5d68d1a0408。读取AGENTS、架构与部署文档及认证、网关、MySQL、学习模块源码。
- 仓库Web两个服务均标记SDK1.1.3、Spire依赖1.0.20260528；Desktop/Lumin为1.2.0，且PPT导出含Python渲染调用。Web网关也仍转发部分生成/聊天请求至Python，不能宣称现有系统全仓颉。
- 服务器只读核验：itn-cj-api和itn-cj-business均连接172.28.0.1:3306/itn_cangjie_dev；API的AGENTS_UPSTREAM指向agents:8000，JAVA_UPSTREAM实际指向business:5000，变量名不代表实际仍运行Java业务服务。编译器版本确认为1.1.3；20889健康检查200，未登录auth/me为401。
- 通过SSH通道对MySQL开启SESSION TRANSACTION READ ONLY与一致性快照；只查询结构、计数、时间范围和非个人目录信息，不运行写入测试，不导出用户明细。
- 数据库MySQL8.0.45，97张表、1135列、75条外键。精确计数：users30、learners24、user_profiles4、generated_learning_resources545、generated_courses8、knowledge_category145、knowledge_chunk1755、knowledge_document38、learning_notes41、learning_wrong_answers37、quiz_results26、learning_events300、study_sessions24。
- 145个knowledge_category节点全部归属Agent domain；cs-base domain虽存在但没有目录节点。生成课程8门分属3个用户/5个学习者；545资源中仅39条关联course/chapter。部分账号对应多个学习者，不能用默认第一条绑定新前端。
- 对当前部署JS做只读AST分析，发现数据结构、计算机组成原理、操作系统、计算机网络、Agent共5门课程。应用无业务fetch调用（仅打包器modulepreload的fetch）；有本地收藏/片段书签和模拟内容，不能视为已连接业务后端。code-path保留了原始组件名，但不是完整源码或source map。
- 输出INTEGRATION_PLAN.md：以当前页面映射迁移能力与表，建议半天首版只验收建档—一门真实课程—阅读—测验—进度恢复，管理员端完整功能与实时生成后置；前提为拿到可编辑React源码和确认可用内容。未承诺缺源码时仍可半天完成全部重写。
- 本轮不修改业务代码、不迁库、不部署服务、不改变当前预览页面；将方案、去敏元数据与本记录提交本地Git，不推送。
- 用户进一步强调尽可能避免旧版过度审核，以快速部署、流畅运行和用户视角为主。已同步缩减方案：管理员保存/一键发布，不继承审核状态机、多级审批、Agent互评、反复审校与置信度准入；生成只保留基础格式校验和失败重试。个人资源与公共课程仍做必要归属映射，不自动公开个人数据。

### Lumin复用分析
- 用户要求查看Lumin是否有可迁移能力；读取ITN-cj根与Desktop/Lumin AGENTS、README、PRODUCT及模型、资源生成、检索、学习状态和运行时源码。GitHub main仍为cc2e6208，与分析检出基线一致。
- 区分Lumin本体的Agent循环/工具事件/会话，与Desktop宿主中的模型适配、学习资源、知识库和学习状态；没有把宿主能力全归入Lumin独立内核。
- 可优先抽取core/src/llm/、pi_provider/的OpenAI兼容调用、SSE及取消超时；resource/中的lecture/practice/quiz/ppt结构化内容与渲染；kb/kb.cj中的切块、关键词、向量、RRF和引用数据。需要适配新前端的数据结构与MySQL存储。
- core/src/learning/learning.cj包含answer、progress、context、remember等逻辑，可作业务规则参考；现有Web已有1.1.3认证/进度/笔记接口，优先复用它们，避免另迁一套SQLite状态存储。
- resource/generate.cj默认maxRepair=2，并含质检/定向返修；spec.cj包含最低字数/章节数规则。按用户要求不照搬这些生成门槛，只保留基础结构及答案/引用有效性校验。
- Desktop PPTX链有Python渲染和桌面任务队列，不能满足当前纯仓颉服务目标；不迁移此链，复用网页结构化幻灯片。
- Lumin/Desktop是SDK1.2.0、Windows与本机存储语境。当前只做静态源码分析，没有编译验证Linux/1.1.3兼容，没有调用真实模型。不要声称即插即用或整套移植可在半天内完成。
- 已把简版结论加入INTEGRATION_PLAN.md第5节；本轮仅改方案与追踪文档，未改功能代码、服务器和数据库。

## 2026-10-20 实施用户端学习闭环（暂停续作）

### 用户决策与范围
- 用户要求实现，期间指示“不用docker”，随后允许仓颉1.2.0；明确要求用户端保留28801当前界面，管理员端后续另建，避免旧版过度审核。
- 先按用户建议启动前后端子agent；因为任务消息未到达，两者均只回问任务且没有产出。暂停后继续时子agent已空闲，因此由root直接完成实现，没有覆盖其他工作区或用户改动。

### 隔离数据
- 新建独立MySQL库`itn_learning_v2_dev`和仅本库DML权限的应用账号；账号密码只写项目根`.env.local`，已gitignore。旧`itn_cangjie_dev`全程只读，未复制用户明细。
- 执行`services/learning/schema.sql`，建立users、user_sessions、courses、lessons、lesson_progress、quiz_attempts、user_state共7表。
- 通过只读事务从旧库筛选33份`PUBLISHED lecture`和28份`PUBLISHED quiz`公开内容，输出到被忽略的`data/agent-source-resources.json`；没有自动公开个人资源。
- `tools/export-catalog.cjs`静态解析构建产物中的字面量课程信息，不执行原JS；`tools/seed-learning.py`将其和公开资源导入隔离库。最终5课24课时：Agent使用旧库来源，计算机四课为明确标注的示例内容。

### 后端
- `services/learning`为Cangjie1.2.0+Spire，不使用Docker/Python/Java运行时。
- 复用并精简原生MySQL协议客户端、UUID、JSON和SQL转义工具；删除旧Web无关接口和依赖。
- 实现`/api/health`、`POST /session`、`GET /bootstrap`、`PUT /profile`、`GET /courses`、课时读取/阅读进度/单题判分/整卷提交、`PUT /state`。
- 登录令牌只保存SHA-256哈希；题目响应不下发正确答案，分数和完成状态由服务端决定；同一attemptId不可重放累计。
- 初版每请求重连远程MySQL，测试暴露出约12秒单次延迟；改为Mutex保护的单连接复用后，bootstrap约0.7秒，全流程测试13.5秒完成。单连接是当前个人开发规模的取舍，正式多人部署应改为小连接池。
- 修复`where`关键字冲突、Spire JSON数组不可迭代、Cangjie类型/转换、共享连接写锁及被占用二进制文件等真实构建问题。

### 前端
- 原始TSX仍不存在。`tools/recover-frontend.cjs`从线上JS的literal/函数结构生成`apps/web/src/RecoveredApp.jsx`，只保留React绑定的应用与UI辅助代码，不加载原 bundle 执行。线上`deployed/`原件逐字节保留。
- 增加`learning-api.jsx`：自动创建独立访客会话、20秒超时、顺序保存收藏/书签、失败提示和重试。
- 应用启动加载bootstrap；建档保存到后端；刷新恢复档案；课程目录与已有完成状态来自后端；讲义页读取真实课时；测验接入服务端答案检查和整卷提交；收藏/书签写回后端。
- 首页指标改为真实学习天数、完成课时、课程数、测验累计分；最近学习记录来自数据库；不再用“李明/128天”等假数据作真实状态。
- 加载失败使用原风格轻量提示，没有重做页面。AI入口明确显示尚未接入，不再返回预先编造的导师答案。
- `npm run build`成功：42 modules，主JS约475KB，gzip约141KB。

### 实际验证
- `node --test tests/learning-flow.test.mjs`：7项全部通过，覆盖档案保存/隔离、客户端伪造分数被忽略、重复提交幂等、跨账号不可见、收藏书签刷新恢复。
- 真实浏览器完成：研究生/考研升学/数据结构+Agent/Python/3个月/1小时建档；首页看到5门真实目录与0/5进度；阅读仓颉后端讲义；3题全部正确；完成后服务端`score=100, completed=1`；刷新后显示1天、1课时、100分、1/5进度、最近学习记录。
- 收藏数据结构后刷新，课程页仍显示“取消收藏”，证明后端恢复成功；浏览器控制台无error/warn。
- 启动脚本`scripts/run-backend.ps1`和`scripts/run-frontend.ps1`提供无Docker运行方式。

### 未完成/限制
- 管理员端、正式账号体系、AI导师、笔记/错题迁入、四门计算机基础课正式讲义、生成任务、生产库迁移和Linux部署尚未接入。
- 当前DB仍是远程隔离开发库；运行时故障重连只有单连接重试，不是高并发连接池。
- 尚未把新系统部署到43.160.236.121，也未替换28801线上页面。

## 2026-10-20 登录页与首次登录分流

- 用户明确首页“立即体验”必须先进入登录页；登录后档案为空才展示首次建档选项，已有档案直接进入学习主页。
- 用户进一步指定登录页复用`git@github.com:AGI-FBHC/ITN-cj.git`中的版本。已读取该仓库`apps/web/src/pages/Login.tsx`，复用其左侧学习说明、三步提示、右侧账号卡片、注册翻转入口和游客入口的设计语言；不迁移旧后端登录请求。
- 新增`apps/web/src/LoginPage.jsx`和`login.css`，页面使用原ITN-cj的暖白、深绿与衬线标题体系，并补齐移动端布局、表单错误和忙碌状态。
- Home入口改为`hero -> login -> onboarding/dashboard`。登录返回profile时直接进入Dashboard；profile为null时进入当前OnboardingWizard。取消建档返回登录页。
- 后端users表增加login_key、password_salt、password_hash、display_name；新增`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/guest`，密码保存SHA-256加盐哈希，账号登录返回稳定userId与profile。
- 浏览器实测：点击“立即体验”出现登录页；注册新账号后出现“你目前是？”四种身份选项；用同一账号再次登录后直接进入学习主页并恢复昵称、角色和课程。
- 修复手动测试档案字段与Dashboard标签不一致造成的默认角色显示；正式从建档向导保存的档案保留roleLabel/goalLabel。
- `npm run build`通过，44 modules，gzip主JS约142KB。新增`tests/account-auth.test.mjs`覆盖注册、首次档案为空、老用户登录恢复、错误密码和重复注册。

### 邮箱验证码登录迁移
- 用户要求把ITN-cj之前的邮箱验证码登录一起拿过来。读取旧`VerificationCodeService`、`VerificationMailService`、`EmailVerificationCodeRepository`和登录控制器，复用其SMTP与安全语义。
- 隔离库新增`email_verification_codes`，只保存邮箱、用途、验证码哈希、创建/过期/消费时间；真实6位验证码不落库、不进日志、不写文档。
- 新后端新增`POST /api/auth/send-code`和`POST /api/auth/email-login`，验证码5分钟有效、60秒重发限制、一次性消费；邮箱首次登录创建稳定账号且profile为null，后续登录恢复同一userId/profile。
- SMTP发信参数从现有业务容器迁移到已忽略`.env.local`；没有打印或提交任何密码。实际发送到配置邮箱返回HTTP200，立即重发返回HTTP429。
- 通过隔离测试记录验证：首次邮箱登录profile=null；保存档案后再次验证码登录恢复同一userId与profile；已消费验证码再次使用返回400。
- 前端登录卡恢复“账号登录 / 邮箱验证码”双入口；邮箱页含收件地址、6位验证码、60秒倒计时、明确错误提示，验证后沿用首次建档/老用户直达逻辑。

### Open Design插件调用诊断
- 尝试通过Open Design生成紫色登录页适配稿，任务`08c4a7e1-7826-426a-ad40-d9163e6ba0bb`已获受理。
- 随后MCP访问旧守护进程地址`127.0.0.1:55326`失败；检查运行态发现Open Design重启后新daemon PID 165200正在`127.0.0.1:64064`监听。问题属于MCP端口未随桌面应用重启刷新，不是模型API Key无效。
- Open Design日志另显示Cloud账户计费摘要403且无active team；若改用Cloud代理生成，需要登录并加入可用团队。若使用Local Codex，则不需要额外模型API Key。
- 本轮没有修改插件安装文件，也没有配置或暴露任何API Key；需要重启Codex/Open Design宿主以让插件MCP重新绑定新端口。

## 2026-10-20 紫色登录页最终适配

- 用户后续明确“不用插件”，因此停止依赖Open Design产物，直接按旧紫色`4acfb19`登录页手工适配。
- `LoginPage.jsx`恢复旧版紫焰Logo、“智启未来 训见成长”、左侧轨道展台与代码/讲义/图表/终端浮动卡片；右侧保留账号登录、邮箱验证码、注册和游客入口。
- `login.css`整体改为紫白主题，保留响应式双栏/移动端卡片；表单、focus、倒计时、错误提示和按钮忙碌状态沿用新流程。
- 浏览器实测：首页“立即体验”进入紫色登录页；注册新账号后出现“你目前是？”身份选项；邮箱验证码页签可正常切换并显示邮箱、验证码与倒计时控件；页面无控制台错误。
- `npm run build`成功，44 modules，gzip主JS约143KB。紫色视觉修改仅涉及前端，不改后端协议。

## 2026-10-20 管理端首版：课程/课时/测验内容维护与用户数据查看

### 用户需求与方案确认
- 用户要求基于现有紫色前端另建管理端，先讨论方案再实现，并要求“尽可能快”。
- 三项方案选择由用户确认：首版范围＝内容编辑 + 上下架 + 用户与数据查看；形态＝同一 React 工程 `/admin` 路由 + 独立管理员登录页；编辑形态＝结构化表单 + JSON 高级模式。
- 沿用此前确定的原则：管理员保存即生效，不设多级审核、Agent 互评或置信度门槛。

### 关键设计决定
- 不修改 450KB 的 `apps/web/src/RecoveredApp.jsx`（反编译产物）。改为在 `main.jsx` 按路径分流：`/admin*` 渲染新的 `AdminApp`，其余仍渲染原用户端，用户端零回归风险。
- 管理端不新建第二个服务、不引入 Docker；所有接口挂在同一个仓颉服务上，路径前缀 `api/admin/`，每个接口先校验 `users.role='admin'`。
- 登录令牌与学习端令牌分开存放（`zhixun-admin-token`），管理端登录页独立于用户端登录页。
- 课时删除只允许删最后一节，避免打乱已发布课时编号与既有学习记录；课程删除只允许“从未被学习过”的课程，其余一律引导下架。
- 讲义与测验以“JSON 文本”形式双向传递（`contentJson`/`quizJson`/`sourcesJson`），后端只做结构校验后原样入库。原因是本仓库 `json_util.cj` 已明确记录 `JsonValue.toJsonString()` 在 Spire 链接下会错编字符串，不能用于响应组装。

### 数据层
- 新增迁移 `services/learning/migrations/001_admin_console.sql`：`users.role`、`courses.status/sort_order/updated_at`、`lessons.updated_at`，全部带默认值；并把 5 门既有课程按原展示顺序写入 `sort_order`。
- 开发库账号只有 DML 权限，ALTER 由服务器 root 账号执行一次；只作用于 `itn_learning_v2_dev`，未触碰旧库 `itn_cangjie_dev`。`schema.sql` 同步更新，保证新库一次建全。
- 新增 `scripts/create-admin.ps1`：生成 `admin` 账号（加盐 SHA-256），密码只在终端输出一次；脚本通过 UTF-8 临时 SQL 文件执行，避免 Windows 控制台代码页损坏中文显示名。
- 本轮管理员账号：`admin`。密码不写入仓库与文档；终端里执行 `scripts/create-admin.ps1` 可随时重置，重置后旧密码立即失效。

### 后端接口
- 认证：`POST api/admin/login`（先校验密码再校验角色，避免泄露哪些账号是管理员）、`api/admin/overview`、`api/admin/courses`(GET/POST)、`api/admin/courses/{id}`(GET/PUT/DELETE)、`api/admin/courses/{id}/status`、`api/admin/courses/{id}/lessons`(POST 追加)、`api/admin/courses/{id}/lessons/{index}`(GET/PUT/DELETE)、`api/admin/users`。
- 校验：课程编号限 2–40 位小写字母/数字/横线/下划线；标题 1–200；讲义必须是 JSON 对象（≤512KB）；测验必须是数组且每题有题干、≥2 个文字选项、正确答案在范围内；来源必须是数组。
- 一致性：新增/改名/删除最后一节都同步重写 `courses.chapters_json` 并刷新 `updated_at`；课时内容更新与目录更新放在同一事务里。
- 用户端过滤：课程列表只返回 `status='published'`，并按 `sort_order` 排序；课时读取接口改为 JOIN courses 并要求已发布，下架课程连带其课时对学习者不可见。

### 前端管理端
- 新增目录 `apps/web/src/admin/`：`admin-api.js`（令牌与错误处理）、`admin-ui.jsx`（状态标签/统计卡/加载与错误块）、`admin.css`（紫色白色主题，沿用登录页色板）、`AdminApp.jsx`（侧栏 + 路由 + 登录守卫）、`AdminLogin.jsx`、`AdminOverview.jsx`、`AdminCourses.jsx`、`AdminCourseDetail.jsx`、`AdminLessonEditor.jsx`、`AdminUsers.jsx`。
- 课时编辑器：结构化编辑分节（小标题/标题/正文）、幻灯片（标题/副标题/要点/讲稿）、测验题（题干/选项/正确项/解析/知识点），并保留 JSON 高级模式同时编辑讲义、测验、来源；脏状态按规范化模型比较，切换模式不会伪造未保存标记；“放弃修改”直接回到上次保存内容。
- 用户页默认隐藏“既未建档也无学习记录”的游客账号，避免 26 个空账号淹没有效数据，可一键取消过滤。
- 新增 `scripts/build-backend.ps1`、`scripts/start-backend.ps1`、`scripts/start-frontend.ps1`（均支持 `-Stop`），构建/启动不必再开前台终端；构建前必须先停服，否则 `main.exe` 被占用会链接失败。
- 修正 `apps/web/index.html` 的标题为“智训云枢”并加空 favicon，消除控制台 404。

### 实际验证
- `node --test tests/*.test.mjs`：17 项全部通过（新增 `tests/admin-console.test.mjs` 覆盖登录/越权/草稿隔离/发布/课时保存/答案不泄露/判分/非法载荷/只删末节/下架/用户列表/删除清理）。
- 删除保护另做一次性自检：带学习记录的课程 DELETE 返回 409 并给出“请改用下架”，随后清理了自检数据。
- 浏览器（Chromium，1440 与 420 两种宽度）实测：`/admin` 未登录跳登录页；登录后概览 6 张统计卡；课程列表 5 门；进入“数据结构”后 5 个课时；课时编辑器加载 9 个内容块；改标题→保存→刷新后标题持久→改回并再次保存；“放弃修改”可回到已保存状态；用户页 10 条有效记录；控制台无 error。
- 截图保存在 `analysis/admin-ui/`（登录、概览、课程、课程详情、课时编辑、JSON 模式、用户、移动端）。
- `npm run build` 通过（54 modules，gzip JS 约 152KB）。

### 测试运行方式
- 三个测试文件共用同一个隔离开发库，必须串行：`node --test --test-concurrency=1 tests/*.test.mjs`。
- 默认并行执行时管理端用例增删课时，会让学习端用例的 `stats.totalLessons` 前后比较偶发不等，属于测试互相干扰，不是接口回归。

### 未完成与限制
- 管理端暂不支持课时重排序、批量导入旧库 545 条资源、图片/附件上传、AI 生成与教研工作台。
- 用户列表只返回最新 200 个账号并在前端筛选，尚未做服务端搜索与分页。
- 管理端与学习端共用同一个仓颉服务实例和单连接数据库访问；正式多人部署应改为连接池。
- 未部署到 43.160.236.121，也未替换 28801 线上页面。

## 2026-10-20 知识库、向量检索与 AI 导师

### 需求与决策
- 用户放弃旧库 545 条资源，改为管理员上传知识库、配置向量模型做切片/索引/检索，并要求把检索接进用户端 AI 导师。
- 向量接入方式参照 Lumin：OpenAI 兼容 `POST {base}/embeddings`，模型名单独可配。Lumin 把向量存 f64 BLOB，这里改成 int8 量化后十六进制落库——1024 维只占 1KB，余弦足够准。
- 检索同样照搬 Lumin 的混合检索：向量一路 + 字符二元组关键词一路 → RRF 名次融合（`1/(60+rank)`）→ 按文档去冗。理由是向量对「1.2 节」「kb_search」这类编号和代码符号很钝，关键词反过来换个说法就全丢。
- 未配置向量模型或接口不提供 `/embeddings` 时自动降级为纯关键词检索，入库和检索都不阻断。

### 数据层
- `services/learning/migrations/002_knowledge_base.sql`：`kb_documents`（正文、状态、切片数、向量数、模型名、错误信息）、`kb_chunks`（标题路径 + 正文 + 字数）、`kb_embeddings`（chunk_id/model/dim/vec_hex）、`kb_settings`（接口地址、两个模型名、批量/切片/重叠/召回）、`tutor_messages`（问答与引用）。
- 切片与向量主键都用 `CHAR(36)`，切片与向量可以在同一批里写入，不依赖自增回填。

### 后端
- `kb_chunk.cj`：Markdown 标题栈生成「文档标题 > 章节 > 小节」路径（首级标题与文档同名时不重复拼），句末优先切分，默认 800 字、重叠 120 字（重叠强制小于半长）。
- `kb_vector.cj`：归一化、int8 量化、余弦、字符二元组关键词打分、RRF 融合、按文档去冗。
- `llm_http.cj`：参考 Lumin 的 `ClientBuilder` + 显式 SNI + 锁 HTTP/1.1，实现 `/embeddings` 与流式 `/chat/completions` 的 SSE 解析。密钥只读环境变量 `ZHIXUN_MODEL_API_KEY`（兼容 `OPENAI_API_KEY`）。
- `kb_service.cj`：配置读写、进程内索引缓存（写操作递增版本号使其失效）、批量入库与增量补向量、混合检索。
- 管理端接口：kb 文档增删查、`reindex`、检索测试、settings 读写、模型连接测试。
- 用户端接口：`POST api/tutor/chat`（检索 → 拼参考资料 → 调对话模型 → 返回答案与引用）、`GET api/tutor/history`。
- 校验：文档 ≤500KB、切片 200–4000 字、重叠 < 半长、批量 1–64、召回 1–20；模型未配置时导师返回 503 并说明缺哪几项。

### 前端
- 管理端新增「知识库」页（上传/粘贴 .md/.txt、切片预览、重建索引、检索测试带分数与命中片段）与「设置」页（接口地址、向量/对话模型、切片参数、连接测试、密钥状态）。
- 用户端阅读页提问面板接上真实导师。因为 `RecoveredApp.jsx` 是反编译单文件，改动只落在 `H` 函数一处，业务逻辑放在新文件 `src/tutor.js`，用 `window.zxTutorAsk` 注入；没注入时仍回退到原来的「服务未接入」文案。
- `LoginPage.jsx`（非反编译产物）在卡片下方加「课程内容维护？进入管理端」直达 `/admin/login`，解决用户反馈「找不到管理员入口」。

### 实际验证
- 接口测试 26 项通过、1 项跳过（`tests/model-chain.test.mjs` 需要本地 mock 模型服务）。
- 用 `tools/mock-model-server.py` 起本地 OpenAI 兼容服务实测：连接测试返回 64 维；入库 3 片全部向量化；检索模式显示「向量+关键词 融合」且首条命中「循环队列」；导师返回答案与 4 条引用；会话记录 2 条。验证后配置已清回未配置状态并停掉 mock。
- 浏览器实测：登录页入口 → `/admin/login` → `admin/admin` 登录 → 概览；知识库上传、检索、切片预览；设置页连接测试的成功/失败两种提示；阅读页提问拿到回答，控制台无报错。
- 管理员密码按要求重置为 `admin`（仅本地隔离开发库；正式环境必须改）。

### 未完成与限制
- 没有向量库：检索是全量加载 + 进程内余弦，文档规模到万级要换存储。
- 上传只支持 Markdown / 纯文本，PDF、Word 未接。
- 导师回答是一次性返回（界面先显示「正在查阅课程资料…」）；框架侧流式响应未验证。
- 检索不分课程/课时，全部走同一个知识库。
- 本机 3306（MySQL 9.3，root/MYSQL）迁移已导出 dump，用户叫停，目前仍是远程开发库；远程应用账号只有 DML 权限。

## 2026-10-20 上架流程收敛为「上传知识库 → 建索引 → 发布课程」

### 需求与决策
- 用户要求清空已有课程，并把上架方式改成「每上传一个知识库，就在它上面建索引、发布课程」，且逻辑要清晰不绕。
- 决定：知识库成为课程的唯一来源。课程不再手工新建课时；文档的顶层章节（H1）就是一节课，切片聚成该课的讲义分节。
- 侧栏去掉「课程」，`/admin/courses*` 重定向到知识库；删除 `AdminCourses/AdminCourseDetail/AdminLessonEditor` 三个页面，避免同一件事有两个入口。
- 后端保留课程读写接口：发布时用它写课程与课时，课程信息（名称/难度/时长/简介）在知识库行内「课程设置」里改。

### 数据层
- `migrations/003_kb_course_link.sql`：`kb_documents.course_id` + 索引，文档与它生成的课程一一对应。
- 清空既有课程数据：`quiz_attempts` → `lesson_progress` → `lessons` → `courses`（按外键顺序）。

### 后端
- `kbPublishCourse`：读文档切片，按标题路径第二段（顶层章节）分组，每组一节；课程 id 取 `kb-` + 文档 id 前 8 位；`chapters_json` 与 `lessons` 一次事务写完；重新发布先清掉旧课时及其学习记录（内容变了，旧进度没有意义）。
- `kbSetCourseStatus`：发布/下架切换。`kbDropDocumentCourse`：删文档时顺带处理课程——没有学习记录就删除课程，有就只下架。
- 新接口：`POST api/admin/kb/documents/{id}/publish`、`POST .../unpublish`；删除文档接口返回 `courseNote` 说明课程的处置结果。
- 文档列表响应带上 `courseId`、`courseStatus`，前端据此渲染「已上架/已下架/未发布」。

### 前端
- 知识库页每行操作：看切片 · 重建索引 · 发布为课程/重新发布 · 下架 · 课程设置 · 删除。
- 顶部提示写明这就是完整上架流程，以及「重新发布会重置学习记录」。

### 实际验证
- 接口测试 21 项通过、2 项跳过（学习流用例需要已发布课程，模型链路用例需要 mock 模型服务）。
- 浏览器实测：admin/admin 登录 → 知识库 → 上传 4 切片文档 → 发布为课程（2 节课）→ 学习者课程列表出现该课 → 下架后学习者看不到 → 删除文档后列表清空，控制台无报错。
- 手工验证过一次课程分组：`# 第一章 / ## 1.1 / ## 1.2 / # 第二章` 生成 2 节课，符合预期。

### 未完成与限制
- 目前不生成测验题：课程只有讲义。测验题仍需另做（未来可由模型生成或单独上传题库）。
- 重新发布不保留任何学习记录，界面上有提示但没有二次确认以外的保护。
- 课程只保留一份（一文档一课程），不支持一个文档拆成多门课。

## 2026-10-20 模型密钥搬到管理端，加密入库

### 需求与决策
- 用户要求 API Key 改在管理员端配置，加密存储到数据库，只有保存前能看到明文；对话模型、TTS 模型也统一在这里配置。
- 决定：密钥不再依赖 `.env.local`。提交时用服务器密钥（`ZHIXUN_AUTH_SECRET`）加密后落库，接口只返回尾号提示；环境变量里若有旧密钥仍作为兜底。
- 标准库暂无可用的 AES 接口（`std.crypto.cipher` 只暴露 `BlockCipher` 接口，没有 AEAD 实现），因此用 SHA-256 派生密钥流做异或加密，并附 SHA-256 校验和防篡改。这能保证密钥不以明文落库、被改写能被发现，但它不是 KMS 的替代品——这点在代码注释里写清了。

### 数据层
- `migrations/004_model_credentials.sql`：`kb_settings` 增加 `api_key_cipher`（密文）、`api_key_hint`（尾号提示）、`tts_model`、`tts_voice`。

### 后端
- `kb_service.cj` 新增 `encryptSecret` / `decryptSecret`：16 字节随机数 + SHA-256 密钥流异或 + 尾部 32 字节校验和，整体十六进制存储。
- `effectiveApiKey`：优先解密库里的密钥，失败或为空时回退 `ZHIXUN_MODEL_API_KEY` / `OPENAI_API_KEY`。
- `endpointOf` 改为接收 `cfg`，所有调用点同步；设置接口新增 `ttsModel`、`ttsVoice`、`apiKey`、`clearApiKey`，并校验密钥长度与 `ZHIXUN_AUTH_SECRET` 是否存在。
- 配置响应新增 `keyHint`、`keySource`（`admin` / `env` / 空），任何接口都不返回明文。

### 前端
- 设置页新增：密钥输入框（密码框，已配置时占位提示「已保存，留空表示不修改」）、清除密钥勾选、语音合成模型、默认音色。
- 保存成功后清空输入框，只显示「已配置密钥（尾号 xxxx）」。
- 顺手修掉页面顶部「密钥只放在服务端环境变量」这句已过时的说明。

### 实际验证
- 保存 `sk-test-ABCD1234`：响应与第二次读取都不含明文，只返回「尾号 1234」，`keySource=admin`。
- 用保存后的密钥调 `/admin/kb/test`：返回 200 与 64 维向量，说明解密链路可用（对接本地 mock 模型服务）。
- 勾选清除后 `keyConfigured=false`、提示清空。
- 浏览器实测：密钥框 type=password、保存后输入框为空、提示为「已配置密钥（尾号 7d6c）」、控制台无报错。
- 验证用的假配置已清空，数据库目前没有密钥。

### 未完成与限制
- TTS 目前只做到「配置可保存」，朗读仍走浏览器 speechSynthesis；接 `/audio/speech` 播放是下一步。
- 密钥加密依赖 `ZHIXUN_AUTH_SECRET`：该值变更后旧密文将无法解密，需要重新录入密钥。
- 未做密钥轮换与使用审计。

## 2026-10-20 向量 / 对话 / 语音 三套模型配置彻底拆开

### 需求
- 用户要求三类模型分别配置，不要揉在一起；密钥仍加密入库，只在保存前可见。

### 数据层
- `migrations/005_model_slots.sql`：`kb_settings` 新增 `embedding_*`、`chat_*`、`tts_*` 三组 `base_url / api_key_cipher / api_key_hint`；原有的单套 `base_url`、`api_key_*` 保留为兜底列，并把旧值一次性复制到三个槽位。

### 后端
- `KbSettings` 从平铺字段改成 `embedding` / `chat` / `tts` 三个 `ModelSlot`（各自 baseUrl、model、密文、尾号），加 `ttsVoice` 与切片参数；`slotEndpoint(cfg, slot)` 统一产出 `ModelEndpoint`。
- 检索只用 embedding 槽位，导师只用 chat 槽位，语音用 tts 槽位；`encoding` 与 `chat` 的密钥互不影响。
- 设置接口改为接收 `embeddingBaseUrl/Model/ApiKey/ClearKey`、`chat*`、`tts*` 三组扁平字段，逐槽位加密：留空保留原密文，勾选清除则置 NULL。
- 配置响应改成三组 `{baseUrl, model, keyHint, keyConfigured, configured}`，任何一组都不回显明文。
- `POST api/admin/kb/test` 支持 `target`：`embedding` 调 `/embeddings`、`chat` 走一次最小对话、`tts` 调 `/audio/speech` 只看状态码。
- 补回被路由替换脚本误删的 `api/tutor/chat` 与 `api/tutor/history`。

### 前端
- 设置页重写为三张独立卡片（向量模型 / 对话模型 / 语音合成），每张卡各自的地址、模型、密钥、测试连接；语音卡多一个音色；卡片右上角显示「已配置 · 尾号 xxxx」或「未配置密钥」。
- 切片与检索参数单独一张卡，避免和模型凭据混在一起。

### 实际验证（对接本地 mock，仅用于自检）
- 三组密钥分别保存后，各自尾号独立（1111 / 2222 / 3333），响应里没有任何明文。
- 三个 `target` 的测试分别返回：向量 64 维、对话 256 字、语音 200。
- 清除后三条槽位同时回到未配置。

### 收尾
- 按用户要求停掉 mock 服务，清空库里的 mock 配置并把切片参数恢复默认（800/120/16/6），留待用户填真实密钥自行测试。
- `tools/mock-model-server.py` 补了 `/audio/speech`，仍只是开发自检工具。

### 限制
- TTS 只有「配置 + 连通性测试」，朗读仍走浏览器 speechSynthesis，未接播放。
- 密钥加密依赖 `ZHIXUN_AUTH_SECRET`，该值变更后旧密文无法解密。

### 设置页改为顶部标签切换

- 用户要求把三套模型配置改成顶部三个选项切换表单，不再纵向堆三张卡。
- 设置页改为「向量模型 / 对话模型 / 语音合成」三个 tab，切换下方表单；每张卡右上角仍显示「已配置 · 尾号 xxxx」或「未配置密钥」。
- 切片与检索参数只在「向量模型」标签下出现（它只影响索引）；「保存全部配置」一次保存三个槽位。
- 浏览器实测：三个 tab 都能切、切走后旧表单不再存在、语音标签下有音色字段，控制台无报错。

### 测试连接改为按页面当前值测试

- 用户反馈：先填了地址、模型和密钥再点「测试连接」，却提示「还没有配置对话模型」。原因是测试接口读的是库里已保存的配置，而用户还没保存。
- 后端 `POST api/admin/kb/test` 现在优先使用请求里带上的 `baseUrl` / `model` / `apiKey` / `voice`；没带的字段才回退到库里已保存的值，密钥为空时用已保存的密钥。
- 前端「测试连接」把当前表单值一起提交，因此先测后存、改完再测都能生效。
- 实测：库内为空时用未保存输入测试，返回的是真实的连接失败（502 Failed to connect），不再是「还没有配置」。

### 语音合成路径改为可配置

- 用户提供 `https://api.xiaomimimo.com/v1` + `mimo-v2.5-tts`，测试返回 openresty 404：该网关没有 OpenAI 的 `/audio/speech` 路由。
- 探测结果：`/v1/models` 不带 Key 返回 401（路径存在），而 `/v1/audio/speech`、`/v1/audio/tts`、`/v1/tts`、`/audio/speech`、`/v1/audio/generations`、`/v1/audio/synthesize` 用 GET 与 POST 均返回 404，说明这些路径在该网关不存在。
- 因此新增 `kb_settings.tts_path`（默认 `/audio/speech`），管理端「语音合成」标签多一个「合成路径」字段；测试与以后的实际合成都用它拼 URL。
- `ttsCheck` 的报错现在包含完整 URL，方便确认到底请求了哪个地址。
- 尚未接入实际朗读：需要确认 MiMo 的语音接口路径与请求体形态后再补。

## 2026-10-20 资料包上传：zip + 智能体整理（只做组织与存储）

### 需求
- 用户要求支持上传文件夹（只收 zip），把结构混乱的包交给「Lumin 那个智能体内核」整理成规范结构再落库；本期不切片、不建索引、不挂课程。
- 明确约束：智能体在给定目录有完整读写权限、中途不与用户交互、一气呵成；处理完成后丢弃原始上传与中间产物，只保留最终结果。

### 技术前提（已实测）
- `stdx.compress.zlib` 可用：用 `DecompressInputStream` 对 raw deflate 实测 56 字节还原 4000 字节，因此 zip 可以纯仓颉解，不需要外部程序。
- RAR 没有开源实现，放弃；上一版方案已确认只支持 zip。
- Lumin 是桌面 Agent 运行时（工具循环 + SQLite + 审批 + Pi provider），整套搬进 Web 后端会引入进程链路与状态存储，因此只抽它的内核形态：工具循环 + 沙箱工作区，用管理员端配置的对话模型驱动。

### 数据层
- `migrations/006_kb_bundles.sql`：`kb_bundles`（包名、字节数、状态 queued/running/ready/failed、步数、模型、标题、错误、运行日志）+ `kb_bundle_docs`（章节顺序、标题、正文、字数）。
- 磁盘只临时存放：`data/kb_work/<bundleId>.zip` 与 `<bundleId>/{in,out}`，处理结束在 `finally` 里整目录删除。

### 后端
- `kb_zip.cj`：手写 zip 目录解析（EOCD → 中央目录 → 本地头），支持 store/deflate，拒绝 `..`、绝对路径、`__MACOSX`/.DS_Store，单文件解压上限 64MB、单包 400 个文件。
- `kb_agent.cj`：Agent 内核。四个工具 `list_files` / `read_file` / `write_file` / `finish`，配合 OpenAI 兼容的 function calling；`KbWorkspace` 做路径沙箱（读只允许 in/ 与 out/，写只允许 out/，拒绝绝对路径与 `..`）；循环上限 60 步，每步写日志，模型报错即终止并记录原因。
- `kb_bundle.cj`：流水线 = 建工作区 → 解包到 in/ → 跑 Agent → 收集 out/*.md（按文件名排序，去掉 `01-` 这类前缀作为章节标题）→ 写 `kb_bundle_docs` → 清工作区与 zip。整个流程 `spawn` 到后台线程，HTTP 立刻返回。
- 新接口：`POST api/admin/kb/bundles`（raw zip，`X-Bundle-Name` 头，50MB 上限）、`GET .../bundles`、`GET .../bundles/{id}`、`DELETE .../bundles/{id}`。未配置对话模型时上传直接 400。
- `http_util.cj` 增加 `readBodyBytes` 读取二进制请求体。

### 前端
- 知识库页新增「资料包（zip）」区块：上传按钮、状态标签（排队/整理中/已整理/失败）、章节数与步数、查看结果（章节正文 + 可折叠的智能体运行日志）、删除。
- 有任务在处理时每 2.5 秒轮询一次状态。

### 实际验证
- 用 Python 造了一个包含中文目录、乱命名文件与假图片的测试 zip（5 个文件）。
- 用本地脚本化桩模型（`tools/mock-model-server.py` 增加 tools 回放，仅自检用）跑通全链路：7 步完成（list → read → 2 次 write → finish），落库 2 章，工作目录与 zip 均无残留。
- 浏览器实测：上传 → 状态变为「已整理」→ 展开看到 2 章正文与运行日志，控制台无报错。
- 未配置对话模型时上传返回 400「还没有配置对话模型，无法用智能体整理资料」。
- 测试数据与桩服务均已清理，模型配置回到空。

### 未完成与限制
- 只支持 zip（store/deflate），不支持 zip64、加密包、rar/7z。
- 整理质量完全取决于对话模型；模型崩了会停在 failed 并保留错误与日志，不会回退到规则排序（用户明确要求全部交给模型）。
- 上传是 raw body，没有断点续传；单包 50MB、单文件解压 64MB 为硬上限。
- 整理结果目前只落 `kb_bundle_docs`，还没有接成 kb_documents / 课程 / 索引；下一步再把 bundle 接到「建索引 → 发布课程」。

### 真实文件夹测试（hello-agents）与两处真 bug

- 用户明确规则：涉及模型接口的验证一律走真实接口，不允许 mock。已删除 `tools/mock-model-server.py`、依赖它的 `tests/model-chain.test.mjs`，并移除此前为自检加的 `ZHIXUN_MODEL_OVERRIDE_*` 端点覆盖开关——那个开关导致过一次「看起来走真模型、实际走桩」的误判。
- 用用户配置的 `deepseek-flash`（https://api.deepseek.com）通过 HTTP 接口真实跑了两轮：
  - `hello-agents-docs.zip`（239 个 md/txt，1.5MB）：22 步对话 / 65 条工具记录，产出 20 章、43,586 字，标题「Hello-Agents：从零开始构建智能体（课程讲义整理版）」。
  - `hello-agents-subset.zip`（24 个 md，469KB）：31 条工具记录，产出 10 章、85,499 字。
- 这轮测试暴露两个真 bug，均已修：
  1. **Invalid utf8 byte sequence**：日志与工具返回值按固定字节数截断，切在汉字中间导致 `String.fromUtf8` 抛异常、整个包失败。改为按 UTF-8 字符边界截断（`kbTruncate` / `kbTailText` / `readFile`），并对 zip 内非 UTF-8 文件名做容错跳过。
  2. **沙箱路径过严**：模型习惯用 `list_files` 看到的 `docs/xx.md`，而原实现要求 `in/docs/xx.md`，首轮出现 3 次「只能读 in/ 与 out/ 目录」。现在读取时自动补 `in/`、写入时自动补 `out/`，仍然锁在工作目录内。
- 修复后复跑小样本：0 次工具失败，第一次 read_file 即成功。
- 顺带确认：管理端「测试连接」用的是页面当前值（可测未保存），资料包流水线用的是已保存配置，两条路径现在一致地走 DB 里的配置。

### 资料包结果改为独立预览页

- 资料包列表里的「查看结果」改成「预览」，点击跳到知识库下的子路由 `/admin/knowledge/bundles/:bundleId`，不再在列表里内联展开。
- 预览页：左侧章节 TOC（点击定位并高亮），右侧按章节顺序渲染 Markdown；顶部显示包名、章数、总字数、智能体工具记录数，并提供「运行日志」折叠与删除。
- Markdown 渲染用 `marked` + `DOMPurify`（新增依赖）：先转 HTML 再净化，避免模型输出里的 HTML/脚本被带进页面。
- 样式集中加在 `admin.css` 的 `.zx-md` 与 `.zx-preview*`，覆盖标题、列表、行内代码、代码块、引用、表格、图片与移动端单列布局。
- 浏览器实测：两个已整理的资料包都能打开预览，10 章 TOC 可切换，正文渲染出 98 个标题、387 段落、291 个列表项、358 处加粗，控制台无报错。

### 预览页顶部条固定

- 「返回知识库」「运行日志」「删除」统一收进预览页顶部条，并设为吸顶（`position: sticky; top: 0`），滚动时始终可见。
- 顶部条内左侧是返回按钮，中间显示标题与「包名 · 章数 · 总字数 · 工具记录数」，右侧是日志与删除；窄屏自动换行。
- 目录与章节锚点都按顶部条高度让位（`top: 84px` / `scroll-margin-top: 84px`），跳转不会被遮住。
- 浏览器实测：滚动 1600px 后顶部条仍贴在 y=0，日志可开合，控制台无报错。

### 预览页支持数学公式

- 用户反馈公式没渲染。预览页原本只做 Markdown，没有数学排版。
- 引入 `katex`，在 `Markdown.jsx` 里先按正则抽出 `$$...$$`、`$...$`、`\[...\]`、`\(...\)` 换成占位符，Markdown 渲染并净化后再替换成 KaTeX 的 HTML——模型输出里的原生 HTML 仍然先过 DOMPurify，KaTeX 产物由本地生成，不走净化。
- 块级公式单独占行，避免被 Markdown 包进段落；公式解析失败时降级成行内代码，不让整段消失。
- 自检：临时插入一个只含公式的资料包（行内、块级、括号写法、表格内公式各若干），预览页渲染出 7 个 KaTeX 节点、1 个块级公式，原文里的 `$E = mc^2$` 已不再以裸文本出现，控制台无报错；测试包已删除。

### 中文标点导致加粗失效的修复

- 现象：`**语言模型（Language Model, LM）**是自然…` 星号原样显示。
- 原因：CommonMark 的强调夹逼规则要求右闭合的 `**` 不能「前面是标点、后面是文字」；中文全角括号 `）` 与句号正好命中，于是 `**` 变成普通字符。这不是模型输出错误，是渲染器按规范拒绝。
- 修法：在 `Markdown.jsx` 里加一层强调归一化——先把行内代码与公式摘成占位符，再按行把成对的 `**…**` / `*…*` / `__…__` 换成 `<strong>`/`<em>`，围栏代码块整段跳过；随后交给 marked，最后统一过 DOMPurify 并还原占位符。
- 自检：临时资料包覆盖了中文括号加粗、句号结尾加粗、英文加粗、斜体、`__` 加粗、行内代码里的 `**`、代码块里的 `**`、行内与块级公式——加粗 4 处、斜体 1 处、代码块与行内代码原样、公式正常，控制台无报错；测试包已删除。


## 2026-10-20 23:54:04 +08:00 Codex 接回 MiMo 会话：保留原文 + 支持资料包图片

### 用户本轮重点与接手依据
- 用户因额度用尽转由 MiMo Desktop 继续开发，要求读取 `ses_ffe5ea71ec6c1ffe2bk47pgY02` 会话，接着完成其中最新任务，并强调尽可能快完成。
- 按链接中的项目目录定位本地 MiMo SQLite，使用只读连接读取该指定会话的实际用户与助手消息，不修改 MiMo 的记录/设置。过滤 runtime/system-reminder，核对 43 条用户请求及仓库 TRACE 和 Git。
- 实际开发目录是 `D:\Downloads\zhixun-yunshu-28801-20261020`、分支 `codex/native-learning-v1`；Codex 当前挂载的旧 ITN worktree 不作为本次功能目录。接手时 Git 干净，HEAD `4ae1acc`。
- MiMo 已完成管理端、知识库、模型分槽加密配置、ZIP Agent 整理、Markdown/公式预览；用户最新要求未实现：网页图片与包内相对图片都保留、原文只做格式微调，禁止擅自改写措辞。
- 延续限制：PS7、纯仓颉1.2+Spire、无Docker、不用Open Design插件、不使用模型mock、不覆盖管理员保存的配置，旧资料包与源目录不动。用户此前已要求前后端子agent并行，因此本次分出图片后端、预览前端、真实接口验收，root负责原文工具与集成。

### 功能与接口
- `kb_agent.cj`：用 `copy_document` 和 `organize_documents` 让模型决定章节名称与顺序，正文由服务端完整复制原文件，避免模型重写或 read_file 预览截断造成丢失。每篇输出关联 `documentSources`。
- 移除任意 `write_file`/`delete_file` 工具；新增受限 `format_document`，只允许 Markdown 标记与排版微调，校验文字/标点/数字，保护代码和 TeX 公式。finish 检查全部支持文档的覆盖，遗漏则反馈模型继续，不能规则兜底或悄悄跳过。
- 工作目录读取不再在400文件处静默截断；ZIP上限2000文件，展开总计256MB，单文件64MB，超限明确失败；压缩条目路径使用工作区规范化，拒绝越界。
- `kb_assets.cj`：按每篇原文所在目录解析图片，支持 `../`、中文、空格、percent编码、行内/引用式/折叠/快捷 Markdown、HTML img；代码里的图片示例不参与替换。网页 URL 原样保留、不做后端下载。
- 包内真实图片保存至 `data/kb_assets/<bundleId>/<assetId>`（可用 `ZHIXUN_ASSET_ROOT` 调整）与 `kb_bundle_assets` 元数据；只替换文档图片目标地址，不改 alt、title 或正文。缺图/越界等写入 warnings 并在预览显示。
- 新增 `GET /api/admin/kb/bundles/{bundleId}/assets/{assetId}`：管理员 Bearer 鉴权、图片 MIME/字节、nosniff/private cache；学员403、未登录401、删除后404。
- 详情新增 `docs[].sourcePath`、顶层 `warnings:string[]`、`bundle.assetCount`。处理中禁止删除409，失败清理部分成品，完成清理上传ZIP与临时目录，删除资料包同时清理成品图片与元数据。
- 前端 Markdown 本地图使用管理员鉴权 fetch → blob；接近视窗再读，重复引用复用请求，卸载取消请求并释放URL；网络图直接显示，失败显示保留alt的占位。
- 保留中文强调符与KaTeX，围栏代码在公式/强调处理前保护；渲染时去掉开头BOM，存储原文保持不变。窄屏长公式和表格只在自身容器滚动，页面不横向溢出。
- README 移除已不存在的mock启动说明，补充真实模型验收、原文保留/图片生命周期与限制。

### 数据与构建操作
- 新增迁移 `007_kb_bundle_assets.sql`，只给 `kb_bundle_docs` 加 `source_path`、`kb_bundles` 加 `warnings_json`，新建资产元数据表；未修改旧业务库。
- 先从当前 `.env.local` 核实运行目标是远程的隔离库 `itn_learning_v2_dev`。运行账号ALTER被拒绝1142，因此使用用户此前提供的数据库管理员凭据完成该库的增量DDL，不扩大运行账号权限，不改 `.env.local`。
- 迁移前后比较 `kb_settings` 全行哈希与 `.env.local` 字节哈希：一致。密钥/密码不写入日志、文档或Git。
- 首次构建遇到图片解析局部变量 `quote` 为仓颉关键字，改名 `quoteByte` 后通过；最终 `scripts/build-backend.ps1` 再次通过，原生后端已重启8312，Vite继续3006。
- `npm run build --prefix apps/web` 通过，61 modules；现有KaTeX主包gzip约262.7KB，仍有Vite单chunk>500KB提示。本轮未做无关打包重构。

### 真实验收与保留结果
- `ZHIXUN_TEST_REAL_MODEL=1 node --test --test-concurrency=1 tests/bundle-images.test.mjs`：5/5通过，约13秒，使用数据库已保存的 `deepseek-flash`。测试含完整真实前言、3张真实图片、7种本地引用方式与网页URL；原文/代码保留、图片SHA256、临时目录清除、管理员鉴权与删包清理均通过；测试包已删，原有两包与模型配置保留。
- 账号/管理端/学习端回归：11项中10通过、1跳过；学习闭环跳过原因是当前没有已发布课程（符合用户先清空课程、改走知识库上架的决定），不是把跳过计为通过。未运行可能调用不相关向量模型的知识库用例。
- 额外用真实第三章验证完整79691字节原文中的网络图片URL不变。为验证离线图，再仅在内存测试ZIP中把原有6个图片URL改为指向同目录真实图片的相对路径，生产代码无特定语料规则。
- 最终保留包：`eece4ad5-b968-4f33-b4ff-fc294a1e5f36`，标题“第三章 大语言模型基础”，原文约43011字，6张真实本地配图，真实模型工具记录6条。逐字反向核验：除图片目标URL外，整篇内容完全一致；6图字节SHA256均与源文件一致，warnings为空，上传与临时目录已清除。
- 早期用于核对网络图片的本轮临时包 `df74c818-e21d-4f6c-9038-b77b9bf92365` 已清理；接手前的两份历史结果未改。
- 浏览器真实验证：本地图已携带鉴权加载，66个KaTeX节点，围栏代码保持原样，控制台无错误；窄屏document宽度/scrollWidth均464，无整页横向溢出。图片按视窗懒加载，未接近视窗的图片尚不发请求。
- 预览URL：`http://localhost:3006/admin/knowledge/bundles/eece4ad5-b968-4f33-b4ff-fc294a1e5f36`，截图 `analysis/bundle-images-preview.jpg`。浏览器标签保留供用户查看。

### 后续接手边界
- 已完成本轮“图片支持 + 原文保留”任务；旧的模型改写结果不会自动恢复，需重新上传原ZIP使用新规则。
- 不要重新清空或写入模型配置，不要再引入mock。资料包目前仍只做组织/存储/预览，后续接索引与发布不在本轮范围。
- 数据库资产元数据与 `data/kb_assets` 成品文件需一起备份；原有两包没有图片素材，不能凭空恢复。
- 所有功能改动与本段TRACE一并本地Git提交，未推送远程，未部署或修改线上28801。


## 2026-10-21 00:00:57 +08:00 方案讨论：知识库 SVG Logo 与导入自动切片（尚未实施）
- 用户询问：压缩包处理后能否让 Agent 为知识库生成 SVG Logo，切片应在导入时一起完成还是独立操作；随后明确“先给我方案”。本轮只核对代码和记录方案，不实现功能、不调用模型、不改数据库。
- 现状核对：ZIP产物在 kb_bundle_docs，尚未接入 kb_documents/kb_chunks；已有 kbChunksFor 按标题、句末和重叠切片，kbIngest 同时负责写切片与向量化，现有发布从切片重组内容。工作区接手提交 b691f5b，无其他改动。
- 建议：管理员一次上传，原文/图片落库后自动切片；后台把切片、向量化、Logo作为可单独重试的阶段。Logo失败不阻塞导入，向量化失败不阻塞预览与课程阅读。
- Logo沿用管理端保存的文本模型，根据标题与目录生成自包含SVG，统一紫色体系，存为知识库图标；限制脚本/外链/嵌入HTML，不引入新图像模型。知识库卡片和预览头部展示，允许独立重新生成。
- 切片复用仓颉现有代码，完善代码围栏/表格/公式/图片段落的结构边界；默认沿用现有800字、120字重叠参数，记录源文档与章节位置。原文为唯一阅读正文，检索切片为派生数据，不能把带重叠的切片重新拼成讲义。
- 向量化在切片之后后台执行，使用已配置向量模型；未配置时保留关键词检索并显示待配置，配置后仅补索引。按内容版本/哈希复用未变化切片与向量，失败只重试该阶段。
- 用户操作保持“上传 → 预览 → 发布”，不增加审核或单独的切片确认。实现时先接通ZIP资料包与现有知识库/课程链路，并让已发布课程的Logo/配图走学员可访问的权限路由；不新增服务或Docker。
- 以上为本轮建议，等待用户后续指令后再做功能更新；不把方案记录当作已实现状态。
