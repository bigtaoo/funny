// IOController's `.tao.editor` save/load flow (io/editorProject.ts). Drives the real function
// bodies against real AppState/AnimationController/CommandManager/EventBus instances (all PIXI-
// free) plus a real JSZip (round-trips an actual zip archive, not a mocked one) and a hand-rolled
// fake ImageController (the one dependency here that needs real `pixi.js` texture creation, which
// this editor has no headless harness for — see vitest.config.ts's header comment). `window`/
// `document` are stubbed only where a test actually exercises the disk-identity branches.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { EventBus, type AppEvents } from '../src/core/EventBus';
import { AppState } from '../src/core/AppState';
import { AnimationController } from '../src/animation/AnimationController';
import { CommandManager } from '../src/core/CommandManager';
import type { AttachmentPoint, SpriteBinding } from '../src/core/types';

function binding(overrides: Partial<SpriteBinding> = {}): SpriteBinding {
  return { anchorX: 0.5, anchorY: 1, flipX: false, zOrder: 0, rotation: 0, scaleX: 1, scaleY: 1, ...overrides };
}
import {
  buildEditorBlob, saveEditorProject, saveEditorProjectAs, loadEditorProject, loadEditorBlob,
  triggerLoadEditor, type EditorProjectHost,
} from '../src/io/editorProject';
import type { WritableFileHandle } from '../src/io/fileIO';

/** Minimal ImageController stand-in — editorProject.ts only ever calls getBlob/setBlob on it. */
function fakeImageCtrl(blobs: Record<string, Blob> = {}) {
  const store = new Map(Object.entries(blobs));
  const set: Array<{ slotId: string; blob: Blob; name: string }> = [];
  return {
    getBlob: (slotId: string) => store.get(slotId),
    setBlob: async (slotId: string, blob: Blob, name: string) => { store.set(slotId, blob); set.push({ slotId, blob, name }); },
    _set: set,
  };
}

function makeHost(opts: { blobs?: Record<string, Blob> } = {}): EditorProjectHost & { events: Array<{ event: string; payload: unknown }> } {
  const bus = new EventBus<AppEvents>();
  const state = new AppState(bus);
  const animCtrl = new AnimationController(bus, state);
  const cmdManager = new CommandManager(bus);
  const events: Array<{ event: string; payload: unknown }> = [];
  bus.on('status', (p) => events.push({ event: 'status', payload: p }));
  bus.on('error', (p) => events.push({ event: 'error', payload: p }));
  let editorFilePath: string | null = null;
  let editorFileHandle: WritableFileHandle | null = null;
  let taoFileHandle: WritableFileHandle | null = null;
  return {
    state, animCtrl, cmdManager, bus,
    imageCtrl: fakeImageCtrl(opts.blobs) as unknown as EditorProjectHost['imageCtrl'],
    get editorFilePath() { return editorFilePath; },
    set editorFilePath(v) { editorFilePath = v; },
    get editorFileHandle() { return editorFileHandle; },
    set editorFileHandle(v) { editorFileHandle = v; },
    get taoFileHandle() { return taoFileHandle; },
    set taoFileHandle(v) { taoFileHandle = v; },
    events,
  };
}

// JSZip's Blob-reading path (utils.js's prepareContent) only engages when a global `FileReader`
// exists — real in every browser, absent in plain Node. Node's native `Blob` already has
// `arrayBuffer()`, so a minimal FileReader shim backed by it is enough to let JSZip.loadAsync
// actually read the real Blobs `buildEditorBlob` produces, without mocking JSZip itself.
class NodeFileReader {
  onload: ((e: { target: { result: unknown } }) => void) | null = null;
  onerror: ((e: { target: { error: unknown } }) => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer()
      .then((buf) => this.onload?.({ target: { result: buf } }))
      .catch((err) => this.onerror?.({ target: { error: err } }));
  }
}

