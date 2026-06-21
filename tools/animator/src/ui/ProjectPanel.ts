import type { EventBus, AppEvents } from '../core/EventBus';
import type { AutoSaveController } from '../io/AutoSaveController';
import type { ProjectStore } from '../io/ProjectStore';

// ── ProjectPanel ──────────────────────────────────────────────────────────────
// The project selection dropdown + New/Rename/Duplicate/Delete buttons and the
// auto-save status dot. Lives in the bottom bar. All persistence is delegated to
// AutoSaveController; this class is pure DOM wiring.

type SaveState = AppEvents['autosave:state'];

const INDICATOR: Record<SaveState, { color: string; title: string }> = {
  idle:   { color: 'var(--text-dim)', title: 'No unsaved changes' },
  dirty:  { color: 'var(--warn)',     title: 'Unsaved changes…' },
  saving: { color: 'var(--accent)',   title: 'Auto-saving…' },
  saved:  { color: '#a6e3a1',         title: 'All changes saved' },
};

export class ProjectPanel {
  private readonly select:    HTMLSelectElement;
  private readonly indicator: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly bus:      EventBus<AppEvents>,
    private readonly autoSave: AutoSaveController,
    private readonly store:    ProjectStore,
  ) {
    this.select    = root.querySelector<HTMLSelectElement>('#project-select')!;
    this.indicator = root.querySelector<HTMLElement>('#autosave-indicator')!;

    this.select.addEventListener('change', () => { void this.autoSave.switchTo(this.select.value); });

    root.querySelector('#btn-project-new')?.addEventListener('click', () => {
      const name = window.prompt('New project name:', 'Untitled');
      if (name !== null) void this.autoSave.createNew(name.trim() || 'Untitled');
    });
    root.querySelector('#btn-project-rename')?.addEventListener('click', () => {
      const name = window.prompt('Rename project:', this.autoSave.activeName);
      if (name !== null && name.trim()) void this.autoSave.rename(name.trim());
    });
    root.querySelector('#btn-project-dup')?.addEventListener('click', () => {
      void this.autoSave.duplicate();
    });
    root.querySelector('#btn-project-del')?.addEventListener('click', () => {
      if (window.confirm(`Delete project "${this.autoSave.activeName}"? This cannot be undone.`)) {
        void this.autoSave.remove();
      }
    });

    this.bus.on('project:list',   () => { void this.refresh(); });
    this.bus.on('project:active', ({ id }) => { this.select.value = id; });
    this.bus.on('autosave:state', s => this.renderIndicator(s));

    this.renderIndicator('idle');
  }

  private async refresh(): Promise<void> {
    const metas = await this.store.listMeta();
    this.select.innerHTML = '';
    for (const m of metas) {
      const opt = document.createElement('option');
      opt.value       = m.id;
      opt.textContent = m.name;
      this.select.appendChild(opt);
    }
    if (this.autoSave.activeId) this.select.value = this.autoSave.activeId;
  }

  private renderIndicator(state: SaveState): void {
    const { color, title } = INDICATOR[state];
    this.indicator.style.color = color;
    this.indicator.title       = title;
  }
}
