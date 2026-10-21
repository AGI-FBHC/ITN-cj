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


## 2026-10-21 00:05:16 +08:00 切片方法澄清（讨论，未实现新功能）
- 用户问“如何切片比较好，切片应该不需要用到向量模型吧”。已只读核对 kb_chunk.cj / kb_service.cj：kbChunksFor 为本地标题/句末/重叠规则，kbIngest 先生成并存储切片，随后才在配置存在时调用 embedTexts；切片本身不依赖向量或对话模型。
- 建议采用 Markdown 结构切片：先分源文档与章节，再按段落组合，目标约800字；长段落在完整句末分开，必要时重叠约120字，尽量以整句为单位。代码块、表格、公式、图片与图注须保护，不按固定字符数截断。
- 源文件/章节/原文位置随切片保存，用于引用和回跳；课程阅读继续使用完整原文。向量化是之后可选的语义检索步骤，无向量配置也应能切片并做关键词检索。
- 当前已经有标题、句末和重叠基础，复杂Markdown整体保护仍属后续待实现。保持“先给方案”的讨论范围，本轮没有改功能、调用模型或写数据库，只追加本文件并本地Git记录。


## 2026-10-21 00:12:56 +08:00 实证核对正文是否由LLM输出；讨论隐藏切片标记
- 用户要求先确认上传后正文是否经过LLM重新输出，再讨论能否在该输出中顺带添加预览隐藏的切片控制标记；用户倾向规则切片可能更合适。本轮仅调查/讨论，未授权实施新切片模式。
- 已对比Git旧版4ae1acc与当前源码：旧版write_file接收模型提供的完整content并落盘；当前copyDocument直接File.readFrom源文件并kbWriteFileDeep复制，organize_documents只是批量复制，format_document仅接收受限局部补丁；模型普通content仅记录进运行日志，不作为最终正文入库。
- 使用运行配置只读SELECT核对三份实际资料包日志，无调用模型或修改数据库：hello-agents-docs.zip有20次write_file、subset有10次write_file；当前预览eece4ad5-b968-4f33-b4ff-fc294a1e5f36只有1次copy_document、0次write_file/format_document，复制79277字节后finish。确认用户记得的早期链路正确，而b691f5b为保留原文已改为工具复制，需向用户明确解释这一变化。
- 讨论结论：若全文本来就需模型输出，约定独立切片标记可行，后端需解析为边界元数据，预览/检索/向量化均使用去标记正文，不能只CSS隐藏。标记属于边界表示，并不自动改变选边界的算法或提高模型切片质量。
- 对当前标题清晰的Markdown教材建议结构规则为主，保护代码/公式/表格/图注，边界可由程序生成并单独存储。若需要模型辅助语义判断，只让其返回已编号段落的分界建议，由程序验证与执行；不必为打标让整篇原文再次输出。未知的检索效果优劣不宣称已有对比实验证明。
- 本轮只追加接手记录并本地Git提交；不修改业务源码、数据库、模型配置或现有文档内容，不实现此前尚在讨论的Logo/自动索引。


## 2026-10-21 00:22:59 +08:00 统一泛化流程、切片摘要、向量存储与鲁棒性方案（讨论中，未实现）
- 用户连续明确：所有资料应走同一套通用流程，不能按教材结构清晰/混乱分别设计；切片还包括总结性信息，要求最方便实现且不易出错；特别强调“一定要鲁棒”。另问向量怎样保存、是否需独立安装向量数据库。
- 已只读核对002知识库DDL与kb_service.cj/kb_vector.cj：已有kb_chunks保存切片原文与标题路径，kb_embeddings保存chunk_id/model/dim及int8量化后hex编码向量。MySQL负责持久化，仓颉服务加载到进程缓存，逐条余弦计算并融合关键词检索。此实现不是数据库内ANN索引，容量和并发能力未做规模压测，不承诺无规模上限。
- 更新建议：结合用户对摘要的澄清，将上一条拟议的“Agent选择语义边界”简化为“统一内容块规则切片 + LLM逐片补摘要/关键词”。这是当前讨论方案的调整，不是已实现功能。所有已支持文档均走同一流水线，标题仅为线索，不按文件名、教材类别或结构质量写专用分支。后续用检索验收决定是否再增加模型边界判断。
- 统一流水线建议：先可靠保存原文/图片 → 程序按段落、代码、表格、公式、图片图注等块组合切片 → 现有文本模型按切片ID批量生成简短摘要和3–5关键词 → 已配置时生成向量。Agent保留正文，模型仅返回附加字段，不重新抄写全文；边界和来源位置作为元数据保存，正文不混入隐藏控制字符。
- 每片基础数据：原文、源文档/章节/位置、内容版本或哈希；附加数据：明确标注的AI摘要与关键词；向量：切片ID、模型标识、维度与向量数据。检索输入可用标题+摘要+原文，最终回答引用原文和实际出处；摘要不能取代原文作为事实依据，JSON结构校验也不能被宣称为摘要事实正确性证明。
- 最小依赖方案：第一版复用现有MySQL存原文、切片、摘要、关键词、向量及任务进度，仓颉负责检索和后台作业，不新增向量服务/Docker/消息队列。增长后按真实延迟/并发压测评估独立向量引擎，预留存储适配接口即可。需要补模型/维度/知识库隔离，换向量模型仅重建向量，不能混算不同空间。
- 鲁棒性要求作为验收标准：原文与AI衍生信息分存；按原文范围验证完整覆盖，保护代码公式表格和图注；模型结果结构化并校验切片ID/类型/长度；摘要/向量/Logo各阶段持久化状态，逐批落库，中断恢复只做未完成任务，有限重试与幂等防重复；更新索引先构建新版本再切换，保留上一可用版本，不先删旧索引；模型故障保留原文并明确显示待补充/失败，不写假结果。
- 所有任务自动后台执行，管理员仍只上传、预览、发布，不增加人工审批或逐片确认。SVG Logo仍是此前待实施方案，可在原文整理后独立后台生成，不阻塞正文和切片。
- 后续验收应覆盖不同来源/排版资料、缺图、超长块、模型响应异常、断网/重启、重复提交和更换向量模型；模型链路一律使用真实接口，禁止mock和针对测试语料硬编码。
- 本轮只追加本文件与本地Git记录，未改业务代码、数据库、模型配置，未实现上述自动切片/摘要/向量重试/Logo功能。


## 2026-10-21 01:07:19 +08:00 功能里程碑：鲁棒导入、摘要向量与独立三风格Logo已接通；原包验收进行中
- 用户已同意实现上一轮统一方案，要求弄好后用Hello-Agents压缩包实测；随后补充Logo必须独立API，按资源标题一次生成多个不同风格供替换，并复用到以后重新生成按钮；多次要求尽快，原“先给方案”限制已被明确实现授权替代。
- 延续纯仓颉1.2+Spire、无Docker、不用设计插件、实际模型接口禁止mock、不能针对Hello编写业务特例；所有支持文档同一流程。按用户此前授权并行：bundle_assets负责持久化pipeline/接线，bundle_checks负责结构切片/模型解析/SVG，bundle_preview负责前端及真实小包验收，root负责契约/迁移/流式上传/索引空间/发布/集成。两个后端子agent后续遇到额度限制，root已接手剩余编译与边界修复。
- 新008迁移已使用DDL账号执行到原隔离库itn_learning_v2_dev，仅加列/表/索引，不给运行账号扩大权限，不改.env.local或kb_settings。新增kb_ingest_jobs持久队列、source/config快照、active/pending构建指针、切片offset/hash/摘要关键词、向量space_key及logo_generations。快照仅存现有已加密槽位密文，任何API不返回快照。tools/apply-schema.py可幂等应用该目录内增量DDL，严格限定隔离库。
- 原文/图片先持久保存，组织失败/服务中断可从原文与成品图片重建工作区；解包/存储不会因模型暂时失败丢正文。流式上传256MB，ZIP目录/CRC/解压长度/总大小/路径/大小写冲突校验，最多4000文件、展开512MB、单文件64MB。HTTP底层ServerBuilder默认限制导致原包413，已用configureServer.maxRequestBodySize同步256MB并真实验证上传成功。
- 全资料用同一内容块切片：原文UTF8字节offset完整覆盖、句/段切分、重叠、围栏代码/TeX/表格/图片图注整体保护；不修改原文字句。测试发现“保护块前只有重叠的重复窗口”会校验失败，root已修为在已覆盖边界继续，不丢文、不输出重复范围。
- 原包实际含一份UTF-16LE的requirements.txt；新增通用Unicode BOM解码，支持UTF-16LE/BE及代理对，仅规范化工作区文本为UTF8，用户原ZIP不变；损坏字符明确失败。没有按文件名写特殊转换。
- 两个持久化加工worker：原文快照→结构切片→按ID批量LLM摘要/关键词→真实embedding，分批SQL保存、有限重试、重启恢复、同源/配置复用，保留旧活动版本。更换向量配置时复用同源同heading同chat模型的既有摘要。root搜索严格过滤端点/模型/实际维度/量化算法空间，摘要关键词辅助检索，回答引用原文；导师只检索已发布且符合课程范围的资料。
- Logo独立队列/API，真实文本模型按title生成line/flat/geometric三种SVG，严格图形/属性白名单、无脚本/事件/外链，独立选择和重新生成；导入自动调用相同服务，按整理后的资源标题生成。生成失败保留上次图标，不影响正文与发布。
- 原文发布为课时，不拼接重叠切片；bundle重复发布保持相同课时与进度。学员鉴权图片和公开已发布Logo路由已接；下架/删除后不可访问，Logo no-store防替换缓存。
- 前端保持紫色：处理/摘要/向量/Logo状态、阶段补全、切片分页30、摘要关键词、三图选择/再生成、显式发布/下架。整包原文只渲染当前章节；进度2.5秒轮询/status，仅文档数/组织状态变化时更新完整正文，避免4.3MB全文反复传输。学员真实讲义接Markdown/公式/代码/鉴权图片。
- 编译问题quote/where/unsafe保留字与默认位置参数已修。后端构建通过，前端构建通过；5组仓颉纯函数测试全通过（覆盖原文/保护块、overlap拒绝缺口、嵌入乱序/异维/非数/零向量、UTF16、JSON与恶意SVG）。
- 新tests/ingestion-v2.test.mjs通过6/6，82.7秒：真实2文档7片全文offset、3风格Logo选择与再生成、摘要关键词、真实1024维相同空间、幂等重试、原文发布及学员配图权限；测试数据清理完成，原有资料包与配置hash保持一致。前一轮仅测试归一化漏了输入相对图替换，误报已修，属于测试断言问题。全程无mock。
- 用户指定原包D:/Downloads/hello-agents-main.zip保持逐字节上传，166920355字节、1736文件、275支持文本、展开185972682字节。当前保留bundle=35517bee-70b2-49fe-b7de-a74afd722e2d，URL http://localhost:3006/admin/knowledge/bundles/35517bee-70b2-49fe-b7de-a74afd722e2d，source已275份全部保存并组织完成，正在切片/摘要/向量，Logo独立排队。验收脚本tools/verify-archive-ingestion.py进程session59502还在运行，进度在ignored data/ingest-progress-<id>.jsonl、run信息data/full-archive-run.json；完成后将生成data/full-archive-report.json。不要把此里程碑当原包全验收已完成。
- 当前后端本地8312、Vite3006正常，未部署/修改线上。root仍需完成原包实际结果核对、重启恢复实测、浏览器图文/摘要/Logo验收、回归及最终本地Git收尾；本次先提交可回滚的功能里程碑。