beforeEach(() => {
  vi.stubGlobal('FileReader', NodeFileReader);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildEditorBlob / loadEditorBlob — round trip', () => {
  it('restores bindings, animations, attachment points, bone length scales, and image blobs', async () => {
    const pngBlob = new Blob(['fake-png-bytes'], { type: 'image/png' });
    const host = makeHost({ blobs: { spine: pngBlob } });
    host.state.setBinding('spine', binding({ scaleX: 1.5, scaleY: 1.5 }));
    host.animCtrl.loadClip('idle', { duration: 400, loop: true, keyframes: [{ time: 0, bones: new Map([['spine', { rotation: 10 }]]) }] });
    host.animCtrl.selectClip('idle');
    host.state.setAllAttachmentPoints([{ id: 'hit', label: 'Hit', parentBone: 'spine', offsetX: 0, offsetY: -30 } as AttachmentPoint]);
    host.state.setLengthScale('spine', 1.3);
    host.state.setPreviewMode('sprite');

    const blob = await buildEditorBlob(host);
    expect(blob.size).toBeGreaterThan(0);

    // The archive itself is a real zip with the documented layout (claudedocs/file-formats.md).
    const zip = await JSZip.loadAsync(blob);
    expect(zip.file('editor.json')).not.toBeNull();
    expect(zip.file('images/spine.png')).not.toBeNull();
    const projectJson = JSON.parse(await zip.file('editor.json')!.async('string'));
    expect(projectJson.version).toBe(1);
    expect(projectJson.bindings.spine).toMatchObject({ scaleX: 1.5, scaleY: 1.5 });
    expect(projectJson.boneLengthScales).toEqual({ spine: 1.3 });

    // Fresh host — restore from the built blob.
    const host2 = makeHost();
    const ok = await loadEditorBlob(host2, blob, 'runner.tao.editor');
    expect(ok).toBe(true);
    expect(host2.state.getBinding('spine')).toMatchObject({ scaleX: 1.5, scaleY: 1.5 });
    expect(host2.animCtrl.store.get('idle')).toMatchObject({ duration: 400, loop: true });
    expect(host2.animCtrl.currentName).toBe('idle');
    expect(host2.state.attachmentPoints.get('hit')).toMatchObject({ label: 'Hit', parentBone: 'spine' });
    expect(host2.state.getLengthScale('spine')).toBe(1.3);
    expect(host2.state.previewMode).toBe('sprite');
    expect((host2.imageCtrl as unknown as { _set: unknown[] })._set).toHaveLength(1);
    expect(host2.events.some((e) => e.event === 'status' && String(e.payload).startsWith('Loaded'))).toBe(true);
  });

  it('omits boneLengthScales from the JSON entirely when every scale is the default 1.0 (sparse map)', async () => {
    const host = makeHost();
    const blob = await buildEditorBlob(host);
    const zip = await JSZip.loadAsync(blob);
    const projectJson = JSON.parse(await zip.file('editor.json')!.async('string'));
    expect(projectJson).not.toHaveProperty('boneLengthScales');
  });

  it('loadEditorBlob resets any previously-remembered disk identity before restoring', async () => {
    const blob = await buildEditorBlob(makeHost());
    const host = makeHost();
    host.editorFilePath = '/old/path.tao.editor';
    host.editorFileHandle = {} as WritableFileHandle;
    host.taoFileHandle = {} as WritableFileHandle;
    await loadEditorBlob(host, blob, 'x.tao.editor');
    expect(host.editorFilePath).toBeNull();
    expect(host.editorFileHandle).toBeNull();
    expect(host.taoFileHandle).toBeNull();
  });

  it('rejects an unsupported project version and reports an error without mutating state', async () => {
    const host = makeHost();
    const zip = new JSZip();
    zip.file('editor.json', JSON.stringify({ version: 2, bindings: {}, animations: {}, attachmentPoints: [] }));
    const blob = await zip.generateAsync({ type: 'blob' });

    const ok = await loadEditorBlob(host, blob, 'newer.tao.editor');
    expect(ok).toBe(false);
    expect(host.events.some((e) => e.event === 'error' && String(e.payload).includes('Unsupported editor version 2'))).toBe(true);
  });

  it('a corrupted/non-zip blob fails gracefully (false + error event, no throw)', async () => {
    const host = makeHost();
    const ok = await loadEditorBlob(host, new Blob(['not a zip']), 'broken.tao.editor');
    expect(ok).toBe(false);
    expect(host.events.some((e) => e.event === 'error')).toBe(true);
  });

  it('an archive missing editor.json fails gracefully', async () => {
    const zip = new JSZip();
    zip.file('images/spine.png', 'not-really-a-png');
    const blob = await zip.generateAsync({ type: 'blob' });
    const host = makeHost();
    const ok = await loadEditorBlob(host, blob, 'no-json.tao.editor');
    expect(ok).toBe(false);
    expect(host.events.some((e) => e.event === 'error' && String(e.payload).includes('editor.json missing'))).toBe(true);
  });

  it('falls back to the first stored clip when selectedClip is absent from the archive', async () => {
    const zip = new JSZip();
    zip.file('editor.json', JSON.stringify({
      version: 1, selectedClip: null, previewMode: 'skeleton', bindings: {},
      animations: { idle: { duration: 100, loop: true, keyframes: [] } }, attachmentPoints: [],
    }));
    const blob = await zip.generateAsync({ type: 'blob' });
    const host = makeHost();
    await loadEditorBlob(host, blob, 'x.tao.editor');
    expect(host.animCtrl.currentName).toBe('idle');
  });

  it('loadEditorProject(host, file) is a thin wrapper that forwards the file\'s own name as the label', async () => {
    const blob = await buildEditorBlob(makeHost());
    const file = new File([blob], 'my-rig.tao.editor');
    const host = makeHost();
    const ok = await loadEditorProject(host, file);
    expect(ok).toBe(true);
    expect(host.events.some((e) => e.event === 'status' && String(e.payload) === 'Loaded my-rig.tao.editor')).toBe(true);
  });
});

