/**
 * ParamPanel.ts — edit the selected layer's numeric param tracks.
 *
 * Each param is one of three interchangeable forms (DESIGN §3.3):
 *   • constant  — a single number
 *   • two-point — {from, to, ease}
 *   • keyframes — Keyframe[] (per-segment ease)
 * A "form" dropdown converts between them; the keyframe form lets you add/remove
 * stops. The "+ param" button offers the primitive's known knobs (paramHints) or free text.
 */
import { Ease, Keyframe, ParamTrack, PrimitiveType } from '@vfx/types';
import { EffectModel } from '../model/EffectModel';
import { defaultParamValue, PARAM_HINTS } from '../model/paramHints';

const EASES: Ease[] = ['linear', 'easeIn', 'easeOut', 'easeInOut'];
type Form = 'const' | 'ramp' | 'keys';

function formOf(track: ParamTrack): Form {
  if (typeof track === 'number') return 'const';
  if (Array.isArray(track)) return 'keys';
  return 'ramp';
}

/** First representative value of a track, for lossy form conversion. */
function firstValue(track: ParamTrack): number {
  if (typeof track === 'number') return track;
  if (Array.isArray(track)) return track[0]?.v ?? 0;
  return track.from;
}
function lastValue(track: ParamTrack): number {
  if (typeof track === 'number') return track;
  if (Array.isArray(track)) return track[track.length - 1]?.v ?? 0;
  return track.to;
}

export class ParamPanel {
  constructor(
    private readonly listEl: HTMLElement,
    private readonly addWrap: HTMLElement,
    private readonly addSelect: HTMLSelectElement,
    private readonly addBtn: HTMLButtonElement,
    private readonly labelEl: HTMLElement,
    private readonly model: EffectModel,
  ) {
    this.addBtn.addEventListener('click', () => this.addParam());
  }

  render(): void {
    this.listEl.innerHTML = '';
    const layer = this.model.selected;
    if (!layer) {
      this.labelEl.textContent = 'No layer selected';
      this.addWrap.style.display = 'none';
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'Select a layer on the left to edit params';
      this.listEl.appendChild(e);
      return;
    }

    this.labelEl.textContent = `Layer ${this.model.selectedLayer + 1} · ${layer.type}`;
    const params = layer.params ?? {};
    const keys = Object.keys(params);
    if (keys.length === 0) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No params — use "+ param" below to add one';
      this.listEl.appendChild(e);
    }
    for (const key of keys) this.listEl.appendChild(this.paramCard(key, params[key]));