## 2026-10-21 内置 Agent 通用切片修正：按正文内容成组，避免标题和短碎片独立入库
- 用户连续指出：页面中FEATURES.md的“工作流功能/前端功能”纯标题切片只是例子，全文还有很多类似问题；随后明确“不是要检查和重构，而是要内置的luminAgent切片逻辑做得好一点”，并要求尽快修正。本次落点为每次导入都会自动调用的生产逻辑，不对特定教材、文件名、四个样例或数据库行做特殊修补。
- 实际调用链：资料包Agent原样组织文档 -> kbMapBundleDocuments -> kbQueueBundleBuilds -> kbSeedBuildChunks -> kbChunksFor。当前仓颉服务的入口文件是kb_agent.cj/kb_bundle.cj，切片实现是kb_chunk.cj；用户所说LuminAgent的导入加工行为由这条内置链路承担。保持统一规则，不增加全文LLM改写或人工审核。
- kbBlocks/kbAttachHeadingBodies把连续标题、空行与后续正文/完整列表项绑定，不再逢标题就产生独立切片；短小节按约800字目标组合，headingPath取实际共有章节。代码围栏、公式、表格、图片与图注继续整体保护；新增列表项及其缩进续行保护，长列表可在条目之间分开。
- kbCoalesceSmallPieces作为每次导入的内置质量修复：少于目标1/4的短片优先与相邻片合并，合并软上限1.5倍目标；空白、分隔线、标题链必须归入邻片，不单独索引。若邻居是超长保护块，允许保留有正文的短片，避免把检索片无限增大；不把最小字数当机械硬阈值。
- 合并直接取原文连续UTF8字节范围，不拼接带重叠的文本；自动检查原文全覆盖、边界合法、每片与source_start/source_end一致，含正文文档不得产生无正文的独立切片。检查在摘要/向量请求之前运行，不依靠管理员事后逐片检查。
- 加工快照加入content-blocks-v4版本，使同一份旧资料重试时建立新切片构建。旧活动版本在新构建完整后切换，原文/图片不修改。相同原文、heading、摘要、关键词和模型端点/维度的已有向量可复用；空间校验仍严格，禁止混维度/不同端点余弦计算。
- 原包实测过程中曾有真实模型返回items数量不足，原有严格校验拒绝保存，不能当作成功。补充通用自动退让：失败批次后续从16片降至8片、再到单片；成功批次重置连续作业失败计数，各片三次上限仍保留。不改模型地址、密钥或配置，不写假摘要。
- 模型/Logo进程中断不额外消耗一次失败额度；恢复时清除纯重启提示。Logo选择状态优先采用资料包当前selection，修正图标已切换但标签仍显示旧样式的问题；无generationId的历史pending状态允许点击生成。保留用户当前flat样式选择。
- 原生测试6/6通过：中文/多语言UTF8范围、UTF16、重叠、保护块、列表续行、标题/分隔线/尾部空白自动归并、严格JSON/向量/SVG。原ZIP全部275个文本经相同生产kbChunksFor执行，报告4457片、纯标题/空白/分隔线问题0、完整保护块0拆断、原文覆盖无缺口；43个短片可能因相邻超长保护块保留，未声称所有片必须达到某字数。记录在ignored data/corpus-audit/report.json与data/chunk-v4-tests.log。
- scripts/build-backend.ps1通过，已重启原生后端8312，当前PID168728；验收进程临时ZHIXUN_INGEST_WORKERS=8，默认4，范围1..8；不改.env.local。Vite3006保持运行。已通过现有retry API为整个35517bee-70b2-49fe-b7de-a74afd722e2d安排新规则，完整原包原文与129图保留，Logo无需重画。
- 账号/管理端/学习端回归本轮最新结果：11项中10通过、1跳过（尚无已发布课程），不能把跳过算通过。旧knowledge-base同步用例尚未适配202异步契约，未运行也不宣称通过。
- 全原包真实模型、向量最终验收仍在运行（session82392，tools/verify-archive-ingestion.py --bundle-id；日志data/full-archive-v4.log），后续需看实际报告再宣布完成。此前session59502因严格摘要数量不符结束，原文及已成功数据未删除。不得把275文档纯函数切片通过说成全原包LLM/向量已完成。
- 本次所有改动与本TRACE同步本地Git供回滚；不推送远程，不修改线上28801，不引入Docker/额外向量服务，不手工改动用户保存的模型设置。

### 2026-10-21 补充：明确规则切片与LLM的职责；复用判定按字节严格比较
- 用户问“目前这个切片是硬规则还是llm对内容做了判断后再切分的？”已明确回答：当前边界由程序结构规则决定，LLM只在之后生成摘要与关键词，向量模型随后生成向量；尚未加入LLM决定语义边界，不应把内置Agent调用规则说成LLM通读后切片。用户这条是询问，未擅自改成新的LLM边界规划模式。
- 对新缓存复用谓词补充BINARY比较：MySQL默认不区分大小写的文本相等不能证明heading/summary/keywords/model/baseUrl的输入完全一致。仅在原文字节哈希、标题、摘要、关键词、模型标识及端点严格一致时复用；向量空间检查保留。此补丁不改变content-blocks-v4的切片范围，不需要再次重建资料包。
- 已在实际MySQL只读SELECT验证默认大小写不敏感比较与BINARY严格比较的差别，包含JSON_EXTRACT端点路径，测试通过；未写入模型配置。仓颉6/6测试再次通过，日志ignored data/chunk-v4-exact-tests.log。
- 为避免中断正在进行的真实整包验收与小包回归，先本地提交该严格性补丁；本轮完整模型任务结束后构建/短暂重启部署，并用独立临时文档验证新SQL实际执行后只清理该临时文档。当前服务仍是befa4f3编译版本，勿把源代码已提交与运行二进制已更新混为一谈。

## 2026-10-21 02:06 +08:00 收尾：通用切片已在全原包生效，真实模型/向量/Logo验收完成
- 本轮用户的最终重点为改善内置Agent每次导入使用的切片逻辑，不做针对几个例子的手工修复，也未要求改为LLM决定切片边界。最终实现仍是结构规则 + 内置质量归并 + 独立LLM摘要/关键词；后续若要模型语义边界判断，需另行设计与授权，不能把当前规则包装成LLM判断。
- 当前实际工作项目D:/Downloads/zhixun-yunshu-28801-20261020，分支codex/native-learning-v1。功能提交6d402c8，通用分组修正befa4f3，字节严格复用补丁3c8c2f1。Codex环境附着的C:/Users/GeJie/.codex/worktrees/13e7/ITN不是当前应用的源码目录，不要在那个旧目录里修复此功能。
- unchanged原包D:/Downloads/hello-agents-main.zip（166920355字节）完成真实全量验收，未重新打包、未替换成章节小包：275份原文，4467切片，4467摘要，4467向量，实际维度1024，失败0、待加工0；完整原文逐一与ZIP比对，切片UTF8范围与正文一致且全覆盖；129张包内引用图逐字节SHA核验通过。原包本身有1处指向作者Mac绝对路径的缺图引用，保留warning，不编造图片。
- active_build全部275个均为content-blocks-v4，不是只处理FEATURES.md等少数样例。原文ZIP标准化文本的原生规则测试4457片，与运行时4467片的差别来自实际资料正文中的持久图片URL替换等字节长度变化，不应把二者混为同一输入计数。两条链路都验证完整覆盖；生产逻辑在摘要/向量请求之前自动合并上下文-only碎片并拒绝仍无正文的孤立片。
- 独立Logo生成已完成line/flat/geometric三款；当前资料包选中flat，用户选择保留。真实小包测试再次6/6通过：原文/图片私有权限、完整块和UTF8来源范围、幂等重试不更改已完成切片、三款Logo选择与重新生成、完整原文发布和下架权限。新一轮用例运行约19分12秒，包含排在全原包队列之后的等待，不能宣称是独立小包处理耗时；日志tests/ingestion-v2-ba310e69-44f8-463f-9402-11d551a43d91.log，主输出data/ingestion-v4-real-tests.log，测试仅清理自己的包/Logo/课程。
- tools/verify-archive-ingestion.py --bundle-id完整验收退出0（原session82392）；报告data/full-archive-report.json，进度data/full-archive-v4.log。真实小包session70765退出0；仓颉纯函数6/6通过（含全语料结构运行），前端构建此前通过；账号/管理员回归10通过、学习流程1因无已发布课程跳过。未运行尚依赖同步旧API语义的tests/knowledge-base.test.mjs，后续若维护它，应改202异步等待与源文发布断言，不能把它记为已通过。
- 全量验收收尾时加载3c8c2f1严格复用补丁，scripts/build-backend.ps1成功，新后端PID172708，8312端口；Vite继续3006。当前临时进程workers=8、产品默认4（有界1..8），.env.local字节哈希与本轮前基线一致，未修改用户的模型端点、密钥或设置。
- 最后新二进制真实冒烟：创建独立“内置切片回归-随机ID”原文，含多层标题、列表、代码、分隔线与结尾标题，自动合成一个有正文的切片，真实LLM摘要/关键词和1024维向量完成；新BINARY复用SQL实际执行成功，API设置哈希前后一致；仅删除自己的临时文档。结果data/ingestion-v4-production-smoke.json，session94279退出0。
- 重启前后在MySQL端对4467片的原文范围、正文、摘要、关键词、维度、向量hex和空间做结构化JSON SHA256，所有ID和哈希完全一致（data/recovery-v4-baseline-sql.json / recovery-v4-report.json）。这是完成数据的重启持久性检查；本轮早期99片处理中断并恢复的实测仍独立成立，不把这次已完成后的重启冒充一次处理中断测试。
- 操作教训：初次可选快照直接读取全部vec_hex到本地，MySQL长时间处于Sending to client。已仅取消该只读查询406593，Python报1317是主动取消可选大结果传输，不是生产加工失败；随后换为数据库内SHA2(JSON_ARRAY(...))只取短哈希，约2秒完成。旧大结果快照data/recovery-v4-baseline.json未生成，不应引用它。后续全量向量持久性对比应沿用数据库端哈希，避免再次拉取全量向量hex。
- 当前API最终确认：pipeline.ready，275文档、4467片/摘要/向量、pending0、failed0；Logo flat；1条原包缺图warning；没有发布此完整资料包为公共课程。浏览器预览URL http://localhost:3006/admin/knowledge/bundles/35517bee-70b2-49fe-b7de-a74afd722e2d，刷新即可查看全局新切片。
- 功能与本TRACE均已同步本地Git，未push、未改线上28801、不使用Docker、不接入独立向量数据库；未用mock，未替换真实provider端点，未改保存的API配置。所有本轮运行会话已结束，前后端服务正常保留给用户查看。

## 2026-10-21 登录超时紧急修复：预览只读当前章节，大文本读取与登录连接隔离
- 用户在全量切片完成后反馈“后端像挂了”“登录都登不上”，并连续要求尽快处理；本轮只处理登录/预览阻塞，不继续改切片算法，也不重新调用LLM或重建4467片。
- 首次检查原后端PID172708、8312监听正常，直连/api/health与3006代理健康检查均200、错误日志无崩溃。但进一步真正调用/admin/login超时20秒，不能仅凭health就宣布后端正常。远程MySQL只读SELECT1约1.09秒可返回，排除数据库整体不可达。
- 现场数据库看到连接406598的kb_bundle_docs全文SELECT长时间Sending to client；主程序query()在databaseLock内复用唯一sharedDatabase，该资料包275篇全文读取占住锁，后续登录查询一起排队，前端20秒超时。此前虽然只渲染当前章节，初始API仍下载整本资料，这是本轮确认并修复的遗漏。
- 先短暂重启恢复登录（临时PID155292），经3006真实登录返回token，约2.65秒。随后实施正式补丁并重新构建，当前原生后端PID173456，8312正常，Vite3006正常，worker进程改回4；没有改.env.local或用户保存的模型设置。
- main.cj新增queryIndependent，只为大文本读取开启独立MySQL连接并finally关闭，不持有登录使用的databaseLock；旧整包全文详情API保留兼容行为，但其正文读取改用独立连接，不能再独占登录连接。其余共享数据库事务机制保留，没有重写整套连接池。
- 详情和retry API新增兼容参数metadata=1，仅返回全部章节目录/字数/来源，不返回各篇content；新增鉴权GET /api/admin/kb/bundles/{bundle_id}/docs/{doc_id}只读指定章节，SQL同时约束bundle_id与doc_id，防止串包。
- 前端admin-api.kbBundle与retryKbBundle明确请求metadata=1；AdminBundlePreview先加载目录，再按需读取当前章节，已经读过的章节在页面内缓存；切章节显示加载/重试状态，不将旧章节正文错显示到新标题下。原文、图片、切片、摘要、向量均不变。
- scripts/build-backend.ps1构建通过并启动新后端；npm run build --prefix apps/web通过（63模块，约3.11秒，保留原KaTeX大包提示）。没有再次全量处理ZIP，因为本补丁不改变导入结果。
- 使用前端代理http://localhost:3006/api实际验证：目录metadata=1为82834字节、275章、全部没有content字段，约2.48秒；选132417字的最大章节（251114字节）并同时发起登录，登录2.24秒返回token，章节3.00秒返回完整正文。冷启动后的第一次登录为6.47秒，亦未超时；不能把2.24秒宣称为所有环境恒定延迟。
- 此验证没有mock、没有改provider、没有模型调用或测试数据导入，只产生正常登录会话。原资料包35517bee-70b2-49fe-b7de-a74afd722e2d仍在原地址，用户刷新页面即可走新按章加载逻辑。
- 本轮将3个功能文件与本段TRACE一并本地Git提交，不push、不改线上服务。后续若其他功能仍有大结果读取，应按现场慢SQL评估隔离，不把此次修复误记为整个数据库连接层已全面重构。

## 2026-10-21 知识库页收敛：去掉文档栏，检索独立成页签

- 用户要求：知识库页去掉「文档」栏及其功能（上传文档、看切片、重建索引、发布/下架、课程设置、删除）；检索从页面底部单独做成顶部切换按钮；检索条目限高内部滚动；去掉检索下的模型说明小字；检索命中内容改用与预览一致的 Markdown 渲染。
- 前端 `AdminKnowledge.jsx` 重写：页面只剩两个页签「资料包 / 检索」。资料包页签保留三项统计（文档/切片/已向量化）与 `AdminBundles`；检索页签只有输入框与结果列表。
- 原来的「上传文档」入口与其表单、文档表格、切片抽屉、发布/下架/课程设置按钮一并移除；后端 `kb_documents` 相关接口保留（异步入库与课程发布仍在使用），只是不再从这个页面暴露。
- 检索结果：单条 `.zx-hit-body` 限高 260px、`overflow: auto` 内部滚动，正文用 `Markdown` 组件渲染（含公式、代码块与中文标点加粗的既有修复）。
- 删除「还没配置向量模型…」这段提示；检索结果仍显示实际使用的检索模式与备注。
- 浏览器实测：「资料包 / 检索」两个页签可切换；页面已无「上传文档/看切片/重建索引」；检索「智能体 记忆 检索」约 1.9 秒返回 6 条，命中内容渲染出 2 个标题、28 个段落，单条可视高度 260px、内容高度 441px、overflow auto；控制台无报错。
- 说明：页面上仍出现的「发布为课程」来自资料包流水线（发布资料包为课程），不是被移除的文档栏功能。

