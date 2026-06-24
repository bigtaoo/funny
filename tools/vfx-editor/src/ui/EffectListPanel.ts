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
      const builtin = rec.id.startsWith('builtin:') ? '内置·' : '';
      meta.textContent = `${builtin}${rec.def.layers.length}层`;
      row.appendChild(meta);

      row.addEventListener('click', () => void this.library.switchTo(rec.id));
      this.mount.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'list-actions';

    const dup = document.createElement('button');
    dup.className = 'sm';
    dup.textContent = '复制';
    dup.addEventListener('click', () => void this.library.duplicateActive().then(() => this.setStatus('✓ 已复制当前特效', 'ok')));
    actions.appendChild(dup);

    const del = document.createElement('button');
    del.className = 'sm danger';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      if (this.records.length <= 1) { this.setStatus('至少保留一个特效', 'err'); return; }
      if (confirm('从本地库删除当前特效？（仓库 JSON 不受影响）')) {
        void this.library.removeActive().then(() => this.setStatus('已删除', 'ok'));
      }
    });
    actions.appendChild(del);

    this.mount.appendChild(actions);
  }
}
