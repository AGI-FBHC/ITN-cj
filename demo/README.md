# Agent 演示

演示相关的启动、预检和录制/回放都在这里。正式演示前按下面顺序走。

## 1. 启动

```powershell
cd F:\cangjieDesk\ITN-cj
.\demo\run-demo.ps1
```

默认使用开发态（`dist\core` + `shell\renderer`）和隔离 profile `demo\profile`。
要跑已打包版本：

```powershell
.\demo\run-demo.ps1 -Packaged
```

## 2. 准备演示环境

打开「设置 → 智能体 → 演示模式」，点“准备演示环境”。它会：

- 在 profile 旁边创建 `lumin-demo-workspace-<profile>`（不在数据目录内，避免被沙箱当成保护目录）；
- 放入 `README.md`、`notes\RAG-学习笔记.md`、`notes\检索实验记录.md`；
- 把工作目录指过去；
- 权限设为“请求批准”、打开命令执行；
- 清空已记住的审批规则（否则彩排时点过“总是允许”，正式演示就不弹卡了）。

## 3. 预检

```powershell
.\tools\agent-demo-preflight.ps1
```

检查内核、模型、工具调用能力、知识库、演示工作区、命令执行、审批规则。
有 FAIL 就不要开场；WARN 按脚本提示处理。

## 4. 录制 / 回放（断网兜底）

录制一场：

```powershell
.\demo\run-demo.ps1 -Record
```

素材写到 `demo\recordings\agent-*.jsonl`（已 gitignore，可能含知识库内容，不要直接提交）。

断网回放：

```powershell
.\demo\run-demo.ps1 -Replay .\demo\recordings\agent-xxxx.jsonl
```

回放只固定模型侧；工具仍在本机真实执行，所以演示的仍是 Agent，不是录像。

限制：多智能体子任务会另建模型请求，目前不在主链路的录制/回放素材里。
离线演示请用单 Agent 剧本（检索、审批、失败恢复）；要演示协作树，保留网络和真实模型。

## 5. 5 分钟脚本

| 时间 | 做什么 | 看什么 |
|---|---|---|
| 0:00 | 打开知识库 | 资料已切片 |
| 0:30 | 问一个必须查资料的问题 | 第 1 步检索、第 2 步读取、第 3 步回答 |
| 1:30 | 展开“工作过程” | 每步工具数、耗时、工具卡参数与结果 |
| 2:00 | 让它整理成笔记 | 产物卡 |
| 2:30 | 输入“请统计行数”（演示预设） | 审批卡 |
| 3:00 | 点“允许一次” | 命令执行；时间线留下“已批准” |
| 3:30 | 运行中插话 | “插话”标记 |
| 4:00 | 点“研究小组”预设 | 右侧协作树 |
| 4:30 | 点“失败恢复”预设 | 失败工具卡 + “换了参数后成功” |
| 5:00 | 看运行汇总卡 | 步数、工具、恢复、耗时、引用 |

## 6. 不要做的事

- 不要点“总是允许”彩排；会写进 profile 的 `approvals.json`，正式演示不再弹卡。
- 不要把 `demo\recordings` 里的原始素材发给别人；先脱敏。
- 不要在 `demo\profile` 里放真实密钥后提交；该目录已 gitignore。
