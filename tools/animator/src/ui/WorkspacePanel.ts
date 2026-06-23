// ── WorkspacePanel ──────────────────────────────────────────────────────────
// The "☁ Workspace" cluster in the bottom bar. Opens a modal overlay to sign in
// (magic-link), browse the team's shared animations, open one into the editor,
// and save the current project back to the workspace. All persistence delegates
// to WorkspaceStore; building/loading the archives delegates to IOController.
//
// Self-contained: builds its own overlay DOM so it stays decoupled from
// index.html beyond the single trigger button (#btn-workspace).
//
// Design: design/tools/animator/WORKSPACE_SYNC.md §6

import type { EventBus, AppEvents } from '../core/EventBus';
import type { IOController } from '../io/IOController';
import type { WorkspaceStore, WorkspaceFile } from '../io/WorkspaceStore';
import { DIRTY_EVENTS } from '../io/AutoSaveController';

// localStorage key for the "auto-sync to workspace" preference (survives reload).
const LS_AUTOSYNC = 'nw-animator:workspaceAutoSync';
// Debounced upload delay. Longer than the local IndexedDB autosave (1.5s) so a
// burst of edits batches into one cloud write instead of hammering Supabase.
const SYNC_DEBOUNCE_MS = 4000;

export class WorkspacePanel {
  private overlay: HTMLElement | null = null;
  private email: string | null = null;

  // ── Cloud auto-sync state ──────────────────────────────────────────────────
  // The workspace slot the current project is bound to. Set when the artist
  // saves to / opens from the workspace; auto-sync keeps writing to this slot.
  private bound: { unitKey: string; name: string } | null = null;
  private autoSync   = false;            // toggle (persisted)
  private syncTimer:  number | null = null;
  private syncing     = false;           // an upload is in flight
  private syncDirty   = false;           // edits arrived since the last upload

