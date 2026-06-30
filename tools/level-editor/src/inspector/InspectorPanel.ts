import { ATTACK_LANES } from '@game/config';
import { TICK_RATE } from '@game/math/fixed';
import { UnitType } from '@game/types';
import type { WaveEntry } from '@game/campaign/LevelDefinition';
import type { EditorState } from '../state/EditorState';
import { ALL_UNITS } from '../units';

/**
 * Inspector for the selected wave entry (P-D).
 *
 * A DOM form bound to {@link EditorState.selectedWave}: edits the unit type,
 * lane, start time, count, spacing, and boss flag of the selected block, plus
 * add/delete. Time fields are shown in seconds (the authoring unit) and
 * converted to ticks (the stored unit) on the way in/out.
 *
 * Re-rendered wholesale on every state change — cheap, and avoids stale-field
 * bugs when the timeline reselects or a drag mutates the same entry.
 */
export class InspectorPanel {
  constructor(private state: EditorState, private root: HTMLElement) {
    state.on(() => this.render());
    this.render();
  }

  private toSec = (ticks: number): string => (ticks / TICK_RATE).toFixed(2).replace(/\.?0+$/, '');
  private toTicks = (sec: number): number => Math.round(sec * TICK_RATE);

  private render(): void {
    const root = this.root;
    root.innerHTML = '';

    const addBtn = el('button', { class: 'primary', text: '+ Add wave' });
    addBtn.addEventListener('click', () => {
      const entry: WaveEntry = { atTick: 0, unitType: UnitType.Infantry, col: ATTACK_LANES[0]!, count: 1 };
      this.state.addWave(entry);
    });
    root.appendChild(addBtn);

    const index = this.state.selectedWave;
    if (index === null || !this.state.waves[index]) {
      root.appendChild(el('p', { class: 'hint', text: 'Click a wave block on the timeline to edit, or add a new wave.' }));
      return;
    }
    const entry = this.state.waves[index]!;

    root.appendChild(el('div', { class: 'insp-title', text: `Wave #${index}` }));

    // Unit type
    const unitSel = el('select') as HTMLSelectElement;
    for (const u of ALL_UNITS) {
      const opt = el('option', { text: `${u.label || u.type} (${u.type})` }) as HTMLOptionElement;
      opt.value = u.type;
      if (u.type === entry.unitType) opt.selected = true;
      unitSel.appendChild(opt);
    }
    unitSel.addEventListener('change', () =>
      this.state.updateWave(index, { unitType: unitSel.value as UnitType }),
    );
    root.appendChild(field('Unit', unitSel));

    // Lane / col
    const colSel = el('select') as HTMLSelectElement;
    for (const c of ATTACK_LANES) {
      const opt = el('option', { text: `col ${c}` }) as HTMLOptionElement;
      opt.value = String(c);
      if (c === entry.col) opt.selected = true;
      colSel.appendChild(opt);
    }
    colSel.addEventListener('change', () => this.state.updateWave(index, { col: Number(colSel.value) }));
    root.appendChild(field('Lane (col)', colSel));

    // atTick (seconds)
    root.appendChild(
      numField('Start time (s)', this.toSec(entry.atTick), 0, 0.1, (v) =>
        this.state.updateWave(index, { atTick: Math.max(0, this.toTicks(v)) }),
      ),
    );

    // count
    root.appendChild(
      numField('Count', String(entry.count), 1, 1, (v) =>
        this.state.updateWave(index, { count: Math.max(1, Math.round(v)) }),
      ),
    );

    // spacing (seconds)
    root.appendChild(
      numField('Interval (s)', this.toSec(entry.spacingTicks ?? 0), 0, 0.1, (v) =>
        this.state.updateWave(index, { spacingTicks: Math.max(0, this.toTicks(v)) }),
      ),
    );

    // isBoss
    const boss = el('input') as HTMLInputElement;
    boss.type = 'checkbox';
    boss.checked = entry.isBoss === true;
    boss.addEventListener('change', () => this.state.updateWave(index, { isBoss: boss.checked }));
    root.appendChild(field('Boss', boss));

    // crossWaypoints
    const wpHeader = el('div', { class: 'insp-title', text: 'Lane-change waypoints (crossWaypoints)' });
    wpHeader.style.fontSize = '11px';
    root.appendChild(wpHeader);
    const wps = entry.crossWaypoints ?? [];
    for (let wi = 0; wi < wps.length; wi++) {
      const wp = wps[wi]!;
      const wpRow = document.createElement('div');
      wpRow.style.cssText = 'display:flex;gap:4px;align-items:center;margin:2px 0';
      // atRow
      const rowInp = el('input') as HTMLInputElement;
      rowInp.type = 'number'; rowInp.min = '0'; rowInp.max = '17'; rowInp.step = '1';
      rowInp.value = String(wp.atRow); rowInp.title = 'Trigger row'; rowInp.style.width = '46px';
      rowInp.addEventListener('change', () => {
        const v = parseInt(rowInp.value);
        if (!isNaN(v)) {
          const updated = [...(entry.crossWaypoints ?? [])];
          updated[wi] = { ...updated[wi]!, atRow: Math.max(0, Math.min(17, v)) };
          this.state.updateWave(index, { crossWaypoints: updated });
        }
      });
      wpRow.appendChild(rowInp);
      const arrow = document.createElement('span'); arrow.textContent = '→';
      wpRow.appendChild(arrow);
      // toCol
      const toColSel = el('select') as HTMLSelectElement;
      for (const c of ATTACK_LANES) {
        const o = el('option', { text: `col ${c}` }) as HTMLOptionElement;
        o.value = String(c);
        if (c === wp.toCol) o.selected = true;
        toColSel.appendChild(o);
      }
      toColSel.addEventListener('change', () => {
        const updated = [...(entry.crossWaypoints ?? [])];
        updated[wi] = { ...updated[wi]!, toCol: Number(toColSel.value) };
        this.state.updateWave(index, { crossWaypoints: updated });
      });
      wpRow.appendChild(toColSel);
      // delete
      const wpDel = el('button', { class: 'danger', text: '×' });
      wpDel.addEventListener('click', () => {
        const updated = (entry.crossWaypoints ?? []).filter((_, i) => i !== wi);
        this.state.updateWave(index, { crossWaypoints: updated });
      });
      wpRow.appendChild(wpDel);
      root.appendChild(wpRow);
    }
    const addWpBtn = el('button', { text: '+ Lane-change waypoint' });
    addWpBtn.addEventListener('click', () => {
      const updated = [...(entry.crossWaypoints ?? []), { atRow: 9, toCol: ATTACK_LANES[0]! }];
      this.state.updateWave(index, { crossWaypoints: updated });
    });
    root.appendChild(addWpBtn);

    // duration readout
    const endSec = this.toSec(entry.atTick + Math.max(0, entry.count - 1) * (entry.spacingTicks ?? 0));
    root.appendChild(el('p', { class: 'hint', text: `Group ends at ${endSec}s` }));

    const del = el('button', { class: 'danger', text: 'Delete wave' });
    del.addEventListener('click', () => this.state.removeWave(index));
    root.appendChild(del);
  }
}

// ── tiny DOM helpers ──
function el(tag: string, opts?: { class?: string; text?: string }): HTMLElement {
  const e = document.createElement(tag);
  if (opts?.class) e.className = opts.class;
  if (opts?.text !== undefined) e.textContent = opts.text;
  return e;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', { class: 'insp-field' });
  wrap.appendChild(el('span', { text: label }));
  wrap.appendChild(control);
  return wrap;
}

function numField(
  label: string,
  value: string,
  min: number,
  step: number,
  onChange: (v: number) => void,
): HTMLElement {
  const input = el('input') as HTMLInputElement;
  input.type = 'number';
  input.value = value;
  input.min = String(min);
  input.step = String(step);
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) onChange(v);
  });
  return field(label, input);
}
