import { parseLevelDefinition, LevelParseError } from '@game/campaign/levelSchema';
import type { LevelDefinition } from '@game/campaign/LevelDefinition';
import sampleLevel from '@game/campaign/levels/ch1_lv1.json';
import { EditorState } from './state/EditorState';
import { BoardPanel } from './board/BoardPanel';
import { TimelinePanel } from './timeline/TimelinePanel';
import { InspectorPanel } from './inspector/InspectorPanel';
import { LevelFormPanel } from './inspector/LevelFormPanel';

/**
 * Editor entry / composition root (P-C).
 *
 * Wires the central {@link EditorState} to the board grid panel and a live JSON
 * pane. Board edits mutate the state, which re-renders both the canvas and the
 * JSON text; conversely the JSON pane can be hand-edited and applied back
 * through the shared game-side validator (`parseLevelDefinition`).
 *
 * The wave timeline (P-D) and form fields (P-E) become additional panels bound
 * to the same EditorState.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const jsonEl = $<HTMLTextAreaElement>('json');
const statusEl = $<HTMLDivElement>('status');

function setStatus(message: string, kind: 'ok' | 'err' | '' = ''): void {
  statusEl.className = `status ${kind}`.trim();
  statusEl.textContent = message;
}

/** Validate raw JSON via the shared game-side schema. */
function parse(raw: unknown): LevelDefinition | null {
  try {
    return parseLevelDefinition(raw);
  } catch (e) {
    if (e instanceof LevelParseError) setStatus(`✗ ${e.message}`, 'err');
    else setStatus(`✗ ${(e as Error).message}`, 'err');
    return null;
  }
}

const initial = parse(sampleLevel)!;
const state = new EditorState(initial);
const board = new BoardPanel(state, $('board-mount'), () => refreshTools());
new TimelinePanel(state, $('timeline-mount'));
new InspectorPanel(state, $('inspector'));
new LevelFormPanel(state, $('level-form'));

// ── Right-column tabs (level form / wave inspector) ──
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.insp-tab'));
function showTab(tab: 'level' | 'wave'): void {
  for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === tab);
  $('level-form').style.display = tab === 'level' ? '' : 'none';
  $('inspector').style.display = tab === 'wave' ? '' : 'none';
}
for (const b of tabButtons) b.addEventListener('click', () => showTab(b.dataset.tab as 'level' | 'wave'));
// Auto-jump to the wave tab when a block is selected in the timeline.
let prevSelected = state.selectedWave;
state.on(() => {
  if (state.selectedWave !== null && prevSelected === null) showTab('wave');
  prevSelected = state.selectedWave;
});

// ── State → JSON text (re-render on every change) ──
function refreshJson(): void {
  jsonEl.value = JSON.stringify(state.level, null, 2);
}
state.on(refreshJson);
refreshJson();

// ── Paint-tool buttons ──
const toolButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.board-tools .tool'));
function refreshTools(): void {
  for (const b of toolButtons) b.classList.toggle('active', b.dataset.tool === board.getTool());
}
for (const b of toolButtons) {
  b.addEventListener('click', () => board.setTool(b.dataset.tool as 'noBuild' | 'blocked' | 'erase' | 'wp' | 'escort'));
}
refreshTools();

// ── Apply hand-edited JSON back into the editor ──
$('btn-apply').addEventListener('click', () => {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonEl.value);
  } catch (e) {
    setStatus(`JSON 解析失败：${(e as Error).message}`, 'err');
    return;
  }
  const level = parse(raw);
  if (!level) return;
  state.setLevel(level);
  setStatus(`✓ 已应用 — 关卡 "${level.id}"`, 'ok');
});

// ── Load bundled sample ──
$('btn-sample').addEventListener('click', () => {
  const level = parse(sampleLevel);
  if (level) {
    state.setLevel(level);
    setStatus('✓ 已载入示例 ch1_lv1', 'ok');
  }
});

// ── Import .json ──
$('btn-import').addEventListener('click', () => void importJson());
async function importJson(): Promise<void> {
  const apply = (text: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      setStatus(`JSON 解析失败：${(e as Error).message}`, 'err');
      return;
    }
    const level = parse(raw);
    if (level) {
      state.setLevel(level);
      setStatus(`✓ 已导入 "${level.id}"`, 'ok');
    }
  };

  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as unknown as {
        showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [{ description: 'Level JSON', accept: { 'application/json': ['.json'] } }],
      });
      apply(await (await handle.getFile()).text());
    } catch {
      /* cancelled */
    }
    return;
  }
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.json,application/json';
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (file) apply(await file.text());
  };
  picker.click();
}

// ── Export .json (re-validates the working state) ──
$('btn-export').addEventListener('click', () => void exportJson());
async function exportJson(): Promise<void> {
  const level = parse(state.level);
  if (!level) {
    setStatus('导出已阻止 — 当前关卡未通过校验', 'err');
    return;
  }
  const text = JSON.stringify(level, null, 2) + '\n';
  const fileName = `${level.id}.json`;

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as unknown as {
        showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName: level.id,
        types: [{ description: 'Level JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await (handle as unknown as {
        createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }>;
      }).createWritable();
      await writable.write(text);
      await writable.close();
      setStatus(`✓ 已保存 ${fileName}`, 'ok');
      return;
    } catch {
      return;
    }
  }
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`✓ 已下载 ${fileName}`, 'ok');
}

// ── Resizable panels ─────────────────────────────────────────────────────────
// Drag the vertical bars to widen the board / inspector columns, the horizontal
// bar to retune the timeline-vs-JSON split. The board canvas auto-refits via its
// own ResizeObserver; the timeline likewise. Pure layout — no level data changes.
function dragSplit(
  splitter: HTMLElement,
  target: HTMLElement,
  axis: 'x' | 'y',
  dir: 1 | -1,
  min: number,
  max: number,
  onResize?: () => void,
): void {
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = axis === 'x' ? target.offsetWidth : target.offsetHeight;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent): void => {
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      const next = Math.max(min, Math.min(max, startSize + dir * (pos - startPos)));
      if (axis === 'x') {
        target.style.flex = `0 0 ${next}px`;
        target.style.width = `${next}px`;
      } else {
        target.style.flex = `0 0 ${next}px`;
        target.style.height = `${next}px`;
      }
      onResize?.();
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

dragSplit($('split-board'), $<HTMLElement>('col-board'), 'x', 1, 260, 820, () => board.resize());
dragSplit($('split-insp'), $<HTMLElement>('col-insp'), 'x', -1, 200, 560);
dragSplit($('split-json'), $<HTMLElement>('json-wrap'), 'y', -1, 90, 520);
window.addEventListener('resize', () => board.resize());

setStatus('就绪 — 载入示例 ch1_lv1');
