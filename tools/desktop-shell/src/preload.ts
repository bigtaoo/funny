import { contextBridge, ipcRenderer } from 'electron';

/**
 * 注入进各工具内容页面（BrowserView）的桥接口，见 design/tools/desktop-shell/DESIGN.md §3。
 * 各工具页面按需调用；脱离壳单独 `npm start` 时 window.nwDesktop 为 undefined，工具侧需做存在性判断。
 */
contextBridge.exposeInMainWorld('nwDesktop', {
  git: {
    status: (workdir: string) => ipcRenderer.invoke('git:status', workdir),
    commitAndPush: (opts: unknown) => ipcRenderer.invoke('git:commitAndPush', opts),
    openOrUpdatePR: (opts: unknown) => ipcRenderer.invoke('git:openOrUpdatePR', opts),
  },
  /** 本地磁盘文件读写，见 design/tools/desktop-shell/DESIGN.md §3。 */
  fs: {
    openFile: (filters: Array<{ name: string; extensions: string[] }>) =>
      ipcRenderer.invoke('fs:openFile', filters),
    writeFile: (path: string, data: ArrayBuffer) => ipcRenderer.invoke('fs:writeFile', path, data),
    saveFileAs: (
      opts: { defaultPath?: string; filters: Array<{ name: string; extensions: string[] }> },
      data: ArrayBuffer,
    ) => ipcRenderer.invoke('fs:saveFileAs', opts, data),
  },
  /** 壳请求工具页面立即保存（内容热更新流程第一步），见 §4.2。返回取消订阅函数。 */
  onRequestSave(cb: () => void | Promise<void>): () => void {
    const listener = () => {
      Promise.resolve(cb()).finally(() => ipcRenderer.send('nw:save-ack'));
    };
    ipcRenderer.on('nw:request-save', listener);
    return () => ipcRenderer.removeListener('nw:request-save', listener);
  },
  /** 壳/工具有新版本可用，见 §4。返回取消订阅函数。 */
  onUpdateAvailable(cb: (info: { kind: 'app' | 'content'; toolId?: string }) => void): () => void {
    const listener = (_e: unknown, info: { kind: 'app' | 'content'; toolId?: string }) => cb(info);
    ipcRenderer.on('nw:update-available', listener);
    return () => ipcRenderer.removeListener('nw:update-available', listener);
  },
});
