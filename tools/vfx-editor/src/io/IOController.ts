/**
 * IOController.ts — import/export a single effect's JSON file.
 *
 * Export re-validates through the game-side parseEffectDef so a downloaded file
 * is guaranteed to load at runtime; the user then drops it into
 * client/src/effects/ (DESIGN §8 write-back flow, manual). Import reads a .json from
 * disk and validates it the same way.
 */
import { parseEffectDef } from '@vfx/parseEffectDef';
import { EffectDef } from '@vfx/types';

/** Validate raw JSON via the shared game-side gate. Returns null + reports on error. */
export function validate(raw: unknown, source: string, onError: (m: string) => void): EffectDef | null {
  try {
    return parseEffectDef(raw, source);
  } catch (e) {
    onError((e as Error).message);
    return null;
  }
}

/** Download one effect as `<id>.json`. Re-validates before writing. */
export async function exportEffect(
  def: EffectDef,
  onOk: (m: string) => void,
  onError: (m: string) => void,
): Promise<void> {
  const checked = validate(def, `${def.id}.json`, onError);
  if (!checked) { onError('Export blocked — current effect failed validation'); return; }
  const text = JSON.stringify(checked, null, 2) + '\n';
  const fileName = `${checked.id}.json`;

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as unknown as {
        showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'VFX JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await (handle as unknown as {
        createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }>;
      }).createWritable();
      await writable.write(text);
      await writable.close();
      onOk(`✓ Saved ${fileName} — manually place in client/src/effects/ and build`);
      return;
    } catch {
      return; // cancelled
    }
  }

  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  onOk(`✓ Downloaded ${fileName} — manually place in client/src/effects/ and build`);
}

/** Open a .json from disk and return the validated EffectDef. */
export async function importEffect(
  onOk: (def: EffectDef) => void,
  onError: (m: string) => void,
): Promise<void> {
  const apply = (text: string): void => {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) { onError(`JSON parse failed: ${(e as Error).message}`); return; }
    const def = validate(raw, 'import', onError);
    if (def) onOk(def);
  };

  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as unknown as {
        showOpenFilePicker: (o: unknown) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [{ description: 'VFX JSON', accept: { 'application/json': ['.json'] } }],
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
