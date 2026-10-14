# scripts —— 构建与打包

计划放置：
- 仓颉内核的构建脚本（静态链接、拷贝 OpenSSL 动态库）。
- Electron 打包脚本，产出绿色压缩包。
- 一键启动脚本，便于开发期调试。

## 已有

| 脚本 | 作用 |
| --- | --- |
| `build.ps1` | 构建仓颉内核 |
| `package.ps1` | 产出可独立分发的内核目录 `dist/core` |
| `package-app.ps1` | 打包 Electron 桌面应用（绿色 zip） |
| `publish-lumin.ps1` | 把 `lumin/` 导出成独立仓库并推送到 GitHub（`git subtree split` 保留历史） |
| `env.ps1` | 加载仓颉 SDK 环境（PowerShell 7） |