    // Populate the "add param" dropdown with not-yet-used known knobs.
    this.refreshAddOptions(layer.type, new Set(keys));
    this.addWrap.style.display = '';
  }

  private refreshAddOptions(type: PrimitiveType, used: Set<string>): void {
    this.addSelect.innerHTML = '';
    const hints = PARAM_HINTS[type] ?? [];
    for (const name of hints) {
      if (used.has(name)) continue;
      const o = document.createElement('option');
      o.value = name; o.textContent = name;
      this.addSelect.appendChild(o);
    }
    const custom = document.createElement('option');
    custom.value = '__custom__';
    custom.textContent = 'Custom…';
    this.addSelect.appendChild(custom);
  }

  private addParam(): void {
    let name = this.addSelect.value;
    if (name === '__custom__' || name === '') {
      const typed = prompt('Param name:');
      if (!typed) return;
      name = typed.trim();
      if (!name) return;
    }
    if (this.model.selected?.params?.[name] !== undefined) return;
    this.model.setParam(name, defaultParamValue(name));
  }

  // ── one param card ──────────────────────────────────────────────────────────
  private paramCard(key: string, track: ParamTrack): HTMLElement {
    const card = document.createElement('div');
    card.className = 'param';

    const head = document.createElement('div');
    head.className = 'param-head';
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = key;
    head.appendChild(name);

    const formSel = document.createElement('select');
    for (const [val, lab] of [['const', 'Constant'], ['ramp', 'Two-point'], ['keys', 'Keyframes']] as const) {
      const o = document.createElement('option');
      o.value = val; o.textContent = lab;
      if (val === formOf(track)) o.selected = true;
      formSel.appendChild(o);
    }
    formSel.addEventListener('change', () => this.convert(key, track, formSel.value as Form));
    head.appendChild(formSel);

    const del = document.createElement('button');
    del.className = 'sm danger';
    del.textContent = '×';
    del.title = 'Delete param';
    del.addEventListener('click', () => this.model.removeParam(key));
    head.appendChild(del);

    card.appendChild(head);
    card.appendChild(this.formBody(key, track));
    return card;
  }

  private convert(key: string, track: ParamTrack, to: Form): void {
    const a = firstValue(track), b = lastValue(track);
    if (to === 'const') this.model.setParam(key, a);
    else if (to === 'ramp') this.model.setParam(key, { from: a, to: b, ease: 'linear' });
    else this.model.setParam(key, [{ t: 0, v: a }, { t: 1, v: b, ease: 'linear' }]);
  }

  private formBody(key: string, track: ParamTrack): HTMLElement {
    const form = formOf(track);
    if (form === 'const') {
      return this.numRow(typeof track === 'number' ? track : 0, (v) => this.model.setParam(key, v));
    }
    if (form === 'ramp') {
      const r = track as { from: number; to: number; ease?: Ease };
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px';
      const row = document.createElement('div');
      row.className = 'row2';
      row.appendChild(this.labeled('from', this.num(r.from, (v) => this.model.setParam(key, { ...r, from: v }))));
      row.appendChild(this.labeled('to', this.num(r.to, (v) => this.model.setParam(key, { ...r, to: v }))));
      wrap.appendChild(row);
      wrap.appendChild(this.labeled('ease', this.easeSel(r.ease, (e) => this.model.setParam(key, { ...r, ease: e }))));
      return wrap;
    }
    // keyframes
    const kfs = track as Keyframe[];
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px';
    kfs.forEach((kf, i) => {
      const row = document.createElement('div');
      row.className = 'kf-row';
      row.appendChild(this.num(kf.t, (v) => { const n = clone(kfs); n[i] = { ...n[i], t: v }; this.model.setParam(key, sortKfs(n)); }, 't'));
      row.appendChild(this.num(kf.v, (v) => { const n = clone(kfs); n[i] = { ...n[i], v }; this.model.setParam(key, n); }, 'v'));
      row.appendChild(this.easeSel(kf.ease, (e) => { const n = clone(kfs); n[i] = { ...n[i], ease: e }; this.model.setParam(key, n); }));
      const rm = document.createElement('button');
      rm.className = 'sm danger';
      rm.textContent = '×';
      rm.addEventListener('click', () => {
        if (kfs.length <= 1) return;
        const n = clone(kfs); n.splice(i, 1); this.model.setParam(key, n);
      });
      row.appendChild(rm);
      wrap.appendChild(row);
    });
    const add = document.createElement('button');
    add.className = 'sm';
    add.textContent = '+ Keyframe';
    add.addEventListener('click', () => {
      const last = kfs[kfs.length - 1];
      const n = clone(kfs);
      n.push({ t: Math.min(1, (last?.t ?? 0) + 0.25), v: last?.v ?? 0, ease: 'linear' });
      this.model.setParam(key, sortKfs(n));
    });
    wrap.appendChild(add);
    return wrap;
  }

  // ── tiny builders ───────────────────────────────────────────────────────────
  private numRow(value: number, onChange: (v: number) => void): HTMLElement {
    return this.num(value, onChange);
  }
  private num(value: number, onChange: (v: number) => void, placeholder?: string): HTMLInputElement {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.1'; inp.value = String(value);
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!Number.isNaN(v)) onChange(v); });
    return inp;
  }
  private easeSel(ease: Ease | undefined, onChange: (e: Ease) => void): HTMLSelectElement {
    const sel = document.createElement('select');
    sel.style.cssText = 'background:#11111b;color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px;font-size:11px;width:100%';
    for (const e of EASES) {
      const o = document.createElement('option');
      o.value = e; o.textContent = e;
      if (e === (ease ?? 'linear')) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value as Ease));
    return sel;
  }
  private labeled(label: string, control: HTMLElement): HTMLElement {
    const f = document.createElement('label');
    f.className = 'field';
    const s = document.createElement('span');
    s.textContent = label;
    f.appendChild(s);
    f.appendChild(control);
    return f;
  }
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function sortKfs(kfs: Keyframe[]): Keyframe[] { return [...kfs].sort((a, b) => a.t - b.t); }