describe('saveEditorProject', () => {
  it('overwrites via the remembered browser file handle when one is already known (no re-prompt)', async () => {
    const written: Blob[] = [];
    let closed = false;
    const handle: WritableFileHandle = {
      getFile: async () => new File([], 'x'),
      createWritable: async () => ({ write: async (b: Blob) => { written.push(b); }, close: async () => { closed = true; } }),
    };
    const host = makeHost();
    host.editorFileHandle = handle;
    vi.stubGlobal('window', {}); // isDesktop() → false

    await saveEditorProject(host);
    expect(written).toHaveLength(1);
    expect(closed).toBe(true);
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Project saved' });
  });

  it('desktop shell: writes directly to the known path via window.nwDesktop.fs', async () => {
    const writeFile = vi.fn(async (_path: string, _buf: ArrayBuffer) => ({ ok: true }));
    vi.stubGlobal('window', { nwDesktop: { fs: { writeFile } } });
    const host = makeHost();
    host.editorFilePath = 'C:\\rig\\runner.tao.editor';

    await saveEditorProject(host);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0]![0]).toBe('C:\\rig\\runner.tao.editor');
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Project saved' });
  });

  it('desktop shell: a failed write reports an error, not a thrown exception', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { writeFile: async () => ({ ok: false, error: 'disk full' }) } } });
    const host = makeHost();
    host.editorFilePath = 'C:\\rig\\runner.tao.editor';
    await expect(saveEditorProject(host)).resolves.toBeUndefined();
    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Save failed: disk full' });
  });
});

describe('saveEditorProjectAs', () => {
  it('browser: remembers the newly-picked handle as the editing target going forward', async () => {
    const handle: WritableFileHandle = {
      getFile: async () => new File([], 'x'),
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    };
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn(async () => handle) });
    const host = makeHost();
    await saveEditorProjectAs(host);
    expect(host.editorFileHandle).toBe(handle);
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Saved a copy — now editing that file' });
  });

  it('desktop shell: cancelling the save-as dialog leaves the host untouched and emits nothing further', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs: async () => ({ canceled: true }) } } });
    const host = makeHost();
    host.editorFilePath = 'C:\\rig\\runner.tao.editor';
    await saveEditorProjectAs(host);
    expect(host.editorFilePath).toBe('C:\\rig\\runner.tao.editor'); // unchanged — cancel never overwrote it
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Saving a copy…' }); // no follow-up status/error
  });
});

// ── "Load .editor" entry points (ADR-070 Phase 4d) ───────────────────────────────────────────
// triggerLoadEditor() is a three-way triage over what the host environment offers, and all three
// arms were uncovered. Each arm ends somewhere different (IPC / File System Access handle / a bare
// file input with NO handle retained), and which one you land in decides whether the next Save
// silently overwrites or re-prompts — so the arms are pinned by their SIDE EFFECT on the host's
// disk identity, not just by "the right function ran".

/** A handle whose getFile() returns `file` and whose writes are recorded. */
function pickerHandle(file: File, written: Blob[] = []): WritableFileHandle {
  return {
    getFile: async () => file,
    createWritable: async () => ({ write: async (b: Blob) => { written.push(b); }, close: async () => {} }),
  };
}

/** A real `.tao.editor` archive for the load paths to actually parse. */
async function editorArchive(): Promise<Blob> {
  const src = makeHost();
  src.state.setBinding('spine', binding({ scaleX: 1.25 }));
  src.animCtrl.loadClip('idle', { duration: 0.5, loop: true, keyframes: [{ time: 0, bones: new Map([['spine', { rotation: 11 }]]) }] });
  src.animCtrl.selectClip('idle');
  return buildEditorBlob(src);
}

