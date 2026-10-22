# 项目结构（智训云枢 · ITN 学员平台）

面向交付的仓库结构说明。前端 React + Vite，后端仓颉 1.2.0 + Spire，数据库 MySQL 8+。

```
ITN-cj/
├─ apps/web/                        前端
│  ├─ src/                          页面与组件
│  │  ├─ RecoveredApp.jsx           学员端主应用（首页/课程/收藏夹/Agent/我的画像）
│  │  ├─ LoginPage.jsx              登录注册（邮箱、验证码、游客、管理员入口）
│  │  ├─ TutorChat.jsx              Lumin 对话（课程侧栏 + Agent 页共用）
│  │  ├─ learning-api.jsx           学习端 API 客户端（会话/画像/计划）
│  │  ├─ learning-plan.jsx/.css     学习计划面板（Agent 真实生成）
│  │  ├─ HomeLearningWidgets.jsx    首页学习活跃网格 + 热门资源榜
│  │  ├─ admin/                     管理端（知识库、课件、模型配置、机构设置、邀请码）
│  │  └─ *.css                      各模块样式
│  ├─ public/                       静态资源（品牌 Logo/favicon、课程封面、登录角色、PPT 背景）
│  ├─ tests/                        前端 Node 测试
│  └─ index.html · vite.config.js · package.json
├─ services/learning/               后端（单体 HTTP 服务）
│  ├─ src/                          仓颉源码
│  │  ├─ main.cj                    路由与服务装配
│  │  ├─ mysql_client.cj            原生 MySQL 驱动
│  │  ├─ kb_*.cj                    知识库：入库/切片/向量/课件/Logo/上传
│  │  ├─ presentation_*.cj          PPT 生成流水线与质量检查
│  │  ├─ tutor_*.cj · llm_http.cj   Lumin Agent（工具调用、SSE、Tavily 检索）
│  │  ├─ learner_memory.cj          学习画像记忆
│  │  ├─ learner_plan.cj            学习计划真实生成（本轮新增）
│  │  ├─ org_onboarding.cj          机构问卷与邀请
│  │  └─ learning_activity.cj       学习活跃与热门资源
│  ├─ migrations/                   001–025 数据库迁移（按编号顺序执行）
│  ├─ renderer/                     Python 渲染器
│  │  ├─ ppt-renderer/              PPTX 渲染 + 预览（python-pptx / Pillow）+ 背景素材
│  │  └─ course-logo/               Logo 归一化
│  ├─ schema.sql · cjpm.toml · cjpm.lock
│  └─ target/                       （忽略）构建产物
├─ tests/                           跨层测试（Python HTTP + Node 单测）
├─ scripts/                         本地开发脚本（构建/启动/建管理员/本地 MySQL）
├─ docs/                            设计、部署与接手文档
│  ├─ deploy-6024.md                113.249.102.41:6024 部署手册
│  ├─ LUMIN_AGENT_PLAN.md · chat-multimodal-plan.md · org-invites-plan.md
│  └─ PROJECT_STRUCTURE.md          本文件
├─ fixtures/                        课程目录样例数据
├─ tools/                           运维脚本（schema、导入导出、审计）
├─ analysis/                        设计参考截图与审计 JSON（资料）
├─ deployed/                        旧版静态预览快照（历史产物，可另行清理）
├─ README.md                        项目说明与启动方式
├─ TRACE.md                         全量变更与跨会话接手记录（重要）
├─ INTEGRATION_PLAN.md · SYNC_PLAN.md
└─ nginx-28801.conf · preview_server.py · SHA256SUMS.txt
```

## 不进仓库的内容（.gitignore）

`.env.local`、`data/`（本地 MySQL、上传件、PPT、备份、部署脚本）、`node_modules/`、`apps/web/dist/`、`services/learning/target/`、`*.log`。

## 分支与发布约定

- 开发分支：`itn-lite`（远端同名分支，2026-10-22 由 `lite` 更名）。
- 远端 `AGI-FBHC/ITN-cj` 已有 `main`、`cangjie-integration`、`desktop`、`front`、`full`、`itn-pro`、`yjyprojects` 等分支；本仓库推送为**独立分支**，不覆盖既有分支。
- 本地构建：`scripts/build-backend.ps1`（仓颉）、`npm run build --prefix apps/web`（前端）。
- 上线：见 `docs/deploy-6024.md`。