  constructor(
    private readonly bus:   EventBus<AppEvents>,
    private readonly store: WorkspaceStore,
    private readonly io:    IOController,
  ) {
    document.getElementById('btn-workspace')?.addEventListener('click', () => void this.open());
    this.autoSync = localStorage.getItem(LS_AUTOSYNC) === '1';

    // Keep cached email fresh so the panel renders the right state on open.
    if (this.store.isConfigured()) {
      this.store.onAuthChange(email => {
        this.email = email;
        if (!email) { this.bound = null; this.cancelSync(); }   // signed out → stop syncing
        if (this.overlay) void this.render();
      });
      void this.store.currentEmail().then(e => { this.email = e; });

      // Mirror local edits up to the bound workspace slot (debounced).
      const schedule = () => this.scheduleSync();
      for (const ev of DIRTY_EVENTS) this.bus.on(ev, schedule);
      // Best-effort flush on tab-hide (more reliable than beforeunload for fetch).
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flushSyncNow();
      });
    }
  }

  // ── Overlay lifecycle ──────────────────────────────────────────────────────

  private async open(): Promise<void> {
    if (this.overlay) return;
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.5);' +
      'display:flex;align-items:center;justify-content:center';
    overlay.addEventListener('click', e => { if (e.target === overlay) this.close(); });
    const panel = document.createElement('div');
    panel.id = 'workspace-modal';
    panel.style.cssText =
      'width:440px;max-height:80vh;overflow:auto;background:var(--surface);' +
      'border:1px solid var(--border);border-radius:8px;padding:16px;' +
      'display:flex;flex-direction:column;gap:12px';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    if (this.store.isConfigured()) this.email = await this.store.currentEmail();
    await this.render();
  }

  private close(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  private get body(): HTMLElement {
    return this.overlay!.querySelector<HTMLElement>('#workspace-modal')!;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  private async render(): Promise<void> {
    if (!this.overlay) return;
    const body = this.body;
    body.innerHTML = '';
    body.appendChild(this.header());

    if (!this.store.isConfigured()) {
      body.appendChild(this.notice(
        '工作区未配置。部署时设置 NW_SUPABASE_URL / NW_SUPABASE_ANON_KEY 后启用。' +
        '本地编辑（自动保存 + 下载 .tao）不受影响。',
      ));
      return;
    }
    if (!this.email) { this.renderSignIn(body); return; }
    await this.renderSignedIn(body);
  }

  private header(): HTMLElement {
    const h = document.createElement('div');
    h.style.cssText = 'display:flex;align-items:center;gap:8px';
    const title = document.createElement('span');
    title.textContent = '☁ 团队工作区';
    title.style.cssText = 'font-weight:700;color:var(--accent);font-size:13px';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.className = 'sm';
    close.style.marginLeft = 'auto';
    close.addEventListener('click', () => this.close());
    h.append(title, close);
    return h;
  }

  private notice(text: string): HTMLElement {
    const n = document.createElement('div');
    n.textContent = text;
    n.style.cssText = 'color:var(--text-dim);font-size:11px;line-height:1.6';
    return n;
  }

  private renderSignIn(body: HTMLElement): void {
    body.appendChild(this.notice('用邮箱登录工作区，我们会发一个登录链接给你。'));
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'you@example.com';
    input.style.cssText = 'flex:1;width:auto';
    const btn = document.createElement('button');
    btn.textContent = '发送登录链接';
    btn.className = 'primary sm';
    btn.addEventListener('click', () => {
      const email = input.value.trim();
      if (!email) return;
      btn.disabled = true;
      this.store.signIn(email)
        .then(() => { body.appendChild(this.notice(`已发送登录链接到 ${email}，请查收邮箱。`)); })
        .catch(err => { this.bus.emit('status', `登录失败：${(err as Error).message}`); })
        .finally(() => { btn.disabled = false; });
    });
    row.append(input, btn);
    body.appendChild(row);
  }

  private async renderSignedIn(body: HTMLElement): Promise<void> {
    const who = document.createElement('div');
    who.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-dim)';
    who.textContent = `已登录：${this.email}`;
    const out = document.createElement('button');
    out.textContent = '登出';
    out.className = 'sm';
    out.style.marginLeft = 'auto';
    out.addEventListener('click', () => {
      void this.store.signOut().then(() => { this.email = null; void this.render(); });
    });
    who.appendChild(out);
    body.appendChild(who);

    body.appendChild(this.saveSection());
    body.appendChild(this.autoSyncSection());

    const listHdr = document.createElement('div');
    listHdr.textContent = '工作区动画';
    listHdr.style.cssText =
      'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;' +
      'color:var(--text-dim);border-top:1px solid var(--border);padding-top:10px';
    body.appendChild(listHdr);

    const listEl = document.createElement('div');
    listEl.textContent = '加载中…';
    listEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:12px';
    body.appendChild(listEl);

    try {
      const files = await this.store.list();
      listEl.innerHTML = '';
      if (files.length === 0) {
        listEl.appendChild(this.notice('工作区还没有动画。在上方保存一个即可。'));
        return;
      }
      for (const f of files) listEl.appendChild(this.fileRow(f));
    } catch (err) {
      listEl.textContent = `加载失败：${(err as Error).message}`;
    }
  }

  private saveSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;gap:6px;align-items:center;border-top:1px solid var(--border);padding-top:10px';
    const unit = document.createElement('input');
    unit.type = 'text';
    unit.placeholder = 'unitKey (如 archer)';
    unit.style.cssText = 'flex:1;width:auto';
    const name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'name (如 archer)';
    name.style.cssText = 'flex:1;width:auto';
    const btn = document.createElement('button');
    btn.textContent = '💾 保存到工作区';
    btn.className = 'primary sm';
    btn.addEventListener('click', () => {
      const u = unit.value.trim(), n = name.value.trim();
      if (!u || !n) { this.bus.emit('status', '请填写 unitKey 和 name'); return; }
      btn.disabled = true;
      void this.saveCurrent(u, n).finally(() => { btn.disabled = false; });
    });
    wrap.append(unit, name, btn);
    return wrap;
  }

  private autoSyncSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-dim)';

    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.autoSync;
    cb.style.cssText = 'width:auto;margin:0';
    cb.addEventListener('change', () => {
      this.autoSync = cb.checked;
      localStorage.setItem(LS_AUTOSYNC, cb.checked ? '1' : '0');
      if (!cb.checked) this.cancelSync();
      if (this.overlay) void this.render();   // refresh the hint
    });
    const text = document.createElement('span');
    text.textContent = '自动同步到工作区';
    label.append(cb, text);

    const hint = document.createElement('span');
    hint.style.cssText = 'margin-left:auto;font-size:10px';
    if (!this.autoSync) {
      hint.textContent = '关';
    } else if (this.bound) {
      hint.textContent = `→ ${this.bound.unitKey}/${this.bound.name}`;
      hint.style.color = 'var(--accent)';
    } else {
      hint.textContent = '待绑定（先保存或打开一个）';
    }

    wrap.append(label, hint);
    return wrap;
  }

  private async saveCurrent(unitKey: string, name: string): Promise<void> {
    this.bus.emit('status', '正在上传到工作区…');
    try {
      const [editorBlob, taoBlob] = await Promise.all([
        this.io.buildEditorBlob(),
        this.io.buildTaoBlob(),
      ]);
      await this.store.save(unitKey, name, editorBlob, taoBlob);
      this.bindTo(unitKey, name);              // future edits auto-sync to this slot
      this.bus.emit('status', `已保存 ${unitKey}/${name} 到工作区`);
      if (this.overlay) await this.render();   // refresh list
    } catch (err) {
      this.bus.emit('status', `保存失败：${(err as Error).message}`);
    }
  }

  // ── Cloud auto-sync ─────────────────────────────────────────────────────────

  /** Bind the current project to a workspace slot; a fresh save clears the dirty flag. */
  private bindTo(unitKey: string, name: string): void {
    this.bound = { unitKey, name };
    this.syncDirty = false;
    if (this.syncTimer !== null) { clearTimeout(this.syncTimer); this.syncTimer = null; }
  }

  private cancelSync(): void {
    if (this.syncTimer !== null) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    this.syncDirty = false;
  }

  private scheduleSync(): void {
    if (!this.autoSync || !this.bound || !this.email || !this.store.isConfigured()) return;
    this.syncDirty = true;
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => { void this.flushSync(); }, SYNC_DEBOUNCE_MS);
  }

  private async flushSync(): Promise<void> {
    this.syncTimer = null;
    if (!this.autoSync || !this.bound || !this.email || !this.syncDirty) return;
    if (this.syncing) { this.scheduleSync(); return; }   // retry after the in-flight upload
    const { unitKey, name } = this.bound;
    this.syncing = true;
    this.syncDirty = false;
    this.bus.emit('status', `正在同步 ${unitKey}/${name} 到工作区…`);
    try {
      const [editorBlob, taoBlob] = await Promise.all([
        this.io.buildEditorBlob(),
        this.io.buildTaoBlob(),
      ]);
      await this.store.save(unitKey, name, editorBlob, taoBlob);
      this.bus.emit('status', `已自动同步 ${unitKey}/${name} · ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      this.syncDirty = true;   // keep dirty so the next edit/flush retries
      this.bus.emit('status', `自动同步失败：${(err as Error).message}`);
    } finally {
      this.syncing = false;
    }
  }

  /** Cancel the debounce and upload immediately if there are unsynced edits. */
  private async flushSyncNow(): Promise<void> {
    if (this.syncTimer !== null) { clearTimeout(this.syncTimer); this.syncTimer = null; }
    if (this.autoSync && this.bound && this.email && this.syncDirty) await this.flushSync();
  }

  private fileRow(f: WorkspaceFile): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;' +
      'background:var(--surface2)';
    const label = document.createElement('span');
    label.style.flex = '1';
    const when = f.updatedAt ? new Date(f.updatedAt).toLocaleString() : '—';
    label.textContent = `${f.unitKey} / ${f.name}`;
    const meta = document.createElement('span');
    meta.textContent = when;
    meta.style.cssText = 'color:var(--text-dim);font-size:10px';
    const open = document.createElement('button');
    open.textContent = '打开';
    open.className = 'sm';
    open.addEventListener('click', () => void this.openFile(f));
    row.append(label, meta, open);
    return row;
  }

  private async openFile(f: WorkspaceFile): Promise<void> {
    this.bus.emit('status', `正在打开 ${f.unitKey}/${f.name}…`);
    try {
      const blob = await this.store.download(f.editorPath);
      await this.io.loadEditorBlob(blob, `${f.name}.tao.editor`);
      this.bindTo(f.unitKey, f.name);          // future edits auto-sync back to this slot
      this.bus.emit('status', `已打开 ${f.unitKey}/${f.name}`);
      this.close();
    } catch (err) {
      this.bus.emit('status', `打开失败：${(err as Error).message}`);
    }
  }
}
