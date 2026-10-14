/**
 * 预加载脚本：把窗口与"选目录"能力"最小面"地交给界面。
 *
 * 只暴露四个具名方法，渲染层拿不到 Node、拿不到任意 IPC 通道——
 * 自绘标题栏需要窗口按钮、登记知识库需要选目录，但这不该成为打开整扇后门的理由。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("itnWindow", {
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
  close: () => ipcRenderer.send("win:close"),
  /** 打开系统的"选择文件夹"对话框，返回绝对路径（取消则返回 ""）。 */
  pickDirectory: () => ipcRenderer.invoke("dlg:pick-directory"),
  /** 打开系统的"选文件"对话框（导入单份资料用），同样返回绝对路径。 */
  pickFile: () => ipcRenderer.invoke("dlg:pick-file"),
  /** 订阅最大化/还原状态，用来切换按钮图标；返回取消订阅的函数。 */
  onStateChange: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("win:state", handler);
    return () => ipcRenderer.removeListener("win:state", handler);
  },
});
