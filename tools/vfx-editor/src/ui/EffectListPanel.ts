/**
 * EffectListPanel.ts — the effect library: browse / switch / new / dup / delete.
 *
 * Reads records from the Library (IndexedDB working copies) and renders a row
 * per effect. Selecting a row switches the active effect; the toolbar buttons
 * create/duplicate/delete. Built-in (repo) effects are tagged.
 */
import { EffectRecord } from '../io/ProjectStore';
import { Library } from '../io/Library';

export class EffectListPanel {
  private records: EffectRecord[] = [];

  constructor(
    private readonly mount: HTMLElement,
    private readonly library: Library,
    private readonly setStatus: (m: string, kind?: 'ok' | 'err' | '') => void,
  ) {}

  async refresh(): Promise<void> {
    this.records = await this.library.list();
    this.render();
  }

  private render(): void {
    this.mount.innerHTML = '';
    const activeId = this.library.activeId;

    for (const rec of this.records) {
      const row = document.createElement('div');
      row.className = 'list-row' + (rec.id === activeId ? ' active' : '');

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = rec.def.id;
      row.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'meta';
      const builtin = rec.id.startsWith('builtin:') ? 'built-in · ' : '';
      meta.textContent = `${builtin}${rec.def.layers.length} layers`;
      row.appendChild(meta);

      row.addEventListener('click', () => void this.library.switchTo(rec.id));
      this.mount.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'list-actions';

    const dup = document.createElement('button');
    dup.className = 'sm';
    dup.textContent = 'Duplicate';
    dup.addEventListener('click', () => void this.library.duplicateActive().then(() => this.setStatus('✓ Effect duplicated', 'ok')));
    actions.appendChild(dup);

    const del = document.createElement('button');
    del.className = 'sm danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      if (this.records.length <= 1) { this.setStatus('Must keep at least one effect', 'err'); return; }
      if (confirm('Delete the current effect from the local library? (Repo JSON is not affected)')) {
        void this.library.removeActive().then(() => this.setStatus('Deleted', 'ok'));
      }
    });
    actions.appendChild(del);

    this.mount.appendChild(actions);
  }
}
