/**
 * vfx-editor entry / composition root (P2).
 *
 * Wires a central EffectModel to: a PixiJS preview that paints via the game's own
 * interpret(); the effect library (IndexedDB working copies, seeded from the
 * repo's built-in effects); layer / param / colour panels; a live JSON pane; and
 * import/export that round-trips through the shared parseEffectDef validator.
 *
 * Design doc: design/tools/vfx-editor/DESIGN.md §8.
 */
import { EFFECTS } from '@vfx/registry';
import { EffectDef } from '@vfx/types';

import { EffectModel } from './model/EffectModel';
import { ALL_PRIMITIVES } from './model/paramHints';
import { toHexString } from './model/color';
import { ProjectStore } from './io/ProjectStore';
import { Library, AutosaveState } from './io/Library';
import { exportEffect, importEffect, validate } from './io/IOController';
import { PreviewRenderer } from './rendering/PreviewRenderer';
import { Playback } from './rendering/Playback';
import { EffectListPanel } from './ui/EffectListPanel';
import { LayerPanel } from './ui/LayerPanel';
import { ParamPanel } from './ui/ParamPanel';
import { ColorPalette } from './ui/ColorPalette';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const statusEl = $<HTMLDivElement>('status');
function setStatus(message: string, kind: 'ok' | 'err' | '' = ''): void {
  statusEl.className = `status ${kind}`.trim();
  statusEl.textContent = message;
}

// ── Core ──────────────────────────────────────────────────────────────────────
const builtins: EffectDef[] = Object.values(EFFECTS);
const model = new EffectModel(builtins[0] ?? blankEffect());
const preview = new PreviewRenderer($('preview-mount'));
const playback = new Playback(updateTimelineReadout);
let previewSeed = 1; // fixed → stable preview; 🎲 reseeds for variation check

const store = new ProjectStore();
const palette = new ColorPalette($('swatches'), model, () => {/* preview reads live each frame */});

// ── Panels ────────────────────────────────────────────────────────────────────
const layerPanel = new LayerPanel($('layer-list'), model);
const paramPanel = new ParamPanel(
  $('param-list'), $('param-add-wrap'), $<HTMLSelectElement>('param-add-name'),
  $<HTMLButtonElement>('btn-add-param'), $('param-layer-label'), model,
);
// Library owns the IndexedDB working copies + autosave; the list panel renders it.
// `effectList` is referenced lazily inside the onListChange arrow, so declaring
// the library first (and the panel right after) avoids any TDZ issue.
let effectList: EffectListPanel;
const lib = new Library(
  store, model, builtins,
  (s: AutosaveState) => { $('autosave').textContent = autosaveLabel(s); },
  () => void effectList?.refresh(),
);
effectList = new EffectListPanel($('effect-list'), lib, setStatus);

// ── Add-layer type dropdown ─────────────────────────────────────────────────────
const addTypeSel = $<HTMLSelectElement>('layer-add-type');
for (const t of ALL_PRIMITIVES) {
  const o = document.createElement('option');
  o.value = t; o.textContent = t;
  addTypeSel.appendChild(o);
}
$('btn-add-layer').addEventListener('click', () => model.addLayer(addTypeSel.value as never));

// ── Effect property fields ──────────────────────────────────────────────────────
const idInput = $<HTMLInputElement>('eff-id');
const colorInput = $<HTMLInputElement>('eff-color');
idInput.addEventListener('change', () => model.setId(idInput.value.trim()));
colorInput.addEventListener('change', () => model.setDefaultColor(colorInput.value));

// ── Timeline controls ───────────────────────────────────────────────────────────
const scrub = $<HTMLInputElement>('scrub');
const tval = $<HTMLSpanElement>('tval');
const playBtn = $<HTMLButtonElement>('btn-play');
const durationInput = $<HTMLInputElement>('duration');
const loopChk = $<HTMLInputElement>('chk-loop');
scrub.addEventListener('input', () => playback.scrubTo(parseInt(scrub.value, 10) / 1000));
playBtn.addEventListener('click', () => playback.toggle());
durationInput.addEventListener('change', () => {
  const d = parseFloat(durationInput.value);
  if (d > 0) model.setDuration(d);
});
loopChk.addEventListener('change', () => model.setLoop(loopChk.checked));

$<HTMLInputElement>('chk-ref').addEventListener('change', (e) =>
  preview.setReferenceUnit((e.target as HTMLInputElement).checked));
$('btn-reseed').addEventListener('click', () => { previewSeed = Math.floor(Math.random() * 0x7fffffff) || 1; });

// ── JSON pane ───────────────────────────────────────────────────────────────────
const jsonEl = $<HTMLTextAreaElement>('json');
$('btn-apply').addEventListener('click', () => {
  let raw: unknown;
  try { raw = JSON.parse(jsonEl.value); } catch (e) { setStatus(`JSON 解析失败：${(e as Error).message}`, 'err'); return; }
  const def = validate(raw, 'json', (m) => setStatus(`✗ ${m}`, 'err'));
  if (!def) return;
  model.replace(def);
  setStatus(`✓ 已应用 — "${def.id}"`, 'ok');
});

