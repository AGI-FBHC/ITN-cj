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