## 2026-10-21 新增「课件管理」页（前端演示版）

- 用户不再从资料包上传处发布课程，改为在侧栏新增「课件管理」：左侧选知识库 → 中间选章节 → 右侧看原文（复用 Markdown 渲染）→ 生成课件时出现四类资源（讲义文稿 / 练习题 / 测验题 / 教学幻灯片），并可在同页「课件库」里预览、发布/下架、删除。
- 本轮明确只做前端效果：生成用 `setTimeout` 模拟（生成中→草稿），课件数据存在 `localStorage['zhixun-courseware-mock']`，不调用任何后端、不写数据库；页面顶部提示「当前为前端演示」。
- 新增 `apps/web/src/admin/AdminCourseware.jsx` 与 `.zx-cw*` 样式：三栏（知识库 216px / 章节 236px / 正文），章节与正文区各自内部滚动；窄屏降为单列。
- 章节列表用 `kbBundle(id)?metadata=1` 只取目录，正文按需通过 `kbBundleDocument(bundleId, docId)` 单章读取，沿用 Codex 修的按需加载；正文里的图片走既有鉴权资源路由，实测 Hello-Agents 首图正常显示。
- 按用户要求移除旧发布入口：资料包预览页顶部条的「发布为课程 / 更新课程 / 下架课程」三个按钮删除，列表行按钮由「预览与发布」改为「预览」，提示文案改为课件在「课件管理」里生成与发布。后端发布接口保留未删。
- 浏览器实测：侧栏出现「课件管理」；选中知识库后列出 275 章；选中章节后正文渲染 11 个标题并显示配图；「生成课件」弹出四类资源，选两类后提交出现两条「生成中→草稿」记录；「课件库」页签列出两条并可打开占位预览；控制台无报错。

### 课件管理页细节修正

- 三栏等高：`.zx-cw` 用固定高度 `calc(100dvh - 208px)` + `align-items: stretch`，三列实测同为 792px、top 一致；左右两列与正文区各自 `overflow: auto`，正文区改为 flex 布局加 `.zx-cw-scroll` 容器（实测 client 684 / scroll 8197）。
- 「生成课件」由页内面板改为弹窗：2×2 资源卡（讲/练/测/播 角标）、选中态为强调色边框 + 实心角标 + 圆形勾选、头部显示章节名与字数、底部「已选 N 项」+ 取消/生成所选，背景加轻微模糊与升起动画；预览弹层共用同一套样式。
- 按用户要求清除说明书式文案：删除页面副标题「选知识库 → 选章节 → 看原文 → 生成课件…」、弹窗里的「当前为前端演示…」提示、生成后的「（演示，不会调用后端）」、删除确认里的「（演示数据）」、预览弹层的占位说明；空态与占位文案收紧为「还没有课件」「选择一个章节」；同时清掉知识库页副标题与设置页「即可」措辞。
- 已把「不要箭头式操作说明、不要自我解释小字」写入项目记忆，后续页面沿用。
- 浏览器实测：页面内已无「→ / 前端演示 / 不会调用 / 这里会显示」等字样；弹窗按钮与选中态正常，控制台无报错。

### 课件资源类型调整

- 按用户要求把「练习题」与「测验题」合并为「题库」，并新增「实操指南」作为第二项；顺序为：讲义文稿 / 实操指南 / 题库 / 教学幻灯片。
- 早期本地演示数据里的 `practice`、`quiz` 两种类型在展示时统一映射为「题库」，不会出现未知类型。
- 浏览器实测：弹窗四张卡顺序与名称正确，选中「实操指南 + 题库」后生成，课件库列出两条，类型显示为「实操指南」「题库」，控制台无报错。

## 2026-10-21 课件生成接入真实后端：移植旧仓库四类资源生成 + 多智能体流程

- 用户要求参考 `AGI-FBHB/ITN-cj`（本地检出 `D:\Downloads\ITN-cj-analysis-20261020`，cc2e6208）里四类资源的生成实现，尽可能复用其代码。核对后确认对应关系：`lecture`→讲义文稿、`practice`→实操指南、`quiz`→题库、`ppt`→教学幻灯片。
- 复用的部分：四个提示词（`lecturePlanPrompt`/`lectureSectionPrompt`/`practicePrompt`/`quizKnowledgePrompt`+`quizQuestionsPrompt`/`pptPrompt`）逐条移植到 `kb_courseware.cj`；`validate.cj` 的结构校验阈值（讲义分节与字数、实操步骤数/风险等级/验收标准/故障排查、题库选项唯一与答案索引/解析长度、幻灯片要点数量与讲稿长度）一并移植；修复提示词沿用 `repairPrompt` 的形态，只返修一轮。
- 与旧版差异：旧版按整门课出章节大纲再逐节撰写；这里以「一章原文」为输入，所以讲义把规划与撰写拆成两次调用（先大纲后正文），课件以单章为单位。
- 多智能体流程显性化：规划 → 检索 → 撰写 → 质检 → 仲裁（按需返修）。每一步写入 `kb_courseware.steps_json`，管理端预览里以角色标签展示，失败时保留问题清单。检索这一步复用知识库混合检索（向量+关键词融合）取跨章证据，并把证据编号注入撰写提示词。
- 数据层：`migrations/009_courseware.sql` 新建 `kb_courseware`（bundle_id、doc_id、kind、title、status、published、content_json、steps_json、model、error_message），外键随资料包/章节级联删除。
- 接口：`POST /api/admin/kb/courseware` 提交生成（后台线程跑）、`GET /api/admin/kb/courseware`、`GET .../{id}`（含 steps 与 content）、`POST .../{id}/publish|unpublish`、`DELETE .../{id}`；服务启动时把上次没跑完的 `generating` 记录标记为失败。
- 前端：`AdminCourseware.jsx` 从 localStorage 假数据改为真实接口；生成弹窗保留四类资源选择；课件库按状态展示（生成中/待发布/已发布/失败），预览里按类型渲染讲义、实操指南（步骤+代码+预期结果+验收+故障排查）、题库（选项高亮正确答案+解析）、幻灯片（要点+讲稿），顶部展示五角色流程标签。
- 迁移中踩到的两个真问题：`where` 是仓颉关键字（变量改名）；索引缓存加载原本走共享连接，几千条向量会占住连接把登录堵死，已改为 `queryIndependent` 独立连接。
- 真实验收：用数据库已保存的 `deepseek-flash`（无 mock）对「前言」章节生成实操指南，61 秒完成，产出 6 个步骤、首步 instruction 204 字，流程为规划→检索→撰写→质检全部通过（未触发仲裁）；浏览器打开课件库能看到 2 条记录与流程标签，预览渲染正常，控制台无报错。

## 2026-10-21 系统 Logo 换新 + 机构设置（名称/简称/Logo）迁移

- 系统 Logo：把 `D:\Downloads` 的 `浅色背景.png`、`暗色背景.png`、`透明背景.png` 放入 `apps/web/public/brand/`（分别命名 logo-light / logo-dark / logo-transparent，另生成 64px 的 favicon.png），统一缩到 256px、38KB 左右。旧的紫焰 SVG（ProductLogo 原实现、登录页插画）没有删除，仍在代码/页面里保留。
- 使用位置：管理端侧栏与登录卡（`BrandLogo`，机构上传 Logo 后优先显示机构的）、`index.html` favicon、学员端 `ProductLogo`（改为图片，机构 Logo 优先，其次系统浅色版）、学员端登录页左上角与移动端品牌位（透明版）。
- 机构设置：`migrations/010_org_settings.sql` 新建 `org_settings`（机构全称、简称、logo_mime），默认「智训云枢」；Logo 文件存 `data/org/logo.bin`，MIME 落库。
- 接口：`GET/PUT api/admin/org`（读、改名称与简称）、`POST api/admin/org/logo`（原始图片体，按魔数校验 PNG/JPEG/WebP/GIF/SVG，≤4MB）、`DELETE api/admin/org/logo`；公开的 `GET api/org` 与 `GET api/org/logo` 供学员端取品牌（logoUrl 带内容哈希做缓存失效）。
- 管理端新增「机构设置」页面（侧栏第 5 项）：机构全称、机构简称、Logo 上传/预览/移除，保存后有成功提示。
- 学员端体现：新增 `org-brand.js`，启动时拉 `/api/org` 写入 localStorage 并广播事件；`RecoveredApp` 的导航、页脚、AppNavigation 三处品牌名改为读机构简称（缺省仍是「智训云枢」），ProductLogo 改为图片，ProfileEditor 的「智训云枢学习者」也改为机构简称 + 学习者。
- 实测：管理端侧栏/登录卡显示新 Logo；「机构设置」上传 `透明背景.png` 后立即预览并可移除；学员端登录页左上角与移动端显示新 Logo 与机构简称；游客进入建档页右上角也是新 Logo；控制台无报错。

### 课件管理：默认选中第一项 + 修章节串台

- 进入课件管理时知识库与章节都默认选第一项（原来只默认知识库，章节要手动点）。切换资料包后自动选新包的第一章。
- 修一个真 bug：切换资料包瞬间，页面还持有上一个包的章节目录，自动选中后会用「旧章节 id + 新资料包 id」去取正文，接口返回 404。现在章节数据带 `forBundle` 标记，只认当前资料包返回的目录；实测切换后正文正常加载，控制台无失败请求。

## 2026-10-21 课件按章节上架：课程上架 + 章节序号 + 资源发布三道闸门

- 用户提出的规则：课件管理里选中知识库可以「上架该课程」；课程下的章节与内容只来自已上传的课件，没课件的章节不出现在学员端；一章的四类资源里至少发布一份，该章节才能在学员端出现；章节序号由管理员上架时手动选，菜单里要标出已被占用的序号；只有已上架的课程才能上架课件；课程下架后课件不删除，方便再次上架。
- 术语按用户口径统一：知识库/课程 = 上架、下架；一章（一套课件）= 上架、下架；单份资源（讲义/实操/题库/幻灯片）= 发布、取消发布。
- 数据层：`migrations/011_cw_chapters.sql` 新建 `kb_courseware_chapters`（bundle_id、doc_id、order_no），主键 (bundle_id,doc_id)，`uk_chapter_order` 保证同一知识库内序号唯一，外键随资料包与章节级联删除。
- 后端（`kb_courseware.cj`、`kb_delivery.cj`、`main.cj`）：
  - `cwPublishChapter` 依次校验序号 1–999、课程已上架、章节属于该知识库、该章节至少有一份 `status='ready' AND published=1` 的课件、序号未被别的章节占用；通过后写章节记录并重建课程。课程未上架直接返回「课程还没有上架，先上架课程再发布课件」。
  - `cwUnpublishChapter` 只删章节记录，不动 `kb_courseware`，管理员随时可以再上架。
  - `cwRebuildBundleCourse(cfg, bundleId, forceStatus)` 从已上架章节重建课时：讲义 sections → 课时 sections；实操 steps → sections（指令 + 代码块 + 预期结果）；幻灯片 → `slides`；题库 → `quiz_json`（题干/选项/正确答案/解析）。只取 `published=1` 的资源，所以未发布的资源不会进学员端。`forceStatus` 为空表示保留课程当前上架状态，避免章节操作把已下架的课程又顶上去。
  - 上架课程改为只建课程壳 + 调 `cwRebuildBundleCourse(..., "published")`，不再拿原文直接生成课时；下架课程只把 `courses.status` 改回 draft，章节记录与课件全部保留。
  - 资源级发布/取消发布/删除后调用 `cwSyncCoursewareCourse`，若该章节已上架就重建，课时内容随之更新。
  - 学员端课程列表增加 `EXISTS(SELECT 1 FROM lessons ...)`，避免「课程已上架但还没有任何章节」时出现空课程。
  - 新接口：`GET api/admin/kb/courseware/chapters?bundleId=`、`POST api/admin/kb/courseware/chapters/{doc_id}/publish`、`POST .../unpublish`；课件列表多返 `chapterOrder`，课件库可直接显示所属章节序号。
- 前端（`AdminCourseware.jsx` + `admin.css`）：知识库列表项「275 章 · 已上架」徽标；章节列顶部课程上架条（未上架时按钮为「上架课程」，已上架显示「已上架 N 个章节」+ 下架）；章节列表已上架的显示绿色 `#序号`；主区按钮在已上架时显示「已上架 #N」；「上架课件」弹窗里上半部分是四类资源清单（未生成/生成中/待发布/已发布，可直接发布或撤回），下半部分是序号网格（已被占用的虚线灰底、删除线、写「已占用」，本章节自己的序号绿色高亮，默认落在 `nextFree`）；底部显示「已发布 N 份课件 · 序号 #M」，不足一份资源时按钮禁用；已上架章节额外有「下架这一章」。课件库新增「章节上架」列。
- 真实验收（无 mock，用库里的 `deepseek-flash`）：对「前言与课程导读」的真实章节跑了一次讲义生成（README_EN，21582 字），产出后发布并上架到序号 2；学员端课程从 0 课时变 2 课时，学习进度显示 `0/2` 且只有「前言」「README_EN」两章。下架课程后学员端课程数 0、章节 2 条与 ready 课件 2 份都还在；再上架后课时、章节序号全部恢复。未上架课程时调章节上架接口返回 409「课程还没有上架」，页面上「上架课件」按钮为禁用态。浏览器实测控制台无报错。


