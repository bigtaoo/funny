import { BrowserView, ipcMain, powerMonitor } from 'electron';

/**
 * 壳级 + 内容级更新共用的"合适时机"提示机制，见 design/tools/desktop-shell/DESIGN.md §4。
 * 通知展示在侧边栏（壳自有 UI），用户点击或空闲达阈值后调用 apply()。
 */

export type UpdateKind = 'app' | 'content';

interface PendingUpdate {
  kind: UpdateKind;
  toolId?: string;
  apply: () => void;
}

const IDLE_THRESHOLD_SECONDS = 120; // 无操作 2 分钟自动应用
const IDLE_CHECK_INTERVAL_MS = 30_000;

let sidebarView: BrowserView | null = null;
let pending: PendingUpdate | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

export function initUpdateNotifier(sidebar: BrowserView): void {
  sidebarView = sidebar;
  ipcMain.handle('shell:apply-update', () => {
    applyPending();
  });
}

/** 已有一条待处理通知时忽略新的（同一时间只展示一条，避免刷屏）。 */
export function showUpdateNotice(kind: UpdateKind, toolId: string | undefined, apply: () => void): void {
  if (pending) return;
  pending = { kind, toolId, apply };
  sidebarView?.webContents.send('shell:update-available', { kind, toolId });
  startIdleWatch();
}

function applyPending(): void {
  if (!pending) return;
  const { apply } = pending;
  clearIdleWatch();
  pending = null;
  sidebarView?.webContents.send('shell:update-cleared');
  apply();
}

function startIdleWatch(): void {
  clearIdleWatch();
  idleTimer = setInterval(() => {
    if (pending && powerMonitor.getSystemIdleTime() >= IDLE_THRESHOLD_SECONDS) {
      applyPending();
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

function clearIdleWatch(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}
