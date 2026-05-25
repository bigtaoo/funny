/**
 * JSON export and import for the full animation store.
 */
import type { AnimationStore, AnimationClip, Keyframe } from './types';
import { state } from './state';
import { emit, STATUS } from './events';

interface ExportFormat {
  version: number;
  animations: AnimationStore;
}

// ── Export ────────────────────────────────────────────────────────────────────

export function exportJSON(): void {
  const payload: ExportFormat = {
    version: 1,
    animations: Object.fromEntries(
      Object.entries(state.animations).map(([name, clip]) => [
        name,
        {
          duration: clip.duration,
          loop: clip.loop,
          keyframes: clip.keyframes.map(kf => ({
            time: kf.time,
            bones: { ...kf.bones },
          })),
        },
      ]),
    ),
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'stickman-animations.json';
  a.click();
  URL.revokeObjectURL(url);
  emit(STATUS, 'Exported stickman-animations.json');
}

// ── Import ────────────────────────────────────────────────────────────────────

/**
 * Parse and merge animations from JSON text into the store.
 * Returns the name of the first imported animation, or null on error.
 */
export function importJSON(
  jsonText: string,
  onSuccess: (firstName: string) => void,
): void {
  try {
    const parsed = JSON.parse(jsonText) as Partial<ExportFormat>;
    if (!parsed.animations || typeof parsed.animations !== 'object') {
      throw new Error('Missing "animations" key');
    }

    let count = 0;
    let firstName = '';

    for (const [name, raw] of Object.entries(parsed.animations)) {
      const clip: AnimationClip = {
        duration:  typeof raw.duration === 'number' ? raw.duration : 0.5,
        loop:      raw.loop !== false,
        keyframes: Array.isArray(raw.keyframes)
          ? raw.keyframes.map((kf): Keyframe => ({
              time:  typeof kf.time === 'number' ? kf.time : 0,
              bones: kf.bones && typeof kf.bones === 'object' ? { ...kf.bones } : {},
            }))
          : [],
      };
      state.animations[name] = clip;
      if (count === 0) firstName = name;
      count++;
    }

    emit(STATUS, `Imported ${count} animation(s)`);
    if (firstName) onSuccess(firstName);
  } catch (err) {
    emit(STATUS, `Import error: ${(err as Error).message}`);
  }
}

// ── Wire file input ───────────────────────────────────────────────────────────

export function initIO(onImportSuccess: (name: string) => void): void {
  const fileInput = document.getElementById('file-input') as HTMLInputElement;

  document.getElementById('btn-export')!.addEventListener('click', exportJSON);
  document.getElementById('btn-import')!.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', e => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => importJSON(ev.target!.result as string, onImportSuccess);
    reader.readAsText(file);
    fileInput.value = '';
  });
}
