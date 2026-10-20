# 前后端同步计划

## 当前约束
- 用户已授权实现，并要求前后端子agent并行。**不用Docker，允许仓颉1.2.0**，Spire原生服务。
- 保持当前28801页面视觉和交互；只做微调与加法。原样对照在3005，开发版在3006，Cangjie API在8312。
- 原始TSX丢失，已从构建产物静态恢复可编辑React模块`apps/web/src/RecoveredApp.jsx`；没有执行原包来生成源码，原始deployed目录保持不变。
- 首版实现建档、课程/课时内容、测验、书签/收藏、进度持久化。复杂审批、互评、自动返修、Python/Java服务不进入新系统。

## 分工和文件边界
- frontend：`apps/web/**`，保持原页面；接入下面接口，修复错误状态与刷新恢复，不改后台。
- backend：`services/learning/**`、`scripts/backend*`、`tests/backend*`；仓颉1.2+Spire+MySQL，复用旧原生协议客户端，不依赖Docker。
- root：`tools/**`、`scripts/seed*`、课程数据导入、共享计划、TRACE、集成验收。root准备隔离开发库和不入Git的连接配置。
- 先按本契约实现，字段新增兼容；修改契约必须通知其他开发者。每个阶段本地Git提交，root统一追加TRACE。

## API约定（/api，JSON；失败非2xx且返回message）
- `GET /health`：运行状态。
- `POST /session`：创建独立访客学习账号，返回`{token,userId,profile}`。前端只在没有token时调用；后续Authorization: Bearer token。没有真实账号密码表单要求，不冒充正式注册登录。
- `GET /bootstrap`：`{profile,courses,favorites,bookmarks,stats,recent}`。profile初始null，填写问卷后保存。courses沿用原UI：`{id,name,icon,description,level,duration,chapters:[{title,done}]}`，可增加sourceLabel。
- `PUT /profile`：完整问卷/个人资料对象，返回保存后的profile（前端原有shape保留）。
- `GET /courses`：`{courses:[...]}`；带token时包含个人进度。
- `GET /courses/{courseId}/lessons/{lessonIndex}`：`{courseId,lessonIndex,title,content,questions,sources,progress}`。content是结构化内容（前端做适配），questions不含correct/answer。前端保留原讲义/PPT样式；内容缺失显示明确状态。
- `PUT /courses/{courseId}/lessons/{lessonIndex}/progress`：`{read:true}`，保存阅读状态，不由客户端直接写分数或completed。
- `POST /courses/{courseId}/lessons/{lessonIndex}/answer`：`{questionId,choice}`，返回`{correct,correctIndex,explanation}`，服务器判定。选项索引从0开始。
- `POST /courses/{courseId}/lessons/{lessonIndex}/quiz`：`{attemptId,answers:[{questionId,choice}],durationSeconds}`，服务器重算并保存，返回`{score,correctCount,total,completed}`；同attemptId重试不重复增加记录，完成规则score>=60。
- `PUT /state`：`{favorites:[courseId],bookmarks:[原前端片段书签对象]}`，仅覆盖当前用户，返回保存状态。

## 隔离开发库（root创建，旧itn_cangjie_dev不写入）
数据库名`itn_learning_v2_dev`，连接变量`ZHIXUN_DB_HOST/PORT/USER/PASSWORD/NAME`在本地`.env.local`，禁止打印密码/提交Git。

最小表结构由backend负责DDL文件，root按该文件初始化并填充课程：
- `users(id CHAR(36) PK, profile_json JSON NULL, created_at DATETIME(6))`
- `user_sessions(token_hash CHAR(64) PK, user_id CHAR(36), expires_at DATETIME(6))`
- `courses(id VARCHAR(40) PK, name VARCHAR(160), icon VARCHAR(255), description TEXT, level VARCHAR(40), duration INT, chapters_json JSON, source_label VARCHAR(100))`
- `lessons(course_id VARCHAR(40), lesson_index INT, title VARCHAR(200), content_json JSON, quiz_json JSON, sources_json JSON, PRIMARY KEY(course_id,lesson_index))`
- `lesson_progress(user_id CHAR(36),course_id VARCHAR(40),lesson_index INT,is_read TINYINT,score INT NULL,completed TINYINT,updated_at DATETIME(6),PRIMARY KEY(user_id,course_id,lesson_index))`
- `quiz_attempts(id VARCHAR(64) PK,user_id CHAR(36),course_id VARCHAR(40),lesson_index INT,answers_json JSON,score INT,duration_seconds INT,created_at DATETIME(6))`
- `user_state(user_id CHAR(36) PK,favorites_json JSON,bookmarks_json JSON,updated_at DATETIME(6))`

quiz_json保存标准化题目：`[{id,question,options:[string],correct:0,explanation,theoryTitle}]`。仅答题接口披露当前题答案。
content_json沿用原阅读内容结构；root会提供`data/catalog-seed.json`，并优先把可用Agent内容与来源导入，原计算机四课示例需注明来源性质。

## 当前验证
- 本机Cangjie1.2.0与Spire构建已通过；原生main.exe在8312的/api/health返回200。
- 恢复React代码的3006首页已用真实浏览器确认，显示与原首页一致。
- 业务接口已实现；隔离库已初始化为5课程24课时，并导入33份公开讲义与28份公共题目。
- `node --test tests/learning-flow.test.mjs` 全部7项通过；账号隔离、服务端判分、幂等测验、收藏和书签持久化均已验证。
- 浏览器已验证：建档、首页真实课程、仓颉讲义、3题测验、刷新恢复档案/进度/收藏；页面无控制台错误。
- `npm run build`通过。使用一条进程内复用的MySQL连接，开发环境首页请求约0.7秒。
- 遗留：管理员端、AI导师、其余四门课正式内容、生产库迁移和Linux部署尚未完成。