## 2026-10-21 08:39:55 +08:00 MiMo Desktop 最新会话接手核对（本轮未改功能）
- 用户提供附件C:/Users/GeJie/.codex/attachments/df28cb44-2b07-4a65-97b8-1308cfde8e50/已粘贴的文本.txt，要求看完这些最新MiMo会话后继续任务。已完整读10956字节附件，并核对当前Git、后端/前端源码、迁移与真实接口；没有把附件中的“完成”直接当作本轮验证结果。
- 当前真实工作目录仍是D:/Downloads/zhixun-yunshu-28801-20261020，分支codex/native-learning-v1，核对前工作区干净。MiMo新增功能提交均存在：33f28db（知识库页收敛）、5962b2b（早期演示课件页）、f694caf/7793da6（资源分类/文案）、262df50（真实课件生成）、1091524（品牌/机构/独立预览页）、d27ac8b（默认选择）、c9b63c4（章节上架）、461271c（术语）。早期localStorage mock已被后续真实接口替代，不应照旧演示阶段继续开发。
- 当前四类资源为lecture讲义文稿、guide实操指南、bank题库、slides教学幻灯片；生成入口kb_courseware.cj，角色流程为规划/检索/撰写/质检/按需仲裁返修，steps_json记录步骤，真实内容放kb_courseware。009_courseware、010_org_settings、011_cw_chapters迁移文件均在。
- 当前发布语义以用户最新要求为准：课程/知识库上架、下架；章节（一套课件）单独上架、下架并由管理员指定1–999序号；单份资源发布/取消发布。章节上架需课程已经上架，且本章节至少一份ready且published的资源；占用序号由唯一索引与后端校验约束；学员端只显示有实际课时的已上架课程，不再直接发布全部上传原文。
- cwRebuildBundleCourse通过keepStatusSql在未显式forceStatus时保留既有课程status，避免资源操作自动重新上架已下架课程；课程下架不删除kb_courseware或kb_courseware_chapters。附件中的“下架后重上架内容保留”已有对应源码，但本轮未对用户现有课程执行上下架来重放测试。
- 系统三版Logo、旧图保留、机构名称/简称/Logo管理、机构品牌在学员端应用、课件独立预览子页、课件管理默认选中第一知识库和章节均已有对应代码。org-brand.js读取公开/api/org。旧INTEGRATION_PLAN/SYNC_PLAN部分首版遗留项已过时，以最新用户会话、源码和TRACE为准；不要因旧计划说机构/管理端“未实现”而重新搭建。
- 本轮真实运行核对：原生后端PID122740（启动4:17:50）仍在运行；通过3006代理health200，实际管理员登录约2.29秒；公开机构接口返回name/shortName/logoUrl/hasLogo。没有重启服务、没有改模型设置、没有发起模型生成。
- 现有Hello-Agents资料包35517bee-70b2-49fe-b7de-a74afd722e2d：上架章节2个，前言#1、README_EN#2，各有1份已发布资源；nextFree=3。课件库实际为两份ready且published（guide、lecture）及一份保留的failed guide记录。学员课程接口实际返回一门Hello-Agents课程，章节只有前言和README_EN，index0/1，均done=false。没有删除失败记录或修改现有课程。
- 发现应优先处理的明确代码风险：kb_courseware.cj的cwRebuildBundleCourse在重建事务里无条件DELETE quiz_attempts、lesson_progress及lessons（当前638–640行）。因此更新资源、章节上架/下架、重新上架课程触发重建时会删除该课程学习/测验记录；仅保留课件资源不等于保留学习进度。当前本轮只读发现，尚未修改，也未执行破坏性重现。
- 修复上述问题时不能简单去掉DELETE学习进度就结束：课时lessonIndex按当前章节排序重新从0编号，插入/调整序号可能导致旧进度串到另一章。后续应基于稳定doc_id关联并保留或正确迁移进度，再以独立临时数据验证；不要用用户当前课程清数据试验。
- 附件提到TTS仅做到配置、朗读未接，这是后续候选工作而非本轮新增授权；本轮没有选择它或其他无关新功能。用户尚未给出新的具体实现事项，接手已完成，接下来需明确是先修学习记录保留还是继续新需求。
- 除正常登录验证产生会话外，本轮未改业务数据库、功能源码、上架状态或模型配置。按用户要求把本次对话重点和接手证据追加到同一TRACE.md，并本地Git记录，未push。

## 2026-10-21 09:31:07 +08:00 发布与切换保留学习记录；明确删除知识库才清理对应记录
- 用户在了解“重建”是自动同步、没有独立按钮后明确规则：删除知识库/清空时清理对应学习记录合理，普通切换没必要触发。随后要求尽快。已按此实现；没有加重建按钮，没有改切片或重新加工Hello-Agents，也未接入TTS等其他功能。
- 页面/知识库选择本来只是GET，未触发重建；本轮确认并保留此行为。发布资源、上下架课程/章节仍需同步可见内容，但不再删除学习进度或测验历史。
- 数据库现场确认lesson_progress和quiz_attempts均有(course_id,lesson_index)外键指向lessons，不能只去掉删进度语句却继续删课时。最终采用固定课时身份：lessons.lesson_index永久绑定章节，source_doc_id记录源章节，display_index单独表示当前用户端顺序，is_visible控制可见性。下架只隐藏旧课时，更新资源用UPSERT，调整序号不更换课时主键。没有复制历史到临时表或使用负数课时编号。
- 新增增量迁移012_courseware_learning_identity.sql：lessons增加source_doc_id、display_index、is_visible（默认1兼容已有课时），以及(course_id,source_doc_id)唯一索引；quiz_attempts增加correct_count/question_count保存提交时结果。用已授权DDL账号仅对原隔离库itn_learning_v2_dev应用，不改运行账号权限或.env.local，凭据只放进程环境、不写日志/Git。
- cwRebuildBundleCourse增加同步互斥，按旧sources_json中的kb_bundle_docs.id或document_id识别既有课时，沿用旧lesson_index；新章节只分配新的永久编号。未知旧课时保留并隐藏，不猜测迁移，也不删除记录。旧章节再次上架复用同一课时身份。重建函数已没有DELETE quiz_attempts/lesson_progress/lessons。
- 学员端接口仍使用当前展示下标，API内部解析为固定lesson_index后读写进度/测验；课程完成标记和最近学习记录反向映射到当前顺序，隐藏/下架课时不再可访问。没有改变前端原有路由形态。课程列表只显示至少有一个可见课时的已上架课程。
- 测验重试固定在原课程/原课时：重放旧attemptId到另一章节返回409；同一提交直接返回保存的成绩/正确数/题数，不按后来修改的题目重新判分，也不更新原学习记录时间戳。首次测验与进度在同一事务保存，并从实际插入成功的记录取结果。
- 显式删除知识库kbDeleteBundleContent现在按course_id清理对应quiz_attempts、lesson_progress、lessons与courses，再删除资料包；不再把已有学习记录的课程只留下draft壳。知识库列表和预览的原有删除确认文字同步明确“课程、课件和学习记录将一并删除，无法恢复”。本轮只对自动验收自己的临时数据执行删除，用户现有知识库未动。
- 只针对当前进度/测验持久性修改；旧收藏/书签JSON结构、生成流程和模型配置保持原样。不要把本补丁误记为学习记录全域数据模型重写。
- 纯函数7/7通过（新增旧课时身份解析用例），后端构建通过；前端构建通过。当前后端PID171980，8312正常，Vite3006保留；workers4。不使用Docker，没有新服务。
- 新tests/test_courseware_progress.py使用手工编写的独立课程/题库夹具复现迁移前课时：不是mock provider，不调用模型、不改模型地址或设置，也不借用用户现有课程做破坏性试验。实际原生HTTP/MySQL流程的10个场景通过：旧课时身份承接；页面/知识库切换只读；更新资源与原成绩重放；调整顺序与跨章节重放拦截；插入新章节不串进度；章节下架再上架；资源撤回再发布；无已发布资源时隐藏课程；课程下架再上架；删除知识库仅清理自己且保留另一门控制课程的学习记录。
- 这是一条集成用例包含10组场景，运行245.024秒，不是10条独立单元测试。报告data/courseware-progress-report.json、输出data/courseware-progress-api-tests.log，原生测试data/courseware-progress-native-tests.log。临时知识库、课程、资源、两名临时访客均在tearDown清理。
- 迁移/验证前使用数据库端SHA2对现有lesson_progress、quiz_attempts取快照；验证后两表原记录哈希完全一致（本轮前均为0条），.env字节哈希一致，临时知识库0个，API模型设置前后也一致。无现有学习记录可供原地压力验证，因此保留/隔离行为以临时夹具的非空历史实测为证，不能宣称恢复了更早已被旧代码删除的记录。
- 所有功能、迁移、回归用例及本TRACE同步本地Git供回滚；未push、未部署线上28801。后续修改课件同步必须保持固定课时身份，不能再按当前展示顺序重置外键主键或清空整门课的学习记录。

## 2026-10-21 09:37:24 +08:00 用户端接入讨论：保持当前紫色前端，只做资源适配（方案未实施）
- 用户确认进度保留修复后，希望讨论将上架课程接入用户端；随后明确用户端尽可能微调现有前端，部分组件/功能复用git@github.com:AGI-FBHC/ITN-cj.git，并要求尽快给出简洁方案。本轮保持讨论范围，未改功能代码、未生成资源或调整上架状态。
- 当前基础已接：实际/courses返回Hello-Agents一门课、前言和README_EN两章；首章接口返回6个sections、0slides、0questions。课程目录、章节正文、学习记录已有链路，下一步重点是按已发布的四类资源提供正确入口与展示，不是另建一套课程服务。
- 当前前端已有课程卡片、章节学习方式选择LessonStartModal、Markdown阅读器、测验界面和演示界面。保留现有布局/导航/颜色/学习流程，只在原有学习方式入口补实操选项，隐藏尚未发布的资源类型。
- 提议：课程与章节只显示满足上架条件的内容，并按管理员序号排序；讲义沿用现有阅读器，实操在同一阅读器适配步骤、代码、预期结果；题库沿用当前作答、服务端判分和解析；幻灯片沿用当前演示器，读取真实slides/讲稿。现有收藏、书签和AI导师入口不另起工作台。
- 后端拟只为学员章节接口补已发布资源的类型/可用状态与按类型分组内容，保留现有sections/slides/questions兼容字段与固定课时身份；题库不直接复用管理员含正确答案的原始预览数据，继续走现有学员答题接口。
- 旧仓库复用以拆逻辑为主：资源数据结构、实操步骤交互、题库状态/解析和引用展示等；当前已迁的认证、生成、判分和进度接口沿用，不重复迁移，不搬旧桌面工作台整页及样式。此次核对的是D:/Downloads/ITN-cj-analysis-20261020本地副本，当前HEAD8e9fdf5（不是早期记录的cc2e6208）；已找到resource/render.cj和shell/renderer/studyplayer.js的lecture/practice/quiz/ppt渲染入口，尚未声明与远端最新提交一致。
- 章节完成条件仅为待讨论建议：有题库沿用当前60分通过标准，无题库由学习者点“学完本章”完成，不强制把四类资源逐项全部做完。该规则当前尚未实现或获用户逐项确认；不要把讨论草案当作已上线行为。
- 建议首轮范围只有资源入口、四类内容适配、完成状态及上下架反馈。TTS/朗读和新题型等扩展不顺手加入，待用户后续明确。后端继续纯仓颉1.2+Spire、无Docker，模型设置不变。
- 本轮仅追加同一TRACE并本地Git记录讨论依据；未改应用功能或业务数据（正常登录验证产生会话除外），未推送远端。

