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
});
