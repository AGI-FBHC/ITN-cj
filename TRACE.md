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

### 未完成与限制
- 管理端暂不支持课时重排序、批量导入旧库 545 条资源、图片/附件上传、AI 生成与教研工作台。
- 用户列表只返回最新 200 个账号并在前端筛选，尚未做服务端搜索与分页。
- 管理端与学习端共用同一个仓颉服务实例和单连接数据库访问；正式多人部署应改为连接池。
- 未部署到 43.160.236.121，也未替换 28801 线上页面。