## 2026-10-21 学员端接入已上架课件（用户批准最小适配方案）
- 对话重点：用户希望以当前紫色前端为主，只做微调和加法，部分复用旧 ITN-cj 的资源渲染逻辑；在上一轮简洁方案后明确回复“可以 帮我实现，尽快”。本轮按该授权实现资源入口、真实四类内容和学习完成状态，不加入新工作台、额外审核或 Docker。
- 实际工作目录仍为 D:/Downloads/zhixun-yunshu-28801-20261020，分支 codex/native-learning-v1；环境挂载的 ITN 工作树不是当前网页源码。沿用本地 Vite 3006 与仓颉1.2/Spire服务8312、既有隔离开发数据库；未更改远端28801网站。
- 沿用用户此前明确的前后端并行授权：learner_resource_ui 负责 apps/web，learner_resource_tests 负责独立契约验收脚本，主 agent 负责仓颉接口、兼容与集成；前端使用 ui-ux-pro-max 做现有应用屏幕的最小交互适配，不使用 OpenDesign 插件。
- 新增 services/learning/src/learning_resources.cj：统一按已发布课件生成 lecture/guide/slides 的类型化内容；题库只通过 publicQuestion 提供题目和选项。保留旧 sections/slides/questions 字段，现有知识库课时通过独立连接读取已发布 kb_courseware 自动适配，无需重新生成、重新上架或清空课程。
- 课程列表每章补 resources/resourceTypes 和管理员 orderNo；支持不连续的章节序号。课程/章节上架与资源发布的原有闸门继续生效。cwSyncBundleCourseLocked 同步时把类型化 resources 落进课程内容；稳定 lesson_index 身份及 display_index 排序方案沿用 feb5b04。
- 实操完整保留 objective、prerequisites、environment、steps（instruction/code/expectedOutput）、acceptanceCriteria、troubleshooting、safetyNotice、safetyChecklist、challenge、estimatedMinutes；原始数组使用字符串容器提取保留 JSON 中的中文、换行、引号和代码，不经存在转义问题的 stdx 重新序列化。新增原生单测覆盖带引号、括号和 Unicode 代码。
- 学员 GET 课时补 resources 与 completion（requiresQuiz、passScore=60、canMarkComplete）。内容中不包含题库正确答案或提前解析；公开选项用 JsonArrWriter 正确转义。没有已发布题库时拒绝提交空测验。
- 完成规则：阅读只更新 read，不自动完成；没有题库时由“学完本章”PUT complete:true 保存；有题库时该操作返回409，必须服务端判分达到60分。重试、刷新和课程上下架沿用已有进度、成绩和答题记录；不新建迁移、不删除用户记录。
- 前端新增 apps/web/src/LearnerResources.jsx：四类资源描述与数据适配、实操内容卡、统一章节完成按钮；切换章节重置本地状态并避免旧保存请求覆盖新章；从真实 progress.completed/chapters.done 恢复完成显示。
- RecoveredApp.jsx 保留当前布局、导航、紫色样式、阅读器、题库界面和幻灯片界面。学习方式弹窗仅列已发布资源，新增动手实操；讲义/实操共用阅读器；幻灯片读取真实内容；真实路径移除样例讲义/题目/幻灯片回退，旧样例函数声明未扩大清理。空资源/下架/网络错误提供可读提示和返回、重试入口。
- 测验逐题网络错误保留选择并允许重试，不再按答错处理；最后成绩保存失败支持原 attemptId 重试。幻灯片导师提问接既有 /api/tutor/chat，使用 message 与字符串 quote 参数，不保留本地拼接的假回答。
- 浏览器发现并修复课程详情的旧样例元数据依赖：新课程ID不在 Iv 映射时读取 updated 导致白屏，改为仅在真实 updatedAt 存在时显示日期，并把固定“第一章/核心基础”调整为课程目录/已上架章节。
- 验证：仓颉 release 构建成功，原生 cjpm test -j1 共8项全部通过；最终前端 vite build 成功（70 modules）。Vite 仍提示既有单包体积大于500KB，不在本次扩大重构。
- 真实 HTTP/MySQL 集成：tests/test_learner_courseware.py 11个检查点全部通过，166.780秒，报告 data/learner-courseware-report.json。覆盖四类内容、2/7/11序号、代码保真、答案不泄漏、无题库/仅幻灯片完成、40分失败/60分通过与禁止绕过、旧课程兼容、资源撤回/空章隐藏/课程下架再上架后保留学习记录。
- 验收数据为明确标记的人工编写课件，用于发布与学员契约测试；未伪造模型服务，也未调用模型生成或改动用户保存的模型配置。测试前后 provider settings 与 .env.local 哈希一致；finally 清理自建资料包/资源/课程/访客，SQL确认测试资料包、课件、课程剩余0。
- 已对真实现有 Hello-Agents 课程只读核对：前言可用实操、README_EN 可用讲义，未发布题库/幻灯片不暴露。没有为真实用户点完成或提交测验；UI浏览会正常写阅读状态。后端进程 PID152592（本轮记录，仅供交接，后续需查实时状态）。
- 浏览器实际验收通过：课程详情可打开，目录仅显示前言（动手实操）/README_EN（阅读讲义），前言弹窗只有已发布实操入口；实操阅读器实际呈现准备、6步指令/代码/预期结果、验收、排错与挑战，底部显示“学完本章”。没有点击真实用户的完成按钮或提交答案。
- 窄窗口实测发现既有左右分栏把阅读器挤成半屏，已让阅读/演示的可拖动面板在767px以下上下排列，保留导师入口；桌面仍是原左右布局。实操模式标签保持单行、课程名可换行。最终前端构建成功，日志 data/learner-resources-web-build-final.log，git diff --check 通过。
- 交付入口 http://localhost:3006/courses；本轮功能与本TRACE一起提交到本地Git，方便回滚。未推送远端；当前使用的管理员/模型密钥仍只在既有忽略配置或数据库中。

## 2026-10-21 10:42:20 +08:00 学习弹窗、机构邀请码、课件队列与对话核查
- 用户反馈学习方式弹窗中的课程图标遮挡标题和课程名。原因是恢复版前端依赖预编译 Tailwind，新增任意间距/定位类不会生成；现改用独立 `lesson-start-modal.css`，重排课程图标、课程名、章节名、资源入口，补齐 44px 关闭按钮、键盘焦点、窄屏滚动和 reduced-motion。桌面实看通过，单资源入口也保持清晰。
- 用户补充：注册必须填写机构邀请码，由机构管理员设置；同一机构用户显示同一 Logo；已有账号先归属江南大学。`013_org_invites_and_courseware_queue.sql` 新建 organizations，users 增加 org_id，全部 172 个既有用户回填江南大学，默认机构 ID 为 `00000000-0000-0000-0000-000000000001`。邀请码不区分大小写，写入前标准化为大写；同机构可多人使用，换码不影响既有成员。
- 后台新增机构列表、创建与切换；每个机构可独立设置名称、简称、邀请码和 Logo。Logo 存储于 `data/org/{orgId}/logo.bin`；默认江南大学可继续读取原 `data/org/logo.bin` 作为兼容。`GET /api/org` 有学习 Bearer 时返回该用户机构，无 Bearer 时返回江南大学；公开品牌接口不返回邀请码，Logo URL 带机构 ID 与内容版本。
- 正式账号密码注册必须提供有效邀请码；首次用邮箱验证码登录也必须提供有效邀请码。已有密码/邮箱账号无需邀请码且不因登录填了其他邀请码而换机构。校验失败不会消费邮箱验证码。匿名学习会话和游客默认归属江南大学，但不能绕过正式注册。已有账号可按原方式登录。
- 机构设置页最初未填江南大学邀请码，这是有意的安全默认：管理员在「机构设置」填写并保存后，新用户才能加入。没有猜测或写入公开默认邀请码。
- 用户要求课件生成使用队列：设置页新增“课件最大并行数”，范围 1–50，默认 10，保存在 `kb_settings.max_courseware_parallel`。课件任务先落 `queued`，持久 worker 按上限领取并改为 `generating`；重启时把中断的 generating 恢复为 queued，任务失败会释放并行槽位。`GET /api/admin/kb/courseware/queue` 返回 queued/running/activeWorkers/maxParallel 与最多 20 条活动任务。
- 课件管理页右上角新增队列图标，活动任务时显示数量；展开可见进行中/排队数、并行上限、进度条和任务列表。实际接口临时夹具验证 queued=2、maxParallel=10、两条活动任务均可展示，随后精确清理。
- 对话核查：讲义的 AI 导师、幻灯片的 AI 导师、顶部“AI智训”均调用真实 `POST /api/tutor/chat`，回答写入 `tutor_messages`，不是本地模拟。此前“AI智训”是本地 d3 规则拼接，本轮已移除，改为真实接口并加入思考、错误与并发提交状态。语音朗读仍使用浏览器 speechSynthesis；语音输入依赖浏览器 SpeechRecognition，是否可用取决于浏览器。
- 用户视角顺手修复：新增可直接访问的 `/login` 路由；首次登录向导仍由 Home 状态承接。登录与注册切换时清空密码和确认密码，避免敏感字段残留；顶部头像从硬编码“李”改为当前显示名首字。课件预览页也识别 queued，排队时自动刷新。
- 用户明确要求“用户画像的设计后面讨论”，本轮未改 profile_json 或画像结构，后续单独立项讨论用户画像字段、来源、可用边界和前端呈现，不能在未确认前把行为日志或敏感推断直接做成画像。
- 验证：仓颉 release 构建成功；原生 `cjpm test -j1` 8/8 通过；前端 Vite build 成功，保留既有单包大于 500KB 提示。`tests/test_org_invites.py` 真实 HTTP/MySQL 10 个检查点全部通过，覆盖邀请码、机构 Logo 隔离与缓存版本、已有账号、邮件首次登录、换码与清理；报告 `data/org-invites-report.json`。测试临时机构、用户和 Logo 已精确清理；最终数据库仅 1 个江南大学机构、无空 org_id 用户。
- 当前本地后端 PID 154964，8312；Vite PID 160368，3006；管理员页与队列弹层已浏览器实看。所有功能与 TRACE 提交本地 Git，供回滚，不推送远端。

## 2026-10-21 11:07:23 +08:00 多智能体协作泳道与生成范围纠正
- 用户要求在正在执行的课件任务完成后，把旧版多智能体协作泳道迁入当前紫色管理端；课件库项目增加详情 icon，进入协作页查看各 Agent 如何生成资源。
- 旧版参考：`ITN/src/front/src/components/agents/SwimlaneBoard.tsx`、`RealTeachingRunView.tsx`、`CollaborationWorkbench.tsx`。当前实现不复用旧仓库的全套页面/依赖，只迁移五 Agent 泳道、路径、实时状态、执行详情、证据和产物预览这些核心表达。
- 新页面 `CoursewareCollaboration.jsx` + `courseware-collaboration.css`，路由 `/admin/courseware/:coursewareId/collaboration`。课件库每行新增可访问详情 icon（所有状态均可点，包括生成中、失败）；页面展示规划、检索、撰写、质检、仲裁五条泳道，运行中自动 2.5 秒轮询，点击泳道显示完整摘要和最终资源产物。桌面为泳道+执行详情双栏，窄屏自动上下排列。
- 后端原有 `steps_json` 已含五角色记录，但部分 running 状态只在网络调用结束后才写入。已修复：规划、检索、撰写、质检、仲裁在调用前立即持久化 running；异常时把当前运行步骤标为 failed；不再把任意异常错误地归到仲裁 Agent。
- 用户指出：“生成资源为什么要传这些，只需对应该章节的原文去做”。确认正确：课件资源属于单章节，生成时不应加载整库、切片或向量。`cwEvidence` 已改为仅使用当前章节原文，检索 Agent 的职责变成锁定/整理本章原文；彻底移除课件生成对 `kbSearch`/`kbLoadIndex` 的调用。
- 现场诊断：原任务 133bac40-5c19-49a3-a111-1d5f20f75d1a 在规划完成后持续 8-11 分钟卡在 `kbLoadIndex` 的全量查询；数据库 processlist 显示 `Sending to client`，目标是 9,529 个 chunks / 9,206 个向量 / 约 18MB，实际仅约 5-8 行/秒。它没有异常退出，但按该速度还会卡十几分钟，判定为功能性阻塞。
- 修复方式不丢记录：停止服务触发既有恢复逻辑，把 generating 自动改回 queued；仅使用本章原文的新构建重启后，该任务约 50 秒完成，状态 ready，步骤为规划 done、检索 done、撰写 done（2261 字）、质检 done（结构通过），仲裁无需返修。
- 验证：前端 Vite build 成功；后端 Cangjie build 成功；历史原生测试 8/8 通过，另补充 `coursewareEvidenceStaysInsideTheSourceChapter` 回归用例。真实 Chrome 已打开协作页，确认五条泳道、执行详情切换、完整 10 页教学幻灯片产物、课件库详情 icon 与返回路径正常。
- 当前后端 PID 88388/重启后以实际端口进程为准，8312；Vite 3006。功能、测试与本 TRACE 本地 Git 提交，不推送远端。

## 2026-10-21 11:15:24 +08:00 明确协作泳道入口与旧版核心面板对齐
- 用户进一步明确：参考源是 `git@github.com:AGI-FBHC/ITN-cj.git`，入口必须来自任务列表项目，通过详情 icon 进入对应资源生成泳道；不应另加侧栏一级入口。
- 已移除临时尝试的侧栏“协作泳道”入口与通用 Hub，不保留无关路由；在“课件管理 → 课件库”的资源标题旁放置明显详情 icon，任何状态（待发布、已发布、失败、生成中）都可点击进入该资源对应的协作页。
- 泳道页按 ITN-cj 的 `CollaborationWorkbench.tsx`、`CollaborationRounds`、`ExecutionDetailPanel` 核心结构对齐：顶部“本次协同路径”，中间“Agents 教研组协作泳道”，右侧独立“执行详情”面板，显示操作结论、原始 Agent 摘要和最终资源产物。使用当前紫色管理端视觉体系，没有引入旧仓库的依赖或运行框架。
- 实看通过：任务列表标题旁 icon 清楚可见，点击后 URL 进入对应 `coursewareId` 的 `/admin/courseware/{id}/collaboration`；五 Agent 状态、详情切换和完整 10 页幻灯片预览正常。前端生产构建通过。

