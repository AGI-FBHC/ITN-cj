# shell —— Electron 外壳

只负责窗口、系统文件对话框和打包，不写业务逻辑。

Windows 打包使用 `assets/lumin.ico`（项目 Logo 的 16–256px 多尺寸图标）。
`scripts/package-app.ps1` 会将图标与 Lumin 产品信息写入 EXE，再读回校验；
安装器复用同一 ICO。`resedit` 仅为构建依赖，不进入分发包。
可用 `node tools/app-icon.cjs <Lumin.exe> --check` 检查成品。

计划：
- 启动时拉起仓颉内核进程，读取标准输出里的端口。
- 内核异常退出时在界面上给出明确提示，并提供重启入口。
- 界面用原生 HTML/CSS/JS，不引入重型框架，保持极简。
