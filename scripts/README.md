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

## Windows 安装版

先运行 `package-app.ps1` 得到当前版本的完整目录和 ZIP，再运行 `package-installer.ps1`，生成 `dist/Lumin-Setup-<版本>-x64.exe`。后者校验发布清单，使用 NSIS 压缩完整程序目录，不重新组装业务代码。

构建机需要 NSIS 与 Windows SDK 的 Manifest Tool (`mt.exe`)；目标电脑不需要这些工具。可通过 `package-installer.ps1 -Compiler <makensis.exe路径>` 指定 NSIS。安装器、快捷方式和卸载图标由 Lumin logo 生成。

Windows 10 最低为 1903（build 18362），或使用 Windows 11，均为 x64。`package.ps1` 给发布内核嵌入 `core/windows-runtime.manifest`，将进程代码页设置为 UTF-8，支持中文安装目录、用户目录与命令行路径。裸编译 EXE 不代表已完成这一发布步骤；不要用它替代发布内核验证中文路径。

`tools/kernel-path-check.ps1` 检查中文可执行文件与工作目录、UI、技能、数据和端口文件路径。`tools/check-installer.ps1` 在隔离目录实际检查安装、升级、文件占用拦截、启动、Office/PDF文件组件、卸载与重装，并备份和恢复产品相关的原注册项/快捷方式。检查成功时写入 `tmp/installer-acceptance-<版本>.json`，其中记录被验收安装器的 SHA256。数据始终使用隔离目录，勿将真实数据库复制进去作为夹具。

下载页由 `tools/serve-release.cjs` 提供，同版本安装器为主要入口，ZIP 为便携版入口。发布必须核对安装器验收报告及本地/服务器/公网下载的文件 SHA256；保留旧 ZIP 地址。安装器卸载按构建时文件清单删除，默认不删除学习数据或用户额外放入安装目录的文件。