## 2026-10-21 11:28:00 +08:00 从 ITN-cj 直接翻译并复用核心泳道组件
- 用户再次纠正：不是只按旧版外观自行重画，而是要复用 `AGI-FBHC/ITN-cj` 的核心前端面板。已定位实际本地克隆 `D:/Downloads/ITN-cj-analysis-20261020`（origin `https://github.com/AGI-FBHC/ITN-cj.git`，HEAD `8e9fdf5`），读取 `apps/web/src/pages/CollaborationWorkbench.tsx` 与 `apps/web/src/components/admin/ExecutionDetailPanel.tsx`。
- 新增 `CollaborationPanels.jsx`，将旧版 `CollaborationRounds`、`AgentWorkflowSummary`、`FlowLink`、`ExecutionDetailPanel` 及 JsonTree 的核心算法从 TypeScript/Tailwind 翻译到当前 React JSX/CSS。保留旧版的关键机制：五 Agent 固定列头、事件按时间向下推进、跨列贝塞尔数据流、仲裁返修轮标记、选择 Agent/事件联动、执行摘要和原始 JSON；图标与颜色适配当前紫色 UI。
- 当前 `steps_json` 结构与旧版事件流不同，因此在适配层将规划/检索/撰写/质检/仲裁步骤转换为统一的 workbench event；生成中第一个缺失步骤会显示当前执行 Agent，质检通过而未触发仲裁时补一条“无需返修”事件，避免路径缺项。
- 入口仍只来自课件库任务行的资源标题旁 detail icon，不加侧栏或全局页面入口；点击进入当前 `coursewareId` 对应泳道。浏览器实看确认事件卡片跨列连接、Agent 列头、右侧执行摘要、原始 JSON、产物预览正常。
- 验证：前端 Vite 生产构建通过；后端生成链路本阶段无改动。

## 2026-10-21 12:05:00 +08:00 PPT 专用生成链、真实产物与交付 Agent 泳道
- 对话重点：用户指出当前“PPT”仍只是 Markdown 卡片，要求复用 ITN-cj/Lumin 的专用 PPT 制作接口；同时明确可以把流程包装成泳道里的 Agent，但核心生成流程不能变，泳道只能观测，不得阻塞或重排规划、检索、撰写、质检、按需仲裁。
- 核对 ITN-cj 检出 `D:/Downloads/ITN-cj-analysis-20261020`（HEAD `8e9fdf5`）：`presentation_agent.cj` 由模型生成结构化演示提纲；`render_ppt.py`/`legacy_agent.py` 使用 `python-pptx` 生成真实可编辑 `.pptx`，同时写入 `.pptx.preview.html` 与 `.pptx.json`。因此本实现只迁移渲染与数据契约，不把 Markdown 内容冒充 PPT，也不改变现有五步内容生成链。
- 新增 `services/learning/renderer/ppt-renderer/`：复制并适配 Lumin 的 `render_ppt.py`、`legacy_agent.py`、`backgrounds.py`。该渲染器接收结构化 outline，输出真实 PPTX、16:9 网页预览和设计 JSON；页面预览来自同一份归一化提纲，自动章节页会同时进入 PPTX 与预览，避免候选页数误报。
- 新增 `services/learning/src/presentation_pipeline.cj`：`renderPresentationPptx()` 调用本地 Python 渲染器；解析渲染器返回的实际 `slides`/`notes` 数写回元数据；产物存放在 `data/presentations/{coursewareId}/presentation.pptx` 及同名 `.preview.html`、`.json`。启动脚本设置 `ZHIXUN_PROJECT_ROOT` 并显式指定工作目录，渲染器路径不再依赖从哪个目录启动后端，修复了此前路径重复拼接导致的 `python: can't open file ...`。
- `kb_courseware.cj` 将 slides 提示词升级为可直接交给演示渲染器的结构化 JSON：10 页分镜、封面/目录/结论固定、正文至少 5 种页面类型、每页结构化 points 与 100–220 字 speakerNotes；校验仍保留在质检和按需返修中。PPTX 渲染发生在原有审核通过之后，新增 `CW_ROLE_LAYOUT="排版"` 的观测步骤，先写 running 再渲染，成功后记录“实际页数、讲稿页数、设计 JSON 与网页预览已输出”。该步骤不调用模型、不改变提示词、审核顺序、队列或失败策略。
- 后端新增受 Bearer 会话保护的 `GET /api/presentation/{id}/download.pptx` 与 `/preview`；管理员可访问，学习者仅能访问已发布资源。`learning_resources.cj` 保留既有降级字段，同时公开 `presentation` 元数据；旧任务读取时从真实 `.json` 侧车回填实际页数和讲稿数，修复过期元数据把 15 页误显示为 10 页的问题。已移除 typed resources 的永久早退，确保既有课程再次读取时也会获得修正后的产物信息。
- 前端新增共享 `PresentationArtifact.jsx` 与 `presentation-artifact.css`，管理员预览和用户学习页都渲染真实 PPTX 网页预览，支持带会话鉴权下载真实文件。学习页只在 `remote.lesson.resources.slides.presentation` 存在时替换旧假幻灯片画布，继续保留原课程导航、右侧 AI 导师、语音提问、全屏、下载和章节完成；没有新产物时仍保留原有兼容展示。
- 泳道翻译面板扩展为六个 Agent：规划、检索、撰写、质检、仲裁、演示交付。演示交付只在 slides 产物上出现；非幻灯片资源显示“无需 PPT 排版”，历史已生成幻灯片根据现有预览补全交付状态。六列在现有双栏宽度内完整显示，窄屏横向滚动；协作页仍从课件库任务行详情 icon 进入，没有新增全局入口。
- 实际测试：`python-pptx` 可打开真实产物；测试任务 `38f167b9-e640-4f17-b1e0-a4435331fdef` 的 10 页结构化分镜经章节页归一化后得到 15 张实际幻灯片、15 页讲者备注；管理员课件页和协作页均显示真实排版，不再显示 Markdown 卡片。用户端临时发布后验证了 `01 / 15`、下载文件名、页数回填、AI 导师与完成按钮，随后立即取消该测试课件发布并恢复原有 `133bac40-...` 已发布状态。
- 验证记录：后端 `cjpm build -i -j1` 成功；原生 `cjpm test -j1` 10/10 通过，新增结构化演示稿必须包含封面/目录/结论且至少 5 类页面的回归用例；前端 `npm run build --prefix apps/web` 成功；健康检查返回 Cangjie 1.2.0 + Spire，后端 8312、Vite 3006 正常。构建仍有既有的 `mysql_client.cj`、`main.cj` 换行歧义警告和前端 bundle 大于 500KB 提示，不是本轮引入的功能错误。
- 本轮未推送远端，未操作 Docker；未改动用户画像结构。后续若再次生成 PPT，核心顺序应保持“规划 → 检索 → 撰写 → 质检 → 按需仲裁 → 已通过内容交给演示交付渲染”，泳道仅做状态观测与详情展示。

## 2026-10-21 13:20:00 +08:00 纠正 PPT 模板复用：补回旧版背景与旧版执行参数
- 用户指出前一版 PPT 不是旧系统的预设模板，并质疑生成流程被重新设计。该判断成立：上一版只迁移了 `backgrounds.py` 与 `legacy_agent.py`，却漏掉 `assets/presentation_backgrounds`；同时后端硬编码了 10 页 balanced 模式，因此视觉上退化成纯色布局。`backgrounds.py` 和 `legacy_agent.py` 的源文件哈希随后与原仓库一致，但缺少资产使模板能力实际失效。
- 已从 `D:/Downloads/ITN-cj-analysis-20261020/apps/desktop/shell/renderer/ppt-renderer/assets/presentation_backgrounds` 完整复制 10 套风格、59 个背景文件，共 7,121,503 字节：abstract-gradient、blue-conference、blue-white-minimal、business-gray、cartoon-doodle、clean-minimal、colorful-ink、morandi-blue-gray、sunset-mountains、watercolor。素材按旧版的标题、目录、正文用途目录保留。
- 课程资源默认参数已恢复为旧版 `useTopicResourceActions` 的课程链路：`clean-minimal`、12 页、detailed、16:9、template 模式。`ZHIXUN_PPT_BACKGROUND_STYLE` 可切换其余预设；非法值回退到旧课程默认 `clean-minimal`。renderer seed 改为 coursewareId，因此不同课件会稳定抽取不同背景，同一课件重渲染不会跳图。
- `kb_courseware.cj` 的幻灯片规划/撰写提示词已按旧 `PresentationAgent.outlinePrompt` 的核心执行规则恢复：封面、目录、总结固定，至少 3 个章节，系统自动插入章节页，正文强调不同页面类型、代码/案例/练习、120–240 字讲稿、课堂 quiz 与章节 summary。质检改为原目录 12 页，而不是上一版自造的 10 页。
- 网页预览现在读取与 PPTX 相同的背景资产并内嵌到 iframe；封面/目录/章节/正文按旧 `select_backgrounds` 角色取图，不再只显示纯色。渲染器返回的页数改为归一化后的真实页数，修复“结构 12 页、实际因章节页变成 16 页却仍显示 12”的统计问题。
- 代码页的 annotations 兼容旧模型常见的 `{line,text}` 对象，并在可见页渲染为“第 N 行：说明”，修复直接打印 Python dict 的问题。共享 PPT 组件明确显示“旧版模板 · 极简留白 / ITN Presentation Template”，管理员生成入口文案改为“12 页分镜 + 章节页”。
- 重新通过系统中的真实课件任务生成样张：`9d784c70-a888-4e40-b5ad-5867193e963f`。结构化分镜 12 页，自动插入 4 张章节页后实际 PPTX 16 页；用 `python-pptx` 复核为 16 页、16 页讲者备注；元数据记录 `clean-minimal` + `template`。导出 PDF/逐页图片人工检查，封面与正文使用旧版浅蓝留白背景，章节页使用旧包的柔和渐变模板，目录、表格、代码、练习与总结页版式正常。
- 对照图保存在忽略目录 `data/qa/old-template-9d/contact-sheet.jpg`，可逐页查看套用旧模板后的全部 16 页；样张在管理端为待发布状态，未覆盖用户原有已发布课件。
- 验证：前端 Vite build 成功；Python 三文件 `py_compile` 通过；仓颉原生测试 10/10 通过；后端构建和重启成功。原仓库已经确认本风格，后续 PPT 应继续使用该资产包和旧执行参数，不应重新发明模板或改成纯 Markdown/纯色卡片。

## 2026-10-21 13:38:00 +08:00 任务队列增加紧凑实时过程消息
- 用户要求在课件任务队列增加明确的“任务队列”入口，加载生成过程打印信息；只显示最新一条，不追加长日志、不占过多空间，并要求不能干扰正在执行的任务。
- 后端 `GET /api/admin/kb/courseware/queue` 仍为只读接口，不改变队列领取、并发或生成线程。查询增加 `steps_json`，按“生成中优先、更新时间倒序”返回最多 20 个活动任务，并为每项增加 `latestMessage`。
- `cwLatestQueueMessage()` 只解析 `steps_json` 的最后一步；优先显示 error，其次 summary，否则按 running/done 显示“正在执行/已完成”，统一加“角色 · ”前缀并截断到 180 字符。新排队任务显示“等待并发槽位”，刚启动且尚无步骤时显示“正在准备生成”。
- 管理端队列按钮由纯图标改为带“任务队列”文字的入口。弹层顶部新增单行“最新过程”，同时每个活动任务只显示一行最新 Agent 消息并使用省略号截断；最多展示 6 条活动任务，不保留历史追加日志。
- 队列仍沿用现有 3 秒轮询，只读取状态与步骤数据；不写数据库，不执行额外模型调用，不影响当前生成任务。新增原生回归用例 `queueFeedUsesOnlyTheLatestStepMessage`。
- 部署前再次查询数据库，确认 queued/generating 活动任务为 0 后才重启后端与前端。验证：仓颉测试 11/11 通过、后端构建成功、前端 Vite build 成功；浏览器确认队列入口文字、0/10 容量、最新过程区和空队列状态显示正常。

## 2026-10-21 13:48:00 +08:00 课件库增加组合筛选
- 用户要求在课件库增加筛选条件。实现为纯前端列表筛选，不新增请求、不改变数据、不触碰生成任务。
- 新增关键词搜索：匹配课件标题、资源类型名称、知识库标题、来源章节和错误信息；输入即时过滤。
- 新增资源类型筛选：全部、讲义文稿、实操指南、题库、教学幻灯片。
- 新增生成状态筛选：全部、排队中、生成中、已完成、生成失败。
- 新增上架状态筛选：全部、已发布、未发布；该条件与生成状态独立，可以组合使用。
- 筛选栏显示“当前结果 / 全部课件”数量，并提供“清除筛选”；无匹配结果时显示独立空状态和清除按钮，不误报“还没有课件”。桌面采用一行紧凑布局，窄屏自动两列/单列。
- 浏览器实测组合条件：教学幻灯片 + 未发布 + 关键词“初识”从 15 条中筛出 4 条，筛选数量与列表同步；筛选恢复后显示全部 15 条。前端生产构建通过。

