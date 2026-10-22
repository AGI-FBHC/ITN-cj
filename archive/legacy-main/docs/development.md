# 开发与验证

## 选择组件

- 网页界面：[Web README](../apps/web/README.md)。
- 本地桌面应用：[Desktop README](../apps/desktop/README.md)。
- 数据 API 与转发：[API README](../services/api/README.md)。
- 账号与业务接口：[业务服务 README](../services/business/README.md)。
- Linux Web 部署：[部署说明](../deploy/web/README.md)。

先进入对应组件，再运行 `cjpm build` 或 `npm run dev`。Web 服务端和 Desktop 使用不同版本的 SDK，环境变量只设置到对应构建会话。

## 验证范围

Web 界面变更运行对应回归测试与生产构建；当前 `tsc -b` 的既有错误仍需单独修复。服务端改动按组件构建并检查受影响接口，数据库测试先确认目标环境。

Desktop 内核变更运行 `core` 的仓颉单测，并针对受影响路径执行独立数据目录下的检查；应用打包还需要检查运行库与预览依赖。mock 检查验证约定和链路，真实模型能力需要另外验证。

移动目录后检查引用路径、脚本相对路径和构建产物，避免只确认文件存在。Desktop 的协作与测试要求见 [apps/desktop/AGENTS.md](../apps/desktop/AGENTS.md)。

## Git 与操作记录

`main` 保存本仓库的集成源码，各组件目录与源码来源见根 README。功能更新保留本地 Git 提交；发布前完成相应检查。

新操作统一追加根目录 [TRACE.md](../TRACE.md)，包含用户要求、范围、提交、验证和未完成事项。各端导入时已有的 TRACE 保留为历史档案。
