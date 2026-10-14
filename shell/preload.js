/**
 * 预加载脚本：把窗口控制能力"最小面"地交给界面。
 *
 * 只暴露三个方法，渲染层拿不到 Node、拿不到任意 IPC 通道——
 * 自绘标题栏需要窗口按钮，但这不该成为打开整扇后门的理由。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("itnWindow", {
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  /** 订阅最大化/还原状态，用来切换按钮图标；返回取消订阅的函数。 */
  onStateChange: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("win:state", handler);
    return () => ipcRenderer.removeListener("win:state", handler);
  },
});
