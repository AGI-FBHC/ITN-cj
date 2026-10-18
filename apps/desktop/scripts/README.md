# Desktop 构建与打包脚本

在 `apps/desktop/` 目录使用 PowerShell 7 执行。脚本通过自身路径定位桌面项目，内核使用仓颉 SDK 1.2.0；完整环境要求见 [Desktop README](../README.md)。

| 脚本 | 作用 |
| --- | --- |
| `env.ps1` | 在当前会话加载 SDK、STDX 与 OpenSSL |
| `build.ps1` | 构建本地内核 |
| `package.ps1` | 校验构建产物并组装 `dist/core/` |
| `prepare-ppt-runtime.ps1` | 准备完整应用所需的 PPT 渲染运行时 |
| `package-app.ps1` | 组装 `dist/Lumin/` 并生成压缩包 |
| `publish-lumin.ps1` | 从当前 Git 仓库导出本应用的 `lumin/` 子目录并推送独立仓库；仅在明确需要发布该仓库时手动执行 |

依赖、生成产物和个人配置不提交到 Git。
