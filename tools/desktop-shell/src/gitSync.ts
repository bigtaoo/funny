import { ipcMain } from 'electron';

/**
 * 预留接口，见 design/tools/desktop-shell/DESIGN.md §5。
 * 当前全部方法返回 not_implemented；外包接入前（P4）再换真实实现（isomorphic-git + 权限收窄 token）。
 * 前端调用点（IPC channel 名）保持不变，届时只替换这里的函数体。
 */

interface GitStatusResult {
  dirty: boolean;
  branch: string;
  ahead: number;
}

interface GitCommitResult {
  ok: boolean;
  commitSha?: string;
  error?: string;
}

interface GitPrResult {
  ok: boolean;
  prUrl?: string;
  error?: string;
}

function status(_workdir: string): Promise<GitStatusResult & { error?: string }> {
  return Promise.resolve({ dirty: false, branch: '', ahead: 0, error: 'not_implemented' });
}

function commitAndPush(_opts: {
  workdir: string;
  message: string;
  branch?: string;
  authorName: string;
  authorEmail: string;
}): Promise<GitCommitResult> {
  return Promise.resolve({ ok: false, error: 'not_implemented' });
}

function openOrUpdatePR(_opts: { branch: string; title: string; body: string }): Promise<GitPrResult> {
  return Promise.resolve({ ok: false, error: 'not_implemented' });
}

export function registerGitSyncHandlers(): void {
  ipcMain.handle('git:status', (_e, workdir: string) => status(workdir));
  ipcMain.handle('git:commitAndPush', (_e, opts) => commitAndPush(opts));
  ipcMain.handle('git:openOrUpdatePR', (_e, opts) => openOrUpdatePR(opts));
}
