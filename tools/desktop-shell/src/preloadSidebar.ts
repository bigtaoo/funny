import { contextBridge, ipcRenderer } from 'electron';
import type { ToolConfig } from './tools';

contextBridge.exposeInMainWorld('nwShell', {
  listTools: (): Promise<ToolConfig[]> => ipcRenderer.invoke('tools:list'),
  switchTool: (id: string): Promise<void> => ipcRenderer.invoke('tool:switch', id),
  onActiveChanged(cb: (id: string) => void): () => void {
    const listener = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('tool:active', listener);
    return () => ipcRenderer.removeListener('tool:active', listener);
  },

  /** 应用当前待处理的更新（壳级重启安装 / 内容级刷新），见 design/tools/desktop-shell/DESIGN.md §4。 */
  applyUpdate: (): Promise<void> => ipcRenderer.invoke('shell:apply-update'),
  onUpdateAvailable(cb: (info: { kind: 'app' | 'content'; toolId?: string }) => void): () => void {
    const listener = (_e: unknown, info: { kind: 'app' | 'content'; toolId?: string }) => cb(info);
    ipcRenderer.on('shell:update-available', listener);
    return () => ipcRenderer.removeListener('shell:update-available', listener);
  },
  onUpdateCleared(cb: () => void): () => void {
    const listener = () => cb();
    ipcRenderer.on('shell:update-cleared', listener);
    return () => ipcRenderer.removeListener('shell:update-cleared', listener);
  },
});