describe('triggerLoadEditor', () => {
  it('desktop shell: reads the file over IPC and remembers its path for later saves', async () => {
    const archive = await editorArchive();
    const openFile = vi.fn(async (_filters: Array<{ name: string; extensions: string[] }>) => ({
      canceled: false, path: 'C:\\rig\\runner.tao.editor', data: await archive.arrayBuffer(),
    }));
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });
    const host = makeHost();

    await triggerLoadEditor(host);

    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile.mock.calls[0]![0]).toEqual([{ name: 'Tao Editor Project', extensions: ['tao.editor'] }]);
    expect(host.editorFilePath).toBe('C:\\rig\\runner.tao.editor');
    expect(host.state.getBinding('spine')!.scaleX).toBe(1.25);   // the archive really was applied
    // The status label is the file's basename, not its full path.
    expect(host.events.some((e) => e.event === 'status' && String(e.payload).includes('runner.tao.editor'))).toBe(true);
  });

  it('desktop shell: a cancelled dialog changes nothing at all', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile: async () => ({ canceled: true }) } } });
    const host = makeHost();
    host.state.setBinding('spine', binding({ scaleX: 9 }));
    host.events.length = 0;

    await triggerLoadEditor(host);

    expect(host.editorFilePath).toBeNull();
    expect(host.state.getBinding('spine')!.scaleX).toBe(9);   // state untouched
    expect(host.events).toEqual([]);
  });

  it('desktop shell: an IPC error is reported and the path stays unset', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile: async () => ({ canceled: false, error: 'permission denied' }) } } });
    const host = makeHost();

    await triggerLoadEditor(host);

    expect(host.editorFilePath).toBeNull();
    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Load failed: permission denied' });
  });

  it('desktop shell: a truthy result with no data is reported rather than parsed as an empty zip', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile: async () => ({ canceled: false, path: 'C:\\x.tao.editor' }) } } });
    const host = makeHost();

    await triggerLoadEditor(host);

    expect(host.editorFilePath).toBeNull();
    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Load failed: unknown error' });
  });

  it('desktop shell: a corrupt archive leaves the path unset — it is only remembered on success', async () => {
    const openFile = async () => ({
      canceled: false, path: 'C:\\rig\\broken.tao.editor',
      data: await new Blob(['not a zip at all']).arrayBuffer(),
    });
    vi.stubGlobal('window', { nwDesktop: { fs: { openFile } } });
    const host = makeHost();

    await triggerLoadEditor(host);

    expect(host.editorFilePath).toBeNull();
    expect(host.events.some((e) => e.event === 'error')).toBe(true);
  });

  it('browser with File System Access: remembers the handle so Save can overwrite silently', async () => {
    const archive = await editorArchive();
    const file = new File([await archive.arrayBuffer()], 'runner.tao.editor');
    const handle = pickerHandle(file);
    const picker = vi.fn(async (_opts: unknown) => [handle]);
    vi.stubGlobal('window', { showOpenFilePicker: picker });
    const host = makeHost();

    await triggerLoadEditor(host);

    expect(picker).toHaveBeenCalledTimes(1);
    expect(host.editorFileHandle).toBe(handle);
    expect(host.editorFilePath).toBeNull();          // the browser arm has no path, only a handle
    expect(host.state.getBinding('spine')!.scaleX).toBe(1.25);
  });

  it('browser: cancelling the picker (AbortError) is silent — not an error toast', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    vi.stubGlobal('window', { showOpenFilePicker: async () => { throw abort; } });
    const host = makeHost();
    host.events.length = 0;

    await triggerLoadEditor(host);

    expect(host.editorFileHandle).toBeNull();
    expect(host.events).toEqual([]);
  });

  it('browser: any other picker failure IS reported', async () => {
    vi.stubGlobal('window', { showOpenFilePicker: async () => { throw new Error('picker exploded'); } });
    const host = makeHost();

    await triggerLoadEditor(host);

    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Load failed: picker exploded' });
  });

  it('browser: a corrupt archive leaves the handle unset', async () => {
    const handle = pickerHandle(new File(['garbage'], 'broken.tao.editor'));
    vi.stubGlobal('window', { showOpenFilePicker: async () => [handle] });
    const host = makeHost();

    await triggerLoadEditor(host);

    expect(host.editorFileHandle).toBeNull();
    expect(host.events.some((e) => e.event === 'error')).toBe(true);
  });

  // Firefox/Safari: no IPC, no picker. Falls back to clicking a hidden <input type=file>, whose
  // change handler (wired in IOController) calls loadEditorProject. Nothing is remembered, which
  // is exactly why Save re-prompts on those browsers.
  it('no IPC and no picker: clicks the hidden file input and retains no disk identity', async () => {
    const click = vi.fn();
    const getElementById = vi.fn((id: string) => (id === 'editor-file-input' ? { click } : null));
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { getElementById });
    const host = makeHost();

    await triggerLoadEditor(host);

    expect(click).toHaveBeenCalledTimes(1);
    expect(getElementById.mock.calls[0]![0]).toBe('editor-file-input');
    expect(host.editorFilePath).toBeNull();
    expect(host.editorFileHandle).toBeNull();
  });

  it('no IPC, no picker, and no file input either: does not throw', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { getElementById: () => null });
    const host = makeHost();

    await expect(triggerLoadEditor(host)).resolves.toBeUndefined();
  });
});

