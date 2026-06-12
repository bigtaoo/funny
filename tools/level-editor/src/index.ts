import { parseLevelDefinition, LevelParseError } from '@game/campaign/levelSchema';
import type { LevelDefinition } from '@game/campaign/LevelDefinition';
import sampleLevel from '@game/campaign/levels/ch1_lv1.json';

/**
 * P-B scaffold entry.
 *
 * Proves the two load-bearing claims of the editor architecture before any
 * visual editing is built (see tools/level-editor/DESIGN.md §6.5, phase P-B):
 *   1. the editor can import the game's pure-data level schema directly
 *      (`@game/*` alias → code/src/game), and
 *   2. a level JSON round-trips: import → parseLevelDefinition → export an
 *      equivalent JSON.
 *
 * The UI is a deliberately bare two-pane JSON in/out + validate + import/export.
 * The board grid (P-C), wave timeline (P-D), and form fields (P-E) replace it.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const inputEl = $<HTMLTextAreaElement>('input');
const outputEl = $<HTMLTextAreaElement>('output');
const statusEl = $<HTMLDivElement>('status');

/** Last successfully validated level — what "Export" writes. */
let validated: LevelDefinition | null = null;

function setStatus(message: string, kind: 'ok' | 'err' | '' = ''): void {
  statusEl.className = `status ${kind}`.trim();
  statusEl.textContent = message;
}

/** Run the shared game-side validator on the input pane's JSON. */
function validate(): boolean {
  validated = null;
  let raw: unknown;
  try {
    raw = JSON.parse(inputEl.value);
  } catch (e) {
    outputEl.value = '';
    setStatus(`JSON 解析失败：${(e as Error).message}`, 'err');
    return false;
  }
  try {
    const level = parseLevelDefinition(raw);
    validated = level;
    outputEl.value = JSON.stringify(level, null, 2);
    setStatus(`✓ 校验通过 — 关卡 "${level.id}"，${level.waves.entries.length} 条波次`, 'ok');
    return true;
  } catch (e) {
    outputEl.value = '';
    if (e instanceof LevelParseError) {
      setStatus(`✗ 校验失败 @ ${e.path}: ${e.message.slice(e.path.length + 2)}`, 'err');
    } else {
      setStatus(`✗ 校验失败：${(e as Error).message}`, 'err');
    }
    return false;
  }
}

function loadSample(): void {
  inputEl.value = JSON.stringify(sampleLevel, null, 2);
  validate();
}

async function importJson(): Promise<void> {
  // File System Access API where available; fall back to a hidden <input>.
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as unknown as {
        showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [{ description: 'Level JSON', accept: { 'application/json': ['.json'] } }],
      });
      const file = await handle.getFile();
      inputEl.value = await file.text();
      validate();
    } catch {
      /* user cancelled */
    }
    return;
  }
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.json,application/json';
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (file) {
      inputEl.value = await file.text();
      validate();
    }
  };
  picker.click();
}

async function exportJson(): Promise<void> {
  if (!validate() || !validated) {
    setStatus('导出已阻止 — 先修正校验错误', 'err');
    return;
  }
  const text = JSON.stringify(validated, null, 2) + '\n';
  const fileName = `${validated.id}.json`;

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as unknown as {
        showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName: validated.id, // extension added by the accept type
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
      return; // user cancelled
    }
  }

  // Fallback: <a download>.
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`✓ 已下载 ${fileName}`, 'ok');
}

$('btn-sample').addEventListener('click', loadSample);
$('btn-import').addEventListener('click', () => void importJson());
$('btn-validate').addEventListener('click', () => validate());
$('btn-export').addEventListener('click', () => void exportJson());

// Boot with the sample so the round-trip is visible immediately.
loadSample();