## 2026-10-21 任务队列点击外部自动收起
- 用户要求任务队列展开后，鼠标点击页面其他位置自动关闭。
- 在 CoursewareQueueIndicator 为按钮和弹层的共同容器添加 ref；仅在展开时注册 document pointerdown 捕获监听，点击容器外关闭，内部点击保持展开，按钮仍支持再次点击收起。
- 增加 Escape 关闭并恢复按钮焦点；关闭或组件卸载时清理监听。onClose 使用稳定回调，避免队列轮询导致反复绑定。
- 仅修改前端弹层交互，没有改动后端、轮询频率、任务调度或生成过程，没有重启服务。
- 验证：npm run build --prefix apps/web 成功（既有 bundle-size 提示）；现有登录浏览器实测展开、点击内部最新过程保持展开、点击课件管理标题收起、Escape 收起均正常。
- 用户追加下一项要求：先给方案，课件库要方便管理员辨认来源知识库和章节，按知识库/章节筛选支持单选和多选，并可结合课件类型筛选；需优化页面。此项尚未修改代码。

## 2026-10-21 课件库来源筛选与生成参数配置
- 用户确认落地两项方案：课件库需要按知识库/章节与课件类型组合筛选，管理员要能快速辨认资源来源；生成课件时增加选填配置和默认值。
- 课件库筛选改为纯前端即时筛选，不增加列表请求，不影响生成任务。来源使用可搜索树形弹层：知识库可整包勾选，章节可单选/多选；课件类型改为多选标签；生成状态和上架状态收进“更多筛选”；顶部显示结果数、当前条件 chips 和一键清除。
- 列表按“知识库 → 来源章节”分组，组头显示知识库、章节序号/标题和资源数，可折叠。每行来源列显示知识库与章节原文；组头和行内“查看原文”都跳到知识库页并携带 `docId`，`AdminBundlePreview` 已支持从 query 参数定位正确章节。筛选状态写入 sessionStorage，离开页面再返回会恢复。
- 后端列表补充 `sourceOrder`（来自 `kb_bundle_docs.order_index + 1`）和任务 `options`；课件库只取元数据，不加载正文。为避免筛选因截断而不完整，列表上限从 100 调整为 1000，并加注释说明原因。
- 新增 `migrations/014_cw_generation_options.sql`：`kb_courseware.options_json MEDIUMTEXT NULL`，为追加式迁移，已只对 `itn_learning_v2_dev` 执行并核验字段存在；旧任务保持 NULL，前端展示历史默认值。
- 生成弹窗增加选填配置：讲义与实操指南分别保存详细程度（精简/标准/详细）；题库可选 5–20 题，默认 8；教学幻灯片可选 8–20 个结构页，默认 12；PPT 背景支持 10 套旧模板和系统默认，可选择是否生成讲者备注；底部共享最多 300 字补充说明。未展开/未修改时直接使用默认值，不改变快捷生成路径。
- 生成后端 `CwGenerationOptions` 统一校验并钳制数值，持久化每份任务的最终配置；规划、撰写提示词按对应资源详细度调整节数、步骤数和正文长度；质检按自定义题量、页数和讲稿开关校验；补充说明明确只能限定受众/范围/侧重点，不得覆盖本章原文事实或改变 JSON 结构。
- 注意并修正旧 PPT 渲染器的枚举差异：管理端使用 `standard`，旧 python-pptx 渲染器只接受 `balanced`，送渲染器前已映射，元数据仍记录管理端语义。PPT 背景缩略图从旧版 10 套资产各取一张复制到 `apps/web/public/presentation-backgrounds/`，界面以缩略图卡片选择，不手绘替代。
- 课件详情页新增“本次生成设置”卡片，展示详细程度或题量、PPT 页数/背景/讲稿开关和补充说明；历史任务无 options 时明确显示“历史任务，使用默认参数”。规划 Agent 的步骤摘要会带“已应用设置”，便于在协作泳道追溯。
- 修复本地启动脚本：`scripts/run-backend.ps1` 原先在 `services/learning` 下运行 main.exe，导致根目录 `data/presentations` 中的旧 PPT 预览 404；现在编译仍在服务目录执行，运行时固定切回项目根目录，已验证 PPT 预览接口 200。
- 验证记录：迁移执行成功；仓颉测试 12/12 通过（新增参数规范化、旧 detailLevel 兼容、数值钳制、无效 JSON 回退、standard→balanced 映射用例）；后端 Cangjie 构建成功；前端 Vite 构建成功（仍只有既有 bundle-size 警告）。浏览器实测来源单章/多章、类型多选、组合筛选数量、条件恢复、查看原文准确定位章节、生成弹窗各设置页与背景缩略图、详情设置展示、PPT iframe 预览恢复；未提交实际模型生成任务，避免产生无用内容或费用。测试时给样张临时写入的设置已恢复为 NULL，筛选已恢复默认。
- 当前运行：后端使用修正后的根目录启动方式，监听 8312；前端 Vite 监听 3006。下一步提交本地 Git，继续保留本轮交互结果页面供用户查看。

## 2026-10-21 知识库原文持久缓存与课件管理铺满布局
- 用户要求：课件管理中知识库上传后原文不变，目录/章节预览应使用浏览器缓存，删除知识库才清理相关缓存；追加截图指出两侧及底部空白过多，要求尽量铺满，不要使用固定 px 高度。两项一起完成。
- 工作仓库仍为 D:/Downloads/zhixun-yunshu-28801-20261020，分支 codex/native-learning-v1；开始前工作区干净。环境中的默认 cwd 是另一个 ITN worktree，本轮所有实际编辑、测试、提交均显式使用本地 3006 所服务的项目路径。
- 新增 apps/web/src/admin/bundle-preview-cache.js：IndexedDB 持久存储 + 最多 64 项内存工作集，按登录会话 SHA-256 摘要/知识库 ID/资源 ID 隔离；不保存令牌原文。重复、并发读取合并；刷新/跨页面访问可直接使用持久缓存；存储不可用或容量不足时回退正常 API 请求/内存缓存，不阻断使用。
- 缓存仅针对稳定的原文数据：课件管理新增 kbBundleSources 目录读取接口封装，只有原文整理完成 status=ready 才缓存目录；kbBundleDocument 统一复用原文缓存，知识库详情页也共享此缓存，移除其组件内重复 Map。发布状态、Logo 状态、任务队列、课件列表和上架章节仍从原接口实时读取，避免把动态元数据一起长期冻结。
- deleteKbBundle 在服务端删除成功后清理对应内存、磁盘缓存；删除失败不清缓存。成功获取知识库列表时对缓存 ID 做对账，清理其他页面/设备已删除的资料包缓存。失效版本号阻止删除期间迟到的原文响应重新回填缓存；删除不影响其他知识库/会话的缓存。摘要、向量、Logo 补全不清原文缓存；只有失败资料重新进入全文整理时才额外失效，以免保留未完成原文。
- 切换章节开始读取时清空上一章 doc，避免加载下一章失败后继续显示并误用旧正文。
- 采用现有 ui-ux-pro-max 布局指导，保留紫色视觉。AdminApp 为 /admin/courseware 主页面添加独立 workspace 类：主区随 100dvh，内层 flex 将标题/通知之外的剩余空间全部交给三栏；移除该页 max-width:1120px、底部 64px padding，以及原三栏 calc(100dvh - 208px)/min-height:460px 限制。
- 三栏改为弹性比例列，保留合理最小宽度，左侧知识库和中间章节、右侧正文各自滚动；两侧边距随窗口 clamp(12px,1.6vw,24px)。手机端恢复自然文档流，目录最大高度为 32dvh，无固定 px 内容高度，不影响其他管理页的原布局。
- 验证：node --test tests/bundle-preview-cache.test.mjs 5/5 通过，覆盖持久存储跨实例复用、会话隔离、并发去重、失败重试、未完成目录不缓存、删除期间请求迟到、远端删除对账和存储失效回退；前端 npm run build --prefix apps/web 成功，只有既有 bundle-size 提示。
- 在浏览器运行临时 QA 页面，直接调用真实 adminApi 并计数目录/原文 fetch：已访问章节跨新页面、整页刷新后的目录/原文请求数均为 0；真实 IndexedDB 合成测试确认持久化跨实例可读，删除后读取走新 loader。临时测试页已移除，未删除真实知识库或提交生成任务。
- 响应式真实页面 iframe 验证：1920x1080 下三栏宽约 1625、底部留白 24；390x844 下内容宽 343、底部留白 16；两者均无水平溢出。当前实际浏览器页面三栏同底，高度随窗口，默认窗口底部约 20px 留白；浏览器无 error 日志。所有临时 QA 标签已关闭，原课件管理标签保留。
- 本轮完全是前端缓存与布局，无数据库变更、无后端重启；生成流程和正在执行任务不受影响。功能及 trace 一并本地提交，未推送。

## 2026-10-21 学员端章节固定展示四种资源及未发布状态
- 用户要求：点击章节后始终出现四个学习选项，管理员没有发布的对应资源显示灰色并注明“暂未发布”。
- 核对既有链路：LearnerResources.jsx 已定义 lecture/guide/slides/bank 及学习模式 lecture/guide/presentation/quiz；后端 learning_resources.cj 的 lrAvailability/lrAvailableKinds 对受管理的章节仅以 status=ready 且 published=1 的资源生成 resourceTypes。本轮无需后端或数据库变更。
- 修改 RecoveredApp.jsx 的 LessonStartModal：移除过滤未发布资源的逻辑，改为固定遍历四种资源；根据当前章节 resourceTypes 判断按钮 available。未发布按钮使用原生 disabled、灰色样式及“暂未发布”徽标，不触发模式选择；已发布继续跳转原有对应学习模式。只有一种已发布资源时仍保留该项的紫色突出显示；四项全未发布时全部禁用并显示原有提示。
- lesson-start-modal.css 新增禁用态文字/图标/底色/鼠标样式，hover 样式仅用于启用按钮。保留原有弹窗布局、滚动、Esc 关闭和键盘焦点循环；禁用按钮自然从 Tab 顺序排除。
- LessonStartModal 增加 named export，用于在临时 Vite 验证页直接挂载真实组件，免于更改实际用户、课程和发布数据。
- 验证：前端 Vite production build 通过（既有 bundle-size 警告）；真实浏览器挂载验证仅发布 guide 时固定四项、三个按钮 disabled 且显示“暂未发布”，guide 选择返回正确模式；全部发布时四项启用，讲义/幻灯片/测验分别返回 lecture/presentation/quiz，guide 模式亦验证；全部未发布时四项均禁用并显示本章提示。实看灰色徽标和紫色已发布选项正常，临时验证页与标签已删除/关闭，用户端首页保持正常。未执行真实课件发布/下架或生成操作，未重启后端。
- 功能更新与本条 TRACE 一起本地提交，未推送远端。

## 2026-10-21 紧急修复学习进度空页面返回管理员登录
- 用户在忘记密码功能开发过程中追加：在“暂无进度明细”页面点击返回竟回到管理员登录，需要优先修复。忘记密码任务保留继续，未取消。
- 定位 RecoveredApp.jsx：LearningProgress 在新知识库课程没有旧版固定进度图时直接返回全屏纯文案，没有 AppNavigation 或站内返回入口；Dashboard 的标签切换全部是 useState，不产生浏览器历史，所以浏览器返回会跨出学习界面到之前访问过的管理员登录页。
- 修复空状态保留学习端 AppNavigation，补“查看课程”和“返回学习首页”明确入口；使用 onNavigate 跳转学习端，不读取来源页面或通用 history.back。
- Dashboard 标签状态改为 React Router location.state.learnerView，每次实际切换通过 navigate 记录一条站内历史，相同标签不重复压栈。浏览器返回/前进会恢复对应学习标签。Home 在已有学习会话且 bootstrap 返回画像时恢复 Dashboard，避免从独立 /progress 返回 / 后丢失当前学习页面。
- 真实浏览器验证：直接访问 /progress 显示学习端导航与返回按钮；“返回学习首页”回到 / 的个人档案/课程学习页；从该页点击“学习进度”后使用浏览器 back，回到学习首页且没有进入 /admin/login。构建通过，浏览器没有错误。
- 本条修复及 trace 单独提交，忘记密码的其他未提交文件保留继续开发；无数据库操作或服务重启。