describe('saveEditorProject — first save of a brand-new project', () => {
  it('browser: asks for a location once, then remembers the handle', async () => {
    const written: Blob[] = [];
    const handle = pickerHandle(new File([], 'x'), written);
    const picker = vi.fn(async (_opts: { suggestedName: string }) => handle);
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    const host = makeHost();
    expect(host.editorFileHandle).toBeNull();

    await saveEditorProject(host);

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0]![0]).toMatchObject({ suggestedName: 'project.tao.editor' });
    expect(host.editorFileHandle).toBe(handle);
    expect(written).toHaveLength(1);
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Project saved' });

    // …and the second save must NOT ask again.
    await saveEditorProject(host);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(2);
  });

  it('desktop shell: no known path yet → save-as dialog, whose result becomes the path', async () => {
    const saveFileAs = vi.fn(async (_opts: { defaultPath?: string; filters: unknown[] }) => ({ canceled: false, path: 'C:\\rig\\new.tao.editor' }));
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs, writeFile: vi.fn() } } });
    const host = makeHost();

    await saveEditorProject(host);

    expect(saveFileAs).toHaveBeenCalledTimes(1);
    expect(saveFileAs.mock.calls[0]![0]).toEqual({
      defaultPath: undefined,
      filters: [{ name: 'Tao Editor Project', extensions: ['tao.editor'] }],
    });
    expect(host.editorFilePath).toBe('C:\\rig\\new.tao.editor');
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Project saved' });
  });

  it('desktop shell: a failed save-as reports the error and leaves the path unset', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs: async () => ({ canceled: false, error: 'read-only volume' }) } } });
    const host = makeHost();

    await saveEditorProject(host);

    expect(host.editorFilePath).toBeNull();
    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Save failed: read-only volume' });
  });

  it('desktop shell: a save-as that returns neither error nor path still fails loudly', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs: async () => ({ canceled: false }) } } });
    const host = makeHost();

    await saveEditorProject(host);

    expect(host.editorFilePath).toBeNull();
    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Save failed: save failed' });
  });
});

describe('saveEditorProjectAs — desktop shell', () => {
  it('writes a copy, retargets Save at it, and reports the basename only', async () => {
    const saveFileAs = vi.fn(async (_opts: { defaultPath?: string; filters: unknown[] }) => ({ canceled: false, path: 'C:\\rig\\copies\\runner-v2.tao.editor' }));
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs } } });
    const host = makeHost();
    host.editorFilePath = 'C:\\rig\\runner.tao.editor';

    await saveEditorProjectAs(host);

    // The old path is offered as the dialog's starting point…
    expect(saveFileAs.mock.calls[0]![0]).toMatchObject({ defaultPath: 'C:\\rig\\runner.tao.editor' });
    // …and the new one replaces it, so subsequent Saves overwrite the copy (Word/Photoshop rule).
    expect(host.editorFilePath).toBe('C:\\rig\\copies\\runner-v2.tao.editor');
    expect(host.events[host.events.length - 1]).toEqual({ event: 'status', payload: 'Saved a copy to runner-v2.tao.editor' });
  });

  it('reports a failed save-as as an error', async () => {
    vi.stubGlobal('window', { nwDesktop: { fs: { saveFileAs: async () => ({ canceled: false, error: 'no space' }) } } });
    const host = makeHost();

    await saveEditorProjectAs(host);

    expect(host.events[host.events.length - 1]).toEqual({ event: 'error', payload: 'Save failed: no space' });
  });

  it('browser: a cancelled picker (null handle) leaves the current target in place', async () => {
    const existing = pickerHandle(new File([], 'current.tao.editor'));
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    vi.stubGlobal('window', { showSaveFilePicker: async () => { throw abort; } });
    const host = makeHost();
    host.editorFileHandle = existing;
    host.events.length = 0;

    await saveEditorProjectAs(host);

    expect(host.editorFileHandle).toBe(existing);
    expect(host.events.map((e) => e.payload)).toEqual(['Saving a copy…']);
  });
});
