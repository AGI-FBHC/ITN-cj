# ITN-Desktop

本地的教培 Agent 工作台：用户自带资料与模型，在自己电脑上生成讲义与练习。

先读 [PRODUCT.md](PRODUCT.md)，那里定义了我们在做什么、不做什么。

| 目录 | 内容 |
| --- | --- |
| `core/` | 仓颉内核：知识库、索引、检索、Agent 循环、模型调用、生成 |
| `shell/` | Electron 外壳：窗口、系统文件对话框、打包 |
| `lumin/` | 仓颉 Agent 运行时与 CLI |
| `scripts/` | 构建、打包、发布脚本 |
| `tools/` | 自动化验收、发布服务与测试工具 |
| `samples/` | 可复现的输入样例 |

桌面端的架构、接口和操作说明保留在本地 `docs/`，不随公开仓库发布。其余约定见 [AGENTS.md](AGENTS.md)，每次操作与对话要点追加到 [TRACE.md](TRACE.md)。

## 当前状态

已提供本地知识库、并发对话、随课导学、学习资源与多智能体协作。业务和模型调度由仓颉内核承担。

## 思考深度

对话输入区的“思考”菜单按当前模型显示可用档位，每个会话独立保存，修改从下一轮生效。协作树和 PPT 子 Agent 继承本轮设置。

模型设置中的“思考适配”保持“默认”时，只自动识别已知官方接口。使用第三方网关时，按网关实际兼容情况选择 DeepSeek、MiMo、Qwen 或 OpenAI；没有适配就保持默认，不会额外发送思考参数。“不启用思考”则明确关闭所有思考参数。MiMo 当前只显示开关。需要 Responses 才支持思考和工具调用的模型暂不开放深度档位。

思考 token 仅使用接口返回的用量，包含在输出总量中。`get_reasoning_mode` 可读取设置；`set_reasoning_mode` 仅在用户明确要求后调整下一轮模式。

## 如何构建

```powershell
# 构建内核（需要仓颉 1.2.0 工具链，环境加载见 scripts/env.ps1）
.\scripts\build.ps1

# 产出可独立分发的内核目录（目标机器无需安装仓颉）
.\scripts\package.ps1
```

产物在 `dist/core`，约 17MB。

## 冒烟测试

```powershell
# 先构建并打包，再跑端到端冒烟（会拉起本地 mock 模型，不需要真实密钥）
.\scripts\build.ps1
.\scripts\package.ps1
.\tools\smoke.ps1
```

测试脚本跑的是 `dist/core` 里的打包产物，而不是 `core/target` 下的裸可执行文件——后者需要工具链 PATH 才能启动。

## 运行桌面应用

```powershell
# 开发态：直接拉起 Electron，它会自行启动仓颉内核
cd shell
npm install
npx electron .

# 打包成绿色压缩包（目标机器无需安装仓颉或 Node）
.\scripts\package-app.ps1

```

产物为 `dist/Lumin-<版本号>/Lumin.exe` 与 `dist/Lumin-<版本号>.zip`，版本目录直接与历版并列。每次交付递增 `shell/package.json` 与 `shell/package-lock.json` 的补丁版本，保留旧版本目录，不追加其他后缀。界面由仓颉内核托管，Electron 负责窗口。
