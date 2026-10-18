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
  pickImage: () => ipcRenderer.invoke("dlg:pick-image"),
  readSelectedImage: (p) => ipcRenderer.invoke("image:read-selected", String(p || "")),
  /** 用系统默认程序打开一个路径（文件夹 → 资源管理器，文件 → 关联的应用）。 */
  openPath: (p) => ipcRenderer.invoke("shell:open-path", String(p || "")),
  /** 打开系统的"选演示文稿"对话框（.pptx / .ppt）。 */
  pickDeck: () => ipcRenderer.invoke("dlg:pick-deck"),
  /** 读一份演示文稿（.pptx / .ppt）的文字，给"在线演示"做离线预览。 */
  readDeck: (p) => ipcRenderer.invoke("deck:read", String(p || "")),
  /** 打开系统的"选文档"对话框（.docx / .doc）。 */
  pickDoc: () => ipcRenderer.invoke("dlg:pick-doc"),
  /** 读一份文档（.docx / .doc）的文字，做离线预览。 */
  readDoc: (p) => ipcRenderer.invoke("doc:read", String(p || "")),
  readResourceFile: (p) => ipcRenderer.invoke('resource:read',String(p || '')),
  /** 把一份 Markdown 导成可编辑的 .pptx / .docx（会弹"另存为"对话框）。 */
  exportResource: (payload) => ipcRenderer.invoke("export:resource", payload || {}),
  /**
   * 订阅深链接：`lumin://thread/<会话id>`。
   *
   * 两种情况都会走到这里：窗口是被链接拉起来的（启动参数里带 URL），
   * 或程序已经在跑、第二个实例把链接转交过来。返回取消订阅的函数。
   */
  onDeepLink: (cb) => {
    const handler = (_e, sid) => cb(String(sid || ""));
    ipcRenderer.on("deeplink:thread", handler);
    return () => ipcRenderer.removeListener("deeplink:thread", handler);
  },
  /** 订阅最大化/还原状态，用来切换按钮图标；返回取消订阅的函数。 */
  onStateChange: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("win:state", handler);
    return () => ipcRenderer.removeListener("win:state", handler);
  },
});
