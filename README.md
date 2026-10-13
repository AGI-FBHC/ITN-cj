# ITN-Desktop

本地的教培 Agent 工作台：用户自带资料与模型，在自己电脑上生成讲义与练习。

先读 [PRODUCT.md](PRODUCT.md)，那里定义了我们在做什么、不做什么。

| 目录 | 内容 |
| --- | --- |
| `core/` | 仓颉内核：知识库、索引、检索、Agent 循环、模型调用、生成 |
| `shell/` | Electron 外壳：窗口、系统文件对话框、打包 |
| `docs/` | 产品、架构、接口契约、数据模型 |
| `scripts/` | 构建与打包脚本 |

其余约定见 [AGENTS.md](AGENTS.md)，每次操作与对话要点追加到 [TRACE.md](TRACE.md)。

## 当前状态

脚手架阶段。仓颉 Windows 工具链尚未安装，先完成技术验证再写业务代码。

## 如何构建

```powershell
# 构建内核（需要先有 D:\cangjie-sdk\1.2.0 工具链，见 docs/04-技术验证.md）
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

测试脚本跑的是 `dist/core` 里的打包产物，而不是 `core/target` 下的裸可执行文件——后者需要工具链 PATH 才能启动。技术验证结论见 [docs/04-技术验证.md](docs/04-技术验证.md)。
