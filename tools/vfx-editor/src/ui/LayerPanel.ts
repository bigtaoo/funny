/**
 * LayerPanel.ts — the layer list + structural editing for the selected layer.
 *
 * Each layer is a row (select / reorder / duplicate / delete). The selected row
 * expands to its structural fields: primitive type, count (radial primitives),
 * z draw-order, jitter/boil seed, and the boil wobble toggle. Numeric param
 * tracks live in ParamPanel; this panel owns everything that isn't a ParamTrack.
 */
import { PrimitiveType } from '@vfx/types';
import { EffectModel } from '../model/EffectModel';
import { ALL_PRIMITIVES, COUNT_PRIMITIVES, POINTS_PRIMITIVES } from '../model/paramHints';

export class LayerPanel {
  constructor(
    private readonly mount: HTMLElement,
    private readonly model: EffectModel,
  ) {}

  render(): void {
    this.mount.innerHTML = '';
    const layers = this.model.layers;
    if (layers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.padding = '10px';
      empty.textContent = '无图层 — 选类型后点「+ 加层」';
      this.mount.appendChild(empty);
      return;
    }

    layers.forEach((layer, i) => {
      const selected = i === this.model.selectedLayer;

      const row = document.createElement('div');
      row.className = 'list-row' + (selected ? ' active' : '');

      const name = document.createElement('span');
      name.className = 'name';
      const cnt = COUNT_PRIMITIVES.has(layer.type) ? ` ×${layer.count ?? 1}` : '';
      name.textContent = `${i + 1}. ${layer.type}${cnt}`;
      row.appendChild(name);

      if (layer.z !== undefined) {
        const z = document.createElement('span');
        z.className = 'meta';
        z.textContent = `z${layer.z}`;
        row.appendChild(z);
      }
      row.addEventListener('click', () => this.model.select(i));
      this.mount.appendChild(row);

      if (selected) this.mount.appendChild(this.structuralFields(i));
    });
  }

  private structuralFields(i: number): HTMLElement {
    const layer = this.model.layers[i];
    const box = document.createElement('div');
    box.style.cssText = 'padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:#11111b;border-bottom:1px solid var(--border)';

    // Reorder / duplicate / delete row
    const ops = document.createElement('div');
    ops.style.cssText = 'display:flex;gap:4px';
    const mkBtn = (label: string, title: string, fn: () => void, danger = false): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'sm' + (danger ? ' danger' : '');
      b.textContent = label; b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    ops.appendChild(mkBtn('↑', '上移', () => this.model.moveLayer(i, -1)));
    ops.appendChild(mkBtn('↓', '下移', () => this.model.moveLayer(i, 1)));
    ops.appendChild(mkBtn('复制', '复制图层', () => this.model.duplicateLayer(i)));
    ops.appendChild(mkBtn('删除', '删除图层', () => this.model.removeLayer(i), true));
    box.appendChild(ops);

    // Type
    box.appendChild(this.field('图元类型', (() => {
      const sel = document.createElement('select');
      sel.className = 'num';
      for (const t of ALL_PRIMITIVES) {
        const o = document.createElement('option');
        o.value = t; o.textContent = t;
        if (t === layer.type) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => this.model.setLayerType(sel.value as PrimitiveType));
      return sel;
    })()));

    // Count (radial primitives only)
    if (COUNT_PRIMITIVES.has(layer.type)) {
      box.appendChild(this.field('count', this.numInput(layer.count ?? 1, (v) => this.model.setLayerCount(v), 1, 1)));
    }

    // z draw order (optional)
    box.appendChild(this.field('z 绘制顺序（空=数组序）', this.optNumInput(layer.z, (v) => this.model.setLayerZ(v))));

    // seed (optional)
    box.appendChild(this.field('seed（空=自动派生）', this.optNumInput(layer.seed, (v) => this.model.setLayerSeed(v))));

    // boil toggle + fields
    const boilWrap = document.createElement('div');
    boilWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px';
    const boilToggle = document.createElement('label');
    boilToggle.className = 'inline';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!layer.boil;
    chk.addEventListener('change', () => this.model.setLayerBoil(chk.checked ? { variants: 3, fps: 8 } : undefined));
    boilToggle.appendChild(chk);
    boilToggle.appendChild(document.createTextNode(' boil 手抖（P3 烘焙；此处仅存数据）'));
    boilWrap.appendChild(boilToggle);
    if (layer.boil) {
      const r = document.createElement('div');
      r.className = 'row2';
      r.appendChild(this.field('variants', this.numInput(layer.boil.variants ?? 3, (v) =>
        this.model.setLayerBoil({ variants: v, fps: layer.boil?.fps ?? 8 }), 1, 1)));
      r.appendChild(this.field('fps', this.numInput(layer.boil.fps ?? 8, (v) =>
        this.model.setLayerBoil({ variants: layer.boil?.variants ?? 3, fps: v }), 1, 1)));
      boilWrap.appendChild(r);
    }
    box.appendChild(boilWrap);

    // points hint (polyline edits go through the JSON pane)
    if (POINTS_PRIMITIVES.has(layer.type)) {
      const hint = document.createElement('div');
      hint.className = 'empty';
      hint.textContent = `points: ${layer.points?.length ?? 0} 点 — 在下方 JSON 面板编辑坐标`;
      box.appendChild(hint);
    }

    return box;
  }

  // ── tiny builders ───────────────────────────────────────────────────────────
  private field(label: string, control: HTMLElement): HTMLElement {
    const f = document.createElement('label');
    f.className = 'field';
    const s = document.createElement('span');
    s.textContent = label;
    f.appendChild(s);
    f.appendChild(control);
    return f;
  }
  private numInput(value: number, onChange: (v: number) => void, step = 0.1, min?: number): HTMLInputElement {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'num'; inp.step = String(step);
    if (min !== undefined) inp.min = String(min);
    inp.value = String(value);
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!Number.isNaN(v)) onChange(v); });
    return inp;
  }
  private optNumInput(value: number | undefined, onChange: (v: number | undefined) => void): HTMLInputElement {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'num'; inp.step = '1';
    inp.value = value === undefined ? '' : String(value);
    inp.addEventListener('change', () => {
      if (inp.value.trim() === '') onChange(undefined);
      else { const v = parseFloat(inp.value); onChange(Number.isNaN(v) ? undefined : v); }
    });
    return inp;
  }
}
