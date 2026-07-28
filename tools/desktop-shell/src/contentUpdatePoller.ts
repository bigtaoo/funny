import { BrowserView } from 'electron';
import type { ToolConfig } from './tools';
import { resolveToolUrl } from './tools';
import { showUpdateNotice } from './updateNotifier';

/**
 * 工具内容级热更新轮询，见 design/tools/desktop-shell/DESIGN.md §4.2。
 * 各工具 webpack 构建产出 version.json（见各 tools/<tool>/webpack.config.js 的 VersionManifestPlugin）。
 */

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const SAVE_ACK_TIMEOUT_MS = 3_000;

interface VersionManifest {
  hash: string;
  builtAt: string;
}

let activeTool: ToolConfig | null = null;
let contentView: BrowserView | null = null;
let baselineHash: string | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let saveAckWaiters: Array<() => void> = [];

async function fetchVersion(tool: ToolConfig): Promise<VersionManifest | null> {
  try {
    const url = new URL('/version.json', resolveToolUrl(tool)).toString();
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as VersionManifest;
  } catch {
    return null; // 离线 / 无 manifest：跳过本轮，不算错误（见 §4.2 离线兜底）
  }
}

/** 工具页面收到 'nw:request-save' 并落盘完成后回发 'nw:save-ack'，main.ts 转调这个函数解除等待。 */
export function notifySaveAck(): void {
  const waiters = saveAckWaiters;
  saveAckWaiters = [];
  waiters.forEach((resolve) => resolve());
}

function waitForSaveAck(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    saveAckWaiters.push(resolve);
    setTimeout(resolve, timeoutMs);
  });
}

/**
 * 切换工具时同步调用：立即清空旧基线，避免旧工具的 hash 被错误拿来跟新工具比对。
 * 真正的基线由后续 `confirmBaseline()`（挂在 did-finish-load）写入。
 */
export function setActiveTool(tool: ToolConfig, view: BrowserView): void {
  activeTool = tool;
  contentView = view;
  baselineHash = null;
}

/** 当前工具页面加载完成后调用（switchTool 的首次加载 + 热更新触发的 reload 都会走到这里）。 */
export async function confirmBaseline(): Promise<void> {
  if (!activeTool) return;
  const manifest = await fetchVersion(activeTool);
  baselineHash = manifest?.hash ?? null;
}

async function pollOnce(): Promise<void> {
  if (!activeTool || !contentView || baselineHash === null) return;
  const manifest = await fetchVersion(activeTool);
  if (!manifest || manifest.hash === baselineHash) return;

  const tool = activeTool;
  const view = contentView;
  view.webContents.send('nw:request-save');
  await waitForSaveAck(SAVE_ACK_TIMEOUT_MS);

  showUpdateNotice('content', tool.id, () => {
    view.webContents.reload();
  });
}

function safePollOnce(): void {
  pollOnce().catch((err) => console.error('[desktop-shell] 内容更新轮询失败：', err));
}

export function startContentUpdatePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(safePollOnce, POLL_INTERVAL_MS);
}

/** 窗口重新获得焦点时提前查一次，不必等下一个轮询周期。 */
export function checkNow(): void {
  safePollOnce();
}
