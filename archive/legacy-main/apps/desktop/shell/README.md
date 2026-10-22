# Desktop Electron 外壳

提供桌面窗口、系统文件操作和界面集成。主进程入口是 `main.js`，界面资源在 `renderer/`。启动时查找打包目录或 `../dist/core/` 下的仓颉内核，再载入本地界面。

先按 [Desktop README](../README.md) 构建和打包内核，在本目录执行：

```powershell
npm ci
npm start
```

完整应用打包使用上级 `scripts/package-app.ps1`。模型配置、用户数据与 API Key 不放入源码包。
