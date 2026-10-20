# 智训云枢

当前用户端以 28801 线上页面为基线，使用 React/Vite；学习服务使用仓颉
1.2.0 + Spire。开发环境不使用 Docker。

## 启动

分别打开两个 PowerShell 7 终端：

```powershell
.\scripts\run-backend.ps1
.\scripts\run-frontend.ps1
```

浏览器打开 `http://localhost:3006/`。停止时在终端按 `Ctrl+C`。

数据库连接只从项目根目录已忽略的 `.env.local` 读取。后端启动时会拒绝连接
`itn_learning_v2_dev` 以外的数据库。

## 已验证范围

- 自动建立独立访客学习账号，不共享其他用户的数据。
- 建档、课程目录、课时阅读、服务端判题、测验提交、课程进度。
- 课程收藏与片段书签刷新后恢复。
- 5 门课程、24 个课时。Agent 课程复用了隔离开发库中的公开讲义和题目；
  其余计算机基础课程是已标注来源的演示内容。
- 界面保持原页面结构，增加加载失败重试与同步状态提示。

AI 导师和管理员端尚未接入；当前 AI 入口会明确显示服务未接入。

## 目录

- `apps/web/`：可从构建产物恢复的开发前端。
- `services/learning/`：原生仓颉学习后端。
- `schema.sql`：隔离开发库结构，位于 `services/learning/schema.sql`。
- `tools/`、`scripts/`：静态源码恢复、课程导入和启动脚本。
- `deployed/`：线上发布产物原件，保持逐字节不变。
- `TRACE.md`：跨会话操作记录。

## 原始页面

要查看未修改的 28801 线上产物：

```powershell
python preview_server.py --port 3005
```

浏览器打开 `http://localhost:3005/`。