## 2026-10-21 登录页忘记密码与邮箱验证码重置
- 用户先要求登录页增加“忘记密码”，期间追加“暂无进度明细返回到管理员登录”问题。返回问题已优先单独修复并提交 6fdc111；本条继续完成原忘记密码请求。
- 新增 ForgotPasswordForm.jsx，沿用当前紫色登录页：注册邮箱、6 位邮箱验证码、新密码与确认密码；发送后显示 60 秒倒计时；校验邮箱/验证码/密码长度/两次密码一致；重置成功清空敏感输入、回到账号登录、预填邮箱并显示成功提示，不自动跳管理端。LoginPage 在非注册状态增加“忘记密码？”入口；找回视图隐藏登录方式/注册切换。
- 复用原生仓颉 SMTP 发送链和现有 email_verification_codes，新增 RESET_PASSWORD 用途，摘要包含 purpose，与 LOGIN 验证码严格隔离；验证码 5 分钟有效、60 秒重发限制；重置邮件主题/正文标明密码重置。未注册邮箱统一提示，不创建账号，也不会实际发送测试邮件。
- 新增追加式迁移 015_password_reset.sql，仅为验证码表增加 failed_attempts INT NOT NULL DEFAULT 0；已只应用于 itn_learning_v2_dev。密码重置每个验证码最多 5 次失败，过期、已消费或锁定均拒绝；只有最新一条重置验证码可使用，不能回退到旧验证码。
- 新增 POST /api/auth/reset-password 与 password_reset.cj。使用独立 MySQL 连接和 SELECT FOR UPDATE，把验证码核验/尝试次数、随机盐密码更新、消耗 LOGIN/RESET_PASSWORD 尚有效凭证、撤销该账号全部旧会话放在事务中；并发重复提交只能成功一次。保留用户 ID、机构、角色、画像和学习记录。支持此前仅通过邮箱验证码登录、尚无密码的既有账号设置密码。
- 当前用户模型只有 login_key，没有工号与邮箱的绑定字段，因此找回入口明确提示工号账号需联系机构管理员；不把用户自行填写的邮箱当作工号账号所有权证明。没有修改管理员默认账号或用户原密码。
- 收紧 validEmail 的 ASCII 控制字符/多 @ 检查以防邮件头换行注入。新增 validVerificationCode 保留前导零并只接受 6 个数字。现有 LOGIN 发码仍使用默认用途，保持兼容。
- 测试：新增原生验证码格式/用途摘要隔离/邮件主题回归用例，cjpm test -j1 13/13 通过；后端 cjpm build -i -j1 -o main-next 成功；Vite 前端构建通过，只有既有换行与 bundle-size 提示。
- 新增 tests/test_password_reset.py，使用唯一临时用户和人工预置验证码，不发外部邮件，不触碰真实账号：验证旧密码失效、新密码可登录、旧会话全部失效、旧登录验证码失效、已使用验证码不能重放、过期与错误用途拒绝、5 次错误锁定、非法输入和发码冷却、未注册邮箱不创建账号、两个并发重置只有一次成功、邮箱无密码账号设置密码。5 项接口用例均已通过；部署后首个测试遇到服务尚未开始监听的连接拒绝，健康就绪后单独重跑该项通过，其余项在部署版本通过。
- 浏览器实看 /login 忘记密码入口、完整表单和当前样式；用合成输入验证两次密码不一致会原地提示且不提交后端，返回登录正常。未通过 GUI 提交真实账号密码修改，未向真实邮箱发送测试邮件。
- 部署前两次只读核对 queued/generating=0，先旁路编译 main-next.exe，再校验当前监听进程是该项目 main.exe 后替换启动，减少停机。当前后端 PID 149484，8312 健康返回 Cangjie 1.2.0 + Spire。期间发现原 Vite 3006 已无监听，已恢复原端口的本地 Vite（PID 40664）；前后端均已验证可访问。未使用 Docker、未推送。
- 源码、迁移、测试与本条 TRACE 一并本地提交；登录页可通过 /login 直接进入查看。

## 2026-10-21 资源生命周期、品牌分层、课程 Logo 上传、默认头像与资料页收尾
- 用户本批需求：①学员端章节序号默认 18 个并在末尾加号顺延；②生成课件每个章节每种资源同时只保留一个，已有资源要有提示标记，重新生成前提示下架并清空该资源对应的学员记录；③机构设置不要直接把管理员端的 logo 和名称替换成机构简称，管理端保持系统 logo，学员端用机构 logo + 系统名"智训云枢" + 机构简称标签（窄屏隐藏标签）；④课程 Logo 除 Agent 生成外支持自定义上传，非正方形按中心裁最大正方形并压缩，不保存原图；⑤把 D:\Desktop\mojofamily 的图片移入项目并用于美化登录页；⑥登录页与首页加 Powered by Cangjie 标注；⑦新用户默认头像从这批角色图随机分配，并随机莫兰迪背景色；⑧编辑资料后右上角头像要更新、点击右上角头像进入编辑资料；⑨基本信息仅姓名必填、移除邮箱填写、头像下文案由"学习者"改为"学员"。用户要求尽快完成并尽量并行。
- 仓库仍为 D:/Downloads/zhixun-yunshu-28801-20261020，分支 codex/native-learning-v1。本轮开始前该工作区已有一批未提交的进行中改动（资源生命周期、Logo 上传、登录页角色图、品牌文案），本轮先核对完成度再补齐与提交，未重做已完成部分。
- 章节序号：管理端发布弹窗序号槽位默认由 12 提到 18（orderSlotCount 初始 18），末尾新增"＋ 添加序号"按钮，点击后增加下一个序号槽并把加号顺延到新槽之后；打开发布弹窗时会按已有章节最大序号自动抬高槽位；发布时仍保留"序号已被占用"校验。
- 资源唯一性：migration 016 给 kb_courseware 增加 is_current/generation 并新建 lesson_resource_progress；migration 017 增加唯一索引 uk_courseware_current(doc_id,kind,is_current)，is_current=NULL 表示历史归档行（MySQL 唯一索引允许多个 NULL）。tools/backfill-courseware-current.py 已在本库执行，按"已发布优先、ready 优先、更新时间倒序"每组 章节×类型 保留一条 current，其余置 NULL，不删除数据；已核对唯一索引存在、无真实重复 current。用户重要已发布课件 133bac40-5c19-49a3-a111-1d5f20f75d1a 保持 is_current=1、published=1 未受影响。
- 生成弹窗与重新生成：四类资源在弹窗内固定展示，已有资源显示"已发布 · 可重新生成 / 已生成 · 可重新生成 / 生成失败 · 可重试 / 生成任务进行中"；正在排队或生成的类型禁止再次勾选；勾选已有资源提交时弹出确认，明确"将立即下架该资源并清空对应的学员学习、测验和书签记录，其他资源与章节不受影响，生成完成后需重新发布"。提交带 replaceExisting 与 expectedGenerations 做乐观并发校验，序号或版本冲突返回 409 并刷新列表。
- 记录清理与版本失效：lesson_resource_progress 以 user/course/lesson/kind 为主键并记录 generation；学习接口按当前 generation 校验，资源重新生成上架后旧版本进度自然失效，客户端带旧版本提交会收到 409 提示刷新。下架时按 kind 清理对应进度、测验（bank）与书签，并回算 lesson_progress 的已读/完成/分数，避免残留假进度。
- 品牌分层：BrandLogo 不再拉取机构 Logo，管理端始终用系统 logo；新增 BrandText（智训云枢 + 机构简称标签，1024px 以下隐藏标签），学员端导航、页脚、登录页共用；document.title 固定为"智训云枢"；main.jsx 仅在非 /admin 路由加载机构品牌，管理端不请求机构信息。管理端"机构设置"仍可编辑机构资料。
- 课程 Logo 上传：新增 POST /api/admin/kb/bundles/{id}/logo，接受 PNG/JPEG/WebP/GIF，最大 8MB；后端通过 renderer/course-logo/normalize_logo.py 居中裁最大正方形、压缩为 WebP 再包成 SVG data URI 入库，不保存用户原图；kb_delivery 的 CSP 放开 img-src data: 以便显示内嵌图。管理端 Logo 卡片增加"上传 Logo"、当前 Logo 预览与说明；上传/生成均写 logo_generations 记录。
- 登录页与首页：mojofamily 图片已压缩为 21 张透明 WebP 放入 apps/web/public/login-characters/（原文件夹已清空，保留项目内资源）；登录页左侧用其中 9 张做装饰并加说明气泡，底部加 Powered by Cangjie 徽标；学员首页导航右侧同样加该徽标（窄屏隐藏）。
- 默认头像与莫兰迪背景：后端按 user id 稳定散列从 21 张角色图选一张作为默认头像，并从 10 个莫兰迪色中稳定选一个背景色；注册、邮箱首次登录、游客创建和读取已有空头像资料时都会补全，刷新不会变色；用户自行上传头像后不再覆盖。
- 资料页：saveProfile 成功后立即更新 learning 快照，右上角头像同步刷新；右上角头像改为按钮，点击进入编辑资料；基本信息仅姓名必填（性别、手机号去掉必填与星号），邮箱字段移除并改为"邮箱或工号是注册时的登录账号，无需在此重复填写"的说明；头像下文案改为"学员"；头像上传支持 JPG/PNG/WebP 并在前端压缩。
- 验证：前端 npm run build 通过（仅既有 bundle-size 警告）；后端服务健康 200（Cangjie 1.2.0 + Spire，itn_learning_v2_dev）；数据库 016/017 已应用且唯一索引存在；上传 Logo 路由存在（未授权返回 401）；21 张头像资源齐全且 http://localhost:3006/login-characters/strawberry.webp 返回 200 image/webp；本轮未跑真实模型生成任务，未改动用户已发布课件数据。
- 运行状态：后端 main.exe（8312）与前端 Vite（3006）均在运行；后端源码最后修改时间早于 17:00 的构建，运行中的二进制已包含本轮后端改动。
- 资料页补充（头像不同步的根因与端到端实测）：此前"编辑资料后右上角头像不更新"的直接原因是 PUT /api/profile 的 64KB 体积上限——前端把头像原图直接转 data URL 提交，0.55MB 图片约 73 万字符、5MB 图片约 700 万字符，后端返回 413 个人资料内容过长；而 Dashboard 的 onSave 用 .catch(() => undefined) 静默吞掉了错误，learning 快照从未更新，界面看起来像"保存了但头像没变"。已用 PUT /api/profile 实测确认：大头像 413、小头像 200。
- 修复：新增 zxAvatarDataUrl()，先中心裁最大正方形，再按 webp(512/384) → jpeg(384/256/192) 逐档降级编码，把头像控制在 36000 字符以内（浏览器不支持 webp 编码时自动落到 jpeg）；编辑器提交改为返回 Promise，失败时在保存按钮左侧以 role=alert 显示真实原因（含"头像或资料内容过大，请更换更小的头像图片"兜底），成功才由父组件更新本地画像并关闭编辑器；头像区文案改为"支持 JPG、PNG、WebP，大小不超过 5MB，将自动压缩为正方形"，accept 同步加入 image/webp。
- 真实浏览器端到端验证（隐藏的 in-app 浏览器标签，验证后已关闭）：游客进入学员端 → 点击右上角头像直接打开编辑资料（此前 onNavigate 白名单里没有 "profile"，点击无反应）；编辑页只保留姓名的必填星号，性别/出生日期/所在地区/手机号均无星号，邮箱输入框已替换为"邮箱或工号是注册时的登录账号…"说明，头像下文案为"学员"；上传 0.55MB / 2400x1600 PNG 后预览被压缩为 30015 字符的 data:image/jpeg；保存后编辑器关闭、右上角头像立即变为新图；整页刷新后头像仍为新图（确认已写入 profile_json）；在编辑器内点击"课程"可正常退出编辑器并切换页面。
- 验证补充：提交状态下再跑 npm run build --prefix apps/web 通过（仅既有 bundle-size 警告）。测试图片 data/qa/avatar-upload-test.png 位于 gitignore 覆盖的 data/ 目录，未进入版本库。

## 2026-10-21 最终收尾：头像菜单、默认头像、Cangjie 标识与资源去重
- 用户要求右上角头像先弹菜单，提供“编辑资料”和“退出登录”；同时新用户默认头像从 mojofamily 角色图随机稳定分配，并随机使用莫兰迪背景色。
- 已实现头像菜单：点击头像不再直接进入资料页，菜单含编辑资料、退出登录；编辑资料进入现有 ProfileEditor，退出登录清除学习会话令牌/显示名并回到登录页；支持点击外部和 Escape 收起。保存资料通过 useLearning 快照立即刷新头像。
- 默认头像：后端按用户 ID 稳定选择 `/login-characters/*.webp`，同时生成稳定莫兰迪 `avatarBackground`；账号注册、邮箱首次登录、游客和无头像资料在 PUT /profile 时补齐，刷新不变色。用户自行上传头像不会被覆盖。
- mojofamily 21 张透明 PNG 已移动到项目 `data/imports/mojofamily-originals`，并压缩为 21 张 WebP 放在 `apps/web/public/login-characters`；登录页左侧使用角色图装饰，登录页、学员首页/导航显示 Powered by Cangjie。原文件夹已清空。
- 修复课件唯一性查询：归档行 is_current=NULL，之前 `COALESCE(is_current,1)` 会把归档行误判为当前版本；现改为只查 `is_current=1`。数据库 016/017 迁移已执行并回填，当前列表 9 条，无重复章节/资源组合。
- 验证：Cangjie 测试 14/14 通过；后端 main-next 构建成功并已替换运行（8312 健康）；Vite 构建成功；浏览器确认头像菜单、登录页角色图、Powered by Cangjie、课件库 9 条无重复、序号默认 18+“＋”。原图片目录保留为空目录，原文件已移入项目数据目录，未删除内容。

## 2026-10-21 Markdown/Mermaid 渲染与课件库精简
- Markdown 渲染修复：识别普通 fenced code 的语言标记；对 `mermaid` 围栏以及被外层 code fence 包裹的嵌套 Mermaid 代码块提取并异步渲染为 SVG，普通代码继续按代码块显示，渲染失败回退为代码。新增 mermaid 依赖，构建生成独立异步 chunk。
- 课件库精简：移除重复“来源章节”列，来源信息收进课件标题下方；状态、更新时间、操作列对齐居中/右对齐；失败错误改为单行省略并保留完整 title；操作按钮压缩为预览、撤回/发布、删除。
- 浏览器验证：课件库显示 9 条且无重复组合；简化表格对齐正常；Mermaid 页面生成 2 个 SVG；Vite 构建通过（既有 bundle 警告）。后端本轮无新改动，8312 保持健康。
- 本轮改动单独本地提交，未推送。