// ── Toolbar ─────────────────────────────────────────────────────────────────────
$('btn-new').addEventListener('click', () => void lib.createNew(blankEffect()).then(() => setStatus('✓ 新建特效', 'ok')));
$('btn-import').addEventListener('click', () => void importEffect(
  (def) => void lib.createNew(def).then(() => setStatus(`✓ 已导入 "${def.id}"`, 'ok')),
  (m) => setStatus(`✗ ${m}`, 'err'),
));
$('btn-export').addEventListener('click', () => void exportEffect(model.effect, (m) => setStatus(m, 'ok'), (m) => setStatus(`✗ ${m}`, 'err')));
$('btn-undo').addEventListener('click', () => model.undo());
$('btn-redo').addEventListener('click', () => model.redo());
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); model.undo(); }
  else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); model.redo(); }
});

// ── Render-on-change ────────────────────────────────────────────────────────────
function fullRender(): void {
  const def = model.effect;
  effectList.refresh();          // active highlight may change on switch
  layerPanel.render();
  paramPanel.render();
  renderMetrics();

  // Effect props (don't clobber a field the user is typing into).
  if (document.activeElement !== idInput) idInput.value = def.id;
  if (document.activeElement !== colorInput) colorInput.value = def.defaultColor === undefined ? '' : String(def.defaultColor);
  if (document.activeElement !== durationInput) durationInput.value = String(def.duration);
  loopChk.checked = !!def.loop;

  // JSON pane (don't clobber while the user edits it).
  if (document.activeElement !== jsonEl) jsonEl.value = JSON.stringify(def, null, 2);

  // Sync playback + undo/redo affordances.
  playback.duration = def.duration;
  $<HTMLButtonElement>('btn-undo').disabled = !model.canUndo;
  $<HTMLButtonElement>('btn-redo').disabled = !model.canRedo;
}
model.on(fullRender);

function renderMetrics(): void {
  const m = model.metrics();
  const host = $('metrics');
  host.innerHTML = '';
  const rows: Array<[string, number, number]> = [
    ['图层数', m.layers, 8],
    ['单层 count 峰值', m.maxCount, 32],
    ['估算顶点', m.vertices, 400],
    ['时长 (s)', m.duration, 2],
  ];
  for (const [label, v, budget] of rows) {
    const row = document.createElement('div');
    const over = v > budget;
    row.className = 'metric-row' + (over ? ' over' : '');
    const l = document.createElement('span'); l.textContent = label;
    const val = document.createElement('span'); val.className = 'v'; val.textContent = `${round(v)} / ${budget}`;
    row.appendChild(l); row.appendChild(val);
    host.appendChild(row);
  }
  const warnHost = $('metric-warnings');
  warnHost.innerHTML = '';
  if (m.warnings.length) {
    const box = document.createElement('div');
    box.className = 'warn-box';
    box.innerHTML = '⚠ 超出软预算：<br>' + m.warnings.map((w) => `· ${w}`).join('<br>');
    warnHost.appendChild(box);
  }
}

function updateTimelineReadout(): void {
  scrub.value = String(Math.round(playback.t * 1000));
  tval.textContent = `t=${playback.t.toFixed(2)}`;
  playBtn.textContent = playback.playing ? '⏸ 暂停' : '▶ 播放';
}

// ── rAF preview loop ─────────────────────────────────────────────────────────────
let last = performance.now();
function frame(now: number): void {
  const dt = now - last;
  last = now;
  playback.advance(dt);
  preview.render(model.effect, playback.t, palette.color, previewSeed);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Splitters ─────────────────────────────────────────────────────────────────
function dragSplit(splitter: HTMLElement, target: HTMLElement, axis: 'x' | 'y', dir: 1 | -1, min: number, max: number): void {
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = axis === 'x' ? target.offsetWidth : target.offsetHeight;
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent): void => {
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      const next = Math.max(min, Math.min(max, startSize + dir * (pos - startPos)));
      target.style.flex = `0 0 ${next}px`;
      if (axis === 'x') target.style.width = `${next}px`; else target.style.height = `${next}px`;
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}
dragSplit($('split-left'), $('col-left'), 'x', 1, 180, 420);
dragSplit($('split-right'), $('col-right'), 'x', -1, 220, 520);
dragSplit($('split-json'), $('json-wrap'), 'y', -1, 80, 480);

// ── Helpers ─────────────────────────────────────────────────────────────────────
function blankEffect(): EffectDef {
  return {
    schemaVersion: 1,
    id: 'new_effect',
    duration: 0.4,
    loop: false,
    defaultColor: toHexString(0x222222),
    sfxKey: null,
    layers: [{ type: 'ring', params: { radius: { from: 0, to: 24 }, alpha: { from: 1, to: 0 }, lineWidth: 2 } }],
  };
}
function autosaveLabel(s: AutosaveState): string {
  return s === 'saved' ? '已自动保存' : s === 'saving' ? '保存中…' : '未保存…';
}
function round(n: number): number { return Math.round(n * 100) / 100; }

// ── Boot ────────────────────────────────────────────────────────────────────────
void lib.bootstrap().then(() => {
  fullRender();
  updateTimelineReadout();
  setStatus('就绪 — 特效库已载入', 'ok');
});
