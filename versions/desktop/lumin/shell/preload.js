/**
 * 预加载脚本：把契约 §8 的 window.lumin 暴露给界面。
 *
 * 渲染层 contextIsolation 开、nodeIntegration 关 —— 界面只拿到 win / dlg / term / paths
 * 四组具名能力，拿不到 Node，也拿不到任意 IPC 通道名。
 */
const { contextBridge, ipcRenderer } = require("electron");

/** 订阅一个渲染进程事件，返回取消订阅函数（契约只规定 cb，返回值是顺手的补充）。 */
function subscribe(channel, cb) {
  const handler = (_e, payload) => {
    if (typeof cb === "function") cb(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("lumin", {
  win: {
    minimize: () => ipcRenderer.send("win:minimize"),
    toggleMaximize: () => ipcRenderer.send("win:toggle-maximize"),
    close: () => ipcRenderer.send("win:close"),
    /** cb({maximized:bool})：最大化/还原时回调；返回取消订阅函数。 */
    onState: (cb) => subscribe("win:state", cb),
  },
  dlg: {
    /** Promise<string|"">：取消返回 ""。 */
    pickDirectory: (title) => ipcRenderer.invoke("dlg:pick-directory", title),
  },
  term: {
    /** Promise<{ok, error?}>；cwd 缺省 <lumin根>/chat-workspace。 */
    start: (opts) => ipcRenderer.invoke("term:start", opts || {}),
    /** 写子进程 stdin。 */
    write: (text) => ipcRenderer.send("term:write", text),
    /** cb(text)：stdout/stderr 增量（主进程已按 UTF-8 流式解码）。 */
    onData: (cb) => subscribe("term:data", cb),
    /** cb({code})：子进程退出。 */
    onExit: (cb) => subscribe("term:exit", cb),
    /** 杀子进程。 */
    stop: () => ipcRenderer.send("term:stop"),
  },
  /** {luminRoot, kernelExe}：主进程算好的唯一事实（候选 exe 的查找逻辑只在 main 里）。 */
  paths: ipcRenderer.sendSync("paths:get") || { luminRoot: "", kernelExe: "" },
});
