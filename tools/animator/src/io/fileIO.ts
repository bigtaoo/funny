// IOController's disk/File-System-Access-API plumbing, extracted as form① free functions
// (claudedocs/client-modules.md "单文件 500 行收敛") — pure utilities and one shared save
// helper, none of them need any IOController instance state.

/** Minimal duck-typed shape of a `FileSystemFileHandle` (File System Access API), which
 *  TS's default lib doesn't declare — kept local rather than pulling in `@types/wicg-*`. */
export interface WritableFileHandle {
  /** The chosen file's NAME only — the File System Access API never hands out a path.
   *  Optional because the Firefox/Safari download fallback produces no handle at all. */
  readonly name?: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }>;
}

/** True when running inside the desktop shell (NW Tool), which does real disk I/O via
 *  IPC instead of the browser's sandboxed File System Access API. */
export function isDesktop(): boolean {
  return !!window.nwDesktop?.fs;
}

/** Clamp a bake factor to (0, 1]: never upscale the source, never produce a zero-size image. */
export function clamp01(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(1, v);
}

export function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (b) resolve(b);
      else   reject(new Error('canvas.toBlob returned null'));
    }, 'image/png');
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** First accepted extension declared in `types` (e.g. ".taoeditor"), or '' if none. */
function primaryExt(types: Array<{ accept: Record<string, string[]> }>): string {
  for (const t of types) {
    for (const exts of Object.values(t.accept)) {
      if (exts[0]) return exts[0];
    }
  }
  return '';
}

/** Guarantee `name` ends with exactly one `ext`. Collapses an accidentally
 *  doubled extension (e.g. "x.taoeditor.taoeditor" → "x.taoeditor") and appends
 *  `ext` when missing, so the File System Access picker cannot re-append one
 *  (Chrome appends the accepted extension whenever the chosen name doesn't
 *  already end with it). The single-dot ".taoeditor" is itself the fix for the
 *  worse case: the compound ".tao.editor" it replaced got double-appended by
 *  Chrome, which is how "max.tao.editor.tao.editor" ended up in the repo. */
function ensureSingleExt(name: string, ext: string): string {
  if (!ext) return name;
  const lower = ext.toLowerCase();
  let n = name;
  while (n.toLowerCase().endsWith(lower + lower)) n = n.slice(0, -ext.length);
  if (!n.toLowerCase().endsWith(lower)) n += ext;
  return n;
}

/** What a `saveWithPicker` call actually did, so the caller can say where the bytes went
 *  instead of a bare "saved". Distinguishing the download fallback from a cancel is the
 *  point: both used to come back as a plain `null`, so Firefox's successful download was
 *  reported as nothing at all. */
export interface SaveOutcome {
  /** The file to reuse for silent overwrites, or null in the download fallback —
   *  a downloaded file leaves nothing behind that can be written to again. */
  handle: WritableFileHandle | null;
  /** The filename actually written. The API never reveals the directory. */
  name: string;
}

/** Save blob via the File System Access API (native save dialog with folder + filename).
 *  Falls back to a filename prompt + triggerDownload for browsers without the API
 *  (e.g. Firefox). Returns null ONLY when the user cancelled.
 *  `startIn`, when given, biases the dialog to open near that handle's location. */
export async function saveWithPicker(
  blob: Blob,
  suggestedName: string,
  types: Array<{ description?: string; accept: Record<string, string[]> }>,
  startIn?: WritableFileHandle | null,
): Promise<SaveOutcome | null> {
  // Pass a name that already carries exactly one canonical extension so neither
  // the native picker nor the user prompt can produce a doubled ".taoeditor".
  const ext       = primaryExt(types);
  const suggested = ensureSingleExt(suggestedName, ext);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const picker = (window as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: WritableFileHandle;
    try {
      handle = await picker({ suggestedName: suggested, types, ...(startIn ? { startIn } : {}) });
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;  // user cancelled
      throw e;
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return { handle, name: handle.name ?? suggested };
  } else {
    // Firefox / Safari fallback: prompt for filename, then trigger download.
    // The save path is controlled by the browser's download settings
    // (Firefox: Settings → Downloads → "Always ask you where to save files").
    const name = window.prompt('Save as:', suggested);
    if (name === null) return null;  // user cancelled
    const written = ensureSingleExt(name.trim() || suggested, ext);
    triggerDownload(blob, written);
    return { handle: null, name: written };
  }
}

/** Make `name` usable as a filename on every platform: drop the characters no filesystem
 *  accepts, collapse whitespace, and fall back to `fallback` when nothing usable is left.
 *  A project called "Untitled" or "狗 v2" should reach the save dialog as itself; one
 *  called "a/b" must not turn into a directory. */
export function sanitizeFilename(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '')     // illegal on at least one target filesystem
    .replace(/\s+/g, ' ')             // tabs/newlines collapse to a space — they separate words
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')  // the rest (NUL and friends) separate nothing; drop them
    .trim();
  return cleaned || fallback;
}

/** Filename portion of an absolute disk path (desktop shell paths only need `\`/`/`). */
export function basename(path: string): string {
  return path.replace(/^.*[\\/]/, '');
}

/** Same-directory `.tao` path for the loaded `.taoeditor` file, e.g.
 *  `…\runner\runner.taoeditor` → `…\runner\runner.tao`. Also strips the legacy
 *  `.tao.editor` suffix, so opening a project saved before the rename still
 *  exports next to it instead of producing `runner.tao.editor.tao`. */
export function deriveTaoPath(editorPath: string): string {
  for (const suffix of ['.taoeditor', '.tao.editor']) {
    if (editorPath.toLowerCase().endsWith(suffix)) {
      return editorPath.slice(0, -suffix.length) + '.tao';
    }
  }
  return `${editorPath}.tao`;
}
